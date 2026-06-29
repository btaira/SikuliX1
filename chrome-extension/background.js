// Service worker — screenshot, CDP input, template storage, recording.
'use strict';

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

// ── debugger state ─────────────────────────────────────────────────────────────
const attached = new Map();

async function attachDebugger(tabId) {
  if (attached.get(tabId)) return;
  await chrome.debugger.attach({ tabId }, '1.3');
  attached.set(tabId, true);
}
async function detachDebugger(tabId) {
  if (!attached.get(tabId)) return;
  try { await chrome.debugger.detach({ tabId }); } catch (_) {}
  attached.delete(tabId);
}
chrome.debugger.onDetach.addListener(({ tabId }) => attached.delete(tabId));

// ── keep-alive ─────────────────────────────────────────────────────────────────
let keepAlive = null;
function startKeepAlive() { keepAlive ??= setInterval(() => chrome.runtime.getPlatformInfo(() => {}), 20_000); }
function stopKeepAlive()  { clearInterval(keepAlive); keepAlive = null; }

// ── recording state ────────────────────────────────────────────────────────────
let recording    = false;
let recAccepting = false;
let recTabId     = null;
let recStepCount = 0;
let recStepsMem  = [];
let recEventChain = Promise.resolve();
let recPendingCount = 0;
let recLastEventAt = 0;

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!recording || tabId !== recTabId || changeInfo.status !== 'complete') return;
  injectRecorder(tabId).catch(err => console.error('recorder reinject failed:', err));
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId !== recTabId) return;
  recording = false;
  recAccepting = false;
  recTabId = null;
  recStepsMem = [];
  stopKeepAlive();
});

// ── message bus ────────────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  if (msg.type === 'keepAlive')     { startKeepAlive(); respond({ ok: true }); return; }
  if (msg.type === 'stopKeepAlive') { stopKeepAlive();  respond({ ok: true }); return; }

  // Recording events from recorder.js (content script)
  if (msg.type === 'recEvent') {
    if (!recAccepting) { respond({ queued: false }); return; }
    recPendingCount += 1;
    recLastEventAt = Date.now();
    recEventChain = recEventChain
      .then(async () => {
        const step = await handleRecEvent(msg.event, sender);
        if (step) await pushRecStep(step);
      })
      .catch(err => console.error('recEvent failed:', err))
      .finally(() => {
        recPendingCount = Math.max(0, recPendingCount - 1);
      });
    respond({ queued: true });
    return; // no response needed
  }

  handle(msg).then(respond).catch(e => respond({ error: e.message }));
  return true;
});

