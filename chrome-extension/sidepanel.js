// Side-panel logic: tab switching, template management, script runner.
'use strict';

// ── state ──────────────────────────────────────────────────────────────────────
let templates = {};   // { name → { dataUrl, width, height } }
let runnerAbort = null; // AbortController for stopping scripts
let threshold = 0.80;

// ── DOM refs ───────────────────────────────────────────────────────────────────
const $editor     = document.getElementById('editor');
const $console    = document.getElementById('console');
const $btnRun     = document.getElementById('btn-run');
const $btnStop    = document.getElementById('btn-stop');
const $btnSave    = document.getElementById('btn-save');
const $btnClear   = document.getElementById('btn-clear');
const $tplList    = document.getElementById('tpl-list');
const $tplName    = document.getElementById('tpl-name');
const $btnCapture = document.getElementById('btn-capture');
const $threshold  = document.getElementById('threshold');
const $threshVal  = document.getElementById('threshold-val');
const $tplCount   = document.getElementById('tpl-count');

// ── helpers ────────────────────────────────────────────────────────────────────
function send(msg) {
  return new Promise((res, rej) => {
    chrome.runtime.sendMessage(msg, (r) => {
      if (chrome.runtime.lastError) return rej(new Error(chrome.runtime.lastError.message));
      if (r && r.error) return rej(new Error(r.error));
      res(r);
    });
  });
}

function logLine(text, cls = 'log-info') {
  const line = document.createElement('div');
  line.className = cls;
  line.textContent = `[${new Date().toLocaleTimeString()}] ${text}`;
  $console.appendChild(line);
  $console.scrollTop = $console.scrollHeight;
}

// ── threshold ──────────────────────────────────────────────────────────────────
$threshold.addEventListener('input', () => {
  threshold = parseFloat($threshold.value);
  $threshVal.textContent = threshold.toFixed(2);
});

// ── tab switching ──────────────────────────────────────────────────────────────
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    const panel = tab.dataset.panel;
    document.getElementById('editor-panel').style.display     = panel === 'editor'    ? 'flex' : 'none';
    document.getElementById('templates-panel').style.display  = panel === 'templates' ? 'flex' : 'none';
  });
});

// ── template rendering ─────────────────────────────────────────────────────────
function renderTemplates() {
  $tplList.innerHTML = '';
  $tplCount.textContent = Object.keys(templates).length;
  for (const [name, tpl] of Object.entries(templates)) {
    const item = document.createElement('div');
    item.className = 'tpl-item';
    item.innerHTML = `
      <img class="tpl-thumb" src="${tpl.dataUrl}" alt="${name}">
      <span class="tpl-name" title="${name}">${name}</span>
      <button class="tpl-insert" data-name="${name}">Insert</button>
      <button class="tpl-delete" data-name="${name}">✕</button>
    `;
    item.querySelector('.tpl-insert').addEventListener('click', () => {
      const cursor = $editor.selectionStart;
      const text = `'${name}'`;
      $editor.value = $editor.value.slice(0, cursor) + text + $editor.value.slice($editor.selectionEnd);
      $editor.selectionStart = $editor.selectionEnd = cursor + text.length;
      $editor.focus();
      // switch to editor tab
      document.querySelector('.tab[data-panel="editor"]').click();
    });
    item.querySelector('.tpl-delete').addEventListener('click', async () => {
      if (!confirm(`Delete template "${name}"?`)) return;
      await send({ type: 'deleteTemplate', name });
      delete templates[name];
      renderTemplates();
      logLine(`Deleted template: ${name}`, 'log-warn');
    });
    $tplList.appendChild(item);
  }
}

async function loadTemplates() {
  const { templates: t } = await send({ type: 'getTemplates' });
  templates = t || {};
  renderTemplates();
}

// ── capture ────────────────────────────────────────────────────────────────────
$btnCapture.addEventListener('click', async () => {
  const name = $tplName.value.trim();
  if (!name) { alert('Enter a template name first.'); return; }
  logLine(`Capturing region for "${name}"…`);
  try {
    await send({ type: 'openCapture', name });
    // Capture page will message back when done
  } catch (e) {
    logLine('Capture error: ' + e.message, 'log-error');
  }
});

