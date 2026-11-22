import { $, $$, api, esc, toast, loadSettings, me, modal, money, fa, fdate, logout, roomLink } from './common.js';

await loadSettings();
let user = await me();
if (!user) {
  location.href = 'login.html?next=dashboard.html';
  await new Promise(() => {}); // stop here; the browser is navigating away
}
const params = new URLSearchParams(location.search);

const TABS = ['rooms', 'plans', 'payments', 'profile'];
function showTab(name) {
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  for (const t of TABS) $('#t-' + t).classList.toggle('hidden', t !== name);
  ({ rooms: loadRooms, plans: loadPlans, payments: loadPayments, profile: loadProfile })[name]();
}
$$('.tab').forEach((t) => t.addEventListener('click', () => showTab(t.dataset.tab)));
$('#logout').addEventListener('click', async () => { await logout(); location.href = './'; });

function renderHeader() {
  $('#who').textContent = user.name;
  $('#admin-link').classList.toggle('hidden', user.role !== 'admin');
  const p = user.plan;
  $('#plan-box').innerHTML = `
    <div><div class="muted">پلن فعلی</div><b>${esc(p.name)}</b>
      ${user.plan_expires ? `<span class="muted"> · تا ${fdate(user.plan_expires)}</span>` : ''}</div>
    <div class="muted">اتاق‌ها: ${fa(user.rooms_used)} از ${user.role === 'admin' ? '∞' : fa(p.max_rooms)} · ظرفیت هر اتاق تا ${fa(p.max_participants)} نفر · ${p.allow_recording ? 'ضبط جلسه فعال' : 'بدون ضبط جلسه'}</div>`;
}
async function refreshUser() { user = await me(); renderHeader(); }
renderHeader();

// ---------- rooms ----------
const roomUrl = roomLink;

async function loadRooms() {
  const box = $('#t-rooms');
  const rooms = await api('/api/rooms').catch((e) => { toast(e.message, true); return []; });
  box.innerHTML = `
    <div class="row spread" style="margin-bottom:1rem"><h3 style="margin:0">اتاق‌ها</h3><button class="btn primary" id="new-room">+ اتاق جدید</button></div>
    ${rooms.length ? `<div class="grid">${rooms.map((r) => `
      <div class="card" data-slug="${esc(r.slug)}">
        <div class="row spread"><h3 style="margin:0">${esc(r.title)}</h3><span class="badge ${r.status === 'open' ? 'ok' : 'bad'}">${r.status === 'open' ? 'باز' : 'بسته'}</span></div>
        <p class="muted">${r.mode === 'class' ? 'حالت کلاس' : 'حالت جلسه'} · تا ${fa(r.max_participants)} نفر ${r.has_password ? '· 🔒 رمزدار' : ''} ${r.allow_guests ? '' : '· فقط اعضا'}</p>
        <input class="ltr" readonly value="${esc(roomUrl(r.slug))}" style="font-size:.8rem">
        <div class="row" style="margin-top:.75rem">
          <a class="btn primary sm" href="room.html#r=${esc(r.slug)}" target="_blank" rel="noopener">ورود</a>
          <button class="btn sm" data-a="copy">کپی لینک</button>
          <button class="btn sm" data-a="edit">ویرایش</button>
          <button class="btn sm danger" data-a="del">حذف</button>
        </div>
      </div>`).join('')}</div>` : '<div class="card muted">هنوز اتاقی نساخته‌اید.</div>'}`;
  $('#new-room').onclick = () => roomForm();
  box.onclick = (e) => {
    const b = e.target.closest('button[data-a]');
    if (!b) return;
    const slug = b.closest('[data-slug]').dataset.slug;
    const room = rooms.find((r) => r.slug === slug);
    if (b.dataset.a === 'copy') navigator.clipboard?.writeText(roomUrl(slug)).then(() => toast('لینک کپی شد'));
    if (b.dataset.a === 'edit') roomForm(room);
    if (b.dataset.a === 'del' && confirm(`اتاق «${room.title}» حذف شود؟`)) {
      api('/api/rooms/' + slug, { method: 'DELETE' }).then(() => { toast('حذف شد'); refreshUser(); loadRooms(); }).catch((e) => toast(e.message, true));
    }
  };
}

