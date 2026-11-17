'use strict';

/*
 * Fusão câmera + acelerômetro para o modo mouse.
 *
 * Cada sensor tem um defeito que o outro cobre:
 *   - câmera: posição precisa e sem deriva, mas chega atrasada (50–100 ms) e
 *     só a cada quadro (30–60 Hz);
 *   - acelerômetro: responde em ~10 ms, a ~60 Hz, mas integrado deriva.
 *
 * Filtro complementar com compensação de atraso:
 *   previsão  a cada leitura do acelerômetro: v += B·a·dt; p += v·dt
 *   correção  a cada quadro (no instante em que ele foi CAPTURADO): a posição
 *             prevista para aquele instante é trocada pela da câmera (o erro é
 *             aplicado a todo o histórico posterior) e a velocidade é puxada
 *             para a da câmera.
 *   repouso   só quando câmera E acelerômetro estão quietos: velocidade zera,
 *             posição encosta na da câmera e o viés do acelerômetro é aprendido.
 *
 * B (2×2) leva aceleração em m/s², no referencial do aparelho, a px/s² no
 * referencial da câmera; vem da calibração. Sem B, a câmera vai direto ao
 * cursor (o agente interpola a 240 Hz).
 *
 * Também traz as contas da calibração do acelerômetro: deslocamento de um
 * gesto com velocidade zero nas pontas (ZUPT), matriz B e atraso da câmera.
 *
 * Funciona no navegador (window.DeslizaeFusion) e no Node (testes).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DeslizaeFusion = api;
})(typeof self !== 'undefined' ? self : this, () => {
  const apply = (M, x, y) => ({ x: M[0] * x + M[1] * y, y: M[2] * x + M[3] * y });

  function createFusion(options = {}) {
    const o = {
      startPx: 0.35,     // deslocamento da câmera desde o repouso que inicia movimento
      stopPx: 0.5,       // espalhamento máximo da câmera na janela de parada
      stopMs: 120,       // janela de parada
      accelOnset: 0.25,  // m/s²: acima disso (2 leituras seguidas) o celular começou a andar
      tiltDps: 25,       // °/s: girando mais que isso, a aceleração é da inclinação, não do deslize
      kv: 0.5,           // ganho da correção de velocidade pela câmera
      historyMs: 600,
      ...options,
    };
    let B = null;
    let bias = { x: 0, y: 0 };
    const cams = []; // {t, x, y}
    const hist = []; // estados previstos {t, x, y, vx, vy}
    let est = null;  // estado atual
    let out = null;  // posição já entregue
    let anchor = null;
    let moving = false;
    let onset = 0;
    let lastImu = null;
    const pending = { dx: 0, dy: 0 };

    function trim(list, t) {
      while (list.length && t - list[0].t > o.historyMs) list.shift();
    }

    function stateAt(t) {
      if (!hist.length || t >= est.t) return est;
      if (t <= hist[0].t) return hist[0];
      let i = hist.length - 1;
      while (i > 0 && hist[i - 1].t > t) i--;
      const a = hist[i - 1], b = hist[i];
      const f = (t - a.t) / (b.t - a.t || 1);
      return {
        t, x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f,
        vx: a.vx + (b.vx - a.vx) * f, vy: a.vy + (b.vy - a.vy) * f,
      };
    }

    function emit() {
      if (!moving || !out) return;
      pending.dx += est.x - out.x;
      pending.dy += est.y - out.y;
      out = { x: est.x, y: est.y };
    }

    function startMoving() {
      moving = true;
      onset = 0;
      est.vx = est.vy = 0;
    }

    function stop(x, y) {
      // Encosta na câmera (verdade) e entrega o restante até ali.
      est.x = x; est.y = y; est.vx = est.vy = 0;
      pending.dx += x - out.x;
      pending.dy += y - out.y;
      out = { x, y };
      anchor = { x, y };
      moving = false;
      hist.length = 0;
    }

    return {
      get moving() { return moving; },
      get usingImu() { return !!B; },
      get bias() { return { ...bias }; },
      setImuMap(M) { B = M; },
      setStartPx(v) { o.startPx = v; o.stopPx = Math.max(0.5, v * 1.4); },
      setAccelOnset(v) { o.accelOnset = v; },

      /** Leitura do acelerômetro linear (m/s², referencial do aparelho). */
      imu(t, ax, ay, gyroDps = 0) {
        if (!B) return;
        const a = { x: ax - bias.x, y: ay - bias.y };
        const amag = Math.hypot(a.x, a.y);
        const tilt = gyroDps > o.tiltDps;
        lastImu = { t, amag, tilt };
        if (!moving && amag < o.accelOnset && !tilt) {
          bias.x += 0.02 * (ax - bias.x);
          bias.y += 0.02 * (ay - bias.y);
        }
        if (!est) return;
        if (!moving) {
          onset = amag > o.accelOnset && !tilt ? onset + 1 : 0;
          if (onset >= 2) startMoving();
        }
        const dt = Math.min(0.05, Math.max(0, (t - est.t) / 1000));
        if (moving && dt > 0) {
          const ap = tilt ? { x: 0, y: 0 } : apply(B, a.x, a.y);
          est.vx += ap.x * dt;
          est.vy += ap.y * dt;
          est.x += est.vx * dt;
          est.y += est.vy * dt;
        }
        est.t = Math.max(est.t, t);
        if (moving) { hist.push({ ...est }); trim(hist, t); }
        emit();
      },

      /** Posição da câmera (px, referencial do aparelho) no instante de captura tc (ms). */
      camera(tc, x, y) {
        cams.push({ t: tc, x, y });
        trim(cams, tc);
        if (!est) {
          est = { t: tc, x, y, vx: 0, vy: 0 };
          out = { x, y };
          anchor = { x, y };
          return;
        }
        if (!moving && Math.hypot(x - anchor.x, y - anchor.y) > o.startPx) startMoving();

        if (moving && B) {
          const s = stateAt(tc);
          const ex = x - s.x, ey = y - s.y;
          // Velocidade da câmera pelos dois últimos quadros. A diferença vale
          // para o MEIO do intervalo; comparar com a prevista no fim dele
          // puxaria a velocidade para o lado errado nas acelerações e frenagens.
          const p = cams.length > 1 ? cams[cams.length - 2] : null;
          let dvx = 0, dvy = 0;
          if (p && tc - p.t > 4) {
            const dt = (tc - p.t) / 1000;
            const mid = stateAt((tc + p.t) / 2);
            dvx = o.kv * ((x - p.x) / dt - mid.vx);
            dvy = o.kv * ((y - p.y) / dt - mid.vy);
          }
          est.x += ex; est.y += ey; est.vx += dvx; est.vy += dvy;
          for (const h of hist) {
            if (h.t >= tc) { h.x += ex; h.y += ey; h.vx += dvx; h.vy += dvy; }
          }
        } else if (moving) {
          est.x = x; est.y = y; est.t = Math.max(est.t, tc);
        }

        if (moving) {
          const recent = cams.filter((c) => tc - c.t <= o.stopMs);
          let span = 0;
          for (const c of recent) span = Math.max(span, Math.hypot(c.x - x, c.y - y));
          const imuQuiet = !B || !lastImu || (lastImu.amag < o.accelOnset && !lastImu.tilt);
          if (recent.length >= 3 && span < o.stopPx && imuQuiet) { stop(x, y); return; }
        }
        emit();
      },

      /** Deslocamento acumulado desde a última chamada (px de câmera). */
      pull() {
        const d = { dx: pending.dx, dy: pending.dy };
        pending.dx = pending.dy = 0;
        return d;
      },

      reset() {
        est = out = anchor = lastImu = null;
        moving = false; onset = 0;
        cams.length = 0; hist.length = 0;
        pending.dx = pending.dy = 0;
      },
    };
  }

  // ------------------------------------------------- calibração do acelerômetro
  /**
   * Deslocamento (m) de um gesto que começa e termina parado. A aceleração
   * integrada uma vez dá a velocidade, que deriva; como ela é zero nas pontas
   * (ZUPT), a deriva linear é removida antes de integrar de novo.
   * samples: [{t (ms), x, y}] em m/s². Retorna a trajetória [{t, x, y}] em m.
   */
  function integrateGesture(samples) {
    if (samples.length < 3) return [];
    const v = [{ t: samples[0].t, x: 0, y: 0 }];
    for (let i = 1; i < samples.length; i++) {
      const dt = (samples[i].t - samples[i - 1].t) / 1000;
      const ax = (samples[i].x + samples[i - 1].x) / 2, ay = (samples[i].y + samples[i - 1].y) / 2;
      v.push({ t: samples[i].t, x: v[i - 1].x + ax * dt, y: v[i - 1].y + ay * dt });
    }
    const t0 = v[0].t, t1 = v[v.length - 1].t, endV = v[v.length - 1];
    for (const p of v) {
      const f = (p.t - t0) / (t1 - t0 || 1);
      p.x -= endV.x * f; p.y -= endV.y * f;
    }
    const pos = [{ t: t0, x: 0, y: 0 }];
    for (let i = 1; i < v.length; i++) {
      const dt = (v[i].t - v[i - 1].t) / 1000;
      pos.push({ t: v[i].t, x: pos[i - 1].x + (v[i].x + v[i - 1].x) / 2 * dt, y: pos[i - 1].y + (v[i].y + v[i - 1].y) / 2 * dt });
    }
    return pos;
  }

  function at(traj, t) {
    if (!traj.length) return { x: 0, y: 0 };
    if (t <= traj[0].t) return traj[0];
    if (t >= traj[traj.length - 1].t) return traj[traj.length - 1];
    let i = 1;
    while (traj[i].t < t) i++;
    const a = traj[i - 1], b = traj[i], f = (t - a.t) / (b.t - a.t || 1);
    return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
  }

  /**
   * Matriz B (m → px) a partir de dois gestos: imuR/imuF em metros (aparelho) e
   * camR/camF em px (câmera). Retorna {B, scale, cond} ou null.
   * cond mede quanto B foge de "rotação/espelho × escala": perto de 1 é bom.
   */
  function fitImuMap(imuR, imuF, camR, camF) {
    const det = imuR.x * imuF.y - imuF.x * imuR.y;
    if (Math.abs(det) < 1e-9) return null;
    const inv = [imuF.y / det, -imuF.x / det, -imuR.y / det, imuR.x / det];
    const B = [
      camR.x * inv[0] + camF.x * inv[2], camR.x * inv[1] + camF.x * inv[3],
      camR.y * inv[0] + camF.y * inv[2], camR.y * inv[1] + camF.y * inv[3],
    ];
    // Valores singulares de B (2×2) pela fórmula fechada.
    const a = B[0], b = B[1], c = B[2], d = B[3];
    const s1 = Math.hypot(a + d, c - b) / 2, s2 = Math.hypot(a - d, c + b) / 2;
    const smax = s1 + s2, smin = Math.abs(s1 - s2);
    return { B, scale: (smax + smin) / 2, cond: smin > 0 ? smax / smin : Infinity };
  }

  /**
   * Atraso da câmera em relação ao acelerômetro (ms): o deslocamento de tempo
   * que melhor alinha a velocidade medida pelos dois. Procura de 0 a maxMs.
   */
  function estimateLag(camTraj, imuTraj, maxMs = 200, stepMs = 4) {
    if (camTraj.length < 4 || imuTraj.length < 4) return null;
    const t0 = Math.max(camTraj[0].t, imuTraj[0].t), t1 = Math.min(camTraj[camTraj.length - 1].t, imuTraj[imuTraj.length - 1].t);
    const speed = (traj, t) => {
      const a = at(traj, t - 10), b = at(traj, t + 10);
      return Math.hypot(b.x - a.x, b.y - a.y);
    };
    let best = 0, bestScore = -Infinity;
    for (let lag = 0; lag <= maxMs; lag += stepMs) {
      let sxy = 0, sxx = 0, syy = 0;
      for (let t = t0; t <= t1 - lag; t += 5) {
        const ci = speed(camTraj, t + lag), ii = speed(imuTraj, t);
        sxy += ci * ii; sxx += ci * ci; syy += ii * ii;
      }
      const score = sxy / Math.sqrt((sxx * syy) || 1);
      if (score > bestScore) { bestScore = score; best = lag; }
    }
    return { lagMs: best, score: bestScore };
  }

  return { createFusion, integrateGesture, fitImuMap, estimateLag, at, apply };
});
