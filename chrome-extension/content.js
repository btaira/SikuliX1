// Content script — lightweight responder for focus and ping checks.
chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
  if (msg.type === 'ping') { respond({ ok: true }); return; }
  if (msg.type === 'focus') {
    const el = document.elementFromPoint(msg.x, msg.y);
    if (el && typeof el.focus === 'function') el.focus();
    respond({ ok: true });
  }
});