function roomForm(r) {
  const m = modal(`
    <h3>${r ? 'ویرایش اتاق' : 'اتاق جدید'}</h3>
    <form>
      <label>عنوان</label><input name="title" required maxlength="100" value="${esc(r?.title || '')}">
      <label>نوع اتاق</label>
      <select name="mode"><option value="class" ${r?.mode === 'class' ? 'selected' : ''}>کلاس — فقط میزبان و ارائه‌دهندگان صحبت می‌کنند</option><option value="meeting" ${r?.mode === 'meeting' ? 'selected' : ''}>جلسه — همه می‌توانند صحبت کنند</option></select>
      <label>حداکثر شرکت‌کننده (سقف پلن: ${fa(user.plan.max_participants)})</label>
      <input name="max_participants" type="number" min="2" max="${user.plan.max_participants}" value="${r?.max_participants ?? Math.min(50, user.plan.max_participants)}">
      <label>رمز ورود ${r?.has_password ? '(خالی = بدون تغییر)' : '(اختیاری)'}</label><input name="password" type="password" class="ltr" autocomplete="new-password">
      ${r?.has_password ? '<div class="check"><input type="checkbox" name="clear_password"><span>حذف رمز اتاق</span></div>' : ''}
      <div class="check"><input type="checkbox" name="allow_guests" ${r?.allow_guests !== 0 ? 'checked' : ''}><span>ورود مهمان (بدون حساب کاربری) مجاز باشد</span></div>
      ${r ? `<div class="check"><input type="checkbox" name="open" ${r.status === 'open' ? 'checked' : ''}><span>اتاق باز باشد</span></div>` : ''}
      <div class="actions"><button class="btn primary">ذخیره</button><button type="button" class="btn" data-close>انصراف</button></div>
    </form>`);
  $('[data-close]', m.el).onclick = m.close;
  $('form', m.el).onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const body = { title: f.get('title'), mode: f.get('mode'), max_participants: Number(f.get('max_participants')), allow_guests: f.has('allow_guests'), password: f.get('password'), clear_password: f.has('clear_password') };
    if (r) body.status = f.has('open') ? 'open' : 'closed';
    try {
      await api(r ? '/api/rooms/' + r.slug : '/api/rooms', { method: r ? 'PATCH' : 'POST', body });
      m.close(); toast('ذخیره شد'); refreshUser(); loadRooms();
    } catch (err) { toast(err.message, true); }
  };
}

// ---------- plans ----------
async function loadPlans() {
  const plans = await api('/api/plans');
  $('#t-plans').innerHTML = `<div class="grid">${plans.map((p) => `
    <div class="card plan">
      <h3>${esc(p.name)} ${p.id === user.plan.id ? '<span class="badge ok">پلن فعلی</span>' : ''}</h3>
      <div class="price">${money(p.price)} ${p.price > 0 ? `<small>/ ${p.duration_days ? fa(p.duration_days) + ' روز' : 'همیشه'}</small>` : ''}</div>
      <ul><li>${fa(p.max_rooms)} اتاق</li><li>تا ${fa(p.max_participants)} شرکت‌کننده</li><li>${p.allow_recording ? 'ضبط جلسه ✓' : 'بدون ضبط جلسه'}</li></ul>
      <button class="btn ${p.price > 0 ? 'primary' : ''}" data-plan="${p.id}" ${p.id === user.plan.id && p.price === 0 ? 'disabled' : ''}>${p.price > 0 ? (p.id === user.plan.id ? 'تمدید' : 'خرید') : 'انتخاب'}</button>
    </div>`).join('')}</div>`;
  $('#t-plans').onclick = async (e) => {
    const b = e.target.closest('[data-plan]');
    if (!b) return;
    b.disabled = true;
    try {
      const r = await api('/api/payments/checkout', { method: 'POST', body: { planId: Number(b.dataset.plan) } });
      if (r.redirect) location.href = r.redirect;
      else if (r.activated) { toast('پلن فعال شد'); await refreshUser(); loadPlans(); }
      else if (r.manual) manualPay(r);
    } catch (err) { toast(err.message, true); }
    b.disabled = false;
  };
}

