export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const config = window.CLASSROOM_CONFIG || {};
export const apiBase = () => String(config.api || '').replace(/\/+$/, '');

// ---- login token (kept in this browser; the API lives on another origin so cookies are not used) ----
let memToken = '';
export const getToken = () => { try { return localStorage.getItem('cr-token') || memToken; } catch { return memToken; } };
export const setToken = (t) => { memToken = t || ''; try { t ? localStorage.setItem('cr-token', t) : localStorage.removeItem('cr-token'); } catch { /* storage blocked */ } };

export async function api(path, { method = 'GET', body } = {}) {
  const base = apiBase();
  if (!base || /YOUR-SUBDOMAIN/.test(base)) throw new Error('آدرس Worker در فایل config.js تنظیم نشده است');
  const token = getToken();
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = 'Bearer ' + token;
  let res;
  try {
    res = await fetch(base + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  } catch { throw new Error('اتصال به سرویس برقرار نشد (آدرس Worker و اینترنت را بررسی کنید)'); }
  let data = {};
  try { data = await res.json(); } catch { /* empty */ }
  if (!res.ok) {
    if (res.status === 401 && token && /^\/api\/(me|rooms|payments|admin)/.test(path)) setToken('');   // expired / invalid token
    const err = new Error(data.error || 'خطا در ارتباط با سرویس');
    err.status = res.status;
    throw err;
  }
  return data;
}

export function toast(msg, isErr = false) {
  let box = $('#toasts');
  if (!box) { box = document.createElement('div'); box.id = 'toasts'; document.body.append(box); }
  const t = document.createElement('div');
  t.className = 'toast' + (isErr ? ' err' : '');
  t.textContent = msg;
  box.append(t);
  setTimeout(() => t.remove(), 4000);
}

export const fa = (n) => Number(n ?? 0).toLocaleString('fa-IR');
export const money = (n) => (Number(n) === 0 ? 'رایگان' : fa(n) + ' تومان');
export function fdate(s) {
  if (!s) return '—';
  const d = new Date(/Z|[+-]\d\d:\d\d$/.test(s) ? s : s.replace(' ', 'T') + 'Z');
  return isNaN(d) ? '—' : d.toLocaleString('fa-IR', { dateStyle: 'medium', timeStyle: 'short' });
}
export const fsize = (b) => (b > 1e9 ? (b / 1e9).toFixed(2) + ' GB' : b > 1e6 ? (b / 1e6).toFixed(1) + ' MB' : Math.round(b / 1e3) + ' KB');

export async function loadSettings() {
  const s = await api('/api/settings/public').catch(() => ({}));
  if (s.primary_color) {
    document.documentElement.style.setProperty('--primary', s.primary_color);
    document.documentElement.style.setProperty('--primary-d', `color-mix(in srgb, ${s.primary_color} 82%, black)`);
  }
  const name = s.site_name || config.siteName || '';
  document.title = document.title.replace('{site}', name);
  for (const el of $$('[data-site-name]')) el.textContent = name;
  return s;
}

export async function me() {
  if (!getToken()) return null;
  const u = await api('/api/me').catch(() => ({ guest: true }));
  return u.guest ? null : u;
}

export async function logout() {
  await api('/api/auth/logout', { method: 'POST', body: {} }).catch(() => {});
  setToken('');
}

export function modal(html, { onClose } = {}) {
  const bg = document.createElement('div');
  bg.className = 'modal-bg';
  bg.innerHTML = `<div class="modal">${html}</div>`;
  const close = () => { bg.remove(); onClose?.(); };
  bg.addEventListener('mousedown', (e) => { if (e.target === bg) close(); });
  document.body.append(bg);
  const first = $('input,select,textarea', bg);
  first?.focus();
  return { el: $('.modal', bg), close };
}

/** Only allow redirecting to our own pages (e.g. "dashboard.html?tab=plans" or "room.html#r=abc"). */
export const safeNext = (n) => (typeof n === 'string' && /^[\w-]+\.html([?#][\w\-=&.%#]*)?$/.test(n) ? n : 'dashboard.html');
export const roomLink = (slug) => `${location.origin}${location.pathname.replace(/[^/]*$/, '')}room.html#r=${slug}`;
