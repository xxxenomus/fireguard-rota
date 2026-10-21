'use strict';

// ---------- helpers ----------
const $ = s => document.querySelector(s);
const KEY = 'fireguard-rota-v1';
const ME_KEY = 'fireguard-me';
const COLORS = ['#ff6b35', '#f7c548', '#3ec1d3', '#a06cd5', '#58d68d', '#ff4f79', '#4d96ff', '#ffa94d'];
const DEFAULTS = { start: '22:00', end: '06:00', jobs: 3, slot: 30, block: 120, mode: 'fair', jobNames: ['', '', '', '', ''] };

const rnd = () => crypto.getRandomValues(new Uint32Array(1))[0] / 4294967296;
const uid = () => 'p' + Math.random().toString(36).slice(2, 9);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const toMin = hhmm => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };
const fmt = min => { min = ((min % 1440) + 1440) % 1440; return String(Math.floor(min / 60)).padStart(2, '0') + ':' + String(min % 60).padStart(2, '0'); };
const dur = min => { min = Math.round(min); const h = Math.floor(min / 60), m = min % 60; return h && m ? `${h}h ${m}m` : h ? `${h}h` : `${m}m`; };
const shiftLen = (s, e) => ((toMin(e) - toMin(s) + 1440) % 1440) || 1440;
const plural = (n, w, many = w + 's') => `${n} ${n === 1 ? w : many}`;

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), 2400);
}

// ---------- state ----------
function load() {
  let s = null;
  try { s = JSON.parse(localStorage.getItem(KEY)); } catch (e) {}
  s = s || {};
  return {
    people: s.people || [],
    settings: { ...DEFAULTS, ...(s.settings || {}) },
    history: s.history || [],
    currentId: s.currentId || null,
  };
}
function save() {
  try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) { toast('Could not save on this device'); }
}

let state = load();
let showSetup = false;
let pick = null; // first name tapped for a swap: { b: block start slot, id }
let shared = null; // rota opened from a share link (read-only)

const byId = id => state.people.find(p => p.id === id);
const current = () => state.history.find(h => h.id === state.currentId) || null;

// ---------- the maths ----------
function calc() {
  const st = state.settings;
  const present = state.people.filter(p => p.present);
  const len = shiftLen(st.start, st.end);
  const S = len / st.slot;
  const J = st.jobs, n = present.length;
  const errors = [];
  if (!n) errors.push('Nobody is marked as in tonight.');
  if (!Number.isInteger(S)) errors.push(`Shift length (${dur(len)}) doesn't split into ${dur(st.slot)} blocks.`);
  if (J > n) errors.push(`${plural(J, 'job')} but only ${plural(n, 'person', 'people')} in. Can't cover it.`);
  const total = Number.isInteger(S) ? S * J : 0;
  const base = n ? Math.floor(total / n) : 0;
  const extra = n ? total % n : 0;
  return { present, len, S, J, n, total, base, extra, errors };
}

// Who gets the leftover blocks. Each winner gets exactly one extra block.
function pickWinners(present, extra, mode) {
  const rounds = [], won = [];
  for (let k = 0; k < extra; k++) {
    let pool = present.filter(p => !won.includes(p.id));
    if (mode === 'fair') {
      const min = Math.min(...pool.map(p => p.stats.jackpots));
      pool = pool.filter(p => p.stats.jackpots === min);
    }
    const w = pool[Math.floor(rnd() * pool.length)];
    won.push(w.id);
    rounds.push({ pool: pool.map(p => p.id), winner: w.id });
  }
  return rounds;
}

