'use strict';

/* Rastreia o deslocamento da imagem fora da thread principal, para que os
   botões continuem respondendo enquanto o alinhamento roda. */
importScripts('/static/flow.js');

let tracker = null;
let config = '';

self.onmessage = (e) => {
  const { gray, n, t, rowNormalize, rekeyPx, reset } = e.data;
  const want = `${n}|${rowNormalize}|${rekeyPx}`;
  if (!tracker || want !== config) {
    tracker = self.DeslizaeFlow.createLKTracker(n, { rowNormalize, rekeyPx });
    config = want;
  }
  if (reset) tracker.reset();
  const t0 = performance.now();
  const r = tracker.push(gray);
  self.postMessage({ t, ...r, ms: performance.now() - t0 });
};
