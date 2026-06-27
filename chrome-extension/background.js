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
let recTabId     = null;
let recStepCount = 0;

// ── message bus ────────────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  if (msg.type === 'keepAlive')     { startKeepAlive(); respond({ ok: true }); return; }
  if (msg.type === 'stopKeepAlive') { stopKeepAlive();  respond({ ok: true }); return; }

  // Recording events from recorder.js (content script)
  if (msg.type === 'recEvent') {
    if (!recording) return;
    handleRecEvent(msg.event, sender.tab?.id ?? recTabId)
      .then(step => step && pushRecStep(step))
      .catch(console.error);
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
      const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
      return { dataUrl };
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
      recTabId     = tabId;
      recStepCount = 0;
      startKeepAlive(); // keep SW alive so `recording` flag survives user interactions
      await chrome.storage.local.set({ recSteps: [], isRecording: true });
      await chrome.scripting.executeScript({ target: { tabId }, files: ['recorder.js'] });
      return { ok: true };
    }
    case 'stopRecording': {
      recording = false;
      stopKeepAlive();
      await chrome.storage.local.set({ isRecording: false });
      chrome.tabs.sendMessage(tabId, { type: 'stopRecorder' }).catch(() => {});
      const { recSteps = [] } = await chrome.storage.local.get('recSteps');
      await chrome.storage.local.remove('recSteps');
      return { steps: recSteps };
    }

    // ── capture tab ───────────────────────────────────────────────────────────
    case 'openCapture': {
      const ss  = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
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

async function handleRecEvent(event, tabId) {
  switch (event.kind) {
    case 'click': {
      // Take screenshot and auto-crop a template around the click point
      const tab      = await activeTab();
      const dataUrl  = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
      const name     = `rec_${++recStepCount}`;
      const cropped  = await cropRegion(dataUrl, event.x, event.y, 140, 70);
      const { templates = {} } = await chrome.storage.local.get('templates');
      templates[name] = cropped;
      await chrome.storage.local.set({ templates });
      return { id: uid(), type: event.button === 'right' ? 'rightClick' : 'click', image: name };
    }
    case 'type':   return { id: uid(), type: 'type',   text:      event.text  };
    case 'key':    return { id: uid(), type: 'key',    combo:     event.combo };
    case 'scroll': return { id: uid(), type: 'scroll', direction: event.direction, amount: event.amount };
    default:       return null;
  }
}

async function pushRecStep(step) {
  const { recSteps = [] } = await chrome.storage.local.get('recSteps');
  recSteps.push(step);
  await chrome.storage.local.set({ recSteps });
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

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 8192)
    bin += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(bin);
}

// ── shared utils ───────────────────────────────────────────────────────────────
async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error('No active tab found');
  return tab;
}
function cdp(tabId, method, params = {}) {
  return chrome.debugger.sendCommand({ tabId }, method, params);
}
function mouseEv(tabId, type, x, y, button, clickCount) {
  return cdp(tabId, 'Input.dispatchMouseEvent', { type, x, y, button, clickCount, modifiers: 0 });
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function uid()     { return `s_${Date.now()}_${Math.random().toString(36).slice(2,7)}`; }

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
