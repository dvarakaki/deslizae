'use strict';

/*
 * Estimativa de deslocamento entre quadros por correlação de fase.
 *
 * Dado o quadro anterior A e o atual B (imagens N×N em tons de cinza), a
 * correlação de fase acha o deslocamento d tal que B(x) ≈ A(x − d):
 *
 *   R = FFT(A)·conj(FFT(B)) / |FFT(A)·conj(FFT(B))|   →   r = IFFT(R)
 *
 * r tem um pico em −d. O pico é refinado com uma parábola em cada eixo
 * (precisão de fração de pixel) e a nitidez dele, medida pelo PSR (pico
 * menos a média do resto, dividido pelo desvio padrão), diz o quanto dá para
 * confiar na medida: teto liso, sem textura, dá PSR baixo.
 *
 * Funciona no navegador (window.DeslizaeFlow) e no Node (module.exports),
 * para poder ser testado sem câmera.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DeslizaeFlow = api;
})(typeof self !== 'undefined' ? self : this, () => {
  // --------------------------------------------------------------- FFT 1D
  function makeFFT(n) {
    if (n & (n - 1)) throw new Error('n precisa ser potência de 2');
    const levels = Math.log2(n);
    const rev = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
      let r = 0;
      for (let b = 0; b < levels; b++) r |= ((i >> b) & 1) << (levels - 1 - b);
      rev[i] = r;
    }
    const cos = new Float64Array(n / 2);
    const sin = new Float64Array(n / 2);
    for (let i = 0; i < n / 2; i++) {
      cos[i] = Math.cos((2 * Math.PI * i) / n);
      sin[i] = Math.sin((2 * Math.PI * i) / n);
    }

    /** FFT in-place de re/im a partir de `off` com passo `stride`. */
    return function fft(re, im, off, stride, inverse, tmpRe, tmpIm) {
      for (let i = 0; i < n; i++) {
        const j = off + rev[i] * stride;
        tmpRe[i] = re[j];
        tmpIm[i] = im[j];
      }
      const sign = inverse ? 1 : -1;
      for (let size = 2; size <= n; size <<= 1) {
        const half = size >> 1;
        const step = n / size;
        for (let start = 0; start < n; start += size) {
          for (let k = 0; k < half; k++) {
            const wr = cos[k * step];
            const wi = sign * sin[k * step];
            const a = start + k;
            const b = a + half;
            const xr = tmpRe[b] * wr - tmpIm[b] * wi;
            const xi = tmpRe[b] * wi + tmpIm[b] * wr;
            tmpRe[b] = tmpRe[a] - xr;
            tmpIm[b] = tmpIm[a] - xi;
            tmpRe[a] += xr;
            tmpIm[a] += xi;
          }
        }
      }
      for (let i = 0; i < n; i++) {
        const j = off + i * stride;
        re[j] = tmpRe[i];
        im[j] = tmpIm[i];
      }
    };
  }

  // ------------------------------------------------------ correlação de fase
  function createPhaseCorrelator(n) {
    const fft = makeFFT(n);
    const size = n * n;
    const tmpRe = new Float64Array(n);
    const tmpIm = new Float64Array(n);
    const window = new Float64Array(size);
    for (let y = 0; y < n; y++) {
      const wy = 0.5 - 0.5 * Math.cos((2 * Math.PI * y) / (n - 1));
      for (let x = 0; x < n; x++) {
        const wx = 0.5 - 0.5 * Math.cos((2 * Math.PI * x) / (n - 1));
        window[y * n + x] = wx * wy; // janela de Hann: evita bordas falsas
      }
    }
    const crossRe = new Float64Array(size);
    const crossIm = new Float64Array(size);

    // Passa-baixa gaussiano no espectro cruzado. A correlação de fase pura dá
    // o mesmo peso a todas as frequências, inclusive às altas (só ruído);
    // atenuá-las deixa o pico suave e com formato de gaussiana, o que permite
    // um ajuste sub-pixel preciso (erro medido < 0,05 px contra ~0,2 px).
    const LOWPASS_SIGMA = 0.12; // em ciclos por pixel
    const lowpass = new Float64Array(size);
    for (let v = 0; v < n; v++) {
      const fv = Math.min(v, n - v) / n;
      for (let u = 0; u < n; u++) {
        const fu = Math.min(u, n - u) / n;
        lowpass[v * n + u] = Math.exp(-(fu * fu + fv * fv) / (2 * LOWPASS_SIGMA * LOWPASS_SIGMA));
      }
    }

    function fft2(re, im, inverse) {
      for (let y = 0; y < n; y++) fft(re, im, y * n, 1, inverse, tmpRe, tmpIm);
      for (let x = 0; x < n; x++) fft(re, im, x, n, inverse, tmpRe, tmpIm);
    }

    /** Prepara um quadro (Float32Array/Array N×N): espectro + medida de textura. */
    function prepare(gray) {
      let mean = 0;
      for (let i = 0; i < size; i++) mean += gray[i];
      mean /= size;
      const re = new Float64Array(size);
      const im = new Float64Array(size);
      let energy = 0;
      for (let i = 0; i < size; i++) {
        const v = gray[i] - mean;
        energy += v * v;
        re[i] = v * window[i];
      }
      fft2(re, im, false);
      return { re, im, contrast: Math.sqrt(energy / size) };
    }

    /**
     * Deslocamento de `b` em relação a `a` (frames preparados).
     * Retorna {dx, dy, psr}: b(x, y) ≈ a(x − dx, y − dy).
     */
    function shift(a, b) {
      for (let i = 0; i < size; i++) {
        const r = a.re[i] * b.re[i] + a.im[i] * b.im[i];
        const m = a.im[i] * b.re[i] - a.re[i] * b.im[i];
        const w = lowpass[i] / (Math.hypot(r, m) + 1e-12);
        crossRe[i] = r * w;
        crossIm[i] = m * w;
      }
      fft2(crossRe, crossIm, true);

      let best = 0;
      let bestV = -Infinity;
      for (let i = 0; i < size; i++) {
        if (crossRe[i] > bestV) { bestV = crossRe[i]; best = i; }
      }
      const px = best % n;
      const py = (best / n) | 0;
      const at = (x, y) => crossRe[((y + n) % n) * n + ((x + n) % n)];

      // Refinamento sub-pixel: gaussiana pelos vizinhos de cada eixo (o pico
      // tem esse formato por causa do passa-baixa); parábola como reserva.
      const sub = (l, c, r) => {
        let d;
        if (l > 0 && c > 0 && r > 0) {
          const a = Math.log(l), b = Math.log(c), g = Math.log(r);
          const den = a - 2 * b + g;
          d = den < 0 ? (a - g) / (2 * den) : 0;
        } else {
          const den = l - 2 * c + r;
          d = den < 0 ? (l - r) / (2 * den) : 0;
        }
        return Math.max(-0.5, Math.min(0.5, d));
      };
      let fx = px + sub(at(px - 1, py), bestV, at(px + 1, py));
      let fy = py + sub(at(px, py - 1), bestV, at(px, py + 1));
      if (fx > n / 2) fx -= n;
      if (fy > n / 2) fy -= n;

      // PSR: nitidez do pico em relação ao resto (fora de uma janela 11×11).
      let sum = 0, sum2 = 0, count = 0;
      for (let y = 0; y < n; y++) {
        const ddy = Math.min(Math.abs(y - py), n - Math.abs(y - py));
        for (let x = 0; x < n; x++) {
          const ddx = Math.min(Math.abs(x - px), n - Math.abs(x - px));
          if (ddx <= 5 && ddy <= 5) continue;
          const v = crossRe[y * n + x];
          sum += v; sum2 += v * v; count++;
        }
      }
      const mean = sum / count;
      const std = Math.sqrt(Math.max(1e-18, sum2 / count - mean * mean));
      const psr = (bestV - mean) / std;

      // O pico está em −d.
      return { dx: -fx, dy: -fy, psr };
    }

    return { n, prepare, shift };
  }

  /** Converte RGBA (ImageData.data) em luminância. */
  function toGray(rgba, out) {
    for (let i = 0, j = 0; j < out.length; i += 4, j++) {
      out[j] = 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
    }
    return out;
  }

  return { createPhaseCorrelator, toGray, makeFFT };
});
