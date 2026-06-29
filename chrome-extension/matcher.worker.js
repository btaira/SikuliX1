// Web Worker — normalized cross-correlation (NCC) template matching.
// Uses an integral-image for O(1) per-window mean and a 4× pyramid for speed.

self.onmessage = function (e) {
  const { ssBuffer, ssW, ssH, tplBuffer, tplW, tplH, threshold, findAll } = e.data;
  try {
    const ssData  = { data: new Uint8ClampedArray(ssBuffer),  width: ssW,  height: ssH  };
    const tplData = { data: new Uint8ClampedArray(tplBuffer), width: tplW, height: tplH };
    const result  = findAll
      ? findAllMatches(ssData, tplData, threshold)
      : findBest(ssData, tplData, threshold);
    self.postMessage({ result });
  } catch (err) {
    self.postMessage({ error: err.message });
  }
};

// ── entry points ───────────────────────────────────────────────────────────────

function findBest(ss, tpl, threshold) {
  const { x, y, score } = coarseRefine(ss, tpl);
  if (!Number.isFinite(score)) return null;
  return {
    x: Math.round(x),
    y: Math.round(y),
    score,
    w: tpl.width,
    h: tpl.height,
    matched: score >= threshold,
  };
}

function findAllMatches(ss, tpl, threshold) {
  const COARSE_THRESHOLD = Math.max(0.5, threshold - 0.15);
  const ssSmall  = downsample(ss, 4);
  const tplSmall = downsample(tpl, 4);

  const coarse = nccScan(ssSmall, tplSmall, COARSE_THRESHOLD);
  const deduped = nonMaxSuppress(coarse, tplSmall.width, tplSmall.height);

  const results = [];
  for (const c of deduped.slice(0, 30)) {
    const cx = Math.round(c.x * 4);
    const cy = Math.round(c.y * 4);
    const m  = nccRegion(ss, tpl, cx - 8, cy - 8, cx + 8, cy + 8);
    if (m && m.score >= threshold) results.push(m);
  }

  results.sort((a, b) => b.score - a.score);
  return nonMaxSuppress(results, tpl.width, tpl.height)
    .map(m => ({ x: Math.round(m.x), y: Math.round(m.y), score: m.score, w: tpl.width, h: tpl.height }));
}

// ── coarse → refine ────────────────────────────────────────────────────────────

function coarseRefine(ss, tpl) {
  const ssSmall  = downsample(ss, 4);
  const tplSmall = downsample(tpl, 4);

  const best = nccBest(ssSmall, tplSmall);
  const cx   = Math.round(best.x * 4);
  const cy   = Math.round(best.y * 4);

  const refined = nccRegion(ss, tpl, cx - 8, cy - 8, cx + 8, cy + 8);
  return refined || { x: cx + tpl.width / 2, y: cy + tpl.height / 2, score: best.score };
}

// ── downsample via OffscreenCanvas ─────────────────────────────────────────────

function downsample(img, factor) {
  const nw = Math.max(1, Math.floor(img.width  / factor));
  const nh = Math.max(1, Math.floor(img.height / factor));
  const src = new OffscreenCanvas(img.width, img.height);
  src.getContext('2d').putImageData(new ImageData(img.data, img.width, img.height), 0, 0);
  const dst = new OffscreenCanvas(nw, nh);
  const ctx = dst.getContext('2d');
  ctx.drawImage(src, 0, 0, nw, nh);
  return ctx.getImageData(0, 0, nw, nh);
}

// ── full-image NCC scan (returns all matches above threshold) ──────────────────

function nccScan(ss, tpl, threshold) {
  const setup = prepareTemplate(tpl);
  if (!setup) return [];
  const { tDiff, tNorm, tw, th } = setup;
  const { data: sd, width: sw, height: sh } = ss;
  const tn = tw * th;
  const ii = buildIntegral(sd, sw, sh);
  const matches = [];

  for (let sy = 0; sy <= sh - th; sy++) {
    for (let sx = 0; sx <= sw - tw; sx++) {
      const score = nccAt(sd, sw, sx, sy, tw, th, tn, ii, tDiff, tNorm);
      if (score >= threshold) {
        matches.push({ x: sx + tw / 2, y: sy + th / 2, score });
      }
    }
  }
  return matches;
}

// ── find single best on a (small) image ───────────────────────────────────────

function nccBest(ss, tpl) {
  const setup = prepareTemplate(tpl);
  if (!setup) return { x: 0, y: 0, score: 0 };
  const { tDiff, tNorm, tw, th } = setup;
  const { data: sd, width: sw, height: sh } = ss;
  const tn = tw * th;
  const ii = buildIntegral(sd, sw, sh);

  let best = { x: 0, y: 0, score: -Infinity };
  for (let sy = 0; sy <= sh - th; sy++) {
    for (let sx = 0; sx <= sw - tw; sx++) {
      const score = nccAt(sd, sw, sx, sy, tw, th, tn, ii, tDiff, tNorm);
      if (score > best.score) best = { x: sx + tw / 2, y: sy + th / 2, score };
    }
  }
  return best;
}

// ── refine within a rectangle ──────────────────────────────────────────────────

