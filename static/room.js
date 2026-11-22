import { $, $$, api, apiBase, esc, toast, loadSettings, me, modal, roomLink } from './common.js';
import { Whiteboard } from './wb.js';
import { SlideViewer } from './slides.js';

// The room id lives in the #hash so static servers that redirect (clean URLs) cannot drop it. Old ?r= links still work.
const slug = new URLSearchParams(location.hash.slice(1)).get('r') || new URLSearchParams(location.search).get('r') || '';
const CHUNK = 14000;                         // bytes per data-channel message (LiveKit's reliable limit is ~15 KiB)
const docBlobs = new Map();                  // file id -> Blob (host: files it presented; everyone: files received)
const incoming = new Map();                  // file id -> { parts, got, total }
const enc = new TextEncoder(), dec = new TextDecoder();
let LK, room, join, wb, viewer, myRole = 'guest', startedAt = 0, recording = null;
let view = null;                  // what the host is showing everyone: 'wb' | 'doc' | null
let docState = null;              // { id, name, page } of the presented file (kept while the whiteboard is shown)
let docLoaded = null, docChain = Promise.resolve();
const tiles = new Map();          // identity -> tile elements (only people whose camera is on)
const screens = new Map();        // identity -> remote screen-share video track
const hands = new Set();          // identities with raised hand
const speaking = new Set();       // identities currently speaking
let focusVideo, wbWrap, docWrap;

loadSettings();

// ---------- helpers ----------
const meta = (p) => { try { return JSON.parse(p?.metadata || '{}'); } catch { return {}; } };
const roleOf = (p) => (p?.isLocal ? myRole : meta(p).role || 'participant');
const isStaff = (p) => ['host', 'presenter'].includes(roleOf(p));
const isHost = () => myRole === 'host';
const initial = (n) => (String(n || '?').trim()[0] || '?').toUpperCase();
const roleLabel = { host: 'میزبان', presenter: 'ارائه‌دهنده', participant: 'شرکت‌کننده', guest: 'مهمان' };

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src; s.onload = resolve; s.onerror = () => reject(new Error('load failed: ' + src));
    document.head.append(s);
  });
}
async function loadLivekit() {
  if (window.LivekitClient) return;
  try { await loadScript('vendor/livekit-client.umd.min.js'); }
  catch { await loadScript('https://cdn.jsdelivr.net/npm/livekit-client@2/dist/livekit-client.umd.min.js'); }
}

function sendData(obj, topic, to) {
  if (!room) return;
  room.localParticipant.publishData(enc.encode(JSON.stringify(obj)), { reliable: true, topic, destinationIdentities: to }).catch(() => {});
}

// ---------- pre-join ----------
const [info, user] = await Promise.all([slug ? api(`/api/rooms/${slug}/info`).catch((e) => ({ error: e.message })) : { error: 'لینک اتاق نامعتبر است' }, me()]);
const loginLink = (text) => { const a = document.createElement('a'); a.href = 'login.html?next=' + encodeURIComponent('room.html#r=' + slug); a.textContent = text; return a; };
if (info.error) {
  $('#pj-title').textContent = 'اتاق پیدا نشد';
  $('#pj-sub').textContent = info.error;
} else if (info.status !== 'open') {
  $('#pj-title').textContent = info.title;
  $('#pj-sub').textContent = 'این اتاق در حال حاضر بسته است.';
} else {
  document.title = info.title;
  $('#pj-title').textContent = info.title;
  $('#pj-sub').textContent = `برگزارکننده: ${info.owner_name} · ${info.mode === 'class' ? 'حالت کلاس (فقط مدرس صحبت می‌کند)' : 'حالت جلسه (همه می‌توانند صحبت کنند)'}`;
  if (!user && !info.allow_guests) {
    $('#pj-sub').textContent = 'برای ورود به این اتاق ابتدا ';
    $('#pj-sub').append(loginLink('وارد حساب خود شوید'), '.');
  } else {
    $('#pj-form').classList.remove('hidden');
    if (user) $('#pj-name-wrap').classList.add('hidden');
    else { try { $('#pj-name').value = localStorage.getItem('cr-name') || ''; } catch { /* storage blocked */ } }
    if (info.has_password) { $('#pj-pw-wrap').classList.remove('hidden'); $('#pj-pw-wrap label').textContent = 'رمز اتاق (برای میزبان لازم نیست)'; }
    if (!user) $('#pj-login').append(loginLink('ورود با حساب کاربری'));
    $('#pj-go').addEventListener('click', doJoin);
    $('#pj-name').addEventListener('keydown', (e) => e.key === 'Enter' && doJoin());
    $('#pj-pw').addEventListener('keydown', (e) => e.key === 'Enter' && doJoin());
  }
}

