'use strict';

pdfjsLib.GlobalWorkerOptions.workerSrc =
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

let currentMode      = null;
let redactionHistory = [];
let pdfPageBitmaps   = [];

const uploadSection  = document.getElementById('upload-section');
const editorSection  = document.getElementById('editor-section');
const dropZone       = document.getElementById('drop-zone');
const fileInput      = document.getElementById('file-input');
const docViewer      = document.getElementById('document-viewer');
const loadingOverlay = document.getElementById('loading-overlay');
const selToolbar     = document.getElementById('selection-toolbar');
const redactionList  = document.getElementById('redaction-list');
const redactionCount = document.getElementById('redaction-count');
const headerControls = document.getElementById('header-controls');
const dirToggle      = document.getElementById('dir-toggle');
const tbBlacken      = document.getElementById('tb-blacken');
const tbRemove       = document.getElementById('tb-remove');
const tbUndo         = document.getElementById('tb-undo');
const tbClear        = document.getElementById('tb-clear');
const btnExport      = document.getElementById('btn-export');
const btnNewFile     = document.getElementById('btn-new-file');

(function init() {
  dropZone.addEventListener('dragover',  e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
  dropZone.addEventListener('dragleave', ()  => dropZone.classList.remove('drag-over'));
  dropZone.addEventListener('drop',      e  => { e.preventDefault(); dropZone.classList.remove('drag-over'); handleFiles(e.dataTransfer.files); });
  dropZone.addEventListener('click',     ()  => fileInput.click());
  document.getElementById('browse-btn').addEventListener('click', e => { e.stopPropagation(); fileInput.click(); });
  fileInput.addEventListener('change', e => handleFiles(e.target.files));

  tbBlacken.addEventListener('click', () => applyRedaction('blacken'));
  tbRemove .addEventListener('click', () => applyRedaction('remove'));
  tbUndo   .addEventListener('click', undoLast);
  tbClear  .addEventListener('click', clearAll);
  btnExport.addEventListener('click', exportPDF);
  btnNewFile.addEventListener('click', resetApp);

  selToolbar.addEventListener('mousedown', e => e.preventDefault());
  selToolbar.querySelectorAll('.sel-btn').forEach(btn =>
    btn.addEventListener('click', () => applyRedaction(btn.dataset.action)));

  dirToggle.addEventListener('change', () => {
    const rtl = dirToggle.checked;
    docViewer.dir  = rtl ? 'rtl' : 'ltr';
    docViewer.lang = rtl ? 'he'  : 'en';
  });

  document.addEventListener('mouseup', onMouseUp);
  document.addEventListener('keyup',   onMouseUp);
  document.addEventListener('mousedown', e => {
    if (!selToolbar.contains(e.target)) hideSelToolbar();
  });
})();

function handleFiles(files) {
  if (!files || !files.length) return;
  const file = files[0];
  const ext  = file.name.split('.').pop().toLowerCase();
  if (ext === 'pdf') {
    runLoader(() => processPDF(file));
  } else if (ext === 'docx' || ext === 'doc') {
    runLoader(() => processDOCX(file));
  } else {
    alert('Please upload a PDF or DOCX/DOC file.');
  }
}

async function runLoader(fn) {
  showLoading();
  try {
    await fn();
    showEditor();
  } catch (err) {
    console.error(err);
    alert('Failed to process the document:\n' + err.message);
    hideLoading();
  }
}

async function processPDF(file) {
  currentMode = 'pdf';
  pdfPageBitmaps.forEach(b => b.close());
  pdfPageBitmaps = [];
  docViewer.innerHTML = '';

  const ab  = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: ab }).promise;

  for (let n = 1; n <= pdf.numPages; n++) {
    const page = await pdf.getPage(n);
    const { wrap, canvas } = await buildPDFPage(page, n);
    docViewer.appendChild(wrap);
    const bitmap = await createImageBitmap(canvas);
    pdfPageBitmaps.push(bitmap);
    if (n < pdf.numPages) {
      const hr = document.createElement('hr');
      hr.className = 'pdf-page-sep';
      docViewer.appendChild(hr);
    }
  }

  autoDetectDirection(docViewer.textContent);
}

