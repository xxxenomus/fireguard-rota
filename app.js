'use strict';

// ---------- helpers ----------
const $ = s => document.querySelector(s);
const KEY = 'fireguard-v3';           // this phone's copy of the crew's rota
const CREW_KEY = 'fireguard-crew';
const DEV_KEY = 'fireguard-device';
const DB = 'https://fireguard-rota-caf41748-default-rtdb.europe-west1.firebasedatabase.app';
const COLORS = ['#ff6b35', '#f7c548', '#3ec1d3', '#a06cd5', '#58d68d'];
const START = 19 * 60, P = 5, MAX_JOBS = 5; // 19:00–07:00 in 30-minute blocks, 5 guys
let S = 24; // half-hours in tonight's shift: 24, or 26 / 22 on the nights the clocks change

// Fixed timetables for 1-5 jobs. grid[block][job] = guy number.
// Every night starts from one of these, so every phone shows the same thing.
const TEMPLATES = {"1":{"roles":["Guy 1","Guy 2","Guy 3","Guy 4","Lucky"],"grid":["4","4","0","0","0","1","1","1","2","2","3","3","3","2","2","2","0","0","4","4","1","1","3","3"]},"2":{"roles":["Guy 1","Guy 2","Guy 3","Lucky 1","Lucky 2"],"grid":["03","03","13","14","04","04","01","21","21","23","03","03","24","24","04","01","01","21","24","24","14","13","23","23"]},"3":{"roles":["Guy 1","Guy 2","Guy 3","Unlucky 1","Unlucky 2"],"grid":["302","304","314","214","210","230","430","431","421","021","023","043","143","142","102","302","304","314","214","210","230","430","431","421"]},"4":{"roles":["Guy 1","Guy 2","Guy 3","Guy 4","Unlucky"],"grid":["4123","0423","0143","0124","0123","4123","0423","0143","0124","0123","4123","0423","0143","0124","0123","4123","0423","0143","0124","0123","4123","0423","0143","0124"]},"5":{"roles":["Guy 1","Guy 2","Guy 3","Guy 4","Guy 5"],"grid":["01234","01234","01234","01234","01234","01234","01234","01234","01234","01234","01234","01234","01234","01234","01234","01234","01234","01234","01234","01234","01234","01234","01234","01234"]}};
// Tonight only (24-25 Oct 2026, clocks go back at 03:00, so 26 half-hours). Names instead of Guy 1-5;
// Liudas goes first and Linas works 02:00 -> 02:00.
const SPECIAL = { '2026-10-24': {"names":["Liudas","Martynas","Lukas","Linas","Daniels"],"pin":{"guy":3,"from":14,"to":16},"grids":{"1":["0","0","4","4","4","0","0","0","1","1","1","4","4","4","3","3","1","1","2","2","3","3","3","2","2","2"],"2":["03","03","02","12","12","14","04","04","03","23","23","14","14","14","03","03","14","14","13","23","23","24","04","04","12","12"],"3":["140","140","120","123","423","423","140","140","120","423","423","143","140","120","123","423","420","130","130","430","420","123","123","120","430","430"],"4":["0234","0234","0134","0214","0231","1234","0234","0134","0214","0231","1234","0234","0134","0214","0231","1234","0214","0134","0234","0231","1234","0234","0134","0214","0231","1234"],"5":["42301","42301","42301","42301","42301","42301","42301","42301","42301","42301","42301","42301","42301","42301","32401","32401","42301","42301","42301","42301","42301","42301","42301","42301","42301","42301"]}} };
const NOTES = {
  3: 'After your break, go to the next job: 1 → 2 → 3 → 1.',
  4: 'Unlucky is the relief: he goes round giving everyone their break.',
  5: 'Everyone stays on their own job all night.',
};

