"use strict";
/* Music Room: view, book and track the dorm music room on TeamUp.
   Everything private (keys, link, token) is stored only on this device. */

const API = "https://api.teamup.com";
const REPO = "Vibes-480/Music-Booking";
const DAY_END = "23:00";          // "until next booking" never goes past this
const MAX_HOURS = 8;
const LEAD_MIN = 60;              // bookings start at least this long from now
const $ = (s, el = document) => el.querySelector(s);
const app = $("#app");

/* ---------- storage ---------- */
const store = {
  get(k, d) { try { const v = localStorage.getItem("mr." + k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem("mr." + k, JSON.stringify(v)); } catch {} },
};
let S = store.get("settings", { teamupKey: "", calendarKey: "", subcalId: "", myName: "Ronny", ghToken: "", subcals: [] });
/* Calendars whose events are people's bookings ("Ordinary booking", "Prolonged booking").
   The rest (council meetings etc.) still block the room but never count as a person. */
function personCals() {
  const ids = new Set((S.subcals || []).filter(c => /booking/i.test(c.name)).map(c => String(c.id)));
  if (S.subcalId) ids.add(String(S.subcalId));
  return ids;
}
const calName = ev => (S.subcals || []).find(c => (ev.subcalendar_ids || []).map(String).includes(String(c.id)))?.name || "";
const isPersonEv = ev => { const ids = personCals(); return !ids.size || (ev.subcalendar_ids || []).some(id => ids.has(String(id))); };
async function loadSubcals() {
  const j = await tu("/subcalendars");
  S.subcals = (j?.subcalendars || []).filter(c => c.active !== false).map(c => ({ id: c.id, name: c.name, readonly: !!c.readonly }));
  if (!S.subcalId) S.subcalId = String(S.subcals.find(c => !c.readonly && /booking/i.test(c.name))?.id || S.subcals.find(c => !c.readonly)?.id || "");
  store.set("settings", S);
}
let favs = store.get("favs", []);
let known = store.get("known", []);
let tab = store.get("tab", "now");

/* ---------- time helpers ---------- */
const pad = n => String(n).padStart(2, "0");
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const hm = d => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
function iso(d) {
  const o = -d.getTimezoneOffset(), sign = o >= 0 ? "+" : "-", a = Math.abs(o);
  return `${ymd(d)}T${hm(d)}:00${sign}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
}
const addMin = (d, m) => new Date(d.getTime() + m * 60000);
function ceilTo(d, step) { const x = new Date(d); x.setSeconds(0, 0); const r = x.getMinutes() % step; if (r) x.setMinutes(x.getMinutes() + step - r); return x; }
function atTime(day, t) { const [h, m] = t.split(":").map(Number); const x = new Date(day); x.setHours(h, m, 0, 0); return x; }
const startOfDay = d => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
const WD = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const wd = d => WD[(d.getDay() + 6) % 7];
const dayLabel = d => { const t = startOfDay(new Date()); const diff = Math.round((startOfDay(d) - t) / 864e5);
  return diff === 0 ? "Today" : diff === 1 ? "Tomorrow" : `${wd(d)} ${d.getDate()}/${d.getMonth() + 1}`; };
const dur = m => { const h = Math.floor(m / 60), r = m % 60; return h && r ? `${h}h ${r}m` : h ? `${h}h` : `${r}m`; };
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/* ---------- names ---------- */
function knownMap() {           // "Anna K = Anna" means both spellings are Anna K
  const m = new Map();
  for (const entry of known) { const parts = String(entry).split("=").map(s => s.trim()).filter(Boolean);
    for (const p of parts) m.set(p.toLowerCase(), parts[0]); }
  return m;
}
const rawName = ev => (ev.who || "").trim() || (ev.title || "").trim();
function person(ev) {
  if (!isPersonEv(ev)) return { name: (ev.title || "").trim() || calName(ev), kind: "event", cal: calName(ev) };
  const n = rawName(ev); if (!n) return { name: "", kind: "noname" };
  const k = knownMap().get(n.toLowerCase());
  if (k) return { name: k, kind: k.toLowerCase() === S.myName.toLowerCase() ? "me" : "known" };
  if (n.toLowerCase() === S.myName.toLowerCase()) return { name: n, kind: "me" };
  return { name: n, kind: "unknown" };
}
const isMine = ev => rawName(ev).toLowerCase() === S.myName.toLowerCase();

/* ---------- TeamUp ---------- */
async function tu(path, method = "GET", body) {
  let r;
  try {
    r = await fetch(`${API}/${S.calendarKey}${path}`, { method, body: body ? JSON.stringify(body) : undefined,
      headers: { "Teamup-Token": S.teamupKey, ...(body ? { "Content-Type": "application/json" } : {}) } });
  } catch { throw new Error("Couldn't reach TeamUp. Check your internet connection."); }
  if (!r.ok) {
    let msg = ""; try { const j = await r.json(); msg = j.error?.message || j.error?.title || ""; } catch {}
    if (r.status === 401 || r.status === 403) throw new Error(`TeamUp refused this (${r.status}). ${msg || "Your link may not allow this, or the API key is wrong."}`);
    throw new Error(`TeamUp error ${r.status}. ${msg}`);
  }
  return r.status === 204 ? null : r.json().catch(() => null);
}
function norm(e) { return { ...e, s: new Date(e.start_dt), e: new Date(e.end_dt) }; }
async function getEvents(from, to) {
  const j = await tu(`/events?startDate=${ymd(from)}&endDate=${ymd(to)}`);
  return (j?.events || []).filter(e => !e.all_day).map(norm).sort((a, b) => a.s - b.s);
}
function eventBody(ev, changes) {
  const b = { ...ev, ...changes }; delete b.s; delete b.e; return b;
}

/* ---------- state ---------- */
let events = [];        // today .. +60 days
let loadError = "";
let pending = null;     // confirm sheet {text, run}
let busy = false;

async function loadUpcoming() {
  const now = new Date();
  events = await getEvents(now, addMin(now, 60 * 24 * 60));
}
function overlaps(s, e, list = events, ignoreId) {
  return list.some(ev => ev.id !== ignoreId && ev.s < e && ev.e > s);
}
function nextStartAfter(t, list = events, ignoreId) {
  return list.filter(ev => ev.id !== ignoreId && ev.s >= t).sort((a, b) => a.s - b.s)[0]?.s || null;
}

/* ---------- UI plumbing ---------- */
function toast(msg) {
  const t = document.createElement("div"); t.className = "toast"; t.textContent = msg; document.body.append(t);
  setTimeout(() => t.remove(), 3200);
}
function ask(text, run, cta = "Confirm") {
  pending = { text, run, cta }; renderConfirm();
}
function renderConfirm() {
  $(".confirm")?.remove();
  if (!pending) return;
  const el = document.createElement("div"); el.className = "confirm";
  el.innerHTML = `<div><p>${esc(pending.text)}</p><div class="btns"><button id="c-no">Back</button><button class="primary" id="c-yes">${esc(pending.cta)}</button></div></div>`;
  document.body.append(el);
  $("#c-no").onclick = () => { pending = null; renderConfirm(); };
  $("#c-yes").onclick = async () => {
    const p = pending; pending = null; renderConfirm(); busy = true; render();
    try { const msg = await p.run(); if (msg) toast(msg); } catch (e) { toast(e.message); }
    busy = false; await refresh();
  };
}
async function refresh() {
  try { loadError = ""; await loadUpcoming(); } catch (e) { loadError = e.message; }
  render();
}

/* ---------- actions ---------- */
async function bookSlot(s, e) {
  const fresh = await getEvents(s, e);        // re-check right before booking
  if (overlaps(s, e, fresh)) throw new Error("Someone booked that time in the meantime. Nothing was booked.");
  await tu("/events", "POST", { subcalendar_ids: [Number(S.subcalId) || S.subcalId].filter(Boolean),
    title: S.myName, who: S.myName, start_dt: iso(s), end_dt: iso(e), all_day: false });
  return `Booked ${dayLabel(s)} ${hm(s)}–${hm(e)}`;
}
async function changeEnd(ev, newEnd) {
  await tu(`/events/${ev.id}`, "PUT", eventBody(ev, { end_dt: iso(newEnd) }));
}
async function cancel(ev) {
  await tu(`/events/${ev.id}?version=${encodeURIComponent(ev.version || "")}`, "DELETE");
  return "Booking cancelled";
}

/* ---------- Now tab ---------- */
function renderNow() {
  const now = new Date();
  const today = events.filter(e => startOfDay(e.s).getTime() === startOfDay(now).getTime() || (e.s < now && e.e > now));
  const current = events.find(e => e.s <= now && e.e > now);
  const next = events.find(e => e.s > now);
  let banner;
  if (current) {
    // run of back-to-back bookings counts as one busy stretch
    let until = current.e; for (const e of events) if (e.s <= until && e.e > until) until = e.e;
    const p = person(current);
    banner = `<div class="banner busy"><b>Busy until ${hm(until)}</b><span>${p.kind === "me" ? "You're booked" : esc(p.name || "No name")}${next && next.s < addMin(until, 1) ? "" : ""}</span></div>`;
  } else if (next && startOfDay(next.s).getTime() === startOfDay(now).getTime()) {
    const p = person(next);
    banner = `<div class="banner"><b>Free until ${hm(next.s)}</b><span>Next: ${p.kind === "me" ? "you" : esc(p.name || "no name")}, ${hm(next.s)}–${hm(next.e)}</span></div>`;
  } else {
    banner = `<div class="banner"><b>Free the rest of today</b><span>${next ? `Next booking ${dayLabel(next.s)} ${hm(next.s)}` : "Nothing booked ahead"}</span></div>`;
  }

  const row = ev => {
    const p = person(ev), cls = ev.s <= now && ev.e > now ? "now" : ev.e <= now ? "past" : "";
    const who = p.kind === "me" ? `<span class="me">${esc(p.name)}</span>`
      : p.kind === "noname" ? `<span class="pill noname">No name</span>`
      : p.kind === "unknown" ? `${esc(p.name)} <span class="pill unknown">New</span>`
      : p.kind === "event" ? (p.cal && p.cal !== p.name ? `${esc(p.name)} <span class="pill event">${esc(p.cal)}</span>` : `${esc(p.name)} <span class="pill event">Meeting</span>`) : esc(p.name);
    return `<div class="row ${cls}"><span>${who}</span><span class="t">${hm(ev.s)}–${hm(ev.e)}</span></div>`;
  };

  // my current booking controls
  let mine = "";
  if (current && isMine(current)) {
    const ext = addMin(current.e, 30), nx = nextStartAfter(current.e, events, current.id);
    const canExt = !nx || nx >= ext;
    mine = `<h2>Your booking now</h2><div class="grid">
      <button class="wide" id="leave">I'm leaving now</button>
      <button class="wide" id="extend" ${canExt ? "" : "disabled"}>+30 min (until ${hm(ext)})${canExt ? "" : " · someone's next"}</button></div>`;
  }

  // book buttons
  const start = ceilTo(addMin(now, LEAD_MIN), 15);
  const btns = [];
  for (let m = 60; m <= MAX_HOURS * 60; m += 30) {
    const e = addMin(start, m), ok = !overlaps(start, e);
    btns.push(`<button data-book="${m}" ${ok && !busy ? "" : "disabled"}>${m / 60}h</button>`);
  }
  const cap = atTime(start, DAY_END);
  let untilEnd = nextStartAfter(start); if (!untilEnd || untilEnd > cap) untilEnd = cap;
  const untilOk = !overlaps(start, addMin(start, 15)) && untilEnd - start >= 15 * 60000;
  const untilLabel = untilOk ? `Until next booking · ${hm(start)}–${hm(untilEnd)} (${dur(Math.round((untilEnd - start) / 60000))})` : "Until next booking · not possible";

  const favBtns = favs.map((f, i) => {
    const s = nextFavStart(f), e = atTime(s, f.e);
    return `<button class="fav" data-fav="${i}" ${busy ? "disabled" : ""}>${WD[f.d]} ${f.s}–${f.e}<br><small class="sub">next: ${dayLabel(s)}</small></button>`;
  }).join("");

  const upcoming = events.filter(e => isMine(e) && e.s > now);
  app.innerHTML = `
    <h1>Music room <button class="link" id="settings" aria-label="Settings">Settings</button></h1>
    ${loadError ? `<div class="list"><div class="empty">${esc(loadError)}</div></div>` : ""}
    ${banner}
    ${mine}
    <h2>Today</h2>
    <div class="list">${today.length ? today.map(row).join("") : `<div class="empty">No bookings today.</div>`}</div>
    <h2>Book from ${hm(start)}${startOfDay(start) > startOfDay(now) ? " tomorrow" : ""}</h2>
    <div class="grid">${btns.join("")}
      <button class="wide primary" id="until" ${untilOk && !busy ? "" : "disabled"}>${untilLabel}</button></div>
    <h2>Favourite slots</h2>
    <div class="grid">${favBtns}<button class="wide link" id="addfav">+ Add a favourite slot</button></div>
    <div id="favform" hidden class="form">
      <div class="inline"><label>Day<select id="f-d">${WD.map((d, i) => `<option value="${i}">${d}</option>`).join("")}</select></label>
      <label>From<input id="f-s" type="time" value="19:00" step="900"></label><label>To<input id="f-e" type="time" value="21:00" step="900"></label></div>
      <div class="inline"><button id="f-cancel">Cancel</button><button class="primary" id="f-save">Save slot</button></div>
      ${favs.length ? `<button class="link danger" id="f-clear">Remove all favourites</button>` : ""}
    </div>
    <h2>Your upcoming bookings</h2>
    <div class="list">${upcoming.length ? upcoming.map(e => `<div class="row"><span>${dayLabel(e.s)} <span class="t">${hm(e.s)}–${hm(e.e)}</span></span><button class="danger" data-cancel="${e.id}">Cancel</button></div>`).join("") : `<div class="empty">None booked.</div>`}</div>
    <p class="sub">Updated ${hm(now)} · <button class="link" id="reload">Refresh</button></p>`;

  $("#settings").onclick = () => renderSettings();
  $("#reload").onclick = () => { toast("Refreshing…"); refresh(); };
  app.querySelectorAll("[data-book]").forEach(b => b.onclick = () => {
    const e = addMin(start, Number(b.dataset.book));
    ask(`Book ${dayLabel(start)} ${hm(start)}–${hm(e)}?`, () => bookSlot(start, e), "Book it");
  });
  $("#until").onclick = () => ask(`Book ${dayLabel(start)} ${hm(start)}–${hm(untilEnd)}?`, () => bookSlot(start, untilEnd), "Book it");
  app.querySelectorAll("[data-fav]").forEach(b => b.onclick = () => {
    const f = favs[b.dataset.fav], s = nextFavStart(f), e = atTime(s, f.e);
    ask(`Book ${dayLabel(s)} ${hm(s)}–${hm(e)}?`, () => bookSlot(s, e), "Book it");
  });
  app.querySelectorAll("[data-cancel]").forEach(b => b.onclick = () => {
    const ev = events.find(e => String(e.id) === b.dataset.cancel);
    ask(`Cancel your booking ${dayLabel(ev.s)} ${hm(ev.s)}–${hm(ev.e)}?`, () => cancel(ev), "Cancel booking");
  });
  $("#addfav").onclick = () => { $("#favform").hidden = false; };
  $("#f-cancel").onclick = () => { $("#favform").hidden = true; };
  $("#f-save").onclick = () => {
    const f = { d: Number($("#f-d").value), s: $("#f-s").value, e: $("#f-e").value };
    if (!f.s || !f.e || f.e <= f.s) return toast("The end time has to be after the start.");
    favs.push(f); store.set("favs", favs); render();
  };
  $("#f-clear")?.addEventListener("click", () => { favs = []; store.set("favs", favs); render(); });
  if (current && isMine(current)) {
    $("#leave").onclick = () => {
      const end = new Date(Math.max(ceilTo(new Date(), 5), addMin(current.s, 15)));
      ask(`End your booking at ${hm(end)}?`, async () => { await changeEnd(current, end); return `Booking now ends at ${hm(end)}`; }, "End it");
    };
    $("#extend").onclick = () => {
      const ext = addMin(current.e, 30);
      ask(`Extend your booking to ${hm(ext)}?`, async () => {
        const fresh = await getEvents(current.e, ext);
        if (overlaps(current.e, ext, fresh, current.id)) throw new Error("Someone is booked right after you. Not extended.");
        await changeEnd(current, ext); return `Extended to ${hm(ext)}`;
      }, "Extend");
    };
  }
}
function nextFavStart(f) {
  const now = new Date(), earliest = addMin(now, LEAD_MIN);
  for (let i = 0; i < 8; i++) {
    const d = addMin(startOfDay(now), i * 1440);
    if ((d.getDay() + 6) % 7 !== f.d) continue;
    const s = atTime(d, f.s); if (s >= earliest) return s;
  }
  return atTime(addMin(startOfDay(now), 7 * 1440), f.s);
}

/* ---------- Stats tab ---------- */
let history = store.get("history", null);   // {fetched, ev:[[startMs,endMs,name]]}
async function loadHistory(force) {
  if (history && !force && Date.now() - history.fetched < 6 * 3600e3) return;
  const now = new Date(), out = []; let empty = 0;
  for (let i = 0; i < 24 && empty < 3; i++) {           // 90-day chunks, up to 6 years back
    const to = addMin(now, -i * 90 * 1440), from = addMin(to, -89 * 1440);
    const ev = await getEvents(from, to);
    empty = ev.length ? 0 : empty + 1;
    for (const e of ev) if (e.s < now && isPersonEv(e)) out.push([e.s.getTime(), e.e.getTime(), rawName(e)]);
  }
  const seen = new Set();
  history = { fetched: Date.now(), ev: out.filter(x => { const k = x.join("|"); return !seen.has(k) && seen.add(k); }) };
  store.set("history", history);
}
function statsHtml() {
  const now = Date.now(), DAY = 864e5, km = knownMap();
  const canon = n => (n ? km.get(n.toLowerCase()) || n : "(no name)");
  const me = S.myName.toLowerCase();
  const mine = history.ev.filter(x => canon(x[2]).toLowerCase() === me);
  const hrs = list => list.reduce((a, x) => a + (Math.min(x[1], now) - x[0]) / 36e5, 0);
  const weekStart = startOfDay(new Date()); weekStart.setDate(weekStart.getDate() - ((weekStart.getDay() + 6) % 7));
  const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
  const weeks = [];
  for (let i = 11; i >= 0; i--) {
    const s = weekStart.getTime() - i * 7 * DAY, e = s + 7 * DAY;
    weeks.push({ s, h: hrs(mine.filter(x => x[0] >= s && x[0] < e)) });
  }
  const avgWeek = weeks.slice(0, 11).reduce((a, w) => a + w.h, 0) / 11;
  const days = new Set(mine.map(x => ymd(new Date(x[0]))));
  let streak = 0, d = startOfDay(new Date()); if (!days.has(ymd(d))) d = addMin(d, -1440);
  while (days.has(ymd(d))) { streak++; d = addMin(d, -1440); }
  const f1 = n => n.toFixed(1).replace(/\.0$/, "");

  const max = Math.max(1, ...weeks.map(w => w.h)), W = 320, H = 120, bw = W / 12;
  const bars = weeks.map((w, i) => { const h = (w.h / max) * (H - 30);
    return `<rect x="${i * bw + 3}" y="${H - 18 - h}" width="${bw - 6}" height="${h}" rx="3" fill="var(--accent)" opacity="${i === 11 ? 1 : .55}"></rect>
      ${i % 2 === 1 || i === 11 ? `<text x="${i * bw + bw / 2}" y="${H - 4}" font-size="9" text-anchor="middle" fill="var(--muted)">${new Date(w.s).getDate()}/${new Date(w.s).getMonth() + 1}</text>` : ""}`; }).join("");

  const people = new Map();
  for (const x of history.ev) { const n = canon(x[2]); if (!people.has(n)) people.set(n, []); people.get(n).push(x); }
  const rows = [...people.entries()].map(([n, l]) => {
    const c = days => l.filter(x => x[0] >= now - days * DAY).length;
    const first = Math.min(...l.map(x => x[0])), months = Math.max(1, (now - first) / (30.44 * DAY));
    return { n, m1: c(30), m3: c(91), m6: c(182), y1: c(365), all: l.length, avg: l.length / months };
  }).sort((a, b) => b.all - a.all);

  return `
    <h2>Your practice</h2>
    <div class="tiles">
      <div class="tile"><b>${f1(weeks[11].h)} h</b><span>this week</span></div>
      <div class="tile"><b>${f1(hrs(mine.filter(x => x[0] >= monthStart.getTime())))} h</b><span>this month</span></div>
      <div class="tile"><b>${f1(avgWeek)} h</b><span>average per week (last 11 weeks)</span></div>
      <div class="tile"><b>${streak} day${streak === 1 ? "" : "s"}</b><span>practice streak</span></div>
      <div class="tile"><b>${f1(hrs(mine))} h</b><span>total, ${mine.length} bookings</span></div>
      <div class="tile"><b>${mine.length ? f1(hrs(mine) / mine.length) : 0} h</b><span>average booking</span></div>
    </div>
    <div class="list chart" style="padding:10px"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Your hours per week, last 12 weeks">${bars}</svg>
      <p class="sub">Hours per week, last 12 weeks</p></div>
    <h2>Bookings per person</h2>
    <div class="tablewrap"><table>
      <tr><th>Name</th><th>Month</th><th>3 mo</th><th>6 mo</th><th>Year</th><th>Total</th><th>Avg/mo</th></tr>
      ${rows.map(r => `<tr><td>${r.n.toLowerCase() === me ? `<span class="me">${esc(r.n)}</span>` : esc(r.n)}</td><td>${r.m1}</td><td>${r.m3}</td><td>${r.m6}</td><td>${r.y1}</td><td>${r.all}</td><td>${f1(r.avg)}</td></tr>`).join("")}
    </table></div>
    <p class="sub">History from ${history.ev.length ? new Date(Math.min(...history.ev.map(x => x[0]))).toLocaleDateString() : "—"} · updated ${new Date(history.fetched).toLocaleString()} · <button class="link" id="hreload">Reload history</button></p>`;
}
async function renderStats(force) {
  app.innerHTML = `<h1>Stats</h1><div class="list"><div class="empty">Loading booking history…</div></div>`;
  try { await loadHistory(force); } catch (e) { app.innerHTML = `<h1>Stats</h1><div class="list"><div class="empty">${esc(e.message)}</div></div>`; return; }
  if (tab !== "stats") return;
  app.innerHTML = `<h1>Stats</h1>${statsHtml()}`;
  $("#hreload").onclick = () => renderStats(true);
}

/* ---------- People tab (known list, shared with the alerts via GitHub) ---------- */
async function gh(path, method = "GET", body) {
  const r = await fetch(`https://api.github.com/repos/${REPO}${path}`, { method, body: body ? JSON.stringify(body) : undefined,
    headers: { Authorization: `Bearer ${S.ghToken}`, Accept: "application/vnd.github+json" } });
  if (!r.ok && r.status !== 404) throw new Error(`GitHub error ${r.status}. Check the GitHub token in Settings.`);
  return r.status === 404 ? null : r.status === 204 ? {} : r.json().catch(() => ({}));
}
async function loadKnown() {
  if (!S.ghToken) return;
  const v = await gh("/actions/variables/KNOWN_PEOPLE");
  if (v?.value) { try { known = JSON.parse(v.value); store.set("known", known); } catch {} }
}
async function saveKnown() {
  store.set("known", known);
  if (!S.ghToken) return "Saved on this device only. Add a GitHub token in Settings so alerts use this list.";
  const body = { name: "KNOWN_PEOPLE", value: JSON.stringify(known) };
  const r = await gh("/actions/variables/KNOWN_PEOPLE", "PATCH", body);
  if (r === null) await gh("/actions/variables", "POST", body);
  return "Saved";
}
async function renderPeople() {
  app.innerHTML = `<h1>People</h1><div class="list"><div class="empty">Loading…</div></div>`;
  try { await loadKnown(); } catch (e) { toast(e.message); }
  try { await loadHistory(false); } catch {}
  if (tab !== "people") return;
  const km = knownMap(), counts = new Map(); let noname = 0;
  for (const x of history?.ev || []) {
    if (!x[2]) { noname++; continue; }
    if (km.has(x[2].toLowerCase()) || x[2].toLowerCase() === S.myName.toLowerCase()) continue;
    counts.set(x[2], (counts.get(x[2]) || 0) + 1);
  }
  const unknown = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  app.innerHTML = `
    <h1>People</h1>
    <p class="sub">You get an alert when someone not on this list books, or when a booking has no name. Write "Anna K = Anna" to count two spellings as one person.</p>
    <h2>Known people (${known.length})</h2>
    <div class="list">${known.length ? known.map((k, i) => `<div class="row"><span>${esc(k)}</span><button class="link danger" data-rm="${i}">Remove</button></div>`).join("") : `<div class="empty">Nobody yet. Add the regulars below.</div>`}</div>
    <div class="inline"><input id="p-new" placeholder="Name as it appears in TeamUp" autocomplete="off"><button class="primary" id="p-add" style="flex:0 0 auto">Add</button></div>
    <h2>Seen in bookings, not on your list</h2>
    <div class="list">${unknown.length ? unknown.map(([n, c]) => `<div class="row"><span>${esc(n)} <span class="t">${c}×</span></span><button data-add="${esc(n)}">Add</button></div>`).join("") : `<div class="empty">Everyone who has booked is on your list.</div>`}
      ${noname ? `<div class="row"><span><span class="pill noname">No name</span></span><span class="t">${noname}×</span></div>` : ""}</div>`;
  const save = async () => { try { toast(await saveKnown()); } catch (e) { toast(e.message); } renderPeople(); };
  app.querySelectorAll("[data-rm]").forEach(b => b.onclick = () => { known.splice(Number(b.dataset.rm), 1); save(); });
  app.querySelectorAll("[data-add]").forEach(b => b.onclick = () => { known.push(b.dataset.add); save(); });
  $("#p-add").onclick = () => { const v = $("#p-new").value.trim(); if (v) { known.push(v); save(); } };
}

