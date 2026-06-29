// recorder.js — injected into the active tab during recording.
// Captures user clicks and keyboard input, sends events to background.
(function () {
  if (window.__sikulixRecorder) return; // idempotent
  window.__sikulixRecorder = true;

  let keyBuffer = '';
  let keyTimer  = null;
  let sendChain = Promise.resolve();

  function queueEvent(event) {
    sendChain = sendChain
      .catch(() => {})
      .then(() => new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: 'recEvent', event }, () => {
          void chrome.runtime.lastError;
          resolve();
        });
      }));
    return sendChain;
  }

  function getViewportOffset() {
    let left = 0;
    let top = 0;
    try {
      let win = window;
      while (win !== win.top && win.frameElement) {
        const r = win.frameElement.getBoundingClientRect();
        left += r.left;
        top += r.top;
        win = win.parent;
      }
    } catch (_) {}
    return { left, top };
  }

  function flushKeys() {
    clearTimeout(keyTimer);
    if (keyBuffer) {
      queueEvent({ kind: 'type', text: keyBuffer });
      keyBuffer = '';
    }
  }

  function getTargetRect(target) {
    if (!target || typeof target.getBoundingClientRect !== 'function') return null;
    const r = target.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    const offset = getViewportOffset();
    return {
      left: r.left + offset.left,
      top: r.top + offset.top,
      width: r.width,
      height: r.height,
    };
  }

  function onPointerDown(e) {
    if (e.button !== 0 && e.button !== 2) return;
    const offset = getViewportOffset();
    flushKeys();
    queueEvent({
      kind: 'click',
      x: e.clientX + offset.left,
      y: e.clientY + offset.top,
      button: e.button === 2 ? 'right' : 'left',
      targetRect: getTargetRect(e.target),
    });
  }

  function onKeyDown(e) {
    // Let printable chars accumulate
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) {
      keyBuffer += e.key;
      clearTimeout(keyTimer);
      keyTimer = setTimeout(flushKeys, 800);
      return;
    }
    // Special key or combo
    flushKeys();
    const mods = [];
    if (e.ctrlKey)  mods.push('ctrl');
    if (e.shiftKey) mods.push('shift');
    if (e.altKey)   mods.push('alt');
    if (e.metaKey)  mods.push('meta');
    const base = e.key.toLowerCase();
    if (['control','shift','alt','meta'].includes(base)) return; // bare modifier
    mods.push(base);
    queueEvent({ kind: 'key', combo: mods.join('+') });
  }

  function onScroll() {
    flushKeys();
    // Debounce scroll events
    clearTimeout(window.__sikulixScrollTimer);
    window.__sikulixScrollTimer = setTimeout(() => {
      queueEvent({ kind: 'scroll', direction: 'down', amount: 300 });
    }, 400);
  }

  document.addEventListener('pointerdown', onPointerDown, true);
  document.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('scroll',    onScroll,  { passive: true });

  // Cleanup when background tells us to stop
  chrome.runtime.onMessage.addListener(function handler(msg) {
    if (msg.type === 'stopRecorder') {
      flushKeys();
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('scroll',    onScroll);
      chrome.runtime.onMessage.removeListener(handler);
      window.__sikulixRecorder = false;
    }
  });
})();
