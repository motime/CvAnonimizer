const { chromium } = require('playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const PORT = 9877;
let passed = 0, failed = 0;

function startServer() {
  const mime = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css' };
  const server = http.createServer((req, res) => {
    const filePath = path.join(ROOT, req.url === '/' ? 'index.html' : req.url);
    const ext = path.extname(filePath);
    try {
      const data = fs.readFileSync(filePath);
      res.writeHead(200, { 'Content-Type': mime[ext] || 'application/octet-stream' });
      res.end(data);
    } catch {
      res.writeHead(404);
      res.end('Not found');
    }
  });
  return new Promise(resolve => server.listen(PORT, () => resolve(server)));
}

async function verifyPdf(page, pdfPath) {
  const fname = '/' + path.basename(pdfPath);
  return page.evaluate(async (u) => {
    const buf = await (await fetch(u)).arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
    const pages = [];
    for (let p = 1; p <= pdf.numPages; p++) {
      const pg = await pdf.getPage(p);
      const vp = pg.getViewport({ scale: 1 });
      const c = document.createElement('canvas');
      c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
      await pg.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let nw = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i] < 250 || d[i+1] < 250 || d[i+2] < 250) nw++;
      pages.push((nw / (c.width * c.height) * 100));
    }
    return pages;
  }, fname);
}

function check(name, ok) {
  if (ok) { passed++; console.log(`  PASS: ${name}`); }
  else { failed++; console.log(`  FAIL: ${name}`); }
}

(async () => {
  const server = await startServer();
  const browser = await chromium.launch();
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', err => errors.push(err.message));

  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle' });

  // Helper: upload a generated PDF
  async function uploadTestPdf(setup) {
    await page.evaluate(async (setupCode) => {
      const { jsPDF } = window.jspdf;
      const doc = new jsPDF();
      // eval setup code to build the PDF
      const fn = new Function('doc', setupCode);
      fn(doc);
      const buf = doc.output('arraybuffer');
      const file = new File([new Blob([buf])], 'test.pdf', { type: 'application/pdf' });
      await new Promise(resolve => {
        const orig = window.showEditor;
        window.showEditor = function() { orig.call(this); window.showEditor = orig; resolve(); };
        handleFiles([file]);
      });
    }, setup);
  }

  // Helper: set up DOCX content
  async function setupDocx(html, rtl = false) {
    await page.evaluate(({ html, rtl }) => {
      resetApp();
      currentMode = 'docx';
      document.getElementById('upload-section').classList.add('hidden');
      document.getElementById('editor-section').classList.remove('hidden');
      document.getElementById('header-controls').style.display = 'flex';
      document.getElementById('dir-toggle').checked = rtl;
      const viewer = document.getElementById('document-viewer');
      viewer.dir = rtl ? 'rtl' : 'ltr';
      viewer.innerHTML = html;
    }, { html, rtl });
  }

  // Helper: export and verify
  async function exportAndVerify(minContentPct = 1) {
    const dlPromise = page.waitForEvent('download', { timeout: 60000 });
    await page.click('#btn-export');
    const dl = await dlPromise;
    const outPath = path.join(ROOT, `_test_${Date.now()}.pdf`);
    await dl.saveAs(outPath);
    const size = fs.statSync(outPath).size;
    const pages = await verifyPdf(page, outPath);
    fs.unlinkSync(outPath);
    return { size, pages };
  }

  // ── PDF EXPORT TESTS ─────────────────────────────────────────────
  console.log('\nPDF Export:');

  await uploadTestPdf(`
    doc.setFillColor(200,200,255); doc.rect(0,0,210,297,'F');
    doc.setFillColor(255,0,0); doc.rect(10,10,190,80,'F');
    doc.setFontSize(48); doc.text('EXPORT TEST', 15, 200);
  `);
  let r = await exportAndVerify();
  check('single page has content', r.pages.length === 1 && r.pages[0] > 5);

  await page.evaluate(() => resetApp());
  await uploadTestPdf(`
    doc.setFillColor(255,200,200); doc.rect(0,0,210,297,'F'); doc.text('P1',50,150);
    doc.addPage();
    doc.setFillColor(200,255,200); doc.rect(0,0,210,297,'F'); doc.text('P2',50,150);
    doc.addPage();
    doc.setFillColor(200,200,255); doc.rect(0,0,210,297,'F'); doc.text('P3',50,150);
  `);
  r = await exportAndVerify();
  check('3-page PDF all have content', r.pages.length === 3 && r.pages.every(p => p > 5));

  // ── DOCX EXPORT TESTS ────────────────────────────────────────────
  console.log('\nDOCX Export:');

  await setupDocx(`<div class="docx-content">
    <h1>Test</h1>
    <p style="color:red; font-size:24px;">Red text</p>
    <div style="background:blue; width:100%; height:100px;"></div>
    <p>Normal text content.</p>
  </div>`);
  r = await exportAndVerify();
  check('basic DOCX has content', r.pages.length >= 1 && r.pages[0] > 1);

  await setupDocx(`<div class="docx-content">
    <h1>קורות חיים</h1>
    <p>שם: ישראל ישראלי</p>
    <p>טלפון: 050-1234567</p>
    <p style="color:red;">טקסט אדום</p>
  </div>`, true);
  r = await exportAndVerify();
  check('RTL Hebrew DOCX has content', r.pages.length >= 1 && r.pages[0] > 0.1);

  let longHtml = '<div class="docx-content"><h1>Long Doc</h1>';
  for (let i = 0; i < 50; i++) longHtml += `<p>Paragraph ${i+1}: Lorem ipsum dolor sit amet.</p>`;
  longHtml += '</div>';
  await setupDocx(longHtml);
  r = await exportAndVerify();
  check('long DOCX multi-page', r.pages.length >= 2 && r.pages.every(p => p > 1));

  // ── SUMMARY ──────────────────────────────────────────────────────
  console.log(`\n${passed} passed, ${failed} failed`);
  if (errors.length) {
    console.log('\nBrowser errors:');
    errors.forEach(e => console.log('  ' + e));
  }

  await browser.close();
  server.close();
  process.exit(failed > 0 ? 1 : 0);
})();