async function doJoin() {
  const btn = $('#pj-go');
  btn.disabled = true; $('#pj-err').textContent = '';
  try {
    const name = $('#pj-name').value.trim();
    if (!user && name) { try { localStorage.setItem('cr-name', name); } catch { /* ignore */ } }
    join = await api(`/api/rooms/${slug}/join`, { method: 'POST', body: { name, password: $('#pj-pw').value } });
    await loadLivekit();
    await start({ mic: $('#pj-mic').checked, cam: $('#pj-cam').checked });
  } catch (e) {
    console.error('join failed:', e);
    const errEl = $('#pj-err');                      // the prejoin box may already be replaced by the "ended" screen
    if (errEl) errEl.textContent = e.message;
    if (btn) btn.disabled = false;
  }
}

// ---------- room ----------
async function start({ mic, cam }) {
  LK = window.LivekitClient;
  const { Room, RoomEvent, Track } = LK;
  myRole = join.role;
  room = new Room({ adaptiveStream: true, dynacast: true, videoCaptureDefaults: { resolution: LK.VideoPresets.h540.resolution } });

  buildStage();
  const on = (ev, fn) => room.on(ev, fn);

  on(RoomEvent.ParticipantConnected, (p) => { refreshTile(p); renderPeople(); sys(`${p.name || 'کاربر'} وارد شد`); });
  on(RoomEvent.ParticipantDisconnected, (p) => {
    tiles.get(p.identity)?.el.remove(); tiles.delete(p.identity);
    hands.delete(p.identity); screens.delete(p.identity); speaking.delete(p.identity);
    renderFocus(); renderPeople(); sys(`${p.name || 'کاربر'} خارج شد`);
  });
  on(RoomEvent.TrackSubscribed, (track, pub, p) => {
    if (track.kind === 'audio') {
      const el = track.attach(); el.style.display = 'none'; document.body.append(el);
      recording?.addTrack(track.mediaStreamTrack);
    } else if (pub.source === Track.Source.ScreenShare) { screens.set(p.identity, track); renderFocus(); }
    refreshTile(p);
  });
  on(RoomEvent.TrackUnsubscribed, (track, pub, p) => {
    track.detach().forEach((el) => el.remove());
    if (pub.source === Track.Source.ScreenShare) { screens.delete(p.identity); renderFocus(); }
    refreshTile(p);
  });
  for (const ev of [RoomEvent.TrackMuted, RoomEvent.TrackUnmuted, RoomEvent.LocalTrackPublished, RoomEvent.LocalTrackUnpublished, RoomEvent.TrackPublished, RoomEvent.TrackUnpublished]) {
    on(ev, (a, b) => { const p = b?.identity ? b : a?.identity ? a : room.localParticipant; refreshTile(p); updateControls(); renderPeople(); });
  }
  on(RoomEvent.ActiveSpeakersChanged, (sp) => {
    const ids = new Set(sp.map((s) => s.identity));
    speaking.clear(); ids.forEach((i) => speaking.add(i));
    for (const [id, t] of tiles) t.el.classList.toggle('speaking', ids.has(id));
    $$('#plist .pitem').forEach((row) => row.classList.toggle('speaking', ids.has(row.dataset.id)));
  });
  on(RoomEvent.ParticipantMetadataChanged, (_old, p) => {
    if (p?.isLocal) {
      const r = meta(p).role; if (r) { const was = myRole; myRole = r; applyDrawPerm(); if (was !== r) toast(`نقش شما: ${roleLabel[r] || r}`); }
    }
    renderPeople(); if (p) refreshTile(p);
  });
  on(RoomEvent.ParticipantPermissionsChanged, async (_prev, p) => {
    if (!p?.isLocal) return;
    updateControls();
    if (p.permissions?.canPublish && !p.isMicrophoneEnabled && join.room.mode === 'class') {
      toast('اجازه صحبت به شما داده شد');
      try { await p.setMicrophoneEnabled(true); } catch { /* user denied */ }
    }
  });
  on(RoomEvent.DataReceived, onData);
  on(RoomEvent.Reconnecting, () => toast('اتصال ناپایدار است؛ در حال اتصال مجدد...'));
  on(RoomEvent.Reconnected, () => toast('اتصال برقرار شد'));
  on(RoomEvent.Disconnected, (reason) => {
    const R = LK.DisconnectReason || {};
    showEnded(reason === R.PARTICIPANT_REMOVED ? 'میزبان شما را از جلسه حذف کرد.' : reason === R.ROOM_DELETED ? 'جلسه توسط میزبان پایان یافت.' : 'ارتباط شما با جلسه قطع شد.');
  });

  await room.connect(join.url, join.token);
  startedAt = Date.now();
  $('#prejoin').classList.add('hidden');
  $('#app').classList.remove('hidden');
  $('#r-title').textContent = join.room.title;
  if (join.role === 'host') { $('#b-muteall').classList.remove('hidden'); $('#b-end').classList.remove('hidden'); $('#b-doc').classList.remove('hidden'); if (join.can_record) $('#b-rec').classList.remove('hidden'); }
  $('#b-wb').classList.toggle('hidden', join.role !== 'host');   // only the host chooses what everyone sees
  wb = new Whiteboard(wbWrap, { send: (m) => sendData(m, 'wb'), canDraw: isStaff(room.localParticipant) });
  viewer = new SlideViewer(docWrap, { sendAnn: (m) => sendData(m, 'ann'), canDraw: join.role === 'host', canNav: join.role === 'host', onNav: docNav });
  applyDrawPerm();

  try { await room.startAudio(); } catch { /* needs gesture — handled below */ }
  document.addEventListener('click', () => { if (!room.canPlaybackAudio) room.startAudio().catch(() => {}); });

  const canPub = room.localParticipant.permissions?.canPublish;
  if (canPub) {
    if (mic) await room.localParticipant.setMicrophoneEnabled(true).catch(() => toast('دسترسی به میکروفن ممکن نشد', true));
    if (cam) await room.localParticipant.setCameraEnabled(true).catch(() => toast('دسترسی به دوربین ممکن نشد', true));
  } else sys('این کلاس در حالت سخنرانی است. برای درخواست صحبت از دکمه «✋ دست» استفاده کنید.');

  refreshTile(room.localParticipant);
  room.remoteParticipants.forEach(refreshTile);
  updateControls(); renderPeople(); bindControls();
  setInterval(tick, 1000); tick();
  window.addEventListener('pagehide', () => navigator.sendBeacon(`${apiBase()}/api/rooms/${slug}/leave`, new Blob([JSON.stringify({ leaveToken: join.leaveToken })], { type: 'text/plain' })));

  // ask a host for the current whiteboard / recording state
  setTimeout(() => {
    const hostIds = [...room.remoteParticipants.values()].filter((p) => roleOf(p) === 'host').map((p) => p.identity);
    if (hostIds.length) sendData({ t: 'sync-req' }, 'ctl', hostIds);
  }, 800);

}