// ── main handler ───────────────────────────────────────────────────────────────
async function handle(msg) {
  const tab       = await activeTab();
  const { id: tabId, windowId } = tab;

  switch (msg.type) {

    // ── screenshot ────────────────────────────────────────────────────────────
    case 'screenshot': {
      return captureScreenshot(tab);
    }

    // ── mouse ─────────────────────────────────────────────────────────────────
    case 'click': {
      await attachDebugger(tabId);
      const btn = msg.button || 'left';
      await mouseEv(tabId, 'mousePressed',  msg.x, msg.y, btn, 1);
      await sleep(30);
      await mouseEv(tabId, 'mouseReleased', msg.x, msg.y, btn, 1);
      if (msg.clickCount === 2) {
        await sleep(40);
        await mouseEv(tabId, 'mousePressed',  msg.x, msg.y, btn, 2);
        await sleep(30);
        await mouseEv(tabId, 'mouseReleased', msg.x, msg.y, btn, 2);
      }
      return { ok: true };
    }
    case 'move': {
      await attachDebugger(tabId);
      await mouseEv(tabId, 'mouseMoved', msg.x, msg.y, 'none', 0);
      return { ok: true };
    }
    case 'scroll': {
      await attachDebugger(tabId);
      await cdp(tabId, 'Input.dispatchMouseEvent', {
        type: 'mouseWheel', x: msg.x ?? 640, y: msg.y ?? 400,
        deltaX: msg.deltaX ?? 0, deltaY: msg.deltaY ?? 0,
      });
      return { ok: true };
    }

    // ── keyboard ──────────────────────────────────────────────────────────────
    case 'type': {
      await attachDebugger(tabId);
      await cdp(tabId, 'Input.insertText', { text: msg.text });
      return { ok: true };
    }
    case 'key': {
      await attachDebugger(tabId);
      const evs = parseCombo(msg.combo);
      for (const ev of evs)           await cdp(tabId, 'Input.dispatchKeyEvent', { type: 'keyDown', ...ev });
      await sleep(20);
      for (const ev of [...evs].reverse()) await cdp(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp',   ...ev });
      return { ok: true };
    }

    // ── focus helper ──────────────────────────────────────────────────────────
    case 'focus': {
      await chrome.scripting.executeScript({
        target: { tabId },
        func: (x, y) => { const el = document.elementFromPoint(x, y); el?.focus(); },
        args: [msg.x, msg.y],
      });
      return { ok: true };
    }

    case 'detachAll': {
      await detachDebugger(tabId);
      return { ok: true };
    }

    // ── recording ─────────────────────────────────────────────────────────────
    case 'startRecording': {
      recording    = true;
      recAccepting = true;
      recTabId     = tabId;
      recStepCount = 0;
      recStepsMem  = [];
      recEventChain = Promise.resolve();
      recPendingCount = 0;
      recLastEventAt = 0;
      startKeepAlive(); // keep SW alive so `recording` flag survives user interactions
      await chrome.storage.local.set({ recSteps: [], isRecording: true });
      await injectRecorder(tabId);
      return { ok: true };
    }
    case 'stopRecording': {
      await chrome.storage.local.set({ isRecording: false });
      chrome.tabs.sendMessage(recTabId ?? tabId, { type: 'stopRecorder' }).catch(() => {});
      await waitForRecorderDrain();
      recAccepting = false;
      await recEventChain.catch(() => {});
      recording = false;
      recTabId = null;
      stopKeepAlive();
      await chrome.storage.local.remove('recSteps');
      return { steps: [...recStepsMem] };
    }

    // ── capture tab ───────────────────────────────────────────────────────────
    case 'openCapture': {
      const { dataUrl: ss } = await captureScreenshot(tab);
      const url = chrome.runtime.getURL('capture.html')
        + '?name=' + encodeURIComponent(msg.name)
        + '&src='  + encodeURIComponent(ss);
      const ct = await chrome.tabs.create({ url, active: true });
      return { captureTabId: ct.id };
    }

    // ── template CRUD ─────────────────────────────────────────────────────────
    case 'saveTemplate': {
      const { templates = {} } = await chrome.storage.local.get('templates');
      templates[msg.name] = { dataUrl: msg.dataUrl, width: msg.width, height: msg.height };
      await chrome.storage.local.set({ templates });
      return { ok: true };
    }
    case 'getTemplates': {
      const { templates = {} } = await chrome.storage.local.get('templates');
      return { templates };
    }
    case 'deleteTemplate': {
      const { templates = {} } = await chrome.storage.local.get('templates');
      delete templates[msg.name];
      await chrome.storage.local.set({ templates });
      return { ok: true };
    }

    // ── workflow persistence ───────────────────────────────────────────────────
    case 'saveWorkflow': {
      await chrome.storage.local.set({ workflow: msg.steps });
      return { ok: true };
    }
    case 'loadWorkflow': {
      const { workflow = [] } = await chrome.storage.local.get('workflow');
      return { steps: workflow };
    }
    case 'saveScript': {
      await chrome.storage.local.set({ savedScript: msg.code });
      return { ok: true };
    }
    case 'loadScript': {
      const { savedScript = '' } = await chrome.storage.local.get('savedScript');
      return { code: savedScript };
    }

    default: throw new Error('Unknown message: ' + msg.type);
  }
}

// ── recording helpers ──────────────────────────────────────────────────────────

async function handleRecEvent(event, sender) {
  const tab = sender.tab || (recTabId ? await chrome.tabs.get(recTabId) : null);
  if (!tab) return null;

  switch (event.kind) {
    case 'click': {
      // Take a screenshot and crop around the clicked element bounds when possible.
      const { dataUrl, metrics } = await captureScreenshot(tab);
      const name     = `rec_${++recStepCount}`;
      const cropped  = await cropRecordedRegion(dataUrl, event, metrics);
      const { templates = {} } = await chrome.storage.local.get('templates');
      templates[name] = cropped;
      await chrome.storage.local.set({ templates });
      return {
        id: uid(),
        type: event.button === 'right' ? 'rightClick' : 'click',
        image: name,
        recordedX: event.x,
        recordedY: event.y,
      };
    }
    case 'type':   return { id: uid(), type: 'type',   text:      event.text  };
    case 'key':    return { id: uid(), type: 'key',    combo:     event.combo };
    case 'scroll': return { id: uid(), type: 'scroll', direction: event.direction, amount: event.amount };
    default:       return null;
  }
}

async function pushRecStep(step) {
  recStepsMem.push(step);
  await chrome.storage.local.set({ recSteps: [...recStepsMem] });
}

// Crop a w×h region centred on (cx,cy) from a PNG data URL, returns {dataUrl,width,height}
async function cropRegion(dataUrl, cx, cy, w, h) {
  const resp   = await fetch(dataUrl);
  const blob   = await resp.blob();
  const bitmap = await createImageBitmap(blob);

  const x  = Math.max(0, Math.round(cx - w / 2));
  const y  = Math.max(0, Math.round(cy - h / 2));
  const cw = Math.min(w, bitmap.width  - x);
  const ch = Math.min(h, bitmap.height - y);

  const canvas = new OffscreenCanvas(cw, ch);
  canvas.getContext('2d').drawImage(bitmap, x, y, cw, ch, 0, 0, cw, ch);

  const outBlob = await canvas.convertToBlob({ type: 'image/png' });
  const ab      = await outBlob.arrayBuffer();
  const b64     = arrayBufferToBase64(ab);
  return { dataUrl: 'data:image/png;base64,' + b64, width: cw, height: ch };
}

async function cropRecordedRegion(dataUrl, event, metrics) {
  const resp   = await fetch(dataUrl);
  const blob   = await resp.blob();
  const bitmap = await createImageBitmap(blob);

  const scaleX = metrics?.viewportWidth  ? bitmap.width  / metrics.viewportWidth  : 1;
  const scaleY = metrics?.viewportHeight ? bitmap.height / metrics.viewportHeight : 1;

  let x;
  let y;
  let w;
  let h;

  if (
    event.targetRect &&
    event.targetRect.width > 0 &&
    event.targetRect.height > 0 &&
    event.targetRect.width <= 180 &&
    event.targetRect.height <= 120
  ) {
    const padX = Math.max(6, Math.round(event.targetRect.width * 0.12));
    const padY = Math.max(6, Math.round(event.targetRect.height * 0.18));
    x = Math.round((event.targetRect.left - padX) * scaleX);
    y = Math.round((event.targetRect.top  - padY) * scaleY);
    w = Math.round((event.targetRect.width  + padX * 2) * scaleX);
    h = Math.round((event.targetRect.height + padY * 2) * scaleY);
  } else {
    const clickW = event.targetRect
      ? clamp(Math.round(event.targetRect.width * 0.55), 56, 160)
      : 90;
    const clickH = event.targetRect
      ? clamp(Math.round(event.targetRect.height * 0.55), 32, 96)
      : 48;
    x = Math.round((event.x - clickW / 2) * scaleX);
    y = Math.round((event.y - clickH / 2) * scaleY);
    w = Math.round(clickW * scaleX);
    h = Math.round(clickH * scaleY);
  }

  x = clamp(x, 0, bitmap.width  - 1);
  y = clamp(y, 0, bitmap.height - 1);
  const maxW = Math.max(1, bitmap.width - x);
  const maxH = Math.max(1, bitmap.height - y);
  w = maxW < 24 ? maxW : clamp(w, 24, maxW);
  h = maxH < 18 ? maxH : clamp(h, 18, maxH);

  const canvas = new OffscreenCanvas(w, h);
  canvas.getContext('2d').drawImage(bitmap, x, y, w, h, 0, 0, w, h);

  const outBlob = await canvas.convertToBlob({ type: 'image/png' });
  const ab      = await outBlob.arrayBuffer();
  const b64     = arrayBufferToBase64(ab);
  return { dataUrl: 'data:image/png;base64,' + b64, width: w, height: h };
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 8192)
    bin += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(bin);
}

