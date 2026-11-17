'use strict';

/*
 * Do deslocamento medido na imagem ao movimento do cursor.
 *
 * - Filtro 1€ (Casiez, Roussel e Vogel, CHI 2012): passa-baixa cuja frequência
 *   de corte cresce com a velocidade. Devagar, tira o tremor; rápido, quase não
 *   atrasa. É o filtro padrão para entrada de ponteiro.
 * - Detector parado/movendo com histerese: parado, o cursor fica congelado
 *   (o ruído não chega à tela); o movimento só começa quando o deslocamento
 *   desde a última parada passa do limiar medido na calibração.
 * - Contas da calibração: matriz giroscópio → imagem (mínimos quadrados) e
 *   orientação dos eixos a partir dos gestos "para a direita" e "para frente".
 *
 * Funciona no navegador (window.DeslizaeMotion) e no Node (testes).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DeslizaeMotion = api;
})(typeof self !== 'undefined' ? self : this, () => {
  // ------------------------------------------------------------- filtro 1€
  function createOneEuro2D({ minCutoff = 1.0, beta = 0.02, dCutoff = 1.0 } = {}) {
    let x = null, y = null, dx = 0, dy = 0, lastT = null;
    const alpha = (cutoff, dt) => {
      const tau = 1 / (2 * Math.PI * cutoff);
      return 1 / (1 + tau / dt);
    };
    return {
      /** Filtra a posição (px) no instante t (s). */
      filter(px, py, t) {
        if (x === null) { x = px; y = py; lastT = t; return { x, y, speed: 0 }; }
        const dt = Math.max(1e-3, t - lastT);
        lastT = t;
        const ad = alpha(dCutoff, dt);
        dx += ad * ((px - x) / dt - dx);
        dy += ad * ((py - y) / dt - dy);
        const speed = Math.hypot(dx, dy);
        const a = alpha(minCutoff + beta * speed, dt);
        x += a * (px - x);
        y += a * (py - y);
        return { x, y, speed };
      },
      reset(px, py, t) { x = px; y = py; dx = dy = 0; lastT = t; },
    };
  }

  // ------------------------------------------------- detector + filtro
  /**
   * Recebe a posição corrigida (px de imagem) e devolve o delta a aplicar.
   *
   * startPx  deslocamento desde a parada que caracteriza movimento
   * stopSpeed velocidade (px/s) abaixo da qual se considera parado…
   * stopMs   …por este tempo
   */
  function createMotionFilter({ startPx = 0.4, stopSpeed = 1.5, stopMs = 250, minCutoff = 1.2, beta = 0.03 } = {}) {
    const euro = createOneEuro2D({ minCutoff, beta });
    const hist = []; // {t, x, y} da última ~0,2 s, para medir a velocidade bruta
    let moving = false;
    let anchor = null; // posição de repouso
    let out = null;    // posição já entregue ao cursor
    let slowSince = null;

    function speedOver(t, windowS) {
      while (hist.length > 2 && t - hist[0].t > windowS) hist.shift();
      if (hist.length < 2) return 0;
      const a = hist[0], b = hist[hist.length - 1];
      return Math.hypot(b.x - a.x, b.y - a.y) / Math.max(1e-3, b.t - a.t);
    }

    return {
      get moving() { return moving; },
      setStartPx(v) { startPx = v; },
      /** t em segundos. Retorna {dx, dy, moving, speed}. */
      push(x, y, t) {
        hist.push({ t, x, y });
        const rawSpeed = speedOver(t, 0.2);
        if (anchor === null) { anchor = { x, y }; out = { x, y }; euro.reset(x, y, t); }

        if (!moving) {
          if (Math.hypot(x - anchor.x, y - anchor.y) <= startPx) {
            return { dx: 0, dy: 0, moving: false, speed: rawSpeed };
          }
          // Começou a mover: o filtro parte do ponto de repouso (sem salto).
          moving = true;
          slowSince = null;
          euro.reset(anchor.x, anchor.y, t - 1 / 60);
        }

        const f = euro.filter(x, y, t);
        if (rawSpeed < stopSpeed) {
          if (slowSince === null) slowSince = t;
          if ((t - slowSince) * 1000 >= stopMs) {
            // Parou: entrega o restante até a posição real e congela.
            const dx = x - out.x, dy = y - out.y;
            moving = false;
            anchor = { x, y };
            out = { x, y };
            return { dx, dy, moving: false, speed: rawSpeed };
          }
        } else {
          slowSince = null;
        }
        const dx = f.x - out.x, dy = f.y - out.y;
        out = { x: f.x, y: f.y };
        return { dx, dy, moving: true, speed: f.speed };
      },
      /** Rastreio perdido ou recalibrado: recomeça parado onde estiver. */
      reset() { moving = false; anchor = null; out = null; hist.length = 0; },
    };
  }

  // ------------------------------------------------------------ calibração
  /** Mínimos quadrados: d ≈ a·gx + b·gy. Retorna [a, b] ou null. */
  function fitGyro(samples, key) {
    let sxx = 0, sxy = 0, syy = 0, sxd = 0, syd = 0;
    for (const s of samples) {
      sxx += s.gx * s.gx; sxy += s.gx * s.gy; syy += s.gy * s.gy;
      sxd += s.gx * s[key]; syd += s.gy * s[key];
    }
    const det = sxx * syy - sxy * sxy;
    if (Math.abs(det) < 1e-9) return null;
    return [(sxd * syy - syd * sxy) / det, (syd * sxx - sxd * sxy) / det];
  }

  /** Matriz 2×2 [a b c d] que leva (gx, gy) em graus ao deslocamento da imagem. */
  function gyroMatrix(samples) {
    const rx = fitGyro(samples, 'dx');
    const ry = fitGyro(samples, 'dy');
    return rx && ry ? [rx[0], rx[1], ry[0], ry[1]] : null;
  }

  /**
   * Orientação dos eixos a partir de dois gestos: vR = deslocamento da imagem
   * ao deslizar para a direita; vF = ao deslizar para frente (longe de você).
   * Retorna a matriz 2×2 [a b c d], ortonormal, tal que A·vR aponta para a
   * direita do cursor (+x) e A·vF para cima (−y).
   */
  function axisMatrix(vR, vF) {
    const nr = Math.hypot(vR.x, vR.y);
    const nf = Math.hypot(vF.x, vF.y);
    if (nr < 1e-6 || nf < 1e-6) return null;
    const th = Math.atan2(vR.y, vR.x);
    const c = Math.cos(-th), s = Math.sin(-th);
    // Rotação que leva vR para +x.
    let A = [c, -s, s, c];
    const fy = s * vF.x + c * vF.y; // componente y de vF depois da rotação
    if (fy > 0) A = [A[0], A[1], -A[2], -A[3]]; // espelha y para "frente" = cima
    return A;
  }

  const apply = (M, x, y) => ({ x: M[0] * x + M[1] * y, y: M[2] * x + M[3] * y });

  return { createOneEuro2D, createMotionFilter, gyroMatrix, axisMatrix, apply };
});