function manualPay(r) {
  const m = modal(`
    <h3>پرداخت کارت‌به‌کارت</h3>
    <p>مبلغ <b>${money(r.amount)}</b> را به کارت زیر واریز کنید:</p>
    <div class="card ltr" style="text-align:center;font-size:1.3rem;letter-spacing:2px">${esc(r.card_number)}</div>
    ${r.card_owner ? `<p class="muted">به نام: ${esc(r.card_owner)}</p>` : ''}
    <p class="muted">${esc(r.note || '')}</p>
    <form><label>شماره پیگیری / ۴ رقم آخر کارت مبدأ</label><input name="ref" required maxlength="80">
    <div class="actions"><button class="btn primary">ثبت پرداخت</button><button type="button" class="btn" data-close>بعداً</button></div></form>`);
  $('[data-close]', m.el).onclick = m.close;
  $('form', m.el).onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api(`/api/payments/${r.paymentId}/receipt`, { method: 'POST', body: { ref: new FormData(e.target).get('ref') } });
      m.close(); toast('ثبت شد؛ پس از تأیید مدیر پلن شما فعال می‌شود'); showTab('payments');
    } catch (err) { toast(err.message, true); }
  };
}

// ---------- payments ----------
const PAY_STATUS = { pending: ['در انتظار', 'warn'], paid: ['پرداخت شده', 'ok'], failed: ['ناموفق', 'bad'], rejected: ['رد شده', 'bad'] };
async function loadPayments() {
  const items = await api('/api/payments').catch(() => []);
  $('#t-payments').innerHTML = items.length ? `<div class="table-wrap"><table>
    <tr><th>تاریخ</th><th>پلن</th><th>مبلغ</th><th>روش</th><th>وضعیت</th><th>پیگیری</th></tr>
    ${items.map((p) => `<tr><td>${fdate(p.created_at)}</td><td>${esc(p.plan_name)}</td><td>${money(p.amount)}</td>
      <td>${p.method === 'zarinpal' ? 'درگاه' : 'کارت‌به‌کارت'}</td>
      <td><span class="badge ${PAY_STATUS[p.status]?.[1] || ''}">${PAY_STATUS[p.status]?.[0] || esc(p.status)}</span>${p.method === 'manual' && p.status === 'pending' && !p.ref_id ? ' <span class="muted">(شماره پیگیری ثبت نشده)</span>' : ''}</td>
      <td class="ltr">${esc(p.ref_id || '—')}</td></tr>`).join('')}</table></div>` : '<div class="card muted">پرداختی ثبت نشده است.</div>';
}

// ---------- profile ----------
function loadProfile() {
  $('#t-profile').innerHTML = `<div class="card" style="max-width:480px"><form id="pf">
    <label>نام</label><input name="name" value="${esc(user.name)}" required minlength="2">
    <label>ایمیل</label><input value="${esc(user.email)}" class="ltr" disabled>
    <h3 style="margin-top:1.5rem">تغییر رمز عبور</h3>
    <label>رمز فعلی</label><input name="current_password" type="password" class="ltr" autocomplete="current-password">
    <label>رمز جدید</label><input name="new_password" type="password" class="ltr" minlength="8" autocomplete="new-password">
    <button class="btn primary" style="margin-top:1rem">ذخیره</button></form></div>`;
  $('#pf').onsubmit = async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    if (!f.new_password) { delete f.new_password; delete f.current_password; }
    try { await api('/api/me', { method: 'PATCH', body: f }); toast('ذخیره شد'); await refreshUser(); } catch (err) { toast(err.message, true); }
  };
}

const pay = params.get('pay');
if (pay) {
  toast(pay === 'ok' ? 'پرداخت موفق بود و پلن شما فعال شد 🎉' : 'پرداخت ناموفق بود یا لغو شد', pay !== 'ok');
  await refreshUser();
}
showTab(TABS.includes(params.get('tab')) ? params.get('tab') : pay ? 'payments' : 'rooms');
