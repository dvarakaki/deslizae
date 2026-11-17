'use strict';

/*
 * Laboratório: o celular como mouse, usando a câmera frontal olhando para o teto.
 *
 * Pipeline por quadro:
 *   câmera → recorte central N×N em cinza → worker (correlação de fase) →
 *   deslocamento da imagem (px) − parte causada por inclinação (giroscópio) →
 *   filtros de qualidade e ruído → eixos/sensibilidade/aceleração → cursor.
 *
 * Usa o mesmo protocolo do touchpad (posições acumuladas por UDP/WebRTC, com
 * WebSocket de reserva), então o agente no PC não muda nada.
 *
 * ?fake=1 troca a câmera por um "teto" sintético que anda em círculos, para
 * testar a página inteira sem celular.
 */
(() => {
  const OP = { PING: 0x05, MOVE: 0x10, SCROLL: 0x11, BUTTON: 0x12, CLICK: 0x13, PONG: 0x85 };
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));

  // ------------------------------------------------------------- ajustes
  const DEFAULTS = {
    sens: 25,        // pixels do cursor por pixel de imagem (antes da aceleração)
    accel: 1.0,
    noise: 0.12,     // deslocamentos menores que isto (px de imagem) viram zero
    minPsr: 8,       // abaixo disto a medida não é confiável
    gyroDelay: 0,    // atraso a aplicar ao giroscópio para alinhar com a câmera
    hiRes: false,
    gyroComp: true,
    smoothing: true,
    invX: false,
    invY: true,
    swap: false,
  };
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* ignora */ } },
  };
  const settings = { ...DEFAULTS };
  try { Object.assign(settings, JSON.parse(store.get('labSettings') || '{}')); } catch { /* ignora */ }
  const save = () => store.set('labSettings', JSON.stringify(settings));

  // Matriz giroscópio → deslocamento da imagem (px por grau), aprendida na calibração.
  let gyroMatrix = null;
  try { gyroMatrix = JSON.parse(store.get('labGyroMatrix') || 'null'); } catch { /* ignora */ }

  const params = new URLSearchParams(location.search);
  const FAKE = params.get('fake') === '1';
  const token = params.get('t') || store.get('token');
  if (token) store.set('token', token);

  const ui = {
    dot: $('#dot'), host: $('#host'), transport: $('#transport'), latency: $('#latency'),
    preview: $('#preview'), status: $('#status'), intro: $('#intro'), video: $('#video'),
    fps: $('#m-fps'), proc: $('#m-proc'), lat: $('#m-lat'), psr: $('#m-psr'),
    psrBar: $('#m-psr-bar'), jitter: $('#m-jitter'), gyro: $('#m-gyro'), send: $('#send'),
  };

  function status(text, kind = '') {
    ui.status.textContent = text;
    ui.status.className = 'lab-status ' + kind;
  }

  // ------------------------------------------------------------ conexão
  let ws = null, wsOpen = false, pc = null, dc = null, dcOpen = false, rtt = 0;

  function channel() { return dcOpen ? dc : wsOpen ? ws : null; }

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

  function sendEvent(build) {
    const b = build();
    if (dcOpen) { try { dc.send(b); } catch { /* ignora */ } }
    if (wsOpen) ws.send(b);
  }

  function sendButton(button, down) {
    sendEvent(() => {
      const b = new ArrayBuffer(27), v = new DataView(b);
      v.setUint8(0, OP.BUTTON); v.setUint32(1, ++eventId, true);
      v.setUint8(5, button); v.setUint8(6, down ? 1 : 0);
      v.setUint32(7, cur.seq, true); v.setFloat64(11, cur.x, true); v.setFloat64(19, cur.y, true);
      return b;
    });
    if (navigator.vibrate) navigator.vibrate(down ? 8 : 4);
  }

  // ------------------------------------------------------------ giroscópio
  // Ângulo acumulado (graus) em torno dos eixos X (beta) e Y (gamma) do aparelho,
  // com o instante de cada amostra, para saber quanto o celular girou entre
  // dois quadros quaisquer.
  const gyroHist = [];
  let gyroAngle = { x: 0, y: 0 };
  let lastGyroT = null;
  let gyroSeen = false;

  function onMotion(e) {
    const r = e.rotationRate;
    if (!r || r.beta == null) return;
    gyroSeen = true;
    const t = e.timeStamp;
    if (lastGyroT !== null) {
      const dt = Math.min(100, t - lastGyroT) / 1000;
      gyroAngle = { x: gyroAngle.x + r.beta * dt, y: gyroAngle.y + r.gamma * dt };
    }
    lastGyroT = t;
    gyroHist.push({ t, x: gyroAngle.x, y: gyroAngle.y });
    while (gyroHist.length && t - gyroHist[0].t > 2000) gyroHist.shift();
    ui.gyro.textContent = `${Math.hypot(r.beta, r.gamma).toFixed(1)} °/s`;
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

  // ------------------------------------------------------------ câmera
  const video = ui.video;
  const work = document.createElement('canvas');
  const wctx = work.getContext('2d', { willReadFrequently: true });
  const pctx = ui.preview.getContext('2d');
  const worker = new Worker('/static/flow-worker.js');
  let busy = false;
  let prevFrameT = null;
  let frames = 0, fpsT0 = performance.now();
  let lastCamLatency = null;

  async function openCamera() {
    if (FAKE) {
      video.srcObject = fakeStream();
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
    scheduleFrame();
  }

  function scheduleFrame() {
    if ('requestVideoFrameCallback' in video) video.requestVideoFrameCallback(onFrame);
    else requestAnimationFrame((now) => onFrame(now, {}));
  }

  function onFrame(now, meta) {
    scheduleFrame();
    frames++;
    const elapsed = now - fpsT0;
    if (elapsed > 1000) {
      ui.fps.textContent = `${Math.round((frames * 1000) / elapsed)} fps`;
      frames = 0; fpsT0 = now;
    }
    // Instante em que a luz chegou ao sensor (quando o navegador informa).
    const t = meta.captureTime || meta.expectedDisplayTime || now;
    if (meta.captureTime) {
      lastCamLatency = performance.now() - meta.captureTime;
      ui.lat.textContent = `${Math.round(lastCamLatency)} ms`;
    } else {
      ui.lat.textContent = 'n/d';
    }
    if (busy) return; // um quadro por vez no worker; pular é melhor que acumular atraso

    const n = settings.hiRes ? 256 : 128;
    const region = Math.min(video.videoWidth, video.videoHeight, 256);
    if (!region) return;
    if (work.width !== n) { work.width = work.height = n; }
    const sx = (video.videoWidth - region) / 2;
    const sy = (video.videoHeight - region) / 2;
    wctx.drawImage(video, sx, sy, region, region, 0, 0, n, n);
    const img = wctx.getImageData(0, 0, n, n);
    pctx.drawImage(work, 0, 0, ui.preview.width, ui.preview.height);
    const gray = window.DeslizaeFlow.toGray(img.data, new Float32Array(n * n));
    busy = true;
    worker.postMessage({ gray, n, t }, [gray.buffer]);
  }

  // ------------------------------------------------------ processamento
  const recentStill = [];
  let calibrating = null;
  let lastResultT = null;

  worker.onmessage = (e) => {
    busy = false;
    const { t, r, contrast, ms } = e.data;
    ui.proc.textContent = `${ms.toFixed(1)} ms`;
    const prevT = lastResultT;
    lastResultT = t;
    if (!r || prevT === null) return;

    // Deslocamento em pixels da câmera (o recorte pode ter sido reduzido).
    const region = Math.min(video.videoWidth, video.videoHeight, 256);
    const k = region / (settings.hiRes ? 256 : 128);
    let dx = r.dx * k, dy = r.dy * k;

    ui.psr.textContent = r.psr.toFixed(1);
    const q = Math.max(0, Math.min(1, (r.psr - 3) / 25));
    ui.psrBar.style.width = `${q * 100}%`;
    ui.psrBar.style.background = r.psr >= settings.minPsr ? 'var(--ok)' : 'var(--bad)';

    // Rotação do celular entre os dois quadros (graus), pelo giroscópio.
    let g = null;
    if (gyroSeen) {
      const a = angleAt(prevT + settings.gyroDelay);
      const b = angleAt(t + settings.gyroDelay);
      if (a && b) g = { x: b.x - a.x, y: b.y - a.y };
    }

    if (calibrating) {
      if (g && r.psr >= settings.minPsr) calibrating.samples.push({ gx: g.x, gy: g.y, dx, dy });
      return;
    }

    // Desconta a parte do movimento da imagem causada por inclinação.
    if (settings.gyroComp && gyroMatrix && g) {
      dx -= gyroMatrix[0] * g.x + gyroMatrix[1] * g.y;
      dy -= gyroMatrix[2] * g.x + gyroMatrix[3] * g.y;
    }

    // Medida pouco confiável (pouca textura, mão na frente): ignora.
    if (r.psr < settings.minPsr || contrast < 2) {
      status(contrast < 2 ? 'Imagem sem contraste: a câmera está coberta ou escura?' : 'Pouca textura no teto: aponte para luminárias ou cantos.', 'warn');
      return;
    }

    const mag = Math.hypot(dx, dy);
    recentStill.push(mag);
    if (recentStill.length > 30) recentStill.shift();
    if (mag < settings.noise) { dx = dy = 0; }
    status(ui.send.checked ? 'Enviando ao cursor.' : 'Medindo. Ligue “Enviar ao cursor” para usar.', 'ok');

    if (!ui.send.checked || (!dx && !dy)) return;

    // Eixos: a imagem do teto anda ao contrário do celular (ajustável).
    let mx = settings.swap ? dy : dx;
    let my = settings.swap ? dx : dy;
    if (settings.invX) mx = -mx;
    if (settings.invY) my = -my;

    // Aceleração: devagar = preciso, rápido = longo (velocidade em px de imagem/s).
    const dtS = Math.max(0.001, (t - prevT) / 1000);
    const v = mag / dtS;
    const s = Math.min(1, Math.max(0, (v - 2) / (60 - 2)));
    const gain = settings.sens * (1 + settings.accel * 3 * s * s * (3 - 2 * s));

    cur.x += mx * gain;
    cur.y += my * gain;
    sendPos(cur, t);
  };

  // Tremor com o celular parado: desvio dos últimos deslocamentos (px de imagem).
  setInterval(() => {
    if (!recentStill.length) return;
    const avg = recentStill.reduce((a, b) => a + b, 0) / recentStill.length;
    ui.jitter.textContent = `${avg.toFixed(2)} px`;
  }, 500);

  // ------------------------------------------------------------ calibração
  // O usuário inclina o celular sem deslizar. Toda a imagem que se move nesse
  // tempo é efeito da inclinação, então dá para aprender, por mínimos
  // quadrados, quantos pixels cada grau de giro em X e em Y desloca a imagem.
  function solve(samples, key) {
    let sxx = 0, sxy = 0, syy = 0, sxd = 0, syd = 0;
    for (const s of samples) {
      sxx += s.gx * s.gx; sxy += s.gx * s.gy; syy += s.gy * s.gy;
      sxd += s.gx * s[key]; syd += s.gy * s[key];
    }
    const det = sxx * syy - sxy * sxy;
    if (Math.abs(det) < 1e-6) return null;
    return [(sxd * syy - syd * sxy) / det, (syd * sxx - sxd * sxy) / det];
  }

  $('#btn-calibrate').addEventListener('click', () => {
    if (!gyroSeen) { status('Giroscópio indisponível neste navegador.', 'warn'); return; }
    calibrating = { samples: [] };
    status('Calibrando: incline o celular para os lados e para frente/trás, SEM deslizar… (4 s)', 'warn');
    setTimeout(() => {
      const samples = calibrating.samples;
      calibrating = null;
      const excitation = samples.reduce((a, s) => a + s.gx * s.gx + s.gy * s.gy, 0);
      const rx = solve(samples, 'dx');
      const ry = solve(samples, 'dy');
      if (samples.length < 20 || excitation < 5 || !rx || !ry) {
        status('Calibração falhou: incline mais o celular (e mantenha o teto visível).', 'warn');
        return;
      }
      gyroMatrix = [rx[0], rx[1], ry[0], ry[1]];
      store.set('labGyroMatrix', JSON.stringify(gyroMatrix));
      status(`Calibrado (${samples.length} amostras): ${gyroMatrix.map((v) => v.toFixed(1)).join(' / ')} px/°`, 'ok');
    }, 4000);
  });

  $('#btn-zero').addEventListener('click', () => { recentStill.length = 0; ui.jitter.textContent = '–'; });

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
    const dy = e.clientY - wheelY;
    wheelY = e.clientY;
    scr.y += dy * 2.4; // dedo desce = conteúdo desce (rolagem natural)
    sendPos(scr, e.timeStamp);
  });
  const wheelEnd = () => { wheelY = null; wheel.classList.remove('active'); };
  wheel.addEventListener('pointerup', wheelEnd);
  wheel.addEventListener('pointercancel', wheelEnd);

  // ------------------------------------------------------------- ajustes
  const sliders = { sens: (v) => `${v}×`, accel: (v) => v.toFixed(1), noise: (v) => v.toFixed(2), minPsr: (v) => v.toFixed(1), gyroDelay: (v) => `${v}` };
  for (const [id, fmt] of Object.entries(sliders)) {
    const el = $('#' + id), out = $('#out-' + id);
    el.value = settings[id];
    out.textContent = fmt(Number(settings[id]));
    el.addEventListener('input', () => { settings[id] = Number(el.value); out.textContent = fmt(settings[id]); save(); });
  }
  for (const id of ['hiRes', 'gyroComp', 'smoothing', 'invX', 'invY', 'swap']) {
    const el = $('#' + id);
    el.checked = !!settings[id];
    // O worker recria o correlator sozinho quando o tamanho (hiRes) muda.
    el.addEventListener('change', () => { settings[id] = el.checked; save(); });
  }

  // ------------------------------------------------------------- início
  $('#btn-start').addEventListener('click', async () => {
    ui.intro.classList.add('hidden');
    const motion = await enableMotion();
    if (!motion) ui.gyro.textContent = 'indisponível';
    try {
      if ('wakeLock' in navigator) navigator.wakeLock.request('screen').catch(() => {});
      await openCamera();
      status('Câmera aberta. Deslize o celular devagar e observe as métricas.', 'ok');
    } catch (err) {
      status(`Não foi possível abrir a câmera: ${err.message || err}`, 'warn');
    }
  });

  document.addEventListener('gesturestart', (e) => e.preventDefault());
  setConn();
  connect();

  // ---------------------------------------------------- teto sintético
  // Para testes sem celular: um teto com "luminárias" que anda num círculo de
  // raio 40 px a cada 4 s.
  function fakeStream() {
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
    tctx.filter = 'blur(2px)';
    tctx.drawImage(tex, 0, 0);
    const t0 = performance.now();
    window.__fakeT0 = t0;
    const draw = () => {
      const a = ((performance.now() - t0) / 4000) * Math.PI * 2;
      const ox = 192 + Math.cos(a) * 40, oy = 272 + Math.sin(a) * 40;
      ctx.drawImage(tex, -ox, -oy);
      requestAnimationFrame(draw);
    };
    draw();
    return c.captureStream(30);
  }
})();
