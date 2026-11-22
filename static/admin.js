import { $, $$, api, esc, toast, loadSettings, me, modal, money, fa, fdate, logout } from './common.js';

await loadSettings();
const admin = await me();
if (!admin || admin.role !== 'admin') {
  location.href = admin ? 'dashboard.html' : 'login.html?next=admin.html';
  await new Promise(() => {}); // stop here; the browser is navigating away
}

$('#logout').onclick = async () => { await logout(); location.href = './'; };
const view = $('#v');
let current = 'overview';
const err = (e) => toast(e.message, true);
const planName = (plans, id) => plans.find((p) => p.id === id)?.name || '—';

const views = { overview, users, rooms, plans, payments, settings };
function show(name) {
  current = name;
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  view.onclick = null;
  views[name]().catch(err);
}
$$('.tab').forEach((t) => (t.onclick = () => show(t.dataset.tab)));

function pager(box, d, go) {
  const pages = Math.max(1, Math.ceil(d.total / d.size));
  box.innerHTML = `<span class="muted">${fa(d.total)} مورد · صفحه ${fa(d.page)} از ${fa(pages)}</span>
    <button class="btn sm" ${d.page <= 1 ? 'disabled' : ''} data-p="${d.page - 1}">قبلی</button>
    <button class="btn sm" ${d.page >= pages ? 'disabled' : ''} data-p="${d.page + 1}">بعدی</button>`;
  box.onclick = (e) => { const b = e.target.closest('[data-p]'); if (b) go(Number(b.dataset.p)); };
}

// ---------- overview ----------
async function overview() {
  const [s, live] = await Promise.all([api('/api/admin/stats'), api('/api/admin/live')]);
  const days = [];
  for (let i = 13; i >= 0; i--) { const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10); days.push([d, s.daily.find((x) => x.d === d)?.c || 0]); }
  const max = Math.max(1, ...days.map((d) => d[1]));
  const stat = (n, l) => `<div class="card stat"><div class="num">${n}</div><div class="muted">${l}</div></div>`;
  view.innerHTML = `
    <div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(180px,1fr))">
      ${stat(fa(s.users), `کاربران (${fa(s.new_users_7d)} جدید در ۷ روز)`)}
      ${stat(fa(s.rooms), 'اتاق‌ها')}
      ${stat(fa(s.joins_30d), 'ورود به اتاق (۳۰ روز)')}
      ${stat(fa(Math.round(s.minutes_30d / 60)), 'ساعت حضور (۳۰ روز)')}
      ${stat(fa(s.revenue_30d), 'درآمد ۳۰ روز (تومان)')}
      ${stat(fa(s.revenue), 'درآمد کل (تومان)')}
    </div>
    <div class="grid" style="margin-top:1rem;grid-template-columns:2fr 1fr">
      <div class="card"><h3>ورود شرکت‌کنندگان در ۱۴ روز اخیر</h3>
        <div class="bars">${days.map(([, c]) => `<div style="height:${(c / max) * 100}%"><span>${c ? fa(c) : ''}</span></div>`).join('')}</div>
        <div class="bars-x">${days.map(([d]) => `<span>${fa(d.slice(8))}</span>`).join('')}</div></div>
      <div class="card"><h3>اتاق‌های زنده</h3>
        ${!live.ok ? `<p class="muted">⚠️ ${esc(live.error)}</p>` : live.rooms.length ? live.rooms.map((r) => `<div class="row spread" style="margin-bottom:.4rem"><a href="room.html#r=${esc(r.slug)}" target="_blank" rel="noopener">${esc(r.title)}</a><span class="badge ok">${fa(r.participants)} نفر</span></div>`).join('') : '<p class="muted">اتاق فعالی وجود ندارد.</p>'}</div>
    </div>`;
  badge(s.pending_payments);
}
function badge(n) { const b = $('#pay-badge'); b.textContent = fa(n); b.classList.toggle('hidden', !n); }

