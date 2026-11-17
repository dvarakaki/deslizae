'use strict';

/* Calcula o deslocamento entre quadros fora da thread principal, para que os
   botões e a interface continuem respondendo enquanto a FFT roda. */
importScripts('/static/flow.js');

let pc = null;
let prev = null;

self.onmessage = (e) => {
  const { gray, n, t } = e.data;
  if (!pc || pc.n !== n) {
    pc = self.DeslizaeFlow.createPhaseCorrelator(n);
    prev = null;
  }
  const t0 = performance.now();
  const cur = pc.prepare(gray);
  const r = prev ? pc.shift(prev, cur) : null;
  prev = cur;
  self.postMessage({ t, r, contrast: cur.contrast, ms: performance.now() - t0 });
};