function buildStage() {
  focusVideo = document.createElement('video');
  focusVideo.autoplay = true; focusVideo.playsInline = true; focusVideo.muted = true;
  wbWrap = document.createElement('div');
  wbWrap.className = 'wb-wrap hidden';
  docWrap = document.createElement('div');
  docWrap.className = 'doc-wrap hidden';
  $('#focus').append(focusVideo, wbWrap, docWrap);
}

// Whiteboard: host + presenters may draw. Annotations on a presented file: the host (teacher) only.
const applyDrawPerm = () => { wb?.setCanDraw(isStaff(room.localParticipant)); viewer?.setCanDraw(isHost()); };

// A tile exists only while the person's camera is on. Everybody else is listed in the people tab only.
function tileFor(p) {
  let t = tiles.get(p.identity);
  if (t) return t;
  const el = document.createElement('div');
  el.className = 'tile';
  const video = document.createElement('video');
  video.autoplay = true; video.playsInline = true; video.muted = true;
  const label = document.createElement('div'); label.className = 'label';
  const nameEl = document.createElement('span'), stateEl = document.createElement('span');
  label.append(nameEl, stateEl);
  el.append(video, label);
  $('#tiles').append(el);
  t = { el, video, nameEl, stateEl };
  tiles.set(p.identity, t);
  return t;
}

function updateStageEmpty() {
  $('#stage-empty').classList.toggle('hidden', tiles.size > 0 || $('#focus').classList.contains('on'));
}

function refreshTile(p) {
  if (!p) return;
  const { Track } = LK;
  const cam = p.getTrackPublication(Track.Source.Camera);
  const mic = p.getTrackPublication(Track.Source.Microphone);
  const camOn = !!(cam && cam.track && !cam.isMuted);
  if (!camOn) {
    const old = tiles.get(p.identity);
    if (old) { try { cam?.track?.detach(old.video); } catch { /* ignore */ } old.el.remove(); tiles.delete(p.identity); }
    updateStageEmpty();
    return;
  }
  const t = tileFor(p);
  cam.track.attach(t.video);
  t.video.classList.toggle('mirror', !!p.isLocal);
  t.el.classList.toggle('speaking', speaking.has(p.identity));
  t.nameEl.textContent = (p.name || 'کاربر') + (p.isLocal ? ' (شما)' : '');
  t.stateEl.textContent = (hands.has(p.identity) ? '✋ ' : '') + (mic && !mic.isMuted ? '🎙️' : '🔇');
  updateStageEmpty();
}

