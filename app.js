'use strict';

// ---------- helpers ----------
const $ = s => document.querySelector(s);
const KEY = 'fireguard-v2';           // this phone's copy of the crew data
const OLD_KEY = 'fireguard-rota-v1';  // first version, migrated once
const ME_KEY = 'fireguard-me-id';
const CREW_KEY = 'fireguard-crew';
const DEV_KEY = 'fireguard-device';
const DB = 'https://fireguard-rota-caf41748-default-rtdb.europe-west1.firebasedatabase.app';
const LEGACY_RELAY = 'https://ntfy.sh/';
const COLORS = ['#ff6b35', '#f7c548', '#3ec1d3', '#a06cd5', '#58d68d', '#ff4f79', '#4d96ff', '#ffa94d'];
const DEFAULTS = { start: '19:00', end: '07:00', jobs: 3, slot: 30, block: 120, mode: 'fair', jobNames: ['', '', '', '', ''] };

const rnd = () => crypto.getRandomValues(new Uint32Array(1))[0] / 4294967296;
const uid = () => 'p' + Math.random().toString(36).slice(2, 9);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const toMin = hhmm => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };
const fmt = min => { min = ((min % 1440) + 1440) % 1440; return String(Math.floor(min / 60)).padStart(2, '0') + ':' + String(min % 60).padStart(2, '0'); };
const dur = min => { min = Math.round(min); const h = Math.floor(min / 60), m = min % 60; return h && m ? `${h}h ${m}m` : h ? `${h}h` : `${m}m`; };
const shiftLen = (s, e) => ((toMin(e) - toMin(s) + 1440) % 1440) || 1440;
const plural = (n, w, many = w + 's') => `${n} ${n === 1 ? w : many}`;
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), 2600);
}

// ---------- state ----------
// One shared "doc" per crew. Every phone keeps a copy and the newest copy wins.
function emptyDoc() {
  return { v: 2, rev: 0, ts: 0, by: '', people: [], settings: { ...DEFAULTS }, night: null, log: [] };
}
function fixDoc(d) {
  d.settings = { ...DEFAULTS, ...(d.settings || {}) };
  // the default shift used to be 22:00–06:00; move crews still on it to 19:00–07:00 once
  if (!d.settings.times2) {
    if (d.settings.start === '22:00' && d.settings.end === '06:00') Object.assign(d.settings, { start: '19:00', end: '07:00' });
    d.settings.times2 = true;
  }
  d.people = d.people || [];
  d.log = d.log || [];
  return d;
}
function loadDoc() {
  let d = null;
  try { d = JSON.parse(localStorage.getItem(KEY)); } catch (e) {}
  if (d && d.v === 2) return fixDoc(d);
  d = emptyDoc();
  try {
    const old = JSON.parse(localStorage.getItem(OLD_KEY));
    if (old && Array.isArray(old.people)) {
      d.people = old.people.map(p => ({
        id: p.id, name: p.name, present: p.present !== false,
        stats: { nights: p.stats?.nights || 0, minutes: p.stats?.minutes || 0, jackpots: p.stats?.jackpots || 0 },
      }));
      d.settings = { ...d.settings, ...Object.fromEntries(Object.entries(old.settings || {}).filter(([k]) => k in DEFAULTS)) };
    }
  } catch (e) {}
  return d;
}
function saveLocal() {
  try { localStorage.setItem(KEY, JSON.stringify(doc)); } catch (e) { toast('Could not save on this phone'); }
}
// Every change goes through here: saved on this phone and sent to the crew.
function commit(redraw = true) {
  doc.rev++;
  doc.ts = Date.now();
  doc.by = device;
  saveLocal();
  publishSoon();
  if (redraw) render();
}

let doc = loadDoc();
let showSetup = false;
let pick = null; // first name tapped for a swap: { b: block start slot, id }
const device = localStorage.getItem(DEV_KEY) || (() => { const d = uid(); localStorage.setItem(DEV_KEY, d); return d; })();

const byId = id => doc.people.find(p => p.id === id);
const meId = () => localStorage.getItem(ME_KEY);
const meName = () => byId(meId())?.name || 'Someone';
const liveNight = () => (doc.night && !doc.night.closed ? doc.night : null);

// ---------- night helpers ----------
// Times inside a night are slot numbers: 0 = shift start, S = shift end.
const np = (n, id) => n.people.find(p => p.id === id);
const isIn = (p, t) => t >= p.from && t < p.to && !p.away.some(([a, b]) => t >= a && t < b);
const jobOn = (j, t) => t >= j.from && t < j.to;
const at = (n, t) => fmt(toMin(n.start) + t * n.slot);
const minsIn = n => (Date.now() - n.startTs) / 60000;
// Changes take effect from the nearest block boundary; everything before it stays as it happened.
const cutNow = n => clamp(Math.round(minsIn(n) / n.slot), 0, n.S);
const nameOf = (n, id) => np(n, id)?.name || byId(id)?.name || '?';
const rowKey = (n, t) => n.grid[t].map((id, k) => id || (jobOn(n.jobs[k], t) ? '!' : '.')).join(',');

function totals(n) {
  const c = {};
  n.people.forEach(p => { c[p.id] = 0; });
  n.grid.forEach(r => r.forEach(id => { if (id && id in c) c[id]++; }));
  return c;
}
function availSlots(n, p) {
  let a = 0;
  for (let t = 0; t < n.S; t++) if (isIn(p, t)) a++;
  return a;
}
// Extra blocks compared with whoever worked least among the people who were in all night.
function extras(n) {
  const tot = totals(n), full = n.people.filter(p => availSlots(n, p) === n.S), out = {};
  if (!full.length) return out;
  const m = Math.min(...full.map(p => tot[p.id]));
  full.forEach(p => { if (tot[p.id] > m) out[p.id] = tot[p.id] - m; });
  return out;
}

// Timestamp of the shift start: the one running now, else the next one.
function computeStartTs(start, len) {
  const now = Date.now(), d = new Date(), m = toMin(start);
  d.setHours(Math.floor(m / 60), m % 60, 0, 0);
  let ts = d.getTime();
  if (ts - 86400000 + len * 60000 > now) ts -= 86400000;
  else if (ts + len * 60000 <= now) ts += 86400000;
  return ts;
}

// ---------- the planner ----------
// Re-plans every slot from `cut` on. Past slots are kept as they happened.
// 1. Work still to hand out is shared so final totals are fair, in proportion to how long
//    each person is around. Leftover blocks go to the front of the jackpot line.
// 2. Many variants are tried and the tidiest is kept (long stretches, real breaks,
//    swaps on the hour, as few changes to the old plan as possible).
function replan(n, cut, prev) {
  const S = n.S, J = n.jobs.length, ids = n.people.map(p => p.id);
  const minLen = Math.max(1, Math.round(60 / n.slot)), B = Math.max(1, Math.round(n.block / n.slot));
  const base = Array.from({ length: S }, (_, t) => Array.from({ length: J }, (_, k) => (t < cut && n.grid[t] && n.grid[t][k]) || null));
  const past = {}, a = {}, cap = {}, rem = {};
  ids.forEach(id => { past[id] = 0; a[id] = 0; cap[id] = 0; rem[id] = 0; });
  for (let t = 0; t < cut; t++) base[t].forEach(id => { if (id in past) past[id]++; });

  const fut = [];
  for (let t = 0; t < S; t++) {
    const jobs = [];
    n.jobs.forEach((j, k) => { if (jobOn(j, t)) jobs.push(k); });
    const av = ids.filter(id => isIn(np(n, id), t));
    if (jobs.length) av.forEach(id => a[id]++);
    if (t < cut) continue;
    const need = Math.min(jobs.length, av.length);
    if (need) av.forEach(id => cap[id]++);
    fut.push({ t, jobs, av, need });
  }

  const W = fut.reduce((s, f) => s + f.need, 0);
  const line = id => { const i = n.line.indexOf(id); return i < 0 ? 1e6 : i; };
  for (let u = 0; u < W; u++) {
    let best = null;
    for (const id of ids) {
      if (rem[id] >= cap[id]) continue;
      if (!best) { best = id; continue; }
      const x = (past[id] + rem[id]) * a[best], y = (past[best] + rem[best]) * a[id];
      if (x < y || (x === y && line(id) < line(best))) best = id;
    }
    if (!best) break;
    rem[best]++;
  }

  const ctx = { n, base, cut, S, J, fut, rem, cap, ids, B, minLen, prev };
  let best = base, bestScore = Infinity;
  const tries = fut.length ? 300 : 1;
  for (let i = 0; i < tries; i++) {
    const g = fillOnce(ctx, i > 0);
    const sc = scoreNight(g, ctx);
    if (sc < bestScore) { best = g; bestScore = sc; }
  }
  n.grid = best;
}

