// Side-panel IDE: workflow editor, code editor, template gallery, recorder.
'use strict';

// ── state ──────────────────────────────────────────────────────────────────────
let templates  = {};   // { name → {dataUrl, width, height} }
let steps      = [];   // workflow steps
let threshold  = 0.80;
let running    = false;
let abortCtl   = null;
let recording  = false;
let recPollTimer = null;
let activePanel  = 'workflow';
let dragSrcIdx   = -1;

// ── DOM ────────────────────────────────────────────────────────────────────────
const $stepList      = document.getElementById('step-list');
const $stepEmpty     = document.getElementById('step-empty');
const $stepCount     = document.getElementById('step-count');
const $editor        = document.getElementById('editor');
const $console       = document.getElementById('console-out');
const $btnRun        = document.getElementById('btn-run');
const $btnStop       = document.getElementById('btn-stop');
const $btnRecord     = document.getElementById('btn-record');
const $btnExport     = document.getElementById('btn-export-code');
const $btnClear      = document.getElementById('btn-clear-workflow');
const $btnSave       = document.getElementById('btn-save');
const $btnClearCons  = document.getElementById('btn-clear-console');
const $btnCapture    = document.getElementById('btn-capture');
const $tplNameInp    = document.getElementById('tpl-name-inp');
const $tplList       = document.getElementById('tpl-list');
const $threshold     = document.getElementById('threshold');
const $threshVal     = document.getElementById('threshold-val');
const $tplCountCode  = document.getElementById('tpl-count-code');

// ── messaging ──────────────────────────────────────────────────────────────────
function send(msg) {
  return new Promise((res, rej) => {
    chrome.runtime.sendMessage(msg, (r) => {
      if (chrome.runtime.lastError) return rej(new Error(chrome.runtime.lastError.message));
      if (r?.error) return rej(new Error(r.error));
      res(r);
    });
  });
}

// ── console ────────────────────────────────────────────────────────────────────
function clog(text, cls = 'c-info') {
  const t = document.createElement('div');
  t.className = cls;
  t.textContent = `[${new Date().toLocaleTimeString()}] ${text}`;
  $console.appendChild(t);
  $console.scrollTop = $console.scrollHeight;
}
$btnClearCons.addEventListener('click', () => { $console.innerHTML = ''; });

// ── tabs ───────────────────────────────────────────────────────────────────────
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    activePanel = tab.dataset.panel;
    document.getElementById('workflow-panel').style.display  = activePanel === 'workflow'  ? 'flex' : 'none';
    document.getElementById('code-panel').style.display      = activePanel === 'code'      ? 'flex' : 'none';
    document.getElementById('templates-panel').style.display = activePanel === 'templates' ? 'flex' : 'none';
  });
});

// ── threshold ──────────────────────────────────────────────────────────────────
$threshold.addEventListener('input', () => {
  threshold = parseFloat($threshold.value);
  $threshVal.textContent = threshold.toFixed(2);
});

// ══════════════════════════════════════════════════════════════════════════════
// STEP DEFINITIONS
// ══════════════════════════════════════════════════════════════════════════════
const STEP_META = {
  click:       { icon: '🖱️', label: 'Click',          hasImage: true  },
  rightClick:  { icon: '🖱️', label: 'Right Click',    hasImage: true  },
  doubleClick: { icon: '🖱️', label: 'Double Click',   hasImage: true  },
  find:        { icon: '🔍', label: 'Find',            hasImage: true  },
  wait:        { icon: '⏳', label: 'Wait for',        hasImage: true  },
  waitVanish:  { icon: '👻', label: 'Wait Vanish',     hasImage: true  },
  type:        { icon: '⌨️', label: 'Type',            hasImage: false },
  key:         { icon: '⌨️', label: 'Key',             hasImage: false },
  scroll:      { icon: '↕️', label: 'Scroll',          hasImage: false },
  pause:       { icon: '⏸️', label: 'Pause',           hasImage: false },
};

function makeStep(type) {
  const defaults = {
    click:       { image: '', button: 'left' },
    rightClick:  { image: '' },
    doubleClick: { image: '' },
    find:        { image: '', varName: '' },
    wait:        { image: '', timeout: 10000 },
    waitVanish:  { image: '', timeout: 10000 },
    type:        { text: '' },
    key:         { combo: '' },
    scroll:      { direction: 'down', amount: 300 },
    pause:       { ms: 1000 },
  };
  return { id: uid(), type, ...defaults[type] };
}