async function buildPDFPage(page, pageNum) {
  const DISPLAY_WIDTH = 780;
  const baseVP   = page.getViewport({ scale: 1 });
  const scale    = DISPLAY_WIDTH / baseVP.width;
  const viewport = page.getViewport({ scale });

  const canvas = document.createElement('canvas');
  canvas.width  = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  canvas.style.cssText = 'display:block;width:100%;height:auto;';

  const textLayerDiv = document.createElement('div');
  textLayerDiv.className = 'pdf-text-layer';
  textLayerDiv.style.cssText = `position:absolute;inset:0;overflow:hidden;width:${canvas.width}px;height:${canvas.height}px;line-height:1;`;

  const wrap = document.createElement('div');
  wrap.className = 'pdf-page-wrap';
  wrap.dataset.page = pageNum;
  wrap.style.cssText = `position:relative;width:${canvas.width}px;max-width:100%;margin:0 auto;`;
  wrap.appendChild(canvas);
  wrap.appendChild(textLayerDiv);

  await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;

  const textContent = await page.getTextContent();
  buildTextLayer(textLayerDiv, textContent, viewport);

  return { wrap, canvas };
}

function buildTextLayer(container, textContent, viewport) {
  textContent.items.forEach(item => {
    if (!item.str) return;

    const tx = pdfjsLib.Util.transform(viewport.transform, item.transform);
    const fontHeight = Math.sqrt(tx[2] * tx[2] + tx[3] * tx[3]);
    if (fontHeight < 1) return;

    const angle = Math.atan2(tx[1], tx[0]);

    const span = document.createElement('span');
    span.textContent = item.str;
    span.style.cssText = `
      position:absolute;
      left:${tx[4]}px;
      top:${tx[5] - fontHeight}px;
      font-size:${fontHeight}px;
      font-family:sans-serif;
      white-space:pre;
      color:transparent;
      cursor:text;
      transform-origin:0% 0%;
      ${angle !== 0 ? `transform:rotate(${angle}rad);` : ''}
    `;

    if (/[\u0590-\u05FF\u0600-\u06FF]/.test(item.str)) span.dir = 'rtl';

    container.appendChild(span);

    if (item.width) {
      requestAnimationFrame(() => {
        const rendered = span.getBoundingClientRect().width;
        const target   = Math.abs(item.width * tx[0]);
        if (rendered > 0 && Math.abs(target - rendered) > 1) {
          span.style.transform =
            (angle !== 0 ? `rotate(${angle}rad) ` : '') +
            `scaleX(${target / rendered})`;
        }
      });
    }
  });
}

async function processDOCX(file) {
  currentMode = 'docx';
  pdfPageBitmaps.forEach(b => b.close());
  pdfPageBitmaps = [];

  const ab = await file.arrayBuffer();
  const result = await mammoth.convertToHtml({ arrayBuffer: ab }, {
    styleMap: [
      "p[style-name='Heading 1'] => h1:fresh",
      "p[style-name='Heading 2'] => h2:fresh",
      "p[style-name='Heading 3'] => h3:fresh",
      "p[style-name='Title']     => h1.docx-title:fresh",
    ],
    includeDefaultStyleMap: true,
    convertImage: mammoth.images.imgElement(img =>
      img.read('base64').then(data => ({
        src: `data:${img.contentType};base64,${data}`,
        style: 'max-width:100%;',
      }))
    ),
  });

  docViewer.innerHTML = `<div class="docx-content">${result.value}</div>`;
  autoDetectDirection(result.value);
}