/* ---------- Settings ---------- */
function renderSettings(first) {
  $("#nav").hidden = !!first;
  app.innerHTML = `
    <h1>${first ? "Set up Music room" : "Settings"}</h1>
    ${first ? `<p class="sub">This is stored only on this device. You only do it once per phone or tablet.</p>` : ""}
    <div class="form">
      <label>TeamUp API key<input id="s-key" value="${esc(S.teamupKey)}" autocomplete="off" spellcheck="false"></label>
      <label>TeamUp link (the one you use to book)<input id="s-cal" value="${S.calendarKey ? "https://teamup.com/" + esc(S.calendarKey) : ""}" placeholder="https://teamup.com/ks…" autocomplete="off" spellcheck="false"></label>
      <label>Your name on bookings<input id="s-name" value="${esc(S.myName)}"></label>
      <label>Book into<select id="s-sub"><option value="">Tap "Load calendars" first</option></select></label>
      <button id="s-load">Load calendars</button>
      <label>GitHub token (optional, lets the People list reach your alerts)<input id="s-gh" value="${esc(S.ghToken)}" autocomplete="off" spellcheck="false"></label>
      <button class="primary" id="s-save">Save</button>
    </div>`;
  const read = () => {
    const cal = $("#s-cal").value.trim().replace(/^https?:\/\/(www\.)?teamup\.com\//, "").split(/[/?#]/)[0];
    return { teamupKey: $("#s-key").value.trim(), calendarKey: cal, myName: $("#s-name").value.trim() || "Ronny",
      subcalId: $("#s-sub").value, ghToken: $("#s-gh").value.trim() };
  };
  const loadRooms = async () => {
    const prev = S; S = { ...S, ...read() };
    try {
      await loadSubcals();
      const subs = S.subcals.filter(c => !c.readonly);
      $("#s-sub").innerHTML = subs.map(c => `<option value="${c.id}" ${String(c.id) === String(S.subcalId) ? "selected" : ""}>${esc(c.name)}</option>`).join("");
      prev.subcals = S.subcals; if (!prev.subcalId) prev.subcalId = S.subcalId;
    } catch (e) { toast(e.message); }
    S = prev;
  };
  $("#s-load").onclick = loadRooms;
  if (S.teamupKey && S.calendarKey) loadRooms();
  $("#s-save").onclick = () => {
    const n = read(); if (!n.teamupKey || !n.calendarKey) return toast("Fill in the API key and the TeamUp link.");
    S = { ...n, subcals: S.subcals || [] }; store.set("settings", S); history = null; store.set("history", null);
    $("#nav").hidden = false; switchTab("now");
  };
}

/* ---------- tabs ---------- */
function render() {
  if (tab === "now") renderNow();
  renderConfirm();
}
function switchTab(t) {
  tab = t; store.set("tab", t);
  document.querySelectorAll("nav button").forEach(b => b.setAttribute("aria-current", b.dataset.tab === t ? "page" : "false"));
  if (t === "now") refresh();
  if (t === "stats") renderStats(false);
  if (t === "people") renderPeople();
}
document.querySelectorAll("nav button").forEach(b => b.onclick = () => switchTab(b.dataset.tab));
document.addEventListener("visibilitychange", () => { if (!document.hidden && tab === "now" && S.teamupKey) refresh(); });
setInterval(() => { if (!document.hidden && tab === "now" && S.teamupKey && !pending) refresh(); }, 60000);

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
if (!S.teamupKey || !S.calendarKey) renderSettings(true);
else { $("#nav").hidden = false; loadKnown().catch(() => {});
  (S.subcals?.length ? Promise.resolve() : loadSubcals()).catch(() => {}).finally(() => switchTab(tab)); }
