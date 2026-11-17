'use strict';

/*
 * Laboratório: o celular como mouse, com a câmera frontal olhando para o teto.
 *
 * Pipeline por quadro:
 *   câmera (exposição travada) → recorte central em cinza → worker:
 *   rastreador com quadro de referência e anticintilação (flow.js) →
 *   posição da imagem − efeito da inclinação (giroscópio sem viés) →
 *   detector parado/movendo + filtro 1€ (motion.js) →
 *   eixos calibrados → sensibilidade/aceleração → cursor.
 *
 * Usa o mesmo protocolo do touchpad (posições acumuladas por UDP/WebRTC, com
 * WebSocket de reserva); o agente no PC não muda.
 *
 * ?fake=1 troca a câmera por um teto sintético que anda em círculos.
 */
(() => {
  const OP = { PING: 0x05, MOVE: 0x10, SCROLL: 0x11, BUTTON: 0x12, CLICK: 0x13, PONG: 0x85 };
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  const Motion = window.DeslizaeMotion;

  // ------------------------------------------------------------- ajustes
  const DEFAULTS = {
    sens: 20,           // px do cursor por px de câmera (antes da aceleração)
    accel: 1.2,
    smooth: 1.2,        // corte mínimo do filtro 1€ (Hz): menor = mais suave
    startPx: 0.4,       // limiar de movimento (px de câmera); a calibração mede
    minPsr: 6,
    gyroDelay: 0,
    rowNormalize: true,
    lockExposure: true,
    wide: false,
    hiRes: false,
    gyroComp: true,
    smoothing: true,
    invX: false,
    invY: false,
    swap: false,
  };
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* ignora */ } },
    del(k) { try { localStorage.removeItem(k); } catch { /* ignora */ } },
  };
  const settings = { ...DEFAULTS };
  try { Object.assign(settings, JSON.parse(store.get('labSettings2') || '{}')); } catch { /* ignora */ }
  const save = () => store.set('labSettings2', JSON.stringify(settings));

  // Calibração: { A (eixos), Mg (giroscópio → imagem), sigma, startPx, bias }
  let calib = null;
  try { calib = JSON.parse(store.get('labCalib') || 'null'); } catch { /* ignora */ }

  const params = new URLSearchParams(location.search);
  const FAKE = params.get('fake') === '1';
  const token = params.get('t') || store.get('token');
  if (token) store.set('token', token);

  const ui = {
    dot: $('#dot'), host: $('#host'), transport: $('#transport'), latency: $('#latency'),
    preview: $('#preview'), wrap: $('#preview-wrap'), state: $('#state'), status: $('#status'),
    intro: $('#intro'), video: $('#video'), send: $('#send'), summary: $('#calib-summary'),
    fps: $('#m-fps'), proc: $('#m-proc'), lat: $('#m-lat'), psr: $('#m-psr'), psrBar: $('#m-psr-bar'),
    jitter: $('#m-jitter'), gyro: $('#m-gyro'), exp: $('#m-exp'),
    wizard: $('#wizard'), wizStep: $('#wiz-step'), wizTitle: $('#wiz-title'), wizText: $('#wiz-text'),
    wizBar: $('#wiz-bar'), wizLive: $('#wiz-live'),
  };

  const fmt = (v, d) => v.toLocaleString('pt-BR', { minimumFractionDigits: d, maximumFractionDigits: d });
  const fmt2 = (v) => fmt(v, 2);

  function status(text, kind = '') {
    ui.status.textContent = text;
    ui.status.className = 'lab-status ' + kind;
  }

  // ------------------------------------------------------------ conexão
  let ws = null, wsOpen = false, pc = null, dc = null, dcOpen = false, rtt = 0;
  const channel = () => (dcOpen ? dc : wsOpen ? ws : null);

  function setConn() {
    ui.dot.className = 'dot ' + (wsOpen ? 'ok' : 'bad');
    ui.transport.textContent = wsOpen ? (dcOpen ? 'UDP' : 'TCP') : '';
    ui.transport.className = 'transport' + (wsOpen ? (dcOpen ? ' udp' : ' tcp') : '');
  }

  function connect() {
    if (!token) { status('Abra pelo QR code do laboratório mostrado no PC.', 'warn'); return; }
    const sock = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?t=${encodeURIComponent(token)}`);
    sock.binaryType = 'arraybuffer';
    ws = sock;
    sock.onopen = () => {
      wsOpen = true;
      for (const p of [cur, scr]) { p.seq = 0; p.x = p.y = 0; }
      setConn();
      startRtc(sock);
    };
    sock.onmessage = (e) => {
      if (typeof e.data !== 'string') { onBinary(e.data); return; }
      let m; try { m = JSON.parse(e.data); } catch { return; }
      if (m.type === 'hello') ui.host.textContent = m.host;
      else if (m.type === 'answer' && pc) pc.setRemoteDescription({ type: 'answer', sdp: m.sdp }).catch(() => {});
    };
    sock.onclose = () => {
      if (ws !== sock) return;
      wsOpen = false; dcOpen = false;
      try { pc && pc.close(); } catch { /* ignora */ }
      pc = dc = null;
      setConn();
      ui.host.textContent = 'Reconectando…';
      setTimeout(connect, 1000);
    };
  }

  async function startRtc(sock) {
    if (typeof RTCPeerConnection === 'undefined') return;
    try {
      const peer = new RTCPeerConnection({ iceServers: [] });
      const ch = peer.createDataChannel('input', { ordered: false, maxRetransmits: 0 });
      ch.binaryType = 'arraybuffer';
      pc = peer; dc = ch;
      ch.onopen = () => { dcOpen = true; setConn(); };
      ch.onclose = () => { dcOpen = false; setConn(); };
      ch.onmessage = (e) => onBinary(e.data);
      await peer.setLocalDescription(await peer.createOffer());
      await new Promise((resolve) => {
        if (peer.iceGatheringState === 'complete') return resolve();
        const t = setTimeout(resolve, 2000);
        peer.addEventListener('icegatheringstatechange', () => {
          if (peer.iceGatheringState === 'complete') { clearTimeout(t); resolve(); }
        });
      });
      if (ws === sock && wsOpen) sock.send(JSON.stringify({ type: 'offer', sdp: peer.localDescription.sdp }));
    } catch { /* segue pelo WebSocket */ }
  }

  function onBinary(buf) {
    const v = new DataView(buf);
    if (v.byteLength === 9 && v.getUint8(0) === OP.PONG) {
      const s = performance.now() - v.getFloat64(1, true);
      rtt = rtt ? rtt * 0.7 + s * 0.3 : s;
      ui.latency.textContent = `${Math.round(rtt)} ms`;
    }
  }

  setInterval(() => {
    const ch = channel();
    if (!ch) return;
    const b = new ArrayBuffer(9), v = new DataView(b);
    v.setUint8(0, OP.PING); v.setFloat64(1, performance.now(), true);
    ch.send(b);
  }, 1000);

  // -------------------------------------------------------------- envio
  const cur = { op: OP.MOVE, seq: 0, x: 0, y: 0 };
  const scr = { op: OP.SCROLL, seq: 0, x: 0, y: 0 };
  let eventId = 0;

  function sendPos(p, t) {
    const ch = channel();
    if (!ch) return;
    p.seq++;
    const b = new ArrayBuffer(29), v = new DataView(b);
    v.setUint8(0, p.op); v.setUint32(1, p.seq, true);
    v.setFloat64(5, p.x, true); v.setFloat64(13, p.y, true);
    v.setFloat64(21, settings.smoothing ? t : -1, true);
    ch.send(b);
  }

  function sendButton(button, down) {
    const b = new ArrayBuffer(27), v = new DataView(b);
    v.setUint8(0, OP.BUTTON); v.setUint32(1, ++eventId, true);
    v.setUint8(5, button); v.setUint8(6, down ? 1 : 0);
    v.setUint32(7, cur.seq, true); v.setFloat64(11, cur.x, true); v.setFloat64(19, cur.y, true);
    if (dcOpen) { try { dc.send(b); } catch { /* ignora */ } }
    if (wsOpen) ws.send(b);
    if (navigator.vibrate) navigator.vibrate(down ? 8 : 4);
  }

  // ------------------------------------------------------------ giroscópio
  // Ângulo acumulado (graus) nos eixos X (beta) e Y (gamma) do aparelho, já
  // sem o viés: o giroscópio sempre lê alguns centésimos de grau por segundo
  // mesmo parado, e integrado isso viraria uma deriva lenta do cursor.
  const gyroHist = [];
  let gyroAngle = { x: 0, y: 0 };
  let gyroBias = calib && calib.bias ? { ...calib.bias } : { x: 0, y: 0 };
  let lastGyroT = null;
  let gyroSeen = false;
  let lastRate = { x: 0, y: 0 };
  const rawRates = []; // para medir o viés na calibração

  function onMotion(e) {
    const r = e.rotationRate;
    if (!r || r.beta == null) return;
    gyroSeen = true;
    const t = e.timeStamp;
    lastRate = { x: r.beta, y: r.gamma };
    if (wizard && wizard.step === 'still') rawRates.push({ x: r.beta, y: r.gamma });
    // Parado e quase sem giro: refina o viés aos poucos.
    if (!motion.moving && Math.hypot(r.beta - gyroBias.x, r.gamma - gyroBias.y) < 3) {
      gyroBias.x += 0.01 * (r.beta - gyroBias.x);
      gyroBias.y += 0.01 * (r.gamma - gyroBias.y);
    }
    if (lastGyroT !== null) {
      const dt = Math.min(100, t - lastGyroT) / 1000;
      gyroAngle = { x: gyroAngle.x + (r.beta - gyroBias.x) * dt, y: gyroAngle.y + (r.gamma - gyroBias.y) * dt };
    }
    lastGyroT = t;
    gyroHist.push({ t, x: gyroAngle.x, y: gyroAngle.y });
    while (gyroHist.length && t - gyroHist[0].t > 3000) gyroHist.shift();
  }

  function angleAt(t) {
    const h = gyroHist;
    if (!h.length) return null;
    if (t <= h[0].t) return h[0];
    if (t >= h[h.length - 1].t) return h[h.length - 1];
    let i = h.length - 1;
    while (i > 0 && h[i - 1].t > t) i--;
    const a = h[i - 1], b = h[i];
    const f = (t - a.t) / (b.t - a.t || 1);
    return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
  }

  async function enableMotion() {
    if (typeof DeviceMotionEvent === 'undefined') return false;
    if (typeof DeviceMotionEvent.requestPermission === 'function') {
      try { if (await DeviceMotionEvent.requestPermission() !== 'granted') return false; } catch { return false; }
    }
    window.addEventListener('devicemotion', onMotion);
    return true;
  }

  setInterval(() => {
    ui.gyro.textContent = gyroSeen ? `${fmt(Math.hypot(lastRate.x - gyroBias.x, lastRate.y - gyroBias.y), 1)} °/s` : 'indisponível';
  }, 300);

  // ------------------------------------------------------------ câmera
  const video = ui.video;
  const work = document.createElement('canvas');
  const wctx = work.getContext('2d', { willReadFrequently: true });
  const pctx = ui.preview.getContext('2d');
  const worker = new Worker('/static/flow-worker.js');
  let busy = false;
  let frames = 0, fpsT0 = performance.now();
  let resetTracker = false;

  // No modo de teste, os quadros vêm direto do canvas sintético, num timer:
  // não depende de o navegador estar desenhando a página (ambientes de teste
  // sem tela não disparam os callbacks de quadro de vídeo).
  let source = video;
  let cameraOn = false;

  async function openCamera() {
    if (FAKE) {
      source = fakeCanvas();
      ui.exp.textContent = 'simulada';
      cameraOn = true;
      scheduleFrame();
      return;
    } else {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error('Este navegador não liberou a câmera. A página precisa ser aberta em HTTPS.');
      }
      video.srcObject = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 60 } },
      });
    }
    await video.play();
    cameraOn = true;
    scheduleFrame();
    if (settings.lockExposure) setTimeout(lockExposure, 1500); // deixa o automático acertar antes
    else ui.exp.textContent = 'automática';
  }

  /** Trava exposição e balanço de branco, quando a câmera permite. */
  async function lockExposure() {
    const track = video.srcObject && video.srcObject.getVideoTracks()[0];
    const caps = track && track.getCapabilities ? track.getCapabilities() : {};
    const advanced = [];
    if ((caps.exposureMode || []).includes('manual')) advanced.push({ exposureMode: 'manual' });
    if ((caps.whiteBalanceMode || []).includes('manual')) advanced.push({ whiteBalanceMode: 'manual' });
    if (!advanced.length) { ui.exp.textContent = 'não suportado'; return; }
    try {
      await track.applyConstraints({ advanced });
      ui.exp.textContent = 'travada';
    } catch {
      ui.exp.textContent = 'não suportado';
    }
  }

  function scheduleFrame() {
    if (FAKE) setTimeout(() => onFrame(performance.now(), {}), 33);
    else if ('requestVideoFrameCallback' in video) video.requestVideoFrameCallback(onFrame);
    else requestAnimationFrame((now) => onFrame(now, {}));
  }

  let geom = { n: 128, region: 256, k: 2 };

  function onFrame(now, meta) {
    scheduleFrame();
    frames++;
    if (now - fpsT0 > 1000) {
      ui.fps.textContent = `${Math.round((frames * 1000) / (now - fpsT0))} fps`;
      frames = 0; fpsT0 = now;
    }
    const t = meta.captureTime || meta.expectedDisplayTime || now;
    ui.lat.textContent = meta.captureTime ? `${Math.round(performance.now() - meta.captureTime)} ms` : 'n/d';
    if (busy) return; // um quadro por vez no worker: pular é melhor que acumular atraso

    const n = settings.hiRes ? 256 : 128;
    if (FAKE) source.draw();
    const sw = source.videoWidth || source.width, sh = source.videoHeight || source.height;
    const side = Math.min(sw, sh);
    if (!side) return;
    const region = settings.wide ? side : Math.min(side, 256);
    geom = { n, region, k: region / n };
    if (work.width !== n) { work.width = work.height = n; }
    wctx.drawImage(source, (sw - region) / 2, (sh - region) / 2, region, region, 0, 0, n, n);
    const img = wctx.getImageData(0, 0, n, n);
    pctx.drawImage(work, 0, 0, ui.preview.width, ui.preview.height);
    drawArrow();
    const gray = window.DeslizaeFlow.toGray(img.data, new Float32Array(n * n));
    busy = true;
    worker.postMessage({
      gray, n, t,
      rowNormalize: settings.rowNormalize, rekeyPx: n / 16, minPsr: settings.minPsr,
      reset: resetTracker,
    }, [gray.buffer]);
    resetTracker = false;
  }

  // ------------------------------------------------------ processamento
  const motion = Motion.createMotionFilter({ startPx: currentStartPx(), minCutoff: settings.smooth });
  let prev = null;                 // última amostra válida {pos, ang}
  let corr = { x: 0, y: 0 };       // posição corrigida acumulada (px de câmera)
  let lastVel = { x: 0, y: 0 };

  function currentStartPx() {
    return settings.startPx;
  }

  function setState(kind, text) {
    ui.wrap.className = 'preview-wrap ' + kind;
    ui.state.textContent = text;
  }

  worker.onmessage = (e) => {
    busy = false;
    const r = e.data;
    ui.proc.textContent = `${fmt(r.ms, 1)} ms`;
    if (r.psr) {
      ui.psr.textContent = fmt(r.psr, 1);
      ui.psrBar.style.width = `${Math.max(0, Math.min(1, (r.psr - 3) / 30)) * 100}%`;
      ui.psrBar.style.background = r.valid ? 'var(--ok)' : 'var(--bad)';
    }

    if (!r.valid) {
      // Sem rastreio confiável: não move nada e recomeça parado.
      prev = null;
      motion.reset();
      if (r.contrast < 2) setState('lost', 'SEM IMAGEM');
      else if (r.psr) setState('lost', 'SEM TEXTURA');
      if (wizard) wizard.lost++;
      return;
    }

    const pos = { x: r.x * geom.k, y: r.y * geom.k };
    const ang = gyroSeen ? angleAt(r.t + settings.gyroDelay) : null;

    if (prev) {
      let dx = pos.x - prev.pos.x;
      let dy = pos.y - prev.pos.y;
      const dg = ang && prev.ang ? { x: ang.x - prev.ang.x, y: ang.y - prev.ang.y } : null;
      if (wizard) wizardSample({ dx, dy, dg, pos });
      // Desconta o deslocamento da imagem causado por inclinação.
      const Mg = calib && calib.Mg;
      if (settings.gyroComp && Mg && dg) {
        dx -= Mg[0] * dg.x + Mg[1] * dg.y;
        dy -= Mg[2] * dg.x + Mg[3] * dg.y;
      }
      corr = { x: corr.x + dx, y: corr.y + dy };
    }
    prev = { pos, ang };

    const m = motion.push(corr.x, corr.y, r.t / 1000);
    setState(m.moving ? 'moving' : 'still', m.moving ? 'MOVENDO' : 'PARADO');
    lastVel = m.moving ? { x: m.dx, y: m.dy } : { x: 0, y: 0 };

    if (wizard || !ui.send.checked || (!m.dx && !m.dy)) {
      if (!wizard) status(calib ? (ui.send.checked ? 'Enviando ao cursor.' : 'Pronto. Ligue “Enviar ao cursor”.') : 'Calibre antes de usar: toque em “Calibrar”.', calib ? 'ok' : 'warn');
      return;
    }

    // Eixos: calibrados (A) e, por cima, ajustes manuais.
    let v = calib && calib.A ? Motion.apply(calib.A, m.dx, m.dy) : { x: m.dx, y: m.dy };
    if (settings.swap) v = { x: v.y, y: v.x };
    if (settings.invX) v.x = -v.x;
    if (settings.invY) v.y = -v.y;

    // Aceleração: devagar = preciso; rápido = longo (velocidade em px de câmera/s).
    const s = Math.min(1, Math.max(0, (m.speed - 3) / (80 - 3)));
    const gain = settings.sens * (1 + settings.accel * 3 * s * s * (3 - 2 * s));
    cur.x += v.x * gain;
    cur.y += v.y * gain;
    sendPos(cur, r.t);
    status('Enviando ao cursor.', 'ok');
  };

  // Tremor parado: quanto a posição oscila sem movimento (px de câmera).
  let jitterSamples = [];
  setInterval(() => {
    if (!prev) return;
    jitterSamples.push({ ...prev.pos });
    if (jitterSamples.length > 20) jitterSamples.shift();
    if (motion.moving || jitterSamples.length < 5) return;
    const mx = jitterSamples.reduce((a, p) => a + p.x, 0) / jitterSamples.length;
    const my = jitterSamples.reduce((a, p) => a + p.y, 0) / jitterSamples.length;
    const sd = Math.sqrt(jitterSamples.reduce((a, p) => a + (p.x - mx) ** 2 + (p.y - my) ** 2, 0) / jitterSamples.length);
    ui.jitter.textContent = `${fmt(sd, 2)} px`;
  }, 100);

  function drawArrow() {
    const w = ui.preview.width, h = ui.preview.height;
    const sp = Math.hypot(lastVel.x, lastVel.y);
    if (sp < 0.01) return;
    const k = Math.min(60, 12 + sp * 8) / sp;
    pctx.strokeStyle = '#5b8cff';
    pctx.lineWidth = 3;
    pctx.beginPath();
    pctx.moveTo(w / 2, h / 2);
    pctx.lineTo(w / 2 + lastVel.x * k, h / 2 + lastVel.y * k);
    pctx.stroke();
  }

  function recenter() {
    resetTracker = true;
    prev = null;
    motion.reset();
    jitterSamples = [];
  }

  // ------------------------------------------------- assistente de calibração
  let wizard = null;

  const STEPS = [
    { id: 'still', title: 'Deixe parado', text: 'Celular parado na mesa, sem encostar nele.', ms: 2500 },
    { id: 'tilt', title: 'Incline sem deslizar', text: 'Incline o celular para os lados e para frente e para trás, sem tirar do lugar.', ms: 4000, gyro: true },
    { id: 'right', title: 'Deslize para a direita', text: 'Deslize o celular uns 10 cm para a DIREITA, em linha reta, e pare.', gesture: true },
    { id: 'fwd', title: 'Deslize para frente', text: 'Deslize o celular uns 10 cm para FRENTE (para longe de você) e pare.', gesture: true },
  ];

  function wizardSample(s) {
    const w = wizard;
    if (w.step === 'still') w.pos.push(s.pos);
    else if (w.step === 'tilt' && s.dg) w.tilt.push({ gx: s.dg.x, gy: s.dg.y, dx: s.dx, dy: s.dy });
    else if (w.gesture) {
      let { dx, dy } = s;
      const Mg = w.Mg;
      if (Mg && s.dg) { dx -= Mg[0] * s.dg.x + Mg[1] * s.dg.y; dy -= Mg[2] * s.dg.x + Mg[3] * s.dg.y; }
      w.gesture.x += dx; w.gesture.y += dy;
      w.gesture.t.push({ t: performance.now(), x: w.gesture.x, y: w.gesture.y });
    }
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function timedStep(ms) {
    const t0 = performance.now();
    while (performance.now() - t0 < ms) {
      if (!wizard) throw new Error('cancelado');
      ui.wizBar.style.width = `${((performance.now() - t0) / ms) * 100}%`;
      await sleep(50);
    }
    ui.wizBar.style.width = '100%';
  }

  /** Espera o gesto: começar a mover (> 12 px) e depois parar (0,4 s). */
  async function gestureStep() {
    const g = { x: 0, y: 0, t: [] };
    wizard.gesture = g;
    const t0 = performance.now();
    let started = false;
    while (performance.now() - t0 < 10000) {
      if (!wizard) throw new Error('cancelado');
      const dist = Math.hypot(g.x, g.y);
      ui.wizLive.textContent = `${dist.toFixed(0)} px`;
      ui.wizBar.style.width = `${Math.min(100, (dist / 60) * 100)}%`;
      if (dist > 12) started = true;
      if (started && g.t.length > 3) {
        const recent = g.t.filter((p) => performance.now() - p.t < 400);
        const span = recent.length ? Math.hypot(recent[recent.length - 1].x - recent[0].x, recent[recent.length - 1].y - recent[0].y) : 0;
        if (recent.length >= 3 && span < 1) return { x: g.x, y: g.y };
      }
      await sleep(50);
    }
    if (started) return { x: g.x, y: g.y };
    throw new Error('não detectei o movimento: o teto está visível?');
  }

  async function runWizard() {
    if (!cameraOn) { status('Inicie a câmera primeiro.', 'warn'); return; }
    ui.send.checked = false;
    wizard = { step: null, pos: [], tilt: [], lost: 0, gesture: null, Mg: calib && calib.Mg };
    ui.wizard.classList.remove('hidden');
    const result = { ...(calib || {}) };
    try {
      for (const [i, step] of STEPS.entries()) {
        if (step.gyro && !gyroSeen) continue;
        wizard.step = step.id;
        wizard.gesture = null;
        ui.wizStep.textContent = `PASSO ${i + 1} DE ${STEPS.length}`;
        ui.wizTitle.textContent = step.title;
        ui.wizText.textContent = step.text;
        ui.wizLive.textContent = '';
        ui.wizBar.style.width = '0%';
        if (step.id === 'still') rawRates.length = 0;

        if (step.ms) await timedStep(step.ms);

        if (step.id === 'still') {
          const p = wizard.pos;
          if (p.length < 10) throw new Error('rastreio instável: aponte para uma área com textura no teto');
          const mx = p.reduce((a, q) => a + q.x, 0) / p.length;
          const my = p.reduce((a, q) => a + q.y, 0) / p.length;
          const sigma = Math.sqrt(p.reduce((a, q) => a + (q.x - mx) ** 2 + (q.y - my) ** 2, 0) / p.length);
          result.sigma = sigma;
          // Limiar com folga: 5 desvios, entre 0,25 e 2 px.
          result.startPx = Math.min(2, Math.max(0.25, 5 * sigma));
          if (rawRates.length) {
            result.bias = {
              x: rawRates.reduce((a, q) => a + q.x, 0) / rawRates.length,
              y: rawRates.reduce((a, q) => a + q.y, 0) / rawRates.length,
            };
            gyroBias = { ...result.bias };
          }
        } else if (step.id === 'tilt') {
          const exc = wizard.tilt.reduce((a, s) => a + s.gx * s.gx + s.gy * s.gy, 0);
          const Mg = Motion.gyroMatrix(wizard.tilt);
          if (!Mg || exc < 8) throw new Error('incline mais o celular durante o passo 2');
          result.Mg = Mg;
          wizard.Mg = Mg;
        } else if (step.id === 'right') {
          result.vR = await gestureStep();
        } else if (step.id === 'fwd') {
          result.vF = await gestureStep();
        }
      }

      const A = Motion.axisMatrix(result.vR, result.vF);
      if (!A) throw new Error('movimentos muito curtos');
      const cos = (result.vR.x * result.vF.x + result.vR.y * result.vF.y) /
        (Math.hypot(result.vR.x, result.vR.y) * Math.hypot(result.vF.x, result.vF.y));
      const angle = Math.acos(Math.max(-1, Math.min(1, cos))) * (180 / Math.PI);
      if (Math.abs(angle - 90) > 35) throw new Error(`os dois movimentos ficaram a ${angle.toFixed(0)}° (esperado ~90°); tente em linhas mais retas`);
      result.A = A;
      result.date = Date.now();
      calib = result;
      store.set('labCalib', JSON.stringify(calib));
      settings.startPx = calib.startPx;
      settings.invX = settings.invY = settings.swap = false;
      save();
      syncControls();
      motion.setStartPx(settings.startPx);
      showSummary();
      status('Calibrado! Ligue “Enviar ao cursor”.', 'ok');
    } catch (err) {
      status(`Calibração interrompida: ${err.message}`, 'warn');
    } finally {
      wizard = null;
      ui.wizard.classList.add('hidden');
      recenter();
    }
  }

  function showSummary() {
    if (!calib || !calib.A) {
      ui.summary.textContent = 'Não calibrado. Os eixos e o ruído ainda não foram medidos.';
      ui.summary.className = 'calib-summary';
      return;
    }
    const parts = [
      `eixos ✓`,
      calib.Mg ? 'inclinação ✓' : 'inclinação: sem giroscópio',
      `ruído ${fmt2(calib.sigma)} px → limiar ${fmt2(calib.startPx)} px`,
    ];
    ui.summary.textContent = `Calibrado: ${parts.join(' · ')}`;
    ui.summary.className = 'calib-summary ok';
  }

  $('#btn-calibrate').addEventListener('click', runWizard);
  $('#wiz-cancel').addEventListener('click', () => { wizard = null; });
  $('#btn-recenter').addEventListener('click', () => { recenter(); status('Rastreio recomeçado.', 'ok'); });
  $('#btn-forget').addEventListener('click', () => {
    calib = null;
    store.del('labCalib');
    settings.startPx = DEFAULTS.startPx;
    save(); syncControls(); motion.setStartPx(settings.startPx); showSummary();
  });

  // ------------------------------------------------------------- botões
  for (const el of $$('.mbtn')) {
    const button = Number(el.dataset.button);
    let id = null;
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      if (id !== null) return;
      id = e.pointerId;
      try { el.setPointerCapture(id); } catch { /* ignora */ }
      el.classList.add('pressed');
      sendButton(button, true);
    });
    const up = (e) => {
      if (e.pointerId !== id) return;
      id = null;
      el.classList.remove('pressed');
      sendButton(button, false);
    };
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  }

  // Rodinha: arrastar o dedo para cima/baixo rola a página.
  const wheel = $('#wheel');
  let wheelY = null;
  wheel.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    wheelY = e.clientY;
    try { wheel.setPointerCapture(e.pointerId); } catch { /* ignora */ }
    wheel.classList.add('active');
  });
  wheel.addEventListener('pointermove', (e) => {
    if (wheelY === null) return;
    scr.y += (e.clientY - wheelY) * 2.4;
    wheelY = e.clientY;
    sendPos(scr, e.timeStamp);
  });
  const wheelEnd = () => { wheelY = null; wheel.classList.remove('active'); };
  wheel.addEventListener('pointerup', wheelEnd);
  wheel.addEventListener('pointercancel', wheelEnd);

  // ------------------------------------------------------------- controles
  const SLIDERS = {
    sens: (v) => `${v}×`, accel: (v) => fmt(v, 1), smooth: (v) => fmt(v, 1),
    startPx: (v) => fmt(v, 2), minPsr: (v) => fmt(v, 1), gyroDelay: (v) => `${v}`,
  };
  const TOGGLES = ['rowNormalize', 'lockExposure', 'wide', 'hiRes', 'gyroComp', 'smoothing', 'invX', 'invY', 'swap'];

  function syncControls() {
    for (const [id, fmt] of Object.entries(SLIDERS)) {
      $('#' + id).value = settings[id];
      $('#out-' + id).textContent = fmt(Number(settings[id]));
    }
    for (const id of TOGGLES) $('#' + id).checked = !!settings[id];
  }

  for (const [id, fmt] of Object.entries(SLIDERS)) {
    const el = $('#' + id);
    el.addEventListener('input', () => {
      settings[id] = Number(el.value);
      $('#out-' + id).textContent = fmt(settings[id]);
      if (id === 'startPx') motion.setStartPx(settings.startPx);
      save();
    });
  }
  for (const id of TOGGLES) {
    const el = $('#' + id);
    el.addEventListener('change', () => {
      settings[id] = el.checked;
      save();
      if (['rowNormalize', 'wide', 'hiRes'].includes(id)) recenter();
      if (id === 'lockExposure' && video.srcObject) {
        if (el.checked) lockExposure();
        else ui.exp.textContent = 'recarregue para soltar';
      }
    });
  }
  // A suavidade muda o filtro: recria para aplicar.
  $('#smooth').addEventListener('change', () => location.reload());

  // ------------------------------------------------------------- início
  $('#btn-start').addEventListener('click', async () => {
    ui.intro.classList.add('hidden');
    await enableMotion();
    try {
      if ('wakeLock' in navigator) navigator.wakeLock.request('screen').catch(() => {});
      await openCamera();
      status(calib ? 'Câmera aberta.' : 'Câmera aberta. Agora toque em “Calibrar”.', 'ok');
    } catch (err) {
      status(`Não foi possível abrir a câmera: ${err.message || err}`, 'warn');
    }
  });

  document.addEventListener('gesturestart', (e) => e.preventDefault());
  syncControls();
  showSummary();
  setConn();
  connect();

  // ---------------------------------------------------- teto sintético
  // Para testes sem celular: teto com "luminárias" que anda num círculo de
  // raio 40 px a cada 4 s. Controle pelo console:
  //   window.__fakePause = true            → para
  //   window.__fakeVel = { x: 2, y: 0 }    → anda em linha reta (px por quadro)
  function fakeCanvas() {
    const c = document.createElement('canvas');
    c.width = 640; c.height = 480;
    const ctx = c.getContext('2d');
    const tex = document.createElement('canvas');
    tex.width = tex.height = 1024;
    const tctx = tex.getContext('2d');
    tctx.fillStyle = '#c8c8c8';
    tctx.fillRect(0, 0, 1024, 1024);
    let seed = 11;
    const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
    for (let i = 0; i < 140; i++) {
      tctx.fillStyle = `rgb(${60 + rand() * 120 | 0},${60 + rand() * 120 | 0},${60 + rand() * 120 | 0})`;
      tctx.beginPath();
      tctx.arc(rand() * 1024, rand() * 1024, 6 + rand() * 30, 0, Math.PI * 2);
      tctx.fill();
    }
    let phase = 0, last = performance.now();
    let lin = { x: 0, y: 0 };
    window.__fakePos = { x: 0, y: 0 };
    // Desenha um quadro novo a cada leitura (chamado por onFrame).
    c.draw = () => {
      const now = performance.now();
      const vel = window.__fakeVel;
      if (vel) { lin.x += vel.x; lin.y += vel.y; }
      else if (!window.__fakePause) phase += ((now - last) / 4000) * Math.PI * 2;
      last = now;
      const ox = 192 + Math.cos(phase) * 40 + lin.x, oy = 272 + Math.sin(phase) * 40 + lin.y;
      window.__fakePos = { x: ox, y: oy };
      ctx.drawImage(tex, -ox, -oy);
      // ruído de sensor
      const id = ctx.getImageData(0, 0, 640, 480);
      for (let i = 0; i < id.data.length; i += 4) {
        const nse = (rand() - 0.5) * 6;
        id.data[i] += nse; id.data[i + 1] += nse; id.data[i + 2] += nse;
      }
      ctx.putImageData(id, 0, 0);
    };
    return c;
  }
})();
