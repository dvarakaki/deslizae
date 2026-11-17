'use strict';

// Rastreador + detector de movimento: o que importa para o cursor.
const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');

const { createTracker, createPhaseCorrelator } = require(path.join(__dirname, '../../deslizae/static/flow.js'));
const { createMotionFilter, gyroMatrix, axisMatrix, apply } = require(path.join(__dirname, '../../deslizae/static/motion.js'));
const { rng, makeScene, crop } = require('./scene.js');

const N = 128;
const FPS = 30;
const scene = makeScene(700, 700);

/** Simula uma câmera: posição (x, y) da cena por quadro, com ruído/luz. */
function run(path_, opts = {}) {
  const tracker = createTracker(N, { rowNormalize: opts.rowNormalize ?? true });
  const motion = createMotionFilter({ startPx: 0.4 });
  const rand = rng(opts.seed ?? 1);
  const out = { x: 0, y: 0 }; // soma dos deltas entregues ao cursor
  const positions = [];
  path_.forEach(([cx, cy], i) => {
    const frame = crop(scene, 200 - cx, 200 - cy, N, {
      noise: opts.noise ?? 1.5,
      gain: opts.gainWobble ? 1 + 0.08 * Math.sin(i / 3) : 1,
      flicker: opts.flicker ? { amp: 0.06, period: 37, phase: i * 1.9 } : null,
      rand,
    });
    const r = tracker.push(frame);
    positions.push(r);
    if (!r.valid) return;
    const m = motion.push(r.x, r.y, i / FPS);
    out.x += m.dx;
    out.y += m.dy;
  });
  return { out, positions };
}

const still = (frames) => Array.from({ length: frames }, () => [0, 0]);

test('parado com ruído de sensor: o cursor não se mexe', () => {
  const { out, positions } = run(still(150));
  assert.equal(out.x, 0);
  assert.equal(out.y, 0);
  const maxDev = Math.max(...positions.filter((p) => p.valid).map((p) => Math.hypot(p.x, p.y)));
  assert.ok(maxDev < 0.2, `posição oscilou ${maxDev.toFixed(3)} px`);
});

test('parado com lâmpada piscando e brilho variando: o cursor não se mexe', () => {
  const { out } = run(still(150), { flicker: true, gainWobble: true });
  assert.ok(Math.hypot(out.x, out.y) === 0, `andou ${out.x.toFixed(2)}, ${out.y.toFixed(2)}`);
});

test('anticintilação: sem normalizar linhas, as faixas viram falso movimento', () => {
  const frames = 60;
  const err = (rowNormalize) => {
    const t = createTracker(N, { rowNormalize });
    const rand = rng(5);
    let worst = 0;
    for (let i = 0; i < frames; i++) {
      const r = t.push(crop(scene, 200, 200, N, { noise: 1, flicker: { amp: 0.12, period: 29, phase: i * 2.3 }, rand }));
      if (r.valid) worst = Math.max(worst, Math.hypot(r.x, r.y));
    }
    return worst;
  };
  const with_ = err(true), without = err(false);
  assert.ok(with_ < 0.25, `com normalização: ${with_.toFixed(3)} px`);
  assert.ok(without > with_ * 2, `normalização deveria ajudar (${without.toFixed(3)} vs ${with_.toFixed(3)})`);
});

test('movimento em linha reta é medido fielmente e para quando o celular para', () => {
  const pathMove = [];
  for (let i = 0; i <= 60; i++) pathMove.push([i * 1.5, i * -0.5]); // 90 px, −30 px
  const tail = still(45).map(() => [90, -30]);
  const { out } = run([...still(10), ...pathMove, ...tail]);
  assert.ok(Math.abs(out.x - 90) < 1.0, `x = ${out.x.toFixed(2)} (esperado 90)`);
  assert.ok(Math.abs(out.y + 30) < 1.0, `y = ${out.y.toFixed(2)} (esperado −30)`);
});