// One greedy pass. Anyone who'd otherwise miss their share is picked first, then people
// still owed time, then whoever is mid-stretch, then the most rested. Jitter shuffles
// stretch lengths and tie-breaks a bit so replan() can compare variants.
function fillOnce(c, jitter) {
  const g = c.base.map(r => r.slice());
  const rem = { ...c.rem }, capLeft = { ...c.cap }, run = {}, post = {}, last = {}, tie = {}, len = {};
  c.ids.forEach(id => {
    run[id] = 0; post[id] = -1; last[id] = -1e9; tie[id] = Math.random();
    len[id] = jitter ? Math.max(c.minLen, c.B + Math.floor(Math.random() * 3) - 1) : c.B;
  });
  const step = (t, row) => c.ids.forEach(id => {
    const k = row.indexOf(id);
    if (k >= 0) { run[id] = post[id] >= 0 ? run[id] + 1 : 1; post[id] = k; last[id] = t; }
    else { run[id] = 0; post[id] = -1; }
  });
  for (let t = 0; t < c.cut; t++) step(t, g[t]);

  for (const f of c.fut) {
    const t = f.t, row = g[t];
    if (f.need) {
      const cand = f.av.map(id => {
        const on = post[id] >= 0, has = rem[id] > 0;
        // finishing someone's last bit now beats calling them back later for a tiny stretch
        const cont = on && has && (run[id] < len[id] || rem[id] < c.minLen);
        return {
          id,
          must: has && rem[id] >= capLeft[id] ? 1 : 0,
          has: has ? 1 : 0,
          cont: cont ? 1 : 0,
          tired: on && !cont ? 1 : 0,
          // someone who only just went on break shouldn't be pulled straight back
          fresh: !on && last[id] >= 0 && t - last[id] - 1 < c.minLen ? 1 : 0,
          noise: jitter ? Math.random() * 1.5 : 0,
        };
      });
      cand.sort((x, y) =>
        y.must - x.must || y.has - x.has || y.cont - x.cont || x.tired - y.tired || x.fresh - y.fresh ||
        (rem[y.id] + y.noise) - (rem[x.id] + x.noise) || last[x.id] - last[y.id] || tie[x.id] - tie[y.id]);
      const chosen = cand.slice(0, f.need).map(x => x.id);
      chosen.forEach(id => { if (post[id] >= 0 && f.jobs.includes(post[id]) && row[post[id]] === null) row[post[id]] = id; });
      chosen.forEach(id => { if (!row.includes(id)) row[f.jobs.find(k => row[k] === null)] = id; });
      chosen.forEach(id => { rem[id]--; });
      f.av.forEach(id => { capLeft[id]--; });
    }
    step(t, row);
  }
  return g;
}

// Lower is better: fair shares first, then tidy stretches and breaks, then stability.
function scoreNight(g, c) {
  let score = 0;
  for (const id of c.ids) {
    let t = 0, prevEnd = -1, got = 0;
    while (t < c.S) {
      if (!g[t].includes(id)) { t++; continue; }
      const s = t;
      let job = g[t].indexOf(id);
      while (t < c.S && g[t].includes(id)) {
        const k = g[t].indexOf(id);
        if (k !== job) { score += 6; job = k; }
        if (t >= c.cut) got++;
        t++;
      }
      score += 10;
      if (t - s < c.minLen) score += 40;
      if (t - s > c.B) score += (t - s - c.B) * 8;
      if (prevEnd >= 0 && s - prevEnd < c.minLen) score += 20;
      prevEnd = t;
    }
    score += Math.abs(got - c.rem[id]) * 100;
  }
  const startMin = toMin(c.n.start);
  for (let t = Math.max(1, c.cut); t < c.S; t++) {
    if (g[t].join() !== g[t - 1].join() && (startMin + t * c.n.slot) % 60) score += 3;
  }
  if (c.prev) {
    for (let t = c.cut; t < c.S; t++) for (let k = 0; k < c.J; k++) {
      if ((c.prev[t]?.[k] || null) !== g[t][k]) score += 2;
    }
  }
  return score;
}

// ---------- nights ----------
function calcSetup() {
  const st = doc.settings, present = doc.people.filter(p => p.present);
  const len = shiftLen(st.start, st.end), S = len / st.slot, J = st.jobs, n = present.length;
  const errors = [], warns = [];
  if (!n) errors.push('Nobody is marked as in tonight.');
  if (!Number.isInteger(S)) errors.push(`Shift length (${dur(len)}) doesn't split into ${dur(st.slot)} blocks.`);
  if (n && J > n) warns.push(`${plural(J, 'job')} but only ${plural(n, 'person', 'people')} in: ${plural(J - n, 'job')} will have nobody.`);
  const total = Number.isInteger(S) ? S * Math.min(J, n) : 0;
  const base = n ? Math.floor(total / n) : 0, extra = n ? total % n : 0;
  return { present, len, S, J, n, total, base, extra, errors, warns };
}

function addFeed(n, what) {
  n.feed.unshift({ ts: Date.now(), who: meName(), what });
  n.feed = n.feed.slice(0, 25);
}

// Saves a finished night into everyone's totals and the history.
function closeNight() {
  const n = liveNight();
  if (!n) return;
  const tot = totals(n), ex = extras(n);
  n.people.forEach(p => {
    const q = byId(p.id);
    if (!q) return;
    q.stats.nights++;
    q.stats.minutes += tot[p.id] * n.slot;
    q.stats.jackpots += ex[p.id] || 0;
  });
  doc.log.unshift({
    d: n.startTs, s: n.start, e: n.end, j: n.jobs.map(j => j.name),
    m: n.people.map(p => [p.name, tot[p.id] * n.slot]),
    x: n.people.filter(p => ex[p.id]).map(p => p.name),
  });
  doc.log = doc.log.slice(0, 60);
  n.closed = true;
}

// Tonight's jackpot line. Fair mode: the people with the fewest jackpots so far go on the wheel,
// and the rest of the line is ordered by fewest jackpots. Pure luck: all random.
function spinLine(people) {
  const mode = doc.settings.mode, jp = p => byId(p.id)?.stats.jackpots || 0;
  let pool = people;
  if (mode === 'fair') {
    const min = Math.min(...people.map(jp));
    pool = people.filter(p => jp(p) === min);
  }
  const winner = pool[Math.floor(rnd() * pool.length)];
  const rest = people.filter(p => p !== winner).map(p => ({ p, r: rnd() }))
    .sort((x, y) => (mode === 'fair' ? jp(x.p) - jp(y.p) : 0) || x.r - y.r).map(x => x.p.id);
  return { pool: pool.map(p => p.id), winner: winner.id, line: [winner.id, ...rest] };
}

