// Shared drawing surface used both for the whiteboard and for annotating presented slides.
// Strokes live in a logical 1600 x bh space (bh depends on the page aspect) so every client sees the same picture.
// Strokes are kept per "page key", so flipping slides keeps each slide's annotations.
const BW = 1600;
const rid = () => Math.random().toString(16).slice(2, 10);
const MAX_STROKES = 1500, MAX_POINTS = 6000;

export class Whiteboard {
  /**
   * @param root      element the canvas fills
   * @param send      (msg) => void   broadcast a drawing message
   * @param canDraw   initial drawing permission
   * @param transparent  true when drawn over a slide (no white paper, tools can live elsewhere)
   * @param toolsHost    element that receives the toolbar instead of `root`
   */
  constructor(root, { send, canDraw, transparent = false, toolsHost = null }) {
    this.root = root;
    this.send = send;
    this.canDraw = canDraw;
    this.transparent = transparent;
    this.stores = new Map();      // page key -> { strokes: [], byId: Map }
    this.key = 'main';
    this.bh = 900;
    this.tool = 'pen';
    this.color = transparent ? '#dc2626' : '#111827';
    this.width = 4;
    this.mine = [];               // [{k,id}] strokes drawn locally (for undo)
    this.pending = null;
    this.cur = null;
    this.raf = 0;

    const tools = document.createElement('div');
    tools.className = 'wb-tools' + (toolsHost ? ' static' : '');
    tools.innerHTML = `
      <button data-t="pen" class="active">قلم</button>
      <button data-t="eraser">پاک‌کن</button>
      <input type="color" value="${this.color}" title="رنگ">
      <input type="range" min="1" max="24" value="${this.width}" title="ضخامت">
      <button data-a="undo">بازگشت</button>
      <button data-a="clear">${transparent ? 'پاک کردن این صفحه' : 'پاک کردن همه'}</button>
      <span class="wb-ro" style="font-size:.8rem;color:#6b7280">فقط مشاهده</span>`;
    this.tools = tools;
    root.innerHTML = '<canvas class="wb-canvas"></canvas>';
    (toolsHost || root).append(tools);
    this.canvas = root.querySelector('canvas');
    this.ctx = this.canvas.getContext('2d');
    this.layer = document.createElement('canvas');
    this.lctx = this.layer.getContext('2d');

    tools.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.t) {
        this.tool = b.dataset.t;
        tools.querySelectorAll('[data-t]').forEach((x) => x.classList.toggle('active', x === b));
      } else if (b.dataset.a === 'undo') this.undo();
      else if (b.dataset.a === 'clear' && confirm(transparent ? 'نوشته‌های این صفحه پاک شود؟' : 'همه نوشته‌های تخته پاک شود؟')) this.clear(true);
    });
    tools.querySelector('input[type=color]').addEventListener('input', (e) => (this.color = e.target.value));
    tools.querySelector('input[type=range]').addEventListener('input', (e) => (this.width = Number(e.target.value)));

    this.canvas.addEventListener('pointerdown', (e) => this.down(e));
    this.canvas.addEventListener('pointermove', (e) => this.move(e));
    for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) this.canvas.addEventListener(ev, () => this.up());
    new ResizeObserver(() => this.resize()).observe(root);
    this.setCanDraw(canDraw);
    this.resize();
  }

  store(k) {
    let s = this.stores.get(k);
    if (!s) { s = { strokes: [], byId: new Map() }; this.stores.set(k, s); }
    return s;
  }

  /** Switch to another page. `aspect` = page height / page width. */
  setPage(key, aspect = 900 / BW) {
    this.up();
    this.key = String(key).slice(0, 32);
    this.bh = Math.max(200, Math.min(6000, Math.round(BW * aspect)));
    this.resize();
  }

  setCanDraw(v) {
    this.canDraw = v;
    this.tools.querySelectorAll('button,input').forEach((el) => el.classList.toggle('hidden', !v));
    this.tools.classList.toggle('hidden', !v && this.transparent);
    this.tools.querySelector('.wb-ro').classList.toggle('hidden', v || this.transparent);
    this.canvas.style.cursor = v ? 'crosshair' : 'default';
  }

  resize() {
    const r = this.root.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    for (const c of [this.canvas, this.layer]) { c.width = Math.max(1, Math.round(r.width * dpr)); c.height = Math.max(1, Math.round(r.height * dpr)); }
    this.dpr = dpr;
    this.scale = Math.min(r.width / BW, r.height / this.bh) || 1;
    this.ox = (r.width - BW * this.scale) / 2;
    this.oy = (r.height - this.bh * this.scale) / 2;
    this.render();
  }

  pos(e) {
    const r = this.canvas.getBoundingClientRect();
    const x = (e.clientX - r.left - this.ox) / this.scale, y = (e.clientY - r.top - this.oy) / this.scale;
    return [Math.round(Math.min(BW, Math.max(0, x))), Math.round(Math.min(this.bh, Math.max(0, y)))];
  }

  down(e) {
    if (!this.canDraw || this.cur) return;
    this.canvas.setPointerCapture(e.pointerId);
    const s = { id: rid(), c: this.color, w: this.width, e: this.tool === 'eraser' ? 1 : 0, p: [this.pos(e)] };
    this.add(this.key, s);
    this.mine.push({ k: this.key, id: s.id });
    this.cur = s;
    this.pending = { k: this.key, id: s.id, c: s.c, w: s.w, e: s.e, p: [...s.p] };
    this.timer = setInterval(() => this.flush(), 60);
    this.queueRender();
  }

  move(e) {
    if (!this.cur || this.cur.p.length >= MAX_POINTS) return;
    const pt = this.pos(e);
    const last = this.cur.p[this.cur.p.length - 1];
    if (Math.abs(pt[0] - last[0]) + Math.abs(pt[1] - last[1]) < 2) return;
    this.cur.p.push(pt);
    this.pending.p.push(pt);
    this.queueRender();
  }

  up() {
    if (!this.cur) return;
    clearInterval(this.timer);
    this.flush();
    this.cur = null;
    this.pending = null;
  }

  flush() {
    if (!this.pending || !this.pending.p.length) return;
    const { k, id, c, w, e, p } = this.pending;
    this.send({ t: 's', k, id, c, w, e, p });
    this.pending.p = [];
  }

  add(k, s) {
    const st = this.store(k);
    if (st.strokes.length >= MAX_STROKES) { const old = st.strokes.shift(); st.byId.delete(old.id); }
    st.strokes.push(s);
    st.byId.set(s.id, s);
  }

  undo() {
    let i = this.mine.length - 1;
    while (i >= 0 && this.mine[i].k !== this.key) i--;
    if (i < 0) return;
    const { k, id } = this.mine.splice(i, 1)[0];
    this.remove(k, id);
    this.send({ t: 'undo', k, id });
  }

  remove(k, id) {
    const st = this.store(k);
    const s = st.byId.get(id);
    if (!s) return;
    st.strokes.splice(st.strokes.indexOf(s), 1);
    st.byId.delete(id);
    if (k === this.key) this.queueRender();
  }

  clear(broadcast, k = this.key) {
    this.stores.set(k, { strokes: [], byId: new Map() });
    this.mine = this.mine.filter((m) => m.k !== k);
    if (k === this.key) this.queueRender();
    if (broadcast) this.send({ t: 'clear', k });
  }

  /** Apply a message received from a presenter/host. */
  apply(m) {
    const k = String(m.k ?? 'main').slice(0, 32);
    if (m.t === 's') {
      const st = this.store(k);
      let s = st.byId.get(m.id);
      if (s && m.sync) return;
      if (!s) { s = { id: String(m.id).slice(0, 16), c: String(m.c).slice(0, 20), w: Math.min(40, Number(m.w) || 4), e: m.e ? 1 : 0, p: [] }; this.add(k, s); }
      for (const pt of m.p || []) if (Array.isArray(pt) && pt.length === 2 && s.p.length < MAX_POINTS) s.p.push([Number(pt[0]) || 0, Number(pt[1]) || 0]);
      if (k === this.key) this.queueRender();
    } else if (m.t === 'undo') this.remove(k, m.id);
    else if (m.t === 'clear') this.clear(false, k);
  }

  /** Messages that recreate every page's drawing for a late joiner. */
  snapshotMessages() {
    const out = [];
    for (const [k, st] of this.stores) {
      for (const s of st.strokes.slice(-300)) {
        for (let i = 0; i < Math.max(1, s.p.length); i += 150) out.push({ t: 's', sync: 1, k, id: s.id, c: s.c, w: s.w, e: s.e, p: s.p.slice(i, i + 150) });
      }
    }
    return out;
  }

  queueRender() { if (!this.raf) this.raf = requestAnimationFrame(() => { this.raf = 0; this.render(); }); }

  render() {
    const { lctx: l, ctx: c, dpr } = this;
    l.setTransform(1, 0, 0, 1, 0, 0);
    l.clearRect(0, 0, this.layer.width, this.layer.height);
    l.setTransform(dpr * this.scale, 0, 0, dpr * this.scale, dpr * this.ox, dpr * this.oy);
    l.lineCap = 'round'; l.lineJoin = 'round';
    for (const s of this.store(this.key).strokes) {
      l.globalCompositeOperation = s.e ? 'destination-out' : 'source-over';
      l.strokeStyle = s.c; l.fillStyle = s.c;
      l.lineWidth = s.e ? s.w * 3 : s.w;
      const p = s.p;
      if (!p.length) continue;
      if (p.length === 1) { l.beginPath(); l.arc(p[0][0], p[0][1], l.lineWidth / 2, 0, Math.PI * 2); l.fill(); continue; }
      l.beginPath();
      l.moveTo(p[0][0], p[0][1]);
      for (let i = 1; i < p.length - 1; i++) l.quadraticCurveTo(p[i][0], p[i][1], (p[i][0] + p[i + 1][0]) / 2, (p[i][1] + p[i + 1][1]) / 2);
      l.lineTo(p[p.length - 1][0], p[p.length - 1][1]);
      l.stroke();
    }
    c.setTransform(1, 0, 0, 1, 0, 0);
    if (this.transparent) c.clearRect(0, 0, this.canvas.width, this.canvas.height);
    else {
      c.fillStyle = '#e5e7eb';
      c.fillRect(0, 0, this.canvas.width, this.canvas.height);
      c.fillStyle = '#fff';
      c.fillRect(this.ox * dpr, this.oy * dpr, BW * this.scale * dpr, this.bh * this.scale * dpr);
    }
    c.drawImage(this.layer, 0, 0);
  }
}