function autoDetectDirection(text) {
  const he    = (text.match(/[\u0590-\u05FF]/g) || []).length;
  const ar    = (text.match(/[\u0600-\u06FF]/g) || []).length;
  const latin = (text.match(/[a-zA-Z]/g)        || []).length;
  const rtl   = (he + ar) > latin;
  dirToggle.checked = rtl;
  docViewer.dir  = rtl ? 'rtl' : 'ltr';
  docViewer.lang = rtl ? 'he'  : 'en';
}

function onMouseUp(e) {
  if (selToolbar.contains(e.target)) return;
  requestAnimationFrame(() => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.toString().trim()) { hideSelToolbar(); return; }
    const range = sel.getRangeAt(0);
    if (!docViewer.contains(range.commonAncestorContainer)) { hideSelToolbar(); return; }
    showSelToolbar(range.getBoundingClientRect());
  });
}

function showSelToolbar(rect) {
  selToolbar.style.display = 'flex';
  requestAnimationFrame(() => {
    const tbW = selToolbar.offsetWidth  || 170;
    const tbH = selToolbar.offsetHeight || 40;
    let left  = rect.left + rect.width / 2 - tbW / 2;
    let top   = rect.top  + window.scrollY - tbH - 12;
    left = Math.max(8, Math.min(left, window.innerWidth - tbW - 8));
    if (top < window.scrollY + 8) top = rect.bottom + window.scrollY + 12;
    selToolbar.style.left = left + 'px';
    selToolbar.style.top  = top  + 'px';
  });
}

function hideSelToolbar() { selToolbar.style.display = 'none'; }

function applyRedaction(type) {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed) return;
  const range = sel.getRangeAt(0);
  if (!docViewer.contains(range.commonAncestorContainer)) return;
  const text = sel.toString().trim();
  if (!text) return;

  const node      = range.commonAncestorContainer;
  const textLayer = node.nodeType === Node.ELEMENT_NODE
    ? node.closest('.pdf-text-layer')
    : node.parentElement?.closest('.pdf-text-layer');

  let entry;
  if (currentMode === 'pdf' && textLayer) {
    entry = applyPDFRedaction(type, text, range, textLayer);
  } else {
    entry = applyDocxRedaction(type, text, range);
  }

  if (entry) {
    sel.removeAllRanges();
    hideSelToolbar();
    redactionHistory.push(entry);
    refreshSidebar();
    refreshToolbarState();
  }
}

function applyPDFRedaction(type, text, range, textLayer) {
  const pageWrap = textLayer.closest('.pdf-page-wrap');
  if (!pageWrap) return null;

  const selRect  = range.getBoundingClientRect();
  const pageRect = pageWrap.getBoundingClientRect();

  const relX = selRect.left - pageRect.left;
  const relY = selRect.top  - pageRect.top;
  const relW = selRect.width;
  const relH = selRect.height + 2;

  const overlay = document.createElement('div');
  overlay.className = `pdf-redact-overlay pdf-redact-${type}`;
  overlay.style.cssText = `
    position:absolute;
    left:${relX}px; top:${relY}px;
    width:${relW}px; height:${relH}px;
    pointer-events:none; z-index:5;
    background:${type === 'blacken' ? '#000' : 'rgba(220,38,38,0.25)'};
    ${type === 'remove' ? 'outline:2px solid rgba(220,38,38,0.6);' : ''}
  `;
  pageWrap.appendChild(overlay);

  return { mode: 'pdf', type, text, el: overlay, pageWrap,
           relX, relY, relW, relH };
}

function applyDocxRedaction(type, text, range) {
  const span = document.createElement('span');
  span.className    = `redacted redacted-${type}`;
  span.dataset.type = type;
  try {
    range.surroundContents(span);
  } catch (_) {
    const frag = range.extractContents();
    span.appendChild(frag);
    range.insertNode(span);
  }
  return { mode: 'docx', type, text, el: span };
}

function undoLast() {
  if (!redactionHistory.length) return;
  removeEntry(redactionHistory.length - 1);
}

