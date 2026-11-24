// Presentation viewer: renders a PDF page with pdf.js and overlays a shared annotation layer.
import { Whiteboard } from './wb.js';

let pdfjsPromise;
function loadPdfjs() {
  pdfjsPromise ||= import(new URL('./vendor/pdf.min.js', import.meta.url).href)
    .then((m) => { m.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdf.worker.min.js', import.meta.url).href; return m; })
    .catch((e) => { pdfjsPromise = null; throw e; });
  return pdfjsPromise;
}
const fa = (n) => Number(n).toLocaleString('fa-IR');

export class SlideViewer {
  /**
   * @param root      container element (filled by the viewer)
   * @param sendAnn   (msg) => void   broadcast an annotation message
   * @param onNav     ({a:'prev'|'next'|'close'}) => void   host clicked a navigation button
   */
  constructor(root, { sendAnn, canDraw, canNav, onNav }) {
    this.root = root;
    this.onNav = onNav;
    this.pdf = null; this.num = 0; this.page = 0; this.aspect = 0.75;
    this.pageObj = null; this.renderTask = null; this.seq = 0; this.loadId = 0;

    root.innerHTML = `
      <div class="doc-bar">
        <div class="doc-nav">
          <button data-n="prev" class="hidden">قبلی</button>
          <span class="doc-pg"></span>
          <button data-n="next" class="hidden">بعدی</button>
        </div>
        <span class="doc-name"></span>
        <div class="doc-tools"></div>
        <button data-n="close" class="hidden doc-close">بستن فایل</button>
      </div>
      <div class="doc-stage">
        <div class="doc-page"><canvas class="doc-canvas"></canvas><div class="doc-ann"></div></div>
      </div>
      <div class="doc-msg hidden"></div>`;
    this.stage = root.querySelector('.doc-stage');
    this.pageEl = root.querySelector('.doc-page');
    this.canvas = root.querySelector('.doc-canvas');
    this.pgEl = root.querySelector('.doc-pg');
    this.nameEl = root.querySelector('.doc-name');
    this.msgEl = root.querySelector('.doc-msg');
    this.ann = new Whiteboard(root.querySelector('.doc-ann'), { send: sendAnn, canDraw, transparent: true, toolsHost: root.querySelector('.doc-tools') });
    root.querySelector('.doc-bar').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-n]');
      if (b) this.onNav?.({ a: b.dataset.n });
    });
    this.setCanNav(canNav);

    let t = 0;
    new ResizeObserver(() => { clearTimeout(t); t = setTimeout(() => this.refit(), 120); }).observe(this.stage);
  }

  setCanDraw(v) { this.ann.setCanDraw(v); }
  setCanNav(v) { this.root.querySelectorAll('[data-n]').forEach((b) => b.classList.toggle('hidden', !v)); }
  setName(n) { this.nameEl.textContent = n || ''; }

  message(text) {
    this.msgEl.textContent = text || '';
    this.msgEl.classList.toggle('hidden', !text);
  }

  /** Parse a PDF given as a Blob (or a URL). Resolves with the page count. */
  async load(src) {
    const id = ++this.loadId;
    this.message('در حال بارگذاری فایل...');
    this.release();
    try {
      let pdf;
      const head = src instanceof Blob ? new Uint8Array(await src.slice(0, 4).arrayBuffer()) : null;
      if (head && head[0] === 0x50 && head[1] === 0x4b) {           // "PK" = zip container = PowerPoint
        const { openPptx } = await import('./pptx.js');
        pdf = await openPptx(src);
      } else {
        const pdfjs = await loadPdfjs();
        const source = src instanceof Blob ? { data: new Uint8Array(await src.arrayBuffer()) } : { url: src };
        const task = pdfjs.getDocument({ ...source, wasmUrl: new URL('./vendor/pdfjs-wasm/', import.meta.url).href, standardFontDataUrl: new URL('./vendor/pdfjs-fonts/', import.meta.url).href, isEvalSupported: false });
        pdf = await task.promise;
      }
      if (id !== this.loadId) { pdf.destroy(); throw new Error('superseded'); }
      this.pdf = pdf; this.num = pdf.numPages; this.page = 0;
      this.message('');
      return this.num;
    } catch (e) {
      if (id === this.loadId) this.message('بارگذاری فایل ناموفق بود'); console.error('load failed', e);
      throw e;
    }
  }

  /** Show page n (1-based). */
  async show(n) {
    if (!this.pdf) return;
    n = Math.max(1, Math.min(this.num, Math.round(Number(n)) || 1));
    const seq = ++this.seq;
    const pdf = this.pdf;
    let page;
    try { page = await pdf.getPage(n); } catch { return; }
    if (seq !== this.seq || pdf !== this.pdf) return;
    this.page = n; this.pageObj = page;
    const vp = page.getViewport({ scale: 1 });
    this.aspect = vp.height / vp.width;
    this.ann.setPage('p' + n, this.aspect);
    this.pgEl.textContent = `صفحه ${fa(n)} از ${fa(this.num)}`;
    await this.refit();
  }

  async refit() {
    if (!this.pageObj) return;
    const sw = this.stage.clientWidth - 16, sh = this.stage.clientHeight - 16;
    if (sw < 50 || sh < 50) return;
    const w = Math.floor(Math.min(sw, sh / this.aspect)), h = Math.floor(w * this.aspect);
    this.pageEl.style.width = w + 'px';
    this.pageEl.style.height = h + 'px';
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const vp0 = this.pageObj.getViewport({ scale: 1 });
    const viewport = this.pageObj.getViewport({ scale: (w * dpr) / vp0.width });
    const seq = ++this.seq;
    this.renderTask?.cancel();
    const off = document.createElement('canvas');           // render off-screen, then swap: no flicker while resizing
    off.width = Math.floor(viewport.width); off.height = Math.floor(viewport.height);
    const task = this.pageObj.render({ canvasContext: off.getContext('2d'), viewport });
    this.renderTask = task;
    try { await task.promise; } catch { return; }           // cancelled by a newer render
    if (seq !== this.seq) return;
    this.canvas.width = off.width; this.canvas.height = off.height;
    this.canvas.getContext('2d').drawImage(off, 0, 0);
  }

  release() {
    this.seq++;
    try { this.renderTask?.cancel(); } catch { /* ignore */ }
    try { this.pdf?.destroy(); } catch { /* ignore */ }
    this.pdf = null; this.pageObj = null; this.num = 0; this.page = 0;
    this.pgEl.textContent = '';
    this.canvas.width = 1; this.canvas.height = 1;
  }

  apply(m) { this.ann.apply(m); }
  snapshotMessages() { return this.ann.snapshotMessages(); }
}
