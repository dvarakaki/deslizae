'use strict';

/*
 * Worker do rastreio. Dois caminhos de entrada:
 *
 *  1) 'stream' (preferido): recebe o ReadableStream de um
 *     MediaStreamTrackProcessor e lê os quadros da câmera aqui mesmo, um a um,
 *     no ritmo dela. Do VideoFrame copia só o plano de luminância (Y) do
 *     recorte central: sem canvas, sem cópia GPU→CPU da imagem inteira e sem
 *     depender da thread da página, que pode estar ocupada desenhando.
 *  2) 'gray' (reserva): a página manda o recorte já em cinza (canvas).
 *
 * Tempos: os quadros são marcados com o relógio absoluto (timeOrigin + now),
 * que a página converte para o seu próprio relógio.
 */
importScripts('/static/flow.js');

const opts = { n: 128, wide: false, rowNormalize: true, rekeyPx: 8 };
let tracker = null;
let trackerKey = '';
let buf = null;
let frames = 0, fpsT0 = 0, fps = 0;
let pathInfo = '';
let offscreen = null;

function ensureTracker() {
  const key = `${opts.n}|${opts.rowNormalize}|${opts.rekeyPx}`;
  if (!tracker || key !== trackerKey) {
    tracker = self.DeslizaeFlow.createLKTracker(opts.n, { rowNormalize: opts.rowNormalize, rekeyPx: opts.rekeyPx });
    trackerKey = key;
  }
}

/** Lado do recorte: múltiplo de n (redução inteira) e par (planos de cor). */
function regionFor(w, h) {
  const n = opts.n;
  const side = Math.min(w, h);
  let r = opts.wide ? side : Math.min(side, 256);
  r = Math.max(n, Math.floor(r / n) * n);
  return Math.min(r, side - (side % 2)) & ~1;
}

/** Reduz um plano de 8 bits (stride) por média em blocos k×k para n×n. */
function downsample(src, offset, stride, region, out) {
  const n = opts.n, k = region / n, inv = 1 / (k * k);
  let sum = 0;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      let s = 0;
      for (let j = 0; j < k; j++) {
        const row = offset + (y * k + j) * stride + x * k;
        for (let i = 0; i < k; i++) s += src[row + i];
      }
      out[y * n + x] = s * inv;
      sum += s * inv;
    }
  }
  return sum / (n * n);
}

/** Cinza n×n do recorte central de um VideoFrame. Retorna {gray, mean} ou null. */
async function lumaFromFrame(frame) {
  const W = frame.displayWidth, H = frame.displayHeight;
  const region = regionFor(W, H);
  const vr = frame.visibleRect || { x: 0, y: 0 };
  const rect = { x: (vr.x + ((W - region) >> 1)) & ~1, y: (vr.y + ((H - region) >> 1)) & ~1, width: region, height: region };
  const gray = new Float32Array(opts.n * opts.n);
  const fmt = frame.format;

  if (fmt === 'NV12' || fmt === 'I420' || fmt === 'I420A' || fmt === 'NV12A' || fmt === 'I422' || fmt === 'I444') {
    const size = frame.allocationSize({ rect });
    if (!buf || buf.length < size) buf = new Uint8Array(size);
    const layout = await frame.copyTo(buf, { rect });
    pathInfo = `worker · ${fmt} · plano Y`;
    const mean = downsample(buf, layout[0].offset, layout[0].stride, region, gray);
    return { gray, mean, k: region / opts.n };
  }
  if (fmt === 'RGBA' || fmt === 'RGBX' || fmt === 'BGRA' || fmt === 'BGRX') {
    const size = frame.allocationSize({ rect });
    if (!buf || buf.length < size) buf = new Uint8Array(size);
    const layout = await frame.copyTo(buf, { rect });
    const stride = layout[0].stride, off = layout[0].offset;
    const lum = new Uint8Array(region * region);
    for (let y = 0; y < region; y++) {
      for (let x = 0; x < region; x++) {
        const i = off + y * stride + x * 4;
        lum[y * region + x] = (77 * buf[i] + 150 * buf[i + 1] + 29 * buf[i + 2]) >> 8; // R/B trocados não importam para a forma
      }
    }
    pathInfo = `worker · ${fmt}`;
    return { gray, mean: downsample(lum, 0, region, region, gray), k: region / opts.n };
  }
  // Formato opaco (quadro só na GPU): desenha num OffscreenCanvas aqui no worker.
  if (typeof OffscreenCanvas !== 'undefined') {
    const n = opts.n;
    if (!offscreen) offscreen = new OffscreenCanvas(n, n).getContext('2d', { willReadFrequently: true });
    offscreen.drawImage(frame, rect.x, rect.y, region, region, 0, 0, n, n);
    const d = offscreen.getImageData(0, 0, n, n).data;
    let sum = 0;
    for (let i = 0, j = 0; j < n * n; i += 4, j++) { gray[j] = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]; sum += gray[j]; }
    pathInfo = 'worker · OffscreenCanvas';
    return { gray, mean: sum / (n * n), k: region / n };
  }
  return null;
}

function process(gray, tAbs, mean, k) {
  ensureTracker();
  const t0 = performance.now();
  const r = tracker.push(gray);
  frames++;
  if (t0 - fpsT0 > 1000) { fps = Math.round((frames * 1000) / (t0 - fpsT0)); frames = 0; fpsT0 = t0; }
  self.postMessage({ type: 'result', tAbs, ...r, k, ms: performance.now() - t0, mean, fps, path: pathInfo });
}

async function readStream(readable) {
  const reader = readable.getReader();
  for (;;) {
    const { value: frame, done } = await reader.read();
    if (done) break;
    const tAbs = performance.timeOrigin + performance.now();
    try {
      const out = await lumaFromFrame(frame);
      if (out) process(out.gray, tAbs, out.mean, out.k);
      else { self.postMessage({ type: 'unsupported', format: frame.format }); break; }
    } catch (err) {
      self.postMessage({ type: 'error', message: String(err && err.message || err) });
    } finally {
      frame.close();
    }
  }
}

self.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'config') { Object.assign(opts, m.opts); return; }
  if (m.type === 'reset') { if (tracker) tracker.reset(); return; }
  if (m.type === 'stream') { readStream(m.readable); return; }
  if (m.type === 'gray') {
    pathInfo = 'página · canvas';
    let sum = 0;
    for (let i = 0; i < m.gray.length; i++) sum += m.gray[i];
    process(m.gray, m.tAbs, sum / m.gray.length, m.k);
  }
};