function startNight() {
  const c = calcSetup();
  if (c.errors.length) return toast(c.errors[0]);
  const spin = spinLine(c.present);
  openRoulette(spin, 'Start the night ✅', () => createNight(spin.line));
}

function createNight(line) {
  const st = doc.settings, len = shiftLen(st.start, st.end), S = len / st.slot;
  closeNight();
  const n = {
    id: uid(), startTs: computeStartTs(st.start, len), start: st.start, end: st.end, slot: st.slot, block: st.block, S,
    people: doc.people.filter(p => p.present).map(p => ({ id: p.id, name: p.name, from: 0, to: S, away: [] })),
    jobs: Array.from({ length: st.jobs }, (_, k) => ({ id: uid(), name: (st.jobNames[k] || '').trim() || `Job ${k + 1}`, from: 0, to: S })),
    line, grid: [], feed: [], closed: false,
  };
  replan(n, 0, null);
  addFeed(n, `started the night. 🎰 ${nameOf(n, line[0])} is first in line`);
  doc.night = n;
  showSetup = false;
  pick = null;
  commit();
  window.scrollTo(0, 0);
}

// A live change: apply it, then recalculate everything from the current block on.
function editNight(what, fn) {
  const n = liveNight();
  if (!n) return;
  const cut = cutNow(n);
  if (cut >= n.S) return toast('This shift is already over');
  if (fn(n, cut) === false) return;
  replan(n, cut, n.grid.map(r => r.slice()));
  addFeed(n, what);
  pick = null;
  commit();
  toast(`Rota recalculated from ${at(n, cut)} ✅`);
}

const findJob = (n, jid) => n.jobs.findIndex(j => j.id === jid);
function removeJob(n, k) {
  n.jobs.splice(k, 1);
  n.grid.forEach(r => r.splice(k, 1));
}

// Swap two people for slots [from, to): two workers trade jobs, or someone on break takes over.
function swapInPlan(n, from, to, a, b) {
  for (let t = from; t < to; t++) {
    const row = n.grid[t], ia = row.indexOf(a), ib = row.indexOf(b);
    if (ia >= 0) row[ia] = b;
    if (ib >= 0) row[ib] = a;
  }
}

function blocks(n) {
  const out = [];
  n.grid.forEach((row, t) => {
    const key = rowKey(n, t), L = out[out.length - 1];
    if (L && L.key === key) L.end = t + 1;
    else out.push({ key, row, start: t, end: t + 1 });
  });
  return out;
}
function personSegs(n, id) {
  const segs = [];
  n.grid.forEach((row, t) => {
    const k = row.indexOf(id);
    if (k < 0) return;
    const L = segs[segs.length - 1];
    if (L && L.end === t && L.job === k) L.end = t + 1;
    else segs.push({ job: k, start: t, end: t + 1 });
  });
  return segs;
}
function tagger(n) {
  const ids = n.people.map(p => p.id), me = meId();
  return id => id
    ? `<span class="tag ${id === me ? 'me' : ''}" style="--c:${COLORS[Math.max(0, ids.indexOf(id)) % COLORS.length]}">${esc(nameOf(n, id))}</span>`
    : '<span class="mut">—</span>';
}

// ---------- sharing as text ----------
const crewUrl = () => location.origin + location.pathname + '#c=' + sync.crew;

function planText(n) {
  const ds = new Date(n.startTs).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
  const tot = totals(n), ex = extras(n);
  let s = `🔥 Fireguard rota — ${ds}, ${n.start}–${n.end}\n\n`;
  for (const p of n.people) {
    const segs = personSegs(n, p.id);
    s += `• ${p.name} (🔨 ${dur(tot[p.id] * n.slot)} · ☕ ${dur((availSlots(n, p) - tot[p.id]) * n.slot)}${ex[p.id] ? ' 🎰' : ''}): `;
    s += segs.length ? segs.map(x => `${at(n, x.start)}–${at(n, x.end)} ${n.jobs[x.job].name}`).join(', ') : 'no watch';
    s += '\n';
  }
  s += `\n🎰 Extra-time line: ${n.line.filter(id => np(n, id)).map(id => nameOf(n, id)).join(' → ')}\n`;
  return s + `\n👉 Live rota: ${crewUrl()}`;
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
async function shareText(title, text) {
  if (navigator.share) {
    try { await navigator.share({ title, text }); return; }
    catch (e) { if (e.name === 'AbortError') return; }
  }
  copyText(text);
}

// ---------- sync ----------
// The crew doc lives in a Firebase Realtime Database (free plan) at /crews/<crew code>.
// Every save writes the whole doc with a higher rev. The database rules refuse anything
// that isn't newer, so an outdated phone can't overwrite fresher data. Phones stream
// changes live and keep their own copy, so the app also works offline.
const sync = { crew: null, es: null, status: 'connecting', timer: null, dirty: false, joined: false, pendingRender: false, lastConnect: 0 };
const crewPath = () => `${DB}/crews/${sync.crew}.json`;
const newer = (a, b) => a.rev > b.rev || (a.rev === b.rev && a.ts > b.ts);
const unwrap = w => { try { return w && typeof w.data === 'string' ? JSON.parse(w.data) : null; } catch (e) { return null; } };

async function fetchRemote() {
  const r = await fetch(crewPath());
  if (!r.ok) throw new Error('db ' + r.status);
  return unwrap(await r.json());
}

function setStatus(s) {
  sync.status = s;
  const el = $('#sync');
  el.className = 'sync ' + s;
  el.textContent = { live: '● live', offline: '● offline', connecting: '● …' }[s];
}

function publishSoon(delay = 900) {
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
        setStatus('live');
      } else if (remote && remote.rev >= sent) {
        // someone else saved first; theirs wins
        sync.dirty = false;
        doc.rev = -1;
        receive(remote);
        toast('Someone else saved a change at the same moment. Yours wasn\'t saved, please redo it');
      } else {
        sync.dirty = false;
        toast('Could not save to the crew. Try again');
      }
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
  if (!remote || remote.v !== 2 || !newer(remote, doc)) return false;
  if (sync.dirty && remote.by !== device) toast('Someone else changed the rota at the same time. Check your change');
  doc = fixDoc(remote);
  sync.dirty = false;
  saveLocal();
  const busy = document.activeElement && document.activeElement.matches('input, select, textarea');
  if (busy || R) sync.pendingRender = true;
  else render();
  return true;
}

// The first version synced through ntfy.sh. Until everyone's phone has updated, also pick up
// anything newer that an old copy of the app left there. (Messages there expire after 12h.)
async function legacyImport() {
  if (Date.now() > Date.UTC(2026, 9, 28) || !window.DecompressionStream) return;
  try {
    const r = await fetch(`${LEGACY_RELAY}fgrota-${sync.crew}/json?poll=1&since=all`);
    for (const line of (await r.text()).split('\n')) {
      try {
        const m = JSON.parse(line);
        if (m.event !== 'message' || !m.message.startsWith('FG2:')) continue;
        const bytes = Uint8Array.from(atob(m.message.slice(4)), c => c.charCodeAt(0));
        const z = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
        receive(JSON.parse(await new Response(z).text()));
      } catch (e) {}
    }
  } catch (e) {}
}

