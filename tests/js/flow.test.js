'use strict';

// Testes do estimador de deslocamento (node tests/js/flow.test.js).
const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');

const { createPhaseCorrelator, makeFFT } = require(path.join(__dirname, '../../deslizae/static/flow.js'));

// Gerador determinístico para os testes serem reproduzíveis.
function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

/** "Teto" sintético: luminárias, bordas e textura suave. */
function makeScene(w, h, seed = 7) {
  const rand = rng(seed);
  const img = new Float64Array(w * h).fill(180);
  for (let k = 0; k < 40; k++) {
    const cx = rand() * w, cy = rand() * h, r = 4 + rand() * 18, v = 40 + rand() * 75;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if ((x - cx) ** 2 + (y - cy) ** 2 < r * r) img[y * w + x] = v;
      }
    }
  }
  // desfoque leve, como a imagem real de uma câmera
  const out = new Float64Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      let s = 0;
      for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) s += img[(y + j) * w + x + i];
      out[y * w + x] = s / 9 + (rand() - 0.5) * 2; // + ruído de sensor
    }
  }
  return { w, h, img: out };
}

/** Recorte N×N da cena começando em (x0, y0), com interpolação bilinear. */
function crop(scene, x0, y0, n) {
  const out = new Float32Array(n * n);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const sx = x0 + x, sy = y0 + y;
      const ix = Math.floor(sx), iy = Math.floor(sy);
      const fx = sx - ix, fy = sy - iy;
      const p = (xx, yy) => scene.img[yy * scene.w + xx];
      out[y * n + x] =
        p(ix, iy) * (1 - fx) * (1 - fy) + p(ix + 1, iy) * fx * (1 - fy) +
        p(ix, iy + 1) * (1 - fx) * fy + p(ix + 1, iy + 1) * fx * fy;
    }
  }
  return out;
}

test('FFT ida e volta recupera o sinal', () => {
  const n = 16;
  const fft = makeFFT(n);
  const re = Float64Array.from({ length: n }, (_, i) => Math.sin(i) + i * 0.1);
  const im = new Float64Array(n);
  const orig = re.slice();
  const tr = new Float64Array(n), ti = new Float64Array(n);
  fft(re, im, 0, 1, false, tr, ti);
  fft(re, im, 0, 1, true, tr, ti);
  for (let i = 0; i < n; i++) assert.ok(Math.abs(re[i] / n - orig[i]) < 1e-9);
});

test('precisão sub-pixel: erro < 0,06 px em toda a faixa fracionária', () => {
  const n = 128;
  const pc = createPhaseCorrelator(n);
  const scene = makeScene(320, 320);
  let worst = 0;
  for (let i = 0; i <= 20; i++) {
    const dx = 3 + i / 20, dy = -2 - i / 40;
    const r = pc.shift(pc.prepare(crop(scene, 100, 100, n)), pc.prepare(crop(scene, 100 - dx, 100 - dy, n)));
    worst = Math.max(worst, Math.abs(r.dx - dx), Math.abs(r.dy - dy));
  }
  assert.ok(worst < 0.06, `erro máximo ${worst.toFixed(3)} px`);
});

test('mede deslocamentos inteiros e fracionários com erro < 0,1 px', () => {
  const n = 128;
  const pc = createPhaseCorrelator(n);
  const scene = makeScene(320, 320);
  const cases = [[0, 0], [3, -2], [-7.5, 4.25], [12.3, -9.8], [0.4, 0.2]];
  for (const [dx, dy] of cases) {
    // A câmera anda (dx, dy): a imagem B é a cena vista a partir de x0 − d.
    const a = pc.prepare(crop(scene, 100, 100, n));
    const b = pc.prepare(crop(scene, 100 - dx, 100 - dy, n));
    const r = pc.shift(a, b);
    assert.ok(Math.abs(r.dx - dx) < 0.1, `dx esperado ${dx}, obtido ${r.dx.toFixed(3)}`);
    assert.ok(Math.abs(r.dy - dy) < 0.1, `dy esperado ${dy}, obtido ${r.dy.toFixed(3)}`);
    assert.ok(r.psr > 10, `PSR baixo demais com textura: ${r.psr.toFixed(1)}`);
  }
});

test('teto liso (sem textura) dá PSR baixo', () => {
  const n = 128;
  const pc = createPhaseCorrelator(n);
  const rand = rng(3);
  const flat = () => Float32Array.from({ length: n * n }, () => 200 + (rand() - 0.5) * 2);
  const r = pc.shift(pc.prepare(flat()), pc.prepare(flat()));
  assert.ok(r.psr < 8, `PSR deveria ser baixo, foi ${r.psr.toFixed(1)}`);
});

test('mede o contraste da imagem', () => {
  const n = 64;
  const pc = createPhaseCorrelator(n);
  const flat = pc.prepare(new Float32Array(n * n).fill(100));
  const textured = pc.prepare(crop(makeScene(200, 200), 50, 50, n));
  assert.ok(flat.contrast < 1e-9);
  assert.ok(textured.contrast > 10);
});

test('é rápido o bastante para 30 fps em 256×256', () => {
  const n = 256;
  const pc = createPhaseCorrelator(n);
  const scene = makeScene(400, 400);
  let a = pc.prepare(crop(scene, 60, 60, n));
  const t0 = performance.now();
  const frames = 10;
  for (let i = 1; i <= frames; i++) {
    const b = pc.prepare(crop(scene, 60 - i, 60, n));
    pc.shift(a, b);
    a = b;
  }
  const ms = (performance.now() - t0) / frames;
  console.log(`  tempo por quadro (256×256): ${ms.toFixed(1)} ms`);
  assert.ok(ms < 33, `lento demais: ${ms.toFixed(1)} ms por quadro`);
});