const uid = () => Math.random().toString(36).slice(2, 10);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = min => { min = ((min % 1440) + 1440) % 1440; return String(Math.floor(min / 60)).padStart(2, '0') + ':' + String(min % 60).padStart(2, '0'); };
const dur = min => { const h = Math.floor(min / 60), m = min % 60; return h && m ? `${h}h ${m}m` : h ? `${h}h` : `${m}m`; };
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
// clock time at the start of block t (real clock, so it's right when the clocks change)
const at = t => { const d = new Date((doc.night ? doc.night.startTs : shiftStart()) + t * 1800000); return fmt(d.getHours() * 60 + d.getMinutes()); };

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), 2600);
}

// ---------- state ----------
// One shared doc per crew: tonight's rota. Every phone keeps a copy; the newest copy wins.
const emptyDoc = () => ({ v: 3, rev: 0, ts: 0, by: '', night: null });
function loadDoc() {
  try { const d = JSON.parse(localStorage.getItem(KEY)); if (d && d.v === 3) return d; } catch (e) {}
  return emptyDoc();
}
function saveLocal() {
  try { localStorage.setItem(KEY, JSON.stringify(doc)); } catch (e) { toast('Could not save on this phone'); }
}
// Every change goes through here: saved on this phone and sent to the crew.
function commit() {
  doc.rev++;
  doc.ts = Date.now();
  doc.by = device;
  saveLocal();
  publishSoon();
  render();
}

let doc = loadDoc();
const device = localStorage.getItem(DEV_KEY) || (() => { const d = uid(); localStorage.setItem(DEV_KEY, d); return d; })();