// Fill S time slots × J jobs so everyone hits their quota exactly.
// Picking anyone whose remaining quota equals the remaining slots first keeps it always solvable.
// After that it prefers keeping people on the same job until their stretch is done,
// then the most rested people. With jitter, stretch lengths and tie-breaks are shuffled a bit
// so schedule() can try many variants and keep the tidiest. (Math.random is plenty here and much
// faster than crypto; only the jackpot needs the fair one.)
function scheduleOnce(ids, quotas, S, J, B, minLen, jitter) {
  const rem = { ...quotas }, run = {}, post = {}, last = {}, tie = {}, len = {};
  ids.forEach(id => {
    run[id] = 0; post[id] = -1; last[id] = -1e9; tie[id] = Math.random();
    len[id] = jitter ? Math.max(minLen, B + Math.floor(Math.random() * 3) - 1) : B;
  });
  const grid = [];
  for (let t = 0; t < S; t++) {
    const R = S - t;
    const cand = ids.filter(id => rem[id] > 0).map(id => {
      const on = post[id] >= 0;
      // finishing someone's last bit now beats calling them back later for a tiny stretch
      const cont = on && (run[id] < len[id] || rem[id] < minLen);
      return {
        id,
        must: rem[id] >= R ? 1 : 0,
        cont: cont ? 1 : 0,
        tired: on && !cont ? 1 : 0,
        // someone who only just went on break shouldn't be pulled straight back
        fresh: !on && t - last[id] - 1 < minLen && last[id] >= 0 ? 1 : 0,
        noise: jitter ? Math.random() * 1.5 : 0,
      };
    });
    cand.sort((x, y) =>
      y.must - x.must || y.cont - x.cont || x.tired - y.tired || x.fresh - y.fresh ||
      (rem[y.id] + y.noise) - (rem[x.id] + x.noise) || last[x.id] - last[y.id] || tie[x.id] - tie[y.id]);
    const chosen = cand.slice(0, J).map(c => c.id);
    const row = new Array(J).fill(null);
    chosen.forEach(id => { if (post[id] >= 0 && row[post[id]] === null) row[post[id]] = id; });
    chosen.forEach(id => { if (!row.includes(id)) row[row.indexOf(null)] = id; });
    ids.forEach(id => {
      const k = row.indexOf(id);
      if (k >= 0) { run[id] = post[id] >= 0 ? run[id] + 1 : 1; post[id] = k; rem[id]--; last[id] = t; }
      else { run[id] = 0; post[id] = -1; }
    });
    grid.push(row);
  }
  return grid;
}

// Lower is tidier: few, long stretches; no lone short stretches; real breaks; swaps on the hour.
function scorePlan(grid, ids, B, minLen, slot, startMin) {
  const S = grid.length;
  let score = 0;
  for (const id of ids) {
    let t = 0, prevEnd = -1;
    while (t < S) {
      if (!grid[t].includes(id)) { t++; continue; }
      const s = t;
      let job = grid[t].indexOf(id);
      while (t < S && grid[t].includes(id)) {
        const k = grid[t].indexOf(id);
        if (k !== job) { score += 6; job = k; }
        t++;
      }
      score += 10;
      if (t - s < minLen) score += 40;
      if (t - s > B) score += (t - s - B) * 8;
      if (prevEnd >= 0 && s - prevEnd < minLen) score += 20;
      prevEnd = t;
    }
  }
  for (let t = 1; t < S; t++) {
    if (grid[t].join() !== grid[t - 1].join() && (startMin + t * slot) % 60) score += 3;
  }
  return score;
}