// ── shared utils ───────────────────────────────────────────────────────────────
async function waitForRecorderDrain(timeoutMs = 1500, quietMs = 120) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const idleFor = recLastEventAt ? Date.now() - recLastEventAt : quietMs;
    if (recPendingCount === 0 && idleFor >= quietMs) return;
    await sleep(25);
  }
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error('No active tab found');
  return tab;
}

async function injectRecorder(tabId) {
  return chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    files: ['recorder.js'],
  });
}

async function captureScreenshot(tab) {
  const dataUrl = await captureVisibleTabWithRetry(tab.windowId, { format: 'png' });
  const metrics = await capturePageMetrics(tab.id);
  return { dataUrl, metrics };
}

async function captureVisibleTabWithRetry(windowId, options, maxAttempts = 3) {
  let lastError = null;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      return await chrome.tabs.captureVisibleTab(windowId, options);
    } catch (err) {
      lastError = err;
      if (!isCaptureQuotaError(err) || attempt === maxAttempts - 1) throw err;
      await sleep(550);
    }
  }
  throw lastError;
}

function isCaptureQuotaError(err) {
  const msg = String(err?.message || err || '');
  return /MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND|quota|too many/i.test(msg);
}

async function capturePageMetrics(tabId) {
  try {
    const [{ result } = {}] = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [0] },
      func: () => ({
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        devicePixelRatio: window.devicePixelRatio || 1,
      }),
    });
    return result || null;
  } catch (_) {
    return null;
  }
}

