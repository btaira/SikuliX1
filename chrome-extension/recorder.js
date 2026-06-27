// recorder.js — injected into the active tab during recording.
// Captures user clicks and keyboard input, sends events to background.
(function () {
  if (window.__sikulixRecorder) return; // idempotent
  window.__sikulixRecorder = true;

  let keyBuffer = '';
  let keyTimer  = null;

  function flushKeys() {
    clearTimeout(keyTimer);
    if (keyBuffer) {
      chrome.runtime.sendMessage({ type: 'recEvent', event: { kind: 'type', text: keyBuffer } });
      keyBuffer = '';
    }
  }

  function onClick(e) {
    flushKeys();
    chrome.runtime.sendMessage({
      type: 'recEvent',
      event: { kind: 'click', x: e.clientX, y: e.clientY, button: e.button === 2 ? 'right' : 'left' }
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
    chrome.runtime.sendMessage({ type: 'recEvent', event: { kind: 'key', combo: mods.join('+') } });
  }

  function onScroll() {
    flushKeys();
    // Debounce scroll events
    clearTimeout(window.__sikulixScrollTimer);
    window.__sikulixScrollTimer = setTimeout(() => {
      chrome.runtime.sendMessage({ type: 'recEvent', event: { kind: 'scroll', direction: 'down', amount: 300 } });
    }, 400);
  }

  document.addEventListener('click',   onClick,   true);
  document.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('scroll',    onScroll,  { passive: true });

  // Cleanup when background tells us to stop
  chrome.runtime.onMessage.addListener(function handler(msg) {
    if (msg.type === 'stopRecorder') {
      flushKeys();
      document.removeEventListener('click',   onClick,   true);
      document.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('scroll',    onScroll);
      chrome.runtime.onMessage.removeListener(handler);
      window.__sikulixRecorder = false;
    }
  });
})();