function clearAll() {
  if (!redactionHistory.length) return;
  if (!confirm('Remove all redactions?')) return;
  for (let i = redactionHistory.length - 1; i >= 0; i--) removeEntry(i);
}

function removeEntry(index) {
  const entry = redactionHistory[index];
  if (!entry) return;
  if (entry.mode === 'pdf') {
    entry.el.remove();
  } else {
    unwrapElement(entry.el);
  }
  redactionHistory.splice(index, 1);
  refreshSidebar();
  refreshToolbarState();
}

function unwrapElement(el) {
  if (!el.parentNode) return;
  const p = el.parentNode;
  while (el.firstChild) p.insertBefore(el.firstChild, el);
  p.removeChild(el);
}

function refreshSidebar() {
  redactionCount.textContent = redactionHistory.length;
  if (!redactionHistory.length) {
    redactionList.innerHTML = '<p class="sidebar-empty">Select text in the document to start redacting.</p>';
    return;
  }
  redactionList.innerHTML = '';
  redactionHistory.forEach((entry, i) => {
    const preview = entry.text.substring(0, 42) + (entry.text.length > 42 ? '…' : '');
    const item = document.createElement('div');
    item.className = 'redaction-item';
    item.innerHTML = `
      <span class="redaction-badge ${entry.type}">${entry.type === 'blacken' ? 'BLK' : 'DEL'}</span>
      <span class="redaction-text" title="${escHtml(entry.text)}">${escHtml(preview)}</span>
      <button class="redaction-del" title="Restore this text">↩</button>
    `;
    item.querySelector('.redaction-del').addEventListener('click', () => removeEntry(i));
    redactionList.appendChild(item);
  });
}

function refreshToolbarState() {
  const any = redactionHistory.length > 0;
  tbUndo.disabled  = !any;
  tbClear.disabled = !any;
}

async function exportPDF() {
  btnExport.disabled    = true;
  btnExport.textContent = '⏳ Generating…';
  try {
    if (currentMode === 'pdf') {
      await exportPDFFromCanvas();
    } else {
      await exportDocxAsPDF();
    }
  } catch (err) {
    console.error(err);
    alert('Export failed:\n' + err.message);
  } finally {
    btnExport.disabled    = false;
    btnExport.textContent = '⬇ Export PDF';
  }
}

async function exportPDFFromCanvas() {
  const { jsPDF } = window.jspdf;
  const pageWraps = docViewer.querySelectorAll('.pdf-page-wrap');
  if (!pageWraps.length) throw new Error('No pages found.');

  let doc = null;

  for (let i = 0; i < pageWraps.length; i++) {
    const wrap   = pageWraps[i];
    const bitmap = pdfPageBitmaps[i];
    if (!bitmap) continue;

    const exp = document.createElement('canvas');
    exp.width  = bitmap.width;
    exp.height = bitmap.height;
    const ctx  = exp.getContext('2d');
    ctx.drawImage(bitmap, 0, 0);

    const scaleX = bitmap.width  / wrap.offsetWidth;
    const scaleY = bitmap.height / wrap.offsetHeight;

    redactionHistory
      .filter(r => r.mode === 'pdf' && r.pageWrap === wrap)
      .forEach(r => {
        ctx.fillStyle = r.type === 'blacken' ? '#000000' : '#ffffff';
        ctx.fillRect(r.relX * scaleX, r.relY * scaleY, r.relW * scaleX, (r.relH + 2) * scaleY);
      });

    const ratio = exp.width / exp.height;
    const pageW = 210;
    const pageH = Math.round(pageW / ratio);

    if (i === 0) {
      doc = new jsPDF({ unit: 'mm', format: [pageW, pageH], orientation: pageH > pageW ? 'p' : 'l' });
    } else {
      doc.addPage([pageW, pageH], pageH > pageW ? 'p' : 'l');
    }
    doc.addImage(exp.toDataURL('image/jpeg', 0.95), 'JPEG', 0, 0, pageW, pageH);
  }

  if (doc) doc.save('anonymized-cv.pdf');
}

