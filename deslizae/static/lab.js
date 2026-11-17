'use strict';

/*
 * Celular como mouse: a câmera frontal acompanha o teto.
 *
 * Pipeline:
 *   câmera (até 120 fps, exposição manual curta) → worker: luminância do
 *   recorte central direto do VideoFrame → Lucas-Kanade contra quadro de
 *   referência, com anticintilação (flow.js) → referencial do aparelho →
 *   − efeito da inclinação (giroscópio sem viés) →
 *   fusão com o acelerômetro, com o atraso da câmera compensado (fusion.js) →
 *   eixos calibrados → sensibilidade/aceleração → cursor (o agente interpola
 *   a 240 Hz).
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
    sens: 18, accel: 1.2, startPx: 0.35, gyroDelay: 0, fusion: true,
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

  // { A: eixos, Mg: giroscópio→imagem, r2, sigma, startPx, bias,
  //   B: acelerômetro→imagem, lagMs/lagPath: atraso da câmera, accelOnset }
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
      state: el('m-state'), net: el('m-net'), path: el('m-path'), accel: el('m-accel'),
      out: el('m-out'), fusion: el('m-fusion'),
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

  // ------------------------------------------------------- sensores (IMU)
  // Giroscópio: ângulo acumulado (graus) nos eixos X (beta) e Y (gamma), sem o
  // viés, para descontar da imagem o efeito da inclinação.
  // Acelerômetro linear: alimenta a fusão (fusion.js), que preenche o
  // movimento entre quadros e compensa o atraso da câmera.
  const gyroHist = [];
  let gyroAngle = { x: 0, y: 0 };
  let gyroBias = calib && calib.bias ? { ...calib.bias } : { x: 0, y: 0 };
  let lastGyroT = null, gyroSeen = false, lastRate = { x: 0, y: 0 };
  const rawRates = [];
  let accelSource = 'indisponível';
  let accelCount = 0;
  const accelHist = []; // {t, x, y} dos últimos 4 s (calibração)

  const gyroDps = () => Math.hypot(lastRate.x - gyroBias.x, lastRate.y - gyroBias.y);

  function onGyro(t, beta, gamma) {
    gyroSeen = true;
    lastRate = { x: beta, y: gamma };
    if (wizard && wizard.step === 'still') rawRates.push({ x: beta, y: gamma });
    if (!fusion.moving && Math.hypot(beta - gyroBias.x, gamma - gyroBias.y) < 3) {
      gyroBias.x += 0.01 * (beta - gyroBias.x);
      gyroBias.y += 0.01 * (gamma - gyroBias.y);
    }
    if (lastGyroT !== null) {
      const dt = Math.min(100, t - lastGyroT) / 1000;
      gyroAngle = { x: gyroAngle.x + (beta - gyroBias.x) * dt, y: gyroAngle.y + (gamma - gyroBias.y) * dt };
    }
    lastGyroT = t;
    gyroHist.push({ t, x: gyroAngle.x, y: gyroAngle.y });
    while (gyroHist.length && t - gyroHist[0].t > 3000) gyroHist.shift();
  }

  function onAccel(t, ax, ay) {
    if (ax == null || ay == null) return;
    accelCount++;
    accelHist.push({ t, x: ax, y: ay });
    while (accelHist.length && t - accelHist[0].t > 4000) accelHist.shift();
    if (wizard && wizard.step === 'still') wizard.accStill.push({ x: ax, y: ay });
    if (settings.fusion) {
      fusion.imu(t, ax, ay, gyroDps());
      flushOutput(t);
    }
  }

  function onMotion(e) {
    const r = e.rotationRate;
    if (r && r.beta != null) onGyro(e.timeStamp, r.beta, r.gamma);
    // O devicemotion só alimenta o acelerômetro se o Generic Sensor não estiver ativo.
    if (accelSource === 'devicemotion' && e.acceleration) onAccel(e.timeStamp, e.acceleration.x, e.acceleration.y);
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
    // Generic Sensor (Chrome/Android): taxa mais alta e o instante da própria leitura.
    try {
      if ('LinearAccelerationSensor' in window) {
        const s = new window.LinearAccelerationSensor({ frequency: 120 });
        s.addEventListener('reading', () => onAccel(s.timestamp, s.x, s.y));
        s.addEventListener('error', () => { accelSource = 'devicemotion'; });
        s.start();
        accelSource = 'LinearAccelerationSensor';
      }
    } catch { /* cai no devicemotion */ }
    if (typeof DeviceMotionEvent === 'undefined') return false;
    if (typeof DeviceMotionEvent.requestPermission === 'function') {
      try { if (await DeviceMotionEvent.requestPermission() !== 'granted') return false; } catch { return false; }
    }
    if (accelSource !== 'LinearAccelerationSensor') accelSource = 'devicemotion';
    addEventListener('devicemotion', onMotion);
    return true;
  }

  // ------------------------------------------------------------ câmera
  // Caminho preferido: os quadros vão direto para o worker
  // (MediaStreamTrackProcessor), que lê só a luminância do recorte central.
  // Reserva (iPhone, teste): canvas na página.
  const video = ui.video;
  const work = document.createElement('canvas');
  const wctx = work.getContext('2d', { willReadFrequently: true });
  const worker = new Worker('/static/flow-worker.js');
  const N = 128;
  let source = video, cameraOn = false, busy = false, framePath = 'canvas';
  let stream = null, track = null;
  let exposure = { supported: false, value: 0, min: 0, max: 0, lastAdjust: 0 };

  function pushConfig() {
    worker.postMessage({ type: 'config', opts: { n: N, wide: settings.wide, rowNormalize: settings.rowNormalize, rekeyPx: 8 } });
  }
  pushConfig();

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
    stream = await ask(640, 480);
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
    track = stream.getVideoTracks()[0];
    const s = track.getSettings();
    ui.m.res.textContent = `${s.width}×${s.height} @ ${Math.round(s.frameRate || 0)} fps`;

    if ('MediaStreamTrackProcessor' in window) {
      try {
        const proc = new window.MediaStreamTrackProcessor({ track });
        worker.postMessage({ type: 'stream', readable: proc.readable }, [proc.readable]);
        framePath = 'worker';
      } catch { framePath = 'canvas'; }
    }
    if (framePath === 'canvas') await useCanvasPath();
    cameraOn = true;
    setTimeout(setupExposure, 1000); // deixa o automático acertar o ponto de partida
  }

  async function useCanvasPath() {
    framePath = 'canvas';
    video.srcObject = stream;
    await video.play().catch(() => {});
    scheduleFrame();
  }

  /**
   * Exposição manual e curta: sem ela, com pouca luz a câmera alonga a
   * exposição e derruba o fps sozinha (é comum cair para 15–20 fps), além de
   * borrar a imagem quando o celular se move.
   */
  async function setupExposure() {
    if (FAKE || !track || !track.getCapabilities) return;
    if (!settings.lockExposure) { ui.m.exp.textContent = 'automática'; return; }
    const caps = track.getCapabilities();
    const advanced = [];
    if ((caps.whiteBalanceMode || []).includes('manual')) advanced.push({ whiteBalanceMode: 'manual' });
    const manual = (caps.exposureMode || []).includes('manual');
    if (manual && caps.exposureTime) {
      const fps = track.getSettings().frameRate || 30;
      // exposureTime em unidades de 100 µs; o teto respeita o intervalo do quadro.
      const max = Math.min(caps.exposureTime.max, Math.floor((1000 / fps - 1) * 10));
      exposure = { supported: true, min: caps.exposureTime.min, max, value: Math.min(max, Math.max(caps.exposureTime.min, 80)), lastAdjust: 0 };
      advanced.push({ exposureMode: 'manual', exposureTime: exposure.value });
    } else if (manual) {
      advanced.push({ exposureMode: 'manual' });
    }
    if (!advanced.length) { ui.m.exp.textContent = 'automática (sem controle)'; return; }
    try {
      await track.applyConstraints({ advanced });
      ui.m.exp.textContent = exposure.supported ? `${fmt(exposure.value / 10, 1)} ms (manual)` : 'travada';
    } catch {
      exposure.supported = false;
      ui.m.exp.textContent = 'automática (sem controle)';
    }
  }

  /** Ajusta a exposição manual pelo brilho médio do recorte (0–255). */
  function adjustExposure(mean) {
    if (!exposure.supported || !track) return;
    const now = performance.now();
    if (now - exposure.lastAdjust < 700) return;
    let v = exposure.value;
    if (mean < 55) v = Math.min(exposure.max, v * 1.35);
    else if (mean > 180) v = Math.max(exposure.min, v / 1.35);
    else return;
    if (Math.abs(v - exposure.value) < 1) return;
    exposure.value = v;
    exposure.lastAdjust = now;
    track.applyConstraints({ advanced: [{ exposureMode: 'manual', exposureTime: v }] }).catch(() => {});
    ui.m.exp.textContent = `${fmt(v / 10, 1)} ms (manual)`;
  }

  function scheduleFrame() {
    if (FAKE) setTimeout(() => onFrame(performance.now(), {}), 1000 / 120);
    else if ('requestVideoFrameCallback' in video) video.requestVideoFrameCallback(onFrame);
    else requestAnimationFrame((now) => onFrame(now, {}));
  }

  function onFrame(now, meta) {
    if (framePath !== 'canvas') return;
    scheduleFrame();
    if (busy) return; // um quadro por vez: pular é melhor que acumular atraso
    if (FAKE) source.draw();
    const sw = source.videoWidth || source.width, sh = source.videoHeight || source.height;
    const side = Math.min(sw, sh);
    if (!side) return;
    // Recorte central: mira o teto logo acima e fica longe dos dedos nos botões.
    const region = settings.wide ? side : Math.min(side, 256);
    if (work.width !== N) { work.width = work.height = N; }
    wctx.drawImage(source, (sw - region) / 2, (sh - region) / 2, region, region, 0, 0, N, N);
    const gray = window.DeslizaeFlow.toGray(wctx.getImageData(0, 0, N, N).data, new Float32Array(N * N));
    busy = true;
    const t = meta.captureTime || now;
    worker.postMessage({ type: 'gray', gray, tAbs: performance.timeOrigin + t, k: region / N }, [gray.buffer]);
  }

  // ------------------------------------------------------ processamento
  const fusion = window.DeslizaeFusion.createFusion({ startPx: settings.startPx });
  if (calib && calib.B && settings.fusion) fusion.setImuMap(calib.B);
  if (calib && calib.accelOnset) fusion.setAccelOnset(calib.accelOnset);
  let prev = null;                 // última amostra válida: posição (tela) e ângulo
  let corr = { x: 0, y: 0 };       // posição corrigida no referencial do aparelho
  let tracking = false;
  let freezeUntil = 0;             // clique estável
  let lastSendT = 0, speedEma = 0;
  let outCount = 0, lastProcMs = 0;
  const jitter = [];

  /** Atraso da câmera (ms) para o caminho atual: medido na calibração ou estimado. */
  function camLag() {
    if (calib && calib.lagMs != null && calib.lagPath === framePath) return calib.lagMs;
    return framePath === 'worker' ? 60 : 30;
  }

  function resetTracking() {
    worker.postMessage({ type: 'reset' });
    prev = null;
    fusion.reset();
    jitter.length = 0;
  }

  function updateDot() {
    let cls = '';
    if (!wsOpen) cls = 'bad';
    else if (!cameraOn) cls = '';
    else if (!tracking) cls = 'warn';
    else cls = fusion.moving ? 'moving' : 'ok';
    ui.dot.className = 'status-dot ' + cls;
  }

  worker.onmessage = (e) => {
    const r = e.data;
    if (r.type === 'unsupported' || r.type === 'error') {
      // O caminho direto não funcionou neste aparelho: volta para o canvas.
      if (framePath === 'worker' && stream) useCanvasPath();
      return;
    }
    if (r.type !== 'result') return;
    busy = false;
    lastProcMs = r.ms;
    ui.m.fps.textContent = `${r.fps} fps`;
    ui.m.path.textContent = r.path;
    ui.m.proc.textContent = `${fmt(r.ms, 1)} ms`;
    ui.m.align.textContent = r.valid ? `${fmt(r.residual, 2)} (${r.method})` : 'sem rastreio';
    adjustExposure(r.mean);

    if (!r.valid) {
      tracking = false;
      prev = null;
      fusion.reset();
      ui.m.state.textContent = r.contrast < 1 ? 'sem imagem' : 'sem textura';
      updateDot();
      return;
    }
    tracking = true;

    const tFrame = r.tAbs - performance.timeOrigin; // relógio da página
    const tCam = tFrame - camLag();                  // quando a luz chegou ao sensor
    const pos = { x: r.x * r.k, y: r.y * r.k };      // px de câmera
    const ang = gyroSeen ? angleAt(tCam + settings.gyroDelay) : null;
    if (prev) {
      // Deslocamento do quadro, no referencial do aparelho.
      let d = Motion.screenToDevice({ x: pos.x - prev.pos.x, y: pos.y - prev.pos.y }, screenAngle);
      const dg = ang && prev.ang ? { x: ang.x - prev.ang.x, y: ang.y - prev.ang.y } : null;
      if (wizard) wizardSample(d, dg, tFrame);
      const Mg = calib && calib.Mg;
      if (settings.gyroComp && Mg && dg) {
        d = { x: d.x - (Mg[0] * dg.x + Mg[1] * dg.y), y: d.y - (Mg[2] * dg.x + Mg[3] * dg.y) };
      }
      corr = { x: corr.x + d.x, y: corr.y + d.y };
    }
    prev = { pos, ang };
    jitter.push({ ...corr });
    if (jitter.length > 30) jitter.shift();

    fusion.camera(tCam, corr.x, corr.y);
    flushOutput(tFrame);
  };

  /** Entrega ao cursor o que a fusão acumulou (chamado a cada quadro e a cada leitura do acelerômetro). */
  function flushOutput(t) {
    const d = fusion.pull();
    ui.m.state.textContent = fusion.moving ? 'movendo' : 'parado';
    updateDot();
    if (!d.dx && !d.dy) return;
    if (wizard || !calib || !calib.A) return;
    if (performance.now() < freezeUntil) return; // clique estável
    if (gestures.activeCount > 0) return;         // dedo no touchpad: o sensor fica quieto

    let v = Motion.apply(calib.A, d.dx, d.dy);
    if (settings.swap) v = { x: v.y, y: v.x };
    if (settings.invX) v.x = -v.x;
    if (settings.invY) v.y = -v.y;

    // Devagar = preciso; rápido = longo (velocidade em px de câmera por segundo).
    const dt = Math.min(0.1, Math.max(0.004, (t - lastSendT) / 1000));
    lastSendT = t;
    speedEma = speedEma * 0.6 + (Math.hypot(d.dx, d.dy) / dt) * 0.4;
    const s = Math.min(1, Math.max(0, (speedEma - 3) / (80 - 3)));
    const gain = settings.sens * (1 + settings.accel * 3 * s * s * (3 - 2 * s));
    cur.x += v.x * gain;
    cur.y += v.y * gain;
    sendPos(cur, t);
    outCount++;
  }

  setInterval(() => {
    ui.m.gyro.textContent = gyroSeen ? `${fmt(gyroDps(), 1)} °/s` : 'indisponível';
    ui.m.lat.textContent = `${Math.round(camLag())} ms (${calib && calib.lagPath === framePath ? 'medido' : 'estimado'})`;
    ui.m.accel.textContent = accelSource === 'indisponível' ? accelSource : `${accelCount} Hz · ${accelSource}`;
    accelCount = 0;
    ui.m.out.textContent = `${outCount} Hz`;
    outCount = 0;
    ui.m.fusion.textContent = !settings.fusion ? 'desligada'
      : fusion.usingImu ? `ativa · câmera −${Math.round(camLag())} ms`
        : accelSource === 'indisponível' ? 'sem acelerômetro (só câmera)' : 'calibre para ativar';
    if (jitter.length >= 10 && !fusion.moving) {
      const mx = jitter.reduce((a, p) => a + p.x, 0) / jitter.length;
      const my = jitter.reduce((a, p) => a + p.y, 0) / jitter.length;
      const sd = Math.sqrt(jitter.reduce((a, p) => a + (p.x - mx) ** 2 + (p.y - my) ** 2, 0) / jitter.length);
      ui.m.jitter.textContent = `${fmt(sd, 3)} px`;
    }
  }, 1000);

  // ------------------------------------------------- assistente de calibração
  let wizard = null;

  const STEPS = [
    { id: 'still', title: 'Deixe parado', text: 'Solte o celular na mesa e não encoste nele.', ms: 2500 },
    { id: 'tilt', title: 'Balance sem deslizar', text: 'Com um dedo na borda, balance o celular para os lados e para frente e para trás, sem tirá-lo do lugar.', ms: 4000, gyro: true },
    { id: 'right', title: 'Para a direita', text: 'Deslize o celular uns 10 cm para a DIREITA, num movimento decidido, e pare. Pode voltar depois.', gesture: true },
    { id: 'fwd', title: 'Para frente', text: 'Deslize o celular uns 10 cm para FRENTE (para longe de você) e pare. Pode voltar depois.', gesture: true },
  ];

  function wizardSample(d, dg, tFrame) {
    const w = wizard;
    if (w.step === 'still') {
      w.still.push({ x: w.sx += d.x, y: w.sy += d.y });
    } else if (w.step === 'tilt' && dg) {
      w.tilt.push({ gx: dg.x, gy: dg.y, dx: d.x, dy: d.y });
    } else if (w.traj) {
      let { x, y } = d;
      if (w.Mg && dg) { x -= w.Mg[0] * dg.x + w.Mg[1] * dg.y; y -= w.Mg[2] * dg.x + w.Mg[3] * dg.y; }
      w.gx += x; w.gy += y;
      w.traj.push({ t: tFrame, x: w.gx, y: w.gy });
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

  /**
   * Grava o gesto: espera parado, registra a trajetória da câmera até o
   * celular se afastar e parar (ou começar a voltar) e devolve o vetor do
   * ponto mais distante, a trajetória e a janela de tempo (para o acelerômetro).
   */
  async function gestureStep() {
    const tw = performance.now();
    let stillSince = null;
    while (performance.now() - tw < 4000) {
      if (!wizard) throw new Error('cancelado');
      if (!fusion.moving) { stillSince = stillSince || performance.now(); if (performance.now() - stillSince > 300) break; }
      else { stillSince = null; ui.wizLive.textContent = 'Aguarde parar…'; }
      await sleep(50);
    }
    wizard.traj = [];
    wizard.gx = wizard.gy = 0;
    const tStart = performance.now();
    let peak = 0;
    while (performance.now() - tStart < 12000) {
      if (!wizard) throw new Error('cancelado');
      const tr = wizard.traj;
      const now = tr.length ? Math.hypot(tr[tr.length - 1].x, tr[tr.length - 1].y) : 0;
      peak = Math.max(peak, now);
      ui.wizLive.textContent = peak > 12 ? 'Isso! Pode parar.' : 'Aguardando o movimento…';
      ui.wizBar.style.width = `${Math.min(100, (peak / 40) * 100)}%`;
      if (peak > 20) {
        const last = tr[tr.length - 1].t;
        const recent = tr.filter((p) => last - p.t < 350);
        const span = recent.length > 2
          ? Math.hypot(recent[recent.length - 1].x - recent[0].x, recent[recent.length - 1].y - recent[0].y) : 99;
        if (span < 1 || now < peak * 0.4) break; // parou, ou já está voltando
      }
      await sleep(50);
    }
    if (peak < 12) throw new Error('não detectei o movimento: o teto está visível?');
    await sleep(350); // deixa o fim do gesto entrar na trajetória
    const traj = wizard.traj.slice();
    const v = Motion.gestureVector(traj);
    const peakPt = traj.find((p) => p.x === v.x && p.y === v.y) || traj[traj.length - 1];
    return { v, traj, tPeak: peakPt.t, t0: tStart, t1: performance.now() };
  }

  /** Deslocamento medido pelo acelerômetro no gesto e atraso da câmera em relação a ele. */
  function imuGesture(g) {
    const samples = accelHist.filter((s) => s.t >= g.t0 - 150 && s.t <= g.t1);
    if (samples.length < 15) return null;
    const imuTraj = window.DeslizaeFusion.integrateGesture(samples);
    const lag = window.DeslizaeFusion.estimateLag(g.traj, imuTraj);
    if (!lag) return null;
    const p = window.DeslizaeFusion.at(imuTraj, g.tPeak - lag.lagMs);
    return { d: { x: p.x, y: p.y }, lag };
  }

  async function runWizard() {
    if (!cameraOn) { toast('Toque em Começar primeiro'); return; }
    closeSheet();
    wizard = { step: null, still: [], sx: 0, sy: 0, tilt: [], traj: null, Mg: null, accStill: [] };
    ui.wizard.classList.remove('hidden');
    const result = {};
    let gR = null, gF = null;
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
        if (step.id === 'still') {
          rawRates.length = 0;
          await sleep(400);
          wizard.still = []; wizard.accStill = []; wizard.sx = wizard.sy = 0;
        }

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
          const acc = wizard.accStill;
          if (acc.length > 10) {
            // Ruído do acelerômetro parado define o limiar de "começou a andar".
            const ax = acc.reduce((a, q) => a + q.x, 0) / acc.length, ay = acc.reduce((a, q) => a + q.y, 0) / acc.length;
            const rms = Math.sqrt(acc.reduce((a, q) => a + (q.x - ax) ** 2 + (q.y - ay) ** 2, 0) / acc.length);
            result.accelOnset = Math.min(0.8, Math.max(0.15, 5 * rms));
          }
        } else if (step.id === 'tilt') {
          const exc = wizard.tilt.reduce((a, s) => a + s.gx * s.gx + s.gy * s.gy, 0);
          const fit = Motion.gyroFit(wizard.tilt);
          // Só usa a compensação se a inclinação explicar bem o movimento da imagem.
          if (fit && exc > 6 && fit.r2 > 0.6) { result.Mg = fit.M; result.r2 = fit.r2; wizard.Mg = fit.M; }
          else { result.Mg = null; result.r2 = fit ? fit.r2 : 0; }
        } else if (step.id === 'right') {
          gR = await gestureStep();
          result.vR = gR.v;
        } else if (step.id === 'fwd') {
          gF = await gestureStep();
          result.vF = gF.v;
        }
      }

      const A = Motion.axisMatrix(result.vR, result.vF);
      if (!A) throw new Error('movimentos muito curtos');
      const cos = (result.vR.x * result.vF.x + result.vR.y * result.vF.y) /
        (Math.hypot(result.vR.x, result.vR.y) * Math.hypot(result.vF.x, result.vF.y));
      const angle = Math.acos(Math.max(-1, Math.min(1, cos))) * (180 / Math.PI);
      if (Math.abs(angle - 90) > 35) throw new Error(`os movimentos ficaram a ${Math.round(angle)}° um do outro (esperado ~90°); deslize em linhas retas`);
      result.A = A;

      // Acelerômetro: escala/eixos (B) e atraso da câmera, pelos mesmos dois gestos.
      result.B = null;
      const iR = gR && imuGesture(gR), iF = gF && imuGesture(gF);
      if (iR && iF) {
        const fit = window.DeslizaeFusion.fitImuMap(iR.d, iF.d, result.vR, result.vF);
        const score = Math.min(iR.lag.score, iF.lag.score);
        if (fit && fit.cond < 1.8 && score > 0.5 && fit.scale > 20 && fit.scale < 5000) {
          result.B = fit.B;
          result.imuScale = fit.scale;
          result.lagMs = (iR.lag.lagMs + iF.lag.lagMs) / 2;
          result.lagPath = framePath;
        }
      }

      result.date = Date.now();
      calib = result;
      store.set(CALIB_KEY, JSON.stringify(calib));
      settings.startPx = calib.startPx;
      settings.invX = settings.invY = settings.swap = false;
      save();
      syncControls();
      fusion.setStartPx(settings.startPx);
      fusion.setImuMap(settings.fusion ? calib.B : null);
      if (calib.accelOnset) fusion.setAccelOnset(calib.accelOnset);
      showSummary();
      toast(calib.B ? 'Calibrado, com fusão de sensores. Pode usar!' : 'Calibrado (sem acelerômetro). Pode usar!', 3000);
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
    const imu = calib.B ? `acelerômetro ✓ (câmera −${Math.round(calib.lagMs)} ms)`
      : accelSource === 'indisponível' ? 'acelerômetro: indisponível neste navegador'
        : 'acelerômetro: não calibrado (deslize com mais decisão nos passos 3 e 4)';
    ui.summary.textContent = `Calibrado · eixos ✓ · ${tilt} · ${imu} · ruído ${fmt(calib.sigma, 3)} px`;
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
      return !fusion.moving;
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
    sens: (v) => `${v}×`, accel: (v) => fmt(v, 1),
    startPx: (v) => fmt(v, 2), gyroDelay: (v) => `${v}`, tpSens: (v) => `${fmt(v, 1)}×`,
  };
  const TOGGLES = ['touchpad', 'fusion', 'gyroComp', 'rowNormalize', 'lockExposure', 'wide', 'smoothing', 'invX', 'invY', 'swap'];

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
      if (id === 'startPx') fusion.setStartPx(settings.startPx);
      save();
    });
  }
  for (const id of TOGGLES) {
    el(id).addEventListener('change', () => {
      settings[id] = el(id).checked;
      save();
      if (id === 'rowNormalize' || id === 'wide') { pushConfig(); resetTracking(); }
      if (id === 'lockExposure' && cameraOn) setupExposure();
      if (id === 'fusion') fusion.setImuMap(settings.fusion && calib ? calib.B : null);
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
    save(); syncControls(); fusion.setStartPx(settings.startPx); fusion.setImuMap(null); showSummary();
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
