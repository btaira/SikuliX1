// Region-capture overlay.
// Opened as a full tab with ?name=<name>&src=<screenshotDataUrl>.
// On selection confirm, saves the cropped region as a template and messages sidepanel.
'use strict';

const params = new URLSearchParams(location.search);
const templateName = params.get('name') || 'unnamed';
const screenshotSrc = params.get('src');

const canvas  = document.getElementById('canvas');
const ctx     = canvas.getContext('2d');
const selDiv  = document.getElementById('selection');
const coords  = document.getElementById('coords');

let img = null;
let dragging = false;
let startX = 0, startY = 0, endX = 0, endY = 0;

// ── load screenshot onto full-page canvas ──────────────────────────────────────
function init() {
  if (!screenshotSrc) {
    document.getElementById('hint').textContent = 'Error: no screenshot provided.';
    return;
  }

  img = new Image();
  img.onload = () => {
    canvas.width  = img.width;
    canvas.height = img.height;
    document.body.style.width  = img.width  + 'px';
    document.body.style.height = img.height + 'px';
    ctx.drawImage(img, 0, 0);
    // Dim the screenshot slightly
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.fillRect(0, 0, img.width, img.height);
  };
  img.src = screenshotSrc;
}

// ── drag selection ─────────────────────────────────────────────────────────────
document.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  dragging = true;
  startX = e.clientX + window.scrollX;
  startY = e.clientY + window.scrollY;
  endX = startX; endY = startY;
  selDiv.style.display = 'block';
  updateSelection();
});

document.addEventListener('mousemove', (e) => {
  if (!dragging) return;
  endX = e.clientX + window.scrollX;
  endY = e.clientY + window.scrollY;
  updateSelection();

  const w = Math.abs(endX - startX), h = Math.abs(endY - startY);
  coords.textContent = `${Math.min(startX,endX)}, ${Math.min(startY,endY)}  ${w}×${h}`;
});

document.addEventListener('mouseup', async (e) => {
  if (!dragging || e.button !== 0) return;
  dragging = false;
  endX = e.clientX + window.scrollX;
  endY = e.clientY + window.scrollY;

  const x = Math.round(Math.min(startX, endX));
  const y = Math.round(Math.min(startY, endY));
  const w = Math.round(Math.abs(endX - startX));
  const h = Math.round(Math.abs(endY - startY));

  if (w < 5 || h < 5) {
    selDiv.style.display = 'none';
    return;
  }

  selDiv.style.display = 'none';
  await saveRegion(x, y, w, h);
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') window.close();
});

function updateSelection() {
  const x = Math.min(startX, endX) - window.scrollX;
  const y = Math.min(startY, endY) - window.scrollY;
  const w = Math.abs(endX - startX);
  const h = Math.abs(endY - startY);
  selDiv.style.left   = x + 'px';
  selDiv.style.top    = y + 'px';
  selDiv.style.width  = w + 'px';
  selDiv.style.height = h + 'px';
}

// ── crop and save ──────────────────────────────────────────────────────────────
async function saveRegion(x, y, w, h) {
  // Redraw original screenshot (without dim) to crop cleanly
  const crop = document.createElement('canvas');
  crop.width = w; crop.height = h;
  const cctx = crop.getContext('2d');
  cctx.drawImage(img, x, y, w, h, 0, 0, w, h);
  const dataUrl = crop.toDataURL('image/png');

  // Save via background
  await new Promise((res, rej) => {
    chrome.runtime.sendMessage(
      { type: 'saveTemplate', name: templateName, dataUrl, width: w, height: h },
      (r) => {
        if (chrome.runtime.lastError) return rej(new Error(chrome.runtime.lastError.message));
        if (r && r.error) return rej(new Error(r.error));
        res(r);
      }
    );
  });

  // Notify all extension pages (sidepanel picks this up)
  chrome.runtime.sendMessage({ type: 'templateSaved', name: templateName, dataUrl, width: w, height: h });

  window.close();
}

init();
