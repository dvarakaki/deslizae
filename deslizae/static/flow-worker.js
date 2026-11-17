'use strict';

/* Rastreia o deslocamento da imagem fora da thread principal, para que os
   botões e a interface continuem respondendo enquanto a FFT roda. */
importScripts('/static/flow.js');

let tracker = null;
let config = '';

self.onmessage = (e) => {
  const { gray, n, t, rowNormalize, rekeyPx, minPsr, reset } = e.data;
  const want = `${n}|${rowNormalize}|${rekeyPx}|${minPsr}`;
  if (!tracker || want !== config) {
    tracker = self.DeslizaeFlow.createTracker(n, { rowNormalize, rekeyPx, minPsr });
    config = want;
  }
  if (reset) tracker.reset();
  const t0 = performance.now();
  const r = tracker.push(gray);
  self.postMessage({ t, ...r, ms: performance.now() - t0 });
};