function schedule(ids, quotas, S, J, B, slot, startMin) {
  const minLen = Math.max(1, Math.round(60 / slot));
  let best = null, bestScore = Infinity;
  for (let i = 0; i < 400; i++) {
    const grid = scheduleOnce(ids, quotas, S, J, B, minLen, i > 0);
    const sc = scorePlan(grid, ids, B, minLen, slot, startMin);
    if (sc < bestScore) { best = grid; bestScore = sc; }
  }
  return best;
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

function buildPlan(c, winners) {
  const st = state.settings;
  const ids = c.present.map(p => p.id);
  const quotas = {}, names = {};
  ids.forEach(id => { quotas[id] = c.base + (winners.includes(id) ? 1 : 0); });
  c.present.forEach(p => { names[p.id] = p.name; });
  const B = Math.max(1, Math.round(st.block / st.slot));
  return {
    id: uid(), created: Date.now(), startTs: computeStartTs(st.start, c.len),
    start: st.start, end: st.end, len: c.len, slot: st.slot, jobs: c.J,
    jobNames: Array.from({ length: c.J }, (_, k) => (st.jobNames[k] || '').trim() || `Job ${k + 1}`),
    quotas, winners, names, grid: schedule(ids, quotas, c.S, c.J, B, st.slot, toMin(st.start)),
  };
}

// Add (sign 1) or remove (sign -1) a plan's hours and jackpots from everyone's totals.
function commit(plan, sign) {
  for (const id in plan.quotas) {
    const p = byId(id);
    if (!p) continue;
    p.stats.minutes = Math.max(0, p.stats.minutes + sign * plan.quotas[id] * plan.slot);
    p.stats.nights = Math.max(0, p.stats.nights + sign);
    if (plan.winners.includes(id)) p.stats.jackpots = Math.max(0, p.stats.jackpots + sign);
  }
}

// Swap two people for slots [from, to). Works for two workers (they trade jobs)
// or a worker and someone on break (hours move between them, totals follow).
function swapInPlan(p, from, to, a, b) {
  commit(p, -1);
  for (let t = from; t < to; t++) {
    const row = p.grid[t], ia = row.indexOf(a), ib = row.indexOf(b);
    if (ia >= 0) row[ia] = b;
    if (ib >= 0) row[ib] = a;
  }
  for (const id in p.quotas) p.quotas[id] = p.grid.reduce((n, row) => n + (row.includes(id) ? 1 : 0), 0);
  p.edited = true;
  commit(p, 1);
  save();
}

function removePlan(id) {
  const p = state.history.find(h => h.id === id);
  if (!p) return;
  commit(p, -1);
  state.history = state.history.filter(h => h !== p);
  if (state.currentId === id) state.currentId = null;
  save();
}

function startBuild() {
  const c = calc();
  if (c.errors.length) return toast(c.errors[0]);
  const rounds = c.extra ? pickWinners(c.present, c.extra, state.settings.mode) : [];
  const finish = () => {
    const plan = buildPlan(c, rounds.map(r => r.winner));
    commit(plan, 1);
    state.history.unshift(plan);
    state.currentId = plan.id;
    pick = null;
    showSetup = false;
    save();
    render();
    window.scrollTo(0, 0);
  };
  if (rounds.length) openRoulette(rounds, state.settings.slot, finish);
  else finish();
}

// ---------- plan reading helpers ----------
function blocks(p) {
  const out = [];
  p.grid.forEach((row, t) => {
    const key = row.join(',');
    const L = out[out.length - 1];
    if (L && L.key === key) L.end = t + 1;
    else out.push({ key, row, start: t, end: t + 1 });
  });
  return out;
}
function personSegs(p, id) {
  const segs = [];
  p.grid.forEach((row, t) => {
    const k = row.indexOf(id);
    if (k < 0) return;
    const L = segs[segs.length - 1];
    if (L && L.end === t && L.job === k) L.end = t + 1;
    else segs.push({ job: k, start: t, end: t + 1 });
  });
  return segs;
}
const at = (p, slotIdx) => fmt(toMin(p.start) + slotIdx * p.slot);
const meIdOf = p => {
  if (p !== shared) return null;
  const me = localStorage.getItem(ME_KEY);
  return Object.keys(p.names).find(id => p.names[id] === me) || null;
};
function tagger(p) {
  const ids = Object.keys(p.names), meId = meIdOf(p);
  return id => id
    ? `<span class="tag ${id === meId ? 'me' : ''}" style="--c:${COLORS[ids.indexOf(id) % COLORS.length]}">${esc(p.names[id])}</span>`
    : '<span class="mut">—</span>';
}

// ---------- share links ----------
const b64e = s => btoa(String.fromCharCode(...new TextEncoder().encode(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64d = s => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0)));

function encodePlan(p) {
  const ids = Object.keys(p.names);
  const g = p.grid.map(r => r.map(id => id ? ids.indexOf(id).toString(36) : '-').join('')).join('');
  return b64e(JSON.stringify({
    v: 1, t: p.startTs, s: p.start, e: p.end, l: p.slot, j: p.jobNames,
    n: ids.map(i => p.names[i]), w: p.winners.map(i => ids.indexOf(i)), g,
  }));
}
function decodePlan(str) {
  const o = JSON.parse(b64d(str));
  const len = shiftLen(o.s, o.e), J = o.j.length, S = len / o.l;
  const names = {}, quotas = {};
  o.n.forEach((name, i) => { names['p' + i] = name; quotas['p' + i] = 0; });
  const grid = [];
  for (let t = 0; t < S; t++) {
    const row = [];
    for (let k = 0; k < J; k++) {
      const ch = o.g[t * J + k];
      const id = ch === '-' ? null : 'p' + parseInt(ch, 36);
      if (id) quotas[id]++;
      row.push(id);
    }
    grid.push(row);
  }
  return {
    id: 'shared', startTs: o.t, start: o.s, end: o.e, len, slot: o.l, jobs: J, jobNames: o.j,
    names, quotas, winners: o.w.map(i => 'p' + i), grid,
  };
}
function shareUrl(p) {
  return location.origin + location.pathname + '#r=' + encodePlan(p);
}

function planText(p) {
  const ds = new Date(p.startTs).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
  let s = `🔥 Fireguard rota — ${ds}, ${p.start}–${p.end}\n`;
  if (!p.jobs) return s + '\nNo jobs tonight 😎';
  s += '\n';
  for (const id of Object.keys(p.names)) {
    const segs = personSegs(p, id);
    const win = p.winners.includes(id) ? ' 🎰' : '';
    s += `• ${p.names[id]} (${dur(p.quotas[id] * p.slot)}${win}): `;
    s += segs.length ? segs.map(x => `${at(p, x.start)}–${at(p, x.end)} ${p.jobNames[x.job]}`).join(', ') : 'resting';
    s += '\n';
  }
  if (p.winners.length) s += `\n🎰 Jackpot: ${p.winners.map(id => p.names[id]).join(', ')} (+${dur(p.slot)} each)\n`;
  return s;
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
async function shareRota(p) {
  if (location.protocol === 'file:') toast('Heads up: links only work once the app is hosted online');
  const url = shareUrl(p);
  const text = planText(p) + '\n👉 Live rota: ' + url;
  if (navigator.share) {
    try { await navigator.share({ title: 'Fireguard rota', text }); return; }
    catch (e) { if (e.name === 'AbortError') return; }
  }
  copyText(text);
}

// ---------- rendering: tonight ----------
function setupHTML() {
  const st = state.settings, c = calc();
  const times = v => Array.from({ length: 48 }, (_, k) => fmt(k * 30))
    .map(t => `<option ${t === v ? 'selected' : ''}>${t}</option>`).join('');
  const chips = (key, opts) => `<div class="chips">${opts.map(([v, l]) =>
    `<button class="chip ${st[key] === v ? 'on' : ''}" data-act="set" data-key="${key}" data-val="${v}">${l}</button>`).join('')}</div>`;

  let h = `<div class="card"><h2>Who's in tonight?</h2><div class="chips">${state.people.map(p =>
    `<button class="chip ${p.present ? 'on' : ''}" data-act="present" data-id="${p.id}">${esc(p.name)}</button>`).join('')}</div></div>`;

  h += `<div class="card"><h2>Tonight's shift</h2>
    <div class="two">
      <div><label class="row">Start</label><select data-set="start">${times(st.start)}</select></div>
      <div><label class="row">End</label><select data-set="end">${times(st.end)}</select></div>
    </div>
    <label class="row">How many jobs need a fireguard?</label>
    ${chips('jobs', [0, 1, 2, 3, 4, 5].map(n => [n, n]))}
    ${st.jobs ? `<label class="row">Job names (optional)</label><div class="jobnames">${Array.from({ length: st.jobs }, (_, k) =>
      `<input type="text" data-job="${k}" placeholder="Job ${k + 1}" maxlength="18" value="${esc(st.jobNames[k] || '')}">`).join('')}</div>` : ''}
    <label class="row">Time blocks</label>
    ${chips('slot', [[30, '30 min'], [60, '1 hour']])}
    <label class="row">Swap people every</label>
    ${chips('block', [[60, '1h'], [120, '2h'], [180, '3h'], [240, '4h']])}
    <label class="row">Jackpot mode</label>
    ${chips('mode', [['fair', '⚖️ Fair'], ['luck', '🎲 Pure luck']])}
    <div class="small mut" style="margin-top:6px">${st.mode === 'fair'
      ? 'Fair: whoever has had the fewest jackpots so far gets put on the wheel.'
      : 'Pure luck: everyone is on the wheel every time.'}</div>
    ${mathHTML(c)}
    <button class="big" data-act="build" ${c.errors.length ? 'disabled' : ''}>${c.extra ? '🎰 Spin the jackpot & build rota' : '✅ Build rota'}</button>
  </div>`;
  return h;
}

function mathHTML(c) {
  const slot = state.settings.slot;
  if (c.errors.length) return `<div class="math">${c.errors.map(e => `<div class="err">⚠️ ${esc(e)}</div>`).join('')}</div>`;
  if (!c.J) return `<div class="math">No jobs tonight. Everyone rests 😎</div>`;
  const exact = c.total * slot / c.n;
  let h = `<div class="math">${dur(c.len)} shift × ${plural(c.J, 'job')} = <b>${dur(c.total * slot)}</b> of watch<br>
    ${plural(c.n, 'person', 'people')} → <b>${dur(c.base * slot)}</b> each, about <b>${dur((c.S - c.base) * slot)}</b> of break`;
  if (c.extra) {
    h += `<br><span class="mut small">(an exact split would be ${dur(exact)}, so it's rounded to clean ${dur(slot)} blocks)</span>
      <br>🎰 <b>${c.extra}</b> leftover ${dur(slot)} block${c.extra > 1 ? 's' : ''}: the roulette decides who gets +${dur(slot)}`;
  } else h += ' — splits perfectly, no roulette needed 👌';
  return h + '</div>';
}

function planHTML(p, viewer) {
  const ids = Object.keys(p.names), tag = tagger(p), meId = meIdOf(p);
  const d = new Date(p.startTs).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'short' });
  let h = `<div class="card"><h2>Rota · ${esc(d)}</h2>
    <div class="sub">${p.start}–${p.end} · ${plural(p.jobs, 'job')} · ${dur(p.slot)} blocks${p.edited ? ' · ✏️ edited' : ''}</div>`;
  if (!p.jobs) h += '<p class="now-big">No jobs tonight 😎</p></div>';
  else {
    h += '<div class="people">' + ids.map(id => {
      const segs = personSegs(p, id);
      return `<div class="pp ${id === meId ? 'me' : ''}">
        <div class="pp-top">${tag(id)} <b>${dur(p.quotas[id] * p.slot)}</b>
          ${p.winners.includes(id) ? `<span class="jack">🎰 +${dur(p.slot)}</span>` : ''}</div>
        <div class="pp-segs">${segs.map(s => `${at(p, s.start)}–${at(p, s.end)} <span class="mut">${esc(p.jobNames[s.job])}</span>`).join('<br>')
          || '<span class="mut">Resting all night</span>'}</div></div>`;
    }).join('') + '</div></div>';

    // in the planner every name in the timeline can be tapped to swap it with another in the same row
    const cell = (b, id) => viewer ? tag(id)
      : `<span class="pick ${pick && pick.b === b.start && pick.id === id ? 'picked' : ''}" data-act="pick" data-b="${b.start}" data-id="${id}">${tag(id)}</span>`;
    h += `<div class="card"><h2>Timeline</h2>
      ${viewer ? '' : `<div class="small mut" style="margin:-4px 0 8px">✏️ ${pick ? '<b>Now tap who to swap with (same row)</b>' : 'Tap two names in the same row to swap them'}</div>`}
      <div class="scroll"><table>
      <tr><th>Time</th>${p.jobNames.map(n => `<th>${esc(n)}</th>`).join('')}<th>Break</th></tr>`;
    for (const b of blocks(p)) {
      const resting = ids.filter(id => !b.row.includes(id));
      h += `<tr data-s="${b.start}" data-e="${b.end}"><td class="time">${at(p, b.start)}<br>${at(p, b.end)}</td>
        ${b.row.map(id => `<td>${cell(b, id)}</td>`).join('')}
        <td class="rest">${viewer ? resting.map(id => esc(p.names[id])).join(', ') : resting.map(id => cell(b, id)).join(' ')}</td></tr>`;
    }
    h += '</table></div></div>';
  }
  if (!viewer) {
    h += `<div class="card"><div class="actions">
      <button class="btn acc" data-act="share">🔗 Share with crew</button>
      <button class="btn" data-act="copy">📋 Copy text</button>
      <button class="btn" data-act="reroll">🎲 Re-roll</button>
      <button class="btn" data-act="newrota">➕ New rota</button>
    </div>
    <div class="small mut" style="margin-top:10px">Re-roll throws this rota away (and its jackpots) and spins again.</div></div>`;
  }
  return h;
}

