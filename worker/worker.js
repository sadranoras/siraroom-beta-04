// Cloudflare Worker = the whole back end of the static classroom site.
//   * accounts, rooms, plans, payments, admin panel  -> Cloudflare D1 (SQLite, free tier)
//   * join tokens + host actions (mute/remove/...)    -> LiveKit (Cloud or self-hosted)
// The database tables are created automatically on the first request.
//
// Bindings / variables (see README.md):
//   DB                  D1 database binding (required)
//   LIVEKIT_URL         wss://YOUR-PROJECT.livekit.cloud           (required)
//   LIVEKIT_API_KEY     (required)        LIVEKIT_API_SECRET  (required, secret)
//   ADMIN_EMAIL, ADMIN_PASSWORD   first admin account, created if no admin exists yet (required once)
//   SITE_URL            address of the static site, e.g. https://class.example.com (used after online payment)
//   ALLOWED_ORIGIN      optional: only this origin may call the API
//   SESSION_SECRET      optional: token signing secret (defaults to LIVEKIT_API_SECRET)
//   ZARINPAL_MERCHANT_ID, ZARINPAL_SANDBOX=1   optional online payment

const enc = new TextEncoder();
const dec = new TextDecoder();

// ---------- small utils ----------
const b64u = (buf) => {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const unb64u = (s) => {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
};
const hex = (u8) => [...u8].map((b) => b.toString(16).padStart(2, '0')).join('');
const unhex = (h) => Uint8Array.from(h.match(/../g) || [], (x) => parseInt(x, 16));
const rand = (n, alphabet) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => alphabet[b % alphabet.length]).join('');

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const fail = (status, msg) => { throw new HttpError(status, msg); };
const S = (v, max = 200) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f]/g, '').trim().slice(0, max) : '');
const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const toInt = (v, def, min = -Infinity, max = Infinity) => {
  const n = Math.trunc(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
};

async function hmacKey(secret) { return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']); }
async function hmac(secret, data) { return new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(data))); }
function safeEq(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

// password hashing: PBKDF2-SHA256 (Workers limit: 100k iterations)
async function pbkdf2(pw, salt) {
  const key = await crypto.subtle.importKey('raw', enc.encode(pw), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 100000 }, key, 256));
}
async function hashPassword(pw) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2$${hex(salt)}$${hex(await pbkdf2(pw, salt))}`;
}
async function verifyPassword(pw, stored) {
  try {
    const [alg, s, h] = String(stored).split('$');
    if (alg !== 'pbkdf2') return false;
    return safeEq(hex(await pbkdf2(pw, unhex(s))), h);
  } catch { return false; }
}

async function signToken(env, payload, ttlSec) {
  const body = b64u(enc.encode(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + ttlSec })));
  return body + '.' + b64u(await hmac(secretOf(env), body));
}
async function verifyToken(env, token) {
  if (typeof token !== 'string') return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  if (!safeEq(b64u(await hmac(secretOf(env), body)), sig)) return null;
  try {
    const p = JSON.parse(dec.decode(unb64u(body)));
    return p.exp > Date.now() / 1000 ? p : null;
  } catch { return null; }
}
const secretOf = (env) => 'sess:' + (env.SESSION_SECRET || env.LIVEKIT_API_SECRET);

async function jwt(payload, secret) {
  const head = b64u(enc.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const body = b64u(enc.encode(JSON.stringify(payload)));
  return `${head}.${body}.${b64u(await hmac(secret, `${head}.${body}`))}`;
}

// ---------- database ----------
const DEFAULT_SETTINGS = {
  site_name: 'کلاس‌آنلاین',
  site_tagline: 'کلاس و جلسه آنلاین با ویدیو، صدا، وایت‌بورد و ارائهٔ فایل',
  allow_registration: '1', primary_color: '#4f46e5', support_text: '', footer_text: '',
  card_number: '', card_owner: '',
  payment_note: 'پس از واریز، شماره پیگیری را در داشبورد ثبت کنید تا پرداخت شما تأیید شود.',
};
const PUBLIC_SETTING_KEYS = ['site_name', 'site_tagline', 'allow_registration', 'primary_color', 'support_text', 'footer_text'];

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS plans(id INTEGER PRIMARY KEY, name TEXT NOT NULL, price INTEGER NOT NULL DEFAULT 0, duration_days INTEGER NOT NULL DEFAULT 30, max_rooms INTEGER NOT NULL DEFAULT 1, max_participants INTEGER NOT NULL DEFAULT 10, allow_recording INTEGER NOT NULL DEFAULT 0, is_default INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1, sort INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE COLLATE NOCASE, password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'user', plan_id INTEGER REFERENCES plans(id), plan_expires TEXT, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT (datetime('now')), last_login TEXT)`,
  `CREATE TABLE IF NOT EXISTS rooms(id INTEGER PRIMARY KEY, slug TEXT NOT NULL UNIQUE, title TEXT NOT NULL, owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, mode TEXT NOT NULL DEFAULT 'class', max_participants INTEGER NOT NULL DEFAULT 50, password_hash TEXT, allow_guests INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL DEFAULT 'open', created_at TEXT NOT NULL DEFAULT (datetime('now')))`,
  `CREATE TABLE IF NOT EXISTS attendance(id INTEGER PRIMARY KEY, room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE, user_id INTEGER, display_name TEXT NOT NULL, role TEXT, joined_at TEXT NOT NULL DEFAULT (datetime('now')), left_at TEXT)`,
  `CREATE INDEX IF NOT EXISTS idx_att_room ON attendance(room_id)`,
  `CREATE INDEX IF NOT EXISTS idx_att_joined ON attendance(joined_at)`,
  `CREATE TABLE IF NOT EXISTS payments(id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, plan_id INTEGER NOT NULL REFERENCES plans(id), amount INTEGER NOT NULL, method TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', authority TEXT, ref_id TEXT, note TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), paid_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS hits(k TEXT NOT NULL, ts INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS idx_hits ON hits(k, ts)`,
];

