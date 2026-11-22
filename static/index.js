import { $, api, esc, loadSettings, me, money, fa } from './common.js';

const [s, user, plans] = await Promise.all([loadSettings(), me(), api('/api/plans').catch(() => [])]);

$('#hero-title').textContent = s.site_name || '';
$('#hero-sub').textContent = s.site_tagline || '';
$('#footer').textContent = s.footer_text || '';

$('#nav').innerHTML = user
  ? `${user.role === 'admin' ? '<a class="btn sm" href="admin.html">پنل مدیریت</a>' : ''}<a class="btn primary sm" href="dashboard.html">داشبورد</a>`
  : `<a class="btn sm" href="login.html">ورود</a>${s.allow_registration === '1' ? '<a class="btn primary sm" href="login.html?tab=register">ثبت‌نام</a>' : ''}`;
if (user) $('#cta').href = 'dashboard.html', $('#cta').textContent = 'رفتن به داشبورد';
if (!user && s.allow_registration !== '1') $('#cta').classList.add('hidden');

$('#plan-grid').innerHTML = plans.map((p) => `
  <div class="card plan">
    <h3>${esc(p.name)}</h3>
    <div class="price">${money(p.price)} ${p.price > 0 ? `<small>/ ${p.duration_days ? fa(p.duration_days) + ' روز' : 'همیشه'}</small>` : ''}</div>
    <ul>
      <li>${fa(p.max_rooms)} اتاق</li>
      <li>تا ${fa(p.max_participants)} شرکت‌کننده در هر اتاق</li>
      <li>${p.allow_recording ? 'ضبط جلسه ✓' : 'بدون ضبط جلسه'}</li>
    </ul>
    <a class="btn ${p.price > 0 ? 'primary' : ''}" href="${user ? 'dashboard.html?tab=plans' : 'login.html?tab=register'}">${p.price > 0 ? 'خرید پلن' : 'شروع'}</a>
  </div>`).join('');
