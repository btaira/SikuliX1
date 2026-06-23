// Service worker — screenshot capture, CDP input dispatch, template storage.

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

// Track which tabs have the debugger attached.
const attached = new Map(); // tabId → true

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

// Keep service worker alive while a script is running.
let keepAliveInterval = null;
function startKeepAlive() {
  if (keepAliveInterval) return;
  keepAliveInterval = setInterval(() => chrome.runtime.getPlatformInfo(() => {}), 20_000);
}
function stopKeepAlive() {
  clearInterval(keepAliveInterval);
  keepAliveInterval = null;
}

// ── message bus ────────────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
  if (msg.type === 'keepAlive') { startKeepAlive(); respond({ ok: true }); return; }
  if (msg.type === 'stopKeepAlive') { stopKeepAlive(); respond({ ok: true }); return; }
  handle(msg).then(respond).catch(e => respond({ error: e.message }));
  return true; // async
});

async function handle(msg) {
  const tab = await activeTab();
  const { id: tabId, windowId } = tab;

  switch (msg.type) {

    case 'screenshot': {
      const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
      return { dataUrl };
    }

    case 'click': {
      await attachDebugger(tabId);
      const btn = msg.button || 'left';
      const count = msg.clickCount || 1;
      await mouseEvent(tabId, 'mousePressed', msg.x, msg.y, btn, count);
      await sleep(30);
      await mouseEvent(tabId, 'mouseReleased', msg.x, msg.y, btn, count);
      if (count === 2) {
        await sleep(30);
        await mouseEvent(tabId, 'mousePressed', msg.x, msg.y, btn, 2);
        await sleep(30);
        await mouseEvent(tabId, 'mouseReleased', msg.x, msg.y, btn, 2);
      }
      return { ok: true };
    }

    case 'move': {
      await attachDebugger(tabId);
      await mouseEvent(tabId, 'mouseMoved', msg.x, msg.y, 'none', 0);
      return { ok: true };
    }

    case 'scroll': {
      await attachDebugger(tabId);
      await cdp(tabId, 'Input.dispatchMouseEvent', {
        type: 'mouseWheel',
        x: msg.x ?? 640, y: msg.y ?? 400,
        deltaX: msg.deltaX ?? 0, deltaY: msg.deltaY ?? 0,
      });
      return { ok: true };
    }

    case 'type': {
      await attachDebugger(tabId);
      await cdp(tabId, 'Input.insertText', { text: msg.text });
      return { ok: true };
    }

    case 'key': {
      await attachDebugger(tabId);
      const events = buildKeyEvents(msg.combo);
      for (const ev of events)
        await cdp(tabId, 'Input.dispatchKeyEvent', { type: 'keyDown', ...ev });
      await sleep(20);
      for (const ev of [...events].reverse())
        await cdp(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', ...ev });
      return { ok: true };
    }

    case 'focus': {
      await chrome.scripting.executeScript({
        target: { tabId },
        func: (x, y) => {
          const el = document.elementFromPoint(x, y);
          if (el) el.focus();
        },
        args: [msg.x, msg.y],
      });
      return { ok: true };
    }

    case 'detachAll': {
      await detachDebugger(tabId);
      return { ok: true };
    }

    // ── capture tab workflow ────────────────────────────────────────────────
    case 'openCapture': {
      const screenshot = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
      const url = chrome.runtime.getURL('capture.html')
        + '?name=' + encodeURIComponent(msg.name)
        + '&src=' + encodeURIComponent(screenshot);
      const ct = await chrome.tabs.create({ url, active: true });
      return { captureTabId: ct.id };
    }

    // ── template CRUD ──────────────────────────────────────────────────────
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

    case 'saveScript': {
      await chrome.storage.local.set({ savedScript: msg.code });
      return { ok: true };
    }

    case 'loadScript': {
      const { savedScript = '' } = await chrome.storage.local.get('savedScript');
      return { code: savedScript };
    }

    default:
      throw new Error('Unknown message: ' + msg.type);
  }
}

// ── helpers ────────────────────────────────────────────────────────────────────
async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error('No active tab found.');
  return tab;
}

function cdp(tabId, method, params = {}) {
  return chrome.debugger.sendCommand({ tabId }, method, params);
}

function mouseEvent(tabId, type, x, y, button, clickCount) {
  return cdp(tabId, 'Input.dispatchMouseEvent', { type, x, y, button, clickCount, modifiers: 0 });
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// Parse key combos like "ctrl+shift+a", "enter", "f5", "escape"
function buildKeyEvents(combo) {
  const MODIFIERS = { ctrl: 2, shift: 8, alt: 1, meta: 4 };
  const KEY_MAP = {
    enter: 'Enter', return: 'Enter', tab: 'Tab', esc: 'Escape', escape: 'Escape',
    backspace: 'Backspace', delete: 'Delete', del: 'Delete', insert: 'Insert',
    up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight',
    home: 'Home', end: 'End', pageup: 'PageUp', pagedown: 'PageDown',
    space: ' ', f1:'F1',f2:'F2',f3:'F3',f4:'F4',f5:'F5',f6:'F6',
    f7:'F7',f8:'F8',f9:'F9',f10:'F10',f11:'F11',f12:'F12',
  };

  const parts = combo.toLowerCase().split('+');
  let modifiers = 0;
  let keyName = '';
  for (const p of parts) {
    if (MODIFIERS[p] !== undefined) modifiers |= MODIFIERS[p];
    else keyName = p;
  }

  const key = KEY_MAP[keyName] || keyName.toUpperCase();
  return [{ key, modifiers, windowsVirtualKeyCode: 0, nativeVirtualKeyCode: 0 }];
}