async function exportDocxAsPDF() {
  const isRTL = dirToggle.checked;

  const wrap = document.createElement('div');
  wrap.style.cssText = `
    width:794px; padding:68px 76px; background:#fff; color:#111;
    font-family:${isRTL ? "'Noto Sans Hebrew','Arial Hebrew',Arial,sans-serif" : "Georgia,'Times New Roman',serif"};
    font-size:10.5pt; line-height:1.65; direction:${isRTL ? 'rtl' : 'ltr'};
    position:fixed; left:0; top:0;
  `;

  const clone = docViewer.cloneNode(true);
  clone.removeAttribute('id');
  clone.querySelectorAll('.redacted-remove').forEach(el => { el.style.cssText += 'display:none!important;'; });
  clone.querySelectorAll('.redacted-blacken').forEach(el => { el.style.cssText += 'background:#000!important;color:#000!important;'; });

  // Copy docx-content styles inline so they survive reparenting
  clone.querySelectorAll('.docx-content').forEach(el => {
    el.style.cssText += 'background:#fff;color:#111;padding:0;margin:0;box-shadow:none;min-height:auto;';
    if (isRTL) el.style.fontFamily = "'Noto Sans Hebrew','Arial Hebrew',Arial,sans-serif";
  });

  wrap.appendChild(clone);
  document.body.appendChild(wrap);

  try {
    const canvas = await html2canvas(wrap, {
      scale: 2,
      useCORS: true,
      logging: false,
      backgroundColor: '#ffffff',
    });

    const { jsPDF } = window.jspdf;
    const imgData = canvas.toDataURL('image/jpeg', 0.97);
    const pxW = canvas.width;
    const pxH = canvas.height;

    // A4 width = 210mm; split content into pages if taller than A4
    const pageW = 210;
    const pageH = 297;
    const contentH_mm = (pxH / pxW) * pageW;
    const totalPages = Math.max(1, Math.ceil(contentH_mm / pageH));

    const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' });

    if (totalPages === 1) {
      doc.addImage(imgData, 'JPEG', 0, 0, pageW, contentH_mm);
    } else {
      // Slice the canvas into A4-sized pages
      const sliceH = Math.floor(pxH / totalPages);
      for (let p = 0; p < totalPages; p++) {
        if (p > 0) doc.addPage('a4', 'portrait');
        const sliceCanvas = document.createElement('canvas');
        sliceCanvas.width = pxW;
        sliceCanvas.height = Math.min(sliceH, pxH - p * sliceH);
        const sCtx = sliceCanvas.getContext('2d');
        sCtx.drawImage(canvas, 0, p * sliceH, pxW, sliceCanvas.height, 0, 0, pxW, sliceCanvas.height);
        const sliceData = sliceCanvas.toDataURL('image/jpeg', 0.97);
        const sliceH_mm = (sliceCanvas.height / pxW) * pageW;
        doc.addImage(sliceData, 'JPEG', 0, 0, pageW, sliceH_mm);
      }
    }

    doc.save('anonymized-cv.pdf');
  } finally {
    wrap.remove();
  }
}

function showEditor() {
  uploadSection.classList.add('hidden');
  editorSection.classList.remove('hidden');
  headerControls.style.display = 'flex';
  hideLoading();
  refreshSidebar();
  refreshToolbarState();
}

function showLoading() { loadingOverlay.classList.remove('hidden'); }
function hideLoading()  { loadingOverlay.classList.add('hidden'); }

function resetApp() {
  editorSection.classList.add('hidden');
  uploadSection.classList.remove('hidden');
  headerControls.style.display = 'none';
  docViewer.innerHTML = '';
  fileInput.value     = '';
  redactionHistory    = [];
  pdfPageBitmaps.forEach(b => b.close());
  pdfPageBitmaps      = [];
  currentMode         = null;
  refreshSidebar();
  refreshToolbarState();
  hideSelToolbar();
}

function escHtml(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