function renderTonight() {
  const el = $('#tab-tonight'), p = current();
  if (!state.people.length) {
    el.innerHTML = `<div class="card center"><p>👋 First, add your crew.</p>
      <button class="big" data-act="tab" data-tab="crew">Add people</button></div>`;
    return;
  }
  if (p && !showSetup) el.innerHTML = '<div id="now"></div>' + planHTML(p, false);
  else el.innerHTML = setupHTML() + (p ? '<button class="btn" data-act="cancelsetup">← Back to current rota</button>' : '');
  renderNow();
}

function myLine(p, id, t) {
  const segs = personSegs(p, id), m = x => x * p.slot;
  const cur = segs.find(s => t >= m(s.start) && t < m(s.end));
  if (cur) return `👉 <b>You're on ${esc(p.jobNames[cur.job])}</b> until ${at(p, cur.end)} (${dur(Math.ceil(m(cur.end) - t))} left)`;
  const nx = segs.find(s => m(s.start) > t);
  if (nx) return `👉 ${t >= 0 ? "You're on break. " : ''}Your next stretch: <b>${at(p, nx.start)}</b> on ${esc(p.jobNames[nx.job])} (in ${dur(Math.ceil(m(nx.start) - t))})`;
  return segs.length ? "👉 You're done for the night 🎉" : "👉 You're resting all night 😎";
}