// 19:00 on the given day (0 = today) and 07:00 the next morning, by the real clock
function nightBounds(day) {
  const s = new Date();
  s.setDate(s.getDate() + day);
  s.setHours(19, 0, 0, 0);
  const e = new Date(s);
  e.setDate(e.getDate() + 1);
  e.setHours(7, 0, 0, 0);
  return [s.getTime(), e.getTime()];
}
// Timestamp of the shift start: the one running now, else the next one.
function shiftStart() {
  const [ps, pe] = nightBounds(-1);
  return Date.now() < pe ? ps : nightBounds(0)[0];
}
function nightLength(startTs) {
  const e = new Date(startTs);
  e.setDate(e.getDate() + 1);
  e.setHours(7, 0, 0, 0);
  return Math.round((e.getTime() - startTs) / 1800000);
}
const dayKey = ts => { const d = new Date(ts); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

function freshNight(J, startTs) {
  const len = nightLength(startTs), sp = SPECIAL[dayKey(startTs)];
  const n = { startTs, S: len, j0: J, changed: false, roles: TEMPLATES[J].roles.slice(), jobs: Array.from({ length: J }, () => ({ from: 0, to: len })) };
  S = len;
  if (sp && sp.grids[J].length === len) {
    Object.assign(n, { roles: sp.names.slice(), pin: sp.pin, grid: sp.grids[J].map(r => r.split('').map(Number)) });
  } else if (len === 24) {
    n.grid = TEMPLATES[J].grid.map(r => r.split('').map(Number));
  } else {
    // a clock-change night without a ready-made timetable: work one out
    n.grid = regen(n, 0, Array.from({ length: len }, () => new Array(J).fill(-1)));
  }
  return n;
}
// Each night starts from the fixed timetable (same on every phone, so nothing needs sending).
function ensureNight() {
  const ts = shiftStart();
  if (!doc.night || doc.night.startTs !== ts || (doc.night.S || 24) !== nightLength(ts)) {
    doc.night = freshNight(doc.night ? doc.night.j0 : 3, ts);
  }
  S = doc.night.S || 24;
}
// Changes take effect from the nearest block boundary; everything before it stays as it happened.
const cutNow = n => clamp(Math.round((Date.now() - n.startTs) / 1800000), 0, S);
const nowBlock = n => { const t = Math.floor((Date.now() - n.startTs) / 1800000); return t >= 0 && t < S ? t : -1; };
const activeJobs = (n, t) => n.jobs.map((j, k) => k).filter(k => t >= n.jobs[k].from && t < n.jobs[k].to);

// ---------- generator ----------
// Re-generates every block from `cut` on after the jobs change.
// 1. Hours: the work still to do is shared so the night's totals are as even as possible;
//    any leftover goes to Unlucky first and Lucky last.
// 2. A first version is built block by block, then polished by trying lots of small swaps.
//    Goals: stretches of 60-90 min, people staying on their own job, no 30-min breaks,
//    and as few changes to the old plan as possible.
function regen(n, cut, prev) {
  const J = n.jobs.length, g = prev.map((r, t) => (t < cut ? r.slice() : new Array(J).fill(-1)));
  const past = new Array(P).fill(0);
  for (let t = 0; t < cut; t++) g[t].forEach(x => { if (x >= 0) past[x]++; });
  const rows = [];
  for (let t = cut; t < S; t++) rows.push(activeJobs(n, t).slice(0, P));
  const W = rows.reduce((a, r) => a + r.length, 0), cap = rows.filter(r => r.length).length;
  const prio = i => (n.roles[i].startsWith('Unlucky') ? 0 : n.roles[i].startsWith('Lucky') ? 2 : 1);
  const rem = new Array(P).fill(0);
  for (let u = 0; u < W; u++) {
    let b = -1;
    for (let i = 0; i < P; i++) {
      if (rem[i] >= cap) continue;
      const x = past[i] + rem[i], y = b < 0 ? 0 : past[b] + rem[b];
      if (b < 0 || x < y || (x === y && (prio(i) < prio(b) || (prio(i) === prio(b) && i < b)))) b = i;
    }
    if (b < 0) break;
    rem[b]++;
  }

  const left = rem.slice();
  for (let t = cut; t < S; t++) {
    const A = rows[t - cut];
    if (!A.length) continue;
    const busyAhead = rows.slice(t - cut).filter(r => r.length).length, before = g[t - 1] || [], row = g[t];
    const chosen = [0, 1, 2, 3, 4].filter(i => left[i] > 0).sort((a, b) =>
      (left[b] >= busyAhead) - (left[a] >= busyAhead) || left[b] - left[a] || before.includes(b) - before.includes(a) || a - b).slice(0, A.length);
    // stay where you were, else where the old plan had you, else any free job
    for (const i of chosen) { const k = before.indexOf(i); if (A.includes(k) && row[k] < 0) row[k] = i; }
    for (const i of chosen) { if (row.includes(i)) continue; const k = (prev[t] || []).indexOf(i); if (A.includes(k) && row[k] < 0) row[k] = i; }
    for (const i of chosen) { if (!row.includes(i)) row[A.find(k => row[k] < 0)] = i; }
    chosen.forEach(i => { left[i]--; });
    // safety net: never leave a running job empty
    for (const k of A) if (row[k] < 0) row[k] = [0, 1, 2, 3, 4].find(i => !row.includes(i));
  }
  return polish(g, cut, prev, n.pin);
}

// Lower is tidier.
function score(g, cut, prev, pin) {
  const J = g[0].length;
  let sc = 0;
  // a pinned stretch (tonight: Linas 02:00 -> 02:00) must stay exactly as it is, wherever people can rest
  if (pin) {
    for (let t = Math.max(cut, pin.from - 1); t <= pin.to && t < S; t++) {
      const on = g[t].includes(pin.guy), want = t >= pin.from && t < pin.to, busy = g[t].filter(x => x >= 0).length;
      if (on !== want && (want ? busy > 0 : busy < P)) sc += 3000;
    }
  }
  for (let p = 0; p < P; p++) {
    const cnt = new Array(J).fill(0);
    for (let t = 0; t < S; t++) { const k = g[t].indexOf(p); if (k >= 0) cnt[k]++; }
    const home = cnt.indexOf(Math.max(...cnt)), sites = cnt.filter(c => c > 0).length;
    if (sites > 1) sc += 50 + 15 * (sites - 1);
    let t = 0, prevEnd = -1;
    while (t < S) {
      let k = g[t].indexOf(p);
      if (k < 0) { t++; continue; }
      const s = t;
      if (k !== home) sc += 12;
      let cur = k, seg = 0;
      while (t < S && (k = g[t].indexOf(p)) >= 0) {
        if (k !== cur) { sc += 20; if (seg === 1) sc += 60; cur = k; seg = 0; }
        seg++;
        if (k !== home) sc += 1;
        t++;
      }
      if (seg === 1 && t - s > 1) sc += 60;
      const len = t - s;
      sc += 5;
      if (len < 2) sc += 80;
      if (len > 3) sc += 35 * (len - 3);
      if (prevEnd >= 0 && s - prevEnd === 1) sc += 35;
      prevEnd = t;
    }
  }
  for (let t = Math.max(1, cut); t < S; t++) {
    if (t % 2 && g[t].join() !== g[t - 1].join()) sc += 1;
    for (let k = 0; k < J; k++) if (prev[t] && g[t][k] !== (prev[t][k] ?? -1)) sc += 4;
  }
  return sc;
}

function polish(g, cut, prev, pin, iters = 70000) {
  const J = g[0].length, F = S - cut, rint = x => Math.floor(Math.random() * x);
  if (F <= 0) return g;
  let cur = g, cs = score(g, cut, prev, pin), best = cur, bs = cs;
  for (let i = 0; i < iters; i++) {
    const h = cur.map(r => r.slice());
    if (Math.random() < 0.6) {
      // two guys trade a stretch of work and rest, so both totals stay the same
      const L = 1 + rint(3), a = rint(P), b = rint(P);
      if (a === b || F < 2 * L) continue;
      const t1 = cut + rint(F - L + 1), t2 = cut + rint(F - L + 1);
      if (Math.abs(t1 - t2) < L) continue;
      let ok = true;
      for (let j = 0; j < L && ok; j++) {
        ok = h[t1 + j].includes(a) && !h[t1 + j].includes(b) && h[t2 + j].includes(b) && !h[t2 + j].includes(a);
      }
      if (!ok) continue;
      for (let j = 0; j < L; j++) { h[t1 + j][h[t1 + j].indexOf(a)] = b; h[t2 + j][h[t2 + j].indexOf(b)] = a; }
    } else {
      // two guys trade jobs for a while
      if (J < 2) continue;
      const L = 1 + rint(Math.min(6, F)), t1 = cut + rint(F - L + 1), x = rint(J), y = rint(J);
      if (x === y) continue;
      let ok = true;
      for (let j = 0; j < L && ok; j++) ok = h[t1 + j][x] >= 0 && h[t1 + j][y] >= 0;
      if (!ok) continue;
      for (let j = 0; j < L; j++) { const r = h[t1 + j]; [r[x], r[y]] = [r[y], r[x]]; }
    }
    const temp = 60 * Math.pow(0.05 / 60, i / iters), hs = score(h, cut, prev, pin);
    if (hs <= cs || Math.random() < Math.exp((cs - hs) / temp)) {
      cur = h; cs = hs;
      if (cs < bs) { best = cur; bs = cs; }
    }
  }
  return best;
}

// Applies a change to the jobs, then re-generates the rest of the night.
function changeJobs(msg, fn) {
  const n = doc.night, cut = cutNow(n);
  if (cut >= S) return toast('The shift is over');
  if (fn(n, cut) === false) return;
  const J = n.jobs.length;
  n.grid.forEach(r => { while (r.length < J) r.push(-1); });
  const prev = n.grid.map(r => r.slice());
  n.changed = true;
  toast('Working it out…');
  setTimeout(() => {
    n.grid = regen(n, cut, prev);
    commit();
    toast(`${msg}. Rota updated from ${at(cut)} ✅`);
  }, 30);
}

// one entry per continuous stretch, listing the jobs in order (a relief guy moves within a stretch)
function stretches(n, guy) {
  const segs = [];
  n.grid.forEach((row, t) => {
    const k = row.indexOf(guy);
    if (k < 0) return;
    const L = segs[segs.length - 1];
    if (L && L.end === t) { L.end = t + 1; if (L.jobs[L.jobs.length - 1] !== k) L.jobs.push(k); }
    else segs.push({ jobs: [k], start: t, end: t + 1 });
  });
  return segs;
}
const jobsText = x => 'Job ' + x.jobs.map(k => k + 1).join(' → ');
// 😬 works more than most of the crew, 🍀 less (the template slots are already called Unlucky / Lucky)
function label(n, i) {
  const name = n.roles[i];
  if (/^(Unlucky|Lucky)/.test(name)) return (name.startsWith('Unlucky') ? '😬 ' : '🍀 ') + name;
  const w = n.roles.map((_, k) => workOf(n, k)), counts = {};
  w.forEach(x => { counts[x] = (counts[x] || 0) + 1; });
  const most = +Object.keys(counts).sort((a, b) => counts[b] - counts[a] || a - b)[0];
  return (w[i] > most ? '😬 ' : w[i] < most ? '🍀 ' : '') + name;
}
const workOf = (n, guy) => n.grid.reduce((a, r) => a + (r.includes(guy) ? 1 : 0), 0) * 30;

// ---------- sharing ----------
const crewUrl = () => location.origin + location.pathname + '#c=' + sync.crew;

function rotaText(n) {
  const running = activeJobs(n, clamp(cutNow(n), 0, S - 1)).length;
  let s = `🔥 Rota · ${plural(n.changed ? running : n.j0, 'job')} · 19:00–07:00\n\n`;
  n.roles.forEach((name, i) => {
    s += `• ${label(n, i)} (${dur(workOf(n, i))}): ${stretches(n, i).map(x => `${at(x.start)}–${at(x.end)} ${jobsText(x)}`).join(', ')}\n`;
  });
  if (!n.changed && NOTES[n.j0]) s += `\n${NOTES[n.j0]}\n`;
  return s + `\n👉 ${crewUrl()}`;
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); }
  catch (e) {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  toast('Copied 📋');
}
async function shareText(text) {
  if (navigator.share) {
    try { await navigator.share({ title: 'Fireguard rota', text }); return; }
    catch (e) { if (e.name === 'AbortError') return; }
  }
  copyText(text);
}

