// In-browser PowerPoint (.pptx) renderer. No server and no conversion: the file is unzipped with JSZip and every
// slide is drawn on a canvas. It exposes the tiny part of the pdf.js document API that SlideViewer uses
// (numPages, getPage(n).getViewport/render, destroy), so presenting a deck works exactly like presenting a PDF.
//
// Supported: text (sizes, bold/italic, colours, alignment, bullets, RTL/Persian, auto-shrink), shapes (rect, rounded
// rect, ellipse, triangle, diamond, lines, custom paths), solid/gradient/image fills and outlines, pictures with crop,
// groups, tables, slide/layout/master backgrounds and decorations, theme colours and fonts.
// Not supported (drawn as a labelled box): charts, SmartArt, video/audio. Animations and transitions are ignored.

let jszipPromise;
function loadJSZip() {
  jszipPromise ||= new Promise((resolve, reject) => {
    if (window.JSZip) return resolve(window.JSZip);
    const s = document.createElement('script');
    s.src = new URL('./vendor/jszip.min.js', import.meta.url).href;
    s.onload = () => resolve(window.JSZip);
    s.onerror = () => { jszipPromise = null; reject(new Error('بارگیری کتابخانهٔ پاورپوینت ناموفق بود')); };
    document.head.append(s);
  });
  return jszipPromise;
}

const kids = (el, ...names) => (el ? [...el.children].filter((c) => !names.length || names.includes(c.nodeName)) : []);
const kid = (el, name) => (el ? [...el.children].find((c) => c.nodeName === name) || null : null);
const chain = (el, ...names) => { for (const n of names) { el = kid(el, n); if (!el) return null; } return el; };
const attr = (el, n, d) => { const v = el?.getAttribute(n); return v == null ? d : v; };
const num = (el, n, d = 0) => { const v = el?.getAttribute(n); return v == null || v === '' ? d : Number(v); };
const parseXml = (s) => new DOMParser().parseFromString(s, 'application/xml');
const EMU_PT = 12700;

const dirname = (p) => p.slice(0, p.lastIndexOf('/') + 1);
function resolvePath(base, target) {
  if (target.startsWith('/')) return target.slice(1);
  const parts = (dirname(base) + target).split('/'), out = [];
  for (const p of parts) { if (p === '..') out.pop(); else if (p !== '.' && p !== '') out.push(p); }
  return out.join('/');
}