function renderNow() {
  const p = shared || (!showSetup && current());
  const box = $('#now');
  if (!p || !box) return;
  const t = (Date.now() - p.startTs) / 60000;
  document.querySelectorAll('tr[data-s]').forEach(tr => {
    const a = +tr.dataset.s * p.slot, b = +tr.dataset.e * p.slot;
    tr.classList.toggle('cur', t >= a && t < b);
    tr.classList.toggle('past', t >= b);
  });
  const meId = meIdOf(p), mine = meId ? `<div class="mine">${myLine(p, meId, t)}</div>` : '';
  if (t >= p.len) {
    box.innerHTML = `<div class="card now"><div class="now-big">Shift done ✅</div><div class="mut">Good work, go sleep 😴</div></div>`;
    return;
  }
  if (t < 0) {
    box.innerHTML = `<div class="card now"><div class="mut">Shift starts in</div><div class="now-big">${dur(Math.ceil(-t))}</div>${mine}</div>`;
    return;
  }
  if (!p.jobs) {
    box.innerHTML = `<div class="card now"><div class="now-big">Quiet night 😎</div><div class="mut">No jobs to cover</div></div>`;
    return;
  }
  const tag = tagger(p), s = Math.floor(t / p.slot), row = p.grid[s], key = row.join();
  let u = s + 1;
  while (u < p.grid.length && p.grid[u].join() === key) u++;
  const left = dur(Math.ceil(u * p.slot - t));
  let h = `<div class="card now"><h2>🟢 On duty now</h2>` +
    row.map((id, k) => `<div class="nowrow"><span class="mut">${esc(p.jobNames[k])}</span>${tag(id)}</div>`).join('');
  if (u < p.grid.length) {
    const changes = p.grid[u].map((id, k) => id !== row[k] ? `${tag(id)} takes over ${esc(p.jobNames[k])}` : null).filter(Boolean);
    h += `<div class="next">⏭ Next swap <b>${at(p, u)}</b> (in ${left})<br>${changes.join('<br>')}</div>`;
  } else {
    h += `<div class="next">🏁 Last stretch. Shift ends ${p.end} (in ${left})</div>`;
  }
  box.innerHTML = h + mine + '</div>';
}

