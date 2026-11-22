import { $, $$, api, loadSettings, safeNext, setToken } from './common.js';

const s = await loadSettings();
const params = new URLSearchParams(location.search);
const next = safeNext(params.get('next'));

if (s.allow_registration !== '1') $('#reg-tab').classList.add('hidden');

function show(tab) {
  if (tab === 'register' && s.allow_registration !== '1') tab = 'login';
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === tab));
  $('#login').classList.toggle('hidden', tab !== 'login');
  $('#register').classList.toggle('hidden', tab !== 'register');
}
$$('.tab').forEach((t) => t.addEventListener('click', () => show(t.dataset.tab)));
show(params.get('tab') === 'register' ? 'register' : 'login');

for (const kind of ['login', 'register']) {
  $('#' + kind).addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('button.btn', e.target);
    btn.disabled = true;
    $('#err-' + kind).textContent = '';
    try {
      const r = await api('/api/auth/' + kind, { method: 'POST', body: Object.fromEntries(new FormData(e.target)) });
      setToken(r.token);
      location.href = next;
    } catch (err) {
      $('#err-' + kind).textContent = err.message;
      btn.disabled = false;
    }
  });
}
