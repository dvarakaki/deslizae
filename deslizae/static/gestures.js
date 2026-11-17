'use strict';

/*
 * Motor de gestos de touchpad, compartilhado pelo touchpad (index.html) e
 * pela área da palma do modo mouse (lab.html).
 *
 *   1 dedo            move o cursor (com aceleração)
 *   toque             clique esquerdo (com espera curta para o toque duplo)
 *   toque duplo       clique duplo; tocar 2× e arrastar = arrastar
 *   segurar parado    arrastar
 *   toque 2 / 3 dedos clique direito / do meio
 *   2 dedos           rolagem (com inércia) ou pinça (zoom), decidido pelo 1º movimento
 *
 * A página fornece as ações (move, scroll, zoom, button, click…) e pode
 * filtrar toques com `accept(e)` (rejeição de palma) e suspender o touchpad
 * com `blocked()`. Nos ajustes, `longPressDrag: false` desliga o "segurar
 * para arrastar" e `dropResting: true` descarta toques em repouso quando
 * outro dedo chega (palma apoiada).
 */
(function (root) {
  const TAP_MAX_MS = 250;          // duração máxima de um toque (1 dedo)
  const MULTI_TAP_MAX_MS = 320;    // idem para 2–3 dedos (raramente encostam juntos)
  const TAP_SLOP = 10;             // px que o dedo pode andar e ainda contar como toque
  const MOVE_DEADZONE = 3;         // segura o início do movimento para cliques não "escorregarem"
  const LONG_PRESS_MS = 450;       // segurar parado = começar a arrastar
  const SCROLL_UNITS_PER_PX = 1.2; // 120 unidades de roda ≈ 100 px no Windows
  const INERTIA_TAU_MS = 325;      // constante de desaceleração (parecida com iOS)
  const VELOCITY_WINDOW_MS = 80;   // janela para medir a velocidade ao soltar a rolagem
  const DOUBLE_TAP_MS = 200;       // espera por um 2º toque (toque duplo e arrastar)
  const PINCH_START_PX = 24;       // variação da distância entre os dedos para virar pinça
  const ZOOM_UNITS_PER_LN = 520;   // 120 × 3 / ln 2: dobrar a distância = 3 passos de zoom
  const REST_MS = 350;             // parado há mais que isto quando outro dedo chega = palma
  const BTN = { LEFT: 0, RIGHT: 1, MIDDLE: 2 };
  const noop = () => {};

  function create(surface, hooks) {
    const h = {
      settings: () => ({}),
      toUi: (e) => ({ x: e.clientX, y: e.clientY }),
      move: noop, scroll: noop, zoom: noop, button: noop, click: noop, haptic: noop,
      canInertia: () => true,
      accept: () => true,
      blocked: () => false,
      onPointerDown: noop, onUsed: noop, onDrag: noop, onTouches: noop,
      ...hooks,
    };

    const active = new Map(); // pointerId -> {x, y, sx, sy}
    const ignored = new Set(); // toques recusados (palma)
    let g = null;             // gesto em andamento
    let longTimer = 0;
    let inertiaRaf = 0;
    let pendingTap = null;

    // Dedo devagar = precisão; dedo rápido = cursor atravessa a tela.
    // v em px CSS por ms. Transição suave (smoothstep) entre 0,05 e 1,2 px/ms.
    function gain(v) {
      const s = h.settings();
      const t = Math.min(1, Math.max(0, (v - 0.05) / (1.2 - 0.05)));
      return s.sensitivity * (1 + s.acceleration * 3 * t * t * (3 - 2 * t));
    }

    const touches = () => Array.from(active.values());
    const report = () => h.onTouches(touches());

    function centroid() {
      let x = 0, y = 0, n = 0;
      for (const p of active.values()) { x += p.x; y += p.y; if (++n === 2) break; }
      return { x: x / n, y: y / n };
    }

    function fingerDist() {
      const it = active.values();
      const a = it.next().value, b = it.next().value;
      return a && b ? Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)) : 1;
    }

    function clearLongPress() { clearTimeout(longTimer); longTimer = 0; }
    function cancelPendingTap() { if (pendingTap) { clearTimeout(pendingTap); pendingTap = null; } }

    function stopInertia() {
      if (inertiaRaf) cancelAnimationFrame(inertiaRaf);
      inertiaRaf = 0;
    }

    function startInertia(vx, vy) {
      if (Math.hypot(vx, vy) < 0.25) return; // unidades de roda por ms
      let last = null;
      const step = (now) => {
        // O 1º quadro pode ter timestamp anterior ao início: dt nunca negativo.
        const dt = last === null ? 16 : Math.min(50, Math.max(0, now - last));
        last = now;
        h.scroll(vx * dt, vy * dt, now);
        const decay = Math.exp(-dt / INERTIA_TAU_MS);
        vx *= decay; vy *= decay;
        if (Math.hypot(vx, vy) < 0.02 || !h.canInertia()) { inertiaRaf = 0; return; }
        inertiaRaf = requestAnimationFrame(step);
      };
      inertiaRaf = requestAnimationFrame(step);
    }

    // Toque duplo e arrastar: depois de um toque, espera DOUBLE_TAP_MS por um
    // 2º. Se ele vier e andar, vira arraste sem nenhum clique antes — senão o
    // Windows leria "clique + apertar" como clique duplo e abriria o arquivo.
    function releaseTapDrag(gesture) {
      if (gesture && gesture.tapDrag) { gesture.tapDrag = false; h.click(BTN.LEFT); }
    }

    function beginDrag(gesture, strength) {
      gesture.tapDrag = false;
      gesture.mode = 'drag';
      gesture.moving = true;
      h.button(BTN.LEFT, true);
      h.onDrag(true);
      h.haptic(strength);
    }

    function startLongPress() {
      clearLongPress();
      longTimer = setTimeout(() => {
        longTimer = 0;
        if (g && g.mode === 'pointer' && active.size === 1 && g.travel < TAP_SLOP && !h.blocked()) {
          g.hold.x = g.hold.y = 0;
          beginDrag(g, 25);
        }
      }, LONG_PRESS_MS);
    }

    surface.addEventListener('pointerdown', (e) => {
      // Toques recusados (palma, botões dentro da área) seguem seu caminho normal.
      if (!h.accept(e)) { ignored.add(e.pointerId); return; }
      e.preventDefault();
      try { surface.setPointerCapture(e.pointerId); } catch { /* ignora */ }
      const s0 = h.settings();

      // Rejeição de palma por repouso: um toque que já estava parado há um
      // tempo quando outro dedo chega é a palma (ou o polegar) apoiada. Ele
      // sai do gesto, e o dedo novo começa um gesto próprio — senão "palma +
      // toque" viraria toque com 2 dedos (clique direito).
      if (s0.dropResting && active.size > 0 && (!g || !g.moving)) {
        for (const [id, q] of active) {
          if (e.timeStamp - q.t0 > REST_MS && Math.hypot(q.x - q.sx, q.y - q.sy) < TAP_SLOP) {
            active.delete(id);
            ignored.add(id);
          }
        }
        if (active.size === 0) { clearLongPress(); g = null; }
      }

      h.onPointerDown(e, active.size);
      stopInertia();

      const pt = h.toUi(e);
      active.set(e.pointerId, { x: pt.x, y: pt.y, sx: pt.x, sy: pt.y, t0: e.timeStamp });
      if (!g) {
        g = {
          mode: 'pointer', primary: e.pointerId, t0: e.timeStamp, maxCount: 0, travel: 0,
          lastT: e.timeStamp, vel: 0, moving: false, hold: { x: 0, y: 0 },
          c: null, c0: null, d0: 1, lastD: 1, samples: [], lastScrollT: 0, tapDrag: false,
        };
        if (pendingTap) { cancelPendingTap(); g.tapDrag = true; } // 2º toque: talvez arraste
      }
      g.maxCount = Math.max(g.maxCount, active.size);

      if (active.size === 1 && g.mode === 'pointer' && s0.longPressDrag !== false) startLongPress();
      else clearLongPress();

      if (g.mode === 'drag') {
        // dedos extras durante o arraste são ignorados
      } else if (active.size === 2) {
        releaseTapDrag(g);
        if (g.mode === 'pointer') { g.mode = 'two'; g.c0 = centroid(); }
        g.c = centroid();
        g.d0 = g.lastD = fingerDist();
        g.lastT = e.timeStamp;
      } else if (active.size >= 3) {
        releaseTapDrag(g);
        g.mode = 'multi';
      }
      report();
    });

    surface.addEventListener('pointermove', (e) => {
      const p = active.get(e.pointerId);
      if (!p || !g) return;
      const pt = h.toUi(e);
      const dx = pt.x - p.x, dy = pt.y - p.y;
      if (!dx && !dy) return;
      p.x = pt.x; p.y = pt.y;

      const fromStart = Math.hypot(p.x - p.sx, p.y - p.sy);
      if (fromStart > g.travel) g.travel = fromStart;
      if (g.travel > TAP_SLOP) clearLongPress();
      if (h.blocked()) { g.blockedMove = true; report(); return; }

      const s = h.settings();
      if (g.mode === 'pointer' || g.mode === 'drag') {
        if (e.pointerId !== g.primary) return;
        const dt = Math.max(1, e.timeStamp - g.lastT);
        g.lastT = e.timeStamp;
        g.vel = g.vel * 0.5 + (Math.hypot(dx, dy) / dt) * 0.5;
        const k = gain(g.vel);
        if (!g.moving) {
          g.hold.x += dx; g.hold.y += dy;
          if (g.travel < MOVE_DEADZONE) return;
          if (g.tapDrag) beginDrag(g, 15); // toque duplo + arrastar
          g.moving = true;
          h.onUsed();
          h.move(g.hold.x * k, g.hold.y * k, e.timeStamp);
        } else {
          h.move(dx * k, dy * k, e.timeStamp);
        }
      } else if (g.mode === 'two' || g.mode === 'scroll' || g.mode === 'pinch') {
        if (active.size < 2) { report(); return; }
        const c = centroid(), d = fingerDist();
        if (g.mode === 'two') {
          const moved = Math.hypot(c.x - g.c0.x, c.y - g.c0.y);
          const spread = Math.abs(d - g.d0);
          if (s.pinchZoom && spread > PINCH_START_PX && spread > moved * 1.2) {
            g.mode = 'pinch'; g.lastD = d; h.onUsed();
          } else if (moved > TAP_SLOP * 0.6) {
            g.mode = 'scroll'; g.c = c; h.onUsed();
          }
          report();
          return;
        }
        if (g.mode === 'pinch') {
          // Escala logarítmica: abrir até o dobro da distância = 3 passos de zoom.
          h.zoom(Math.log(d / g.lastD) * ZOOM_UNITS_PER_LN, e.timeStamp);
          g.lastD = d;
        } else {
          const cdx = c.x - g.c.x, cdy = c.y - g.c.y;
          g.c = c;
          const k = SCROLL_UNITS_PER_PX * s.scrollSpeed * (s.naturalScroll ? 1 : -1);
          const wx = -cdx * k; // roda horizontal: positivo = direita
          const wy = cdy * k;  // roda vertical: positivo = para cima
          // Velocidade medida numa janela de tempo: os dois dedos chegam quase
          // juntos e um dt instantâneo inflaria a inércia.
          g.samples.push({ t: e.timeStamp, x: wx, y: wy });
          while (g.samples.length && e.timeStamp - g.samples[0].t > VELOCITY_WINDOW_MS) g.samples.shift();
          g.lastScrollT = e.timeStamp;
          h.scroll(wx, wy, e.timeStamp);
        }
      }
      report();
    });

    function onEnd(e, cancelled) {
      if (ignored.delete(e.pointerId)) return;
      if (!active.has(e.pointerId)) return;
      active.delete(e.pointerId);
      if (!g) { report(); return; }

      if (active.size > 0) {
        // Um dedo saiu, outro continua: recalcula referências sem dar "pulo".
        if (g.mode === 'scroll' || g.mode === 'two') g.c = centroid();
        if (e.pointerId === g.primary) g.primary = active.keys().next().value;
        report();
        return;
      }

      clearLongPress();
      const gesture = g;
      g = null;
      const s = h.settings();
      const duration = e.timeStamp - gesture.t0;
      const maxTap = gesture.maxCount > 1 ? MULTI_TAP_MAX_MS : TAP_MAX_MS;
      const isTap = !cancelled && !gesture.blockedMove && !h.blocked() && s.tapToClick &&
        duration < maxTap && gesture.travel < TAP_SLOP;

      if (gesture.mode === 'drag') {
        h.button(BTN.LEFT, false);
        h.onDrag(false);
      } else if (isTap && gesture.maxCount === 1) {
        h.haptic(8);
        h.onUsed();
        if (gesture.tapDrag) {
          gesture.tapDrag = false;
          h.click(BTN.LEFT); // dois toques rápidos = clique duplo
          h.click(BTN.LEFT);
        } else if (s.tapDrag) {
          pendingTap = setTimeout(() => { pendingTap = null; h.click(BTN.LEFT); }, DOUBLE_TAP_MS);
        } else {
          h.click(BTN.LEFT);
        }
      } else if (isTap) {
        h.click(gesture.maxCount === 2 ? BTN.RIGHT : BTN.MIDDLE);
        h.haptic(8);
        h.onUsed();
      } else {
        if (!cancelled) releaseTapDrag(gesture);
        if (gesture.mode === 'scroll' && s.inertia && !cancelled && e.timeStamp - gesture.lastScrollT < 60) {
          const recent = gesture.samples.filter((x) => e.timeStamp - x.t <= VELOCITY_WINDOW_MS);
          if (recent.length >= 2) {
            // A 1ª amostra marca o início da janela; seu delta veio antes dela.
            const span = Math.max(16, e.timeStamp - recent[0].t);
            let sx = 0, sy = 0;
            for (const x of recent.slice(1)) { sx += x.x; sy += x.y; }
            startInertia(sx / span, sy / span);
          }
        }
      }
      report();
    }

    surface.addEventListener('pointerup', (e) => onEnd(e, false));
    surface.addEventListener('pointercancel', (e) => onEnd(e, true));

    return {
      /** Quantos dedos estão na área agora. */
      get activeCount() { return active.size; },
      /** Esquece tudo (conexão caiu, página em segundo plano, tela girou). */
      reset() {
        clearLongPress();
        cancelPendingTap();
        stopInertia();
        if (g && g.mode === 'drag') { h.button(BTN.LEFT, false); h.onDrag(false); }
        active.clear();
        ignored.clear();
        g = null;
        report();
      },
    };
  }

  root.DeslizaeGestures = { create, BTN };
})(typeof self !== 'undefined' ? self : this);