async function connect() {
  if (!sync.crew) return;
  sync.lastConnect = Date.now();
  setStatus('connecting');
  try {
    const remote = await fetchRemote();
    if (remote) receive(remote);
    await legacyImport();
    if (doc.people.length && (!remote || newer(doc, remote))) {
      if (!doc.rev) doc.rev = 1;
      publishSoon(300);
    }
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
  if (m) {
    const code = m[1].toLowerCase();
    const ok = !crew || crew === code || !doc.people.length ||
      confirm('Join the crew from this link? This phone\'s current crew data will be replaced by theirs.');
    if (ok && crew !== code) {
      crew = code;
      localStorage.setItem(CREW_KEY, code);
      doc = emptyDoc();
      saveLocal();
      sync.joined = true;
    }
    history.replaceState(null, '', location.pathname);
  } else if (location.hash.startsWith('#r=')) {
    toast('That\'s an old rota link. Ask for the crew invite link instead');
    history.replaceState(null, '', location.pathname);
  }
  if (!crew) {
    crew = Array.from(crypto.getRandomValues(new Uint8Array(10)), b => (b % 36).toString(36)).join('');
    localStorage.setItem(CREW_KEY, crew);
  }
  sync.crew = crew;
}

// ---------- rendering: tonight ----------
function setupHTML() {
  const st = doc.settings, c = calcSetup();
  const times = v => Array.from({ length: 48 }, (_, k) => fmt(k * 30))
    .map(t => `<option ${t === v ? 'selected' : ''}>${t}</option>`).join('');
  const chips = (key, opts) => `<div class="chips">${opts.map(([v, l]) =>
    `<button class="chip ${st[key] === v ? 'on' : ''}" data-act="set" data-key="${key}" data-val="${v}">${l}</button>`).join('')}</div>`;
  const n = liveNight();

  let h = `<div class="card"><h2>Who's in tonight?</h2><div class="chips">${doc.people.map(p =>
    `<button class="chip ${p.present ? 'on' : ''}" data-act="present" data-id="${p.id}">${esc(p.name)}</button>`).join('')}</div></div>`;

  h += `<div class="card"><h2>New night</h2>
    <div class="two">
      <div><label class="row">Start</label><select data-set="start">${times(st.start)}</select></div>
      <div><label class="row">End</label><select data-set="end">${times(st.end)}</select></div>
    </div>
    <label class="row">Jobs at the start of the shift <span class="small">(you can add or end jobs later)</span></label>
    ${chips('jobs', [0, 1, 2, 3, 4, 5].map(k => [k, k]))}
    ${st.jobs ? `<label class="row">Job names (optional)</label><div class="jobnames">${Array.from({ length: st.jobs }, (_, k) =>
      `<input type="text" data-job="${k}" placeholder="Job ${k + 1}" maxlength="18" value="${esc(st.jobNames[k] || '')}">`).join('')}</div>` : ''}
    <label class="row">Time blocks</label>
    ${chips('slot', [[30, '30 min'], [60, '1 hour']])}
    <label class="row">Swap people every</label>
    ${chips('block', [[60, '1h'], [120, '2h'], [180, '3h'], [240, '4h']])}
    <label class="row">Jackpot mode</label>
    ${chips('mode', [['fair', '⚖️ Fair'], ['luck', '🎲 Pure luck']])}
    <div class="small mut" style="margin-top:6px">${st.mode === 'fair'
      ? 'Fair: whoever has had the fewest jackpots so far goes on the wheel.'
      : 'Pure luck: everyone is on the wheel every time.'}</div>
    ${mathHTML(c)}
    ${n ? '<div class="small mut" style="margin-top:10px">Starting a new night saves the current night\'s hours into everyone\'s totals.</div>' : ''}
    <button class="big" data-act="start" ${c.errors.length ? 'disabled' : ''}>🎰 Spin tonight's jackpot & start</button>
  </div>`;
  return h;
}

function mathHTML(c) {
  const slot = doc.settings.slot;
  if (c.errors.length) return `<div class="math">${c.errors.map(e => `<div class="err">⚠️ ${esc(e)}</div>`).join('')}</div>`;
  let h = '<div class="math">';
  if (!c.J) h += 'No jobs at the start. Everyone rests until a job comes in 😎';
  else {
    h += `${dur(c.len)} shift × ${plural(Math.min(c.J, c.n), 'job')} = <b>${dur(c.total * slot)}</b> of watch<br>
      ${plural(c.n, 'person', 'people')} → <b>${dur(c.base * slot)}</b> each, about <b>${dur((c.S - c.base) * slot)}</b> of break`;
    if (c.extra) {
      h += `<br><span class="mut small">(an exact split would be ${dur(c.total * slot / c.n)}, so it's rounded to clean ${dur(slot)} blocks)</span>
        <br>🎰 ${c.extra} leftover ${dur(slot)} block${c.extra > 1 ? 's' : ''} → the first ${c.extra > 1 ? c.extra + ' people' : 'person'} in the jackpot line get +${dur(slot)}`;
    } else h += '<br>Splits perfectly right now 👌';
  }
  h += c.warns.map(w => `<div class="err">⚠️ ${esc(w)}</div>`).join('');
  return h + `<div class="small mut" style="margin-top:8px">The jackpot is spun every night, even with 0 or 1 jobs. If a job shows up or ends later, any leftover time goes to the front of the line first.</div></div>`;
}

function whoAmIHTML() {
  return `<div class="card"><h2>👤 Who are you on this phone?</h2>
    <div class="chips">${doc.people.map(p => `<button class="chip" data-act="setme" data-id="${p.id}">${esc(p.name)}</button>`).join('')}</div>
    <div class="small mut" style="margin-top:8px">So the app can show your own times, and so changes show who made them.</div></div>`;
}

function jobStatus(n, j, cut) {
  if (j.to <= j.from) return 'cancelled';
  if (cut >= j.to) return `ended ${at(n, j.to)}`;
  if (cut < j.from) return `starts ${at(n, j.from)}${j.to < n.S ? ' – ' + at(n, j.to) : ''}`;
  return `running${j.from > 0 ? ' since ' + at(n, j.from) : ''}${j.to < n.S ? ' until ' + at(n, j.to) : ''}`;
}
function personStatus(n, p, cut) {
  if (cut >= p.to) return `🏠 left ${at(n, p.to)}`;
  if (cut < p.from) return `arrives ${at(n, p.from)}`;
  const away = p.away.find(([a, b]) => cut >= a && cut < b);
  const bits = [];
  if (away) bits.push(`⏸ away until ${at(n, away[1])}`);
  if (p.from > 0) bits.push(`arrived ${at(n, p.from)}`);
  if (p.to < n.S) bits.push(`leaves ${at(n, p.to)}`);
  return bits.join(' · ');
}

function nightHTML(n) {
  const cut = cutNow(n), tag = tagger(n), tot = totals(n), ex = extras(n), me = meId();
  const d = new Date(n.startTs).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'short' });
  const running = n.jobs.filter(j => j.to > j.from).length;
  const nowSlot = clamp(Math.ceil(minsIn(n) / n.slot), 0, n.S);
  let h = `<div class="card"><h2>Tonight · ${esc(d)}</h2>
    <div class="sub">${n.start}–${n.end} · ${plural(running, 'job')} · ${dur(n.slot)} blocks</div>
    <div class="line">🎰 <b>Extra-time line:</b> ${n.line.filter(id => np(n, id)).map((id, i) => `${i + 1}. ${tag(id)}`).join(' ')}</div>
    <div class="small mut">Leftover time, now or after a change, goes to the front of the line first.</div></div>`;

  // who works where, and how much work and break everyone has
  h += '<div class="card"><h2>Everyone tonight</h2><div class="people">' + n.people.map(p => {
    const segs = personSegs(n, p.id), work = tot[p.id], brk = availSlots(n, p) - work;
    let todo = 0;
    for (let t = nowSlot; t < n.S; t++) if (n.grid[t].includes(p.id)) todo++;
    const status = personStatus(n, p, cut);
    return `<div class="pp ${p.id === me ? 'me' : ''}">
      <div class="pp-top">${tag(p.id)}${ex[p.id] ? ` <span class="jack">🎰 +${dur(ex[p.id] * n.slot)}</span>` : ''}</div>
      <div class="wt">🔨 <b>${dur(work * n.slot)}</b> work · ☕ <b>${dur(brk * n.slot)}</b> break
        ${minsIn(n) > 0 && nowSlot < n.S ? `<br><span class="mut">still to do: ${dur(todo * n.slot)}</span>` : ''}</div>
      ${status ? `<div class="small mut">${status}</div>` : ''}
      <div class="pp-segs">${segs.map(s => `${at(n, s.start)}–${at(n, s.end)} <span class="mut">${esc(n.jobs[s.job].name)}</span>`).join('<br>')
        || '<span class="mut">No watch tonight</span>'}</div></div>`;
  }).join('') + '</div></div>';

  // live changes
  const others = doc.people.filter(p => !np(n, p.id));
  h += `<div class="card"><h2>Something changed?</h2>
    <div class="small mut">Changes apply from <b>${at(n, cut)}</b> and the rest of the night is recalculated for everyone. Earlier times stay as they were.</div>
    <h3>Jobs</h3>
    ${n.jobs.map(j => `<div class="lrow"><div><b>${esc(j.name)}</b> <span class="mut small">${jobStatus(n, j, cut)}</span></div>
      <div class="lbtns">${j.to > cut ? `<button class="sbtn" data-act="jobend" data-j="${j.id}">⛔ Ended</button>`
        : `<button class="sbtn" data-act="jobresume" data-j="${j.id}">▶ Back on</button>`}
      <button class="sbtn" data-act="jobedit" data-j="${j.id}">✏️</button></div></div>`).join('') || '<p class="mut small">No jobs right now.</p>'}
    <button class="btn" style="margin-top:8px" data-act="jobadd">➕ New job</button>
    <h3>People</h3>
    ${n.people.map(p => {
      const gone = cut >= p.to, away = p.away.some(([a, b]) => cut >= a && cut < b), notYet = cut < p.from;
      return `<div class="lrow"><div><b>${esc(p.name)}</b> <span class="mut small">${personStatus(n, p, cut)}</span></div><div class="lbtns">
        ${gone || away ? `<button class="sbtn" data-act="back" data-id="${p.id}">👋 Back</button>`
          : notYet ? '' : `<button class="sbtn" data-act="away" data-id="${p.id}">⏸ Away</button><button class="sbtn" data-act="leave" data-id="${p.id}">🏠 Gone</button>`}
        <button class="sbtn" data-act="personedit" data-id="${p.id}">✏️</button></div></div>`;
    }).join('')}
    ${others.length ? `<div class="chips" style="margin-top:8px">${others.map(p =>
      `<button class="sbtn" data-act="arrive" data-id="${p.id}">👋 ${esc(p.name)} is here</button>`).join('')}</div>` : ''}
  </div>`;

  // timeline; tap two names in the same row to swap them
  h += `<div class="card"><h2>Timeline</h2>
    <div class="small mut" style="margin:-4px 0 8px">✏️ ${pick ? '<b>Now tap who to swap with (same row)</b>' : 'Tap two names in the same row to swap them'}</div>
    <div class="scroll"><table><tr><th>Time</th>${n.jobs.map(j => `<th>${esc(j.name)}${j.from > 0 || j.to < n.S
      ? `<br><span class="small">${j.to > j.from ? at(n, j.from) + '–' + at(n, j.to) : 'cancelled'}</span>` : ''}</th>`).join('')}<th>Break</th></tr>`;
  const cell = (b, id) => `<span class="pick ${pick && pick.b === b.start && pick.id === id ? 'picked' : ''}" data-act="pick" data-b="${b.start}" data-id="${id}">${tag(id)}</span>`;
  for (const b of blocks(n)) {
    const resting = n.people.filter(p => isIn(p, b.start) && !b.row.includes(p.id));
    h += `<tr data-s="${b.start}" data-e="${b.end}"><td class="time">${at(n, b.start)}<br>${at(n, b.end)}</td>
      ${b.row.map((id, k) => `<td>${id ? cell(b, id) : !jobOn(n.jobs[k], b.start) ? '<span class="off">·</span>'
        : b.start >= cut ? '<span class="warn">⚠️ nobody</span>' : '<span class="mut">—</span>'}</td>`).join('')}
      <td class="rest">${resting.map(p => cell(b, p.id)).join(' ')}</td></tr>`;
  }
  h += '</table></div></div>';

  if (n.feed.length) {
    h += `<div class="card"><h2>Changes</h2><div class="feed">${n.feed.slice(0, 10).map(f =>
      `<div><span class="mut">${fmt(new Date(f.ts).getHours() * 60 + new Date(f.ts).getMinutes())}</span> <b>${esc(f.who)}</b> ${esc(f.what)}</div>`).join('')}</div></div>`;
  }

  h += `<div class="card"><div class="actions">
      <button class="btn acc" data-act="sharetext">📤 Send rota</button>
      <button class="btn" data-act="invite">🔗 Invite crew</button>
      <button class="btn" data-act="respin">🎲 Re-spin jackpot</button>
      <button class="btn" data-act="newnight">➕ New night</button>
    </div>
    <button class="link" data-act="cancelnight">Cancel tonight</button></div>`;
  return h;
}