// ---------- rendering: crew ----------
function renderCrew() {
  const el = $('#tab-crew');
  el.innerHTML = `<div class="card"><h2>Add person</h2>
    <form id="addform" class="addrow"><input type="text" id="newname" placeholder="Name" maxlength="20" autocomplete="off">
    <button class="btn acc">Add</button></form></div>
    <div class="card"><h2>Crew (${state.people.length})</h2>
    ${state.people.map(p => `<div class="crew">
      <button class="chip ${p.present ? 'on' : ''}" data-act="present" data-id="${p.id}">${p.present ? '✅ In' : '💤 Off'}</button>
      <div class="cname" data-act="rename" data-id="${p.id}">${esc(p.name)}
        <div class="mut small">${plural(p.stats.nights, 'night')} · ${dur(p.stats.minutes)} · 🎰 ${p.stats.jackpots}</div></div>
      <div class="jk"><button class="mini" data-act="jk" data-id="${p.id}" data-d="-1">−</button>
        <button class="mini" data-act="jk" data-id="${p.id}" data-d="1">+</button></div>
      <button class="mini danger" data-act="delperson" data-id="${p.id}">✕</button>
    </div>`).join('') || '<p class="mut">Nobody yet.</p>'}
    <div class="small mut" style="margin-top:10px">Tap a name to rename it. Use − / + to fix someone's 🎰 jackpot count.</div></div>
    <div class="card"><h2>How the jackpot works</h2>
    <p class="small">Hours are split into clean blocks, so nobody ends up working 1h 39m. If the blocks don't split evenly,
    the leftovers go to the <b>jackpot roulette</b> 🎰 and each winner works one extra block.
    In ⚖️ Fair mode only the people with the fewest jackpots go on the wheel, so it evens out over time.</p></div>`;
}

// ---------- rendering: history ----------
function renderHistory() {
  const el = $('#tab-history');
  let h = `<div class="card"><h2>Past rotas</h2>`;
  h += state.history.map(p => {
    const d = new Date(p.startTs).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
    return `<div class="hist"><div class="hist-top"><div><b>${esc(d)}</b>
      <span class="mut small">${p.start}–${p.end} · ${plural(p.jobs, 'job')}</span></div>
      <button class="mini danger" data-act="delplan" data-id="${p.id}">🗑</button></div>
      <div class="chips">${Object.keys(p.names).map(id =>
        `<span class="small">${esc(p.names[id])} ${dur(p.quotas[id] * p.slot)}${p.winners.includes(id) ? ' 🎰' : ''}</span>`).join(' · ')}</div></div>`;
  }).join('') || '<p class="mut">No rotas yet.</p>';
  h += `<div class="small mut" style="margin-top:10px">Deleting a rota also takes its hours and jackpots off everyone's totals.</div></div>
    <div class="card"><h2>Backup</h2>
    <p class="small mut">Everything is saved on this phone only. Make a backup now and then, or to hand planning over to someone else.</p>
    <div class="actions"><button class="btn" data-act="backup">💾 Save backup</button>
    <button class="btn" data-act="restore">📂 Restore backup</button></div></div>`;
  el.innerHTML = h;
}