function renderFocus() {
  const f = $('#focus');
  let on = false;
  focusVideo.classList.add('hidden'); wbWrap.classList.add('hidden'); docWrap.classList.add('hidden');
  if (view === 'wb') { wbWrap.classList.remove('hidden'); on = true; }
  else if (view === 'doc') { docWrap.classList.remove('hidden'); on = true; }
  else if (screens.size) {
    const [, track] = [...screens.entries()][0];
    track.attach(focusVideo);
    focusVideo.classList.remove('hidden'); on = true;
  }
  f.classList.toggle('on', on);
  $('#stage').classList.toggle('has-focus', on);
  updateStageEmpty();
}

// ---------- shared view: whiteboard / presented file (host decides, everyone follows) ----------
const clampPage = (n) => Math.max(1, Math.min(5000, Math.round(Number(n)) || 1));

function sendView(to) { sendData({ a: 'view', v: view, doc: docState }, 'ctl', to); }

/** Make the viewer match docState. Serialised so quick page flips never race a file load. */
function syncDoc() {
  docChain = docChain.then(async () => {
    const st = docState;
    if (!st || view !== 'doc') return;
    try {
      if (docLoaded !== st.id) {
        viewer.setName(st.name);
        const blob = docBlobs.get(st.id);
        if (!blob) { docLoaded = null; viewer.release(); viewer.message(incoming.has(st.id) ? progressText(st.id) : 'در حال دریافت فایل از میزبان...'); return; }
        docLoaded = null;
        await viewer.load(blob);
        docLoaded = st.id;
      }
      if (docState) await viewer.show(docState.page);
    } catch (e) { if (e.message !== 'superseded') toast('نمایش فایل ناموفق بود', true); }
  });
}

// ---------- file transfer over the LiveKit data channel (host -> everyone) ----------
const progressText = (id) => { const r = incoming.get(id); return `در حال دریافت فایل از میزبان... ${r ? Math.round((r.got / r.total) * 100).toLocaleString('fa-IR') : '۰'}٪`; };

// Small progress card (bottom of the screen) shared by sending (host) and receiving (everyone else).
const fmtBytes = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1e3)) + ' KB');
let xferEl = null, xferHide = 0, xferLast = 0;
function showXfer(label, done, total, t0, final = false) {
  const now = performance.now();
  if (!final && now - xferLast < 80) return;          // throttle DOM updates
  xferLast = now;
  if (!xferEl) {
    xferEl = document.createElement('div');
    xferEl.className = 'xfer';
    xferEl.innerHTML = '<div class="xfer-top"><b></b><span class="xfer-pct"></span></div><div class="xfer-bar"><i></i></div><div class="xfer-sub"></div>';
    document.body.append(xferEl);
  }
  clearTimeout(xferHide);
  const pct = Math.min(100, Math.round((done / total) * 100));
  const rate = done / Math.max(0.05, (now - t0) / 1000);
  xferEl.classList.remove('hidden');
  xferEl.querySelector('b').textContent = label;
  xferEl.querySelector('.xfer-pct').textContent = pct.toLocaleString('fa-IR') + '٪';
  xferEl.querySelector('i').style.width = pct + '%';
  xferEl.querySelector('.xfer-sub').textContent = final ? '✓ انجام شد' : `${fmtBytes(done)} از ${fmtBytes(total)} — سرعت: ${fmtBytes(rate)} در ثانیه`;
  if (final) xferHide = setTimeout(() => xferEl.classList.add('hidden'), 1800);
}
const hideXfer = () => { clearTimeout(xferHide); xferEl?.classList.add('hidden'); };

async function sendFile(id, blob, to) {
  if (!room) return;
  const buf = new Uint8Array(await blob.arrayBuffer());
  const total = Math.max(1, Math.ceil(buf.length / CHUNK));
  const track = !to && buf.length > 0;                // progress card only for the broadcast to everyone
  const t0 = performance.now();
  const lp = room.localParticipant;
  for (let i = 0; i < total; i++) {
    const part = buf.subarray(i * CHUNK, (i + 1) * CHUNK);
    try { await lp.publishData(part, { reliable: true, topic: `f:${id}:${i}:${total}`, destinationIdentities: to }); }
    catch { hideXfer(); toast('ارسال فایل با خطا مواجه شد', true); return; }
    if (track) showXfer('ارسال فایل برای شرکت‌کنندگان', Math.min(buf.length, (i + 1) * CHUNK), buf.length, t0, i === total - 1);
    if (i % 32 === 31) await new Promise((r) => setTimeout(r));   // let the UI breathe; the SDK itself waits when the channel buffer is full
  }
}