function nccRegion(ss, tpl, x1, y1, x2, y2) {
  const setup = prepareTemplate(tpl);
  if (!setup) return null;
  const { tDiff, tNorm, tw, th } = setup;
  const { data: sd, width: sw, height: sh } = ss;
  const tn = tw * th;
  const ii = buildIntegral(sd, sw, sh);

  const rx1 = Math.max(0, x1), ry1 = Math.max(0, y1);
  const rx2 = Math.min(sw - tw, x2), ry2 = Math.min(sh - th, y2);

  let best = { x: -1, y: -1, score: -Infinity };
  for (let sy = ry1; sy <= ry2; sy++) {
    for (let sx = rx1; sx <= rx2; sx++) {
      const score = nccAt(sd, sw, sx, sy, tw, th, tn, ii, tDiff, tNorm);
      if (score > best.score) best = { x: sx + tw / 2, y: sy + th / 2, score };
    }
  }
  return best.x >= 0
    ? { x: best.x, y: best.y, score: best.score, w: tw, h: th }
    : null;
}

// ── NCC score at one position ──────────────────────────────────────────────────

function nccAt(sd, sw, sx, sy, tw, th, tn, ii, tDiff, tNorm) {
  const [wR, wG, wB] = windowSum(ii, sw, sx, sy, sx + tw - 1, sy + th - 1);
  const wmR = wR / tn, wmG = wG / tn, wmB = wB / tn;

  let corr = 0, wNorm = 0;
  for (let ty = 0; ty < th; ty++) {
    const siRow = (sy + ty) * sw;
    const tiRow = ty * tw;
    for (let tx = 0; tx < tw; tx++) {
      const si = (siRow + sx + tx) * 4;
      const ti = (tiRow + tx) * 3;
      const dr = sd[si]     - wmR;
      const dg = sd[si + 1] - wmG;
      const db = sd[si + 2] - wmB;
      corr  += dr * tDiff[ti] + dg * tDiff[ti + 1] + db * tDiff[ti + 2];
      wNorm += dr * dr + dg * dg + db * db;
    }
  }
  wNorm = Math.sqrt(wNorm);
  const denom = wNorm * tNorm;
  return denom > 1e-6 ? corr / denom : 0;
}

// ── prepare template (zero-mean, pre-normalise) ────────────────────────────────

function prepareTemplate(tpl) {
  const { data: td, width: tw, height: th } = tpl;
  const tn = tw * th;
  if (tn === 0) return null;

  let tR = 0, tG = 0, tB = 0;
  for (let i = 0; i < tn; i++) {
    tR += td[i * 4]; tG += td[i * 4 + 1]; tB += td[i * 4 + 2];
  }
  const tmR = tR / tn, tmG = tG / tn, tmB = tB / tn;

  const tDiff = new Float32Array(tn * 3);
  let tNorm = 0;
  for (let i = 0; i < tn; i++) {
    tDiff[i * 3]     = td[i * 4]     - tmR;
    tDiff[i * 3 + 1] = td[i * 4 + 1] - tmG;
    tDiff[i * 3 + 2] = td[i * 4 + 2] - tmB;
    tNorm += tDiff[i * 3] ** 2 + tDiff[i * 3 + 1] ** 2 + tDiff[i * 3 + 2] ** 2;
  }
  tNorm = Math.sqrt(tNorm);
  if (tNorm < 1e-6) return null;

  return { tDiff, tNorm, tw, th };
}

// ── integral image ─────────────────────────────────────────────────────────────

function buildIntegral(data, w, h) {
  const ii = new Float64Array((w + 1) * (h + 1) * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const si  = (y * w + x) * 4;
      const di  = ((y + 1) * (w + 1) + (x + 1)) * 3;
      const top = (y * (w + 1) + (x + 1)) * 3;
      const lft = ((y + 1) * (w + 1) + x) * 3;
      const tl  = (y * (w + 1) + x) * 3;
      ii[di]     = data[si]     + ii[top]     + ii[lft]     - ii[tl];
      ii[di + 1] = data[si + 1] + ii[top + 1] + ii[lft + 1] - ii[tl + 1];
      ii[di + 2] = data[si + 2] + ii[top + 2] + ii[lft + 2] - ii[tl + 2];
    }
  }
  return ii;
}

function windowSum(ii, w, x1, y1, x2, y2) {
  const r1 = ((y2 + 1) * (w + 1) + (x2 + 1)) * 3;
  const r2 = (y1 * (w + 1) + (x2 + 1)) * 3;
  const r3 = ((y2 + 1) * (w + 1) + x1) * 3;
  const r4 = (y1 * (w + 1) + x1) * 3;
  return [
    ii[r1] - ii[r2] - ii[r3] + ii[r4],
    ii[r1 + 1] - ii[r2 + 1] - ii[r3 + 1] + ii[r4 + 1],
    ii[r1 + 2] - ii[r2 + 2] - ii[r3 + 2] + ii[r4 + 2],
  ];
}

// ── non-maximum suppression ────────────────────────────────────────────────────

function nonMaxSuppress(matches, tw, th) {
  const sorted = [...matches].sort((a, b) => b.score - a.score);
  const kept = [];
  for (const m of sorted) {
    const overlaps = kept.some(
      k => Math.abs(k.x - m.x) < tw * 0.6 && Math.abs(k.y - m.y) < th * 0.6
    );
    if (!overlaps) kept.push(m);
  }
  return kept;
}