test('movimento longo com várias trocas de referência acumula pouco erro', () => {
  const pathLong = [];
  for (let i = 0; i <= 150; i++) pathLong.push([i * 2, Math.sin(i / 10) * 20]); // 300 px
  const tail = still(30).map(() => pathLong[pathLong.length - 1]);
  const { out, positions } = run([...pathLong, ...tail]);
  const end = pathLong[pathLong.length - 1];
  const rekeys = positions.filter((p) => p.rekeyed).length;
  assert.ok(rekeys > 20, `esperava várias trocas de referência, houve ${rekeys}`);
  // A janela de Hann subestima todo deslocamento numa proporção constante
  // (~0,7%, igual nos dois eixos): para o cursor é só uma sensibilidade
  // levemente menor. O que precisa ser pequeno é o erro relativo e de direção.
  const err = Math.hypot(out.x - end[0], out.y - end[1]) / Math.hypot(end[0], end[1]);
  assert.ok(err < 0.02, `erro relativo ${(err * 100).toFixed(2)}%`);
  const angErr = Math.abs(Math.atan2(out.y, out.x) - Math.atan2(end[1], end[0])) * (180 / Math.PI);
  assert.ok(angErr < 0.5, `erro de direção ${angErr.toFixed(2)}°`);
});

test('micro-movimento abaixo do limiar não passa; acima, passa inteiro', () => {
  const tiny = [...still(10), ...Array.from({ length: 20 }, (_, i) => [Math.min(i, 10) * 0.02, 0]), ...still(30).map(() => [0.2, 0])];
  assert.equal(run(tiny).out.x, 0); // 0,2 px: tremor, ignorado
  const small = [...still(10), ...Array.from({ length: 20 }, (_, i) => [Math.min(i, 10) * 0.3, 0]), ...still(30).map(() => [3, 0])];
  const { out } = run(small);
  assert.ok(Math.abs(out.x - 3) < 0.3, `3 px pedidos, ${out.x.toFixed(2)} entregues`);
});

test('calibração: matriz do giroscópio e orientação dos eixos', () => {
  // Simulação: 1° em X desloca a imagem (0, 8,7) px; 1° em Y desloca (−8,7, 0).
  const rand = rng(9);
  const samples = Array.from({ length: 80 }, () => {
    const gx = (rand() - 0.5) * 2, gy = (rand() - 0.5) * 2;
    return { gx, gy, dx: -8.7 * gy + (rand() - 0.5) * 0.1, dy: 8.7 * gx + (rand() - 0.5) * 0.1 };
  });
  const M = gyroMatrix(samples);
  assert.ok(Math.abs(M[0]) < 0.1 && Math.abs(M[1] + 8.7) < 0.1 && Math.abs(M[2] - 8.7) < 0.1 && Math.abs(M[3]) < 0.1, `M = ${M.map((v) => v.toFixed(2))}`);

  // Imagem anda para a esquerda quando o celular vai para a direita, e para
  // baixo quando vai para frente (casos reais de câmera frontal).
  const A = axisMatrix({ x: -40, y: 2 }, { x: 1, y: 35 });
  const right = apply(A, -40, 2), fwd = apply(A, 1, 35);
  assert.ok(right.x > 39 && Math.abs(right.y) < 1e-9, `direita → ${right.x.toFixed(1)}, ${right.y.toFixed(1)}`);
  assert.ok(fwd.y < -34, `frente deveria ir para cima, foi ${fwd.y.toFixed(1)}`);
});

test('correlator continua preciso com normalização por linha', () => {
  const pc = createPhaseCorrelator(N, { rowNormalize: true });
  const r = pc.shift(pc.prepare(crop(scene, 150, 150, N)), pc.prepare(crop(scene, 150 - 4.3, 150 + 2.6, N)));
  assert.ok(Math.abs(r.dx - 4.3) < 0.08 && Math.abs(r.dy + 2.6) < 0.08, `(${r.dx.toFixed(3)}, ${r.dy.toFixed(3)})`);
});