// ---------- sync ----------
// The crew's rota lives in a Firebase Realtime Database (free plan) at /crews/<crew code>.
// Every save writes the whole doc with a higher rev. The database rules refuse anything
// that isn't newer, so an outdated phone can't overwrite fresher data. Phones stream
// changes live and keep their own copy, so the app also works offline.
const sync = { crew: null, es: null, timer: null, dirty: false, lastConnect: 0 };
const crewPath = () => `${DB}/crews/${sync.crew}.json`;
const newer = (a, b) => a.rev > b.rev || (a.rev === b.rev && a.ts > b.ts);
const unwrap = w => { try { return w && typeof w.data === 'string' ? JSON.parse(w.data) : null; } catch (e) { return null; } };

async function fetchRemote() {
  const r = await fetch(crewPath());
  if (!r.ok) throw new Error('db ' + r.status);
  return unwrap(await r.json());
}

function setStatus(s) {
  const el = $('#sync');
  el.className = 'sync ' + s;
  el.textContent = { live: '● live', offline: '● offline', connecting: '● …' }[s];
}

function publishSoon(delay = 600) {
  sync.dirty = true;
  clearTimeout(sync.timer);
  sync.timer = setTimeout(publish, delay);
}
async function publish() {
  if (!sync.crew || !sync.dirty) return;
  const sent = doc.rev;
  try {
    const body = JSON.stringify({ rev: doc.rev, ts: doc.ts, by: device, data: JSON.stringify(doc) });
    const r = await fetch(crewPath(), { method: 'PUT', body });
    if (r.status === 401 || r.status === 403) {
      // refused: the database already has a newer version
      const remote = await fetchRemote();
      if (remote && remote.by === device && remote.rev >= sent) {
        // our own later save got there first; nothing lost
        if (doc.rev === sent) sync.dirty = false;
      } else if (remote && remote.v === 3 && remote.rev >= sent) {
        // someone else saved first; theirs wins
        sync.dirty = false;
        doc.rev = -1;
        receive(remote);
        toast('Someone else changed the rota at the same moment. Please check and redo yours');
      } else if (remote && remote.rev >= sent) {
        // leftover data from the old version of the app: go past it
        doc.rev = remote.rev + 1;
        return publish();
      } else {
        sync.dirty = false;
        toast('Could not save to the crew. Try again');
      }
      setStatus('live');
      return;
    }
    if (!r.ok) throw new Error('db ' + r.status);
    if (doc.rev === sent) sync.dirty = false;
    setStatus('live');
  } catch (e) {
    setStatus('offline');
    clearTimeout(sync.timer);
    sync.timer = setTimeout(publish, 30000);
  }
}