const bindArgs = (a) => a.map((v) => (v === undefined ? null : v));
function makeDb(env) {
  const st = (sql, a) => env.DB.prepare(sql).bind(...bindArgs(a));
  return {
    all: async (sql, ...a) => (await st(sql, a).all()).results || [],
    one: async (sql, ...a) => (await st(sql, a).first()) || null,
    run: async (sql, ...a) => { const r = await st(sql, a).run(); return { id: r.meta?.last_row_id }; },
  };
}

let ready = null;
function ensureReady(env) {
  ready ||= (async () => {
    if (!env.DB) throw new HttpError(500, 'پایگاه‌داده D1 به Worker متصل نشده است (binding با نام DB)');
    await env.DB.batch(SCHEMA.map((s) => env.DB.prepare(s)));
    const db = makeDb(env);
    if (!(await db.one('SELECT id FROM plans LIMIT 1'))) {
      const ins = 'INSERT INTO plans(name,price,duration_days,max_rooms,max_participants,allow_recording,is_default,sort) VALUES (?,?,?,?,?,?,?,?)';
      await env.DB.batch([
        env.DB.prepare(ins).bind('رایگان', 0, 0, 1, 10, 0, 1, 1),
        env.DB.prepare(ins).bind('پایه', 150000, 30, 5, 50, 1, 0, 2),
        env.DB.prepare(ins).bind('حرفه‌ای', 450000, 30, 20, 200, 1, 0, 3),
      ]);
    }
    // The owner's account: ADMIN_EMAIL + ADMIN_PASSWORD. Created if missing; if the account already exists and the
    // password matches ADMIN_PASSWORD it is promoted to admin (so nobody can claim it just by knowing the email).
    if (env.ADMIN_EMAIL && env.ADMIN_PASSWORD && String(env.ADMIN_PASSWORD).length >= 8) {
      const email = S(env.ADMIN_EMAIL, 120).toLowerCase();
      const existing = await db.one('SELECT * FROM users WHERE email=?', email);
      if (!existing) {
        const def = await db.one('SELECT id FROM plans WHERE is_default=1');
        await db.run('INSERT INTO users(name,email,password_hash,role,plan_id) VALUES (?,?,?,?,?)',
          'مدیر سیستم', email, await hashPassword(String(env.ADMIN_PASSWORD)), 'admin', def?.id ?? null);
      } else if (existing.role !== 'admin' && existing.active && (await verifyPassword(String(env.ADMIN_PASSWORD), existing.password_hash))) {
        await db.run("UPDATE users SET role='admin' WHERE id=?", existing.id);
      }
    }
  })().catch((e) => { ready = null; throw e; });
  return ready;
}

