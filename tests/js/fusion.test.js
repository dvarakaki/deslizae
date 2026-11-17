'use strict';

// Fusão câmera + acelerômetro, numa simulação com atraso, ruído e viés reais.
const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');

const { createFusion, integrateGesture, fitImuMap, estimateLag, apply } = require(path.join(__dirname, '../../deslizae/static/fusion.js'));
const { rng } = require('./scene.js');

const B_TRUE = [-250, 0, 0, 250]; // m → px de câmera (eixo X espelhado, como na câmera frontal)
const CAM_HZ = 30, IMU_HZ = 60, CAM_LAG = 70; // ms

// Movimentos "minimum-jerk" (perfil típico da mão) em metros, no referencial do aparelho.
const SEGMENTS = [
  { t0: 500, T: 350, dx: 0.08, dy: 0 },
  { t0: 1400, T: 300, dx: 0, dy: 0.06 },
];
const END = 2500;

function truth(t) {
  let x = 0, y = 0, ax = 0, ay = 0;
  for (const s of SEGMENTS) {
    const tau = Math.min(1, Math.max(0, (t - s.t0) / s.T));
    const pos = 10 * tau ** 3 - 15 * tau ** 4 + 6 * tau ** 5;
    const acc = t > s.t0 && t < s.t0 + s.T ? (60 * tau - 180 * tau ** 2 + 120 * tau ** 3) / (s.T / 1000) ** 2 : 0;
    x += s.dx * pos; y += s.dy * pos; ax += s.dx * acc; ay += s.dy * acc;
  }
  return { x, y, ax, ay };
}

/** Roda a simulação; retorna a série da posição entregue ao cursor. */
function simulate({ useImu, seed = 3 }) {
  const rand = rng(seed);
  const gauss = () => (rand() + rand() + rand() + rand() - 2) * 0.87;
  const f = createFusion();
  if (useImu) f.setImuMap(B_TRUE);
  const events = [];
  for (let t = 0; t <= END; t += 1000 / CAM_HZ) {
    const p = apply(B_TRUE, truth(t).x, truth(t).y);
    events.push({ at: t + CAM_LAG, kind: 'cam', t, x: p.x + gauss() * 0.03, y: p.y + gauss() * 0.03 });
  }
  for (let t = 0; t <= END; t += 1000 / IMU_HZ) {
    const tr = truth(t);
    events.push({ at: t, kind: 'imu', t, ax: tr.ax + 0.03 + gauss() * 0.02, ay: tr.ay - 0.02 + gauss() * 0.02 });
  }
  events.sort((a, b) => a.at - b.at);
  const out = { x: 0, y: 0 };
  let origin = null;
  const series = [];
  for (const e of events) {
    if (e.kind === 'cam') { f.camera(e.t, e.x, e.y); if (!origin) origin = { x: e.x, y: e.y }; }
    else f.imu(e.t, e.ax, e.ay, 0);
    const d = f.pull();
    out.x += d.dx; out.y += d.dy;
    series.push({ at: e.at, x: out.x, y: out.y });
  }
  return series;
}

const crossing = (series, key, target) => series.find((p) => Math.abs(p[key]) >= Math.abs(target))?.at;

test('fusão: chega à posição certa e não deriva', () => {
  const s = simulate({ useImu: true });
  const end = s[s.length - 1];
  const want = apply(B_TRUE, 0.08, 0.06); // (−20, 15) px
  assert.ok(Math.abs(end.x - want.x) < 0.5 && Math.abs(end.y - want.y) < 0.5, `fim (${end.x.toFixed(2)}, ${end.y.toFixed(2)})`);
});