// ══════════════════════════════════════════════════════════════════════════════
// WORKFLOW RENDERING  — the SikuliX-style visual blocks
// ══════════════════════════════════════════════════════════════════════════════
function renderWorkflow() {
  // Remove all cards (keep #step-empty)
  [...$stepList.querySelectorAll('.step-card')].forEach(el => el.remove());

  $stepEmpty.style.display = steps.length ? 'none' : 'block';
  $stepCount.textContent   = `${steps.length} step${steps.length !== 1 ? 's' : ''}`;

  steps.forEach((step, idx) => {
    const card = buildCard(step, idx);
    $stepList.appendChild(card);
  });
}

function buildCard(step, idx) {
  const meta   = STEP_META[step.type] || { icon: '?', label: step.type, hasImage: false };
  const card   = document.createElement('div');
  card.className  = 'step-card';
  card.dataset.id = step.id;
  card.draggable  = true;

  // ── drag handle ─────────────────────────────────────────────────────────
  const handle = el('div', 'step-handle', '⠿');
  const num    = el('div', 'step-num', idx + 1);

  // ── icon ─────────────────────────────────────────────────────────────────
  const icon = el('div', 'step-icon', meta.icon);

  // ── body ─────────────────────────────────────────────────────────────────
  const body  = el('div', 'step-body');
  const label = el('div', 'step-label', meta.label);
  body.appendChild(label);

  if (meta.hasImage) {
    const row   = el('div', 'step-row');
    const thumb = buildThumb(step);
    const inp   = buildInput(step, 'image', 'template name…', 'step-input');

    // live-update the thumbnail when name changes
    inp.addEventListener('input', () => {
      step.image = inp.value;
      updateThumb(thumb, step.image);
    });

    // capture button inline
    const capBtn = el('button', 'add-step-btn', '📷');
    capBtn.title = 'Capture new template';
    capBtn.style.cssText = 'font-size:12px;padding:2px 6px;flex-shrink:0';
    capBtn.addEventListener('click', async () => {
      const name = inp.value.trim() || `tpl_${Date.now()}`;
      inp.value = name; step.image = name;
      await send({ type: 'openCapture', name });
    });

    row.append(thumb, inp, capBtn);

    // type-specific extra fields
    if (step.type === 'wait' || step.type === 'waitVanish') {
      const timeout = buildInput(step, 'timeout', 'ms', 'step-input step-input-sm');
      timeout.type = 'number';
      row.appendChild(timeout);
      row.appendChild(el('span', 'step-badge', 'ms'));
    }
    if (step.type === 'find') {
      const v = buildInput(step, 'varName', 'var (optional)', 'step-input step-input-sm');
      row.appendChild(v);
    }

    body.appendChild(row);

  } else if (step.type === 'type') {
    const row = el('div', 'step-row');
    const inp = buildInput(step, 'text', 'text to type…', 'step-input');
    row.appendChild(inp);
    body.appendChild(row);

  } else if (step.type === 'key') {
    const row = el('div', 'step-row');
    const inp = buildInput(step, 'combo', 'e.g. ctrl+a, enter…', 'step-input');
    row.appendChild(inp);
    body.appendChild(row);

  } else if (step.type === 'scroll') {
    const row = el('div', 'step-row');
    const sel = document.createElement('select');
    sel.className = 'step-select';
    ['up','down','left','right'].forEach(d => {
      const o = document.createElement('option');
      o.value = d; o.textContent = d;
      if (d === step.direction) o.selected = true;
      sel.appendChild(o);
    });
    sel.addEventListener('change', () => step.direction = sel.value);
    const amt = buildInput(step, 'amount', '300', 'step-input step-input-sm');
    amt.type = 'number';
    row.append(sel, amt, el('span', 'step-badge', 'px'));
    body.appendChild(row);

  } else if (step.type === 'pause') {
    const row = el('div', 'step-row');
    const inp = buildInput(step, 'ms', '1000', 'step-input step-input-sm');
    inp.type = 'number';
    row.append(inp, el('span', 'step-badge', 'ms'));
    body.appendChild(row);
  }

  // ── delete button ────────────────────────────────────────────────────────
  const del = el('button', 'step-delete', '✕');
  del.addEventListener('click', () => {
    steps.splice(idx, 1);
    renderWorkflow();
    saveWorkflow();
  });

  card.append(handle, num, icon, body, del);

  // ── drag-and-drop ────────────────────────────────────────────────────────
  card.addEventListener('dragstart', (e) => {
    dragSrcIdx = idx;
    e.dataTransfer.effectAllowed = 'move';
    card.style.opacity = '.4';
  });
  card.addEventListener('dragend', () => { card.style.opacity = ''; });
  card.addEventListener('dragover', (e) => { e.preventDefault(); card.classList.add('drag-over'); });
  card.addEventListener('dragleave', () => card.classList.remove('drag-over'));
  card.addEventListener('drop', (e) => {
    e.preventDefault();
    card.classList.remove('drag-over');
    if (dragSrcIdx === idx) return;
    const [moved] = steps.splice(dragSrcIdx, 1);
    steps.splice(idx, 0, moved);
    renderWorkflow();
    saveWorkflow();
  });

  return card;
}