// ---------- LiveKit ----------
const lkHttp = (env) => env.LIVEKIT_URL.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:').replace(/\/+$/, '');
async function lkRaw(env, method, body) {
  const now = Math.floor(Date.now() / 1000);
  const token = await jwt({ iss: env.LIVEKIT_API_KEY, nbf: now, exp: now + 60, video: { roomCreate: true, roomList: true, roomAdmin: true, room: body.room || body.name } }, env.LIVEKIT_API_SECRET);
  const res = await fetch(`${lkHttp(env)}/twirp/livekit.RoomService/${method}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body),
  });
  const text = await res.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { /* ignore */ }
  if (!res.ok) throw new Error(data.msg || `LiveKit ${method} failed (${res.status})`);
  return data;
}
async function lkCall(env, method, body) {
  try { return await lkRaw(env, method, body); } catch (e) {
    console.error('[livekit]', method, e.message);
    throw new HttpError(503, `سرور تماس تصویری (LiveKit) در دسترس نیست: ${e.message}`);
  }
}

// ---------- rate limit (stored in D1 so it works across Worker instances) ----------
async function limited(db, key, max, windowMs) {
  const now = Date.now();
  await db.run('INSERT INTO hits(k,ts) VALUES (?,?)', key, now);
  const c = (await db.one('SELECT COUNT(*) c FROM hits WHERE k=? AND ts>?', key, now - windowMs)).c;
  if (Math.random() < 0.02) await db.run('DELETE FROM hits WHERE ts<?', now - 3600000);
  return c > max;
}

// ---------- domain helpers ----------
const FALLBACK_PLAN = { id: 0, name: 'رایگان', price: 0, max_rooms: 1, max_participants: 10, allow_recording: 0 };
async function planOf(db, u) {
  if (u.role === 'admin') return { id: 0, name: 'مدیر سیستم', price: 0, max_rooms: 9999, max_participants: 1000, allow_recording: 1 };
  const def = (await db.one('SELECT * FROM plans WHERE is_default=1')) || FALLBACK_PLAN;
  const p = u.plan_id ? await db.one('SELECT * FROM plans WHERE id=?', u.plan_id) : null;
  const expired = u.plan_expires && Date.parse(u.plan_expires) < Date.now();
  return !p || expired ? def : p;
}
async function publicUser(db, u) {
  return {
    id: u.id, name: u.name, email: u.email, role: u.role, plan: await planOf(db, u), plan_expires: u.plan_expires,
    rooms_used: (await db.one('SELECT COUNT(*) c FROM rooms WHERE owner_id=?', u.id)).c,
  };
}
const roomView = ({ password_hash, ...rest }) => ({ ...rest, has_password: !!password_hash });
async function ownRoom(db, user, slug) {
  const r = await db.one('SELECT * FROM rooms WHERE slug=?', slug);
  if (!r) fail(404, 'اتاق پیدا نشد');
  if (r.owner_id !== user.id && user.role !== 'admin') fail(403, 'دسترسی ندارید');
  return r;
}
async function applyPlan(db, userId, planId) {
  const plan = await db.one('SELECT * FROM plans WHERE id=?', planId);
  const user = await db.one('SELECT * FROM users WHERE id=?', userId);
  if (!plan || !user) return;
  let expires = null;
  if (plan.duration_days > 0) {
    const base = user.plan_id === plan.id && user.plan_expires && Date.parse(user.plan_expires) > Date.now() ? Date.parse(user.plan_expires) : Date.now();
    expires = new Date(base + plan.duration_days * 86400000).toISOString();
  }
  await db.run('UPDATE users SET plan_id=?, plan_expires=? WHERE id=?', plan.id, expires, userId);
}
async function getSettings(db) {
  const o = { ...DEFAULT_SETTINGS };
  for (const r of await db.all('SELECT key,value FROM settings')) o[r.key] = r.value;
  return o;
}

// ---------- routing ----------
const routes = [];
function route(method, pattern, handler, opts = {}) {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ method, re, keys, handler, opts });
}
const A = { auth: 'admin' };
const U = { auth: 'user' };

// ================= public / auth =================
route('GET', '/api/settings/public', async ({ db }) => {
  const s = await getSettings(db);
  return Object.fromEntries(PUBLIC_SETTING_KEYS.map((k) => [k, s[k]]));
});
route('GET', '/api/plans', ({ db }) => db.all('SELECT * FROM plans WHERE active=1 ORDER BY sort,id'));

route('POST', '/api/auth/register', async ({ env, db, body, ip }) => {
  if ((await getSettings(db)).allow_registration !== '1') fail(403, 'ثبت‌نام در حال حاضر غیرفعال است');
  if (await limited(db, 'reg:' + ip, 10, 3600000)) fail(429, 'تعداد درخواست‌ها زیاد است، بعداً تلاش کنید');
  const name = S(body.name, 60), email = S(body.email, 120).toLowerCase(), pw = typeof body.password === 'string' ? body.password : '';
  if (name.length < 2) fail(400, 'نام را وارد کنید');
  if (!emailRe.test(email)) fail(400, 'ایمیل نامعتبر است');
  if (pw.length < 8) fail(400, 'رمز عبور باید حداقل ۸ کاراکتر باشد');
  if (await db.one('SELECT id FROM users WHERE email=?', email)) fail(409, 'این ایمیل قبلاً ثبت شده است');
  const def = await db.one('SELECT id FROM plans WHERE is_default=1');
  const r = await db.run('INSERT INTO users(name,email,password_hash,plan_id) VALUES (?,?,?,?)', name, email, await hashPassword(pw), def?.id ?? null);
  const u = await db.one('SELECT * FROM users WHERE id=?', r.id);
  return { ...(await publicUser(db, u)), token: await signToken(env, { uid: u.id }, 30 * 86400) };
});

route('POST', '/api/auth/login', async ({ env, db, body, ip }) => {
  const email = S(body.email, 120).toLowerCase(), pw = typeof body.password === 'string' ? body.password : '';
  if ((await limited(db, 'login:' + ip, 20, 600000)) || (await limited(db, 'login:' + email, 8, 600000))) fail(429, 'تلاش‌های ناموفق زیاد بود؛ چند دقیقه بعد دوباره امتحان کنید');
  const u = await db.one('SELECT * FROM users WHERE email=?', email);
  if (!u || !(await verifyPassword(pw, u.password_hash))) fail(401, 'ایمیل یا رمز عبور اشتباه است');
  if (!u.active) fail(403, 'حساب شما غیرفعال شده است');
  await db.run("UPDATE users SET last_login=datetime('now') WHERE id=?", u.id);
  return { ...(await publicUser(db, u)), token: await signToken(env, { uid: u.id }, 30 * 86400) };
});

route('POST', '/api/auth/logout', () => ({ ok: true }));   // the browser just forgets its token
route('GET', '/api/me', ({ db, user }) => (user ? publicUser(db, user) : { guest: true }));

route('PATCH', '/api/me', async ({ db, user, body }) => {
  const name = S(body.name, 60);
  if (name) await db.run('UPDATE users SET name=? WHERE id=?', name, user.id);
  if (body.new_password) {
    if (!(await verifyPassword(String(body.current_password || ''), user.password_hash))) fail(400, 'رمز فعلی اشتباه است');
    if (String(body.new_password).length < 8) fail(400, 'رمز جدید باید حداقل ۸ کاراکتر باشد');
    await db.run('UPDATE users SET password_hash=? WHERE id=?', await hashPassword(String(body.new_password)), user.id);
  }
  return publicUser(db, await db.one('SELECT * FROM users WHERE id=?', user.id));
}, U);

// ================= rooms =================
route('GET', '/api/rooms', async ({ db, user }) => (await db.all('SELECT * FROM rooms WHERE owner_id=? ORDER BY id DESC', user.id)).map(roomView), U);

async function roomFields(body, plan) {
  const f = {};
  if (body.title !== undefined) { f.title = S(body.title, 100); if (!f.title) fail(400, 'عنوان اتاق را وارد کنید'); }
  if (body.mode !== undefined) f.mode = body.mode === 'meeting' ? 'meeting' : 'class';
  if (body.max_participants !== undefined) f.max_participants = toInt(body.max_participants, 50, 2, plan.max_participants);
  if (body.allow_guests !== undefined) f.allow_guests = body.allow_guests ? 1 : 0;
  if (body.status !== undefined) f.status = body.status === 'closed' ? 'closed' : 'open';
  if (typeof body.password === 'string' && body.password) {
    if (body.password.length < 4) fail(400, 'رمز اتاق باید حداقل ۴ کاراکتر باشد');
    f.password_hash = await hashPassword(body.password);
  } else if (body.clear_password) f.password_hash = null;
  return f;
}

route('POST', '/api/rooms', async ({ db, user, body }) => {
  const plan = await planOf(db, user);
  if ((await db.one('SELECT COUNT(*) c FROM rooms WHERE owner_id=?', user.id)).c >= plan.max_rooms) fail(403, `سقف تعداد اتاق در پلن «${plan.name}» پر شده است`);
  const f = await roomFields({ title: body.title, mode: body.mode, max_participants: body.max_participants ?? 50, allow_guests: body.allow_guests ?? true, password: body.password }, plan);
  if (!f.title) fail(400, 'عنوان اتاق را وارد کنید');
  const slug = rand(10, 'abcdefghjkmnpqrstuvwxyz23456789');
  await db.run('INSERT INTO rooms(slug,title,owner_id,mode,max_participants,password_hash,allow_guests) VALUES (?,?,?,?,?,?,?)',
    slug, f.title, user.id, f.mode ?? 'class', f.max_participants ?? 50, f.password_hash ?? null, f.allow_guests ?? 1);
  return roomView(await db.one('SELECT * FROM rooms WHERE slug=?', slug));
}, U);

route('PATCH', '/api/rooms/:slug', async ({ db, user, params, body }) => {
  const r = await ownRoom(db, user, params.slug);
  const owner = await db.one('SELECT * FROM users WHERE id=?', r.owner_id);
  const f = await roomFields(body, await planOf(db, owner));
  const keys = Object.keys(f);
  if (keys.length) await db.run(`UPDATE rooms SET ${keys.map((k) => k + '=?').join(',')} WHERE id=?`, ...keys.map((k) => f[k]), r.id);
  return roomView(await db.one('SELECT * FROM rooms WHERE id=?', r.id));
}, U);

route('DELETE', '/api/rooms/:slug', async ({ env, db, user, params }) => {
  const r = await ownRoom(db, user, params.slug);
  await db.run('DELETE FROM rooms WHERE id=?', r.id);
  lkRaw(env, 'DeleteRoom', { room: r.slug }).catch(() => {});
  return { ok: true };
}, U);

route('GET', '/api/rooms/:slug/info', async ({ db, params }) => {
  const r = await db.one('SELECT r.*, u.name AS owner_name FROM rooms r JOIN users u ON u.id=r.owner_id WHERE r.slug=?', params.slug);
  if (!r) fail(404, 'اتاق پیدا نشد');
  return { title: r.title, mode: r.mode, status: r.status, allow_guests: !!r.allow_guests, has_password: !!r.password_hash, owner_name: r.owner_name };
});

route('POST', '/api/rooms/:slug/join', async ({ env, db, params, body, user, ip }) => {
  const r = await db.one('SELECT * FROM rooms WHERE slug=?', params.slug);
  if (!r) fail(404, 'اتاق پیدا نشد');
  if (r.status !== 'open') fail(403, 'این اتاق بسته است');
  if (!user && !r.allow_guests) fail(401, 'برای ورود به این اتاق باید وارد حساب کاربری شوید');
  const isHost = !!user && (user.id === r.owner_id || user.role === 'admin');
  if (r.password_hash && !isHost) {
    if (await limited(db, 'roompw:' + ip + r.id, 10, 600000)) fail(429, 'تلاش‌های زیاد؛ بعداً دوباره امتحان کنید');
    if (!(await verifyPassword(String(body.password || ''), r.password_hash))) fail(403, 'رمز اتاق اشتباه است');
  }
  const displayName = user ? user.name : S(body.name, 40);
  if (!displayName) fail(400, 'نام خود را وارد کنید');

  const owner = await db.one('SELECT * FROM users WHERE id=?', r.owner_id);
  const ownerPlan = await planOf(db, owner);
  await lkCall(env, 'CreateRoom', { name: r.slug, empty_timeout: 600, max_participants: Math.min(r.max_participants, ownerPlan.max_participants) });

  const role = isHost ? 'host' : user ? 'participant' : 'guest';
  const identity = (user ? `u${user.id}` : 'g') + '-' + rand(8, 'abcdef0123456789');
  const now = Math.floor(Date.now() / 1000);
  const token = await jwt({
    iss: env.LIVEKIT_API_KEY, sub: identity, name: displayName, metadata: JSON.stringify({ role, uid: user?.id ?? null }), nbf: now, exp: now + 6 * 3600,
    // canUpdateOwnMetadata is deliberately NOT granted: the role lives in metadata and other clients trust it.
    video: { room: r.slug, roomJoin: true, canPublish: isHost || r.mode === 'meeting', canSubscribe: true, canPublishData: true },
  }, env.LIVEKIT_API_SECRET);
  const a = await db.run('INSERT INTO attendance(room_id,user_id,display_name,role) VALUES (?,?,?,?)', r.id, user?.id ?? null, displayName, role);
  return {
    url: env.LIVEKIT_URL, token, identity, role, name: displayName,
    room: { slug: r.slug, title: r.title, mode: r.mode },
    can_record: isHost && !!ownerPlan.allow_recording,
    leaveToken: await signToken(env, { aid: a.id }, 24 * 3600),
  };
});

route('POST', '/api/rooms/:slug/leave', async ({ env, db, body }) => {
  const p = await verifyToken(env, body.leaveToken);
  if (p?.aid) await db.run("UPDATE attendance SET left_at=datetime('now') WHERE id=? AND left_at IS NULL", p.aid);
  return { ok: true };
});

route('POST', '/api/rooms/:slug/host', async ({ env, db, user, params, body }) => {
  const r = await ownRoom(db, user, params.slug);
  const action = S(body.action, 20), identity = S(body.identity, 64);
  if (action !== 'end' && !/^[\w-]{1,64}$/.test(identity)) fail(400, 'شناسه نامعتبر');
  if (action === 'end') { await lkCall(env, 'DeleteRoom', { room: r.slug }); return { ok: true }; }
  if (action === 'remove') { await lkCall(env, 'RemoveParticipant', { room: r.slug, identity }); return { ok: true }; }
  if (action === 'mute') {
    const trackSid = S(body.trackSid, 64);
    if (!/^[\w-]{1,64}$/.test(trackSid)) fail(400, 'شناسه نامعتبر');
    await lkCall(env, 'MutePublishedTrack', { room: r.slug, identity, track_sid: trackSid, muted: true });
    return { ok: true };
  }
  if (action === 'promote' || action === 'demote') {
    const list = await lkCall(env, 'ListParticipants', { room: r.slug });
    const p = (list.participants || []).find((x) => x.identity === identity);
    if (!p) fail(404, 'شرکت‌کننده پیدا نشد');
    let meta = {};
    try { meta = JSON.parse(p.metadata || '{}'); } catch { /* keep empty */ }
    if (meta.role === 'host') fail(400, 'نقش میزبان قابل تغییر نیست');
    const up = action === 'promote';
    meta.role = up ? 'presenter' : (meta.uid ? 'participant' : 'guest');
    await lkCall(env, 'UpdateParticipant', {
      room: r.slug, identity, metadata: JSON.stringify(meta),
      permission: { can_subscribe: true, can_publish: up || r.mode === 'meeting', can_publish_data: true },
    });
    return { ok: true, role: meta.role };
  }
  fail(400, 'عملیات نامعتبر');
}, U);

// ================= payments =================
const zpBase = (env) => (env.ZARINPAL_SANDBOX === '1' ? 'https://sandbox.zarinpal.com' : 'https://payment.zarinpal.com');

route('POST', '/api/payments/checkout', async ({ env, db, user, body, url }) => {
  const plan = await db.one('SELECT * FROM plans WHERE id=? AND active=1', toInt(body.planId, 0));
  if (!plan) fail(404, 'پلن پیدا نشد');
  if (plan.price <= 0) { await applyPlan(db, user.id, plan.id); return { activated: true }; }
  if ((await db.one("SELECT COUNT(*) c FROM payments WHERE user_id=? AND status='pending'", user.id)).c >= 5) fail(429, 'چند پرداخت در انتظار دارید؛ ابتدا آن‌ها را نهایی کنید');
  const s = await getSettings(db);
  if (env.ZARINPAL_MERCHANT_ID) {
    const x = await db.run("INSERT INTO payments(user_id,plan_id,amount,method) VALUES (?,?,?,'zarinpal')", user.id, plan.id, plan.price);
    try {
      const r = await fetch(`${zpBase(env)}/pg/v4/payment/request.json`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ merchant_id: env.ZARINPAL_MERCHANT_ID, amount: plan.price, currency: 'IRT', description: `خرید پلن ${plan.name}`, callback_url: `${url.origin}/api/payments/callback?pid=${x.id}`, metadata: { email: user.email } }),
      });
      const j = await r.json();
      const authority = j?.data?.authority;
      if (!authority) throw new Error(JSON.stringify(j?.errors || j));
      await db.run('UPDATE payments SET authority=? WHERE id=?', authority, x.id);
      return { redirect: `${zpBase(env)}/pg/StartPay/${authority}` };
    } catch (e) {
      console.error('[zarinpal request]', e.message);
      await db.run("UPDATE payments SET status='failed' WHERE id=?", x.id);
      fail(502, 'اتصال به درگاه پرداخت برقرار نشد');
    }
  }
  if (!s.card_number) fail(503, 'روش پرداخت هنوز توسط مدیر تنظیم نشده است');
  const x = await db.run("INSERT INTO payments(user_id,plan_id,amount,method) VALUES (?,?,?,'manual')", user.id, plan.id, plan.price);
  return { manual: true, paymentId: x.id, amount: plan.price, card_number: s.card_number, card_owner: s.card_owner, note: s.payment_note };
}, U);

route('POST', '/api/payments/:id/receipt', async ({ db, user, params, body }) => {
  const p = await db.one("SELECT * FROM payments WHERE id=? AND user_id=? AND method='manual' AND status='pending'", Number(params.id), user.id);
  if (!p) fail(404, 'پرداخت پیدا نشد');
  const ref = S(body.ref, 80);
  if (!ref) fail(400, 'شماره پیگیری را وارد کنید');
  await db.run('UPDATE payments SET ref_id=? WHERE id=?', ref, p.id);
  return { ok: true };
}, U);

route('GET', '/api/payments', ({ db, user }) =>
  db.all('SELECT p.*, pl.name AS plan_name FROM payments p JOIN plans pl ON pl.id=p.plan_id WHERE p.user_id=? ORDER BY p.id DESC LIMIT 50', user.id), U);

route('GET', '/api/payments/callback', async ({ env, db, url }) => {
  const site = String(env.SITE_URL || '').replace(/\/+$/, '');
  const back = (q) => ({ redirect: `${site}/dashboard.html?${q}` });
  const p = await db.one("SELECT * FROM payments WHERE id=? AND method='zarinpal' AND status='pending'", Number(url.searchParams.get('pid')));
  if (!p || url.searchParams.get('Authority') !== p.authority) return back('pay=invalid');
  if (url.searchParams.get('Status') !== 'OK') { await db.run("UPDATE payments SET status='failed' WHERE id=?", p.id); return back('pay=failed'); }
  try {
    const r = await fetch(`${zpBase(env)}/pg/v4/payment/verify.json`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ merchant_id: env.ZARINPAL_MERCHANT_ID, amount: p.amount, authority: p.authority }),
    });
    const j = await r.json();
    if (j?.data?.code === 100 || j?.data?.code === 101) {
      await db.run("UPDATE payments SET status='paid', ref_id=?, paid_at=datetime('now') WHERE id=?", String(j.data.ref_id ?? ''), p.id);
      await applyPlan(db, p.user_id, p.plan_id);
      return back('pay=ok');
    }
  } catch (e) { console.error('[zarinpal verify]', e.message); }
  await db.run("UPDATE payments SET status='failed' WHERE id=?", p.id);
  return back('pay=failed');
});

// ================= admin =================
route('GET', '/api/admin/stats', async ({ db }) => {
  const daily = await db.all("SELECT date(joined_at) d, COUNT(*) c FROM attendance WHERE joined_at >= date('now','-13 days') GROUP BY d ORDER BY d");
  const minutes = (await db.one("SELECT COALESCE(SUM(MIN((julianday(COALESCE(left_at, datetime('now'))) - julianday(joined_at)) * 1440, 360)),0) m FROM attendance WHERE joined_at >= date('now','-30 days')")).m;
  return {
    users: (await db.one('SELECT COUNT(*) c FROM users')).c,
    new_users_7d: (await db.one("SELECT COUNT(*) c FROM users WHERE created_at >= datetime('now','-7 days')")).c,
    rooms: (await db.one('SELECT COUNT(*) c FROM rooms')).c,
    joins_30d: (await db.one("SELECT COUNT(*) c FROM attendance WHERE joined_at >= date('now','-30 days')")).c,
    minutes_30d: Math.round(minutes),
    revenue: (await db.one("SELECT COALESCE(SUM(amount),0) s FROM payments WHERE status='paid'")).s,
    revenue_30d: (await db.one("SELECT COALESCE(SUM(amount),0) s FROM payments WHERE status='paid' AND paid_at >= datetime('now','-30 days')")).s,
    pending_payments: (await db.one("SELECT COUNT(*) c FROM payments WHERE status='pending' AND ref_id IS NOT NULL")).c,
    recordings_bytes: 0,
    daily,
  };
}, A);

route('GET', '/api/admin/live', async ({ env, db }) => {
  try {
    const data = await lkRaw(env, 'ListRooms', {});
    const rooms = [];
    for (const r of data.rooms || []) {
      const row = await db.one('SELECT title FROM rooms WHERE slug=?', r.name);
      rooms.push({ slug: r.name, title: row?.title || r.name, participants: r.num_participants ?? r.numParticipants ?? 0 });
    }
    return { ok: true, rooms };
  } catch { return { ok: false, error: 'LiveKit در دسترس نیست', rooms: [] }; }
}, A);

route('GET', '/api/admin/users', async ({ db, url }) => {
  const q = '%' + S(url.searchParams.get('q') || '', 60) + '%';
  const page = toInt(url.searchParams.get('page'), 1, 1), size = 25;
  const where = 'WHERE (name LIKE ? OR email LIKE ?)';
  const total = (await db.one(`SELECT COUNT(*) c FROM users ${where}`, q, q)).c;
  const items = await db.all(`SELECT u.id,u.name,u.email,u.role,u.active,u.plan_id,u.plan_expires,u.created_at,u.last_login,
      (SELECT COUNT(*) FROM rooms WHERE owner_id=u.id) AS rooms FROM users u ${where} ORDER BY u.id DESC LIMIT ? OFFSET ?`, q, q, size, (page - 1) * size);
  return { items, total, page, size };
}, A);

route('POST', '/api/admin/users', async ({ db, body }) => {
  const name = S(body.name, 60), email = S(body.email, 120).toLowerCase(), pw = String(body.password || '');
  if (name.length < 2 || !emailRe.test(email) || pw.length < 8) fail(400, 'نام، ایمیل معتبر و رمز حداقل ۸ کاراکتری لازم است');
  if (await db.one('SELECT id FROM users WHERE email=?', email)) fail(409, 'این ایمیل قبلاً ثبت شده است');
  const def = await db.one('SELECT id FROM plans WHERE is_default=1');
  const x = await db.run('INSERT INTO users(name,email,password_hash,role,plan_id,plan_expires) VALUES (?,?,?,?,?,?)',
    name, email, await hashPassword(pw), body.role === 'admin' ? 'admin' : 'user', body.plan_id ? toInt(body.plan_id, null) : def?.id ?? null, S(body.plan_expires, 40) || null);
  return { id: x.id };
}, A);

route('PATCH', '/api/admin/users/:id', async ({ db, user, params, body }) => {
  const id = Number(params.id);
  if (!(await db.one('SELECT id FROM users WHERE id=?', id))) fail(404, 'کاربر پیدا نشد');
  const sets = [], vals = [];
  const set = (k, v) => { sets.push(k + '=?'); vals.push(v); };
  if (body.name !== undefined) { const n = S(body.name, 60); if (n.length < 2) fail(400, 'نام نامعتبر'); set('name', n); }
  if (body.email !== undefined) {
    const e = S(body.email, 120).toLowerCase();
    if (!emailRe.test(e)) fail(400, 'ایمیل نامعتبر');
    if (await db.one('SELECT id FROM users WHERE email=? AND id<>?', e, id)) fail(409, 'این ایمیل قبلاً ثبت شده است');
    set('email', e);
  }
  if (body.role !== undefined) set('role', body.role === 'admin' ? 'admin' : 'user');
  if (body.active !== undefined) set('active', body.active ? 1 : 0);
  if (body.plan_id !== undefined) set('plan_id', body.plan_id ? toInt(body.plan_id, null) : null);
  if (body.plan_expires !== undefined) set('plan_expires', S(body.plan_expires, 40) || null);
  if (body.password) { if (String(body.password).length < 8) fail(400, 'رمز باید حداقل ۸ کاراکتر باشد'); set('password_hash', await hashPassword(String(body.password))); }
  if (id === user.id && ((body.role !== undefined && body.role !== 'admin') || body.active === false || body.active === 0)) fail(400, 'نمی‌توانید نقش یا وضعیت حساب خودتان را کاهش دهید');
  if (sets.length) await db.run(`UPDATE users SET ${sets.join(',')} WHERE id=?`, ...vals, id);
  return { ok: true };
}, A);

route('DELETE', '/api/admin/users/:id', async ({ db, user, params }) => {
  const id = Number(params.id);
  if (id === user.id) fail(400, 'نمی‌توانید حساب خودتان را حذف کنید');
  await db.run('DELETE FROM users WHERE id=?', id);
  return { ok: true };
}, A);

route('GET', '/api/admin/rooms', async ({ db, url }) => {
  const q = '%' + S(url.searchParams.get('q') || '', 60) + '%';
  const page = toInt(url.searchParams.get('page'), 1, 1), size = 25;
  const where = 'WHERE (r.title LIKE ? OR r.slug LIKE ? OR u.name LIKE ?)';
  const total = (await db.one(`SELECT COUNT(*) c FROM rooms r JOIN users u ON u.id=r.owner_id ${where}`, q, q, q)).c;
  const items = await db.all(`SELECT r.id,r.slug,r.title,r.mode,r.status,r.max_participants,r.created_at,u.name AS owner_name,
      (SELECT COUNT(*) FROM attendance WHERE room_id=r.id) AS joins FROM rooms r JOIN users u ON u.id=r.owner_id ${where} ORDER BY r.id DESC LIMIT ? OFFSET ?`, q, q, q, size, (page - 1) * size);
  return { items, total, page, size };
}, A);

route('PATCH', '/api/admin/rooms/:id', async ({ env, db, params, body }) => {
  const r = await db.one('SELECT * FROM rooms WHERE id=?', Number(params.id));
  if (!r) fail(404, 'اتاق پیدا نشد');
  if (body.status !== undefined) await db.run('UPDATE rooms SET status=? WHERE id=?', body.status === 'closed' ? 'closed' : 'open', r.id);
  if (body.max_participants !== undefined) await db.run('UPDATE rooms SET max_participants=? WHERE id=?', toInt(body.max_participants, r.max_participants, 2, 1000), r.id);
  if (body.status === 'closed') lkRaw(env, 'DeleteRoom', { room: r.slug }).catch(() => {});
  return { ok: true };
}, A);

route('POST', '/api/admin/rooms/:id/end', async ({ env, db, params }) => {
  const r = await db.one('SELECT * FROM rooms WHERE id=?', Number(params.id));
  if (!r) fail(404, 'اتاق پیدا نشد');
  await lkCall(env, 'DeleteRoom', { room: r.slug });
  return { ok: true };
}, A);

route('DELETE', '/api/admin/rooms/:id', async ({ env, db, params }) => {
  const r = await db.one('SELECT * FROM rooms WHERE id=?', Number(params.id));
  if (!r) fail(404, 'اتاق پیدا نشد');
  await db.run('DELETE FROM rooms WHERE id=?', r.id);
  lkRaw(env, 'DeleteRoom', { room: r.slug }).catch(() => {});
  return { ok: true };
}, A);

route('GET', '/api/admin/plans', ({ db }) => db.all('SELECT p.*, (SELECT COUNT(*) FROM users WHERE plan_id=p.id) AS users FROM plans p ORDER BY sort,id'), A);

function planFields(body) {
  const name = S(body.name, 60);
  if (!name) fail(400, 'نام پلن را وارد کنید');
  return [name, toInt(body.price, 0, 0), toInt(body.duration_days, 30, 0), toInt(body.max_rooms, 1, 1, 9999), toInt(body.max_participants, 10, 2, 1000),
    body.allow_recording ? 1 : 0, body.active === false || body.active === 0 ? 0 : 1, toInt(body.sort, 0)];
}
route('POST', '/api/admin/plans', async ({ db, body }) => {
  const x = await db.run('INSERT INTO plans(name,price,duration_days,max_rooms,max_participants,allow_recording,active,sort) VALUES (?,?,?,?,?,?,?,?)', ...planFields(body));
  return { id: x.id };
}, A);
route('PATCH', '/api/admin/plans/:id', async ({ db, params, body }) => {
  const p = await db.one('SELECT * FROM plans WHERE id=?', Number(params.id));
  if (!p) fail(404, 'پلن پیدا نشد');
  const f = planFields({ ...p, ...body });
  if (p.is_default && f[6] === 0) fail(400, 'پلن پیش‌فرض را نمی‌توان غیرفعال کرد');
  await db.run('UPDATE plans SET name=?,price=?,duration_days=?,max_rooms=?,max_participants=?,allow_recording=?,active=?,sort=? WHERE id=?', ...f, p.id);
  if (body.is_default) { await db.run('UPDATE plans SET is_default=0'); await db.run('UPDATE plans SET is_default=1, active=1 WHERE id=?', p.id); }
  return { ok: true };
}, A);
route('DELETE', '/api/admin/plans/:id', async ({ db, params }) => {
  const p = await db.one('SELECT * FROM plans WHERE id=?', Number(params.id));
  if (!p) fail(404, 'پلن پیدا نشد');
  if (p.is_default) fail(400, 'پلن پیش‌فرض قابل حذف نیست');
  if ((await db.one('SELECT COUNT(*) c FROM users WHERE plan_id=?', p.id)).c || (await db.one('SELECT COUNT(*) c FROM payments WHERE plan_id=?', p.id)).c) fail(409, 'این پلن استفاده شده است؛ به‌جای حذف آن را غیرفعال کنید');
  await db.run('DELETE FROM plans WHERE id=?', p.id);
  return { ok: true };
}, A);

route('GET', '/api/admin/payments', async ({ db, url }) => {
  const status = S(url.searchParams.get('status') || '', 20);
  const items = await db.all(`SELECT p.*, u.name AS user_name, u.email, pl.name AS plan_name FROM payments p
    JOIN users u ON u.id=p.user_id JOIN plans pl ON pl.id=p.plan_id ${status ? 'WHERE p.status=?' : ''} ORDER BY p.id DESC LIMIT 200`, ...(status ? [status] : []));
  return { items };
}, A);
route('POST', '/api/admin/payments/:id/approve', async ({ db, params }) => {
  const p = await db.one("SELECT * FROM payments WHERE id=? AND status='pending'", Number(params.id));
  if (!p) fail(404, 'پرداخت در انتظار پیدا نشد');
  await db.run("UPDATE payments SET status='paid', paid_at=datetime('now') WHERE id=?", p.id);
  await applyPlan(db, p.user_id, p.plan_id);
  return { ok: true };
}, A);
route('POST', '/api/admin/payments/:id/reject', async ({ db, params, body }) => {
  const p = await db.one("SELECT * FROM payments WHERE id=? AND status='pending'", Number(params.id));
  if (!p) fail(404, 'پرداخت در انتظار پیدا نشد');
  await db.run("UPDATE payments SET status='rejected', note=? WHERE id=?", S(body.note, 200) || null, p.id);
  return { ok: true };
}, A);

route('GET', '/api/admin/settings', async ({ env, db }) => ({ ...(await getSettings(db)), zarinpal: !!env.ZARINPAL_MERCHANT_ID, livekit_url: env.LIVEKIT_URL }), A);
route('PUT', '/api/admin/settings', async ({ db, body }) => {
  for (const k of Object.keys(DEFAULT_SETTINGS)) {
    if (body[k] === undefined) continue;
    let v = S(String(body[k]), 500);
    if (k === 'primary_color' && !/^#[0-9a-fA-F]{6}$/.test(v)) fail(400, 'رنگ باید به شکل #RRGGBB باشد');
    if (k === 'allow_registration') v = body[k] === true || v === '1' ? '1' : '0';
    await db.run('INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', k, v);
  }
  return { ok: true };
}, A);

// ================= entry point =================
export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const allow = env.ALLOWED_ORIGIN || '*';
    const cors = {
      'Access-Control-Allow-Origin': allow, 'Access-Control-Allow-Methods': 'GET, POST, PATCH, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Max-Age': '86400', Vary: 'Origin',
    };
    const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...cors } });
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    try {
      for (const k of ['LIVEKIT_URL', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET']) if (!env[k]) throw new HttpError(500, `متغیر ${k} روی Worker تنظیم نشده است`);
      const url = new URL(request.url);
      if (env.ALLOWED_ORIGIN && origin && origin !== env.ALLOWED_ORIGIN && request.method !== 'GET') throw new HttpError(403, 'origin مجاز نیست');
      let matched = null, params = {};
      for (const r of routes) {
        if (r.method !== request.method) continue;
        const m = r.re.exec(url.pathname.replace(/\/+$/, '') || '/');
        if (m) { matched = r; r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1]))); break; }
      }
      if (!matched) throw new HttpError(404, 'پیدا نشد');
      await ensureReady(env);
      const db = makeDb(env);
      let user = null;
      const bearer = /^Bearer (.+)$/.exec(request.headers.get('Authorization') || '')?.[1];
      if (bearer) {
        const p = await verifyToken(env, bearer);
        if (p?.uid) user = await db.one('SELECT * FROM users WHERE id=? AND active=1', p.uid);
      }
      if (matched.opts.auth && !user) throw new HttpError(401, 'ابتدا وارد حساب کاربری شوید');
      if (matched.opts.auth === 'admin' && user.role !== 'admin') throw new HttpError(403, 'دسترسی ندارید');
      let body = {};
      if (request.method !== 'GET' && request.method !== 'DELETE') {
        const text = await request.text();
        if (text.length > 100000) throw new HttpError(413, 'حجم درخواست زیاد است');
        if (text) { try { body = JSON.parse(text); } catch { throw new HttpError(400, 'درخواست نامعتبر است'); } }
        if (!body || typeof body !== 'object') body = {};
      }
      const ip = request.headers.get('CF-Connecting-IP') || '';
      const out = await matched.handler({ request, env, db, params, url, user, body, ip });
      if (out?.redirect) return new Response(null, { status: 302, headers: { Location: out.redirect } });
      return json(out ?? { ok: true });
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status);
      console.error(e);
      return json({ error: 'خطای داخلی سرور' }, 500);
    }
  },
};