function renderTonight() {
  const el = $('#tab-tonight'), n = liveNight();
  if (!doc.people.length) {
    el.innerHTML = sync.joined
      ? `<div class="card center"><p>⏳ Loading your crew…</p><p class="small mut">If this stays empty, ask a coworker to open the app once so it syncs.</p></div>`
      : `<div class="card center"><p>👋 First, add your crew.</p>
        <button class="big" data-act="tab" data-tab="crew">Add people</button></div>`;
    return;
  }
  let h = meId() && byId(meId()) ? '' : whoAmIHTML();
  if (n && !showSetup) h += '<div id="now"></div>' + nightHTML(n);
  else h += setupHTML() + (n ? '<button class="btn" data-act="cancelsetup">← Back to tonight</button>' : '');
  el.innerHTML = h;
  renderNow();
}

function myLine(n, id, t) {
  const segs = personSegs(n, id), m = x => x * n.slot;
  const cur = segs.find(s => t >= m(s.start) && t < m(s.end));
  if (cur) return `👉 <b>You're on ${esc(n.jobs[cur.job].name)}</b> until ${at(n, cur.end)} (${dur(Math.ceil(m(cur.end) - t))} left)`;
  const nx = segs.find(s => m(s.start) > t);
  if (nx) return `👉 ${t >= 0 ? "You're on break. " : ''}Your next stretch: <b>${at(n, nx.start)}</b> on ${esc(n.jobs[nx.job].name)} (in ${dur(Math.ceil(m(nx.start) - t))})`;
  return segs.length ? "👉 You're done for the night 🎉" : '👉 No watch for you tonight 😎';
}