function buildThumb(step) {
  const tpl = templates[step.image];
  if (tpl) {
    const img = document.createElement('img');
    img.className = 'step-thumb';
    img.src = tpl.dataUrl;
    img.title = step.image;
    return img;
  }
  const ph = el('div', 'step-thumb-empty', '📷');
  ph.title = 'No template — type a name or click 📷 to capture';
  return ph;
}

function updateThumb(el, name) {
  const tpl = templates[name];
  if (tpl && el.tagName !== 'IMG') {
    const img = document.createElement('img');
    img.className = 'step-thumb'; img.src = tpl.dataUrl; img.title = name;
    el.replaceWith(img);
  } else if (!tpl && el.tagName === 'IMG') {
    const ph = document.createElement('div');
    ph.className = 'step-thumb-empty'; ph.textContent = '📷';
    el.replaceWith(ph);
  } else if (tpl && el.tagName === 'IMG') {
    el.src = tpl.dataUrl; el.title = name;
  }
}

function buildInput(step, field, placeholder, cls) {
  const inp = document.createElement('input');
  inp.className   = cls;
  inp.placeholder = placeholder;
  inp.value       = step[field] ?? '';
  inp.addEventListener('change', () => step[field] = inp.type === 'number' ? Number(inp.value) : inp.value);
  return inp;
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls)  e.className   = cls;
  if (text) e.textContent = text;
  return e;
}

// ── add step buttons ───────────────────────────────────────────────────────────
document.querySelectorAll('.add-step-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const type = btn.dataset.type;
    if (!type) return;
    steps.push(makeStep(type));
    renderWorkflow();
    saveWorkflow();
    $stepList.scrollTop = $stepList.scrollHeight;
  });
});

// ── clear / export ─────────────────────────────────────────────────────────────
$btnClear.addEventListener('click', () => {
  if (!steps.length || confirm('Clear all workflow steps?')) {
    steps = []; renderWorkflow(); saveWorkflow();
  }
});

$btnExport.addEventListener('click', () => {
  const code = generateCode(steps);
  $editor.value = code;
  // Switch to code tab
  document.querySelector('.tab[data-panel="code"]').click();
  clog('Workflow exported to Code tab.', 'c-ok');
});

// ── code generation ────────────────────────────────────────────────────────────
function generateCode(stepList) {
  const lines = stepList.map(s => {
    switch (s.type) {
      case 'click':       return `await click('${s.image}');`;
      case 'rightClick':  return `await rightClick('${s.image}');`;
      case 'doubleClick': return `await doubleClick('${s.image}');`;
      case 'find':        return s.varName
        ? `const ${s.varName} = await find('${s.image}');`
        : `await find('${s.image}');`;
      case 'wait':        return `await wait('${s.image}', ${s.timeout ?? 10000});`;
      case 'waitVanish':  return `await waitVanish('${s.image}', ${s.timeout ?? 10000});`;
      case 'type':        return `await type(${JSON.stringify(s.text ?? '')});`;
      case 'key':         return `await key('${s.combo ?? ''}');`;
      case 'scroll':      return `await scroll('${s.direction ?? 'down'}', ${s.amount ?? 300});`;
      case 'pause':       return `await pause(${s.ms ?? 1000});`;
      default:            return `// unknown: ${s.type}`;
    }
  });
  return lines.join('\n');
}

// ══════════════════════════════════════════════════════════════════════════════
// RECORDER
// ══════════════════════════════════════════════════════════════════════════════
$btnRecord.addEventListener('click', async () => {
  if (!recording) {
    recording = true;
    $btnRecord.textContent = '⏹ Stop Recording';
    $btnRecord.classList.add('active');
    clog('Recording started — interact with the page.', 'c-warn');
    try {
      await send({ type: 'startRecording' });
    } catch (e) {
      clog('Recording error: ' + e.message, 'c-error');
      stopRecording(); return;
    }
    // Poll storage for new recorded steps
    recPollTimer = setInterval(pollRecSteps, 600);
  } else {
    stopRecording();
  }
});