// ---------- rendering: shared (coworker) view ----------
function renderViewer() {
  const p = shared, meId = meIdOf(p), ids = Object.keys(p.names);
  $('#viewer').innerHTML = `<div class="card"><h2>Tap your name</h2><div class="chips">${ids.map(id =>
      `<button class="chip ${id === meId ? 'on' : ''}" data-act="me" data-name="${esc(p.names[id])}">${esc(p.names[id])}</button>`).join('')}</div></div>
    <div id="now"></div>${planHTML(p, true)}
    <p class="center"><button class="link" data-act="leave">Open my own planner</button></p>`;
  renderNow();
}

function render() {
  document.body.classList.toggle('viewer', !!shared);
  if (shared) return renderViewer();
  renderTonight();
  renderCrew();
  renderHistory();
}

function switchTab(name) {
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.id === 'tab-' + name));
  document.querySelectorAll('nav button').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  window.scrollTo(0, 0);
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

function openRoulette(rounds, slot, done) {
  R = { rounds, slot, done, idx: 0, rot: 0, phase: 'ready', winners: [] };
  $('#roulette').classList.remove('hidden');
  showRound();
}

function showRound() {
  const r = R.rounds[R.idx];
  $('#r-sub').innerHTML = `Spin <b>${R.idx + 1}</b> of <b>${R.rounds.length}</b> · prize: <b>+${dur(R.slot)}</b> of bonus fireguarding` +
    (state.settings.mode === 'fair' ? '<br><span class="small mut">⚖️ Only people with the fewest jackpots are on the wheel</span>' : '');
  $('#r-result').textContent = '';
  $('#r-winners').textContent = R.winners.length ? '🎰 ' + R.winners.join(', ') : '';
  $('#r-btn').textContent = 'SPIN! 🎰';
  $('#r-btn').disabled = false;
  R.phase = 'ready';
  drawWheel(r.pool, R.rot);
}

function spinWheel() {
  const r = R.rounds[R.idx], n = r.pool.length, a = 2 * Math.PI / n, i = r.pool.indexOf(r.winner);
  const TAU = 2 * Math.PI, POINTER = -Math.PI / 2;
  let target = POINTER - (i + 0.5) * a + (rnd() - 0.5) * a * 0.7;
  while (target < R.rot + TAU * 6) target += TAU;
  const from = R.rot, t0 = performance.now(), D = 4200;
  let lastSeg = -1;
  R.phase = 'spinning';
  $('#r-btn').disabled = true;
  const frame = now => {
    const p = Math.min(1, (now - t0) / D);
    R.rot = from + (target - from) * (1 - Math.pow(1 - p, 4));
    drawWheel(r.pool, R.rot);
    const seg = Math.floor((((POINTER - R.rot) % TAU) + TAU) % TAU / a);
    if (seg !== lastSeg) { if (lastSeg >= 0) beep(900); lastSeg = seg; }
    if (p < 1) return requestAnimationFrame(frame);
    const name = byId(r.winner)?.name || '?';
    R.winners.push(name);
    R.phase = 'done';
    $('#r-result').textContent = `🎉 JACKPOT! ${name} gets +${dur(R.slot)}`;
    $('#r-winners').textContent = '🎰 ' + R.winners.join(', ');
    $('#r-btn').textContent = R.idx < R.rounds.length - 1 ? 'Next spin ➜' : 'Build the rota ✅';
    $('#r-btn').disabled = false;
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
  else if (R.phase === 'done') {
    if (R.idx < R.rounds.length - 1) { R.idx++; showRound(); }
    else closeRoulette();
  }
});
$('#r-skip').addEventListener('click', () => { if (R && R.phase !== 'spinning') closeRoulette(); });