function receive(remote) {
  if (!remote || remote.v !== 3 || !newer(remote, doc)) return false;
  doc = remote;
  sync.dirty = false;
  saveLocal();
  render();
  return true;
}

async function connect() {
  if (!sync.crew) return;
  sync.lastConnect = Date.now();
  setStatus('connecting');
  try {
    const remote = await fetchRemote();
    if (remote && remote.v === 3) receive(remote);
    // share ours if the database has nothing newer (or only data from the old app)
    if (doc.rev > 0 && (!remote || remote.v !== 3 || newer(doc, remote))) publishSoon(300);
    setStatus('live');
  } catch (e) {
    setStatus('offline');
  }
  openStream();
}
function openStream() {
  if (!window.EventSource) return;
  if (sync.es) sync.es.close();
  const es = new EventSource(crewPath());
  const refresh = () => fetchRemote().then(receive).catch(() => {});
  es.addEventListener('put', e => {
    try {
      const m = JSON.parse(e.data);
      if (m.path === '/') receive(unwrap(m.data));
      else refresh();
    } catch (err) {}
  });
  es.addEventListener('patch', refresh);
  es.addEventListener('cancel', () => setStatus('offline'));
  es.onopen = () => setStatus('live');
  es.onerror = () => setStatus(navigator.onLine === false ? 'offline' : 'connecting');
  sync.es = es;
}