function onFileChunk(topic, payload) {
  const [, idS, iS, tS] = topic.split(':');
  const id = Number(idS), i = Number(iS), total = Number(tS);
  if (!Number.isInteger(id) || !Number.isInteger(i) || !Number.isInteger(total) || i < 0 || i >= total || total > 1e6) return;
  if (docBlobs.has(id)) return;
  let r = incoming.get(id);
  if (!r || r.total !== total) { r = { parts: new Array(total), got: 0, total, t0: performance.now() }; incoming.set(id, r); }
  if (!r.parts[i]) { r.parts[i] = new Uint8Array(payload); r.got++; }
  showXfer('دریافت فایل از میزبان', r.got * CHUNK, total * CHUNK, r.t0, r.got === total);
  if (r.got === total) {
    incoming.delete(id);
    docBlobs.set(id, new Blob(r.parts, { type: 'application/pdf' }));
    if (docState?.id === id && view === 'doc') syncDoc();
  }
}

function dropDoc() { docState = null; docLoaded = null; viewer?.release(); }

function applyView(m) {
  view = m.v === 'wb' || m.v === 'doc' ? m.v : null;
  const d = m.doc;
  if (d && Number.isInteger(d.id)) docState = { id: d.id, name: String(d.name || '').slice(0, 120), page: clampPage(d.page) };
  else if (!d) dropDoc();
  renderFocus(); updateControls();
  if (view === 'doc') syncDoc();
}

function hostSetView(v) {
  view = v;
  renderFocus(); updateControls(); sendView();
  if (v === 'doc') syncDoc();
}

function docNav({ a }) {
  if (!isHost() || !docState) return;
  if (a === 'close') { dropDoc(); hostSetView(null); return; }
  const page = clampPage(docState.page + (a === 'next' ? 1 : -1));
  if (page === docState.page || (viewer.num && page > viewer.num)) return;
  docState.page = page;
  sendData({ a: 'page', page }, 'ctl');
  syncDoc();
}

function updateControls() {
  if (!room) return;
  const lp = room.localParticipant;
  const canPub = !!lp.permissions?.canPublish;
  const set = (id, active, label, offLabel, enabled = true) => {
    const b = $(id);
    b.textContent = active ? label : offLabel;
    b.classList.toggle('off', !active && /mic|cam/.test(id));
    b.classList.toggle('on', active && /screen|wb|doc|hand/.test(id));
    b.disabled = !enabled;
  };
  set('#b-mic', lp.isMicrophoneEnabled, '🎙️ میکروفن', '🔇 میکروفن', canPub);
  set('#b-cam', lp.isCameraEnabled, '📷 دوربین', '🚫 دوربین', canPub);
  set('#b-screen', lp.isScreenShareEnabled, '⏹ توقف اشتراک', '🖥️ اشتراک صفحه', canPub && !!navigator.mediaDevices?.getDisplayMedia);
  set('#b-wb', view === 'wb', '✏️ بستن وایت‌بورد', '✏️ وایت‌بورد');
  set('#b-doc', view === 'doc', '📄 ارائه فایل', '📄 ارائه فایل');
  set('#b-hand', hands.has(lp.identity), '✋ پایین آوردن دست', '✋ دست', !canPub || join.room.mode === 'class');
  $('#b-hand').classList.toggle('hidden', isHost() || (canPub && join.room.mode !== 'class'));
  set('#b-rec', !!recording, '⏹ توقف ضبط', '⏺ ضبط');
}