function cdp(tabId, method, params = {}) {
  return chrome.debugger.sendCommand({ tabId }, method, params);
}
function mouseEv(tabId, type, x, y, button, clickCount) {
  return cdp(tabId, 'Input.dispatchMouseEvent', { type, x, y, button, clickCount, modifiers: 0 });
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function uid()     { return `s_${Date.now()}_${Math.random().toString(36).slice(2,7)}`; }
function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

function parseCombo(combo) {
  const MODS = { ctrl: 2, shift: 8, alt: 1, meta: 4 };
  const KEY  = {
    enter:'Enter', return:'Enter', tab:'Tab', esc:'Escape', escape:'Escape',
    backspace:'Backspace', delete:'Delete', del:'Delete', insert:'Insert',
    up:'ArrowUp', down:'ArrowDown', left:'ArrowLeft', right:'ArrowRight',
    home:'Home', end:'End', pageup:'PageUp', pagedown:'PageDown', space:' ',
    f1:'F1',f2:'F2',f3:'F3',f4:'F4',f5:'F5',f6:'F6',
    f7:'F7',f8:'F8',f9:'F9',f10:'F10',f11:'F11',f12:'F12',
  };
  const parts = combo.toLowerCase().split('+');
  let mod = 0, k = '';
  for (const p of parts) MODS[p] ? (mod |= MODS[p]) : (k = p);
  return [{ key: KEY[k] || k.toUpperCase(), modifiers: mod, windowsVirtualKeyCode: 0, nativeVirtualKeyCode: 0 }];
}