function initCrew() {
  const m = location.hash.match(/^#c=([a-z0-9]{8,40})$/i);
  let crew = localStorage.getItem(CREW_KEY);
  if (m && crew !== m[1].toLowerCase()) {
    crew = m[1].toLowerCase();
    localStorage.setItem(CREW_KEY, crew);
    doc = emptyDoc();
    saveLocal();
  }
  if (location.hash) history.replaceState(null, '', location.pathname);
  if (!crew) {
    crew = Array.from(crypto.getRandomValues(new Uint8Array(10)), b => (b % 36).toString(36)).join('');
    localStorage.setItem(CREW_KEY, crew);
  }
  sync.crew = crew;
}

// ---------- rendering ----------
function jobStatus(n, j, cut) {
  if (cut >= j.to) return `ended ${at(j.to)}`;
  if (j.from > 0) return cut < j.from ? `from ${at(j.from)}` : `since ${at(j.from)}`;
  return '';
}

function render() {
  ensureNight();
  const n = doc.night, cut = cutNow(n), now = nowBlock(n), over = cut >= S;
  const running = activeJobs(n, Math.min(cut, S - 1)).length;

  let h = `<div class="card"><h2>Jobs at the start</h2><div class="chips">${[1, 2, 3, 4, 5].map(k =>
    `<button class="chip ${k === n.j0 ? 'on' : ''}" data-act="start" data-val="${k}">${k}</button>`).join('')}</div>
    ${!n.changed && NOTES[n.j0] ? `<div class="small" style="margin-top:10px">${NOTES[n.j0]}</div>` : ''}</div>`;

  h += `<div class="card"><h2>Jobs</h2>
    ${n.jobs.map((j, k) => `<div class="lrow"><div><b>Job ${k + 1}</b> <span class="mut small">${jobStatus(n, j, cut)}</span></div>
      ${over ? '' : j.to > cut ? `<button class="sbtn" data-act="end" data-k="${k}">⛔ Ended</button>`
        : `<button class="sbtn" data-act="resume" data-k="${k}">▶ Back on</button>`}</div>`).join('')}
    ${over || running >= MAX_JOBS ? '' : `<button class="btn" style="margin-top:8px" data-act="add">➕ New job from ${at(cut)}</button>`}</div>`;

  h += '<div class="card"><h2>19:00–07:00</h2><div class="people">' + n.roles.map((name, i) => {
    const work = workOf(n, i);
    return `<div class="pp"><div class="pp-top"><span class="tag" style="--c:${COLORS[i]}">${esc(label(n, i))}</span></div>
      <div class="wt">🔨 <b>${dur(work)}</b> · ☕ <b>${dur(S * 30 - work)}</b></div>
      <div class="pp-segs">${stretches(n, i).map(x =>
        `<div class="${now >= x.start && now < x.end ? 'now' : ''}">${at(x.start)}–${at(x.end)} <span class="mut">${jobsText(x)}</span></div>`).join('')
        || '<span class="mut">No watch</span>'}</div></div>`;
  }).join('') + '</div></div>';

  h += `<div class="card actions">
    <button class="btn acc" data-act="send">📤 Send to the group</button>
    <button class="btn" data-act="invite">🔗 Invite</button></div>`;
  $('#rota').innerHTML = h;
}

// ---------- events ----------
document.addEventListener('click', e => {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  const n = doc.night, k = Number(b.dataset.k);
  switch (b.dataset.act) {
    case 'start': {
      const J = Number(b.dataset.val);
      if (J === n.j0 && !n.changed) break;
      if (n.changed && !confirm(`Start over with ${plural(J, 'job')}? Tonight's changes will be lost.`)) break;
      doc.night = freshNight(J, n.startTs);
      commit();
      break;
    }
    case 'end':
      if (confirm(`Job ${k + 1} has ended?`)) {
        changeJobs(`Job ${k + 1} ended`, (night, cut) => { night.jobs[k].to = Math.max(night.jobs[k].from, cut); });
      }
      break;
    case 'resume':
      changeJobs(`Job ${k + 1} is back on`, night => { night.jobs[k].to = S; });
      break;
    case 'add':
      changeJobs(`Job ${n.jobs.length + 1} added`, (night, cut) => { night.jobs.push({ from: cut, to: S }); });
      break;
    case 'send': shareText(rotaText(n)); break;
    case 'invite': shareText(`🔥 Join our fireguard rota: ${crewUrl()}`); break;
  }
});

function tick() {
  const d = new Date();
  $('#clock').textContent = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  const n = doc.night || { startTs: shiftStart() };
  const key = shiftStart() + ':' + nowBlock(n) + ':' + cutNow(n);
  if (key !== tick.key) { tick.key = key; render(); }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  tick();
  if (Date.now() - sync.lastConnect > 10000) connect();
});
window.addEventListener('online', () => { connect(); if (sync.dirty) publishSoon(300); });

// ---------- start ----------
initCrew();
render();
tick();
setInterval(tick, 15000);
connect();

if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