// ---------- colours ----------
const SYS = { black: '000000', white: 'FFFFFF', red: 'FF0000', green: '008000', blue: '0000FF', yellow: 'FFFF00', gray: '808080', grey: '808080' };
function hexToRgb(h) { h = h.replace('#', ''); if (h.length === 3) h = [...h].map((c) => c + c).join(''); const n = parseInt(h.padEnd(6, '0').slice(0, 6), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
function rgbToHsl([r, g, b]) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b); let h = 0, s = 0; const l = (mx + mn) / 2;
  if (mx !== mn) {
    const d = mx - mn; s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
    h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; h /= 6;
  }
  return [h, s, l];
}
function hslToRgb([h, s, l]) {
  if (s === 0) { const v = Math.round(l * 255); return [v, v, v]; }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
  const f = (t) => { t = (t + 1) % 1; return t < 1 / 6 ? p + (q - p) * 6 * t : t < 0.5 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p; };
  return [f(h + 1 / 3), f(h), f(h - 1 / 3)].map((v) => Math.round(v * 255));
}
function colorOf(parent, T) {
  const c = kids(parent).find((k) => /^a:(srgbClr|schemeClr|sysClr|prstClr)$/.test(k.nodeName));
  if (!c) return null;
  let rgb, alpha = 1;
  const n = c.nodeName;
  if (n === 'a:srgbClr') rgb = hexToRgb(attr(c, 'val', '000000'));
  else if (n === 'a:sysClr') rgb = hexToRgb(attr(c, 'lastClr', attr(c, 'val') === 'window' ? 'FFFFFF' : '000000'));
  else if (n === 'a:prstClr') rgb = hexToRgb(SYS[attr(c, 'val', 'black')] || '000000');
  else {
    let v = attr(c, 'val', 'tx1');
    v = T.clrMap[v] || v;
    rgb = hexToRgb(T.colors[v] || (v === 'phClr' ? T.phClr || '000000' : '000000'));
  }
  for (const m of kids(c)) {
    const val = num(m, 'val', 0) / 100000;
    if (m.nodeName === 'a:alpha') alpha = val;
    else if (m.nodeName === 'a:lumMod' || m.nodeName === 'a:lumOff' || m.nodeName === 'a:satMod') {
      const hsl = rgbToHsl(rgb);
      if (m.nodeName === 'a:lumMod') hsl[2] = Math.min(1, hsl[2] * val);
      else if (m.nodeName === 'a:lumOff') hsl[2] = Math.min(1, Math.max(0, hsl[2] + val));
      else hsl[1] = Math.min(1, hsl[1] * val);
      rgb = hslToRgb(hsl);
    } else if (m.nodeName === 'a:tint') rgb = rgb.map((x) => Math.round(x * val + 255 * (1 - val)));
    else if (m.nodeName === 'a:shade') rgb = rgb.map((x) => Math.round(x * val));
  }
  return alpha < 1 ? `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${alpha})` : `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
}

// ---------- text style resolution ----------
function rprops(el, T) {
  if (!el) return {};
  const o = {};
  if (el.hasAttribute('sz')) o.sz = num(el, 'sz') / 100;
  if (el.hasAttribute('b')) o.b = attr(el, 'b') === '1' || attr(el, 'b') === 'true';
  if (el.hasAttribute('i')) o.i = attr(el, 'i') === '1' || attr(el, 'i') === 'true';
  const sf = kid(el, 'a:solidFill');
  if (sf) o.color = colorOf(sf, T);
  const face = (f) => (f === '+mj-lt' ? T.fonts.major : f === '+mn-lt' ? T.fonts.minor : f === '+mj-cs' ? T.fonts.major : f === '+mn-cs' ? T.fonts.minor : f);
  const lat = kid(el, 'a:latin'), cs = kid(el, 'a:cs');
  if (lat && attr(lat, 'typeface')) o.face = face(attr(lat, 'typeface'));
  if (cs && attr(cs, 'typeface')) o.cs = face(attr(cs, 'typeface'));
  return o;
}
function pprops(el, T) {
  if (!el) return {};
  const o = {};
  for (const k of ['algn', 'marL', 'marR', 'indent', 'rtl', 'lvl']) if (el.hasAttribute(k)) o[k] = attr(el, k);
  const sp = (name) => { const e = kid(el, name); if (!e) return undefined; const p = kid(e, 'a:spcPts'), q = kid(e, 'a:spcPct'); return p ? { pts: num(p, 'val') / 100 } : q ? { pct: num(q, 'val') / 100000 } : undefined; };
  for (const [k, n] of [['lnSpc', 'a:lnSpc'], ['spcBef', 'a:spcBef'], ['spcAft', 'a:spcAft']]) { const v = sp(n); if (v) o[k] = v; }
  if (kid(el, 'a:buNone')) o.bu = { none: true };
  const bc = kid(el, 'a:buChar'), ba = kid(el, 'a:buAutoNum');
  if (bc) o.bu = { char: attr(bc, 'char', '•') };
  if (ba) o.bu = { auto: attr(ba, 'type', 'arabicPeriod'), start: num(ba, 'startAt', 1) };
  const bClr = kid(el, 'a:buClr'); if (bClr) o.buColor = colorOf(bClr, T);
  const d = kid(el, 'a:defRPr'); if (d) o.def = rprops(d, T);
  return o;
}
const mergeP = (a, b) => ({ ...a, ...b, def: { ...(a.def || {}), ...(b.def || {}) } });

// ---------- document ----------
export async function openPptx(blob) {
  const JSZip = await loadJSZip();
  const zip = await JSZip.loadAsync(await blob.arrayBuffer());
  const text = async (p) => { const f = zip.file(p); return f ? f.async('string') : null; };
  const xml = async (p) => { const s = await text(p); return s ? parseXml(s) : null; };
  const relsCache = new Map(), partCache = new Map(), imgCache = new Map();

  async function rels(part) {
    if (relsCache.has(part)) return relsCache.get(part);
    const d = await xml(`${dirname(part)}_rels/${part.slice(part.lastIndexOf('/') + 1)}.rels`);
    const m = new Map();
    for (const r of d ? [...d.getElementsByTagName('Relationship')] : []) m.set(r.getAttribute('Id'), { type: r.getAttribute('Type') || '', target: resolvePath(part, r.getAttribute('Target') || '') });
    relsCache.set(part, m);
    return m;
  }
  const relOfType = (m, re) => [...m.values()].find((r) => re.test(r.type));

  const pres = await xml('ppt/presentation.xml');
  if (!pres) throw new Error('فایل پاورپوینت معتبر نیست');
  const sz = pres.getElementsByTagName('p:sldSz')[0];
  const cx = num(sz, 'cx', 9144000), cy = num(sz, 'cy', 6858000);
  const presRels = await rels('ppt/presentation.xml');
  const slidePaths = [...pres.getElementsByTagName('p:sldId')].map((s) => presRels.get(s.getAttribute('r:id'))?.target).filter(Boolean);
  if (!slidePaths.length) throw new Error('اسلایدی در فایل پیدا نشد');

  async function loadTheme(masterPath) {
    const mrels = await rels(masterPath);
    const t = await xml(relOfType(mrels, /theme$/)?.target || 'ppt/theme/theme1.xml');
    const colors = {};
    const cs = t?.getElementsByTagName('a:clrScheme')[0];
    for (const c of kids(cs)) {
      const n = c.nodeName.replace('a:', ''), v = kids(c)[0];
      if (v) colors[n] = v.nodeName === 'a:sysClr' ? attr(v, 'lastClr', '000000') : attr(v, 'val', '000000');
    }
    const fs = t?.getElementsByTagName('a:fontScheme')[0];
    const fonts = { major: attr(chain(fs, 'a:majorFont', 'a:latin'), 'typeface', 'Calibri'), minor: attr(chain(fs, 'a:minorFont', 'a:latin'), 'typeface', 'Calibri') };
    return { colors, fonts };
  }
  async function loadMaster(path) {
    if (partCache.has(path)) return partCache.get(path);
    const doc = await xml(path);
    const { colors, fonts } = await loadTheme(path);
    const clrMap = {};
    const cm = doc.getElementsByTagName('p:clrMap')[0];
    for (const a of cm ? [...cm.attributes] : []) clrMap[a.name] = a.value;
    const part = { path, doc, T: { colors, fonts, clrMap }, rels: await rels(path), tx: chain(doc.documentElement, 'p:txStyles') };
    partCache.set(path, part);
    return part;
  }
  async function loadLayout(path) {
    if (partCache.has(path)) return partCache.get(path);
    const doc = await xml(path);
    const lrels = await rels(path);
    const master = await loadMaster(relOfType(lrels, /slideMaster$/).target);
    const part = { path, doc, rels: lrels, master, T: master.T };
    partCache.set(path, part);
    return part;
  }

  async function image(part, rid) {
    const r = part.rels.get(rid);
    if (!r) return null;
    if (imgCache.has(r.target)) return imgCache.get(r.target);
    const p = (async () => {
      const f = zip.file(r.target);
      if (!f) return null;
      const ext = r.target.split('.').pop().toLowerCase();
      const type = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp' }[ext];
      if (!type) return null;                         // emf / wmf / tiff: not drawable by browsers
      const url = URL.createObjectURL(new Blob([await f.async('arraybuffer')], { type }));
      try { const img = new Image(); img.src = url; await img.decode(); return img; } catch { return null; } finally { setTimeout(() => URL.revokeObjectURL(url), 60000); }
    })();
    imgCache.set(r.target, p);
    return p;
  }

  // ----- rendering of one slide -----
  async function renderSlide(n, ctx, W, H, cancelled) {
    const spath = slidePaths[n - 1];
    const doc = await xml(spath);
    const srels = await rels(spath);
    const layout = await loadLayout(relOfType(srels, /slideLayout$/).target);
    const master = layout.master;
    const slide = { path: spath, doc, rels: srels, master, layout, T: master.T };
    const k = W / cx;

    ctx.save();
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);

    // background: slide -> layout -> master
    for (const part of [slide, layout, master]) {
      const bg = chain(part.doc.documentElement, 'p:cSld', 'p:bg');
      if (!bg) continue;
      const pr = kid(bg, 'p:bgPr'), ref = kid(bg, 'p:bgRef');
      let fill = pr ? await fillOf(pr, part.T, part) : ref ? { type: 'solid', color: colorOf(ref, part.T) } : null;
      if (fill && fill.type !== 'none') { await paintFill(ctx, fill, 0, 0, W, H, part); break; }
    }

    const ident = { sx: 1, sy: 1, tx: 0, ty: 0 };
    const ctxo = { ctx, k, W, H, cancelled };
    const drawTree = async (part, onlyNonPh) => {
      const tree = chain(part.doc.documentElement, 'p:cSld', 'p:spTree');
      if (tree) await drawNodes(ctxo, tree, ident, part, slide, onlyNonPh);
    };
    if (attr(layout.doc.documentElement, 'showMasterSp', '1') !== '0' && attr(doc.documentElement, 'showMasterSp', '1') !== '0') await drawTree(master, true);
    if (attr(doc.documentElement, 'showMasterSp', '1') !== '0') await drawTree(layout, true);
    await drawTree(slide, false);
    ctx.restore();
  }

  // ----- fills / lines -----
  async function fillOf(spPr, T, part) {
    for (const c of kids(spPr)) {
      if (c.nodeName === 'a:noFill') return { type: 'none' };
      if (c.nodeName === 'a:solidFill') return { type: 'solid', color: colorOf(c, T) };
      if (c.nodeName === 'a:gradFill') {
        const stops = kids(chain(c, 'a:gsLst')).map((g) => ({ pos: num(g, 'pos') / 100000, color: colorOf(g, T) }));
        const lin = kid(c, 'a:lin');
        return { type: 'grad', stops, angle: lin ? num(lin, 'ang') / 60000 : 90, path: !!kid(c, 'a:path') };
      }
      if (c.nodeName === 'a:blipFill') {
        const blip = kid(c, 'a:blip');
        return { type: 'img', rid: attr(blip, 'r:embed'), src: kid(c, 'a:srcRect') };
      }
      if (c.nodeName === 'a:pattFill') return { type: 'solid', color: colorOf(kid(c, 'a:fgClr'), T) };
    }
    return null;
  }
  async function paintFill(ctx, f, x, y, w, h, part, pathFn) {
    ctx.save();
    if (pathFn) { pathFn(); ctx.clip(); }
    if (f.type === 'solid' && f.color) { ctx.fillStyle = f.color; pathFn ? ctx.fillRect(x - 1, y - 1, w + 2, h + 2) : ctx.fillRect(x, y, w, h); }
    else if (f.type === 'grad' && f.stops.length) {
      let g;
      if (f.path) g = ctx.createRadialGradient(x + w / 2, y + h / 2, 0, x + w / 2, y + h / 2, Math.max(w, h) / 2);
      else {
        const a = (f.angle * Math.PI) / 180, dx = Math.cos(a), dy = Math.sin(a), len = Math.abs(w * dx) + Math.abs(h * dy);
        const cxx = x + w / 2, cyy = y + h / 2;
        g = ctx.createLinearGradient(cxx - (dx * len) / 2, cyy - (dy * len) / 2, cxx + (dx * len) / 2, cyy + (dy * len) / 2);
      }
      for (const s of f.stops) { try { g.addColorStop(Math.min(1, Math.max(0, s.pos)), s.color || '#000'); } catch { /* bad stop */ } }
      ctx.fillStyle = g; ctx.fillRect(x - 1, y - 1, w + 2, h + 2);
    } else if (f.type === 'img') {
      const img = await image(part, f.rid);
      if (img) drawImageCropped(ctx, img, f.src, x, y, w, h);
    }
    ctx.restore();
  }
  function drawImageCropped(ctx, img, srcRect, x, y, w, h) {
    const l = num(srcRect, 'l') / 100000, t = num(srcRect, 't') / 100000, r = num(srcRect, 'r') / 100000, b = num(srcRect, 'b') / 100000;
    const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
    ctx.drawImage(img, iw * l, ih * t, Math.max(1, iw * (1 - l - r)), Math.max(1, ih * (1 - t - b)), x, y, w, h);
  }
  function lineOf(spPr, T, node, k) {
    const ln = kid(spPr, 'a:ln');
    let color = null, width = 0, dash = null;
    if (ln) {
      width = num(ln, 'w', 12700) * k;
      if (kid(ln, 'a:noFill')) return null;
      const sf = kid(ln, 'a:solidFill');
      if (sf) color = colorOf(sf, T);
      const d = attr(kid(ln, 'a:prstDash'), 'val');
      if (d && d !== 'solid') dash = d;
    }
    if (!color) {
      const ref = chain(node, 'p:style', 'a:lnRef');
      if (ref && num(ref, 'idx') > 0 && !(ln && kid(ln, 'a:noFill'))) { color = colorOf(ref, T); width = width || 12700 * k; }
    }
    return color ? { color, width: Math.max(1, width), dash } : null;
  }

  // ----- geometry -----
  function xfrmOf(el) {
    const x = el && (kid(el, 'a:xfrm') || kid(el, 'p:xfrm'));
    if (!x) return null;
    const off = kid(x, 'a:off'), ext = kid(x, 'a:ext');
    return { x: num(off, 'x'), y: num(off, 'y'), w: num(ext, 'cx'), h: num(ext, 'cy'), rot: num(x, 'rot') / 60000, fh: attr(x, 'flipH') === '1', fv: attr(x, 'flipV') === '1', chX: num(kid(x, 'a:chOff'), 'x'), chY: num(kid(x, 'a:chOff'), 'y'), chW: num(kid(x, 'a:chExt'), 'cx'), chH: num(kid(x, 'a:chExt'), 'cy') };
  }
  function shapePath(ctx, geom, w, h) {
    const prst = attr(kid(geom, 'a:prstGeom'), 'prst', 'rect');
    const cust = kid(geom, 'a:custGeom');
    ctx.beginPath();
    if (cust) {
      const p = chain(cust, 'a:pathLst', 'a:path');
      if (!p) { ctx.rect(0, 0, w, h); return; }
      const pw = num(p, 'w', w) || w, ph = num(p, 'h', h) || h, sx = w / pw, sy = h / ph;
      const pt = (e) => [num(e, 'x') * sx, num(e, 'y') * sy];
      for (const c of kids(p)) {
        const pts = kids(c, 'a:pt');
        if (c.nodeName === 'a:moveTo') ctx.moveTo(...pt(pts[0]));
        else if (c.nodeName === 'a:lnTo') ctx.lineTo(...pt(pts[0]));
        else if (c.nodeName === 'a:cubicBezTo') ctx.bezierCurveTo(...pt(pts[0]), ...pt(pts[1]), ...pt(pts[2]));
        else if (c.nodeName === 'a:quadBezTo') ctx.quadraticCurveTo(...pt(pts[0]), ...pt(pts[1]));
        else if (c.nodeName === 'a:close') ctx.closePath();
      }
      return;
    }
    const av = (name, d) => { const g = [...(geom?.getElementsByTagName('a:gd') || [])].find((e) => e.getAttribute('name') === name); const m = /val (-?\d+)/.exec(g?.getAttribute('fmla') || ''); return m ? Number(m[1]) : d; };
    if (prst === 'ellipse') ctx.ellipse(w / 2, h / 2, Math.abs(w / 2), Math.abs(h / 2), 0, 0, Math.PI * 2);
    else if (prst === 'roundRect') { const r = (Math.min(w, h) * av('adj', 16667)) / 100000; ctx.roundRect(0, 0, w, h, r); }
    else if (prst === 'triangle') { const a = (w * av('adj', 50000)) / 100000; ctx.moveTo(a, 0); ctx.lineTo(w, h); ctx.lineTo(0, h); ctx.closePath(); }
    else if (prst === 'rtTriangle') { ctx.moveTo(0, 0); ctx.lineTo(w, h); ctx.lineTo(0, h); ctx.closePath(); }
    else if (prst === 'diamond') { ctx.moveTo(w / 2, 0); ctx.lineTo(w, h / 2); ctx.lineTo(w / 2, h); ctx.lineTo(0, h / 2); ctx.closePath(); }
    else if (prst === 'parallelogram') { const a = (Math.min(w, h) * av('adj', 25000)) / 100000; ctx.moveTo(a, 0); ctx.lineTo(w, 0); ctx.lineTo(w - a, h); ctx.lineTo(0, h); ctx.closePath(); }
    else if (prst === 'rightArrow') { const hh = h * 0.3, nx = w * 0.6; ctx.moveTo(0, hh); ctx.lineTo(nx, hh); ctx.lineTo(nx, 0); ctx.lineTo(w, h / 2); ctx.lineTo(nx, h); ctx.lineTo(nx, h - hh); ctx.lineTo(0, h - hh); ctx.closePath(); }
    else if (/^(line|straightConnector1|bentConnector\d|curvedConnector\d)$/.test(prst)) { ctx.moveTo(0, 0); ctx.lineTo(w, h); }
    else ctx.rect(0, 0, w, h);
  }

  // ----- placeholders -----
  const phOf = (node) => chain(node, 'p:nvSpPr', 'p:nvPr', 'p:ph') || chain(node, 'p:nvPicPr', 'p:nvPr', 'p:ph') || chain(node, 'p:nvGraphicFramePr', 'p:nvPr', 'p:ph');
  const phType = (ph) => { const t = attr(ph, 'type', 'body'); return t === 'ctrTitle' ? 'title' : t === 'subTitle' ? 'body' : t; };
  function findPh(part, ph) {
    const tree = chain(part.doc.documentElement, 'p:cSld', 'p:spTree');
    if (!tree || !ph) return null;
    const cands = kids(tree, 'p:sp', 'p:pic', 'p:graphicFrame').filter((s) => phOf(s));
    const idx = attr(ph, 'idx');
    return cands.find((s) => idx != null && attr(phOf(s), 'idx') === idx && phType(phOf(s)) === phType(ph))
      || cands.find((s) => phType(phOf(s)) === phType(ph) && (idx == null || attr(phOf(s), 'idx') == null))
      || (idx != null ? cands.find((s) => attr(phOf(s), 'idx') === idx) : null);
  }

  async function drawNodes(o, tree, m, part, slide, onlyNonPh) {
    for (const node of kids(tree)) {
      if (o.cancelled()) return;
      try {
        const nm = node.nodeName;
        if (nm === 'p:grpSp') {
          if (onlyNonPh && false) continue;
          const gx = xfrmOf(chain(node, 'p:grpSpPr'));
          let m2 = m;
          if (gx && gx.chW && gx.chH) {
            const sx = gx.w / gx.chW, sy = gx.h / gx.chH;
            m2 = { sx: m.sx * sx, sy: m.sy * sy, tx: m.tx + m.sx * (gx.x - gx.chX * sx), ty: m.ty + m.sy * (gx.y - gx.chY * sy) };
          }
          await drawNodes(o, node, m2, part, slide, onlyNonPh);
        } else if (nm === 'p:sp' || nm === 'p:pic' || nm === 'p:cxnSp' || nm === 'p:graphicFrame') {
          const ph = phOf(node);
          if (onlyNonPh && ph) continue;
          if (attr(chain(node, 'p:nvSpPr', 'p:cNvPr'), 'hidden') === '1') continue;
          await drawNode(o, node, m, part, slide, ph);
        }
      } catch (e) { console.warn('pptx: skipped a shape', e); }
    }
  }

  async function drawNode(o, node, m, part, slide, ph) {
    const { ctx, k } = o;
    const nm = node.nodeName;
    const spPr = kid(node, 'p:spPr') || kid(node, 'p:grpSpPr');
    let xf = xfrmOf(spPr) || xfrmOf(node);
    let inh = [];          // placeholder chain: layout shape, master shape
    if (ph && part === slide) {
      for (const p of [slide.layout, slide.master]) { const s = findPh(p, ph); if (s) inh.push({ node: s, part: p }); }
      if (!xf) for (const i of inh) { xf = xfrmOf(kid(i.node, 'p:spPr')); if (xf) break; }
    } else if (ph) {
      inh = [];
    }
    if (!xf) return;
    const X = (m.tx + m.sx * xf.x) * k, Y = (m.ty + m.sy * xf.y) * k, w = m.sx * xf.w * k, h = m.sy * xf.h * k;
    const T = part.T;

    ctx.save();
    ctx.translate(X + w / 2, Y + h / 2);
    if (xf.rot) ctx.rotate((xf.rot * Math.PI) / 180);
    ctx.scale(xf.fh ? -1 : 1, xf.fv ? -1 : 1);
    ctx.translate(-w / 2, -h / 2);

    if (nm === 'p:pic') {
      const blip = chain(node, 'p:blipFill', 'a:blip');
      const img = blip ? await image(part, attr(blip, 'r:embed')) : null;
      if (img) drawImageCropped(ctx, img, chain(node, 'p:blipFill', 'a:srcRect'), 0, 0, w, h);
      else { ctx.strokeStyle = '#cbd5e1'; ctx.strokeRect(0, 0, w, h); }
    } else if (nm === 'p:graphicFrame') {
      const tbl = node.getElementsByTagName('a:tbl')[0];
      if (tbl) await drawTable(o, tbl, w, h, part, T);
      else {
        ctx.fillStyle = '#f1f5f9'; ctx.fillRect(0, 0, w, h); ctx.strokeStyle = '#cbd5e1'; ctx.strokeRect(0, 0, w, h);
        ctx.fillStyle = '#64748b'; ctx.font = `${Math.max(12, Math.min(h / 8, 28))}px Vazirmatn, Tahoma, sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText('نمودار / SmartArt (در نمایش پشتیبانی نمی‌شود)', w / 2, h / 2);
      }
    } else {
      const geom = spPr;
      const fill = (await fillOf(spPr, T, part)) || (() => { const ref = chain(node, 'p:style', 'a:fillRef'); return ref && num(ref, 'idx') > 0 ? { type: 'solid', color: colorOf(ref, T) } : null; })();
      const ln = lineOf(spPr, T, node, k);
      const isLine = /^(line|straightConnector1|bentConnector\d|curvedConnector\d)$/.test(attr(chain(spPr, 'a:prstGeom'), 'prst', ''));
      const pathFn = () => shapePath(ctx, geom, w, h);
      if (fill && fill.type !== 'none' && !isLine) await paintFill(ctx, fill, 0, 0, w, h, part, pathFn);
      if (ln) {
        ctx.beginPath(); shapePath(ctx, geom, w, h);
        ctx.strokeStyle = ln.color; ctx.lineWidth = ln.width; ctx.lineJoin = 'round';
        if (ln.dash) ctx.setLineDash(ln.dash.includes('dot') ? [ln.width, ln.width * 2] : [ln.width * 4, ln.width * 2.5]);
        ctx.stroke(); ctx.setLineDash([]);
      }
      const tx = kid(node, 'p:txBody');
      if (tx) await drawText(o, tx, 0, 0, w, h, { part, T, ph, inh, node, k });
    }
    ctx.restore();
  }

  async function drawTable(o, tbl, w, h, part, T) {
    const { ctx, k } = o;
    const cols = kids(chain(tbl, 'a:tblGrid')).map((c) => num(c, 'w') * k);
    let y = 0;
    for (const tr of kids(tbl, 'a:tr')) {
      const rh = num(tr, 'h') * k;
      let x = 0, ci = 0;
      for (const tc of kids(tr, 'a:tc')) {
        const span = num(tc, 'gridSpan', 1), cw = cols.slice(ci, ci + span).reduce((a, b) => a + b, 0);
        const pr = kid(tc, 'a:tcPr');
        const f = pr ? await fillOf(pr, T, part) : null;
        if (f && f.type !== 'none') await paintFill(ctx, f, x, y, cw, rh, part);
        ctx.strokeStyle = '#94a3b8'; ctx.lineWidth = Math.max(1, k * 9525); ctx.strokeRect(x, y, cw, rh);
        const tx = kid(tc, 'a:txBody');
        if (tx && attr(tc, 'hMerge') !== '1' && attr(tc, 'vMerge') !== '1') await drawText(o, tx, x, y, cw, rh, { part, T, ph: null, inh: [], node: tc, k, cell: true });
        x += cw; ci += span;
      }
      y += rh;
    }
  }

  // ----- text -----
  async function drawText(o, txBody, X, Y, W, H, S) {
    const { ctx, k } = o, { T } = S;
    // style chain, lowest priority first
    const lst = [];
    const ph = S.ph;
    const tx = S.part.master?.tx || S.part.tx || S.part.master?.master?.tx;
    const master = S.part.master || (S.part.T ? S.part : null);
    const mTx = (master && master.tx) || (S.part.layout?.master?.tx);
    const kind = !ph ? 'otherStyle' : ['title'].includes(phType(ph)) ? 'titleStyle' : ['body', 'obj', 'subTitle'].includes(phType(ph)) || attr(ph, 'idx') ? 'bodyStyle' : 'otherStyle';
    const style = chain(mTx || tx, `p:${kind}`);
    if (style) lst.push(style);
    for (const i of [...S.inh].reverse()) { const l = chain(i.node, 'p:txBody', 'a:lstStyle'); if (l) lst.push(l); }
    const own = kid(txBody, 'a:lstStyle'); if (own) lst.push(own);
    const lvlProps = (lvl) => lst.reduce((acc, l) => mergeP(acc, pprops(kid(l, `a:lvl${lvl + 1}pPr`), T)), {});

    // body properties (inherit anchor/insets from placeholders)
    const bps = [...S.inh].reverse().map((i) => chain(i.node, 'p:txBody', 'a:bodyPr')).filter(Boolean);
    const bp = kid(txBody, 'a:bodyPr');
    const bpa = (n, d) => { let v = attr(bp, n); for (let i = bps.length - 1; v == null && i >= 0; i--) v = attr(bps[i], n); return v == null ? d : v; };
    const cell = !!S.cell;
    const ins = { l: Number(bpa('lIns', cell ? 91440 : 91440)) * k, r: Number(bpa('rIns', 91440)) * k, t: Number(bpa('tIns', 45720)) * k, b: Number(bpa('bIns', 45720)) * k };
    const anchor = cell ? attr(kid(S.node, 'a:tcPr'), 'anchor', 't') : bpa('anchor', 't');
    const fitEl = kid(bp, 'a:normAutofit') || bps.map((b) => kid(b, 'a:normAutofit')).find(Boolean);
    let fontScale = fitEl ? num(fitEl, 'fontScale', 100000) / 100000 : 1;
    const hasFit = !!fitEl;
    const boxW = W - ins.l - ins.r, boxH = H - ins.t - ins.b;
    if (boxW < 4) return;

    // paragraphs -> styled tokens
    const paras = [];
    let autoNum = {};
    for (const p of kids(txBody, 'a:p')) {
      const pPr = kid(p, 'a:pPr');
      const lvl = Math.min(8, num(pPr, 'lvl', 0));
      const props = mergeP(lvlProps(lvl), pprops(pPr, T));
      const tokens = [];
      for (const r of kids(p)) {
        if (r.nodeName === 'a:br') { tokens.push({ br: true, st: props.def }); continue; }
        if (r.nodeName !== 'a:r' && r.nodeName !== 'a:fld') continue;
        const t = kid(r, 'a:t')?.textContent ?? '';
        const st = { ...props.def, ...rprops(kid(r, 'a:rPr'), T) };
        for (const part of t.split(/( +)/)) if (part) tokens.push({ text: part, st });
      }
      const endSz = rprops(kid(p, 'a:endParaRPr'), T).sz;
      paras.push({ props, lvl, tokens, endSz });
    }

    const defFace = (st) => {
      const face = st.face || T.fonts.minor || 'Calibri';
      return `"${face}", Vazirmatn, Tahoma, Arial, sans-serif`;
    };
    const fontOf = (st, szPx) => `${st.i ? 'italic ' : ''}${st.b ? 'bold ' : ''}${szPx}px ${defFace(st)}`;

    function layout(scale) {
      const lines = [];
      let totalH = 0;
      autoNum = {};
      for (const para of paras) {
        const pr = para.props;
        const rtl = pr.rtl === '1';
        const marL = (Number(pr.marL ?? (para.lvl ? para.lvl * 457200 : 0))) * k, indent = Number(pr.indent ?? 0) * k;
        const marR = Number(pr.marR ?? 0) * k;
        const algn = pr.algn || (rtl ? 'r' : 'l');
        const hasBu = pr.bu && !pr.bu.none && para.tokens.some((t) => !t.br);
        const baseSz = (st) => (st.sz || 18) * EMU_PT * k * scale;
        let bullet = null;
        if (hasBu) {
          if (pr.bu.char) bullet = pr.bu.char;
          else { autoNum[para.lvl] = (autoNum[para.lvl] ?? pr.bu.start - 1) + 1; bullet = autoNum[para.lvl] + (pr.bu.auto?.includes('Paren') ? ')' : '.'); }
          for (const l of Object.keys(autoNum)) if (Number(l) > para.lvl) delete autoNum[l];
        } else for (const l of Object.keys(autoNum)) if (Number(l) >= para.lvl) delete autoNum[l];
        const firstSt = para.tokens.find((t) => t.st)?.st || {};
        const spcB = pr.spcBef ? (pr.spcBef.pts != null ? pr.spcBef.pts * EMU_PT * k * scale : pr.spcBef.pct * baseSz(firstSt)) : 0;
        const spcA = pr.spcAft ? (pr.spcAft.pts != null ? pr.spcAft.pts * EMU_PT * k * scale : pr.spcAft.pct * baseSz(firstSt)) : 0;
        const lnF = pr.lnSpc?.pct ?? (pr.lnSpc?.pts ? null : 1);

        // wrap
        const avail = (first) => boxW - marL - marR - (first ? (bullet ? 0 : indent) : 0);
        let cur = { toks: [], w: 0, size: 0 };
        const rows = [];
        const push = () => { rows.push(cur); cur = { toks: [], w: 0, size: 0 }; };
        for (const tk of para.tokens) {
          if (tk.br) { cur.size = Math.max(cur.size, baseSz(tk.st || {})); push(); continue; }
          const size = baseSz(tk.st);
          ctx.font = fontOf(tk.st, size);
          const tw = ctx.measureText(tk.text).width;
          const isSpace = /^ +$/.test(tk.text);
          if (!isSpace && cur.w + tw > avail(rows.length === 0) && cur.toks.some((t) => !/^ +$/.test(t.text))) {
            while (cur.toks.length && /^ +$/.test(cur.toks[cur.toks.length - 1].text)) { cur.w -= cur.toks.pop().w; }
            push();
          }
          if (isSpace && cur.toks.length === 0) continue;
          cur.toks.push({ ...tk, w: tw, size });
          cur.w += tw; cur.size = Math.max(cur.size, size);
        }
        if (cur.toks.length || !rows.length) { if (!cur.size) cur.size = baseSz({ sz: para.endSz || firstSt.sz }); push(); }
        rows.forEach((r, i) => {
          while (r.toks.length && /^ +$/.test(r.toks[r.toks.length - 1].text)) r.w -= r.toks.pop().w;
          r.lh = lnF != null ? r.size * 1.2 * lnF : pr.lnSpc.pts * EMU_PT * k * scale;
          r.first = i === 0; r.bullet = i === 0 ? bullet : null; r.spcB = i === 0 ? spcB : 0; r.spcA = i === rows.length - 1 ? spcA : 0;
          r.rtl = rtl; r.algn = algn; r.marL = marL; r.marR = marR; r.indent = indent; r.buColor = pr.buColor; r.buSt = firstSt;
          totalH += r.lh + r.spcB + r.spcA;
        });
        lines.push(...rows);
      }
      return { lines, totalH };
    }

    let scale = fontScale, L = layout(scale);
    if (hasFit && L.totalH > boxH) {
      for (let i = 0; i < 8 && L.totalH > boxH && scale > 0.3; i++) { scale *= Math.max(0.5, Math.sqrt(boxH / L.totalH)) * 0.98; L = layout(scale); }
    }

    let y = Y + ins.t;
    if (anchor === 'ctr') y += (boxH - L.totalH) / 2; else if (anchor === 'b') y += boxH - L.totalH;
    ctx.textBaseline = 'alphabetic';
    for (const r of L.lines) {
      y += r.spcB;
      const left = X + ins.l, right = X + W - ins.r;
      const startEdge = r.rtl ? right - r.marR - r.marL : left + r.marL;
      const firstOff = r.first && !r.bullet ? r.indent : 0;
      const width = r.w;
      const availW = boxW - r.marL - r.marR - firstOff;
      let x;
      const align = r.algn === 'ctr' ? 'c' : r.algn === 'r' ? 'r' : 'l';
      if (r.rtl) {
        const rightEdge = startEdge - (r.first && !r.bullet ? r.indent : 0);
        x = align === 'l' ? rightEdge - availW + width : align === 'c' ? rightEdge - (availW - width) / 2 : rightEdge;
      } else {
        const leftEdge = startEdge + firstOff;
        x = align === 'r' ? leftEdge + availW - width : align === 'c' ? leftEdge + (availW - width) / 2 : leftEdge;
      }
      const base = y + r.size * 1.0;
      if (r.bullet) {
        ctx.font = fontOf(r.buSt, r.size); ctx.fillStyle = r.buColor || r.buSt.color || '#000';
        ctx.direction = r.rtl ? 'rtl' : 'ltr'; ctx.textAlign = r.rtl ? 'right' : 'left';
        const bx = r.rtl ? right - r.marR - r.marL - r.indent : left + r.marL + r.indent;
        ctx.fillText(r.bullet, bx, base);
      }
      ctx.textAlign = 'left';
      for (const tk of r.toks) {
        ctx.font = fontOf(tk.st, tk.size); ctx.fillStyle = tk.st.color || '#000'; ctx.direction = r.rtl ? 'rtl' : 'ltr';
        if (r.rtl) { x -= tk.w; ctx.fillText(tk.text, x, base); }
        else { ctx.fillText(tk.text, x, base); x += tk.w; }
        if (tk.st.u) { ctx.fillRect(r.rtl ? x : x - tk.w, base + tk.size * 0.1, tk.w, Math.max(1, tk.size / 18)); }
      }
      y += r.lh + r.spcA;
    }
    ctx.direction = 'ltr';
  }

  // ----- pdf.js-like facade -----
  return {
    numPages: slidePaths.length,
    getPage: async (n) => ({
      getViewport: ({ scale }) => ({ width: (cx / EMU_PT) * scale, height: (cy / EMU_PT) * scale }),
      render: ({ canvasContext, viewport }) => {
        let stop = false;
        const promise = renderSlide(n, canvasContext, viewport.width, viewport.height, () => stop).then(() => { if (stop) throw new Error('cancelled'); });
        return { promise, cancel: () => { stop = true; } };
      },
    }),
    destroy: () => { imgCache.clear(); partCache.clear(); relsCache.clear(); },
  };
}