function renderNow() {
  const n = !showSetup && liveNight(), box = $('#now');
  if (!n || !box) return;
  const t = minsIn(n), len = n.S * n.slot, tag = tagger(n);
  document.querySelectorAll('#tab-tonight tr[data-s]').forEach(tr => {
    const a = +tr.dataset.s * n.slot, b = +tr.dataset.e * n.slot;
    tr.classList.toggle('cur', t >= a && t < b);
    tr.classList.toggle('past', t >= b);
  });
  const me = meId(), mine = me && np(n, me) ? `<div class="mine">${myLine(n, me, t)}</div>` : '';
  if (t >= len) {
    box.innerHTML = `<div class="card now"><div class="now-big">Shift done ✅</div><div class="mut">Good work, go sleep 😴</div></div>`;
    return;
  }
  if (t < 0) {
    box.innerHTML = `<div class="card now"><div class="mut">Shift starts in</div><div class="now-big">${dur(Math.ceil(-t))}</div>${mine}</div>`;
    return;
  }
  const s = Math.floor(t / n.slot), row = n.grid[s], key = rowKey(n, s);
  const active = n.jobs.map((j, k) => k).filter(k => jobOn(n.jobs[k], s));
  let u = s + 1;
  while (u < n.S && rowKey(n, u) === key) u++;
  const left = dur(Math.ceil(u * n.slot - t));
  let h = '<div class="card now"><h2>🟢 Right now</h2>';
  h += active.length
    ? active.map(k => `<div class="nowrow"><span class="mut">${esc(n.jobs[k].name)}</span>${row[k] ? tag(row[k]) : '<span class="warn">⚠️ nobody</span>'}</div>`).join('')
    : '<div class="nowrow">No jobs running right now 😎</div>';
  const resting = n.people.filter(p => isIn(p, s) && !row.includes(p.id));
  if (resting.length) h += `<div class="small mut" style="margin-top:6px">☕ On break: ${resting.map(p => esc(p.name)).join(', ')}</div>`;
  if (u < n.S) {
    const nr = n.grid[u], ch = [];
    n.jobs.forEach((j, k) => {
      const on0 = jobOn(j, s), on1 = jobOn(j, u);
      if (on0 && !on1) ch.push(`${esc(j.name)} ends`);
      else if (!on0 && on1) ch.push(`${esc(j.name)} starts: ${nr[k] ? tag(nr[k]) : '⚠️ nobody'}`);
      else if (on1 && nr[k] !== row[k]) ch.push(`${nr[k] ? tag(nr[k]) : '⚠️ nobody'} takes over ${esc(j.name)}`);
    });
    h += `<div class="next">⏭ Next change <b>${at(n, u)}</b> (in ${left})${ch.length ? '<br>' + ch.join('<br>') : ''}</div>`;
  } else {
    h += `<div class="next">🏁 Last stretch. Shift ends ${n.end} (in ${left})</div>`;
  }
  box.innerHTML = h + mine + '</div>';
}

// ---------- rendering: crew ----------
function renderCrew() {
  const el = $('#tab-crew'), me = meId(), n = liveNight();
  el.innerHTML = `<div class="card"><h2>🔗 Invite your crew</h2>
    <p class="small">Send this link to your coworkers. Everyone who opens it sees the same rota and can update it. Changes show up on all phones within seconds.</p>
    <div class="code">${esc(crewUrl())}</div>
    <div class="actions" style="margin-top:10px"><button class="btn acc" data-act="invite">📤 Send invite</button>
    <button class="btn" data-act="copyinvite">📋 Copy link</button></div>
    <div class="small mut" style="margin-top:8px">Anyone with this link can see and change the rota, so keep it in your crew chat.</div></div>
    <div class="card"><h2>Add person</h2>
    <form id="addform" class="addrow"><input type="text" id="newname" placeholder="Name" maxlength="20" autocomplete="off">
    <button class="btn acc">Add</button></form></div>
    <div class="card"><h2>Crew (${doc.people.length})</h2>
    ${doc.people.map(p => `<div class="crew">
      <button class="chip ${p.present ? 'on' : ''}" data-act="present" data-id="${p.id}">${p.present ? '✅ In' : '💤 Off'}</button>
      <div class="cname" data-act="rename" data-id="${p.id}">${esc(p.name)}${p.id === me ? ' <span class="small mut">(you)</span>' : ''}
        <div class="mut small">${plural(p.stats.nights, 'night')} · ${dur(p.stats.minutes)} · 🎰 ${p.stats.jackpots}</div></div>
      <div class="jk"><button class="mini" data-act="jk" data-id="${p.id}" data-d="-1">−</button>
        <button class="mini" data-act="jk" data-id="${p.id}" data-d="1">+</button></div>
      <button class="mini danger" data-act="delperson" data-id="${p.id}">✕</button>
    </div>`).join('') || '<p class="mut">Nobody yet.</p>'}
    <div class="small mut" style="margin-top:10px">✅/💤 = in for the next new night${n ? ' (for tonight, use "Something changed?")' : ''}.
      Tap a name to rename. − / + fixes someone's 🎰 count. Totals update when a night is finished.</div></div>
    ${doc.people.length ? `<div class="card"><h2>👤 This phone belongs to</h2><div class="chips">${doc.people.map(p =>
      `<button class="chip ${p.id === me ? 'on' : ''}" data-act="setme" data-id="${p.id}">${esc(p.name)}</button>`).join('')}</div></div>` : ''}
    <div class="card"><h2>How the jackpot works</h2>
    <p class="small">Every night the wheel picks tonight's <b>jackpot line</b> 🎰. Hours are split into clean blocks, so nobody
    ends up working 1h 39m. Whatever doesn't split evenly goes to the front of the line, one extra block each.
    If a job turns up, ends early or someone leaves, the rest of the night is recalculated the same way.
    In ⚖️ Fair mode the people with the fewest jackpots go on the wheel, so it evens out over time.</p></div>`;
}

// ---------- rendering: history ----------
function renderHistory() {
  const el = $('#tab-history');
  let h = '<div class="card"><h2>Past nights</h2>';
  h += doc.log.map(l => {
    const d = new Date(l.d).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
    return `<div class="hist"><div class="hist-top"><div><b>${esc(d)}</b>
      <span class="mut small">${l.s}–${l.e} · ${plural(l.j.length, 'job')}</span></div></div>
      <div class="chips">${l.m.map(([name, min]) =>
        `<span class="small">${esc(name)} ${dur(min)}${l.x.includes(name) ? ' 🎰' : ''}</span>`).join(' · ')}</div></div>`;
  }).join('') || '<p class="mut">No finished nights yet. A night is saved here when the next one starts.</p>';
  h += `</div><div class="card"><h2>Backup</h2>
    <p class="small mut">Everything already syncs between your crew's phones. A backup file is extra safety.</p>
    <div class="actions"><button class="btn" data-act="backup">💾 Save backup</button>
    <button class="btn" data-act="restore">📂 Restore backup</button></div></div>`;
  el.innerHTML = h;
}

function render() {
  sync.pendingRender = false;
  renderTonight();
  renderCrew();
  renderHistory();
}

function switchTab(name) {
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.id === 'tab-' + name));
  document.querySelectorAll('nav button').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  window.scrollTo(0, 0);
}

// ---------- modal ----------
let modalOk = null;
function openModal(title, body, ok, okLabel = 'Save') {
  $('#m-title').textContent = title;
  $('#m-body').innerHTML = body;
  $('#m-ok').textContent = okLabel;
  modalOk = ok;
  $('#modal').classList.remove('hidden');
}
function closeModal() {
  $('#modal').classList.add('hidden');
  modalOk = null;
  if (sync.pendingRender) render();
}
$('#m-ok').addEventListener('click', () => {
  const val = k => $(`#m-body [name="${k}"]`)?.value;
  if (modalOk && modalOk(val) !== false) closeModal();
});
$('#m-cancel').addEventListener('click', closeModal);

// <option>s for block boundaries from..to
function timeOpts(n, from, to, sel) {
  const cut = cutNow(n);
  let h = '';
  for (let t = from; t <= to; t++) {
    h += `<option value="${t}" ${t === sel ? 'selected' : ''}>${at(n, t)}${t === cut && cut > 0 ? ' (now)' : ''}${t === n.S ? ' (shift end)' : ''}</option>`;
  }
  return h;
}

