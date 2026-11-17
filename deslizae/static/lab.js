'use strict';

/*
 * Celular como mouse: a câmera frontal acompanha o teto.
 *
 * Pipeline por quadro (até 120 Hz):
 *   câmera (exposição travada) → recorte central em cinza → worker:
 *   Lucas-Kanade contra quadro de referência, com anticintilação (flow.js) →
 *   referencial do aparelho (a tela pode girar sozinha) →
 *   − efeito da inclinação (giroscópio sem viés, se a calibração for boa) →
 *   detector parado/movendo + filtro 1€ (motion.js) →
 *   eixos calibrados → sensibilidade/aceleração → cursor.
 *
 * A interface fica fixa no aparelho (tela cheia + trava em retrato; onde não
 * há trava, a página gira por CSS). Mesmo protocolo do touchpad: o agente no
 * PC não muda.
 *
 * ?fake=1 troca a câmera por um teto sintético (window.__fakePause,
 * window.__fakeVel = {x, y} controlam o movimento).
 */
(() => {
  const OP = { PING: 0x05, MOVE: 0x10, SCROLL: 0x11, BUTTON: 0x12, CLICK: 0x13, ZOOM: 0x14, PONG: 0x85 };
  const PALM_PX = 42; // contato mais largo que isto (px CSS) é palma, não ponta de dedo
  const CALIB_KEY = 'labCalib3';
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  const Motion = window.DeslizaeMotion;

  // ------------------------------------------------------------- ajustes
  const DEFAULTS = {
    sens: 18, accel: 1.2, smooth: 1.2, startPx: 0.35, gyroDelay: 0,
    touchpad: true, tpSens: 1.6,
    gyroComp: true, rowNormalize: true, lockExposure: true, wide: false, smoothing: true,
    invX: false, invY: false, swap: false,
  };
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* ignora */ } },
    del(k) { try { localStorage.removeItem(k); } catch { /* ignora */ } },
  };
  const settings = { ...DEFAULTS };
  try { Object.assign(settings, JSON.parse(store.get('labSettings3') || '{}')); } catch { /* ignora */ }
  const save = () => store.set('labSettings3', JSON.stringify(settings));

  // { A: eixos, Mg: giroscópio→imagem (ou null), r2, sigma, startPx, bias }
  let calib = null;
  try { calib = JSON.parse(store.get(CALIB_KEY) || 'null'); } catch { /* ignora */ }

  const params = new URLSearchParams(location.search);
  const FAKE = params.get('fake') === '1';
  const token = params.get('t') || store.get('token');
  if (token) store.set('token', token);

  const fmt = (v, d) => v.toLocaleString('pt-BR', { minimumFractionDigits: d, maximumFractionDigits: d });
  const el = (id) => document.getElementById(id);
  const ui = {
    app: el('app'), dot: el('dot'), toast: el('toast'), intro: el('intro'), video: el('video'),
    sheet: el('sheet'), backdrop: el('sheet-backdrop'), summary: el('calib-summary'),
    wizard: el('wizard'), wizStep: el('wiz-step'), wizTitle: el('wiz-title'), wizText: el('wiz-text'),
    wizBar: el('wiz-bar'), wizLive: el('wiz-live'),
    m: {
      fps: el('m-fps'), res: el('m-res'), proc: el('m-proc'), lat: el('m-lat'), align: el('m-res2'),
      jitter: el('m-jitter'), gyro: el('m-gyro'), exp: el('m-exp'), orient: el('m-orient'),
      state: el('m-state'), net: el('m-net'),
    },
  };

  let toastTimer = 0;
  function toast(text, ms = 1800) {
    ui.toast.textContent = text;
    ui.toast.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => ui.toast.classList.remove('on'), ms);
  }

  // ---------------------------------------------------------- orientação
  // A interface fica presa ao aparelho. Se o sistema girar a tela (comum com
  // o celular deitado), a página gira de volta por CSS e os toques/vetores
  // são convertidos.
  let screenAngle = 0;
  const orient = { rot: 0, W: innerWidth, H: innerHeight };

  function readAngle() {
    const a = screen.orientation && typeof screen.orientation.angle === 'number'
      ? screen.orientation.angle
      : (typeof window.orientation === 'number' ? window.orientation : 0);
    return ((a % 360) + 360) % 360;
  }

  function applyOrientation() {
    screenAngle = readAngle();
    const W = innerWidth, H = innerHeight;
    const rot = screenAngle === 90 ? -90 : screenAngle === 270 ? 90 : screenAngle === 180 ? 180 : 0;
    const app = ui.app;
    if (rot === 0) {
      app.style.width = app.style.height = app.style.transform = '';
    } else if (rot === 180) {
      app.style.width = app.style.height = '';
      app.style.transform = 'rotate(180deg)';
      app.style.transformOrigin = '50% 50%';
    } else {
      app.style.width = `${H}px`;
      app.style.height = `${W}px`;
      app.style.transformOrigin = '0 0';
      app.style.transform = rot === 90 ? 'rotate(90deg) translateY(-100%)' : 'rotate(-90deg) translateX(-100%)';
    }
    Object.assign(orient, { rot, W, H });
    app.classList.toggle('rotated', rot !== 0);
    ui.m.orient.textContent = `${screenAngle}°` + (rot ? ' (compensada)' : '');
    resetTracking();
  }
  addEventListener('resize', applyOrientation);
  if (screen.orientation) screen.orientation.addEventListener('change', applyOrientation);

  /** Ponto da tela → ponto da interface (para a rodinha). */
  function toUi(e) {
    const x = e.clientX, y = e.clientY;
    if (orient.rot === 90) return { x: y, y: orient.W - x };
    if (orient.rot === -90) return { x: orient.H - y, y: x };
    if (orient.rot === 180) return { x: orient.W - x, y: orient.H - y };
    return { x, y };
  }

  async function lockOrientation() {
    try {
      if (document.documentElement.requestFullscreen && !document.fullscreenElement) {
        await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
      }
      if (screen.orientation && screen.orientation.lock) await screen.orientation.lock('portrait');
    } catch { /* sem suporte: a compensação por CSS cuida */ }
  }

  // ------------------------------------------------------------ conexão
  let ws = null, wsOpen = false, pc = null, dc = null, dcOpen = false, rtt = 0;
  const channel = () => (dcOpen ? dc : wsOpen ? ws : null);

  function connect() {
    if (!token) { toast('Abra pelo QR code do laboratório', 5000); return; }
    const sock = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?t=${encodeURIComponent(token)}`);
    sock.binaryType = 'arraybuffer';
    ws = sock;
    sock.onopen = () => {
      wsOpen = true;
      for (const p of [cur, scr, zm]) { p.seq = 0; p.x = p.y = 0; }
      startRtc(sock);
      updateDot();
    };
    sock.onmessage = (e) => {
      if (typeof e.data !== 'string') { onBinary(e.data); return; }
      let m; try { m = JSON.parse(e.data); } catch { return; }
      if (m.type === 'answer' && pc) pc.setRemoteDescription({ type: 'answer', sdp: m.sdp }).catch(() => {});
    };
    sock.onclose = () => {
      if (ws !== sock) return;
      wsOpen = false; dcOpen = false;
      try { pc && pc.close(); } catch { /* ignora */ }
      pc = dc = null;
      updateDot();
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
      ch.onopen = () => { dcOpen = true; };
      ch.onclose = () => { dcOpen = false; };
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
    }
  }

  setInterval(() => {
    const ch = channel();
    ui.m.net.textContent = wsOpen ? `${dcOpen ? 'UDP' : 'TCP'} · ${Math.round(rtt)} ms` : 'desconectado';
    if (!ch) return;
    const b = new ArrayBuffer(9), v = new DataView(b);
    v.setUint8(0, OP.PING); v.setFloat64(1, performance.now(), true);
    ch.send(b);
  }, 1000);

  // -------------------------------------------------------------- envio
  const cur = { op: OP.MOVE, seq: 0, x: 0, y: 0 };
  const scr = { op: OP.SCROLL, seq: 0, x: 0, y: 0 };
  const zm = { op: OP.ZOOM, seq: 0, x: 0, y: 0 };
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
    if (navigator.vibrate) navigator.vibrate(down ? 10 : 5);
  }

  function sendClick(button) {
    const b = new ArrayBuffer(26), v = new DataView(b);
    v.setUint8(0, OP.CLICK); v.setUint32(1, ++eventId, true);
    v.setUint8(5, button);
    v.setUint32(6, cur.seq, true); v.setFloat64(10, cur.x, true); v.setFloat64(18, cur.y, true);
    if (dcOpen) { try { dc.send(b); } catch { /* ignora */ } }
    if (wsOpen) ws.send(b);
  }

  // ------------------------------------------------------------ giroscópio
  // Ângulo acumulado (graus) nos eixos X (beta) e Y (gamma) do aparelho, sem
  // o viés (o giroscópio lê alguns centésimos de °/s mesmo parado; integrado,
  // isso viraria deriva).
  const gyroHist = [];
  let gyroAngle = { x: 0, y: 0 };
  let gyroBias = calib && calib.bias ? { ...calib.bias } : { x: 0, y: 0 };
  let lastGyroT = null, gyroSeen = false, lastRate = { x: 0, y: 0 };
  const rawRates = [];

  function onMotion(e) {
    const r = e.rotationRate;
    if (!r || r.beta == null) return;
    gyroSeen = true;
    const t = e.timeStamp;
    lastRate = { x: r.beta, y: r.gamma };
    if (wizard && wizard.step === 'still') rawRates.push({ x: r.beta, y: r.gamma });
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
    addEventListener('devicemotion', onMotion);
    return true;
  }

  // ------------------------------------------------------------ câmera
  const video = ui.video;
  const work = document.createElement('canvas');
  const wctx = work.getContext('2d', { willReadFrequently: true });
  const worker = new Worker('/static/flow-worker.js');
  const N = 128;
  let source = video, cameraOn = false, busy = false, resetNext = false;
  let frames = 0, fpsT0 = performance.now(), camFps = 0;

  /** Pede 120 fps; se a câmera não chegar perto, tenta resolução menor. */
  async function openCamera() {
    if (FAKE) {
      source = fakeCanvas();
      ui.m.exp.textContent = 'simulada';
      ui.m.res.textContent = '640×480 (simulada)';
      cameraOn = true;
      scheduleFrame();
      return;
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('o navegador não liberou a câmera (a página precisa estar em HTTPS)');
    }
    const ask = (w, h) => navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: 'user', width: { ideal: w }, height: { ideal: h }, frameRate: { ideal: 120, min: 24 } },
    });
    let stream = await ask(640, 480);
    let fps = stream.getVideoTracks()[0].getSettings().frameRate || 0;
    if (fps && fps < 90) {
      // Muitas câmeras frontais só passam de 60 fps em resolução menor.
      try {
        const small = await ask(320, 240);
        const sfps = small.getVideoTracks()[0].getSettings().frameRate || 0;
        if (sfps > fps * 1.3) { stream.getTracks().forEach((t) => t.stop()); stream = small; fps = sfps; }
        else small.getTracks().forEach((t) => t.stop());
      } catch { /* fica com a primeira */ }
    }
    video.srcObject = stream;
    await video.play();
    const s = stream.getVideoTracks()[0].getSettings();
    ui.m.res.textContent = `${s.width}×${s.height} @ ${Math.round(s.frameRate || 0)} fps`;
    cameraOn = true;
    scheduleFrame();
    if (settings.lockExposure) setTimeout(lockExposure, 1200);
    else ui.m.exp.textContent = 'automática';
  }

  async function lockExposure() {
    const track = video.srcObject && video.srcObject.getVideoTracks()[0];
    const caps = track && track.getCapabilities ? track.getCapabilities() : {};
    const advanced = [];
    if ((caps.exposureMode || []).includes('manual')) advanced.push({ exposureMode: 'manual' });
    if ((caps.whiteBalanceMode || []).includes('manual')) advanced.push({ whiteBalanceMode: 'manual' });
    if (!advanced.length) { ui.m.exp.textContent = 'não suportado'; return; }
    try { await track.applyConstraints({ advanced }); ui.m.exp.textContent = 'travada'; }
    catch { ui.m.exp.textContent = 'não suportado'; }
  }

  function scheduleFrame() {
    if (FAKE) setTimeout(() => onFrame(performance.now(), {}), 1000 / 120);
    else if ('requestVideoFrameCallback' in video) video.requestVideoFrameCallback(onFrame);
    else requestAnimationFrame((now) => onFrame(now, {}));
  }

  let geomK = 2;

  function onFrame(now, meta) {
    scheduleFrame();
    frames++;
    if (now - fpsT0 > 1000) {
      camFps = Math.round((frames * 1000) / (now - fpsT0));
      ui.m.fps.textContent = `${camFps} fps`;
      frames = 0; fpsT0 = now;
    }
    const t = meta.captureTime || meta.expectedDisplayTime || now;
    if (meta.captureTime) ui.m.lat.textContent = `${Math.round(performance.now() - meta.captureTime)} ms`;
    if (busy) return; // um quadro por vez: pular é melhor que acumular atraso

    if (FAKE) source.draw();
    const sw = source.videoWidth || source.width, sh = source.videoHeight || source.height;
    const side = Math.min(sw, sh);
    if (!side) return;
    // Recorte central: mira o teto logo acima e fica longe dos dedos nos botões.
    const region = settings.wide ? side : Math.min(side, 256);
    geomK = region / N;
    if (work.width !== N) { work.width = work.height = N; }
    wctx.drawImage(source, (sw - region) / 2, (sh - region) / 2, region, region, 0, 0, N, N);
    const gray = window.DeslizaeFlow.toGray(wctx.getImageData(0, 0, N, N).data, new Float32Array(N * N));
    busy = true;
    worker.postMessage({ gray, n: N, t, rowNormalize: settings.rowNormalize, rekeyPx: 8, reset: resetNext }, [gray.buffer]);
    resetNext = false;
  }

  // ------------------------------------------------------ processamento
  const motion = Motion.createMotionFilter({ startPx: settings.startPx, minCutoff: settings.smooth });
  let prev = null;                 // última amostra válida: posição (tela) e ângulo
  let corr = { x: 0, y: 0 };       // posição corrigida no referencial do aparelho
  let tracking = false;
  let freezeUntil = 0;             // clique estável
  const jitter = [];

  function resetTracking() {
    resetNext = true;
    prev = null;
    motion.reset();
    jitter.length = 0;
  }

  function updateDot() {
    let cls = '';
    if (!wsOpen) cls = 'bad';
    else if (!cameraOn) cls = '';
    else if (!tracking) cls = 'warn';
    else cls = motion.moving ? 'moving' : 'ok';
    ui.dot.className = 'status-dot ' + cls;
  }

  worker.onmessage = (e) => {
    busy = false;
    const r = e.data;
    ui.m.proc.textContent = `${fmt(r.ms, 1)} ms`;
    ui.m.align.textContent = r.valid ? `${fmt(r.residual, 2)} (${r.method})` : 'sem rastreio';

    if (!r.valid) {
      tracking = false;
      prev = null;
      motion.reset();
      ui.m.state.textContent = r.contrast < 1 ? 'sem imagem' : 'sem textura';
      updateDot();
      return;
    }
    tracking = true;

    const pos = { x: r.x * geomK, y: r.y * geomK };
    const ang = gyroSeen ? angleAt(r.t + settings.gyroDelay) : null;
    if (prev) {
      // Deslocamento do quadro, no referencial do aparelho.
      let d = Motion.screenToDevice({ x: pos.x - prev.pos.x, y: pos.y - prev.pos.y }, screenAngle);
      const dg = ang && prev.ang ? { x: ang.x - prev.ang.x, y: ang.y - prev.ang.y } : null;
      if (wizard) wizardSample(d, dg);
      const Mg = calib && calib.Mg;
      if (settings.gyroComp && Mg && dg) {
        d = { x: d.x - (Mg[0] * dg.x + Mg[1] * dg.y), y: d.y - (Mg[2] * dg.x + Mg[3] * dg.y) };
      }
      corr = { x: corr.x + d.x, y: corr.y + d.y };
    }
    prev = { pos, ang };

    jitter.push({ ...corr });
    if (jitter.length > 30) jitter.shift();

    const m = motion.push(corr.x, corr.y, r.t / 1000);
    ui.m.state.textContent = m.moving ? 'movendo' : 'parado';
    updateDot();

    if (wizard || !calib || (!m.dx && !m.dy)) return;
    if (performance.now() < freezeUntil) return; // clique estável
    if (gestures.activeCount > 0) return;         // dedo no touchpad: a câmera fica quieta

    let v = Motion.apply(calib.A, m.dx, m.dy);
    if (settings.swap) v = { x: v.y, y: v.x };
    if (settings.invX) v.x = -v.x;
    if (settings.invY) v.y = -v.y;

    // Devagar = preciso; rápido = longo (velocidade em px de câmera por segundo).
    const s = Math.min(1, Math.max(0, (m.speed - 3) / (80 - 3)));
    const gain = settings.sens * (1 + settings.accel * 3 * s * s * (3 - 2 * s));
    cur.x += v.x * gain;
    cur.y += v.y * gain;
    sendPos(cur, r.t);
  };

  setInterval(() => {
    ui.m.gyro.textContent = gyroSeen
      ? `${fmt(Math.hypot(lastRate.x - gyroBias.x, lastRate.y - gyroBias.y), 1)} °/s`
      : 'indisponível';
    if (jitter.length >= 10 && !motion.moving) {
      const mx = jitter.reduce((a, p) => a + p.x, 0) / jitter.length;
      const my = jitter.reduce((a, p) => a + p.y, 0) / jitter.length;
      const sd = Math.sqrt(jitter.reduce((a, p) => a + (p.x - mx) ** 2 + (p.y - my) ** 2, 0) / jitter.length);
      ui.m.jitter.textContent = `${fmt(sd, 3)} px`;
    }
  }, 300);

  // ------------------------------------------------- assistente de calibração
  let wizard = null;

  const STEPS = [
    { id: 'still', title: 'Deixe parado', text: 'Solte o celular na mesa e não encoste nele.', ms: 2500 },
    { id: 'tilt', title: 'Balance sem deslizar', text: 'Com um dedo na borda, balance o celular para os lados e para frente e para trás, sem tirá-lo do lugar.', ms: 4000, gyro: true },
    { id: 'right', title: 'Para a direita', text: 'Deslize o celular uns 10 cm para a DIREITA. Pode voltar depois.', gesture: true },
    { id: 'fwd', title: 'Para frente', text: 'Deslize o celular uns 10 cm para FRENTE (para longe de você). Pode voltar depois.', gesture: true },
  ];

  function wizardSample(d, dg) {
    const w = wizard;
    if (w.step === 'still') {
      w.still.push({ x: w.sx += d.x, y: w.sy += d.y });
    } else if (w.step === 'tilt' && dg) {
      w.tilt.push({ gx: dg.x, gy: dg.y, dx: d.x, dy: d.y });
    } else if (w.traj) {
      let { x, y } = d;
      if (w.Mg && dg) { x -= w.Mg[0] * dg.x + w.Mg[1] * dg.y; y -= w.Mg[2] * dg.x + w.Mg[3] * dg.y; }
      w.gx += x; w.gy += y;
      w.traj.push({ t: performance.now(), x: w.gx, y: w.gy });
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

  /** Grava a trajetória até o gesto terminar: afastou-se e parou (ou voltou). */
  async function gestureStep() {
    // Só começa a gravar com o celular parado: o fim do gesto anterior (a
    // volta) não pode entrar neste.
    const tw = performance.now();
    let stillSince = null;
    while (performance.now() - tw < 4000) {
      if (!wizard) throw new Error('cancelado');
      if (!motion.moving) { stillSince = stillSince || performance.now(); if (performance.now() - stillSince > 300) break; }
      else { stillSince = null; ui.wizLive.textContent = 'Aguarde parar…'; }
      await sleep(50);
    }
    wizard.traj = [];
    wizard.gx = wizard.gy = 0;
    const t0 = performance.now();
    let peak = 0;
    while (performance.now() - t0 < 12000) {
      if (!wizard) throw new Error('cancelado');
      const tr = wizard.traj;
      const now = tr.length ? Math.hypot(tr[tr.length - 1].x, tr[tr.length - 1].y) : 0;
      peak = Math.max(peak, now);
      ui.wizLive.textContent = peak > 12 ? 'Isso! Pode parar.' : 'Aguardando o movimento…';
      ui.wizBar.style.width = `${Math.min(100, (peak / 40) * 100)}%`;
      if (peak > 20) {
        const recent = tr.filter((p) => performance.now() - p.t < 350);
        const span = recent.length > 2
          ? Math.hypot(recent[recent.length - 1].x - recent[0].x, recent[recent.length - 1].y - recent[0].y) : 99;
        if (span < 1 || now < peak * 0.4) break; // parou, ou já está voltando
      }
      await sleep(50);
    }
    if (peak < 12) throw new Error('não detectei o movimento: o teto está visível?');
    await sleep(300); // deixa o restante do gesto entrar na trajetória
    return Motion.gestureVector(wizard.traj);
  }

  async function runWizard() {
    if (!cameraOn) { toast('Toque em Começar primeiro'); return; }
    closeSheet();
    wizard = { step: null, still: [], sx: 0, sy: 0, tilt: [], traj: null, Mg: null };
    ui.wizard.classList.remove('hidden');
    const result = {};
    try {
      for (const [i, step] of STEPS.entries()) {
        if (step.gyro && !gyroSeen) continue;
        wizard.step = step.id;
        wizard.traj = null;
        ui.wizStep.textContent = `PASSO ${i + 1} DE ${STEPS.length}`;
        ui.wizTitle.textContent = step.title;
        ui.wizText.textContent = step.text;
        ui.wizLive.textContent = '';
        ui.wizBar.style.width = '0%';
        if (step.id === 'still') { rawRates.length = 0; await sleep(400); wizard.still = []; wizard.sx = wizard.sy = 0; }

        if (step.ms) await timedStep(step.ms);

        if (step.id === 'still') {
          const p = wizard.still;
          if (p.length < 15) throw new Error('rastreio instável: aponte a câmera para uma área com textura no teto');
          const mx = p.reduce((a, q) => a + q.x, 0) / p.length;
          const my = p.reduce((a, q) => a + q.y, 0) / p.length;
          result.sigma = Math.sqrt(p.reduce((a, q) => a + (q.x - mx) ** 2 + (q.y - my) ** 2, 0) / p.length);
          result.startPx = Math.min(2, Math.max(0.2, 6 * result.sigma));
          if (rawRates.length) {
            result.bias = {
              x: rawRates.reduce((a, q) => a + q.x, 0) / rawRates.length,
              y: rawRates.reduce((a, q) => a + q.y, 0) / rawRates.length,
            };
            gyroBias = { ...result.bias };
          }
        } else if (step.id === 'tilt') {
          const exc = wizard.tilt.reduce((a, s) => a + s.gx * s.gx + s.gy * s.gy, 0);
          const fit = Motion.gyroFit(wizard.tilt);
          // Só usa a compensação se a inclinação explicar bem o movimento da imagem.
          if (fit && exc > 6 && fit.r2 > 0.6) { result.Mg = fit.M; result.r2 = fit.r2; wizard.Mg = fit.M; }
          else { result.Mg = null; result.r2 = fit ? fit.r2 : 0; }
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
      if (Math.abs(angle - 90) > 35) throw new Error(`os movimentos ficaram a ${Math.round(angle)}° um do outro (esperado ~90°); deslize em linhas retas`);
      result.A = A;
      result.date = Date.now();
      calib = result;
      store.set(CALIB_KEY, JSON.stringify(calib));
      settings.startPx = calib.startPx;
      settings.invX = settings.invY = settings.swap = false;
      save();
      syncControls();
      motion.setStartPx(settings.startPx);
      showSummary();
      toast('Calibrado. Pode usar!', 2500);
    } catch (err) {
      if (err.message !== 'cancelado') toast(`Calibração: ${err.message}`, 5000);
    } finally {
      wizard = null;
      ui.wizard.classList.add('hidden');
      resetTracking();
    }
  }

  function showSummary() {
    if (!calib || !calib.A) {
      ui.summary.textContent = 'Não calibrado: toque em Calibrar.';
      ui.summary.className = 'calib-summary warn';
      return;
    }
    const tilt = calib.Mg ? `inclinação ✓ (R² ${fmt(calib.r2, 2)})` : 'inclinação: sem compensação';
    ui.summary.textContent = `Calibrado · eixos ✓ · ${tilt} · ruído ${fmt(calib.sigma, 3)} px`;
    ui.summary.className = 'calib-summary ok';
  }

  // ------------------------------------------------------------- botões
  for (const key of $$('.key')) {
    const button = Number(key.dataset.button);
    let id = null;
    key.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      if (id !== null) return;
      id = e.pointerId;
      try { key.setPointerCapture(id); } catch { /* ignora */ }
      key.classList.add('pressed');
      freezeUntil = performance.now() + 120; // o toque não pode "empurrar" o cursor
      sendButton(button, true);
    });
    const up = (e) => {
      if (e.pointerId !== id) return;
      id = null;
      key.classList.remove('pressed');
      freezeUntil = performance.now() + 120;
      sendButton(button, false);
    };
    key.addEventListener('pointerup', up);
    key.addEventListener('pointercancel', up);
    key.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  // Rodinha: arrastar para cima/baixo rola a página.
  const wheel = el('wheel');
  let wheelY = null;
  wheel.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    wheelY = toUi(e).y;
    try { wheel.setPointerCapture(e.pointerId); } catch { /* ignora */ }
    wheel.classList.add('active');
    freezeUntil = performance.now() + 120;
  });
  wheel.addEventListener('pointermove', (e) => {
    if (wheelY === null) return;
    const y = toUi(e).y;
    scr.y += (y - wheelY) * 2.4;
    wheelY = y;
    freezeUntil = performance.now() + 120; // rolando, o cursor fica quieto
    sendPos(scr, e.timeStamp);
  });
  const wheelEnd = () => { wheelY = null; wheel.classList.remove('active'); };
  wheel.addEventListener('pointerup', wheelEnd);
  wheel.addEventListener('pointercancel', wheelEnd);

  // ---------------------------------------------------- touchpad na palma
  // Mesmo motor de gestos do touchpad (gestures.js), com rejeição de palma:
  // contato largo é ignorado; com o celular deslizando, a mão está no "modo
  // mouse" e novos toques são ignorados; um toque parado quando outro dedo
  // chega é a palma apoiada; e "segurar para arrastar" fica desligado.
  const palm = el('palm');
  const gestures = window.DeslizaeGestures.create(palm, {
    settings: () => ({
      sensitivity: settings.tpSens, acceleration: 1.0, scrollSpeed: 1.5, naturalScroll: true,
      inertia: true, tapToClick: true, tapDrag: true, pinchZoom: true,
      longPressDrag: false, dropResting: true,
    }),
    toUi,
    accept: (e) => {
      if (!settings.touchpad) return false;
      if (e.target.closest && e.target.closest('.gear')) return false;
      if (e.pointerType === 'touch' && (e.width > PALM_PX || e.height > PALM_PX)) return false;
      return !motion.moving;
    },
    move: (dx, dy, t) => { cur.x += dx; cur.y += dy; sendPos(cur, t); },
    scroll: (wx, wy, t) => { scr.x += wx; scr.y += wy; sendPos(scr, t); },
    zoom: (z, t) => { zm.x += z; sendPos(zm, t); },
    button: sendButton,
    click: sendClick,
    haptic: (ms) => { if (navigator.vibrate) navigator.vibrate(ms); },
    canInertia: () => wsOpen,
    onTouches: (points) => {
      palm.classList.toggle('touching', points.length > 0);
      // Ao soltar, a câmera espera um instante: o toque pode ter balançado o celular.
      if (!points.length) freezeUntil = performance.now() + 150;
    },
  });

  // ------------------------------------------------------------- ajustes
  const SLIDERS = {
    sens: (v) => `${v}×`, accel: (v) => fmt(v, 1), smooth: (v) => fmt(v, 1),
    startPx: (v) => fmt(v, 2), gyroDelay: (v) => `${v}`, tpSens: (v) => `${fmt(v, 1)}×`,
  };
  const TOGGLES = ['touchpad', 'gyroComp', 'rowNormalize', 'lockExposure', 'wide', 'smoothing', 'invX', 'invY', 'swap'];

  function syncControls() {
    for (const [id, f] of Object.entries(SLIDERS)) {
      el(id).value = settings[id];
      el('out-' + id).textContent = f(Number(settings[id]));
    }
    for (const id of TOGGLES) el(id).checked = !!settings[id];
  }
  for (const [id, f] of Object.entries(SLIDERS)) {
    el(id).addEventListener('input', () => {
      settings[id] = Number(el(id).value);
      el('out-' + id).textContent = f(settings[id]);
      if (id === 'startPx') motion.setStartPx(settings.startPx);
      save();
    });
  }
  el('smooth').addEventListener('change', () => location.reload()); // recria o filtro
  for (const id of TOGGLES) {
    el(id).addEventListener('change', () => {
      settings[id] = el(id).checked;
      save();
      if (id === 'rowNormalize' || id === 'wide') resetTracking();
      if (id === 'lockExposure' && el(id).checked && cameraOn) lockExposure();
    });
  }

  function openSheet() { ui.sheet.hidden = false; ui.backdrop.hidden = false; }
  function closeSheet() { ui.sheet.hidden = true; ui.backdrop.hidden = true; }
  el('btn-settings').addEventListener('click', openSheet);
  el('btn-close').addEventListener('click', closeSheet);
  ui.backdrop.addEventListener('click', closeSheet);
  el('btn-calibrate').addEventListener('click', runWizard);
  el('wiz-cancel').addEventListener('click', () => { wizard = null; });
  el('btn-recenter').addEventListener('click', () => { resetTracking(); toast('Rastreio recomeçado'); });
  el('btn-forget').addEventListener('click', () => {
    calib = null;
    store.del(CALIB_KEY);
    settings.startPx = DEFAULTS.startPx;
    save(); syncControls(); motion.setStartPx(settings.startPx); showSummary();
  });

  // ------------------------------------------------------------- início
  el('btn-start').addEventListener('click', async () => {
    ui.intro.classList.add('hidden');
    await lockOrientation();
    await enableMotion();
    try {
      if ('wakeLock' in navigator) navigator.wakeLock.request('screen').catch(() => {});
      await openCamera();
      if (!calib) runWizard(); // sem calibração não dá para usar: já abre o assistente
    } catch (err) {
      toast(`Câmera: ${err.message || err}`, 6000);
    }
  });

  // Sem zoom, sem menu de contexto, sem rolar a página.
  document.addEventListener('gesturestart', (e) => e.preventDefault());
  document.addEventListener('contextmenu', (e) => e.preventDefault());
  document.addEventListener('touchmove', (e) => { if (!ui.sheet.contains(e.target)) e.preventDefault(); }, { passive: false });

  syncControls();
  showSummary();
  applyOrientation();
  updateDot();
  connect();

  // ---------------------------------------------------- teto sintético
  function fakeCanvas() {
    const c = document.createElement('canvas');
    c.width = 640; c.height = 480;
    const ctx = c.getContext('2d');
    const tex = document.createElement('canvas');
    tex.width = tex.height = 1400;
    const tctx = tex.getContext('2d');
    tctx.fillStyle = '#c8c8c8';
    tctx.fillRect(0, 0, 1400, 1400);
    let seed = 11;
    const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
    for (let i = 0; i < 260; i++) {
      tctx.fillStyle = `rgb(${60 + rand() * 120 | 0},${60 + rand() * 120 | 0},${60 + rand() * 120 | 0})`;
      tctx.beginPath();
      tctx.arc(rand() * 1400, rand() * 1400, 6 + rand() * 30, 0, Math.PI * 2);
      tctx.fill();
    }
    let phase = 0, last = performance.now();
    const lin = { x: 0, y: 0 };
    c.draw = () => {
      const now = performance.now();
      const vel = window.__fakeVel;
      if (vel) { lin.x += vel.x; lin.y += vel.y; }
      else if (!window.__fakePause) phase += ((now - last) / 4000) * Math.PI * 2;
      last = now;
      const ox = 380 + Math.cos(phase) * 40 + lin.x, oy = 460 + Math.sin(phase) * 40 + lin.y;
      ctx.drawImage(tex, -ox, -oy);
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