function bindControls() {
  const lp = room.localParticipant;
  const guard = (fn) => async () => { try { await fn(); } catch (e) { if (e?.name !== 'NotAllowedError') toast(e.message || 'خطا', true); } updateControls(); };
  $('#b-mic').onclick = guard(() => lp.setMicrophoneEnabled(!lp.isMicrophoneEnabled));
  $('#b-cam').onclick = guard(() => lp.setCameraEnabled(!lp.isCameraEnabled));
  $('#b-screen').onclick = guard(() => lp.setScreenShareEnabled(!lp.isScreenShareEnabled, { audio: true }));
  $('#b-hand').onclick = () => {
    const up = !hands.has(lp.identity);
    up ? hands.add(lp.identity) : hands.delete(lp.identity);
    sendData({ up }, 'hand');
    refreshTile(lp); renderPeople(); updateControls();
  };
  $('#b-wb').onclick = () => { if (isHost()) hostSetView(view === 'wb' ? null : 'wb'); };
  $('#b-doc').onclick = () => { if (isHost()) openFilesModal(); };
  document.addEventListener('keydown', (e) => {          // PowerPoint-style keys for the host while a file is shown
    if (!isHost() || view !== 'doc' || /^(input|textarea|select)$/i.test(e.target.tagName) || e.ctrlKey || e.metaKey || e.altKey) return;
    if (['ArrowRight', 'ArrowDown', 'PageDown', ' '].includes(e.key)) { e.preventDefault(); docNav({ a: 'next' }); }
    else if (['ArrowLeft', 'ArrowUp', 'PageUp'].includes(e.key)) { e.preventDefault(); docNav({ a: 'prev' }); }
  });
  $('#b-side').onclick = () => $('#main').classList.toggle('no-side');
  $('#b-muteall').onclick = () => { sendData({ a: 'mute-all' }, 'ctl'); toast('درخواست بی‌صدا کردن برای همه ارسال شد'); };
  $('#b-rec').onclick = guard(() => (recording ? stopRecording() : startRecording()));
  $('#b-leave').onclick = async () => { await stopRecording(); await room.disconnect(); };
  $('#b-end').onclick = async () => {
    if (!confirm('جلسه برای همه پایان یابد؟')) return;
    await stopRecording();
    try { await api(`/api/rooms/${slug}/host`, { method: 'POST', body: { action: 'end' } }); } catch (e) { toast(e.message, true); }
  };
  $('#r-copy').onclick = () => navigator.clipboard?.writeText(roomLink(slug)).then(() => toast('لینک اتاق کپی شد'), () => toast('کپی نشد', true));

  $$('.sidebar .tab').forEach((t) => (t.onclick = () => {
    $$('.sidebar .tab').forEach((x) => x.classList.toggle('active', x === t));
    $('#p-chat').classList.toggle('hidden', t.dataset.p !== 'chat');
    $('#p-people').classList.toggle('hidden', t.dataset.p !== 'people');
  }));
  $('#chat-form').onsubmit = (e) => {
    e.preventDefault();
    const text = $('#chat-in').value.trim().slice(0, 500);
    if (!text) return;
    sendData({ text }, 'chat');
    addMsg(lp.name, text, true);
    $('#chat-in').value = '';
  };
  $('#plist').onclick = (e) => {
    const b = e.target.closest('button[data-a]');
    if (b) hostAction(b.dataset.a, b.dataset.id);
  };
}

// ---------- data channel ----------
function onData(payload, p, _kind, topic) {
  if (topic && topic.startsWith('f:')) { if (p && roleOf(p) === 'host') onFileChunk(topic, payload); return; }
  let m;
  try { m = JSON.parse(dec.decode(payload)); } catch { return; }
  if (!m || typeof m !== 'object') return;
  const name = p?.name || 'کاربر';
  if (topic === 'chat' && typeof m.text === 'string') addMsg(name, m.text.slice(0, 500), false);
  else if (topic === 'hand' && p) {
    m.up ? hands.add(p.identity) : hands.delete(p.identity);
    if (m.up && isHost()) toast(`✋ ${name} دستش را بالا برد`);
    refreshTile(p); renderPeople();
  } else if (topic === 'wb' && p && isStaff(p)) wb?.apply(m);
  else if (topic === 'ann' && p && roleOf(p) === 'host') viewer?.apply(m);
  else if (topic === 'ctl' && p) {
    if (m.t === 'sync-req') {   // a joiner asks for current state; only hosts answer
      if (!isHost()) return;
      const to = [p.identity];
      sendView(to);
      if (docState && docBlobs.has(docState.id)) sendFile(docState.id, docBlobs.get(docState.id), to);
      if (recording) sendData({ a: 'rec', on: true }, 'ctl', to);
      (async () => {
        const msgs = [...wb.snapshotMessages().map((x) => ['wb', x]), ...viewer.snapshotMessages().map((x) => ['ann', x])];
        for (const [topicName, msg] of msgs) { sendData(msg, topicName, to); await new Promise((r) => setTimeout(r, 15)); }
      })();
      return;
    }
    if (roleOf(p) !== 'host') return;   // everything below is host-only
    if (m.a === 'view') applyView(m);
    else if (m.a === 'page') { if (docState) { docState.page = clampPage(m.page); if (view === 'doc') syncDoc(); } }
    else if (m.a === 'rec') $('#r-rec').classList.toggle('hidden', !m.on);
    else if (m.a === 'mute-all' && !isHost() && room.localParticipant.isMicrophoneEnabled) {
      room.localParticipant.setMicrophoneEnabled(false).then(updateControls);
      toast('میزبان همه را بی‌صدا کرد');
    }
  }
}

// ---------- chat / people ----------
function addMsg(who, text, mine) {
  const box = $('#msgs');
  const d = document.createElement('div');
  d.className = 'msg' + (mine ? ' me' : '');
  const w = document.createElement('span'); w.className = 'who'; w.textContent = mine ? 'شما' : who;
  d.append(w, document.createTextNode(text));
  box.append(d); box.scrollTop = box.scrollHeight;
}
function sys(text) {
  const box = $('#msgs');
  if (!box) return;
  const d = document.createElement('div'); d.className = 'msg sys'; d.textContent = text;
  box.append(d); box.scrollTop = box.scrollHeight;
}