// ---------- users ----------
async function users(page = 1, q = '') {
  const [d, plansList] = await Promise.all([api(`/api/admin/users?page=${page}&q=${encodeURIComponent(q)}`), api('/api/admin/plans')]);
  view.innerHTML = `
    <div class="row spread" style="margin-bottom:1rem"><form id="sf" class="row"><input id="q" placeholder="جستجوی نام یا ایمیل" value="${esc(q)}" style="width:260px"><button class="btn">جستجو</button></form><button class="btn primary" id="add">+ کاربر جدید</button></div>
    <div class="table-wrap"><table><tr><th>نام</th><th>ایمیل</th><th>نقش</th><th>پلن</th><th>اتاق</th><th>عضویت</th><th>وضعیت</th><th></th></tr>
    ${d.items.map((u) => `<tr>
      <td>${esc(u.name)}</td><td class="ltr">${esc(u.email)}</td>
      <td>${u.role === 'admin' ? '<span class="badge">مدیر</span>' : 'کاربر'}</td>
      <td>${esc(planName(plansList, u.plan_id))}${u.plan_expires ? `<br><span class="muted">تا ${fdate(u.plan_expires)}</span>` : ''}</td>
      <td>${fa(u.rooms)}</td><td>${fdate(u.created_at)}</td>
      <td><span class="badge ${u.active ? 'ok' : 'bad'}">${u.active ? 'فعال' : 'مسدود'}</span></td>
      <td class="row"><button class="btn sm" data-edit="${u.id}">ویرایش</button><button class="btn sm danger" data-del="${u.id}">حذف</button></td></tr>`).join('')}</table></div>
    <div class="row" id="pg" style="margin-top:1rem"></div>`;
  pager($('#pg'), d, (p) => users(p, q));
  $('#sf').onsubmit = (e) => { e.preventDefault(); users(1, $('#q').value); };
  $('#add').onclick = () => userForm(null, plansList, () => users(page, q));
  view.onclick = async (e) => {
    const ed = e.target.closest('[data-edit]'), del = e.target.closest('[data-del]');
    if (ed) userForm(d.items.find((u) => u.id === Number(ed.dataset.edit)), plansList, () => users(page, q));
    if (del) {
      const u = d.items.find((x) => x.id === Number(del.dataset.del));
      if (confirm(`کاربر «${u.name}» با همه اتاق‌هایش حذف شود؟`)) api('/api/admin/users/' + u.id, { method: 'DELETE' }).then(() => { toast('حذف شد'); users(page, q); }).catch(err);
    }
  };
}