// Listen for template saved from capture tab
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'templateSaved') {
    templates[msg.name] = { dataUrl: msg.dataUrl, width: msg.width, height: msg.height };
    renderTemplates();
    logLine(`Template saved: "${msg.name}" (${msg.width}×${msg.height}px)`, 'log-ok');
  }
});

// ── save / load script ─────────────────────────────────────────────────────────
$btnSave.addEventListener('click', async () => {
  await send({ type: 'saveScript', code: $editor.value });
  logLine('Script saved.', 'log-ok');
});

async function loadSavedScript() {
  const { code } = await send({ type: 'loadScript' });
  if (code) $editor.value = code;
}

// ── script runner ──────────────────────────────────────────────────────────────
$btnRun.addEventListener('click', () => runScript());
$btnStop.addEventListener('click', () => {
  if (runnerAbort) { runnerAbort.abort(); runnerAbort = null; }
});
$btnClear.addEventListener('click', () => { $console.innerHTML = ''; });

async function runScript() {
  if (runnerAbort) return; // already running

  const code = $editor.value.trim();
  if (!code) return;

  runnerAbort = new AbortController();
  const signal = runnerAbort.signal;

  $btnRun.style.display  = 'none';
  $btnStop.style.display = 'inline-block';
  logLine('▶ Running…', 'log-ok');

  // Tell background to keep service worker alive
  await send({ type: 'keepAlive' });

  const api = createAPI(
    (msg) => logLine(msg),
    (id)  => templates[id],
    ()    => threshold,
  );

  // Wrap each API function to check abort signal
  const wrapped = {};
  for (const [k, fn] of Object.entries(api)) {
    wrapped[k] = async (...args) => {
      if (signal.aborted) throw new Error('Script stopped by user.');
      return fn(...args);
    };
  }

  try {
    const fn = new Function(
      'find','exists','findAll','wait','waitVanish',
      'click','rightClick','doubleClick','hover','dragDrop',
      'scroll','type','key','pause','log','screenshot',
      `"use strict"; return (async () => { ${code} })();`
    );
    await fn(
      wrapped.find, wrapped.exists, wrapped.findAll, wrapped.wait, wrapped.waitVanish,
      wrapped.click, wrapped.rightClick, wrapped.doubleClick, wrapped.hover, wrapped.dragDrop,
      wrapped.scroll, wrapped.type, wrapped.key, wrapped.pause, wrapped.log, wrapped.screenshot,
    );
    if (!signal.aborted) logLine('✔ Done.', 'log-ok');
  } catch (e) {
    if (!signal.aborted) logLine('✖ ' + e.message, 'log-error');
    else logLine('■ Stopped.', 'log-warn');
  } finally {
    runnerAbort = null;
    $btnRun.style.display  = 'inline-block';
    $btnStop.style.display = 'none';
    await send({ type: 'stopKeepAlive' });
    // Detach debugger when script finishes
    await send({ type: 'detachAll' }).catch(() => {});
  }
}

// Keyboard shortcut: Ctrl+Enter to run, Ctrl+S to save
$editor.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); runScript(); }
  if ((e.ctrlKey || e.metaKey) && e.key === 's')     { e.preventDefault(); $btnSave.click(); }
  // Insert 2-space tab
  if (e.key === 'Tab') {
    e.preventDefault();
    const s = $editor.selectionStart;
    $editor.value = $editor.value.slice(0, s) + '  ' + $editor.value.slice($editor.selectionEnd);
    $editor.selectionStart = $editor.selectionEnd = s + 2;
  }
});

// ── boot ───────────────────────────────────────────────────────────────────────
(async () => {
  await loadTemplates();
  await loadSavedScript();
  logLine('SikuliX for Chrome ready. Ctrl+Enter to run.', 'log-info');
})();