function jobModal(n, j) {
  const cut = cutNow(n), started = j && j.from < cut;
  const from = j ? j.from : cut, to = j ? j.to : n.S;
  const body = `<label class="row">Name</label><input type="text" name="name" maxlength="18" value="${esc(j ? j.name : `Job ${n.jobs.length + 1}`)}">
    <div class="two">
      <div><label class="row">Starts</label>${started ? `<div style="padding:10px 0">${at(n, j.from)} <span class="mut small">(started)</span></div>`
        : `<select name="from">${timeOpts(n, cut, n.S - 1, from)}</select>`}</div>
      <div><label class="row">Ends</label><select name="to">${timeOpts(n, Math.max(cut, (started ? j.from : cut) + 1), n.S, Math.max(to, cut))}</select></div>
    </div>
    ${j && !started ? `<button class="btn danger" style="margin-top:14px" data-act="jobremove" data-j="${j.id}">🗑 Remove this job</button>` : ''}`;
  openModal(j ? 'Edit job' : 'New job', body, val => {
    const name = (val('name') || '').trim().slice(0, 18) || 'Job';
    const f = started ? j.from : Number(val('from')), t = Number(val('to'));
    if (t <= f) { toast('The end has to be after the start'); return false; }
    if (j) {
      editNight(`changed ${name}: ${at(n, f)}–${at(n, t)}`, night => {
        const k = findJob(night, j.id);
        if (k < 0) return false;
        Object.assign(night.jobs[k], { name, from: f, to: t });
      });
    } else {
      editNight(`added ${name} (${at(n, f)}–${at(n, t)})`, night => { night.jobs.push({ id: uid(), name, from: f, to: t }); });
    }
  });
}

function personModal(n, p) {
  const cut = cutNow(n), started = p.from < cut;
  const body = `<p class="small mut">When is ${esc(p.name)} around tonight?</p>
    <div class="two">
      <div><label class="row">From</label>${started ? `<div style="padding:10px 0">${at(n, p.from)}</div>`
        : `<select name="from">${timeOpts(n, cut, n.S - 1, p.from)}</select>`}</div>
      <div><label class="row">Until</label><select name="to">${timeOpts(n, Math.max(cut, p.from + 1), n.S, Math.max(p.to, cut))}</select></div>
    </div>`;
  openModal(p.name, body, val => {
    const f = started ? p.from : Number(val('from')), t = Number(val('to'));
    if (t <= f) { toast('"Until" has to be after "from"'); return false; }
    editNight(`set ${p.name} to ${at(n, f)}–${at(n, t)}`, night => { Object.assign(np(night, p.id), { from: f, to: t }); });
  });
}

function awayModal(n, p) {
  const cut = cutNow(n), opts = [];
  for (let k = 1; cut + k <= n.S && k * n.slot <= 240; k++) opts.push(k);
  if (!opts.length) return toast("This shift is already over");
  const body = `<p class="small mut">${esc(p.name)} is away from ${at(n, cut)} for…</p>
    <select name="len">${opts.map(k => `<option value="${k}" ${k * n.slot === 60 ? 'selected' : ''}>${dur(k * n.slot)} (back ${at(n, cut + k)})</option>`).join('')}</select>`;
  openModal('Away / break', body, val => {
    const k = Number(val('len'));
    editNight(`${p.name} away ${at(n, cut)}–${at(n, cut + k)}`, (night, c) => { np(night, p.id).away.push([c, Math.min(night.S, c + k)]); });
  }, 'Set');
}

// ---------- roulette ----------
let R = null, AC = null;

function beep(freq, len = 0.04, vol = 0.06) {
  try {
    AC = AC || new (window.AudioContext || window.webkitAudioContext)();
    const o = AC.createOscillator(), g = AC.createGain();
    o.type = 'square';
    o.frequency.value = freq;
    g.gain.setValueAtTime(vol, AC.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, AC.currentTime + len);
    o.connect(g).connect(AC.destination);
    o.start();
    o.stop(AC.currentTime + len);
  } catch (e) {}
}

function drawWheel(pool, rot) {
  const cv = $('#wheel'), g = cv.getContext('2d'), W = cv.width, c = W / 2, r = c - 8;
  const n = pool.length, a = 2 * Math.PI / n;
  g.clearRect(0, 0, W, W);
  pool.forEach((id, k) => {
    g.beginPath();
    g.moveTo(c, c);
    g.arc(c, c, r, rot + k * a, rot + (k + 1) * a);
    g.closePath();
    // avoid two neighbours sharing a colour when the wheel wraps around
    g.fillStyle = COLORS[(n > 1 && k === n - 1 && k % COLORS.length === 0) ? 1 : k % COLORS.length];
    g.fill();
    g.strokeStyle = '#121318';
    g.lineWidth = 4;
    g.stroke();
    g.save();
    g.translate(c, c);
    g.rotate(rot + (k + 0.5) * a);
    g.textAlign = 'right';
    g.fillStyle = '#121318';
    g.font = `bold ${n > 8 ? 28 : 36}px system-ui, sans-serif`;
    const name = byId(id)?.name || '?';
    g.fillText(name.length > 11 ? name.slice(0, 10) + '…' : name, r - 24, 12);
    g.restore();
  });
  g.beginPath();
  g.arc(c, c, 34, 0, 2 * Math.PI);
  g.fillStyle = '#121318';
  g.fill();
  g.font = '36px system-ui';
  g.textAlign = 'center';
  g.fillText('🔥', c, c + 13);
}

function openRoulette(spin, doneLabel, done) {
  R = { ...spin, doneLabel, done, rot: 0, phase: 'ready' };
  $('#r-sub').innerHTML = `Tonight's jackpot goes first in line for any extra time` +
    (doc.settings.mode === 'fair' ? '<br><span class="small mut">⚖️ Only people with the fewest jackpots are on the wheel</span>' : '');
  $('#r-result').textContent = '';
  $('#r-winners').textContent = '';
  $('#r-btn').textContent = 'SPIN! 🎰';
  $('#r-btn').disabled = false;
  $('#roulette').classList.remove('hidden');
  drawWheel(R.pool, 0);
}

function showLine() {
  const name = byId(R.winner)?.name || '?';
  $('#r-result').textContent = `🎉 JACKPOT! ${name}`;
  $('#r-winners').innerHTML = 'Extra-time line:<br>' + R.line.map((id, i) => `${i + 1}. ${esc(byId(id)?.name || '?')}`).join(' · ');
  $('#r-btn').textContent = R.doneLabel;
  $('#r-btn').disabled = false;
  R.phase = 'done';
}

function spinWheel() {
  const n = R.pool.length, a = 2 * Math.PI / n, i = R.pool.indexOf(R.winner);
  const TAU = 2 * Math.PI, POINTER = -Math.PI / 2;
  let target = POINTER - (i + 0.5) * a + (rnd() - 0.5) * a * 0.7;
  while (target < R.rot + TAU * 6) target += TAU;
  const from = R.rot, t0 = performance.now(), D = 4200;
  let lastSeg = -1;
  R.phase = 'spinning';
  $('#r-btn').disabled = true;
  const frame = now => {
    if (!R) return;
    const p = Math.min(1, (now - t0) / D);
    R.rot = from + (target - from) * (1 - Math.pow(1 - p, 4));
    drawWheel(R.pool, R.rot);
    const seg = Math.floor((((POINTER - R.rot) % TAU) + TAU) % TAU / a);
    if (seg !== lastSeg) { if (lastSeg >= 0) beep(900); lastSeg = seg; }
    if (p < 1) return requestAnimationFrame(frame);
    showLine();
    [523, 659, 784, 1047].forEach((f, k) => setTimeout(() => beep(f, 0.15, 0.08), k * 110));
    if (navigator.vibrate) navigator.vibrate([80, 60, 160]);
  };
  requestAnimationFrame(frame);
}

function closeRoulette() {
  $('#roulette').classList.add('hidden');
  const done = R.done;
  R = null;
  done();
}

$('#r-btn').addEventListener('click', () => {
  if (!R) return;
  if (R.phase === 'ready') spinWheel();
  else if (R.phase === 'done') closeRoulette();
});
$('#r-skip').addEventListener('click', () => {
  if (!R || R.phase === 'spinning') return;
  if (R.phase === 'ready') showLine();
  else closeRoulette();
});
$('#r-cancel').addEventListener('click', () => {
  if (!R || R.phase === 'spinning') return;
  $('#roulette').classList.add('hidden');
  R = null;
  if (sync.pendingRender) render();
});