function userForm(u, plansList, done) {
  const m = modal(`<h3>${u ? 'ویرایش کاربر' : 'کاربر جدید'}</h3><form>
    <label>نام</label><input name="name" required value="${esc(u?.name || '')}">
    <label>ایمیل</label><input name="email" type="email" required class="ltr" value="${esc(u?.email || '')}">
    <label>رمز عبور ${u ? '(خالی = بدون تغییر)' : '(حداقل ۸ کاراکتر)'}</label><input name="password" type="password" class="ltr" ${u ? '' : 'required'} minlength="8" autocomplete="new-password">
    <label>نقش</label><select name="role"><option value="user">کاربر</option><option value="admin" ${u?.role === 'admin' ? 'selected' : ''}>مدیر</option></select>
    <label>پلن</label><select name="plan_id">${plansList.map((p) => `<option value="${p.id}" ${p.id === u?.plan_id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select>
    <label>انقضای پلن (خالی = بدون انقضا)</label><input name="plan_expires" type="date" class="ltr" value="${u?.plan_expires ? u.plan_expires.slice(0, 10) : ''}">
    ${u ? `<div class="check"><input type="checkbox" name="active" ${u.active ? 'checked' : ''}><span>حساب فعال باشد</span></div>` : ''}
    <div class="actions"><button class="btn primary">ذخیره</button><button type="button" class="btn" data-close>انصراف</button></div></form>`);
  $('[data-close]', m.el).onclick = m.close;
  $('form', m.el).onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const body = { name: f.get('name'), email: f.get('email'), role: f.get('role'), plan_id: Number(f.get('plan_id')), plan_expires: f.get('plan_expires') ? new Date(f.get('plan_expires') + 'T23:59:59Z').toISOString() : '' };
    if (f.get('password')) body.password = f.get('password');
    if (u) body.active = f.has('active');
    try { await api(u ? '/api/admin/users/' + u.id : '/api/admin/users', { method: u ? 'PATCH' : 'POST', body }); m.close(); toast('ذخیره شد'); done(); } catch (er) { err(er); }
  };
}

// ---------- rooms ----------
async function rooms(page = 1, q = '') {
  const d = await api(`/api/admin/rooms?page=${page}&q=${encodeURIComponent(q)}`);
  view.innerHTML = `
    <form id="sf" class="row" style="margin-bottom:1rem"><input id="q" placeholder="جستجوی عنوان، شناسه یا مالک" value="${esc(q)}" style="width:280px"><button class="btn">جستجو</button></form>
    <div class="table-wrap"><table><tr><th>عنوان</th><th>مالک</th><th>نوع</th><th>ظرفیت</th><th>ورودها</th><th>ساخت</th><th>وضعیت</th><th></th></tr>
    ${d.items.map((r) => `<tr><td><a href="room.html#r=${esc(r.slug)}" target="_blank" rel="noopener">${esc(r.title)}</a></td><td>${esc(r.owner_name)}</td>
      <td>${r.mode === 'class' ? 'کلاس' : 'جلسه'}</td><td>${fa(r.max_participants)}</td><td>${fa(r.joins)}</td><td>${fdate(r.created_at)}</td>
      <td><span class="badge ${r.status === 'open' ? 'ok' : 'bad'}">${r.status === 'open' ? 'باز' : 'بسته'}</span></td>
      <td class="row"><button class="btn sm" data-t="${r.id}">${r.status === 'open' ? 'بستن' : 'باز کردن'}</button><button class="btn sm" data-end="${r.id}">پایان جلسه</button><button class="btn sm danger" data-del="${r.id}">حذف</button></td></tr>`).join('')}</table></div>
    <div class="row" id="pg" style="margin-top:1rem"></div>`;
  pager($('#pg'), d, (p) => rooms(p, q));
  $('#sf').onsubmit = (e) => { e.preventDefault(); rooms(1, $('#q').value); };
  view.onclick = (e) => {
    const t = e.target.closest('[data-t]'), en = e.target.closest('[data-end]'), del = e.target.closest('[data-del]');
    const reload = () => rooms(page, q);
    if (t) { const r = d.items.find((x) => x.id === Number(t.dataset.t)); api('/api/admin/rooms/' + r.id, { method: 'PATCH', body: { status: r.status === 'open' ? 'closed' : 'open' } }).then(reload).catch(err); }
    if (en && confirm('همه شرکت‌کنندگان این اتاق از جلسه خارج شوند؟')) api(`/api/admin/rooms/${en.dataset.end}/end`, { method: 'POST', body: {} }).then(() => toast('جلسه پایان یافت')).catch(err);
    if (del && confirm('اتاق حذف شود؟')) api('/api/admin/rooms/' + del.dataset.del, { method: 'DELETE' }).then(reload).catch(err);
  };
}

// ---------- plans ----------
async function plans() {
  const list = await api('/api/admin/plans');
  view.innerHTML = `
    <div class="row spread" style="margin-bottom:1rem"><h3 style="margin:0">پلن‌های فروش</h3><button class="btn primary" id="add">+ پلن جدید</button></div>
    <div class="table-wrap"><table><tr><th>نام</th><th>قیمت</th><th>مدت</th><th>اتاق</th><th>ظرفیت</th><th>ضبط</th><th>کاربران</th><th>وضعیت</th><th></th></tr>
    ${list.map((p) => `<tr><td>${esc(p.name)} ${p.is_default ? '<span class="badge">پیش‌فرض</span>' : ''}</td><td>${money(p.price)}</td><td>${p.duration_days ? fa(p.duration_days) + ' روز' : 'نامحدود'}</td>
      <td>${fa(p.max_rooms)}</td><td>${fa(p.max_participants)}</td><td>${p.allow_recording ? '✓' : '—'}</td><td>${fa(p.users)}</td>
      <td><span class="badge ${p.active ? 'ok' : 'bad'}">${p.active ? 'فعال' : 'غیرفعال'}</span></td>
      <td class="row"><button class="btn sm" data-edit="${p.id}">ویرایش</button><button class="btn sm danger" data-del="${p.id}">حذف</button></td></tr>`).join('')}</table></div>`;
  $('#add').onclick = () => planForm(null);
  view.onclick = (e) => {
    const ed = e.target.closest('[data-edit]'), del = e.target.closest('[data-del]');
    if (ed) planForm(list.find((p) => p.id === Number(ed.dataset.edit)));
    if (del && confirm('این پلن حذف شود؟')) api('/api/admin/plans/' + del.dataset.del, { method: 'DELETE' }).then(plans).catch(err);
  };
}
function planForm(p) {
  const m = modal(`<h3>${p ? 'ویرایش پلن' : 'پلن جدید'}</h3><form>
    <label>نام پلن</label><input name="name" required value="${esc(p?.name || '')}">
    <label>قیمت (تومان؛ ۰ = رایگان)</label><input name="price" type="number" min="0" value="${p?.price ?? 0}">
    <label>مدت اعتبار (روز؛ ۰ = نامحدود)</label><input name="duration_days" type="number" min="0" value="${p?.duration_days ?? 30}">
    <label>حداکثر تعداد اتاق</label><input name="max_rooms" type="number" min="1" value="${p?.max_rooms ?? 1}">
    <label>حداکثر شرکت‌کننده در هر اتاق</label><input name="max_participants" type="number" min="2" max="1000" value="${p?.max_participants ?? 10}">
    <label>ترتیب نمایش</label><input name="sort" type="number" value="${p?.sort ?? 0}">
    <div class="check"><input type="checkbox" name="allow_recording" ${p?.allow_recording ? 'checked' : ''}><span>امکان ضبط جلسه</span></div>
    <div class="check"><input type="checkbox" name="active" ${p?.active !== 0 ? 'checked' : ''}><span>فعال (قابل خرید)</span></div>
    ${p && !p.is_default ? '<div class="check"><input type="checkbox" name="is_default"><span>تبدیل به پلن پیش‌فرض (ثبت‌نام‌ها و پلن‌های منقضی‌شده)</span></div>' : ''}
    <div class="actions"><button class="btn primary">ذخیره</button><button type="button" class="btn" data-close>انصراف</button></div></form>`);
  $('[data-close]', m.el).onclick = m.close;
  $('form', m.el).onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const body = { name: f.get('name'), price: +f.get('price'), duration_days: +f.get('duration_days'), max_rooms: +f.get('max_rooms'), max_participants: +f.get('max_participants'), sort: +f.get('sort'), allow_recording: f.has('allow_recording'), active: f.has('active') };
    if (f.has('is_default')) body.is_default = true;
    try { await api(p ? '/api/admin/plans/' + p.id : '/api/admin/plans', { method: p ? 'PATCH' : 'POST', body }); m.close(); toast('ذخیره شد'); plans(); } catch (er) { err(er); }
  };
}

// ---------- payments ----------
const PAY = { pending: ['در انتظار', 'warn'], paid: ['پرداخت شده', 'ok'], failed: ['ناموفق', 'bad'], rejected: ['رد شده', 'bad'] };
async function payments(status = '') {
  const { items } = await api('/api/admin/payments' + (status ? '?status=' + status : ''));
  view.innerHTML = `
    <div class="row" style="margin-bottom:1rem"><select id="st" style="width:200px"><option value="">همه وضعیت‌ها</option>${Object.entries(PAY).map(([k, v]) => `<option value="${k}" ${k === status ? 'selected' : ''}>${v[0]}</option>`).join('')}</select></div>
    <div class="table-wrap"><table><tr><th>تاریخ</th><th>کاربر</th><th>پلن</th><th>مبلغ</th><th>روش</th><th>شماره پیگیری</th><th>وضعیت</th><th></th></tr>
    ${items.map((p) => `<tr><td>${fdate(p.created_at)}</td><td>${esc(p.user_name)}<br><span class="muted ltr">${esc(p.email)}</span></td><td>${esc(p.plan_name)}</td><td>${money(p.amount)}</td>
      <td>${p.method === 'zarinpal' ? 'درگاه' : 'کارت‌به‌کارت'}</td><td class="ltr">${esc(p.ref_id || '—')}</td>
      <td><span class="badge ${PAY[p.status]?.[1] || ''}">${PAY[p.status]?.[0] || esc(p.status)}</span></td>
      <td class="row">${p.status === 'pending' ? `<button class="btn sm primary" data-ok="${p.id}">تأیید</button><button class="btn sm danger" data-no="${p.id}">رد</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="8" class="muted">موردی نیست.</td></tr>'}</table></div>`;
  $('#st').onchange = (e) => payments(e.target.value);
  view.onclick = (e) => {
    const ok = e.target.closest('[data-ok]'), no = e.target.closest('[data-no]');
    if (ok && confirm('پرداخت تأیید و پلن کاربر فعال شود؟')) api(`/api/admin/payments/${ok.dataset.ok}/approve`, { method: 'POST', body: {} }).then(() => { toast('تأیید شد'); payments(status); }).catch(err);
    if (no) { const note = prompt('دلیل رد (اختیاری):') ?? null; if (note !== null) api(`/api/admin/payments/${no.dataset.no}/reject`, { method: 'POST', body: { note } }).then(() => payments(status)).catch(err); }
  };
}

// ---------- settings ----------
async function settings() {
  const s = await api('/api/admin/settings');
  view.innerHTML = `<div class="card" style="max-width:640px"><form id="sf">
    <h3>اطلاعات سایت</h3>
    <label>نام سایت / برند</label><input name="site_name" value="${esc(s.site_name)}" required>
    <label>شعار صفحه اول</label><input name="site_tagline" value="${esc(s.site_tagline)}">
    <label>رنگ اصلی</label><input name="primary_color" type="color" value="${esc(s.primary_color)}" style="height:44px">
    <label>متن پایین صفحه (فوتر)</label><input name="footer_text" value="${esc(s.footer_text)}">
    <div class="check"><input type="checkbox" name="allow_registration" ${s.allow_registration === '1' ? 'checked' : ''}><span>ثبت‌نام کاربران جدید باز باشد</span></div>
    <h3 style="margin-top:1.5rem">پرداخت</h3>
    <p class="muted">${s.zarinpal ? '✅ درگاه زرین‌پال فعال است (از متغیر ZARINPAL_MERCHANT_ID).' : 'درگاه آنلاین فعال نیست؛ پرداخت به‌صورت کارت‌به‌کارت و با تأیید دستی شما انجام می‌شود.'}</p>
    <label>شماره کارت</label><input name="card_number" class="ltr" value="${esc(s.card_number)}">
    <label>نام صاحب کارت</label><input name="card_owner" value="${esc(s.card_owner)}">
    <label>توضیح پرداخت برای کاربر</label><input name="payment_note" value="${esc(s.payment_note)}">
    <h3 style="margin-top:1.5rem">سرور ویدیو</h3>
    <p class="muted ltr">LiveKit: ${esc(s.livekit_url)} (از فایل .env تنظیم می‌شود)</p>
    <button class="btn primary" style="margin-top:1rem">ذخیره تنظیمات</button></form></div>`;
  $('#sf').onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const body = Object.fromEntries(f);
    body.allow_registration = f.has('allow_registration');
    try { await api('/api/admin/settings', { method: 'PUT', body }); toast('ذخیره شد'); loadSettings(); } catch (er) { err(er); }
  };
}

show('overview');
api('/api/admin/stats').then((s) => badge(s.pending_payments)).catch(() => {});
