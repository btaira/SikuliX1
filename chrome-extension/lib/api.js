// SikuliX-like API — runs in the side-panel page context.
// Functions are injected as globals when user scripts execute.

'use strict';

/* global chrome */

// Loaded by the sidepanel; `logOutput` and `templates` are injected at runtime.
// This file exports `createAPI(logFn, getTemplateFn, getThresholdFn)`.

function createAPI(logFn, getTemplate, getThreshold) {
  const send = (msg) =>
    new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(msg, (resp) => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        if (resp && resp.error) return reject(new Error(resp.error));
        resolve(resp);
      });
    });

  // ── screenshot + match ───────────────────────────────────────────────────────

  async function capture() {
    const { dataUrl } = await send({ type: 'screenshot' });
    return dataUrl;
  }

  async function imageDataFrom(dataUrl) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const c = document.createElement('canvas');
        c.width = img.width; c.height = img.height;
        c.getContext('2d').drawImage(img, 0, 0);
        resolve(c.getContext('2d').getImageData(0, 0, img.width, img.height));
      };
      img.onerror = () => reject(new Error('Failed to load image'));
      img.src = dataUrl;
    });
  }

  function runMatcher(ssData, tplData, threshold, findAll = false) {
    return new Promise((resolve, reject) => {
      const ssBuffer  = ssData.data.buffer.slice(0);
      const tplBuffer = tplData.data.buffer.slice(0);
      const worker = new Worker(chrome.runtime.getURL('matcher.worker.js'));
      worker.onmessage = (e) => {
        worker.terminate();
        if (e.data.error) reject(new Error(e.data.error));
        else resolve(e.data.result);
      };
      worker.onerror = (e) => { worker.terminate(); reject(new Error(e.message)); };
      worker.postMessage(
        { ssBuffer, ssW: ssData.width, ssH: ssData.height,
          tplBuffer, tplW: tplData.width, tplH: tplData.height,
          threshold, findAll },
        [ssBuffer, tplBuffer]
      );
    });
  }

  async function matchOn(templateId, screenshotUrl, findAll) {
    const tpl = getTemplate(templateId);
    if (!tpl) throw new Error(`Template not found: "${templateId}"`);
    const threshold = getThreshold();
    const [ssData, tplData] = await Promise.all([
      imageDataFrom(screenshotUrl),
      imageDataFrom(tpl.dataUrl),
    ]);
    return runMatcher(ssData, tplData, threshold, findAll);
  }

  // ── public API ───────────────────────────────────────────────────────────────

  async function find(templateId) {
    const ss = await capture();
    const match = await matchOn(templateId, ss, false);
    if (!match) throw new Error(`find("${templateId}"): not found on screen`);
    return match;
  }

  async function exists(templateId) {
    const ss = await capture();
    return matchOn(templateId, ss, false);
  }

  async function findAll(templateId) {
    const ss = await capture();
    const matches = await matchOn(templateId, ss, true);
    return matches || [];
  }

  async function wait(templateId, timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const ss = await capture();
      const match = await matchOn(templateId, ss, false);
      if (match) return match;
      await pause(500);
    }
    throw new Error(`wait("${templateId}"): timed out after ${timeoutMs}ms`);
  }

  async function waitVanish(templateId, timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const ss = await capture();
      const match = await matchOn(templateId, ss, false);
      if (!match) return true;
      await pause(500);
    }
    throw new Error(`waitVanish("${templateId}"): still visible after ${timeoutMs}ms`);
  }

  // ── mouse input ──────────────────────────────────────────────────────────────

  async function resolveTarget(target) {
    if (typeof target === 'string') {
      const m = await find(target);
      return { x: m.x, y: m.y };
    }
    if (target && typeof target.x === 'number') return target;
    throw new Error('click target must be a template name or {x, y}');
  }

  async function click(target) {
    const { x, y } = await resolveTarget(target);
    logFn(`click(${Math.round(x)}, ${Math.round(y)})`);
    await send({ type: 'focus', x, y });
    return send({ type: 'click', x, y, button: 'left', clickCount: 1 });
  }

  async function rightClick(target) {
    const { x, y } = await resolveTarget(target);
    logFn(`rightClick(${Math.round(x)}, ${Math.round(y)})`);
    return send({ type: 'click', x, y, button: 'right', clickCount: 1 });
  }

  async function doubleClick(target) {
    const { x, y } = await resolveTarget(target);
    logFn(`doubleClick(${Math.round(x)}, ${Math.round(y)})`);
    await send({ type: 'focus', x, y });
    return send({ type: 'click', x, y, button: 'left', clickCount: 2 });
  }

  async function hover(target) {
    const { x, y } = await resolveTarget(target);
    logFn(`hover(${Math.round(x)}, ${Math.round(y)})`);
    return send({ type: 'move', x, y });
  }

  async function dragDrop(from, to) {
    const f = await resolveTarget(from);
    const t = await resolveTarget(to);
    logFn(`dragDrop(${Math.round(f.x)},${Math.round(f.y)} → ${Math.round(t.x)},${Math.round(t.y)})`);
    await send({ type: 'click', x: f.x, y: f.y, button: 'left', clickCount: 1 });
    // move in steps
    const steps = 10;
    for (let i = 1; i <= steps; i++) {
      await send({ type: 'move',
        x: f.x + (t.x - f.x) * i / steps,
        y: f.y + (t.y - f.y) * i / steps });
      await pause(20);
    }
    await send({ type: 'click', x: t.x, y: t.y, button: 'left', clickCount: 1 });
  }

  async function scroll(direction = 'down', amount = 300, x, y) {
    const deltaY = direction === 'down' ? amount : -amount;
    const deltaX = direction === 'right' ? amount : direction === 'left' ? -amount : 0;
    logFn(`scroll(${direction}, ${amount})`);
    return send({ type: 'scroll', deltaX, deltaY, x, y });
  }

  // ── keyboard input ───────────────────────────────────────────────────────────

  async function type(text) {
    logFn(`type("${text.length > 40 ? text.slice(0, 40) + '…' : text}")`);
    return send({ type: 'type', text });
  }

  async function key(combo) {
    logFn(`key("${combo}")`);
    return send({ type: 'key', combo });
  }

  // ── utilities ────────────────────────────────────────────────────────────────

  function pause(ms) {
    return new Promise(r => setTimeout(r, ms));
  }

  function log(msg) {
    logFn(String(msg));
  }

  async function screenshot() {
    const url = await capture();
    logFn('[screenshot taken]');
    return url;
  }

  return {
    find, exists, findAll, wait, waitVanish,
    click, rightClick, doubleClick, hover, dragDrop, scroll,
    type, key,
    pause, log, screenshot,
  };
}

// Export for sidepanel.js (loaded as a classic script tag).
if (typeof module !== 'undefined') module.exports = { createAPI };