function renderPeople() {
  if (!room) return;
  const { Track } = LK;
  const all = [room.localParticipant, ...room.remoteParticipants.values()];
  all.sort((a, b) => (hands.has(b.identity) - hands.has(a.identity)) || (roleOf(a) === 'host' ? -1 : 0));
  $('#pc').textContent = all.length;
  $('#r-count').textContent = `${all.length} نفر`;
  const list = $('#plist');
  list.textContent = '';
  for (const p of all) {
    const r = roleOf(p);
    const row = document.createElement('div'); row.className = 'pitem' + (speaking.has(p.identity) ? ' speaking' : ''); row.dataset.id = p.identity;
    const left = document.createElement('div'); left.className = 'who';
    const nameEl = document.createElement('span');
    nameEl.textContent = `${hands.has(p.identity) ? '✋ ' : ''}${p.name || 'کاربر'}${p.isLocal ? ' (شما)' : ''}`;
    const badge = document.createElement('span'); badge.className = 'badge'; badge.textContent = roleLabel[r] || r;
    const camP = p.getTrackPublication(Track.Source.Camera), micP = p.getTrackPublication(Track.Source.Microphone);
    const st = document.createElement('span'); st.className = 'st';
    st.textContent = `${camP && !camP.isMuted ? '📷' : ''}${micP && !micP.isMuted ? '🎙️' : '🔇'}`;
    left.append(nameEl, badge, st);
    row.append(left);
    if (isHost() && !p.isLocal && r !== 'host') {
      const acts = document.createElement('div'); acts.className = 'acts';
      const mk = (a, text) => { const b = document.createElement('button'); b.dataset.a = a; b.dataset.id = p.identity; b.textContent = text; acts.append(b); };
      const mic = p.getTrackPublication(Track.Source.Microphone);
      if (mic && !mic.isMuted) mk('mute', 'بی‌صدا');
      r === 'presenter' ? mk('demote', 'لغو ارائه') : mk('promote', join.room.mode === 'class' ? 'اجازه صحبت' : 'ارائه‌دهنده');
      mk('remove', 'حذف');
      row.append(acts);
    }
    list.append(row);
  }
}

async function hostAction(action, identity) {
  try {
    const body = { action, identity };
    if (action === 'mute') {
      const pub = room.remoteParticipants.get(identity)?.getTrackPublication(LK.Track.Source.Microphone);
      if (!pub) return toast('میکروفن این فرد خاموش است');
      body.trackSid = pub.trackSid;
    }
    if (action === 'remove' && !confirm('این فرد از جلسه حذف شود؟')) return;
    await api(`/api/rooms/${slug}/host`, { method: 'POST', body });
  } catch (e) { toast(e.message, true); }
}

// ---------- presentation files (host) ----------
const fmtSize = (b) => (b > 1e6 ? (b / 1e6).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1e3)) + ' KB');
const localFiles = [];   // files this host picked in this session: { id, name, size }

function openFilesModal() {
  const m = modal(`<div class="files-modal">
    <h3>ارائهٔ فایل</h3>
    <div class="upload-box">
      <input type="file" id="f-in" accept=".pdf,application/pdf" class="hidden">
      <button class="btn primary" id="f-pick">انتخاب فایل PDF</button>
      <p class="muted" style="margin:.5rem 0 0">بدون محدودیت حجم (فایل‌های خیلی بزرگ دیرتر به دانش‌آموزان می‌رسند). فایل مستقیماً از مرورگر شما برای شرکت‌کنندگان ارسال می‌شود.
      برای پاورپوینت: در PowerPoint از File ← Save as ← PDF بگیرید و آن را انتخاب کنید.</p>
    </div>
    <div id="f-list"></div>
    <div class="actions"><button class="btn" data-close>بستن</button></div></div>`);
  const $m = (s2) => m.el.querySelector(s2);
  $m('[data-close]').onclick = m.close;

  function refresh() {
    $m('#f-list').innerHTML = localFiles.length ? `<div class="table-wrap"><table>
      <tr><th>نام فایل</th><th>حجم</th><th></th></tr>
      ${localFiles.map((f) => `<tr><td>${esc(f.name)}</td><td>${fmtSize(f.size)}</td>
        <td class="row"><button class="btn sm primary" data-show="${f.id}">ارائه</button><button class="btn sm danger" data-del="${f.id}">حذف</button></td></tr>`).join('')}
      </table></div>` : '<p class="muted" style="margin-top:.75rem">هنوز فایلی انتخاب نشده است.</p>';
  }

  $m('#f-pick').onclick = () => $m('#f-in').click();
  $m('#f-in').onchange = async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    if (!/\.pdf$/i.test(file.name)) return toast('فقط فایل PDF پذیرفته می‌شود. پاورپوینت را به PDF تبدیل کنید.', true);
    const head = new Uint8Array(await file.slice(0, 5).arrayBuffer());
    if (String.fromCharCode(...head) !== '%PDF-') return toast('این فایل PDF معتبر نیست', true);
    const id = Date.now();
    docBlobs.set(id, file);
    localFiles.push({ id, name: file.name, size: file.size });
    present(id);
    m.close();
  };

  m.el.onclick = (e) => {
    const show = e.target.closest('[data-show]'), del = e.target.closest('[data-del]');
    if (show) { present(Number(show.dataset.show)); m.close(); }
    else if (del && confirm('این فایل حذف شود؟')) {
      const id = Number(del.dataset.del);
      localFiles.splice(localFiles.findIndex((f) => f.id === id), 1);
      docBlobs.delete(id);
      if (docState?.id === id) { dropDoc(); hostSetView(null); }
      refresh();
    }
  };
  refresh();
}

