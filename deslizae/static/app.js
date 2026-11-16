'use strict';

/*
 * Deslizae — touchpad no navegador do celular.
 *
 * Fluxo: eventos de toque (Pointer Events) -> motor de gestos -> mensagens
 * binárias pequenas por UDP (WebRTC), ou WebSocket como reserva -> agente
 * no PC move o cursor.
 *
 * Latência: cada movimento é enviado assim que o evento chega (sem esperar
 * o próximo quadro). Se a rede engasgar, os deltas pendentes são somados
 * num único pacote em vez de formar fila — o cursor nunca "anda atrasado".
 */
(() => {
  // Ver deslizae/protocol.py para o formato de cada mensagem.
  const OP = { PING: 0x05, MOVE: 0x10, SCROLL: 0x11, BUTTON: 0x12, CLICK: 0x13, ZOOM: 0x14, PONG: 0x85 };
  const BTN = { LEFT: 0, RIGHT: 1, MIDDLE: 2 };

  const DEFAULTS = {
    sensitivity: 1.6,
    acceleration: 1.0,
    scrollSpeed: 1.5,
    naturalScroll: true,
    inertia: true,
    tapToClick: true,
    showButtons: true,
    haptics: true,
    smoothing: true,
    orientation: 'auto', // 'auto' | 'portrait' | 'landscape'
    flip: false,
    udp: true,
    tapDrag: true,
    pinchZoom: true,
  };

  const TAP_MAX_MS = 250;        // duração máxima de um toque (1 dedo)
  const MULTI_TAP_MAX_MS = 320;  // idem para 2–3 dedos (raramente encostam juntos)
  const TAP_SLOP = 10;           // px que o dedo pode andar e ainda contar como toque
  const MOVE_DEADZONE = 3;       // segura o início do movimento para cliques não "escorregarem"
  const LONG_PRESS_MS = 450;     // segurar parado = começar a arrastar
  const SCROLL_UNITS_PER_PX = 1.2; // 120 unidades de roda ≈ 100 px no Windows
  const INERTIA_TAU_MS = 325;    // constante de desaceleração (parecida com iOS)
  const VELOCITY_WINDOW_MS = 80; // janela para medir a velocidade ao soltar a rolagem
  const DOUBLE_TAP_MS = 200;     // espera por um 2º toque (toque duplo e arrastar)
  const PINCH_START_PX = 24;     // variação da distância entre os dedos para virar pinça
  const ZOOM_UNITS_PER_LN = 520; // 120 × 3 / ln 2: dobrar a distância = 3 passos de zoom
  const PING_INTERVAL_MS = 1000;
  const MAX_BUFFERED = 512;      // bytes na fila do socket antes de passar a agrupar

  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));

  // ---------------------------------------------------------------- storage
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* modo privado */ } },
  };

  let settings = { ...DEFAULTS };
  try { Object.assign(settings, JSON.parse(store.get('settings') || '{}')); } catch { /* ignora */ }
  const saveSettings = () => store.set('settings', JSON.stringify(settings));

  // ------------------------------------------------------------------ token
  // O token vem no QR code (?t=...). Fica salvo e também é mantido na URL,
  // para que "Adicionar à Tela de Início" (que no iPhone tem armazenamento
  // separado do Safari) já abra pareado.
  const params = new URLSearchParams(location.search);
  let token = params.get('t') || store.get('token');
  if (token) {
    store.set('token', token);
    if (params.get('t') !== token) history.replaceState(null, '', '/?t=' + encodeURIComponent(token));
  }

  // --------------------------------------------------------------------- UI
  const ui = {
    dot: $('#dot'),
    host: $('#host'),
    latency: $('#latency'),
    transport: $('#transport'),
    surface: $('#surface'),
    hint: $('#hint'),
    dots: $$('.touch-dot'),
    dragBadge: $('#drag-badge'),
    buttons: $('#buttons'),
    overlay: $('#overlay'),
    overlaySpinner: $('#overlay-spinner'),
    overlayTitle: $('#overlay-title'),
    overlayText: $('#overlay-text'),
    overlayRetry: $('#overlay-retry'),
    sheet: $('#sheet'),
    sheetBackdrop: $('#sheet-backdrop'),
    video: $('#keepawake'),
    app: $('#app'),
    toast: $('#toast'),
  };

  let hostName = '';
  let overlayTimer = 0;

  function showOverlay(title, text = '', { spinner = true, retry = false, delay = 0 } = {}) {
    clearTimeout(overlayTimer);
    const apply = () => {
      ui.overlayTitle.textContent = title;
      ui.overlayText.textContent = text;
      ui.overlaySpinner.hidden = !spinner;
      ui.overlayRetry.hidden = !retry;
      ui.overlay.classList.remove('hidden');
    };
    if (delay) overlayTimer = setTimeout(apply, delay); else apply();
  }

  function hideOverlay() {
    clearTimeout(overlayTimer);
    ui.overlay.classList.add('hidden');
  }

  function setStatus(state) {
    ui.dot.className = 'dot ' + ({ ok: 'ok', connecting: 'warn', bad: 'bad' }[state] || '');
    ui.host.textContent = state === 'ok' ? (hostName || 'Conectado') : 'Conectando…';
    if (state !== 'ok') { ui.latency.textContent = ''; ui.latency.className = 'latency'; }
  }

  // -------------------------------------------------------------- conexão
  // Dois caminhos até o PC:
  //  • WebSocket (TCP): controle, negociação do WebRTC e reserva.
  //  • Canal de dados WebRTC sem reenvio (UDP): caminho principal dos
  //    movimentos. Um pacote perdido no Wi-Fi não trava os seguintes, como
  //    acontece no TCP, que segura tudo (~200 ms) para reenviar o perdido.
  let ws = null;
  let wsOpen = false;
  let pc = null;
  let dc = null;
  let dcOpen = false;
  let retryDelay = 250;
  let retryTimer = 0;
  let failures = 0;
  let rtt = 0;

  async function connect() {
    clearTimeout(retryTimer);
    if (!token) {
      showOverlay('Abra pelo QR code',
        'Escaneie com a câmera do celular o QR code mostrado no computador.', { spinner: false });
      return;
    }
    if (ws && ws.readyState <= WebSocket.OPEN) return;
    setStatus('connecting');

    // Checagem rápida antes do WebSocket: diferencia "PC fora do ar" de
    // "código de pareamento inválido" (o WebSocket não expõe o status HTTP).
    try {
      const r = await fetch('/api/auth?t=' + encodeURIComponent(token), { cache: 'no-store' });
      if (r.status === 401) {
        showOverlay('Pareamento expirado',
          'Este celular não está mais pareado.\nEscaneie o QR code novamente no computador.',
          { spinner: false });
        return;
      }
    } catch {
      scheduleRetry();
      return;
    }

    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const sock = new WebSocket(`${proto}://${location.host}/ws?t=${encodeURIComponent(token)}`);
    sock.binaryType = 'arraybuffer';
    ws = sock;

    sock.onopen = () => {
      if (ws !== sock) return;
      wsOpen = true;
      retryDelay = 250;
      failures = 0;
      resetCounters(); // nova conexão = nova sessão no agente
      hideOverlay();
      setStatus('ok');
      updateTransport();
      sendPing();
      startRtc(sock);
    };
    sock.onmessage = (e) => {
      if (typeof e.data !== 'string') { handleBinary(e.data); return; }
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      if (msg.type === 'hello') {
        hostName = msg.host;
        setStatus('ok');
      } else if (msg.type === 'answer' && pc) {
        pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp }).catch(() => { closeRtc(); updateTransport(); });
      } else if (msg.type === 'rtc-unavailable') {
        closeRtc();
        updateTransport();
      }
    };
    sock.onclose = () => {
      if (ws !== sock) return;
      ws = null;
      wsOpen = false;
      rtt = 0;
      closeRtc();
      resetInput();
      setStatus('bad');
      updateTransport();
      scheduleRetry();
    };
  }

  function handleBinary(buf) {
    const v = new DataView(buf);
    if (v.byteLength === 9 && v.getUint8(0) === OP.PONG) {
      const sample = performance.now() - v.getFloat64(1, true);
      rtt = rtt ? rtt * 0.7 + sample * 0.3 : sample;
      const ms = Math.round(rtt);
      ui.latency.textContent = `${ms} ms`;
      ui.latency.className = 'latency' + (ms > 80 ? ' bad' : ms > 30 ? ' warn' : '');
    }
  }

  async function startRtc(sock) {
    closeRtc();
    updateTransport();
    if (!settings.udp || typeof RTCPeerConnection === 'undefined') return;
    try {
      // Sem servidores STUN: a conexão é direta, dentro da rede local.
      const peer = new RTCPeerConnection({ iceServers: [] });
      const channel = peer.createDataChannel('input', { ordered: false, maxRetransmits: 0 });
      channel.binaryType = 'arraybuffer';
      pc = peer;
      dc = channel;
      channel.onopen = () => {
        if (dc !== channel) return;
        dcOpen = true;
        rtt = 0; // passa a medir o caminho UDP
        updateTransport();
        sendPing();
      };
      channel.onclose = () => {
        if (dc !== channel) return;
        dcOpen = false;
        updateTransport();
      };
      channel.onmessage = (e) => { if (e.data instanceof ArrayBuffer) handleBinary(e.data); };
      peer.onconnectionstatechange = () => {
        if (pc === peer && peer.connectionState === 'failed') { closeRtc(); updateTransport(); }
      };
      await peer.setLocalDescription(await peer.createOffer());
      await iceGatheringDone(peer, 2000);
      if (pc !== peer || ws !== sock || !wsOpen) return;
      sock.send(JSON.stringify({ type: 'offer', sdp: peer.localDescription.sdp }));
    } catch {
      closeRtc();
      updateTransport();
    }
  }

  function iceGatheringDone(peer, timeoutMs) {
    if (peer.iceGatheringState === 'complete') return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      peer.addEventListener('icegatheringstatechange', () => {
        if (peer.iceGatheringState === 'complete') { clearTimeout(timer); resolve(); }
      });
    });
  }

  function closeRtc() {
    dcOpen = false;
    try { dc && dc.close(); } catch { /* ignora */ }
    try { pc && pc.close(); } catch { /* ignora */ }
    dc = null;
    pc = null;
  }

  function updateTransport() {
    ui.transport.textContent = wsOpen ? (dcOpen ? 'UDP' : 'TCP') : '';
    ui.transport.className = 'transport' + (wsOpen ? (dcOpen ? ' udp' : ' tcp') : '');
    ui.transport.title = dcOpen
      ? 'Conexão UDP (WebRTC): perdas no Wi-Fi não travam o cursor'
      : 'Conexão TCP (WebSocket)';
  }

  function scheduleRetry() {
    failures++;
    if (failures >= 4) {
      showOverlay('Não encontrei o computador',
        '• O Deslizae está aberto no PC?\n' +
        '• O celular está no mesmo Wi-Fi que o PC?\n' +
        '• O Firewall do Windows liberou o acesso (rede privada)?\n' +
        '• Wi-Fi de visitantes ou corporativo? Tente o hotspot do celular.',
        { spinner: true, retry: true });
    } else {
      showOverlay('Conectando ao computador…', '', { delay: failures === 1 ? 400 : 0 });
    }
    clearTimeout(retryTimer);
    retryTimer = setTimeout(connect, retryDelay);
    retryDelay = Math.min(retryDelay * 2, 3000);
  }

  ui.overlayRetry.addEventListener('click', () => { retryDelay = 250; failures = 0; connect(); });

  // ---------------------------------------------------------------- envio
  // Movimento e rolagem vão como POSIÇÃO ACUMULADA desde a conexão, com
  // número de sequência: se um pacote UDP se perde, o próximo já contém o
  // movimento dele, e pacotes atrasados são descartados pelo agente.
  const cur = { op: OP.MOVE, seq: 0, x: 0, y: 0, t: 0, dirty: false };
  const scr = { op: OP.SCROLL, seq: 0, x: 0, y: 0, t: 0, dirty: false };
  const zm = { op: OP.ZOOM, seq: 0, x: 0, y: 0, t: 0, dirty: false };
  let eventId = 0;
  let flushTimer = 0;

  function resetCounters() {
    for (const p of [cur, scr, zm]) { p.seq = 0; p.x = p.y = 0; p.dirty = false; }
  }

  // UDP quando disponível; senão, WebSocket.
  const channel = () => (dcOpen ? dc : wsOpen ? ws : null);

  function sendPos(p, ch) {
    if (!p.dirty) return;
    p.seq++;
    const buf = new ArrayBuffer(29);
    const v = new DataView(buf);
    v.setUint8(0, p.op);
    v.setUint32(1, p.seq, true);
    v.setFloat64(5, p.x, true);
    v.setFloat64(13, p.y, true);
    // Com suavização, o instante do toque vai junto para o agente reproduzir
    // o movimento no ritmo do dedo; -1 = aplicar assim que chegar.
    v.setFloat64(21, settings.smoothing ? p.t : -1, true);
    ch.send(buf);
    p.dirty = false;
  }

  function flush() {
    const ch = channel();
    if (!ch) return;
    if (ch.bufferedAmount > MAX_BUFFERED) {
      // Rede engasgou: a posição acumulada continua andando e sai inteira depois.
      if (!flushTimer) flushTimer = setTimeout(() => { flushTimer = 0; flush(); }, 4);
      return;
    }
    sendPos(cur, ch);
    sendPos(scr, ch);
    sendPos(zm, ch);
  }

  function flushNow() {
    clearTimeout(flushTimer);
    flushTimer = 0;
    const ch = channel();
    if (ch) { sendPos(cur, ch); sendPos(scr, ch); sendPos(zm, ch); }
  }

  function queueZoom(units, t) {
    const before = Math.trunc(zm.x / 120);
    zm.x += units;
    zm.t = t;
    zm.dirty = true;
    if (Math.trunc(zm.x / 120) !== before) haptic(6); // um "tique" por passo de zoom
    flush();
  }

  function queueMove(dx, dy, t) { cur.x += dx; cur.y += dy; cur.t = t; cur.dirty = true; flush(); }
  function queueScroll(dx, dy, t) { scr.x += dx; scr.y += dy; scr.t = t; scr.dirty = true; flush(); }

  // Cliques e botões vão pelos DOIS caminhos (o agente ignora a cópia pelo id)
  // e levam a posição do cursor, para caírem no lugar certo mesmo com perdas.
  function sendEvent(buf) {
    if (dcOpen) { try { dc.send(buf); } catch { /* ignora */ } }
    if (wsOpen) ws.send(buf);
  }

  const held = new Set();
  function sendButton(button, down) {
    if (down) held.add(button); else held.delete(button);
    if (!wsOpen) return;
    flushNow();
    const buf = new ArrayBuffer(27);
    const v = new DataView(buf);
    v.setUint8(0, OP.BUTTON);
    v.setUint32(1, ++eventId, true);
    v.setUint8(5, button);
    v.setUint8(6, down ? 1 : 0);
    v.setUint32(7, cur.seq, true);
    v.setFloat64(11, cur.x, true);
    v.setFloat64(19, cur.y, true);
    sendEvent(buf);
  }

  function sendClick(button) {
    if (!wsOpen) return;
    flushNow();
    const buf = new ArrayBuffer(26);
    const v = new DataView(buf);
    v.setUint8(0, OP.CLICK);
    v.setUint32(1, ++eventId, true);
    v.setUint8(5, button);
    v.setUint32(6, cur.seq, true);
    v.setFloat64(10, cur.x, true);
    v.setFloat64(18, cur.y, true);
    sendEvent(buf);
  }

  function sendPing() {
    const ch = channel();
    if (!ch || document.hidden) return;
    const buf = new ArrayBuffer(9);
    const v = new DataView(buf);
    v.setUint8(0, OP.PING);
    v.setFloat64(1, performance.now(), true);
    ch.send(buf);
  }
  setInterval(sendPing, PING_INTERVAL_MS);

  // ------------------------------------------------------------- feedback
  function haptic(ms) {
    if (settings.haptics && navigator.vibrate) navigator.vibrate(ms);
  }

  let wakeLock = null;
  async function keepAwake() {
    if ('wakeLock' in navigator) {
      if (wakeLock) return;
      try {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => { wakeLock = null; });
        return;
      } catch { /* cai no plano B */ }
    }
    // Plano B (HTTP na rede local não tem Wake Lock): um vídeo mudo em loop
    // impede o celular de apagar a tela.
    if (ui.video.paused) ui.video.play().catch(() => {});
  }

  // -------------------------------------------------- curva de aceleração
  // Dedo devagar = precisão; dedo rápido = cursor atravessa a tela.
  // v em px CSS por ms. Transição suave (smoothstep) entre 0.05 e 1.2 px/ms.
  function gain(v) {
    const t = Math.min(1, Math.max(0, (v - 0.05) / (1.2 - 0.05)));
    const smooth = t * t * (3 - 2 * t);
    return settings.sensitivity * (1 + settings.acceleration * 3 * smooth);
  }

  // ------------------------------------------------------- motor de gestos
  const active = new Map(); // pointerId -> {x, y, sx, sy}
  let g = null;             // gesto em andamento
  let longTimer = 0;
  let inertiaRaf = 0;
  let surfaceOrigin = { x: 0, y: 0 };
  let hintHidden = store.get('hintSeen') === '1';
  if (hintHidden) ui.hint.classList.add('hidden');

  // Posição da área de toque no espaço da interface (que pode estar girada):
  // offsetLeft/Top são medidos dentro do contêiner .app, antes da rotação.
  const refreshRect = () => {
    surfaceOrigin = { x: ui.surface.offsetLeft, y: ui.surface.offsetTop };
  };

  // ------------------------------------------------------------ orientação
  // "Automática" segue o celular. "Em pé"/"Deitado" giram a interface 90°
  // por CSS quando a tela do navegador não está na orientação pedida (por
  // exemplo, com a rotação automática desligada). Os toques chegam em
  // coordenadas da tela e são convertidos para as da interface girada.
  const orient = { rot: 0, W: window.innerWidth, H: window.innerHeight };

  function screenAngle() {
    const a = (screen.orientation && typeof screen.orientation.angle === 'number')
      ? screen.orientation.angle
      : (typeof window.orientation === 'number' ? window.orientation : 0);
    return ((a % 360) + 360) % 360;
  }

  function applyOrientation() {
    const W = window.innerWidth;
    const H = window.innerHeight;
    const windowLandscape = W > H;
    let rot = 0;
    if (settings.orientation === 'landscape' && !windowLandscape) {
      // Padrão: celular deitado com o topo para a esquerda.
      rot = settings.flip ? -90 : 90;
    } else if (settings.orientation === 'portrait' && windowLandscape) {
      // O sistema girou a tela; girar de volta conforme o lado em que deitou.
      rot = screenAngle() === 270 ? 90 : -90;
      if (settings.flip) rot = -rot;
    }

    const app = ui.app;
    if (rot === 0) {
      app.style.width = app.style.height = app.style.transform = '';
    } else {
      app.style.width = `${H}px`;
      app.style.height = `${W}px`;
      app.style.transform = rot === 90 ? 'rotate(90deg) translateY(-100%)' : 'rotate(-90deg) translateX(-100%)';
    }
    const changed = rot !== orient.rot;
    Object.assign(orient, { rot, W, H });
    app.classList.toggle('rotated', rot !== 0);
    app.classList.toggle('landscape', rot === 0 ? windowLandscape : !windowLandscape);
    if (changed && active.size) resetInput(); // gesto no meio da troca: descarta
    requestAnimationFrame(refreshRect);
  }

  /** Coordenadas da tela -> coordenadas da interface (já considerando a rotação). */
  function toUi(e) {
    const x = e.clientX;
    const y = e.clientY;
    if (orient.rot === 90) return { x: y, y: orient.W - x };
    if (orient.rot === -90) return { x: orient.H - y, y: x };
    return { x, y };
  }

  /** Tenta travar a orientação pelo sistema (Android em tela cheia); se não der, o CSS resolve. */
  function lockOrientation() {
    const so = screen.orientation;
    if (!so) return;
    if (settings.orientation === 'auto') {
      try { so.unlock(); } catch { /* sem suporte */ }
    } else if (so.lock) {
      so.lock(settings.orientation).catch(() => {});
    }
  }

  const ORIENTATION_NAMES = { auto: 'Automática', portrait: 'Em pé', landscape: 'Deitado' };
  let toastTimer = 0;
  function toast(text) {
    ui.toast.textContent = text;
    ui.toast.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => ui.toast.classList.remove('on'), 1400);
  }

  function setOrientation(mode, announce) {
    settings.orientation = mode;
    saveSettings();
    renderSettings();
    lockOrientation();
    applyOrientation();
    if (announce) toast(`Orientação: ${ORIENTATION_NAMES[mode]}`);
  }

  window.addEventListener('resize', applyOrientation);
  window.addEventListener('orientationchange', () => setTimeout(applyOrientation, 300));
  if (screen.orientation) screen.orientation.addEventListener('change', applyOrientation);

  function centroid() {
    let x = 0, y = 0, n = 0;
    for (const p of active.values()) { x += p.x; y += p.y; if (++n === 2) break; }
    return { x: x / n, y: y / n };
  }

  function updateDots() {
    let i = 0;
    for (const p of active.values()) {
      if (i >= ui.dots.length) break;
      const d = ui.dots[i++];
      d.style.transform = `translate(${p.x - surfaceOrigin.x}px, ${p.y - surfaceOrigin.y}px)`;
      d.classList.add('on');
    }
    for (; i < ui.dots.length; i++) ui.dots[i].classList.remove('on');
  }

  function setDragging(on) {
    ui.surface.classList.toggle('dragging', on);
    ui.dragBadge.hidden = !on;
  }

  function clearLongPress() { clearTimeout(longTimer); longTimer = 0; }

  function startLongPress() {
    clearLongPress();
    longTimer = setTimeout(() => {
      longTimer = 0;
      if (g && g.mode === 'pointer' && active.size === 1 && g.travel < TAP_SLOP) {
        g.hold.x = g.hold.y = 0;
        beginDrag(g, 25);
      }
    }, LONG_PRESS_MS);
  }

  function stopInertia() {
    if (inertiaRaf) cancelAnimationFrame(inertiaRaf);
    inertiaRaf = 0;
  }

  function startInertia(vx, vy) {
    if (Math.hypot(vx, vy) < 0.25) return; // unidades de roda por ms
    let last = null;
    const step = (now) => {
      // O timestamp do 1º quadro pode ser anterior ao início da inércia;
      // por isso o relógio começa no próprio quadro e dt nunca é negativo.
      const dt = last === null ? 16 : Math.min(50, Math.max(0, now - last));
      last = now;
      queueScroll(vx * dt, vy * dt, now);
      const decay = Math.exp(-dt / INERTIA_TAU_MS);
      vx *= decay;
      vy *= decay;
      if (Math.hypot(vx, vy) < 0.02 || !wsOpen) { inertiaRaf = 0; return; }
      inertiaRaf = requestAnimationFrame(step);
    };
    inertiaRaf = requestAnimationFrame(step);
  }

  function hideHint() {
    if (hintHidden) return;
    hintHidden = true;
    ui.hint.classList.add('hidden');
    store.set('hintSeen', '1');
  }

  function fingerDist() {
    const it = active.values();
    const a = it.next().value;
    const b = it.next().value;
    return a && b ? Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)) : 1;
  }

  // Toque duplo e arrastar: depois de um toque, esperamos DOUBLE_TAP_MS para
  // ver se o dedo volta. Se voltar e andar, vira arraste (botão apertado) sem
  // nenhum clique antes — senão o Windows veria "clique + apertar" como
  // clique duplo e abriria o arquivo em vez de arrastá-lo.
  let pendingTap = null;

  function cancelPendingTap() {
    if (pendingTap) { clearTimeout(pendingTap); pendingTap = null; }
  }

  /** O 2º toque não virou arraste: entrega o clique que estava guardado. */
  function releaseTapDrag(gesture) {
    if (gesture && gesture.tapDrag) {
      gesture.tapDrag = false;
      sendClick(BTN.LEFT);
    }
  }

  function beginDrag(gesture, strength) {
    gesture.tapDrag = false;
    gesture.mode = 'drag';
    gesture.moving = true;
    sendButton(BTN.LEFT, true);
    setDragging(true);
    haptic(strength);
  }

  ui.surface.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    try { ui.surface.setPointerCapture(e.pointerId); } catch { /* ignora */ }
    keepAwake();
    stopInertia();
    if (active.size === 0) refreshRect();

    const pt = toUi(e);
    active.set(e.pointerId, { x: pt.x, y: pt.y, sx: pt.x, sy: pt.y });
    if (!g) {
      g = {
        mode: 'pointer', primary: e.pointerId, t0: e.timeStamp, maxCount: 0, travel: 0,
        lastT: e.timeStamp, vel: 0, moving: false, hold: { x: 0, y: 0 },
        c: null, c0: null, d0: 1, lastD: 1, samples: [], lastScrollT: 0,
        tapDrag: false,
      };
      if (pendingTap) { cancelPendingTap(); g.tapDrag = true; } // 2º toque: talvez arraste
    }
    g.maxCount = Math.max(g.maxCount, active.size);

    if (active.size === 1 && g.mode === 'pointer') startLongPress();
    else clearLongPress();

    if (g.mode === 'drag') {
      // dedos extras durante o arraste são ignorados
    } else if (active.size === 2) {
      releaseTapDrag(g);
      if (g.mode === 'pointer') {
        // Ainda não se sabe se é rolagem ou pinça: decide pelo 1º movimento.
        g.mode = 'two';
        g.c0 = centroid();
      }
      g.c = centroid();
      g.d0 = g.lastD = fingerDist();
      g.lastT = e.timeStamp;
    } else if (active.size >= 3) {
      releaseTapDrag(g);
      g.mode = 'multi';
    }
    updateDots();
  });

  ui.surface.addEventListener('pointermove', (e) => {
    const p = active.get(e.pointerId);
    if (!p || !g) return;
    const pt = toUi(e);
    const dx = pt.x - p.x;
    const dy = pt.y - p.y;
    if (!dx && !dy) return;
    p.x = pt.x;
    p.y = pt.y;

    const fromStart = Math.hypot(p.x - p.sx, p.y - p.sy);
    if (fromStart > g.travel) g.travel = fromStart;
    if (g.travel > TAP_SLOP) clearLongPress();

    if (g.mode === 'pointer' || g.mode === 'drag') {
      if (e.pointerId !== g.primary) return;
      const dt = Math.max(1, e.timeStamp - g.lastT);
      g.lastT = e.timeStamp;
      g.vel = g.vel * 0.5 + (Math.hypot(dx, dy) / dt) * 0.5;
      const k = gain(g.vel);
      if (!g.moving) {
        g.hold.x += dx;
        g.hold.y += dy;
        if (g.travel < MOVE_DEADZONE) return;
        if (g.tapDrag) beginDrag(g, 15); // toque duplo + arrastar
        g.moving = true;
        hideHint();
        queueMove(g.hold.x * k, g.hold.y * k, e.timeStamp);
      } else {
        queueMove(dx * k, dy * k, e.timeStamp);
      }
    } else if (g.mode === 'two' || g.mode === 'scroll' || g.mode === 'pinch') {
      if (active.size < 2) { updateDots(); return; }
      const c = centroid();
      const d = fingerDist();

      if (g.mode === 'two') {
        const moved = Math.hypot(c.x - g.c0.x, c.y - g.c0.y);
        const spread = Math.abs(d - g.d0);
        if (settings.pinchZoom && spread > PINCH_START_PX && spread > moved * 1.2) {
          g.mode = 'pinch';
          g.lastD = d;
          hideHint();
        } else if (moved > TAP_SLOP * 0.6) {
          g.mode = 'scroll';
          g.c = c;
          hideHint();
        }
        updateDots();
        return;
      }

      if (g.mode === 'pinch') {
        // Escala logarítmica: abrir até o dobro da distância = 3 passos de zoom.
        queueZoom(Math.log(d / g.lastD) * ZOOM_UNITS_PER_LN, e.timeStamp);
        g.lastD = d;
      } else {
        const cdx = c.x - g.c.x;
        const cdy = c.y - g.c.y;
        g.c = c;
        const k = SCROLL_UNITS_PER_PX * settings.scrollSpeed * (settings.naturalScroll ? 1 : -1);
        const wx = -cdx * k; // roda horizontal: positivo = direita
        const wy = cdy * k;  // roda vertical: positivo = para cima
        // Guarda amostras para estimar a velocidade numa janela de tempo: os
        // eventos dos dois dedos chegam quase juntos e um dt instantâneo
        // inflaria a velocidade da inércia.
        g.samples.push({ t: e.timeStamp, x: wx, y: wy });
        while (g.samples.length && e.timeStamp - g.samples[0].t > VELOCITY_WINDOW_MS) g.samples.shift();
        g.lastScrollT = e.timeStamp;
        queueScroll(wx, wy, e.timeStamp);
      }
    }
    updateDots();
  });

  function onPointerEnd(e, cancelled) {
    if (!active.has(e.pointerId)) return;
    active.delete(e.pointerId);
    if (!g) { updateDots(); return; }

    if (active.size > 0) {
      // Um dedo saiu, outro continua: recalcula referências sem dar "pulo".
      if (g.mode === 'scroll' || g.mode === 'two') g.c = centroid();
      if (e.pointerId === g.primary) g.primary = active.keys().next().value;
      updateDots();
      return;
    }

    clearLongPress();
    const gesture = g;
    g = null;
    const duration = e.timeStamp - gesture.t0;
    const maxTap = gesture.maxCount > 1 ? MULTI_TAP_MAX_MS : TAP_MAX_MS;
    const isTap = !cancelled && settings.tapToClick && duration < maxTap && gesture.travel < TAP_SLOP;

    if (gesture.mode === 'drag') {
      sendButton(BTN.LEFT, false);
      setDragging(false);
    } else if (isTap && gesture.maxCount === 1) {
      haptic(8);
      hideHint();
      if (gesture.tapDrag) {
        // Dois toques rápidos = clique duplo.
        gesture.tapDrag = false;
        sendClick(BTN.LEFT);
        sendClick(BTN.LEFT);
      } else if (settings.tapDrag) {
        pendingTap = setTimeout(() => { pendingTap = null; sendClick(BTN.LEFT); }, DOUBLE_TAP_MS);
      } else {
        sendClick(BTN.LEFT);
      }
    } else if (isTap) {
      sendClick(gesture.maxCount === 2 ? BTN.RIGHT : BTN.MIDDLE);
      haptic(8);
      hideHint();
    } else {
      if (!cancelled) releaseTapDrag(gesture);
      if (gesture.mode === 'scroll' && settings.inertia && !cancelled &&
          e.timeStamp - gesture.lastScrollT < 60) {
        const recent = gesture.samples.filter((s) => e.timeStamp - s.t <= VELOCITY_WINDOW_MS);
        if (recent.length >= 2) {
          // A primeira amostra marca o início da janela; seu delta veio antes dela.
          const span = Math.max(16, e.timeStamp - recent[0].t);
          let sx = 0, sy = 0;
          for (const s of recent.slice(1)) { sx += s.x; sy += s.y; }
          startInertia(sx / span, sy / span);
        }
      }
    }
    updateDots();
  }

  ui.surface.addEventListener('pointerup', (e) => onPointerEnd(e, false));
  ui.surface.addEventListener('pointercancel', (e) => onPointerEnd(e, true));

  // ------------------------------------------------------ botões de baixo
  const buttonEls = $$('.mbtn');
  for (const el of buttonEls) {
    const button = Number(el.dataset.button);
    let pointer = null;
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      if (pointer !== null) return;
      pointer = e.pointerId;
      try { el.setPointerCapture(e.pointerId); } catch { /* ignora */ }
      el.classList.add('pressed');
      keepAwake();
      sendButton(button, true);
      haptic(10);
    });
    const up = (e) => {
      if (e.pointerId !== pointer) return;
      pointer = null;
      el.classList.remove('pressed');
      sendButton(button, false);
    };
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el._reset = () => { pointer = null; el.classList.remove('pressed'); };
  }

  /** Solta tudo (conexão caiu ou página foi para segundo plano). */
  function resetInput() {
    clearLongPress();
    cancelPendingTap();
    stopInertia();
    if (wsOpen) for (const b of Array.from(held)) sendButton(b, false);
    held.clear();
    active.clear();
    g = null;
    setDragging(false);
    for (const el of buttonEls) el._reset();
    updateDots();
  }

  // --------------------------------------------------------------- ajustes
  const sliders = ['sensitivity', 'acceleration', 'scrollSpeed'];
  const toggles = [
    'naturalScroll', 'inertia', 'tapToClick', 'tapDrag', 'pinchZoom',
    'showButtons', 'haptics', 'smoothing', 'udp', 'flip',
  ];

  function renderSettings() {
    for (const id of sliders) {
      $('#' + id).value = settings[id];
      $('#out-' + id).textContent = Number(settings[id]).toFixed(1) + '×';
    }
    for (const id of toggles) $('#' + id).checked = !!settings[id];
    for (const b of $$('[data-orientation]')) {
      b.setAttribute('aria-checked', String(b.dataset.orientation === settings.orientation));
    }
    $('#row-flip').hidden = settings.orientation === 'auto';
    ui.buttons.hidden = !settings.showButtons;
    requestAnimationFrame(refreshRect);
  }

  for (const b of $$('[data-orientation]')) {
    b.addEventListener('click', () => setOrientation(b.dataset.orientation, false));
  }
  // Botão da barra: alterna Automática → Em pé → Deitado.
  $('#btn-orientation').addEventListener('click', () => {
    const order = ['auto', 'portrait', 'landscape'];
    setOrientation(order[(order.indexOf(settings.orientation) + 1) % order.length], true);
  });

  for (const id of sliders) {
    $('#' + id).addEventListener('input', (e) => {
      settings[id] = Number(e.target.value);
      $('#out-' + id).textContent = settings[id].toFixed(1) + '×';
      saveSettings();
    });
  }
  for (const id of toggles) {
    $('#' + id).addEventListener('change', (e) => {
      settings[id] = e.target.checked;
      saveSettings();
      renderSettings();
      if (id === 'udp' && wsOpen) startRtc(ws); // liga/desliga o UDP na hora
      if (id === 'flip') applyOrientation();
    });
  }

  function openSheet() { ui.sheet.hidden = false; ui.sheetBackdrop.hidden = false; }
  function closeSheet() { ui.sheet.hidden = true; ui.sheetBackdrop.hidden = true; }
  $('#btn-settings').addEventListener('click', openSheet);
  $('#btn-close').addEventListener('click', closeSheet);
  ui.sheetBackdrop.addEventListener('click', closeSheet);
  $('#btn-reset').addEventListener('click', () => {
    settings = { ...DEFAULTS };
    saveSettings();
    renderSettings();
    lockOrientation();
    applyOrientation();
  });

  if (!navigator.vibrate) $('#row-haptics').hidden = true;

  const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  if (isIOS && !standalone) $('#ios-tip').hidden = false;

  const fsBtn = $('#btn-fullscreen');
  if (document.fullscreenEnabled) {
    fsBtn.hidden = false;
    fsBtn.addEventListener('click', () => {
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
      else document.documentElement.requestFullscreen({ navigationUI: 'hide' }).catch(() => {});
    });
    document.addEventListener('fullscreenchange', () => {
      // Em tela cheia o Android permite travar a orientação de verdade.
      if (document.fullscreenElement) lockOrientation();
      setTimeout(applyOrientation, 100);
    });
  }

  // ------------------------------------------- bloqueios do navegador
  // Sem zoom, sem menu de contexto, sem "puxar para atualizar".
  document.addEventListener('gesturestart', (e) => e.preventDefault());
  document.addEventListener('contextmenu', (e) => e.preventDefault());
  document.addEventListener('touchmove', (e) => {
    if (!ui.sheet.contains(e.target)) e.preventDefault();
  }, { passive: false });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      resetInput();
    } else {
      wakeLock = null;
      if (!wsOpen) { retryDelay = 250; failures = 0; connect(); }
      else sendPing();
    }
  });

  // ------------------------------------------------------------- início
  renderSettings();
  applyOrientation();
  connect();
})();