async function stopRecording() {
  clearInterval(recPollTimer);
  recording = false;
  $btnRecord.textContent = '⏺ Record';
  $btnRecord.classList.remove('active');
  try {
    const { steps: recSteps } = await send({ type: 'stopRecording' });
    if (recSteps?.length) {
      steps.push(...recSteps);
      await loadTemplates();   // refresh thumbnails for auto-captured templates
      renderWorkflow();
      saveWorkflow();
      clog(`Recording stopped — ${recSteps.length} step(s) captured.`, 'c-ok');
      // Switch to workflow tab to show result
      document.querySelector('.tab[data-panel="workflow"]').click();
    } else {
      clog('Recording stopped — no steps captured.', 'c-warn');
    }
  } catch (e) {
    clog('Stop recording error: ' + e.message, 'c-error');
  }
}

async function pollRecSteps() {
  // Peek at recSteps queue; background drains it on stopRecording
  const { recSteps = [] } = await chrome.storage.local.get('recSteps');
  if (recSteps.length) {
    clog(`Recorded ${recSteps.length} step(s) so far…`, 'c-warn');
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// RUN WORKFLOW
// ══════════════════════════════════════════════════════════════════════════════
$btnRun.addEventListener('click', () => {
  if (activePanel === 'code') runCode();
  else runWorkflow();
});
$btnStop.addEventListener('click', () => { abortCtl?.abort(); });

async function runWorkflow() {
  if (running || !steps.length) return;
  setRunState(true);
  clog(`▶ Running workflow (${steps.length} steps)…`, 'c-ok');
  await send({ type: 'keepAlive' });

  const api = buildAPI();

  for (let i = 0; i < steps.length; i++) {
    if (abortCtl?.signal.aborted) break;
    const step = steps[i];

    // Highlight current card
    const cards = $stepList.querySelectorAll('.step-card');
    cards.forEach((c, ci) => c.classList.toggle('running', ci === i));

    const meta = STEP_META[step.type] || {};
    clog(`Step ${i + 1}: ${meta.label} ${step.image || step.text || step.combo || ''}`, 'c-step');

    try {
      await execStep(step, api);
    } catch (e) {
      if (abortCtl?.signal.aborted) break;
      clog(`✖ Step ${i + 1} failed: ${e.message}`, 'c-error');
      // Highlight as failed
      cards[i]?.classList.replace('running', 'failed');
      break;
    }
  }

  $stepList.querySelectorAll('.step-card').forEach(c => c.classList.remove('running'));
  if (!abortCtl?.signal.aborted) clog('✔ Workflow complete.', 'c-ok');
  else clog('■ Stopped.', 'c-warn');
  setRunState(false);
  await send({ type: 'stopKeepAlive' });
  await send({ type: 'detachAll' }).catch(() => {});
}

async function execStep(step, api) {
  switch (step.type) {
    case 'click':       return api.click(step.image);
    case 'rightClick':  return api.rightClick(step.image);
    case 'doubleClick': return api.doubleClick(step.image);
    case 'find':        return api.find(step.image);
    case 'wait':        return api.wait(step.image, step.timeout);
    case 'waitVanish':  return api.waitVanish(step.image, step.timeout);
    case 'type':        return api.type(step.text || '');
    case 'key':         return api.key(step.combo || '');
    case 'scroll':      return api.scroll(step.direction, step.amount);
    case 'pause':       return api.pause(step.ms || 1000);
    default: throw new Error('Unknown step type: ' + step.type);
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// RUN CODE (from Code tab)
// ══════════════════════════════════════════════════════════════════════════════
async function runCode() {
  if (running) return;
  const code = $editor.value.trim();
  if (!code) return;
  setRunState(true);
  clog('▶ Running code…', 'c-ok');
  await send({ type: 'keepAlive' });

  const api = buildAPI();
  const sig = abortCtl.signal;

  const wrapped = {};
  for (const [k, fn] of Object.entries(api)) {
    wrapped[k] = (...args) => {
      if (sig.aborted) throw new Error('Stopped by user.');
      return fn(...args);
    };
  }

  try {
    const fn = new Function(
      'find','exists','findAll','wait','waitVanish',
      'click','rightClick','doubleClick','hover','dragDrop',
      'scroll','type','key','pause','log','screenshot',
      `"use strict"; return (async()=>{ ${code} })();`
    );
    await fn(
      wrapped.find, wrapped.exists, wrapped.findAll, wrapped.wait, wrapped.waitVanish,
      wrapped.click, wrapped.rightClick, wrapped.doubleClick, wrapped.hover, wrapped.dragDrop,
      wrapped.scroll, wrapped.type, wrapped.key, wrapped.pause, wrapped.log, wrapped.screenshot,
    );
    if (!sig.aborted) clog('✔ Done.', 'c-ok');
    else              clog('■ Stopped.', 'c-warn');
  } catch (e) {
    clog(`✖ ${e.message}`, 'c-error');
  } finally {
    setRunState(false);
    await send({ type: 'stopKeepAlive' });
    await send({ type: 'detachAll' }).catch(() => {});
  }
}

function setRunState(on) {
  running         = on;
  abortCtl        = on ? new AbortController() : null;
  $btnRun.style.display  = on ? 'none'         : 'inline-block';
  $btnStop.style.display = on ? 'inline-block' : 'none';
}

// ── build API ──────────────────────────────────────────────────────────────────
function buildAPI() {
  return createAPI(
    msg => clog(msg),
    id  => templates[id],
    ()  => threshold,
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// TEMPLATES
// ══════════════════════════════════════════════════════════════════════════════
async function loadTemplates() {
  const { templates: t } = await send({ type: 'getTemplates' });
  templates = t || {};
  renderTemplates();
  $tplCountCode.textContent = `${Object.keys(templates).length} templates`;
}

function renderTemplates() {
  $tplList.innerHTML = '';
  for (const [name, tpl] of Object.entries(templates)) {
    const item = document.createElement('div');
    item.className = 'tpl-item';
    item.innerHTML = `
      <img class="tpl-thumb" src="${tpl.dataUrl}" alt="${name}">
      <div class="tpl-info">
        <div class="tpl-name">${name}</div>
        <div class="tpl-dims">${tpl.width}×${tpl.height}px</div>
      </div>
      <button class="tpl-insert" data-name="${name}">+ Step</button>
      <button class="tpl-delete" data-name="${name}">✕</button>
    `;
    item.querySelector('.tpl-insert').addEventListener('click', () => {
      steps.push({ ...makeStep('click'), image: name });
      renderWorkflow();
      saveWorkflow();
      document.querySelector('.tab[data-panel="workflow"]').click();
    });
    item.querySelector('.tpl-delete').addEventListener('click', async () => {
      if (!confirm(`Delete "${name}"?`)) return;
      await send({ type: 'deleteTemplate', name });
      delete templates[name];
      renderTemplates();
      renderWorkflow(); // refresh thumbnails
      clog(`Deleted: ${name}`, 'c-warn');
    });
    $tplList.appendChild(item);
  }
}

$btnCapture.addEventListener('click', async () => {
  const name = $tplNameInp.value.trim();
  if (!name) { alert('Enter a template name.'); return; }
  try { await send({ type: 'openCapture', name }); }
  catch (e) { clog('Capture error: ' + e.message, 'c-error'); }
});

// When capture.html saves a template it broadcasts this message
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'templateSaved') {
    templates[msg.name] = { dataUrl: msg.dataUrl, width: msg.width, height: msg.height };
    renderTemplates();
    renderWorkflow(); // update inline thumbnails
    clog(`Template saved: "${msg.name}" (${msg.width}×${msg.height})`, 'c-ok');
  }
});

// ── code save ─────────────────────────────────────────────────────────────────
$btnSave.addEventListener('click', async () => {
  await send({ type: 'saveScript', code: $editor.value });
  clog('Script saved.', 'c-ok');
});

$editor.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); runCode(); }
  if ((e.ctrlKey || e.metaKey) && e.key === 's')     { e.preventDefault(); $btnSave.click(); }
  if (e.key === 'Tab') {
    e.preventDefault();
    const s = $editor.selectionStart;
    $editor.value = $editor.value.slice(0, s) + '  ' + $editor.value.slice($editor.selectionEnd);
    $editor.selectionStart = $editor.selectionEnd = s + 2;
  }
});

// ── persistence ────────────────────────────────────────────────────────────────
async function saveWorkflow() {
  await send({ type: 'saveWorkflow', steps }).catch(() => {});
}

async function loadWorkflow() {
  const { steps: saved } = await send({ type: 'loadWorkflow' });
  steps = saved || [];
  renderWorkflow();
}

// ── utils ──────────────────────────────────────────────────────────────────────
function uid() { return 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

// ── boot ───────────────────────────────────────────────────────────────────────
(async () => {
  await loadTemplates();
  await loadWorkflow();
  const { code } = await send({ type: 'loadScript' });
  if (code) $editor.value = code;
  clog('SikuliX for Chrome ready.  Workflow: add steps or ⏺ Record.  Code: Ctrl+Enter to run.', 'c-info');
})();