// ---------- events ----------
document.addEventListener('click', e => {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  const id = b.dataset.id, p = id && byId(id);
  switch (b.dataset.act) {
    case 'tab': switchTab(b.dataset.tab); break;
    case 'set': {
      const key = b.dataset.key;
      state.settings[key] = key === 'mode' ? b.dataset.val : Number(b.dataset.val);
      save(); renderTonight(); break;
    }
    case 'present': if (p) { p.present = !p.present; save(); render(); } break;
    case 'build': startBuild(); break;
    case 'newrota': showSetup = true; pick = null; renderTonight(); window.scrollTo(0, 0); break;
    case 'cancelsetup': showSetup = false; renderTonight(); break;
    case 'reroll':
      if (confirm('Throw this rota away and spin again?')) { removePlan(state.currentId); startBuild(); }
      break;
    case 'pick': {
      const plan = current(), blk = Number(b.dataset.b);
      if (!plan) break;
      if (!pick || pick.b !== blk) pick = { b: blk, id };
      else if (pick.id === id) pick = null;
      else {
        const bl = blocks(plan).find(x => x.start === blk);
        if (!bl.row.includes(pick.id) && !bl.row.includes(id)) { toast('Both are on break, nothing to swap'); pick = null; }
        else {
          const names = `${plan.names[pick.id]} ↔ ${plan.names[id]}`;
          swapInPlan(plan, bl.start, bl.end, pick.id, id);
          pick = null;
          renderCrew(); renderHistory();
          toast(`Swapped ${names} ✅ Share again so the crew sees it`);
        }
      }
      renderTonight();
      break;
    }
    case 'share': shareRota(current()); break;
    case 'copy': copyText(planText(current())); break;
    case 'rename': {
      if (!p) break;
      const name = prompt('New name', p.name);
      if (name && name.trim()) { p.name = name.trim().slice(0, 20); save(); render(); }
      break;
    }
    case 'jk': if (p) { p.stats.jackpots = Math.max(0, p.stats.jackpots + Number(b.dataset.d)); save(); renderCrew(); } break;
    case 'delperson':
      if (p && confirm(`Remove ${p.name}? Their totals will be lost.`)) {
        state.people = state.people.filter(x => x !== p); save(); render();
      }
      break;
    case 'delplan':
      if (confirm('Delete this rota? Its hours and jackpots come off everyone\'s totals.')) { removePlan(id); render(); }
      break;
    case 'backup': {
      const blob = new Blob([JSON.stringify(state, null, 1)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `fireguard-backup-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      break;
    }
    case 'restore': $('#restore-file').click(); break;
    case 'me': {
      const name = b.dataset.name;
      if (localStorage.getItem(ME_KEY) === name) localStorage.removeItem(ME_KEY);
      else localStorage.setItem(ME_KEY, name);
      renderViewer(); break;
    }
    case 'leave': history.replaceState(null, '', location.pathname); shared = null; render(); break;
  }
});

document.addEventListener('change', e => {
  const k = e.target.dataset.set;
  if (k) { state.settings[k] = e.target.value; save(); renderTonight(); }
});
document.addEventListener('input', e => {
  const k = e.target.dataset.job;
  if (k !== undefined) { state.settings.jobNames[+k] = e.target.value; save(); }
});
document.addEventListener('submit', e => {
  if (e.target.id !== 'addform') return;
  e.preventDefault();
  const name = $('#newname').value.trim().slice(0, 20);
  if (!name) return;
  if (state.people.some(p => p.name.toLowerCase() === name.toLowerCase())) return toast(`${name} is already on the crew`);
  state.people.push({ id: uid(), name, present: true, stats: { nights: 0, minutes: 0, jackpots: 0 } });
  save(); render();
  $('#newname').focus();
});

$('#restore-file').addEventListener('change', async e => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  try {
    const s = JSON.parse(await f.text());
    if (!Array.isArray(s.people) || !Array.isArray(s.history)) throw new Error('bad file');
    if (!confirm('Replace everything on this phone with the backup?')) return;
    localStorage.setItem(KEY, JSON.stringify(s));
    state = load(); showSetup = false; render(); toast('Backup restored ✅');
  } catch (err) { toast('That file is not a Fireguard backup'); }
});

function readHash() {
  shared = null;
  const m = location.hash.match(/^#r=(.+)$/);
  if (m) {
    try { shared = decodePlan(m[1]); } catch (e) { toast('That rota link is broken 😕'); }
  }
}
window.addEventListener('hashchange', () => { readHash(); render(); });

function tick() {
  const d = new Date();
  $('#clock').textContent = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  renderNow();
}

// ---------- start ----------
readHash();
{
  // if the last rota ended a while ago, open straight on the setup screen
  const p = current();
  if (p && Date.now() > p.startTs + (p.len + 360) * 60000) showSetup = true;
}
render();
tick();
setInterval(tick, 15000);

if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
