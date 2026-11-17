'use strict';

// Utilitários dos testes: "teto" sintético e recortes com deslocamento exato.

function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

/** Teto sintético: "luminárias" e manchas, desfocado como uma câmera real. */
function makeScene(w, h, seed = 7) {
  const rand = rng(seed);
  const img = new Float64Array(w * h).fill(180);
  const blobs = Math.round((w * h) / 2500);
  for (let k = 0; k < blobs; k++) {
    const cx = rand() * w, cy = rand() * h, r = 4 + rand() * 18, v = 40 + rand() * 75;
    const x0 = Math.max(0, Math.floor(cx - r)), x1 = Math.min(w - 1, Math.ceil(cx + r));
    const y0 = Math.max(0, Math.floor(cy - r)), y1 = Math.min(h - 1, Math.ceil(cy + r));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        if ((x - cx) ** 2 + (y - cy) ** 2 < r * r) img[y * w + x] = v;
      }
    }
  }
  let cur = img;
  for (let pass = 0; pass < 2; pass++) {
    const out = new Float64Array(w * h);
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        let s = 0;
        for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) s += cur[(y + j) * w + x + i];
        out[y * w + x] = s / 9;
      }
    }
    cur = out;
  }
  return { w, h, img: cur };
}

/**
 * Recorte N×N da cena a partir de (x0, y0) com interpolação bilinear.
 * Opções: noise (desvio do ruído de sensor), gain (brilho), flicker
 * {amp, period, phase} (faixas horizontais multiplicativas), rand.
 */
function crop(scene, x0, y0, n, opts = {}) {
  const { noise = 0, gain = 1, flicker = null, rand = Math.random } = opts;
  const out = new Float32Array(n * n);
  for (let y = 0; y < n; y++) {
    const band = flicker ? 1 + flicker.amp * Math.sin((2 * Math.PI * y) / flicker.period + flicker.phase) : 1;
    for (let x = 0; x < n; x++) {
      const sx = x0 + x, sy = y0 + y;
      const ix = Math.floor(sx), iy = Math.floor(sy);
      const fx = sx - ix, fy = sy - iy;
      const p = (xx, yy) => scene.img[yy * scene.w + xx];
      const v =
        p(ix, iy) * (1 - fx) * (1 - fy) + p(ix + 1, iy) * fx * (1 - fy) +
        p(ix, iy + 1) * (1 - fx) * fy + p(ix + 1, iy + 1) * fx * fy;
      out[y * n + x] = v * gain * band + (noise ? (rand() - 0.5) * 2 * noise * Math.sqrt(3) : 0);
    }
  }
  return out;
}

module.exports = { rng, makeScene, crop };
