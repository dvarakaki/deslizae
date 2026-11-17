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
  function createPhaseCorrelator(n, { rowNormalize = false } = {}) {
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

    /**
     * Prepara um quadro (Float32Array/Array N×N): espectro + medida de textura.
     *
     * Com `rowNormalize`, cada linha é dividida pela própria média. Lâmpadas
     * LED/fluorescentes piscam a 100–120 Hz e, com o obturador da câmera
     * lendo uma linha por vez, aparecem como faixas horizontais que andam a
     * cada quadro: um ganho multiplicativo por linha, que a divisão cancela.
     * Sem isso, as faixas viram um falso movimento vertical.
     */
    function prepare(gray) {
      const re = new Float64Array(size);
      const im = new Float64Array(size);
      let mean = 0;
      for (let i = 0; i < size; i++) mean += gray[i];
      mean /= size;
      if (rowNormalize) {
        for (let y = 0; y < n; y++) {
          let rm = 0;
          for (let x = 0; x < n; x++) rm += gray[y * n + x];
          rm = Math.max(1, rm / n);
          for (let x = 0; x < n; x++) re[y * n + x] = (gray[y * n + x] / rm - 1) * mean;
        }
      } else {
        for (let i = 0; i < size; i++) re[i] = gray[i] - mean;
      }
      let energy = 0;
      for (let i = 0; i < size; i++) {
        energy += re[i] * re[i];
        re[i] *= window[i];
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

  /**
   * Rastreador com quadro de referência (como os sensores de mouse óptico).
   *
   * Comparar cada quadro com o anterior soma o erro de cada medida (~0,05 px)
   * a cada quadro: parado, o cursor "anda sozinho". Aqui cada quadro é
   * comparado com um quadro de referência fixo; parado, a posição só oscila
   * em torno do mesmo ponto, sem acumular. A referência só é trocada quando o
   * deslocamento em relação a ela passa de `rekeyPx` (a sobreposição entre as
   * imagens diminui) ou quando a qualidade cai muito (luz mudou, mão na
   * frente). Assim o erro acumula só a cada troca, não a cada quadro.
   *
   * push(gray) → { x, y, psr, contrast, valid, rekeyed }, posição em pixels
   * da imagem desde o início.
   */
  function createTracker(n, { rekeyPx = 8, minPsr = 6, rowNormalize = true } = {}) {
    const pc = createPhaseCorrelator(n, { rowNormalize });
    let key = null;
    let keyPsr = 0;
    let keyPos = { x: 0, y: 0 };
    let last = { x: 0, y: 0 };

    function rekey(frame, pos) {
      key = frame;
      keyPos = { x: pos.x, y: pos.y };
      keyPsr = 0;
    }

    function push(gray) {
      const cur = pc.prepare(gray);
      if (!key) {
        rekey(cur, last);
        return { x: last.x, y: last.y, psr: 0, contrast: cur.contrast, valid: false, rekeyed: true };
      }
      const r = pc.shift(key, cur);
      if (r.psr < minPsr) {
        // Perdeu o rastreio: recomeça daqui, sem mover a posição (sem saltos).
        rekey(cur, last);
        return { x: last.x, y: last.y, psr: r.psr, contrast: cur.contrast, valid: false, rekeyed: true };
      }
      if (!keyPsr) keyPsr = r.psr;
      last = { x: keyPos.x + r.dx, y: keyPos.y + r.dy };
      let rekeyed = false;
      if (Math.hypot(r.dx, r.dy) > rekeyPx || r.psr < keyPsr * 0.5) {
        rekey(cur, last);
        rekeyed = true;
      }
      return { x: last.x, y: last.y, psr: r.psr, contrast: cur.contrast, valid: true, rekeyed };
    }

    function reset() {
      key = null;
      keyPos = { x: 0, y: 0 };
      last = { x: 0, y: 0 };
    }

    return { n, push, reset };
  }

  /**
   * Rastreador rápido para 120 Hz: Lucas-Kanade inverso-composicional
   * (Baker e Matthews, 2004) contra um quadro de referência.
   *
   * A 120 Hz o deslocamento entre quadros é pequeno (frações de pixel a
   * poucos pixels), o regime ideal do Lucas-Kanade: ele alinha a imagem atual
   * à referência por mínimos quadrados, partindo da posição prevista, em
   * O(n²) por iteração, bem mais barato que FFTs, e com precisão melhor que a
   * correlação de fase. A forma inversa-composicional calcula gradientes e a
   * matriz normal só uma vez por referência.
   *
   * A correlação de fase entra como reserva quando o Lucas-Kanade não converge
   * (movimento brusco, troca de cena), e a referência é trocada a cada
   * `rekeyPx` de deslocamento, como no rastreador por fase.
   *
   * push(gray) → { x, y, valid, rekeyed, residual, contrast, method }
   *   residual: erro RMS normalizado do alinhamento (0 = perfeito; ~1,4 =
   *   imagens sem relação). Serve de medida de confiança.
   */
  function createLKTracker(n, { rekeyPx = 8, rowNormalize = true, maxResidual = 0.55, maxIter = 6 } = {}) {
    const size = n * n;
    const margin = Math.ceil(rekeyPx) + 4;
    const lo = margin, hi = n - 1 - margin;
    const pc = createPhaseCorrelator(n, { rowNormalize: false });

    let T = null;            // referência pré-processada
    let gx = null, gy = null;
    let hinv = null;         // inversa da matriz normal 2×2
    let keyPos = { x: 0, y: 0 };
    let p = { x: 0, y: 0 };  // deslocamento atual em relação à referência
    let v = { x: 0, y: 0 };  // último deslocamento por quadro (previsão)
    let last = { x: 0, y: 0 };

    /** Normaliza linhas (anticintilação), tira a média e escala para desvio 1. */
    function preprocess(gray) {
      const out = new Float32Array(size);
      let mean = 0;
      for (let i = 0; i < size; i++) mean += gray[i];
      mean /= size;
      if (rowNormalize) {
        for (let y = 0; y < n; y++) {
          let rm = 0;
          for (let x = 0; x < n; x++) rm += gray[y * n + x];
          rm = Math.max(1, rm / n);
          for (let x = 0; x < n; x++) out[y * n + x] = gray[y * n + x] / rm - 1;
        }
      } else {
        for (let i = 0; i < size; i++) out[i] = gray[i] - mean;
      }
      let m2 = 0, s2 = 0;
      for (let i = 0; i < size; i++) m2 += out[i];
      m2 /= size;
      for (let i = 0; i < size; i++) { out[i] -= m2; s2 += out[i] * out[i]; }
      const std = Math.sqrt(s2 / size);
      const contrast = rowNormalize ? std * mean : std;
      const k = std > 1e-9 ? 1 / std : 0;
      for (let i = 0; i < size; i++) out[i] *= k;
      return { img: out, contrast };
    }

    function setKey(img, pos) {
      T = img;
      gx = new Float32Array(size);
      gy = new Float32Array(size);
      let a = 0, b = 0, c = 0;
      for (let y = lo; y <= hi; y++) {
        for (let x = lo; x <= hi; x++) {
          const i = y * n + x;
          const dx = (T[i + 1] - T[i - 1]) * 0.5;
          const dy = (T[i + n] - T[i - n]) * 0.5;
          gx[i] = dx; gy[i] = dy;
          a += dx * dx; b += dx * dy; c += dy * dy;
        }
      }
      const det = a * c - b * b;
      hinv = det > 1e-9 ? [c / det, -b / det, -b / det, a / det] : null;
      keyPos = { x: pos.x, y: pos.y };
      p = { x: 0, y: 0 };
    }

    /** Amostra bilinear de I em (x, y). */
    function sample(I, x, y) {
      const ix = Math.floor(x), iy = Math.floor(y);
      const fx = x - ix, fy = y - iy;
      const i = iy * n + ix;
      return (I[i] * (1 - fx) + I[i + 1] * fx) * (1 - fy) + (I[i + n] * (1 - fx) + I[i + n + 1] * fx) * fy;
    }

    /** Alinha I à referência partindo de p0. Retorna {p, residual, ok}. */
    function align(I, p0) {
      if (!hinv) return { p: p0, residual: Infinity, ok: false };
      let px = p0.x, py = p0.y;
      let residual = Infinity;
      const count = (hi - lo + 1) * (hi - lo + 1);
      for (let it = 0; it < maxIter; it++) {
        if (Math.abs(px) > margin - 2 || Math.abs(py) > margin - 2) return { p: { x: px, y: py }, residual, ok: false };
        let sx = 0, sy = 0, se = 0;
        for (let y = lo; y <= hi; y++) {
          for (let x = lo; x <= hi; x++) {
            const i = y * n + x;
            const e = sample(I, x + px, y + py) - T[i];
            sx += gx[i] * e;
            sy += gy[i] * e;
            se += e * e;
          }
        }
        residual = Math.sqrt(se / count);
        const dpx = hinv[0] * sx + hinv[1] * sy;
        const dpy = hinv[2] * sx + hinv[3] * sy;
        px -= dpx;
        py -= dpy;
        if (dpx * dpx + dpy * dpy < 1e-6) break;
      }
      return { p: { x: px, y: py }, residual, ok: residual < maxResidual };
    }

    function push(gray) {
      const { img, contrast } = preprocess(gray);
      if (!T || contrast < 1) {
        setKey(img, last);
        v = { x: 0, y: 0 };
        return { x: last.x, y: last.y, valid: false, rekeyed: true, residual: Infinity, contrast, method: 'key' };
      }

      // 1) Lucas-Kanade a partir da previsão (posição + velocidade).
      let method = 'lk';
      let r = align(img, { x: p.x + v.x, y: p.y + v.y });
      if (!r.ok) {
        // 2) Reserva: correlação de fase acha o deslocamento grosso; o
        //    Lucas-Kanade refina a partir dele.
        method = 'fase';
        const ph = pc.shift(pc.prepare(T), pc.prepare(img));
        r = align(img, { x: ph.dx, y: ph.dy });
      }
      if (!r.ok) {
        // Perdeu o rastreio: recomeça daqui sem mover a posição (sem saltos).
        setKey(img, last);
        v = { x: 0, y: 0 };
        return { x: last.x, y: last.y, valid: false, rekeyed: true, residual: r.residual, contrast, method };
      }

      v = { x: r.p.x - p.x, y: r.p.y - p.y };
      p = r.p;
      last = { x: keyPos.x + p.x, y: keyPos.y + p.y };
      let rekeyed = false;
      if (Math.hypot(p.x, p.y) > rekeyPx || r.residual > maxResidual * 0.7) {
        setKey(img, last);
        rekeyed = true;
      }
      return { x: last.x, y: last.y, valid: true, rekeyed, residual: r.residual, contrast, method };
    }

    function reset() {
      T = null;
      keyPos = { x: 0, y: 0 };
      p = { x: 0, y: 0 };
      v = { x: 0, y: 0 };
      last = { x: 0, y: 0 };
    }

    return { n, push, reset };
  }

  /** Converte RGBA (ImageData.data) em luminância. */
  function toGray(rgba, out) {
    for (let i = 0, j = 0; j < out.length; i += 4, j++) {
      out[j] = 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
    }
    return out;
  }

  return { createPhaseCorrelator, createTracker, createLKTracker, toGray, makeFFT };
});