test('fusão: parado, nada se move (antes, entre e depois dos gestos)', () => {
  const s = simulate({ useImu: true });
  const span = (a, b) => {
    const w = s.filter((p) => p.at >= a && p.at <= b);
    return Math.max(...w.map((p) => Math.hypot(p.x - w[0].x, p.y - w[0].y)));
  };
  assert.equal(span(0, 480), 0);
  assert.ok(span(1150, 1390) < 0.05, `entre gestos: ${span(1150, 1390).toFixed(3)} px`);
  assert.ok(span(2050, END) < 0.05, `depois: ${span(2050, END).toFixed(3)} px`);
});

test('fusão: reage antes que a câmera sozinha (atraso compensado)', () => {
  const fused = simulate({ useImu: true });
  const cam = simulate({ useImu: false });
  const half = apply(B_TRUE, 0.04, 0).x; // metade do 1º gesto
  const tTruth = SEGMENTS[0].t0 + SEGMENTS[0].T / 2;
  const lagFused = crossing(fused, 'x', half) - tTruth;
  const lagCam = crossing(cam, 'x', half) - tTruth;
  console.log(`  atraso até a metade do gesto: só câmera ${lagCam.toFixed(0)} ms, fusão ${lagFused.toFixed(0)} ms`);
  assert.ok(lagFused < lagCam - 30, `fusão ${lagFused.toFixed(0)} ms vs câmera ${lagCam.toFixed(0)} ms`);
});

test('fusão: sem ultrapassar o alvo de forma visível', () => {
  const s = simulate({ useImu: true });
  const target = apply(B_TRUE, 0.08, 0).x; // −20 px no 1º gesto
  const w = s.filter((p) => p.at < SEGMENTS[1].t0);
  const extreme = Math.min(...w.map((p) => p.x));
  assert.ok(extreme > target * 1.08, `ultrapassou até ${extreme.toFixed(2)} (alvo ${target})`);
});

test('só câmera: segue a câmera e para quando ela para', () => {
  const s = simulate({ useImu: false });
  const end = s[s.length - 1];
  const want = apply(B_TRUE, 0.08, 0.06);
  assert.ok(Math.abs(end.x - want.x) < 0.3 && Math.abs(end.y - want.y) < 0.3);
});

test('calibração: deslocamento do gesto pelo acelerômetro (ZUPT) com viés', () => {
  const rand = rng(8);
  const samples = [];
  for (let t = 300; t <= 1050; t += 1000 / IMU_HZ) {
    const tr = truth(t);
    samples.push({ t, x: tr.ax + 0.04 + (rand() - 0.5) * 0.04, y: tr.ay + (rand() - 0.5) * 0.04 });
  }
  const traj = integrateGesture(samples);
  const end = traj[traj.length - 1];
  assert.ok(Math.abs(end.x - 0.08) < 0.004, `x = ${end.x.toFixed(4)} m (esperado 0,08)`);
  assert.ok(Math.abs(end.y) < 0.004, `y = ${end.y.toFixed(4)} m`);
});

test('calibração: matriz B do acelerômetro e qualidade', () => {
  const r = fitImuMap({ x: 0.08, y: 0.001 }, { x: -0.002, y: 0.06 }, apply(B_TRUE, 0.08, 0.001), apply(B_TRUE, -0.002, 0.06));
  assert.ok(r.B.every((v, i) => Math.abs(v - B_TRUE[i]) < 1e-6));
  assert.ok(Math.abs(r.scale - 250) < 1e-6 && r.cond < 1.01);
});

test('calibração: atraso da câmera pela correlação das velocidades', () => {
  const imu = [], cam = [];
  for (let t = 300; t <= 1100; t += 5) {
    const tr = truth(t);
    imu.push({ t, x: tr.x, y: tr.y });
    const d = truth(t - CAM_LAG); // câmera vê o passado: o que aconteceu há 70 ms
    cam.push({ t, x: d.x, y: d.y });
  }
  const r = estimateLag(cam, imu);
  assert.ok(Math.abs(r.lagMs - CAM_LAG) <= 8, `atraso estimado ${r.lagMs} ms`);
});