// ---------- events ----------
document.addEventListener('click', e => {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  const id = b.dataset.id, p = id && byId(id), n = liveNight();
  const jid = b.dataset.j, job = n && jid ? n.jobs[findJob(n, jid)] : null;
  switch (b.dataset.act) {
    case 'tab': switchTab(b.dataset.tab); break;
    case 'set': {
      const key = b.dataset.key;
      doc.settings[key] = key === 'mode' ? b.dataset.val : Number(b.dataset.val);
      commit();
      break;
    }
    case 'present': if (p) { p.present = !p.present; commit(); } break;
    case 'setme': localStorage.setItem(ME_KEY, id); render(); break;
    case 'start': startNight(); break;
    case 'newnight': showSetup = true; pick = null; renderTonight(); window.scrollTo(0, 0); break;
    case 'cancelsetup': showSetup = false; renderTonight(); break;
    case 'cancelnight':
      if (n && confirm('Cancel tonight\'s rota? It won\'t count towards anyone\'s totals.')) { doc.night = null; commit(); }
      break;
    case 'respin':
      if (n) {
        const spin = spinLine(n.people);
        openRoulette(spin, 'Use this line ✅', () => editNight(`re-spun the jackpot. 🎰 ${nameOf(n, spin.winner)} is first in line`, night => { night.line = spin.line; }));
      }
      break;
    case 'jobadd': if (n) jobModal(n, null); break;
    case 'jobedit': if (job) jobModal(n, job); break;
    case 'jobremove':
      closeModal();
      if (job) editNight(`removed ${job.name}`, night => { const k = findJob(night, jid); if (k < 0) return false; removeJob(night, k); });
      break;
    case 'jobend':
      if (job && confirm(`${job.name} has ended? The rest of the night will be recalculated.`)) {
        editNight(`marked ${job.name} as ended`, (night, cut) => {
          const k = findJob(night, jid);
          if (k < 0) return false;
          if (night.jobs[k].from >= cut) removeJob(night, k);
          else night.jobs[k].to = cut;
        });
      }
      break;
    case 'jobresume':
      if (job) editNight(`${job.name} is back on`, night => { night.jobs[findJob(night, jid)].to = night.S; });
      break;
    case 'leave': {
      const q = n && np(n, id);
      if (q && confirm(`${q.name} has gone home? Their remaining time is shared out.`)) {
        editNight(`${q.name} went home`, (night, cut) => { const x = np(night, id); x.to = Math.max(x.from, cut); });
      }
      break;
    }
    case 'away': { const q = n && np(n, id); if (q) awayModal(n, q); break; }
    case 'back': {
      const q = n && np(n, id);
      if (q) {
        editNight(`${q.name} is back`, (night, cut) => {
          const x = np(night, id);
          x.away = x.away.map(([a, z]) => [a, Math.min(z, cut)]).filter(([a, z]) => z > a);
          if (x.to <= cut) { if (x.to < cut) x.away.push([x.to, cut]); x.to = night.S; }
        });
      }
      break;
    }
    case 'arrive':
      if (n && p) {
        editNight(`${p.name} arrived`, (night, cut) => {
          night.people.push({ id: p.id, name: p.name, from: cut, to: night.S, away: [] });
          if (!night.line.includes(p.id)) night.line.push(p.id);
        });
      }
      break;
    case 'personedit': { const q = n && np(n, id); if (q) personModal(n, q); break; }
    case 'pick': {
      if (!n) break;
      const blk = Number(b.dataset.b);
      if (!pick || pick.b !== blk) pick = { b: blk, id };
      else if (pick.id === id) pick = null;
      else {
        const bl = blocks(n).find(x => x.start === blk);
        if (!bl.row.includes(pick.id) && !bl.row.includes(id)) { toast('Both are on break, nothing to swap'); pick = null; }
        else {
          const names = `${nameOf(n, pick.id)} ↔ ${nameOf(n, id)}`;
          swapInPlan(n, bl.start, bl.end, pick.id, id);
          addFeed(n, `swapped ${names} (${at(n, bl.start)}–${at(n, bl.end)})`);
          pick = null;
          commit();
          toast(`Swapped ${names} ✅`);
          break;
        }
      }
      renderTonight();
      break;
    }
    case 'sharetext': if (n) shareText('Fireguard rota', planText(n)); break;
    case 'invite': shareText('Fireguard rota', `🔥 Join our fireguard rota: ${crewUrl()}`); break;
    case 'copyinvite': copyText(crewUrl()); break;
    case 'rename': {
      if (!p) break;
      const name = prompt('New name', p.name);
      if (name && name.trim()) {
        p.name = name.trim().slice(0, 20);
        const q = n && np(n, p.id);
        if (q) q.name = p.name;
        commit();
      }
      break;
    }
    case 'jk': if (p) { p.stats.jackpots = Math.max(0, p.stats.jackpots + Number(b.dataset.d)); commit(); } break;
    case 'delperson':
      if (!p) break;
      if (n && np(n, p.id)) { toast(`${p.name} is on tonight's rota. Mark them 🏠 Gone first, or wait for the next night`); break; }
      if (confirm(`Remove ${p.name}? Their totals will be lost.`)) {
        doc.people = doc.people.filter(x => x !== p);
        commit();
      }
      break;
    case 'backup': {
      const blob = new Blob([JSON.stringify(doc, null, 1)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `fireguard-backup-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      break;
    }
    case 'restore': $('#restore-file').click(); break;
  }
});

document.addEventListener('change', e => {
  const k = e.target.dataset.set;
  if (k) { doc.settings[k] = e.target.value; commit(); }
});
document.addEventListener('input', e => {
  const k = e.target.dataset.job;
  if (k !== undefined) { doc.settings.jobNames[+k] = e.target.value; commit(false); }
});
document.addEventListener('focusout', () => {
  setTimeout(() => {
    const busy = document.activeElement && document.activeElement.matches('input, select, textarea');
    if (sync.pendingRender && !busy && !modalOk && !R) render();
  }, 0);
});
document.addEventListener('submit', e => {
  if (e.target.id !== 'addform') return;
  e.preventDefault();
  const name = $('#newname').value.trim().slice(0, 20);
  if (!name) return;
  if (doc.people.some(p => p.name.toLowerCase() === name.toLowerCase())) return toast(`${name} is already on the crew`);
  doc.people.push({ id: uid(), name, present: true, stats: { nights: 0, minutes: 0, jackpots: 0 } });
  commit();
  $('#newname').focus();
});

$('#restore-file').addEventListener('change', async e => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  try {
    const d = JSON.parse(await f.text());
    if (d.v !== 2 || !Array.isArray(d.people)) throw new Error('bad file');
    if (!confirm('Replace the crew\'s data with this backup? This changes it on everyone\'s phone.')) return;
    const rev = doc.rev;
    doc = fixDoc(d);
    doc.rev = Math.max(rev, doc.rev);
    showSetup = false;
    commit();
    toast('Backup restored ✅');
  } catch (err) { toast('That file is not a Fireguard backup'); }
});

function tick() {
  const d = new Date();
  $('#clock').textContent = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  renderNow();
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  tick();
  if (Date.now() - sync.lastConnect > 10000) connect();
});
window.addEventListener('online', () => { connect(); if (sync.dirty) publishSoon(300); });

// ---------- start ----------
initCrew();
{
  // if the last night ended a while ago, open straight on the new-night screen
  const n = liveNight();
  if (n && Date.now() > n.startTs + (n.S * n.slot + 360) * 60000) showSetup = true;
}
render();
tick();
setInterval(tick, 15000);
connect();

if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