function present(id) {
  const f = localFiles.find((x) => x.id === id);
  if (!f) return;
  docState = { id: f.id, name: f.name, page: 1 };
  docLoaded = null;
  hostSetView('doc');
  sendFile(f.id, docBlobs.get(f.id));      // everyone currently in the room; late joiners get it via sync-req
}

// ---------- recording (host's browser; the file is saved on the host's computer) ----------
async function startRecording() {
  if (recording) return;
  const display = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 15 }, audio: true });
  const ac = new AudioContext();
  const dest = ac.createMediaStreamDestination();
  const seen = new Set();
  const addTrack = (mst) => {
    if (!mst || seen.has(mst.id)) return;
    seen.add(mst.id);
    try { ac.createMediaStreamSource(new MediaStream([mst])).connect(dest); } catch { /* ignore */ }
  };
  display.getAudioTracks().forEach(addTrack);
  const { Track } = LK;
  addTrack(room.localParticipant.getTrackPublication(Track.Source.Microphone)?.track?.mediaStreamTrack);
  for (const p of room.remoteParticipants.values()) for (const pub of p.audioTrackPublications.values()) addTrack(pub.track?.mediaStreamTrack);

  const mime = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'].find((m) => MediaRecorder.isTypeSupported(m));
  const mr = new MediaRecorder(new MediaStream([...display.getVideoTracks(), ...dest.stream.getAudioTracks()]), { mimeType: mime, videoBitsPerSecond: 1500000 });
  const chunks = [];
  mr.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  mr.onstop = () => {
    if (!chunks.length) return;
    const url = URL.createObjectURL(new Blob(chunks, { type: 'video/webm' }));
    const a = document.createElement('a');
    a.href = url; a.download = `ضبط-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.webm`;
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    toast('ضبط پایان یافت و فایل در رایانهٔ شما ذخیره شد');
  };
  display.getVideoTracks()[0].addEventListener('ended', () => stopRecording());
  mr.start(2000);
  recording = { mr, display, ac, addTrack };
  sendData({ a: 'rec', on: true }, 'ctl');
  $('#r-rec').classList.remove('hidden');
  toast('ضبط شروع شد. همه شرکت‌کنندگان نشانگر «در حال ضبط» را می‌بینند.');
  updateControls();
}

async function stopRecording() {
  if (!recording) return;
  const r = recording;
  recording = null;
  try { if (r.mr.state !== 'inactive') r.mr.stop(); } catch { /* ignore */ }
  r.display.getTracks().forEach((t) => t.stop());
  setTimeout(() => r.ac.close().catch(() => {}), 1000);
  sendData({ a: 'rec', on: false }, 'ctl');
  $('#r-rec').classList.add('hidden');
  updateControls();
}

// ---------- misc ----------
function tick() {
  const s = Math.floor((Date.now() - startedAt) / 1000);
  const f = (n) => String(n).padStart(2, '0');
  $('#r-timer').textContent = `${f(Math.floor(s / 3600))}:${f(Math.floor((s % 3600) / 60))}:${f(s % 60)}`;
}

function showEnded(msg) {
  stopRecording();
  $('#app').classList.add('hidden');
  const box = $('#prejoin');
  box.classList.remove('hidden');
  box.textContent = '';
  const h = document.createElement('h2'); h.textContent = 'جلسه به پایان رسید';
  const p = document.createElement('p'); p.className = 'muted'; p.textContent = msg;
  const b = document.createElement('button'); b.className = 'btn primary'; b.textContent = 'ورود دوباره'; b.onclick = () => location.reload();
  const a = document.createElement('a'); a.href = './'; a.className = 'btn'; a.textContent = 'صفحه اصلی'; a.style.marginInlineStart = '.5rem';
  box.append(h, p, b, a);
}
