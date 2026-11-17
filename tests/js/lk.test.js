'use strict';

// Rastreador Lucas-Kanade (o usado no laboratório a 120 Hz).
const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');

const { createLKTracker } = require(path.join(__dirname, '../../deslizae/static/flow.js'));
const { createMotionFilter } = require(path.join(__dirname, '../../deslizae/static/motion.js'));
const { rng, makeScene, crop } = require('./scene.js');

const N = 128;
const FPS = 120;
const scene = makeScene(800, 800);

function run(traj, opts = {}) {
  const tr = createLKTracker(N, { rowNormalize: opts.rowNormalize ?? true });
  const motion = createMotionFilter({ startPx: 0.3 });
  const rand = rng(opts.seed ?? 2);
  const out = { x: 0, y: 0 };
  const res = [];
  traj.forEach(([cx, cy], i) => {
    const r = tr.push(crop(scene, 250 - cx, 250 - cy, N, {
      noise: opts.noise ?? 1.5,
      gain: opts.gainWobble ? 1 + 0.08 * Math.sin(i / 7) : 1,
      flicker: opts.flicker ? { amp: 0.06, period: 37, phase: i * 1.3 } : null,
      rand,
    }));
    res.push(r);
    if (!r.valid) return;
    const m = motion.push(r.x, r.y, i / FPS);
    out.x += m.dx; out.y += m.dy;
  });
  return { out, res };
}

const still = (k, at = [0, 0]) => Array.from({ length: k }, () => at);

test('parado com ruído, cintilação e brilho variando: zero movimento', () => {
  const { out, res } = run(still(360), { flicker: true, gainWobble: true });
  assert.equal(Math.hypot(out.x, out.y), 0);
  const dev = Math.max(...res.filter((r) => r.valid).map((r) => Math.hypot(r.x, r.y)));
  assert.ok(dev < 0.1, `posição oscilou ${dev.toFixed(3)} px`);
});

test('precisão sub-pixel do alinhamento < 0,03 px', () => {
  let worst = 0;
  for (let i = 0; i <= 20; i++) {
    const d = [0.15 * i, -0.07 * i];
    const tr = createLKTracker(N);
    tr.push(crop(scene, 250, 250, N));
    const r = tr.push(crop(scene, 250 - d[0], 250 - d[1], N));
    worst = Math.max(worst, Math.abs(r.x - d[0]), Math.abs(r.y - d[1]));
  }
  assert.ok(worst < 0.03, `erro máximo ${worst.toFixed(4)} px`);
});

test('movimento a 120 Hz é medido fielmente e para quando para', () => {
  const traj = [...still(30)];
  for (let i = 1; i <= 240; i++) traj.push([i * 0.5, -i * 0.25]); // 2 s, 120 px × −60 px
  traj.push(...still(120, traj[traj.length - 1]));
  const { out } = run(traj);
  assert.ok(Math.abs(out.x - 120) < 1.2, `x = ${out.x.toFixed(2)} (esperado 120)`);
  assert.ok(Math.abs(out.y + 60) < 0.8, `y = ${out.y.toFixed(2)} (esperado −60)`);
});

test('movimento brusco (salto de 6 px num quadro) é recuperado pela correlação de fase', () => {
  const traj = [...still(10), ...still(30, [6, -5])];
  const { out, res } = run(traj);
  assert.ok(res.some((r) => r.method === 'fase'), 'esperava usar a reserva');
  assert.ok(Math.abs(out.x - 6) < 0.2 && Math.abs(out.y + 5) < 0.2, `(${out.x.toFixed(2)}, ${out.y.toFixed(2)})`);
});

test('teto liso: sem rastreio válido, sem movimento', () => {
  const tr = createLKTracker(N);
  const rand = rng(4);
  let valid = 0;
  for (let i = 0; i < 30; i++) {
    const r = tr.push(Float32Array.from({ length: N * N }, () => 200 + (rand() - 0.5) * 3));
    if (r.valid && Math.hypot(r.x, r.y) > 0.5) valid++;
  }
  assert.equal(valid, 0);
});

test('rápido o bastante para 120 Hz (< 3 ms por quadro no PC)', () => {
  const tr = createLKTracker(N);
  const frames = [];
  for (let i = 0; i < 60; i++) frames.push(crop(scene, 250 - i * 0.4, 250, N, { noise: 1 }));
  tr.push(frames[0]);
  const t0 = performance.now();
  for (let i = 1; i < frames.length; i++) tr.push(frames[i]);
  const ms = (performance.now() - t0) / (frames.length - 1);
  console.log(`  tempo por quadro: ${ms.toFixed(2)} ms`);
  assert.ok(ms < 3, `${ms.toFixed(2)} ms por quadro`);
});
