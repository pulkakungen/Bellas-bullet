"use strict";

/* =========================================================
   BELLAS BULLET – digital bullet journal
   Data: localStorage + synk via egen Cloudflare Worker (../worker).
   Google Kalender läses bara, inget skrivs dit.
   ========================================================= */

const DEFAULT_WORKER_URL = "https://bellas-bullet.bella-sassibrass.workers.dev";
const GCAL_SCOPE = "https://www.googleapis.com/auth/calendar.readonly";
// Bellas eget OAuth-klient-ID (projektet "bellas bullet" i Google Cloud). Inte hemligt.
const DEFAULT_GCAL_CLIENT_ID = "400889692963-6f538f6tr3ek5l0v8q66af0qpik0pae6.apps.googleusercontent.com";

const STATE_KEY = "bullet_state_v1";
const LOCAL_KEY = "bullet_local_v1"; // bara den här enheten: synknyckel, Google-token

const STEP_GOAL = 12000;
const WORKOUT_GOAL = 2;
const WATER_GOAL = 8;
const WORKOUT_TYPES = { complete: "Complete", styrka: "Styrka", cardio: "Cardio" };

const MAPS = ["entries", "collections", "routines", "zones", "done", "days", "weeks", "workouts", "birthdays", "habits", "meals", "foods", "meta"];

/* ---------------- Datum ---------------- */

const pad = (n) => String(n).padStart(2, "0");
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseYmd = (s) => {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d || 1);
};
const today = () => ymd(new Date());
const addDays = (s, n) => {
  const d = parseYmd(s);
  d.setDate(d.getDate() + n);
  return ymd(d);
};
const addMonths = (ym, n) => {
  const d = parseYmd(ym + "-01");
  d.setMonth(d.getMonth() + n);
  return ymd(d).slice(0, 7);
};
const daysBetween = (a, b) => Math.round((parseYmd(b) - parseYmd(a)) / 864e5);
const weekStart = (s) => addDays(s, -((parseYmd(s).getDay() + 6) % 7));
const daysInMonth = (ym) => new Date(+ym.slice(0, 4), +ym.slice(5, 7), 0).getDate();
function isoWeek(s) {
  const d = parseYmd(s);
  d.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7));
  const jan4 = new Date(d.getFullYear(), 0, 4);
  return 1 + Math.round(((d - jan4) / 864e5 - 3 + ((jan4.getDay() + 6) % 7)) / 7);
}

const WD = ["sön", "mån", "tis", "ons", "tor", "fre", "lör"];
const WD_LONG = ["söndag", "måndag", "tisdag", "onsdag", "torsdag", "fredag", "lördag"];
const MONTHS = ["januari", "februari", "mars", "april", "maj", "juni", "juli", "augusti", "september", "oktober", "november", "december"];
const monthName = (ym) => MONTHS[+ym.slice(5, 7) - 1];
const niceDate = (s) => `${+s.slice(8, 10)} ${monthName(s.slice(0, 7))}`;

/* ---------------- State ---------------- */

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const emptyState = () => Object.fromEntries([["v", 1], ...MAPS.map((m) => [m, {}])]);

function loadJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (e) {
    return fallback;
  }
}

let state = loadJSON(STATE_KEY, null);
const local = loadJSON(LOCAL_KEY, {});
const workerUrl = () => (local.workerUrl || DEFAULT_WORKER_URL).replace(/\/$/, "");
if (!state) state = emptyState();
for (const m of MAPS) state[m] = state[m] || {};

function persist() {
  try {
    localStorage.setItem(STATE_KEY, JSON.stringify(state));
  } catch (e) {}
}
function saveLocal() {
  try {
    localStorage.setItem(LOCAL_KEY, JSON.stringify(local));
  } catch (e) {}
}

function put(map, rec) {
  state[map][rec.id] = { ...rec, u: Date.now() };
  persist();
  scheduleSync();
}
function remove(map, id) {
  if (state[map][id]) put(map, { id, del: true });
}
const live = (map) => Object.values(state[map]).filter((r) => r && !r.del);
const get = (map, id) => {
  const r = state[map][id];
  return r && !r.del ? r : null;
};
const settings = () => get("meta", "settings") || { id: "settings" };

function mergeStates(a, b) {
  const out = emptyState();
  for (const m of MAPS) {
    const A = a[m] || {};
    const B = b[m] || {};
    for (const id of new Set([...Object.keys(A), ...Object.keys(B)])) {
      const x = A[id];
      const y = B[id];
      out[m][id] = !x ? y : !y ? x : (y.u || 0) > (x.u || 0) ? y : x;
    }
  }
  return out;
}

// Appen startar tom. Brain dump finns alltid, utan att behöva skapas.
const BRAINDUMP = { id: "c-braindump", name: "Brain dump", note: true };
const getColl = (id) => get("collections", id) || (id === BRAINDUMP.id ? BRAINDUMP : null);

// Bellas städspecialer, läggs in med en knapp under Rutiner.
// Fasta id:n: läggs aldrig in dubbelt, och det du ändrat skrivs inte över.
const STADSPECIALER = {
  routines: [
    ["dammsuga-trappor", "Dammsuga trapporna", 7],
    ["dammsuga-horn", "Dammsuga hörn och lister", 14],
    ["dammsuga-under", "Dammsuga under soffa och säng", 14],
    ["dammsuga-kallare", "Dammsuga källaren", 14],
    ["robot", "Tömma och rengöra robotdammsugaren", 7],
    ["vattorka", "Våttorka golven", 14],
    ["lakan", "Byta lakan", 14],
    ["tvatt", "Tvätta", 4],
    ["kokbank", "Torka av köksbänkarna", 1],
    ["badrum", "Städa badrummet", 7],
    ["blommor", "Vattna blommorna", 7]
  ],
  zones: [
    ["kok", "Kök", ["Torka luckor och handtag", "Rengör spis och ugn", "Rensa skafferiet"]],
    ["badrum", "Badrum", ["Skura kakel och fogar", "Rensa avloppet", "Rensa skåpen"]],
    ["sovrum", "Sovrum", ["Rensa garderoben", "Dammsug under sängen", "Gå igenom byrån"]],
    ["vardagsrum", "Vardagsrum och hall", ["Damma hyllor", "Skor och ytterkläder", "Fönsterbrädor"]],
    ["tvattstuga", "Tvättstuga", ["Sopa", "Plocka undan", "Mangla", "Stryka"]],
    ["matkallare", "Matkällaren", ["Inventera", "Rensa gammalt", "Sopa golvet"]]
  ]
};
// Ersatta av mer precisa sysslor. Tas bort om de aldrig bockats av.
const RETIRED_SPECIALS = ["r-dammsuga"];
const everDone = (id) => live("done").some((d) => d.id.startsWith(id + "|"));
const missingSpecials = () =>
  RETIRED_SPECIALS.filter((id) => get("routines", id) && !everDone(id)).length +
  STADSPECIALER.routines.filter(([id]) => !get("routines", "r-" + id)).length + STADSPECIALER.zones.filter(([id]) => !get("zones", "z-" + id)).length;

function addSpecials() {
  RETIRED_SPECIALS.forEach((id) => {
    if (get("routines", id) && !everDone(id)) remove("routines", id);
  });
  STADSPECIALER.routines.forEach(([id, name, every]) => {
    if (!get("routines", "r-" + id)) put("routines", { id: "r-" + id, name, cat: "hem", mode: "interval", every, since: today() });
  });
  const base = live("zones").length;
  STADSPECIALER.zones.forEach(([id, name, tasks], i) => {
    if (!get("zones", "z-" + id)) put("zones", { id: "z-" + id, name, tasks, order: base + i });
  });
}

// Bellas hudvårdsrutin (kväll), en variant per veckodag. 0 = söndag.
const BASE = ["Vitamin C Cleansing Balm", "Nivea Cleansing Cream Caring"];
const EYES = ["The Ordinary Volufiline", "Biovène Hyaluronic Eye Filler", "Xlash Pro Eyelash Serum"];
const LUMENE = "Lumene Nordic Hydra Aqua Lumenessence Beauty Lotion";
const Q10 = "Cien Q10 Night Mask";
const GLOW = "Lumene Nordic-C Glow Moisturizer";
const SKINCARE_PRESET = {
  1: [...BASE, LUMENE, "COSRX Snail 96 Mucin", ...EYES, Q10],
  2: [...BASE, LUMENE, "Elizabeth Arden Ceramide Capsules Daily Youth", ...EYES, GLOW],
  3: [...BASE, "The Ordinary Glycolic Acid 7%", "The Ordinary Niacinamide 10% + Zinc", ...EYES, Q10],
  4: [...BASE, LUMENE, "The Ordinary Hyaluronic Acid 2% + B5", ...EYES, GLOW],
  5: [...BASE, "Ikzee Kojic Acid & Turmeric Cleansing Pads", "Elizabeth Arden Ceramide Capsules Face & Eyes", ...EYES, Q10],
  6: [...BASE, LUMENE, "COSRX Snail 96 Mucin", ...EYES, GLOW],
  0: [...BASE, LUMENE, "Elizabeth Arden Ceramide Capsules Daily Youth", ...EYES, Q10]
};
const skincare = () => get("meta", "skincare");
const skinStepsOn = (date) => (skincare()?.days?.[parseYmd(date).getDay()] || []);
const skinKey = (step) => "sk:" + step;
function skinStatus(date) {
  const steps = skinStepsOn(date);
  const done = steps.filter((st) => isDone(skinKey(st), date)).length;
  return { steps, done, all: steps.length > 0 && done === steps.length };
}

/* ---------------- Hjälpare ---------------- */

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const $ = (sel) => document.querySelector(sel);

let toastTimer;
function toast(msg) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2400);
}

/* ---------------- Symbolerna (din nyckel) ---------------- */

function sym(kind) {
  const box = '<rect x="2.5" y="2.5" width="15" height="15" rx="1.2"/>';
  const svg = (inner) => `<svg viewBox="0 0 20 20" class="sym-svg" aria-hidden="true">${inner}</svg>`;
  switch (kind) {
    case "open":
      return svg(box);
    case "done":
      return svg(
        box +
          '<g class="hatch"><path d="M2.5 8.5 8.5 2.5M2.5 13.5 13.5 2.5M2.5 17.5 17.5 2.5M6.5 17.5 17.5 6.5M11.5 17.5 17.5 11.5"/></g>'
      );
    case "started":
      return svg(box + '<path d="M2.5 17.5 17.5 2.5"/>');
    case "migrated":
      return svg(box + '<path d="M2.5 2.5 17.5 10 2.5 17.5"/>');
    case "struck":
      return svg(box + '<path d="M2.5 10H17.5"/>');
    case "event":
      return svg('<circle cx="10" cy="10" r="5.5"/>');
    case "meeting":
      return svg('<path d="M10 4 16.5 16H3.5Z"/>');
    case "note":
      return svg('<circle cx="10" cy="10" r="1.8" class="fill"/>');
    case "birthday":
      return svg('<path d="M3.5 17.5h13M4.5 17.5v-6h11v6M4.5 14c1.8 1.2 3.7 1.2 5.5 0s3.7-1.2 5.5 0M10 11.5V8.5"/><path d="M10 4c1.2 1.3 1.2 2.6 0 3.3-1.2-.7-1.2-2 0-3.3Z" class="fill"/>');
  }
  return "";
}
const SIG_LABEL = { "!": "Deadline", "*": "Viktigt", "?": "Kolla upp" };
const STATUS_LABEL = { open: "Uppgift", done: "Klar", started: "Påbörjad", migrated: "Framflyttad", struck: "Struken" };
const TYPE_LABEL = { task: "Uppgift", event: "Event", meeting: "Möte", note: "Notering" };
const entrySym = (e) => sym(e.type === "task" ? e.status : e.type);

/* ---------------- Poster ---------------- */

function entriesWhere(pred) {
  return live("entries")
    .filter(pred)
    .sort((a, b) => (a.time || "99") .localeCompare(b.time || "99") || (a.order || 0) - (b.order || 0));
}
const entriesOn = (date) => entriesWhere((e) => e.date === date && !e.parent);
const childrenOf = (id) => entriesWhere((e) => e.parent === id);

// Snabbskrivning: "o " event, "m " möte, ". " eller "- " notering,
// "! " "* " "? " signifiers och "14:00 " tid, i valfri ordning först på raden.
function parseQuick(raw, preset) {
  let s = raw.trim();
  let type = preset.type || "task";
  let sig = preset.sig || "";
  let time = "";
  for (let i = 0; i < 4; i++) {
    let m;
    if ((m = s.match(/^(o|○)\s+/i))) type = "event";
    else if ((m = s.match(/^(m|△|\^)\s+/i))) type = "meeting";
    else if ((m = s.match(/^(\.|·|-|–|~)\s+/))) type = "note";
    else if ((m = s.match(/^([!*?])\s*/))) sig = m[1];
    else if ((m = s.match(/^(\d{1,2})[:.](\d{2})\s+/))) time = `${pad(Math.min(23, +m[1]))}:${m[2]}`;
    else break;
    s = s.slice(m[0].length);
  }
  return { type, sig, time, text: s.trim() };
}

// Kvällsplanering: "imorgon", "fre", "12/10", "2026-10-12", "nov", "v 42"
// först på raden avgör vart raden hamnar. Utan datum: imorgon.
const WD_ALIASES = { sön: 0, söndag: 0, mån: 1, måndag: 1, tis: 2, tisdag: 2, ons: 3, onsdag: 3, tor: 4, tors: 4, torsdag: 4, fre: 5, fredag: 5, lör: 6, lördag: 6 };
const MONTH_ALIASES = Object.fromEntries(MONTHS.flatMap((m, i) => [[m, i + 1], [m.slice(0, 3), i + 1]]));

function parseWhen(raw, base = today()) {
  const s = raw.trim();
  const tomorrow = addDays(base, 1);
  let m;
  const word = (s.match(/^(\S+)\s+/) || [])[1]?.toLowerCase().replace(/[.,:]$/, "");
  const rest = (n) => s.slice(n).trim();
  if (word === "idag") return { scope: { date: base }, rest: rest(word.length) };
  if (word === "imorgon") return { scope: { date: tomorrow }, rest: rest(word.length) };
  if (word === "övermorgon") return { scope: { date: addDays(base, 2) }, rest: rest(word.length) };
  if (word && word in WD_ALIASES) {
    let d = addDays(base, 1);
    while (parseYmd(d).getDay() !== WD_ALIASES[word]) d = addDays(d, 1);
    return { scope: { date: d }, rest: rest(s.indexOf(" ")) };
  }
  if ((m = s.match(/^(\d{4})-(\d{2})-(\d{2})\s+/))) return { scope: { date: `${m[1]}-${m[2]}-${m[3]}` }, rest: rest(m[0].length) };
  if ((m = s.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\s+/))) {
    let y = m[3] ? +(m[3].length === 2 ? "20" + m[3] : m[3]) : +base.slice(0, 4);
    let d = `${y}-${pad(+m[2])}-${pad(+m[1])}`;
    if (!m[3] && d < base) d = `${y + 1}-${pad(+m[2])}-${pad(+m[1])}`;
    return { scope: { date: d }, rest: rest(m[0].length) };
  }
  if ((m = s.match(/^v\.?\s?(\d{1,2})\s+/i))) {
    // måndagen i vecka n, i år eller nästa år om den redan passerat
    for (const y of [+base.slice(0, 4), +base.slice(0, 4) + 1]) {
      let d = weekStart(`${y}-01-04`);
      d = addDays(d, (+m[1] - 1) * 7);
      if (d >= weekStart(base)) return { scope: { date: d }, rest: rest(m[0].length) };
    }
  }
  if (word && word in MONTH_ALIASES) {
    let ym = `${base.slice(0, 4)}-${pad(MONTH_ALIASES[word])}`;
    if (ym < base.slice(0, 7)) ym = `${+base.slice(0, 4) + 1}-${pad(MONTH_ALIASES[word])}`;
    return { scope: { month: ym }, rest: rest(s.indexOf(" ")) };
  }
  return { scope: { date: tomorrow }, rest: s };
}
const whereLabel = (scope) => (scope.date ? `${WD_LONG[parseYmd(scope.date).getDay()]} ${niceDate(scope.date)}` : `${monthName(scope.month)} ${scope.month.slice(0, 4)}`);

function addEntry(scope, raw, preset = {}) {
  const p = parseQuick(raw, preset);
  if (!p.text) return;
  const e = { id: uid(), type: p.type, text: p.text, sig: p.sig, status: "open", order: Date.now(), ...scope };
  if (p.time) e.time = p.time;
  put("entries", e);
  return e;
}

function moveEntry(e, target) {
  put("entries", { ...e, status: "migrated" });
  const copy = { id: uid(), type: e.type, text: e.text, sig: e.sig, status: e.status === "started" ? "started" : "open", order: Date.now(), from: e.id, ...target };
  if (target.date && e.time) copy.time = e.time;
  put("entries", copy);
  for (const child of childrenOf(e.id)) {
    if (child.status === "open" || child.status === "started") {
      put("entries", { ...child, status: "migrated" });
      put("entries", { id: uid(), type: child.type, text: child.text, sig: child.sig, status: child.status, order: child.order, parent: copy.id, ...target });
    }
  }
}

function cycleStatus(e) {
  if (e.type !== "task") return;
  const next = { open: "started", started: "done", done: "open", migrated: "open", struck: "open" }[e.status] || "open";
  put("entries", { ...e, status: next });
  if (e.routine && next === "done") setDone(e.routine, e.date, true);
}

// Öppna uppgifter från tidigare dagar och passerade månader.
function openBacklog() {
  const t = today();
  const m = t.slice(0, 7);
  return entriesWhere(
    (e) => !e.parent && e.type === "task" && (e.status === "open" || e.status === "started") && ((e.date && e.date < t) || (e.month && e.month < m))
  );
}

/* ---------------- Rutiner, zoner, träning ---------------- */

const doneKey = (id, date) => `${id}|${date}`;
const isDone = (id, date) => !!get("done", doneKey(id, date));
function setDone(id, date, on) {
  if (on) put("done", { id: doneKey(id, date) });
  else remove("done", doneKey(id, date));
}
function lastDone(id, before) {
  let last = null;
  for (const r of live("done")) {
    const [rid, date] = r.id.split("|");
    if (rid === id && date <= before && (!last || date > last)) last = date;
  }
  return last;
}

function routineInfo(r, date) {
  const done = isDone(r.id, date);
  if (r.mode === "weekday") {
    return { r, done, due: parseYmd(date).getDay() === r.weekday, score: 99, label: WD_LONG[r.weekday] + "ar" };
  }
  const last = lastDone(r.id, done ? addDays(date, -1) : date);
  if (!last) {
    // Aldrig gjord: sprid ut första gången över intervallet, räknat från när
    // rutinen lades in, så inte allt blir förfallet samma dag.
    const first = firstDue(r);
    const wait = daysBetween(date, first);
    const due = wait <= 0;
    return { r, done, due, since: null, score: due ? 1 + -wait / r.every : 0, label: due ? "första gången" : `första gången om ${wait} ${wait === 1 ? "dag" : "dagar"}` };
  }
  const since = daysBetween(last, date);
  const due = since >= r.every;
  let label = `senast för ${since} ${since === 1 ? "dag" : "dagar"} sedan`;
  if (since > r.every) label += `, ${since - r.every} över`;
  return { r, done, due, since, score: since / r.every, label };
}

// Första dagen för en rutin som aldrig gjorts: startdagen plus en fast
// förskjutning inom intervallet (samma på alla enheter, räknad från id:t).
function firstDue(r) {
  const start = r.since || (r.u > 1 ? ymd(new Date(r.u)) : today());
  if (r.every <= 1) return start;
  let h = 0;
  for (const ch of r.id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return addDays(start, h % r.every);
}

function zoneForWeek(date) {
  const zones = live("zones").sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.id.localeCompare(b.id));
  if (!zones.length) return null;
  const weeks = Math.floor(daysBetween("2024-01-01", weekStart(date)) / 7);
  return zones[((weeks % zones.length) + zones.length) % zones.length];
}
const zoneKey = (zone, task) => `z:${zone.id}:${task}`;

// Händelser från Google för en dag: utan det du dolt, och med dubbletter
// (samma titel samma dag) ihopslagna, där den med klockslag vinner.
const gcalKey = (e) => `${e.t}|${e.s}`;
const normTitle = (t) => String(t || "").trim().toLowerCase();
function gcalEventsOn(date) {
  const cache = get("meta", "gcal");
  if (!cache || !Array.isArray(cache.events)) return [];
  const s = settings();
  const hiddenKeys = new Set(s.gcalHiddenKeys || []);
  const hiddenTitles = new Set((s.gcalHiddenTitles || []).map(normTitle));
  const byTitle = new Map();
  for (const e of cache.events) {
    if (!(e.sd <= date && date <= e.ed)) continue;
    if (hiddenKeys.has(gcalKey(e)) || hiddenTitles.has(normTitle(e.t))) continue;
    const k = normTitle(e.t);
    const prev = byTitle.get(k);
    if (!prev || (prev.ad && !e.ad)) byTitle.set(k, e);
  }
  return [...byTitle.values()].sort((a, b) => (a.ad === b.ad ? a.s.localeCompare(b.s) : a.ad ? -1 : 1));
}

// Hur full är dagen? Styr hur många sysslor appen föreslår.
function busyMinutes(date) {
  let min = 0;
  for (const e of gcalEventsOn(date)) {
    if (e.ad) continue;
    const s = new Date(e.s);
    const en = new Date(e.e);
    const dayStart = parseYmd(date);
    const dayEnd = parseYmd(addDays(date, 1));
    min += Math.max(0, (Math.min(en, dayEnd) - Math.max(s, dayStart)) / 6e4);
  }
  min += entriesOn(date).filter((e) => (e.type === "meeting" || e.type === "event") && e.time).length * 60;
  return min;
}
// Tak för sysslor per dag: ditt tak för vardag eller helg, och lägre om
// kalendern är full. Dagliga sysslor räknas inte in.
const DEFAULT_CHORES = { weekday: 1, weekend: 3 };
function choreCap(date) {
  const wd = parseYmd(date).getDay();
  const s = settings();
  return wd === 0 || wd === 6 ? s.choresWeekend ?? DEFAULT_CHORES.weekend : s.choresWeekday ?? DEFAULT_CHORES.weekday;
}
// Ingen städning idag: sjuk, eller om du valt att hoppa över dagen.
const choresOff = (date) => isSick(date) || !!dayRec(date).skipChores;
function choreLimit(date) {
  if (choresOff(date)) return 0;
  const b = busyMinutes(date);
  const byCalendar = b >= 360 ? 0 : b >= 180 ? 1 : b >= 60 ? 2 : 5;
  return Math.min(choreCap(date), byCalendar);
}

const workoutsIn = (from, to) => live("workouts").filter((w) => w.date >= from && w.date <= to);
const weekWorkouts = (date) => workoutsIn(weekStart(date), addDays(weekStart(date), 6));
const dayRec = (date) => get("days", date) || { id: date };
// Hälsa: "krasslig" påverkar träningen, "sjuk" även sysslorna.
const health = (date) => {
  const r = dayRec(date);
  return r.health || (r.sick ? "sjuk" : null);
};
const isSick = (date) => health(date) === "sjuk";
// Veckans träningsmål sänks om du varit krasslig eller sjuk flera dagar.
function workoutGoal(date) {
  const start = weekStart(date);
  const poorly = Array.from({ length: 7 }, (_, i) => health(addDays(start, i))).filter(Boolean).length;
  return poorly >= 5 ? 0 : poorly >= 3 ? 1 : WORKOUT_GOAL;
}
const setDay = (date, patch) => put("days", { ...dayRec(date), ...patch, id: date });

function birthdaysOn(date) {
  return live("birthdays").filter((b) => b.md === date.slice(5));
}
const ageOn = (b, date) => (b.year ? +date.slice(0, 4) - b.year : null);

/* ---------------- Svenska helgdagar ---------------- */

const holidayCache = {};
function easter(y) {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4;
  const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  return `${y}-${pad(month)}-${pad(((h + l - 7 * m + 114) % 31) + 1)}`;
}
// Första dagen med given veckodag (0=sön) från och med ett datum.
const firstWeekday = (from, wd) => addDays(from, (wd - parseYmd(from).getDay() + 7) % 7);

function holidays(year) {
  if (holidayCache[year]) return holidayCache[year];
  const e = easter(year);
  const list = [
    [`${year}-01-01`, "Nyårsdagen", true],
    [`${year}-01-06`, "Trettondedag jul", true],
    [`${year}-02-14`, "Alla hjärtans dag", false],
    [addDays(e, -2), "Långfredagen", true],
    [addDays(e, -1), "Påskafton", false],
    [e, "Påskdagen", true],
    [addDays(e, 1), "Annandag påsk", true],
    [`${year}-04-30`, "Valborg", false],
    [`${year}-05-01`, "Första maj", true],
    [addDays(e, 39), "Kristi himmelfärd", true],
    [firstWeekday(`${year}-05-25`, 0), "Mors dag", false],
    [addDays(e, 49), "Pingstdagen", true],
    [`${year}-06-06`, "Nationaldagen", true],
    [firstWeekday(`${year}-06-19`, 5), "Midsommarafton", false],
    [firstWeekday(`${year}-06-20`, 6), "Midsommardagen", true],
    [firstWeekday(`${year}-10-31`, 6), "Alla helgons dag", true],
    [firstWeekday(`${year}-11-08`, 0), "Fars dag", false],
    [`${year}-12-13`, "Lucia", false],
    [`${year}-12-24`, "Julafton", false],
    [`${year}-12-25`, "Juldagen", true],
    [`${year}-12-26`, "Annandag jul", true],
    [`${year}-12-31`, "Nyårsafton", false]
  ].map(([date, name, red]) => ({ date, name, red }));
  // första advent: söndagen 27 november till 3 december
  list.push({ date: firstWeekday(`${year}-11-27`, 0), name: "Första advent", red: false });
  return (holidayCache[year] = list.sort((a, b) => a.date.localeCompare(b.date)));
}
const holidaysOn = (date) => holidays(+date.slice(0, 4)).filter((h) => h.date === date);
const isRedDay = (date) => parseYmd(date).getDay() === 0 || holidaysOn(date).some((h) => h.red);
const holidayRow = (h) =>
  `<li class="entry ty-holiday"><span class="sig"></span><span class="sym static">${sym("event")}</span><span class="e-text ${h.red ? "red" : ""}">${esc(h.name)}</span></li>`;

/* ---------------- Routing ---------------- */

function route() {
  const [view, arg] = location.hash.replace(/^#\/?/, "").split("/");
  return { view: view || "day", arg };
}
function go(hash) {
  location.hash = hash;
}

let showAllChores = false;

function render() {
  const { view, arg } = route();
  const t = today();
  const views = {
    day: () => viewDay(arg || t),
    week: () => viewWeek(weekStart(arg || t)),
    month: () => viewMonth(arg || t.slice(0, 7)),
    future: () => viewFuture(+(arg || t.slice(0, 4))),
    gratitude: () => viewGratitude(),
    weight: () => viewWeight(arg || "90"),
    kvall: () => viewEvening(),
    index: () => viewIndex(),
    coll: () => viewCollection(arg),
    tracker: () => viewTracker(arg || t.slice(0, 7)),
    routines: () => viewRoutines(),
    birthdays: () => viewBirthdays(),
    key: () => viewKey(),
    settings: () => viewSettings()
  };
  const app = $("#app");
  const pageArg = { day: arg || t, week: weekStart(arg || t), month: arg || t.slice(0, 7) }[view] || arg || "";
  app.innerHTML = (views[view] || views.day)() + `<span class="page-no">${pageNumber(view, pageArg)}</span>`;
  if (turnDir) {
    app.classList.remove("turn-next", "turn-prev");
    void app.offsetWidth;
    app.classList.add(turnDir > 0 ? "turn-next" : "turn-prev");
    turnDir = 0;
  }
  const tab = { day: "day", week: "week", month: "month", future: "future" }[view] || "index";
  document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
}

/* ---------------- Boken: sidor i ordning ---------------- */
// Som i en pappersbok: varje månad börjar med sitt uppslag, varje måndag
// föregås av en veckosida, sedan en sida per dag.
// Index (1), Nyckel (2) och Framtidslogg (3) ligger först.

const isMonday = (d) => parseYmd(d).getDay() === 1;
const lastOfMonth = (ym) => `${ym}-${pad(daysInMonth(ym))}`;

function nextPage(view, arg) {
  if (view === "month") {
    const first = `${arg}-01`;
    return isMonday(first) ? `week/${first}` : `day/${first}`;
  }
  if (view === "week") return `day/${arg}`;
  const nd = addDays(arg, 1);
  if (nd.slice(0, 7) !== arg.slice(0, 7)) return `month/${nd.slice(0, 7)}`;
  return isMonday(nd) ? `week/${nd}` : `day/${nd}`;
}

function prevPage(view, arg) {
  if (view === "month") return `day/${lastOfMonth(addMonths(arg, -1))}`;
  if (view === "week") return arg.slice(8) === "01" ? `month/${arg.slice(0, 7)}` : `day/${addDays(arg, -1)}`;
  if (isMonday(arg)) return `week/${arg}`;
  return arg.slice(8) === "01" ? `month/${arg.slice(0, 7)}` : `day/${addDays(arg, -1)}`;
}

// Antal måndagar från 1 januari till och med datumet.
function mondaysThrough(d) {
  const jan1 = `${d.slice(0, 4)}-01-01`;
  const firstMon = firstWeekday(jan1, 1);
  return firstMon > d ? 0 : Math.floor(daysBetween(firstMon, d) / 7) + 1;
}

function pageNumber(view, arg) {
  const doy = (d) => daysBetween(`${d.slice(0, 4)}-01-01`, d) + 1;
  if (view === "day") return 3 + +arg.slice(5, 7) + mondaysThrough(arg) + doy(arg);
  if (view === "week") return 3 + +arg.slice(5, 7) + mondaysThrough(arg) + doy(arg) - 1;
  if (view === "month") {
    const before = arg.slice(5, 7) === "01" ? null : lastOfMonth(addMonths(arg, -1));
    return 3 + +arg.slice(5, 7) + (before ? mondaysThrough(before) + doy(before) : 0);
  }
  return { index: 1, key: 2, future: 3 }[view] || "";
}

// Svep åt sidan för att bläddra, som i en bok.
let turnDir = 0;
let touchStart = null;
document.addEventListener("touchstart", (e) => {
  if (e.touches.length !== 1 || e.target.closest("input, textarea, .tracker-scroll, dialog")) return (touchStart = null);
  touchStart = { x: e.touches[0].clientX, y: e.touches[0].clientY, t: Date.now() };
}, { passive: true });
document.addEventListener("touchend", (e) => {
  if (!touchStart) return;
  const dx = e.changedTouches[0].clientX - touchStart.x;
  const dy = e.changedTouches[0].clientY - touchStart.y;
  const quick = Date.now() - touchStart.t < 600;
  touchStart = null;
  if (!quick || Math.abs(dx) < 70 || Math.abs(dy) > Math.abs(dx) * 0.6) return;
  const arrows = document.querySelectorAll("#app .nav-arrow");
  const target = dx < 0 ? arrows[arrows.length - 1] : arrows[0];
  if (target && target.getAttribute("href")) {
    turnDir = dx < 0 ? 1 : -1;
    location.hash = target.getAttribute("href");
  }
});
document.addEventListener("click", (e) => {
  const a = e.target.closest(".nav-arrow");
  if (a) turnDir = a === document.querySelectorAll("#app .nav-arrow")[0] ? -1 : 1;
}, true);

/* ---------------- Byggstenar ---------------- */

function head(eyebrow, title, prevHash, nextHash, extra = "") {
  return `<header class="page-head">
    ${prevHash ? `<a class="nav-arrow" href="#${prevHash}" aria-label="Föregående">‹</a>` : "<span></span>"}
    <div class="page-title"><div class="eyebrow">${eyebrow}</div><h1>${title}</h1>${extra}</div>
    ${nextHash ? `<a class="nav-arrow" href="#${nextHash}" aria-label="Nästa">›</a>` : "<span></span>"}
  </header>`;
}

function entryRow(e, opts = {}) {
  const time = e.time ? `<span class="e-time">${e.time}</span>` : "";
  const from = opts.showDate && e.date ? `<span class="e-from">${niceDate(e.date)}</span>` : "";
  return `<li class="entry ty-${e.type} st-${e.status}">
    <span class="sig" title="${SIG_LABEL[e.sig] || ""}">${esc(e.sig || "")}</span>
    <button class="sym" data-act="cycle" data-id="${e.id}" aria-label="${TYPE_LABEL[e.type]}: ${STATUS_LABEL[e.status] || ""}">${entrySym(e)}</button>
    <span class="e-text" data-act="entryMenu" data-id="${e.id}">${time}${esc(e.text)}${from}</span>
  </li>${opts.noChildren ? "" : childrenOf(e.id).map((c) => entryRow(c, { child: true })).join("")}`.replace('<li class="entry', `<li class="entry${opts.child ? " child" : ""}`);
}

function gcalRow(ev) {
  const time = ev.ad ? "" : `<span class="e-time">${ev.s.slice(11, 16)}</span>`;
  return `<li class="entry ty-event gcal"><span class="sig"></span><span class="sym static">${sym("event")}</span>
    <span class="e-text" data-act="gcalMenu" data-key="${esc(gcalKey(ev))}" data-title="${esc(ev.t)}">${time}${esc(ev.t)}<span class="e-from">Google</span></span></li>`;
}

function birthdayRow(b, date) {
  const age = ageOn(b, date);
  return `<li class="entry ty-birthday"><span class="sig"></span><span class="sym static">${sym("birthday")}</span>
    <span class="e-text" data-act="editBirthday" data-id="${b.id}">${esc(b.name)}${age !== null ? ` fyller ${age}` : " fyller år"}</span></li>`;
}

function logForm(scope, placeholder, defType = "task") {
  const s = Object.entries(scope).map(([k, v]) => `data-${k}="${esc(v)}"`).join(" ");
  return `<form class="log-form" data-form="log" ${s} autocomplete="off">
    <div class="chips" role="group" aria-label="Typ">
      ${[["task", "Uppgift", "open"], ["event", "Event", "event"], ["meeting", "Möte", "meeting"], ["note", "Notering", "note"]]
        .map(([v, label, icon]) => `<button type="button" class="chip ${v === defType ? "on" : ""}" data-chip="type" data-val="${v}" title="${label}">${sym(icon)}</button>`)
        .join("")}
      <span class="chip-sep"></span>
      <button type="button" class="chip txt" data-chip="sig" data-val="!" title="Deadline">!</button>
      <button type="button" class="chip txt" data-chip="sig" data-val="*" title="Viktigt">*</button>
      <button type="button" class="chip txt" data-chip="sig" data-val="?" title="Kolla upp">?</button>
    </div>
    <div class="log-input-row">
      <input name="text" type="text" placeholder="${placeholder}" enterkeyhint="done" />
      <button type="submit" class="btn-small">+</button>
    </div>
  </form>`;
}

const block = (title, body, cls = "") => `<section class="block ${cls}"><h2>${title}</h2>${body}</section>`;
const list = (rows, empty) => `<ul class="log">${rows.join("") || `<li class="empty">${empty}</li>`}</ul>`;

/* ---------------- Dag ---------------- */

function viewDay(date) {
  const t = today();
  const d = parseYmd(date);
  const backlog = date === t ? openBacklog() : [];
  const entries = entriesOn(date);
  const gcal = gcalEventsOn(date);
  const bdays = birthdaysOn(date);

  const work = dayRec(date).work;
  let html = `<header class="day-head" style="--tape:${tapeColor(date.slice(0, 7))}">
    <a class="nav-arrow" href="#${prevPage("day", date)}" aria-label="Föregående sida">‹</a>
    <div class="page-title">
      <div class="ribbon"><span>${niceDate(date)}</span></div>
      <div class="sign"><span>${WD_LONG[d.getDay()]}</span></div>
      <div class="eyebrow">vecka ${isoWeek(date)}${work ? " · " + esc(work) : ""}</div>
      ${date !== t ? `<a class="link-btn" href="#day/${t}">till idag</a>` : ""}
    </div>
    <a class="nav-arrow" href="#${nextPage("day", date)}" aria-label="Nästa sida">›</a>
  </header>`;

  if (date === t && new Date().getHours() >= 18) {
    html += `<div class="banner"><span>Dags att runda av dagen.</span><a class="btn-small" href="#kvall">Kvällsgenomgång</a></div>`;
  } else if (backlog.length) {
    html += `<div class="banner"><span>${backlog.length} öppna uppgifter från tidigare. Dags att migrera.</span>
      <button class="btn-small" data-act="migrate">Gå igenom</button></div>`;
  }

  const calRows = [...holidaysOn(date).map(holidayRow), ...bdays.map((b) => birthdayRow(b, date)), ...gcal.map(gcalRow)];
  if (calRows.length) html += block("Kalender", list(calRows, ""));

  html += block("Logg", list(entries.map((e) => entryRow(e)), "Tomt blad. Skriv nedan.") + logForm({ date }, "Skriv... (o event, m möte, . notering)"));

  const habits = live("habits").sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const skin = skinStatus(date);
  if (skin.steps.length) {
    html += block(
      "Hudvård",
      `<p class="hint">${WD_LONG[d.getDay()]}skväll · ${skin.all ? "klart för ikväll" : `${skin.done} av ${skin.steps.length} steg`}</p>
       <ol class="skin-steps">${skin.steps
         .map((st) => {
           const on = isDone(skinKey(st), date);
           return `<li class="${on ? "is-done" : ""}"><button class="check" data-act="toggleSkin" data-step="${esc(st)}" data-date="${date}" aria-label="Markera ${esc(st)}">${sym(on ? "done" : "open")}</button><span class="c-name">${esc(st)}</span></li>`;
         })
         .join("")}</ol>
       ${skin.all ? "" : `<button class="link-btn left" data-act="skinAll" data-date="${date}">bocka alla</button>`}`
    );
  }
  if (habits.length) {
    html += block(
      "Vanor",
      `<ul class="chores">${habits
        .map((h) => {
          const on = isDone(h.id, date);
          return `<li class="${on ? "is-done" : ""}"><button class="check" data-act="toggleHabit" data-id="${h.id}" data-date="${date}">${sym(on ? "done" : "open")}</button><span class="c-name">${esc(h.name)}</span></li>`;
        })
        .join("")}</ul>`
    );
  }
  html += choresBlock(date);
  html += foodBlock(date);
  html += trainingBlock(date);
  html += wellbeingBlock(date);
  return html;
}

function choresBlock(date) {
  const infos = live("routines").map((r) => routineInfo(r, date));
  const isDaily = (i) => i.r.mode !== "weekday" && i.r.every <= 1;
  const daily = choresOff(date) ? [] : infos.filter((i) => isDaily(i) && !i.done);
  const due = infos.filter((i) => !isDaily(i) && i.due && !i.done).sort((a, b) => b.score - a.score);
  const doneToday = infos.filter((i) => i.done);
  const limit = choreLimit(date);
  const shown = [...daily, ...(showAllChores ? due : due.slice(0, limit))];
  const hidden = due.length - Math.min(due.length, showAllChores ? due.length : limit);

  const row = (i) => `<li class="${i.done ? "is-done" : ""}">
      <button class="check" data-act="toggleRoutine" data-id="${i.r.id}" data-date="${date}" aria-label="Markera ${esc(i.r.name)}">${sym(i.done ? "done" : "open")}</button>
      <span class="c-name">${esc(i.r.name)}<span class="c-meta">${esc(i.label)}</span></span>
      ${i.done ? "" : `<button class="plus-btn" data-act="choreToLog" data-id="${i.r.id}" data-date="${date}">till loggen</button>`}
    </li>`;

  let body = "";
  const busy = busyMinutes(date);
  if (due.length) {
    const wknd = [0, 6].includes(parseYmd(date).getDay());
    body += `<p class="hint">${isSick(date) ? "Du är sjuk idag. Vila, sysslorna väntar." : dayRec(date).skipChores ? `Hoppar över idag, sysslorna kommer imorgon. <button class="link-btn" data-act="skipChores" data-date="${date}">ångra</button>` : limit === 0 ? "Fullt i kalendern idag, sysslorna får vänta." : busy >= 180 ? "Fullt i kalendern idag, så bara det viktigaste." : wknd ? "Helg, lite mer tid för hemmet." : "Vardag, bara det viktigaste."}</p>`;
  }
  const none = !infos.length ? '<li class="empty">Inga rutiner än. Lägg till under <a href="#routines">Index → Rutiner</a>.</li>' : '<li class="empty">Inget förfallet. Hemmet mår bra.</li>';
  const sick = choresOff(date);
  body += `<ul class="chores">${[...shown, ...doneToday].map(row).join("") || (sick ? "" : none)}</ul>`;
  if (!isSick(date) && !dayRec(date).skipChores && (shown.length || hidden > 0)) body += `<button class="btn-small ghost skip-btn" data-act="skipChores" data-date="${date}">Ingen städning idag</button> `;
  if (hidden > 0) body += `<button class="link-btn left" data-act="allChores">visa ${hidden} till</button>`;
  else if (showAllChores && due.length > limit) body += `<button class="link-btn left" data-act="allChores">visa färre</button>`;
  else if (!due.length && infos.some((i) => !isDaily(i))) {
    const next = infos.filter((i) => !isDaily(i) && !i.due && !i.done && i.r.mode !== "weekday").map((i) => ({ i, d: i.since === null ? daysBetween(date, firstDue(i.r)) : i.r.every - i.since })).sort((a, b) => a.d - b.d)[0];
    if (next) body += `<p class="hint">Nästa: ${esc(next.i.r.name)} om ${next.d} ${next.d === 1 ? "dag" : "dagar"}.</p>`;
  }

  const zone = sick ? null : zoneForWeek(date);
  if (zone) {
    const wk = weekStart(date);
    const tasks = (zone.tasks || []).map((task) => {
      const on = isDone(zoneKey(zone, task), wk);
      return `<li class="${on ? "is-done" : ""}"><button class="check" data-act="toggleZone" data-zone="${zone.id}" data-task="${esc(task)}" data-week="${wk}">${sym(on ? "done" : "open")}</button><span class="c-name">${esc(task)}</span></li>`;
    });
    body += `<h3>Veckans zon: ${esc(zone.name)}</h3><ul class="chores">${tasks.join("")}</ul>`;
  }
  return block("Hemmet", body);
}

function trainingBlock(date) {
  const week = weekWorkouts(date);
  const todays = week.filter((w) => w.date === date);
  const goal = workoutGoal(date);
  const dots = Array.from({ length: Math.max(goal, week.length) }, (_, i) => `<span class="goal-dot ${i < week.length ? "on" : ""}"></span>`).join("");
  const h = health(date);
  const healthNote = h === "sjuk" ? "Du är sjuk. Vila, ingen träning idag." : h === "krasslig" ? "Krasslig idag: ta det lugnt, ett lätt pass eller vila räcker." : "";
  const steps = dayRec(date).steps || "";
  const stepPct = steps ? Math.min(100, Math.round((steps / STEP_GOAL) * 100)) : 0;
  return block(
    "Träning",
    `${healthNote ? `<p class="hint health-note">${healthNote}</p>` : ""}
     <div class="goal-row"><span>Veckan</span><span class="goal-dots">${dots}</span><span class="goal-num">${week.length}/${goal} pass${goal < WORKOUT_GOAL ? " (sänkt)" : ""}</span></div>
     <div class="btn-row">${Object.entries(WORKOUT_TYPES)
       .map(([k, v]) => `<button class="btn-small ghost" data-act="addWorkout" data-type="${k}" data-date="${date}">+ ${v}</button>`)
       .join("")}</div>
     ${todays.length ? `<ul class="log">${todays.map((w) => `<li class="entry"><span class="sig"></span><span class="sym static">${sym("done")}</span><span class="e-text" data-act="workoutMenu" data-id="${w.id}">${WORKOUT_TYPES[w.type]}</span></li>`).join("")}</ul>` : ""}
     <label class="field inline"><span>Steg</span><input type="number" inputmode="numeric" min="0" step="100" value="${steps}" data-change="steps" data-date="${date}" placeholder="0" /></label>
     <div class="bar"><div class="bar-fill ${steps >= STEP_GOAL ? "full" : ""}" style="width:${stepPct}%"></div></div>
     <p class="hint">${steps ? `${Number(steps).toLocaleString("sv-SE")} av ${STEP_GOAL.toLocaleString("sv-SE")}` : `Mål ${STEP_GOAL.toLocaleString("sv-SE")} steg`}</p>`
  );
}

function scale(field, date, value, labels) {
  return `<div class="scale" role="group" aria-label="${field}">${[1, 2, 3, 4, 5]
    .map((n) => `<button class="scale-dot lv${n} ${value === n ? "on" : ""}" data-act="setScale" data-field="${field}" data-val="${n}" data-date="${date}" title="${labels[n - 1]}">${n}</button>`)
    .join("")}</div>`;
}

function wellbeingBlock(date) {
  const r = dayRec(date);
  const water = r.water || 0;
  return block(
    "Mående",
    `<div class="well-row"><span>Humör</span>${scale("mood", date, r.mood, ["Tungt", "Lite nere", "Okej", "Bra", "Toppen"])}</div>
     <div class="well-row"><span>Energi</span>${scale("energy", date, r.energy, ["Slut", "Låg", "Okej", "Pigg", "Full fart"])}</div>
     <div class="well-row"><span>Vatten</span>
       <div class="water">${Array.from({ length: Math.max(WATER_GOAL, water) }, (_, i) => `<button class="glass ${i < water ? "on" : ""}" data-act="setWater" data-val="${i + 1}" data-date="${date}" aria-label="${i + 1} glas"></button>`).join("")}</div></div>
     <div class="well-row"><span>Hälsa</span><div class="seg" role="group" aria-label="Hälsa">${[[null, "Frisk"], ["krasslig", "Krasslig"], ["sjuk", "Sjuk"]]
       .map(([v, label]) => `<button class="seg-btn ${health(date) === v ? "on" : ""}" data-act="setHealth" data-val="${v || ""}" data-date="${date}">${label}</button>`)
       .join("")}</div></div>
     ${health(date) ? `<label class="field"><span>Hur mår du? Symtom</span><input data-change="symptoms" data-date="${date}" value="${esc(r.symptoms || "")}" placeholder="t.ex. feber, halsont" /></label>` : ""}
     <div class="well-row"><span>Vikt</span><label class="inline-num"><input type="text" inputmode="decimal" value="${r.weight != null ? fmtKg(r.weight) : ""}" data-change="weight" data-date="${date}" placeholder="kg" /> kg</label><a class="link-btn" href="#weight">graf</a></div>
     <div class="well-row"><span>Sömn</span><label class="inline-num"><input type="number" inputmode="decimal" min="0" max="16" step="0.5" value="${r.sleep ?? ""}" data-change="sleep" data-date="${date}" placeholder="0" /> timmar</label></div>
     <div class="well-row"><span>Medicin</span><div class="btn-row">${[["medsAm", "Morgon"], ["medsPm", "Kväll"]]
       .map(([k, label]) => `<button class="tick ${r[k] ? "on" : ""}" data-act="toggleMeds" data-key="${k}" data-date="${date}">${sym(r[k] ? "done" : "open")}${label}</button>`)
       .join("")}</div></div>
     <label class="field"><span>Tacksam för idag</span><textarea rows="2" data-change="grateful" data-date="${date}" placeholder="En sak räcker.">${esc(r.grateful || "")}</textarea></label>`
  );
}

/* ---------------- Mat ---------------- */

const MEALS = [["frukost", "Frukost"], ["lunch", "Lunch"], ["middag", "Middag"], ["mellanmal", "Mellanmål"]];
const mealsOn = (date) => live("meals").filter((m) => m.date === date).sort((a, b) => (a.order || 0) - (b.order || 0));
function mealTotals(date) {
  const t = { kcal: 0, p: 0, f: 0, c: 0 };
  for (const m of mealsOn(date)) for (const k of Object.keys(t)) t[k] += m[k] || 0;
  return t;
}
const r0 = (n) => Math.round(n || 0);
const r1 = (n) => Math.round((n || 0) * 10) / 10;
const macroLine = (x) => `${r0(x.kcal)} kcal · P ${r1(x.p)} · F ${r1(x.f)} · K ${r1(x.c)}`;

function foodBlock(date) {
  const t = mealTotals(date);
  const s = settings();
  const bar = (val, goal, label, unit) => {
    if (!goal) return `<div class="macro"><b>${r0(val)}</b> ${unit} ${label}</div>`;
    const pct = Math.min(100, Math.round((val / goal) * 100));
    const left = goal - val;
    return `<div class="macro"><div class="macro-top"><span><b>${r0(val)}</b> / ${goal} ${unit} ${label}</span><span class="hint">${left >= 0 ? r0(left) + " kvar" : r0(-left) + " över"}</span></div>
      <div class="bar"><div class="bar-fill ${val > goal ? "over" : val >= goal * 0.9 ? "full" : ""}" style="width:${pct}%"></div></div></div>`;
  };
  const sections = MEALS.map(([key, label]) => {
    const items = mealsOn(date).filter((m) => m.meal === key);
    const sum = items.reduce((a, m) => a + (m.kcal || 0), 0);
    return `<div class="meal">
      <div class="meal-head"><h3>${label}</h3><span class="hint">${sum ? r0(sum) + " kcal" : ""}</span>
        <button class="btn-small ghost" data-act="addFood" data-meal="${key}" data-date="${date}">+ Lägg till</button></div>
      <ul class="food-list">${items
        .map((m) => `<li data-act="mealMenu" data-id="${m.id}"><span class="fl-name">${esc(m.name)}${m.grams ? ` <small>${r0(m.grams)} g</small>` : ""}</span><span class="fl-kcal">${r0(m.kcal)} kcal</span></li>`)
        .join("")}</ul>
    </div>`;
  }).join("");
  return block(
    "Mat",
    `${bar(t.kcal, s.kcalGoal, "", "kcal")}${bar(t.p, s.proteinGoal, "protein", "g")}
     <p class="hint">Fett ${r1(t.f)} g · Kolhydrater ${r1(t.c)} g${!s.kcalGoal ? ' · <a href="#settings">sätt dagsmål</a>' : ""}</p>
     ${sections}`
  );
}

// Livsmedel att välja: per 100 g (Livsmedelsverket, streckkod) eller per portion (egna).
let foodResults = {};
function foodRow(food) {
  if (food.id && food.id.startsWith("fd-")) food = { ...food, foodId: food.id, mine: true };
  const id = "f" + Object.keys(foodResults).length;
  foodResults[id] = food;
  const meta = food.per100 ? (food.kcal != null ? `${r0(food.kcal)} kcal/100 g` : "Livsmedelsverket") : `${r0(food.kcal)} kcal/portion`;
  return `<li><button type="button" class="food-pick" data-food-pick="${id}"><span>${esc(food.name)}</span><small>${meta}${food.mine ? " · min" : ""}</small></button></li>`;
}

async function workerGet(path) {
  if (!local.syncKey) throw new Error("Lägg in synknyckeln i Inställningar för att söka i Livsmedelsverket");
  const res = await fetch(workerUrl() + path, { headers: { "X-Journal-Key": local.syncKey } });
  if (!res.ok) throw new Error("Workern svarade " + res.status);
  return res.json();
}

let foodCtx = null; // { date, meal }
let foodTimer;
async function openFoodSearch(date, meal) {
  await closeSheet();
  foodCtx = { date, meal };
  foodResults = {};
  const dlg = sheet();
  const label = MEALS.find(([k]) => k === meal)[1];
  const mine = live("foods").sort((a, b) => (b.used || 0) - (a.used || 0)).slice(0, 12);
  dlg.innerHTML = `<form method="dialog" class="sheet-form food-sheet">
    <p class="sheet-title">${label}</p>
    <input type="search" id="food-q" placeholder="Sök livsmedel, t.ex. havregryn" autocomplete="off" />
    <div class="btn-row">
      <button type="button" class="btn-small ghost" data-food-act="scan">Skanna streckkod</button>
      <button type="button" class="btn-small ghost" data-food-act="manual">Skriv in själv</button>
    </div>
    <div id="food-results">${mine.length ? `<h3>Mina maträtter</h3><ul class="food-results">${mine.map(foodRow).join("")}</ul>` : '<p class="hint">Sök i Livsmedelsverkets databas, skanna en förpackning eller skriv in själv. Det du sparar hamnar under Mina maträtter.</p>'}</div>
    <div class="sheet-buttons"><button value="close" class="ghost">Stäng</button></div>
  </form>`;
  dlg.onclose = null;
  dlg.showModal();
  if (!("ontouchstart" in window)) dlg.querySelector("#food-q").focus();
}

// "2 dl", "150 g", "1,5 l" först i sökningen blir förvald mängd i gram
// (1 dl räknas som 100 g, vilket stämmer bra för yoghurt, mjölk och gröt).
function parseAmount(q) {
  const m = q.trim().match(/^(\d+(?:[.,]\d+)?)\s*(g|gram|dl|ml|cl|l)\b/i);
  if (!m) return null;
  const n = parseFloat(m[1].replace(",", "."));
  return Math.round(n * { g: 1, gram: 1, ml: 1, cl: 10, dl: 100, l: 1000 }[m[2].toLowerCase()]);
}

// Livsmedelsverkets lista hämtas en gång via workern och sparas i telefonen
// i en vecka. Sökningen sker här, direkt och även utan nät.
const LMV_CACHE = "bullet_lmv_v1";
let lmvItems = null;
async function lmvList() {
  if (lmvItems) return lmvItems;
  let cached = null;
  try {
    cached = JSON.parse(localStorage.getItem(LMV_CACHE) || "null");
  } catch (e) {}
  if (!cached || Date.now() - cached.at > 7 * 864e5) {
    const data = await workerGet("/food/list");
    if (data.error) throw new Error(data.error);
    if (!Array.isArray(data.list)) throw new Error("ingen livsmedelslista från workern");
    cached = { at: Date.now(), list: data.list };
    try {
      localStorage.setItem(LMV_CACHE, JSON.stringify(cached));
    } catch (e) {}
  }
  lmvItems = cached.list.map(([nummer, namn]) => {
    const name = norm(namn);
    return { f: { nummer, namn }, name, tokens: name.split(/\s+/).filter(Boolean) };
  });
  return lmvItems;
}

// Samma förlåtande sökning som workern: stavfel, sammansatta ord, och
// sällsynta ord väger tyngre än vanliga.
const norm = (t) =>
  String(t)
    .toLowerCase()
    .replace(/[éèê]/g, "e")
    .replace(/[üú]/g, "u")
    .replace(/soya/g, "soja")
    .replace(/[^a-zåäö0-9 ]/g, " ");
const STOP = new Set(["g", "gram", "dl", "ml", "cl", "l", "st", "msk", "tsk", "portion", "och", "med", "utan", "el"]);

function editDistance(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      best = Math.min(best, cur[j]);
    }
    if (best > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

function fuzzyContains(w, t) {
  for (const len of [t.length - 1, t.length, t.length + 1]) {
    for (let k = 0; k + len <= w.length; k++) if (editDistance(w.slice(k, k + len), t, 1) <= 1) return true;
  }
  return false;
}

// Hur väl ett sökord matchar ett livsmedelsnamn (0 till 1).
function wordMatch(w, name, tokens) {
  if (name.includes(w)) return 1;
  const tol = w.length >= 8 ? 2 : w.length >= 5 ? 1 : 0;
  let best = 0;
  for (const t of tokens) {
    if (tol && editDistance(w, t, tol) <= tol) best = Math.max(best, 0.9);
    if (w.length >= 4 && t.includes(w.slice(0, Math.max(4, w.length - 2)))) best = Math.max(best, 0.7);
  }
  // sammansatt sökord: hur stor del av ordet täcks av namnets ord
  // ("sojayoghurt" täcks av "soja" + "yoghurt"), ett stavfel per del tillåts
  let cover = 0;
  for (const t of tokens) {
    if (t.length < 3) continue;
    if (w.includes(t)) cover += t.length;
    else if (t.length >= 5 && fuzzyContains(w, t)) cover += t.length - 1;
    else {
      // samma början, t.ex. "soja" i "sojayoghurt" och "sojadryck"
      let cp = 0;
      while (cp < w.length && cp < t.length && w[cp] === t[cp]) cp++;
      if (cp >= 4) cover += cp;
    }
  }
  if (cover) best = Math.max(best, 0.95 * Math.min(1, cover / w.length));
  // stavfel inuti sammansatta ord: jämför mot lika långa bitar av namnet
  if (!best && tol && w.length >= 6) {
    const flat = tokens.join("");
    for (let k = 0; k + w.length - 1 <= flat.length; k++) {
      if (editDistance(w, flat.slice(k, k + w.length), tol) <= tol) {
        best = 0.8;
        break;
      }
    }
  }
  return best;
}

function searchFoods(items, q) {
  const words = norm(q).split(/\s+/).filter((w) => w.length > 1 && !/^\d/.test(w) && !STOP.has(w));
  if (!words.length) return [];
  const matches = items.map((it) => words.map((w) => wordMatch(w, it.name, it.tokens)));
  const weights = words.map((_, wi) => Math.log((items.length + 1) / (matches.filter((m) => m[wi] >= 0.6).length + 1)) + 0.5);
  const scored = items.map((it, idx) => ({ ...it, score: matches[idx].reduce((sum, m, wi) => sum + m * weights[wi], 0) })).filter((x) => x.score > 0);
  const best = Math.max(0, ...scored.map((x) => x.score));
  return scored
    .filter((x) => x.score >= best * 0.45)
    .sort((a, b) => b.score - a.score || a.f.namn.length - b.f.namn.length)
    .slice(0, 25)
    .map((x) => x.f);
}

async function runFoodSearch(q) {
  foodCtx.amount = parseAmount(q);
  const out = $("#food-results");
  if (!out) return;
  foodResults = {};
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const mine = live("foods").filter((f) => words.every((w) => f.name.toLowerCase().includes(w)));
  let html = mine.length ? `<h3>Mina maträtter</h3><ul class="food-results">${mine.map(foodRow).join("")}</ul>` : "";
  out.innerHTML = html + '<p class="hint">Söker i Livsmedelsverket...</p>';
  try {
    let found;
    try {
      found = searchFoods(await lmvList(), q);
    } catch (e) {
      // listan gick inte att hämta (t.ex. äldre worker): använd workerns sökning
      const data = await workerGet("/food/search?q=" + encodeURIComponent(q)).catch(() => null);
      if (!data || data.error) throw new Error((data && data.error) || e.message);
      found = data.results || [];
    }
    if ($("#food-q")?.value.trim() !== q) return; // en nyare sökning har tagit över
    const lmv = found.map((r) => ({ name: r.namn, lmv: r.nummer, per100: true, kcal: null }));
    html += `<h3>Livsmedelsverket</h3><ul class="food-results">${lmv.map(foodRow).join("") || '<li class="empty">Inga träffar.</li>'}</ul>`;
  } catch (e) {
    html += `<p class="hint error">${esc(e.message)}</p>`;
  }
  out.innerHTML = html;
}

async function pickFood(food) {
  await closeSheet();
  if (food.lmv && food.kcal == null) {
    try {
      const n = await workerGet("/food/" + food.lmv);
      if (n.error) throw new Error(n.error);
      Object.assign(food, { kcal: n.kcal, p: n.p, f: n.f, c: n.c });
    } catch (e) {
      return toast(e.message);
    }
  }
  portionDialog(food);
}

// Mängd i gram för livsmedel per 100 g, eller antal portioner för egna maträtter.
async function portionDialog(food, existing) {
  const per100 = !!food.per100;
  const amount = existing ? (per100 ? existing.grams : existing.portions || 1) : per100 ? foodCtx?.amount || food.grams || 100 : 1;
  const calc = (a) => {
    const k = per100 ? a / 100 : a;
    return { kcal: (food.kcal || 0) * k, p: (food.p || 0) * k, f: (food.f || 0) * k, c: (food.c || 0) * k };
  };
  const res = await openSheet(
    esc(food.name),
    `<p class="hint">${per100 ? "Per 100 g" : "Per portion"}: ${macroLine(food)}</p>
     <label class="field"><span>${per100 ? "Gram" : "Portioner"}</span><input type="text" name="amount" id="portion-amount" inputmode="decimal" value="${amount}" required /></label>
     <p class="plan-preview" id="portion-preview">${macroLine(calc(amount))}</p>
     ${food.mine || existing ? "" : '<label class="check-field"><input type="checkbox" name="save" /> Spara bland mina maträtter</label>'}
     <input type="hidden" id="portion-food" value="${esc(JSON.stringify({ per100, kcal: food.kcal, p: food.p, f: food.f, c: food.c }))}" />`,
    [{ value: "ok", label: existing ? "Spara" : "Lägg till", cls: "btn-primary" }, ...(existing ? [{ value: "delete", label: "Ta bort", cls: "danger", novalidate: true }] : []), CLOSE]
  );
  if (res.action === "delete") {
    remove("meals", existing.id);
    return render();
  }
  if (res.action !== "ok") return;
  const a = Math.max(0, parseFloat(String(res.data.amount).replace(",", ".")) || 0);
  const v = calc(a);
  const rec = {
    ...(existing || { id: "m-" + uid(), date: foodCtx.date, meal: foodCtx.meal, order: Date.now() }),
    name: food.name,
    ...v,
    grams: per100 ? a : food.grams ? food.grams * a : null,
    portions: per100 ? null : a,
    src: { per100, kcal: food.kcal, p: food.p, f: food.f, c: food.c, grams: food.grams || null, lmv: food.lmv || null, ean: food.ean || null, foodId: food.foodId || null }
  };
  put("meals", rec);
  if (food.foodId && get("foods", food.foodId)) put("foods", { ...get("foods", food.foodId), used: (get("foods", food.foodId).used || 0) + 1 });
  if (res.data.save) put("foods", { id: "fd-" + uid(), name: food.name, per100, kcal: food.kcal, p: food.p, f: food.f, c: food.c, grams: per100 ? a : food.grams || null, ean: food.ean || null, lmv: food.lmv || null, used: 1 });
  toast(`${food.name}: ${r0(v.kcal)} kcal`);
  render();
}

async function manualFood() {
  const res = await openSheet(
    "Skriv in själv",
    `<label class="field"><span>Vad åt du?</span><input name="name" required /></label>
     <div class="row">
       <label class="field"><span>Kalorier</span><input name="kcal" type="number" inputmode="decimal" min="0" step="any" required /></label>
       <label class="field"><span>Protein g</span><input name="p" type="number" inputmode="decimal" min="0" step="any" /></label>
     </div>
     <div class="row">
       <label class="field"><span>Fett g</span><input name="f" type="number" inputmode="decimal" min="0" step="any" /></label>
       <label class="field"><span>Kolhydrater g</span><input name="c" type="number" inputmode="decimal" min="0" step="any" /></label>
     </div>
     <label class="check-field"><input type="checkbox" name="save" checked /> Spara bland mina maträtter</label>`,
    [{ value: "ok", label: "Lägg till", cls: "btn-primary" }, CLOSE]
  );
  if (res.action !== "ok") return;
  const n = (k) => parseFloat(String(res.data[k] || 0).replace(",", ".")) || 0;
  const food = { name: res.data.name.trim(), per100: false, kcal: n("kcal"), p: n("p"), f: n("f"), c: n("c") };
  let foodId = null;
  if (res.data.save) {
    foodId = "fd-" + uid();
    put("foods", { id: foodId, ...food, used: 1 });
  }
  put("meals", { id: "m-" + uid(), date: foodCtx.date, meal: foodCtx.meal, order: Date.now(), name: food.name, kcal: food.kcal, p: food.p, f: food.f, c: food.c, portions: 1, src: { ...food, foodId } });
  toast(`${food.name}: ${r0(food.kcal)} kcal`);
  render();
}

// Streckkod: webbläsarens inbyggda läsare om den finns, annars ZXing. Värden från Open Food Facts.
let scanStop = null;
async function scanBarcode() {
  await closeSheet();
  const dlg = sheet();
  dlg.innerHTML = `<form method="dialog" class="sheet-form">
    <p class="sheet-title">Skanna streckkod</p>
    <video id="scan-video" class="scan-video" playsinline muted></video>
    <p class="hint" id="scan-status">Håll streckkoden framför kameran.</p>
    <div class="log-input-row"><input id="scan-code" inputmode="numeric" placeholder="eller skriv siffrorna" /><button type="button" class="btn-small" data-food-act="code">Sök</button></div>
    <div class="sheet-buttons"><button value="close" class="ghost">Stäng</button></div>
  </form>`;
  dlg.onclose = () => scanStop && scanStop();
  dlg.showModal();
  const video = dlg.querySelector("#scan-video");
  const status = dlg.querySelector("#scan-status");
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
    video.srcObject = stream;
    await video.play();
    let running = true;
    scanStop = () => {
      running = false;
      stream.getTracks().forEach((t) => t.stop());
      scanStop = null;
    };
    if ("BarcodeDetector" in window) {
      const det = new BarcodeDetector({ formats: ["ean_13", "ean_8", "upc_a", "upc_e"] });
      const loop = async () => {
        if (!running) return;
        const codes = await det.detect(video).catch(() => []);
        if (codes.length) return lookupBarcode(codes[0].rawValue);
        requestAnimationFrame(loop);
      };
      loop();
    } else {
      await loadScript("https://unpkg.com/@zxing/library@0.21.3/umd/index.min.js");
      const reader = new ZXing.BrowserMultiFormatReader();
      const stopStream = scanStop;
      scanStop = () => {
        reader.reset();
        stopStream();
      };
      reader.decodeFromStream(stream, video, (result) => {
        if (result && running) lookupBarcode(result.getText());
      });
    }
  } catch (e) {
    status.textContent = "Kameran gick inte att starta. Skriv siffrorna under streckkoden i stället.";
  }
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) return resolve();
    const el = document.createElement("script");
    el.src = src;
    el.onload = resolve;
    el.onerror = () => reject(new Error("kunde inte ladda " + src));
    document.head.append(el);
  });
}

async function lookupBarcode(code) {
  code = String(code).replace(/\D/g, "");
  if (!code) return;
  if (scanStop) scanStop();
  const status = $("#scan-status");
  if (status) status.textContent = `Hittade ${code}, hämtar...`;
  const saved = live("foods").find((f) => f.ean === code);
  if (saved) return pickFood({ ...saved, foodId: saved.id, mine: true });
  try {
    const res = await fetch(`https://world.openfoodfacts.org/api/v2/product/${code}.json?fields=product_name,product_name_sv,brands,nutriments,serving_quantity`);
    const data = await res.json();
    if (!data.product) throw new Error("not found");
    const n = data.product.nutriments || {};
    const kcal = n["energy-kcal_100g"] ?? (n["energy_100g"] ? n["energy_100g"] / 4.184 : null);
    if (kcal == null) throw new Error("no kcal");
    const name = [data.product.product_name_sv || data.product.product_name, (data.product.brands || "").split(",")[0]].filter(Boolean).join(", ") || "Vara " + code;
    pickFood({ name, per100: true, ean: code, kcal, p: n.proteins_100g, f: n.fat_100g, c: n.carbohydrates_100g, grams: +data.product.serving_quantity || 100 });
  } catch (e) {
    if (status) status.textContent = `Hittade inte ${code} i Open Food Facts. Tryck Stäng och välj Skriv in själv.`;
  }
}

/* ---------------- Vecka ---------------- */

function sleepChart(start) {
  const w = 280;
  const h = 90;
  const pts = [];
  for (let i = 0; i < 7; i++) {
    const s = dayRec(addDays(start, i)).sleep;
    if (s) pts.push([20 + i * ((w - 30) / 6), h - 12 - ((Math.min(10, Math.max(4, s)) - 4) / 6) * (h - 24), s]);
  }
  const grid = [5, 6, 7, 8, 9]
    .map((v) => {
      const y = h - 12 - ((v - 4) / 6) * (h - 24);
      return `<line x1="14" x2="${w}" y1="${y}" y2="${y}" class="grid"/><text x="0" y="${y + 3}">${v}</text>`;
    })
    .join("");
  const days = ["M", "T", "O", "T", "F", "L", "S"].map((d, i) => `<text x="${16 + i * ((w - 30) / 6)}" y="${h}">${d}</text>`).join("");
  const line = pts.length > 1 ? `<polyline points="${pts.map((p) => p[0] + "," + p[1]).join(" ")}" class="line"/>` : "";
  const dots = pts.map((p) => `<circle cx="${p[0]}" cy="${p[1]}" r="3.5" class="pt"/>`).join("");
  return `<svg viewBox="-2 0 ${w + 4} ${h + 4}" class="sleep-chart" role="img" aria-label="Sömn per natt">${grid}${days}${line}${dots}</svg>`;
}

function viewWeek(start) {
  const end = addDays(start, 6);
  const t = today();
  const ym = start.slice(0, 7);
  const wk = get("weeks", start) || { id: start };
  const workouts = workoutsIn(start, end);
  const dates = Array.from({ length: 7 }, (_, i) => addDays(start, i));
  const stepDays = dates.filter((d) => (dayRec(d).steps || 0) >= STEP_GOAL).length;
  const zone = zoneForWeek(start);
  const zoneDone = zone ? (zone.tasks || []).filter((task) => isDone(zoneKey(zone, task), start)).length : 0;

  let html = `<header class="week-head" style="--tape:${tapeColor(ym)}">
    <a class="nav-arrow" href="#${prevPage("week", start)}" aria-label="Föregående sida">‹</a>
    <div class="page-title"><h1 class="tape-title">Vecka ${isoWeek(start)}</h1><div class="eyebrow">${niceDate(start)} till ${niceDate(end)}</div>
      <div class="jump"><a href="#week/${addDays(start, -7)}">« v ${isoWeek(addDays(start, -7))}</a><a href="#week/${addDays(start, 7)}">v ${isoWeek(addDays(start, 7))} »</a></div></div>
    <a class="nav-arrow" href="#${nextPage("week", start)}" aria-label="Nästa sida">›</a>
  </header>`;

  const cards = dates.map((date) => {
    const d = parseYmd(date);
    const rows = [
      ...holidaysOn(date).map(holidayRow),
      ...birthdaysOn(date).map((b) => birthdayRow(b, date)),
      ...gcalEventsOn(date).map(gcalRow),
      ...entriesOn(date).map((e) => entryRow(e))
    ];
    const r = dayRec(date);
    const sunday = isRedDay(date);
    return `<section class="week-day ${date === t ? "is-today" : ""}" style="--tape:${tapeColor(ym)}">
      <div class="wd-head">
        <a href="#day/${date}" class="wd-name"><span class="tape">${WD_LONG[d.getDay()]}</span></a>
        <input class="work-hours" value="${esc(r.work || "")}" data-change="work" data-date="${date}" placeholder="arbetstid" aria-label="Arbetstid ${WD_LONG[d.getDay()]}" />
      </div>
      <ul class="log compact">${rows.join("")}</ul>
      <form class="mini-add" data-form="log" data-date="${date}" autocomplete="off"><input name="text" placeholder="+" aria-label="Lägg till ${WD_LONG[d.getDay()]}" /></form>
      <a href="#day/${date}" class="wd-num ${sunday ? "red" : ""}">${d.getDate()}</a>
    </section>`;
  });
  html += `<div class="week-grid">${cards.join("")}</div>`;

  // Veckans tracker: egna vanor, vatten, träning och steg dag för dag.
  const letters = ["M", "T", "O", "T", "F", "L", "S"];
  const habits = live("habits").sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const cell = (on, act, extra = "") => `<td><button class="wk-dot ${on ? "on" : ""}" ${act} ${extra}></button></td>`;
  const trows = [
    ...habits.map((h) => `<tr><th>${esc(h.name)}</th>${dates.map((d) => cell(isDone(h.id, d), `data-act="toggleHabit" data-id="${h.id}" data-date="${d}"`)).join("")}</tr>`),
    `<tr><th>Träning</th>${dates.map((d) => cell(workouts.some((w) => w.date === d), `data-act="goDay" data-date="${d}"`)).join("")}</tr>`,
    `<tr><th>${STEP_GOAL / 1000}k steg</th>${dates.map((d) => cell((dayRec(d).steps || 0) >= STEP_GOAL, `data-act="goDay" data-date="${d}"`)).join("")}</tr>`,
    `<tr><th>Vatten</th>${dates.map((d) => `<td class="water-col">${dayRec(d).water || 0}</td>`).join("")}</tr>`
  ];
  html += `<div class="week-extras">`;
  html += block(
    "Tracker",
    `<table class="wk-tracker"><thead><tr><th></th>${letters.map((l) => `<th>${l}</th>`).join("")}</tr></thead><tbody>${trows.join("")}</tbody></table>
     <a class="link-btn left" href="#routines">ändra vanor</a>`
  );
  html += block(
    "Veckan",
    `<div class="stats">
       <div><b>${workouts.length}/${workoutGoal(start)}</b><span>pass</span></div>
       <div><b>${stepDays}/7</b><span>dagar ${STEP_GOAL / 1000}k</span></div>
       ${zone ? `<div><b>${zoneDone}/${(zone.tasks || []).length}</b><span>${esc(zone.name)}</span></div>` : ""}
     </div>
     <h3>Sömn</h3>${sleepChart(start)}`
  );
  html += block("Anteckningar", `<textarea rows="4" data-change="weekFocus" data-week="${start}" placeholder="Fokus, tankar, sånt som inte är uppgifter.">${esc(wk.focus || "")}</textarea>`);
  // En samling som heter "Inköp" visas som veckans inköpslista.
  const shop = live("collections").find((c) => c.name.trim().toLowerCase().startsWith("inköp"));
  if (shop) {
    const items = entriesWhere((e) => e.coll === shop.id && e.status !== "done" && e.status !== "struck");
    html += block(`<a href="#coll/${shop.id}">${esc(shop.name)}</a>`, list(items.map((e) => entryRow(e)), "Inget att köpa.") + `<form class="mini-add" data-form="log" data-coll="${shop.id}" autocomplete="off"><input name="text" placeholder="+ lägg till" /></form>`);
  }
  html += `</div>`;
  return html;
}

/* ---------------- Månad ---------------- */

// Washitejpens färg per månad.
const TAPES = ["#9cc3e6", "#f4a6c6", "#b5dc97", "#f5dd6b", "#8fd3b0", "#ff6fb5", "#ffc857", "#f4a261", "#a8cf6b", "#f0a24e", "#f2df4a", "#e0645c"];
const tapeColor = (ym) => TAPES[+ym.slice(5, 7) - 1];

// Små doodles för månadens försättsblad, efter säsong.
function doodles(ym) {
  const m = +ym.slice(5, 7);
  const leaf = (x, y, r, c) => `<g transform="translate(${x} ${y}) rotate(${r})"><path d="M0 0C6-9 18-9 22 0 18 9 6 9 0 0Z" fill="${c}"/><path d="M-6 0H16"/></g>`;
  const flower = (x, y, c) => `<g transform="translate(${x} ${y})">${[0, 72, 144, 216, 288].map((a) => `<ellipse rx="4" ry="7" transform="rotate(${a}) translate(0 -7)" fill="${c}"/>`).join("")}<circle r="3.5" fill="#f5c542"/></g>`;
  const flake = (x, y) => `<g transform="translate(${x} ${y})">${[0, 60, 120].map((a) => `<path d="M0-10V10" transform="rotate(${a})"/>`).join("")}</g>`;
  const heart = (x, y, c) => `<path transform="translate(${x} ${y})" d="M0 4C-8-2-6-10 0-6 6-10 8-2 0 4Z" fill="${c}"/>`;
  const holly = (x, y) => `<g transform="translate(${x} ${y})"><path d="M0 0C4-4 10-4 14-8 12-2 16 0 12 4 8 2 4 4 0 0Z" fill="#6fae6a"/><circle cx="-2" cy="3" r="2.5" fill="#d94b4b"/><circle cx="2" cy="5" r="2.5" fill="#d94b4b"/></g>`;
  const pumpkin = (x, y, s) => `<g transform="translate(${x} ${y}) scale(${s})"><ellipse cx="0" cy="0" rx="16" ry="12" fill="#f3a95b"/><path d="M-6-11C-9 0-9 5-6 11M6-11C9 0 9 5 6 11M0-12V12"/><path d="M0-12C0-16 2-18 4-19"/></g>`;
  const sun = (x, y) => `<g transform="translate(${x} ${y})"><circle r="8" fill="#ffd166"/>${[0, 45, 90, 135, 180, 225, 270, 315].map((a) => `<path d="M0-12V-16" transform="rotate(${a})"/>`).join("")}</g>`;
  let art = "";
  if (m >= 9 && m <= 11) {
    const cs = ["#f3a95b", "#e9d45a", "#9ccc65", "#e46b5a", "#f0c050"];
    art = [[20, 20, 30], [90, 50, -20], [250, 18, 60], [300, 60, 10], [40, 80, 80], [210, 75, -40], [150, 12, 15]].map(([x, y, r], i) => leaf(x, y, r, cs[i % cs.length])).join("");
    if (m === 10) art += pumpkin(300, 40, 1) + pumpkin(332, 48, 0.65);
  } else if (m === 12) {
    art = [holly(30, 30), heart(80, 70, "#c98a4b"), holly(150, 20), heart(210, 40, "#c98a4b"), holly(270, 70), heart(310, 25, "#d94b4b"), flake(120, 80), flake(250, 20)].join("");
  } else if (m <= 2) {
    art = [[30, 30], [90, 70], [160, 25], [220, 80], [290, 40], [330, 85]].map(([x, y]) => flake(x, y)).join("") + (m === 2 ? heart(190, 55, "#f08aa8") : "");
  } else if (m <= 5) {
    const cs = ["#f4a6c6", "#f5dd6b", "#9cc3e6", "#c3a6e8"];
    art = [[30, 40], [100, 75], [180, 30], [250, 70], [320, 35]].map(([x, y], i) => flower(x, y, cs[i % cs.length])).join("");
  } else {
    art = sun(40, 40) + [heart(120, 70, "#ff6fb5"), heart(220, 30, "#ffc857"), heart(300, 75, "#ff6fb5")].join("") + flower(170, 80, "#8fd3b0");
  }
  return `<svg viewBox="0 0 350 110" class="doodles" aria-hidden="true">${art}</svg>`;
}

function viewMonth(ym) {
  const t = today();
  const n = daysInMonth(ym);
  const lead = (parseYmd(ym + "-01").getDay() + 6) % 7;
  const cells = [];
  for (let i = 0; i < lead; i++) cells.push('<div class="mg-cell blank"></div>');
  for (let i = 1; i <= n; i++) {
    const date = `${ym}-${pad(i)}`;
    const d = parseYmd(date);
    const items = [
      ...holidaysOn(date).map((h) => `<span class="mi hol ${h.red ? "red" : ""}">${esc(h.name)}</span>`),
      ...birthdaysOn(date).map((b) => `<span class="mi bd">${esc(b.name)}</span>`),
      ...gcalEventsOn(date).map((e) => `<span class="mi">${e.ad ? "" : +e.s.slice(11, 13) + (e.s.slice(14, 16) !== "00" ? "." + e.s.slice(14, 16) : "") + " "}${esc(e.t)}</span>`),
      ...entriesOn(date)
        .filter((e) => e.type === "event" || e.type === "meeting" || e.sig)
        .map((e) => `<span class="mi">${e.sig ? `<b>${esc(e.sig)}</b>` : ""}${e.time ? e.time.replace(":00", "") + " " : ""}${esc(e.text)}</span>`)
    ];
    const mood = dayRec(date).mood;
    cells.push(`<div class="mg-cell ${date === t ? "today" : ""}" data-act="goDay" data-date="${date}">
      <div class="mg-items">${items.join("")}</div>
      <span class="mg-num ${isRedDay(date) ? "red" : ""}">${i}</span>${mood ? `<span class="mood-dot lv${mood}"></span>` : ""}
    </div>`);
  }
  const tasks = entriesWhere((e) => e.month === ym && !e.parent);
  return (
    `<section class="month-cover" style="--tape:${tapeColor(ym)}">${doodles(ym)}
      <div class="cover-row">
        <a class="nav-arrow" href="#${prevPage("month", ym)}" aria-label="Föregående sida">‹</a>
        <div><h1 class="cover-title">${monthName(ym)} <span>${ym.slice(0, 4)}</span></h1>
        <div class="jump"><a href="#month/${addMonths(ym, -1)}">« ${monthName(addMonths(ym, -1))}</a><a href="#month/${addMonths(ym, 1)}">${monthName(addMonths(ym, 1))} »</a></div></div>
        <a class="nav-arrow" href="#${nextPage("month", ym)}" aria-label="Nästa sida">›</a>
      </div>
    </section>
    <section class="month-grid" style="--tape:${tapeColor(ym)}">
      ${["Måndag", "Tisdag", "Onsdag", "Torsdag", "Fredag", "Lördag", "Söndag"].map((w) => `<div class="mg-wd"><span class="full">${w}</span><span class="short">${w.slice(0, 3)}</span></div>`).join("")}
      ${cells.join("")}
    </section>` + block("Mål och händelser", list(tasks.map((e) => entryRow(e)), "Vad är viktigast den här månaden?") + logForm({ month: ym }, "Mål, händelse eller uppgift..."))
  );
}

/* ---------------- Framtid ---------------- */

function viewFuture(year) {
  const t = today();
  const bdays = live("birthdays");
  const months = [];
  for (let m = 1; m <= 12; m++) {
    const ym = `${year}-${pad(m)}`;
    const items = [
      ...holidays(year).filter((h) => h.date.slice(0, 7) === ym).map((h) => ({ k: h.date.slice(8), html: `<li class="fl-item hol ${h.red ? "red" : ""}"><b>${+h.date.slice(8)}</b>${esc(h.name)}</li>` })),
      ...bdays.filter((b) => b.md.slice(0, 2) === pad(m)).map((b) => ({ k: b.md.slice(3), html: `<li class="fl-item bd" data-act="editBirthday" data-id="${b.id}"><b>${+b.md.slice(3)}</b>${sym("birthday")}${esc(b.name)}${b.year ? ` ${year - b.year} år` : ""}</li>` })),
      ...live("entries").filter((e) => e.date && e.date.slice(0, 7) === ym && (e.sig || e.type === "event" || e.type === "meeting")).map((e) => ({ k: e.date.slice(8), html: `<li class="fl-item"><b>${+e.date.slice(8)}</b><a href="#day/${e.date}">${e.sig ? esc(e.sig) + " " : ""}${esc(e.text)}</a></li>` }))
    ].sort((a, b) => a.k.localeCompare(b.k));
    const planned = entriesWhere((e) => e.month === ym && !e.parent);
    months.push(`<section class="block future-month ${ym < t.slice(0, 7) ? "past" : ""} ${ym === t.slice(0, 7) ? "current" : ""}" style="--tape:${tapeColor(ym)}">
      <h2><a href="#month/${ym}" class="tape">${monthName(ym)}</a></h2>
      <ul class="fl-list">${items.map((i) => i.html).join("")}</ul>
      <ul class="log">${planned.map((e) => entryRow(e)).join("")}</ul>
      ${logForm({ month: ym }, "Planera...")}
    </section>`);
  }
  return head("Framtidslogg", String(year), `future/${year - 1}`, `future/${year + 1}`) + `<div class="future-grid">${months.join("")}</div>`;
}

/* ---------------- Index + samlingar ---------------- */

let searchQuery = "";

// Söker i allt: loggen, delsteg, samlingar, födelsedagar, tacksamhet,
// veckoanteckningar, rutiner och händelser från Google. Alla ord måste finnas.
// Bara "!", "*" eller "?" listar alla öppna rader med den markeringen.
function searchResults() {
  const raw = searchQuery.trim();
  const words = raw.toLowerCase().split(/\s+/).filter(Boolean);
  const onlySig = /^[!*?]$/.test(raw);
  if (!onlySig && raw.length < 2) return "";
  const matches = (text) => words.every((w) => String(text || "").toLowerCase().includes(w));
  const mark = (text) => {
    let out = esc(text);
    if (onlySig) return out;
    for (const w of words) out = out.replace(new RegExp(`(${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi"), "<mark>$1</mark>");
    return out;
  };
  const hits = [];
  const where = (e) => (e.date ? niceDate(e.date) + " " + e.date.slice(0, 4) : e.month ? monthName(e.month) + " " + e.month.slice(0, 4) : getColl(e.coll)?.name || "");
  const href = (e) => (e.date ? `#day/${e.date}` : e.month ? `#month/${e.month}` : `#coll/${e.coll}`);

  for (const e of live("entries")) {
    const ok = onlySig ? e.sig === raw && !["done", "struck", "migrated"].includes(e.status) : matches(e.text);
    if (!ok) continue;
    const parent = e.parent ? get("entries", e.parent) : null;
    hits.push({
      sort: e.date || (e.month ? e.month + "-00" : ""),
      html: `<li class="entry ty-${e.type} st-${e.status}"><span class="sig">${esc(e.sig || "")}</span><span class="sym static">${entrySym(e)}</span>
        <a class="e-text" href="${href(e)}">${mark(e.text)}<span class="e-from">${esc(where(e))}${parent ? " · " + esc(parent.text) : ""}</span></a></li>`
    });
  }
  if (!onlySig) {
    for (const c of live("collections")) if (matches(c.name)) hits.push({ sort: "", html: `<li class="entry"><span class="sig"></span><span class="sym static">☰</span><a class="e-text" href="#coll/${c.id}">${mark(c.name)}<span class="e-from">samling</span></a></li>` });
    for (const b of live("birthdays")) if (matches(b.name)) hits.push({ sort: "", html: `<li class="entry ty-birthday"><span class="sig"></span><span class="sym static">${sym("birthday")}</span><a class="e-text" href="#birthdays">${mark(b.name)}<span class="e-from">${+b.md.slice(3)} ${monthName("2000-" + b.md.slice(0, 2))}</span></a></li>` });
    for (const d of live("days")) {
      if (d.grateful && matches(d.grateful)) hits.push({ sort: d.id, html: `<li class="entry ty-note"><span class="sig"></span><span class="sym static">♡</span><a class="e-text" href="#day/${d.id}">${mark(d.grateful)}<span class="e-from">tacksam ${niceDate(d.id)}</span></a></li>` });
    }
    for (const w of live("weeks")) if (w.focus && matches(w.focus)) hits.push({ sort: w.id, html: `<li class="entry ty-note"><span class="sig"></span><span class="sym static">${sym("note")}</span><a class="e-text" href="#week/${w.id}">${mark(w.focus)}<span class="e-from">vecka ${isoWeek(w.id)}</span></a></li>` });
    for (const r of live("routines")) if (matches(r.name)) hits.push({ sort: "", html: `<li class="entry"><span class="sig"></span><span class="sym static">↻</span><a class="e-text" href="#routines">${mark(r.name)}<span class="e-from">rutin${lastDone(r.id, today()) ? ", senast " + niceDate(lastDone(r.id, today())) : ""}</span></a></li>` });
    const gcal = get("meta", "gcal");
    for (const ev of (gcal && gcal.events) || []) if (matches(ev.t)) hits.push({ sort: ev.sd, html: `<li class="entry gcal"><span class="sig"></span><span class="sym static">${sym("event")}</span><a class="e-text" href="#day/${ev.sd}">${mark(ev.t)}<span class="e-from">Google ${niceDate(ev.sd)}</span></a></li>` });
  }
  hits.sort((a, b) => b.sort.localeCompare(a.sort));
  const shown = hits.slice(0, 60);
  return `<p class="hint">${hits.length} ${hits.length === 1 ? "träff" : "träffar"}</p><ul class="log">${shown.map((h) => h.html).join("") || '<li class="empty">Inga träffar.</li>'}</ul>`;
}

function viewIndex() {
  const colls = live("collections")
    .filter((c) => c.id !== "c-braindump")
    .sort((a, b) => a.name.localeCompare(b.name, "sv"));
  const count = (id) => live("entries").filter((e) => e.coll === id).length;
  const t = today();
  const months = Array.from({ length: 6 }, (_, i) => addMonths(t.slice(0, 7), -i));
  return (
    head("Bellas Bullet", "Index", null, null) +
    `<section class="block"><h2>Sök</h2><input type="search" id="search" data-change="search" value="${esc(searchQuery)}" placeholder="Sök i allt du skrivit..." /><p class="hint">Tips: skriv bara <code>?</code> för allt du ska kolla upp, <code>!</code> för deadlines.</p><div id="search-results">${searchResults()}</div></section>` +
    block(
      "Samlingar",
      `<ul class="index-list">${colls.map((c) => `<li><a href="#coll/${c.id}">${esc(c.name)}</a><span class="dots"></span><span>${count(c.id)}</span></li>`).join("") || '<li class="empty">Inga samlingar än.</li>'}</ul>
       <form class="log-input-row" data-form="newColl" autocomplete="off"><input name="name" placeholder="Ny samling, t.ex. Böcker att läsa" /><button class="btn-small">+</button></form>`
    ) +
    block(
      "Uppslag",
      `<ul class="index-list">
        <li><a href="#kvall">Kvällsgenomgång</a><span class="dots"></span><span>varje kväll</span></li>
        <li><a href="#coll/c-braindump">Brain dump</a><span class="dots"></span><span>${live("entries").filter((e) => e.coll === "c-braindump").length}</span></li>
        <li><a href="#future/${t.slice(0, 4)}">Framtidslogg ${t.slice(0, 4)}</a><span class="dots"></span><span>3</span></li>
        <li><a href="#weight">Vikt</a><span class="dots"></span><span>${(() => { const w = weightSeries(); return w.length ? fmtKg(w[w.length - 1].kg) + " kg" : ""; })()}</span></li>
        <li><a href="#gratitude">Tacksamhet</a><span class="dots"></span><span>${live("days").filter((d) => d.grateful).length}</span></li>
        <li><a href="#birthdays">Födelsedagar</a><span class="dots"></span><span>${live("birthdays").length}</span></li>
        <li><a href="#key">Nyckel</a><span class="dots"></span><span>2</span></li>
        <li><a href="#tracker/${t.slice(0, 7)}">Tracker</a><span class="dots"></span><span>${monthName(t.slice(0, 7))}</span></li>
        <li><a href="#routines">Rutiner och zoner</a><span class="dots"></span><span>${live("routines").length}</span></li>
        ${months.map((m) => `<li><a href="#month/${m}">${monthName(m)} ${m.slice(0, 4)}</a><span class="dots"></span><span>s. ${pageNumber("month", m)}</span></li>`).join("")}
        <li><a href="#settings">Inställningar</a><span class="dots"></span><span></span></li>
      </ul>`
    )
  );
}

function bookshelf(entries) {
  const tones = ["#e8d9c0", "#d9e6d0", "#f3d6d6", "#d6e2f0", "#efe3b5", "#e2d6ef"];
  const books = entries
    .map((e, i) => {
      const h = 120 + ((e.text.length * 7 + i * 13) % 50);
      return `<button class="book" style="height:${h}px;background:${tones[i % tones.length]}" data-act="entryMenu" data-id="${e.id}" title="${esc(e.text)}"><span>${esc(e.text)}</span></button>`;
    })
    .join("");
  return `<div class="shelf">${books || '<p class="hint">Hyllan är tom än så länge.</p>'}</div>`;
}

function viewCollection(id) {
  const c = getColl(id);
  if (!c) return head("Samling", "Hittades inte", null, null);
  const entries = entriesWhere((e) => e.coll === id && !e.parent);
  const body = c.view === "shelf" ? bookshelf(entries) : list(entries.map((e) => entryRow(e)), "Tom samling.");
  return (
    head("Samling", esc(c.name), null, null, `<button class="link-btn" data-act="collMenu" data-id="${id}">ändra</button>`) +
    (id === "c-braindump" ? '<p class="hint center">Skriv av dig. Sortera sen: tryck på en rad för att flytta den till en dag eller månad.</p>' : "") +
    block("", body + logForm({ coll: id }, c.view === "shelf" ? "Boktitel..." : id === "c-braindump" ? "Tanke, idé, projekt..." : "Lägg till...", c.note ? "note" : "task"))
  );
}

/* ---------------- Kvällsgenomgång ---------------- */

let planned = []; // det som lagts in under kvällens planering, visas som kvitto

function migButtons(e, inbox) {
  return `<span class="mig-actions">
    <button type="button" class="btn-small" data-mig="tomorrow" data-id="${e.id}">Imorgon</button>
    <button type="button" class="btn-small ghost" data-mig="pick" data-id="${e.id}">Välj dag</button>
    <button type="button" class="btn-small ghost" data-mig="month" data-id="${e.id}">Senare</button>
    <button type="button" class="btn-small ghost" data-mig="struck" data-id="${e.id}" aria-label="Stryk">${inbox ? "Släpp" : sym("struck")}</button>
  </span>`;
}

function viewEvening() {
  const t = today();
  const tomorrow = addDays(t, 1);
  const r = dayRec(t);
  const open = entriesWhere((e) => !e.parent && e.type === "task" && (e.status === "open" || e.status === "started") && e.date && e.date <= t);
  const inbox = entriesWhere((e) => e.coll === "c-braindump" && e.status === "open");
  const row = (e, isInbox) => `<li><span class="sig">${esc(e.sig || "")}</span><span class="sym static">${entrySym(e)}</span>
    <span class="txt">${esc(e.text)}${e.date && e.date < t ? `<span class="e-from">${niceDate(e.date)}</span>` : ""}</span>${migButtons(e, isInbox)}</li>`;

  const tomorrowRows = [
    ...holidaysOn(tomorrow).map(holidayRow),
    ...birthdaysOn(tomorrow).map((b) => birthdayRow(b, tomorrow)),
    ...gcalEventsOn(tomorrow).map(gcalRow),
    ...entriesOn(tomorrow).map((e) => entryRow(e))
  ];
  const chores = live("routines").map((x) => routineInfo(x, tomorrow)).filter((i) => i.due).sort((a, b) => b.score - a.score).slice(0, choreLimit(tomorrow));

  return (
    head("Kvällsgenomgång", "Ikväll", null, null, `<div class="eyebrow">${WD_LONG[parseYmd(t).getDay()]} ${niceDate(t)}</div>`) +
    block(
      "1. Hur var dagen?",
      `<div class="well-row"><span>Humör</span>${scale("mood", t, r.mood, ["Tungt", "Lite nere", "Okej", "Bra", "Toppen"])}</div>
       <div class="well-row"><span>Energi</span>${scale("energy", t, r.energy, ["Slut", "Låg", "Okej", "Pigg", "Full fart"])}</div>
       <label class="field"><span>Tacksam för</span><textarea rows="2" data-change="grateful" data-date="${t}" placeholder="En sak räcker.">${esc(r.grateful || "")}</textarea></label>
       <form class="log-input-row" data-form="dayNote" autocomplete="off"><input name="text" placeholder="En rad om dagen, sparas som notering" /><button class="btn-small">+</button></form>`
    ) +
    block(
      "2. Migrera",
      open.length
        ? `<p class="hint">Är det här värt att göra? Flytta det som spelar roll, stryk resten.</p><ul class="migrate-list">${open.map((e) => row(e, false)).join("")}</ul>`
        : '<p class="hint">Inga öppna uppgifter. Snyggt.</p>'
    ) +
    (inbox.length ? block("3. Sortera brain dump", `<ul class="migrate-list">${inbox.map((e) => row(e, true)).join("")}</ul>`) : "") +
    block(
      `${inbox.length ? 4 : 3}. Fyll i framåt`,
      `<p class="hint">Börja raden med när: <code>fre</code>, <code>12/10</code>, <code>v 42</code>, <code>nov</code>. Utan datum hamnar det på imorgon. Symbolerna fungerar som vanligt: <code>m</code> möte, <code>o</code> event, <code>!</code> deadline, <code>14:00</code> tid.</p>
       <form class="plan-form" data-form="plan" autocomplete="off">
         <div class="log-input-row"><input name="text" id="plan-input" placeholder="fre 14:00 m Tandläkare" /><button class="btn-small">+</button></div>
         <p class="plan-preview hint" id="plan-preview"></p>
       </form>
       ${planned.length ? `<ul class="planned">${planned.map((p) => `<li>${entrySym(p.e)} ${esc(p.e.text)} <span>→ ${esc(p.where)}</span></li>`).join("")}</ul>` : ""}`
    ) +
    block(
      "Imorgon",
      list(tomorrowRows, "Inget inbokat än.") +
        (chores.length ? `<h3>Dags för</h3><ul class="chores">${chores.map((i) => `<li><span class="check">${sym("open")}</span><span class="c-name">${esc(i.r.name)}</span></li>`).join("")}</ul>` : "") +
        `<a class="btn-primary" href="#day/${tomorrow}">Öppna imorgon</a>`
    )
  );
}

/* ---------------- Vikt ---------------- */

const fmtKg = (n) => (Math.round(n * 10) / 10).toLocaleString("sv-SE", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
function weightSeries() {
  const pts = live("days").filter((d) => d.weight).map((d) => ({ date: d.id, kg: d.weight })).sort((a, b) => a.date.localeCompare(b.date));
  // trend: medel av vägningarna de senaste 7 dagarna, jämnar ut dagssvängningar
  return pts.map((p) => {
    const from = addDays(p.date, -6);
    const win = pts.filter((q) => q.date >= from && q.date <= p.date);
    return { ...p, trend: win.reduce((a, q) => a + q.kg, 0) / win.length };
  });
}

const WEIGHT_RANGES = [["30", "30 dagar"], ["90", "3 mån"], ["365", "1 år"], ["all", "Allt"]];
let weightPoints = [];

function weightChart(pts, goal) {
  // ritas i skärmens verkliga bredd, så text och punkter får rätt storlek
  const W = Math.max(300, Math.min(680, ($("#app")?.clientWidth || 390) - 32)), H = 240, L = 36, R = 70, T = 14, B = 30;
  const dates = pts.map((p) => p.date);
  const d0 = dates[0], d1 = dates[dates.length - 1];
  const span = Math.max(1, daysBetween(d0, d1));
  const vals = [...pts.map((p) => p.kg), ...pts.map((p) => p.trend), ...(goal ? [goal] : [])];
  let lo = Math.floor(Math.min(...vals) - 0.5), hi = Math.ceil(Math.max(...vals) + 0.5);
  if (hi - lo < 2) { lo -= 1; hi += 1; }
  const step = hi - lo > 12 ? 5 : hi - lo > 6 ? 2 : 1;
  const x = (d) => L + (daysBetween(d0, d) / span) * (W - L - R);
  const y = (v) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
  let grid = "";
  for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) grid += `<line class="wc-grid" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text class="wc-tick" x="${L - 8}" y="${y(v) + 4}" text-anchor="end">${v}</text>`;
  // några datum längs x-axeln
  const nTicks = Math.min(5, dates.length);
  let xt = "";
  for (let i = 0; i < nTicks; i++) {
    const d = addDays(d0, Math.round((span * i) / Math.max(1, nTicks - 1)));
    xt += `<text class="wc-tick" x="${x(d)}" y="${H - 8}" text-anchor="middle">${+d.slice(8)}/${+d.slice(5, 7)}</text>`;
  }
  const goalLine = goal && goal >= lo && goal <= hi ? `<line class="wc-goal" x1="${L}" x2="${W - R}" y1="${y(goal)}" y2="${y(goal)}"/><text class="wc-label" x="${W - R + 6}" y="${y(goal) + 4}">mål ${fmtKg(goal)}</text>` : "";
  const trend = pts.map((p, i) => `${i ? "L" : "M"}${x(p.date).toFixed(1)},${y(p.trend).toFixed(1)}`).join("");
  const last = pts[pts.length - 1];
  const dots = pts.map((p) => `<circle class="wc-dot" cx="${x(p.date).toFixed(1)}" cy="${y(p.kg).toFixed(1)}" r="4"/>`).join("");
  weightPoints = pts.map((p) => ({ ...p, px: x(p.date), py: y(p.kg), ty: y(p.trend) }));
  return `<div class="wc-wrap" id="wc-wrap">
    <svg viewBox="0 0 ${W} ${H}" class="wc" id="wc" role="img" aria-label="Vikt över tid med trendlinje">
      ${grid}${goalLine}
      <line class="wc-cross" id="wc-cross" x1="0" x2="0" y1="${T}" y2="${H - B}" visibility="hidden"/>
      ${pts.length > 1 ? `<path class="wc-trend" d="${trend}"/>` : ""}${dots}
      <text class="wc-label" x="${x(last.date) + 8}" y="${y(last.trend) + 4}">trend ${fmtKg(last.trend)}</text>
      ${xt}
      <rect x="${L}" y="${T}" width="${W - L - R}" height="${H - T - B}" fill="transparent" id="wc-hit"/>
    </svg>
    <div class="wc-tip" id="wc-tip" hidden></div>
  </div>
  <div class="wc-legend"><span><i class="wc-sw dot"></i>Vägning</span><span><i class="wc-sw line"></i>Trend, snitt 7 dagar</span>${goal ? '<span><i class="wc-sw goal"></i>Mål</span>' : ""}</div>`;
}

function viewWeight(range) {
  const t = today();
  const all = weightSeries();
  const from = range === "all" ? "0000" : addDays(t, -(+range || 90));
  const pts = all.filter((p) => p.date >= from);
  const goal = settings().weightGoal || null;
  const last = all[all.length - 1];
  const ago = last ? [...all].reverse().find((p) => p.date <= addDays(last.date, -30)) : null;
  const diff = last && ago ? last.trend - ago.trend : null;
  const hero = last
    ? `<div class="hero"><div class="hero-num">${fmtKg(last.kg)}<span> kg</span></div>
        <div class="hero-sub">${niceDate(last.date)}${diff != null ? ` · trend ${diff > 0 ? "+" : diff < 0 ? "−" : "±"}${fmtKg(Math.abs(diff))} kg på 30 dagar` : ""}${goal ? ` · ${fmtKg(Math.abs(last.trend - goal))} kg ${last.trend > goal ? "kvar" : "under"} till mål` : ""}</div></div>`
    : '<p class="hint">Inga vägningar än. Skriv in vikten under Mående på dagssidan, eller här nedanför.</p>';
  const filters = `<div class="seg wc-range" role="group" aria-label="Tidsperiod">${WEIGHT_RANGES.map(([v, l]) => `<a class="seg-btn ${range === v ? "on" : ""}" href="#weight/${v}">${l}</a>`).join("")}</div>`;
  const rows = [...pts].reverse().map((p, i, arr) => {
    const prev = arr[i + 1];
    const d = prev ? p.kg - prev.kg : null;
    return `<tr><td><a href="#day/${p.date}">${niceDate(p.date)}</a></td><td>${fmtKg(p.kg)}</td><td>${fmtKg(p.trend)}</td><td>${d == null ? "" : (d > 0 ? "+" : d < 0 ? "−" : "±") + fmtKg(Math.abs(d))}</td></tr>`;
  });
  return (
    head("Tracker", "Vikt", null, null) +
    block(
      "",
      `${hero}${filters}
       ${pts.length ? weightChart(pts, goal) : all.length ? '<p class="hint">Inga vägningar i den här perioden.</p>' : ""}
       <div class="row">
         <label class="field"><span>Dagens vikt, kg</span><input type="text" inputmode="decimal" data-change="weight" data-date="${t}" value="${dayRec(t).weight != null ? fmtKg(dayRec(t).weight) : ""}" /></label>
         <label class="field"><span>Målvikt, kg (valfritt)</span><input type="text" inputmode="decimal" data-change="weightGoal" value="${goal != null ? fmtKg(goal) : ""}" /></label>
       </div>`
    ) +
    (rows.length ? block("Vägningar", `<table class="wc-table"><thead><tr><th>Datum</th><th>Vikt</th><th>Trend</th><th>Ändring</th></tr></thead><tbody>${rows.join("")}</tbody></table>`) : "")
  );
}

// Hovring och tryck i grafen: närmaste vägning visas i en ruta.
function weightHover(ev) {
  const svg = $("#wc");
  if (!svg || !weightPoints.length) return;
  const box = svg.getBoundingClientRect();
  const vx = ((ev.clientX - box.left) / box.width) * svg.viewBox.baseVal.width;
  let best = weightPoints[0];
  for (const p of weightPoints) if (Math.abs(p.px - vx) < Math.abs(best.px - vx)) best = p;
  const cross = $("#wc-cross");
  cross.setAttribute("x1", best.px);
  cross.setAttribute("x2", best.px);
  cross.setAttribute("visibility", "visible");
  const tip = $("#wc-tip");
  tip.hidden = false;
  tip.innerHTML = `<b>${niceDate(best.date)}</b><br>${fmtKg(best.kg)} kg<br><span>trend ${fmtKg(best.trend)}</span>`;
  const scale = box.width / svg.viewBox.baseVal.width;
  const left = best.px * scale;
  tip.style.left = Math.min(box.width - 120, Math.max(0, left + 10)) + "px";
  tip.style.top = Math.max(0, best.py * scale - 60) + "px";
}
document.addEventListener("pointermove", (ev) => ev.target.closest && ev.target.closest("#wc") && weightHover(ev));
// ny bredd (t.ex. när telefonen vrids): rita om viktgrafen
let resizeTimer;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => route().view === "weight" && render(), 200);
});
document.addEventListener("pointerdown", (ev) => ev.target.closest && ev.target.closest("#wc") && weightHover(ev));
document.addEventListener("pointerleave", (ev) => {
  if (ev.target && ev.target.id === "wc") {
    $("#wc-tip") && ($("#wc-tip").hidden = true);
    $("#wc-cross")?.setAttribute("visibility", "hidden");
  }
}, true);

/* ---------------- Tacksamhet ---------------- */

function viewGratitude() {
  const days = live("days")
    .filter((d) => d.grateful)
    .sort((a, b) => b.id.localeCompare(a.id));
  const t = today();
  const rows = days.map((d) => `<li><a href="#day/${d.id}" class="g-date">${niceDate(d.id)}</a><span class="g-text">${esc(d.grateful)}</span></li>`);
  return (
    head("En sak om dagen", "Tacksamhet", null, null) +
    block(
      "Idag",
      `<textarea rows="2" data-change="grateful" data-date="${t}" placeholder="Vad är du tacksam för idag?">${esc(dayRec(t).grateful || "")}</textarea>`
    ) +
    block(`${days.length} dagar`, `<ul class="gratitude-list">${rows.join("") || '<li class="empty">Din första rad hamnar här.</li>'}</ul>`)
  );
}

/* ---------------- Födelsedagar ---------------- */

function viewBirthdays() {
  const t = today();
  const all = live("birthdays");
  const next = (b) => {
    let d = `${t.slice(0, 4)}-${b.md}`;
    if (d < t) d = `${+t.slice(0, 4) + 1}-${b.md}`;
    return d;
  };
  const sorted = all.map((b) => ({ b, d: next(b) })).sort((x, y) => x.d.localeCompare(y.d));
  const rows = sorted.map(({ b, d }) => {
    const days = daysBetween(t, d);
    const age = ageOn(b, d);
    return `<li data-act="editBirthday" data-id="${b.id}"><span class="bd-date">${+b.md.slice(3)} ${monthName("2000-" + b.md.slice(0, 2)).slice(0, 3)}</span>
      <span class="bd-name">${esc(b.name)}${age !== null ? ` <small>fyller ${age}</small>` : ""}</span>
      <span class="bd-when">${days === 0 ? "idag" : days === 1 ? "imorgon" : `om ${days} d`}</span></li>`;
  });
  return (
    head("Kom ihåg", "Födelsedagar", null, null) +
    block("", `<ul class="bd-list">${rows.join("") || '<li class="empty">Inga födelsedagar än.</li>'}</ul><button class="btn-primary" data-act="editBirthday">Lägg till födelsedag</button>`)
  );
}

/* ---------------- Tracker ---------------- */

function viewTracker(ym) {
  const t = today();
  const n = daysInMonth(ym);
  const dates = Array.from({ length: n }, (_, i) => `${ym}-${pad(i + 1)}`);
  const headRow = `<tr><th class="name"></th>${dates
    .map((d) => {
      const wd = parseYmd(d).getDay();
      return `<th class="${wd === 0 || wd === 6 ? "weekend" : ""}">${+d.slice(8)}</th>`;
    })
    .join("")}</tr>`;
  const cell = (d, cls, content = "", act = `data-act="goDay" data-date="${d}"`) =>
    `<td class="${d === t ? "today" : ""}"><button class="cell ${cls}" ${act}>${content}</button></td>`;

  const row = (name, fn) => `<tr><th class="name">${name}</th>${dates.map(fn).join("")}</tr>`;
  const rows = [
    row("Hälsa", (d) => cell(d, isSick(d) ? "on sick" : health(d) === "krasslig" ? "half sick" : "")),
    row("Humör", (d) => cell(d, dayRec(d).mood ? `lv${dayRec(d).mood}` : "")),
    row("Energi", (d) => cell(d, dayRec(d).energy ? `lv${dayRec(d).energy}` : "")),
    row("Vatten", (d) => cell(d, (dayRec(d).water || 0) >= WATER_GOAL ? "on" : (dayRec(d).water || 0) > 0 ? "half" : "")),
    row("Kalorier", (d) => {
      const t = mealTotals(d);
      const goal = settings().kcalGoal;
      return cell(d, !t.kcal ? "" : goal && t.kcal > goal * 1.1 ? "half" : "on", t.kcal ? Math.round(t.kcal / 100) : "");
    }),
    row("Protein", (d) => {
      const t = mealTotals(d);
      const goal = settings().proteinGoal;
      return cell(d, !t.p ? "" : !goal || t.p >= goal ? "on" : "half");
    }),
    row("Medicin", (d) => {
      const r = dayRec(d);
      const n = (r.medsAm ? 1 : 0) + (r.medsPm ? 1 : 0);
      return cell(d, n === 2 ? "on" : n || r.meds ? "half" : "");
    }),
    row("Steg", (d) => cell(d, (dayRec(d).steps || 0) >= STEP_GOAL ? "on" : (dayRec(d).steps || 0) > 0 ? "half" : "")),
    row("Träning", (d) => {
      const w = live("workouts").filter((x) => x.date === d);
      return cell(d, w.length ? "on" : "", w.map((x) => WORKOUT_TYPES[x.type][0]).join(""));
    }),
    row("Vikt", (d) => cell(d, dayRec(d).weight ? "on" : "")),
    row("Sömn 7h+", (d) => cell(d, (dayRec(d).sleep || 0) >= 7 ? "on" : dayRec(d).sleep ? "half" : "", dayRec(d).sleep ? Math.round(dayRec(d).sleep) : "")),
    row("Tacksamhet", (d) => cell(d, dayRec(d).grateful ? "on" : "")),
    ...(skincare() ? [row("Hudvård", (d) => {
      const st = skinStatus(d);
      return cell(d, st.all ? "on mig" : st.done ? "half" : "");
    })] : []),
    ...live("habits")
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
      .map((h) => row(esc(h.name), (d) => cell(d, isDone(h.id, d) ? "on mig" : "", "", `data-act="toggleHabit" data-id="${h.id}" data-date="${d}"`)))
  ];
  const routineRows = live("routines")
    .sort((a, b) => a.name.localeCompare(b.name, "sv"))
    .map((r) => row(esc(r.name), (d) => cell(d, isDone(r.id, d) ? "on hem" : "", "", `data-act="toggleRoutine" data-id="${r.id}" data-date="${d}"`)));

  return (
    head("Tracker", monthName(ym), `tracker/${addMonths(ym, -1)}`, `tracker/${addMonths(ym, 1)}`) +
    `<p class="hint center">Tryck på en ruta för att öppna dagen. Hushållsraderna bockas direkt.</p>
    <div class="tracker-scroll"><table class="tracker">
      <thead>${headRow}</thead>
      <tbody>${rows.join("")}<tr class="group"><th class="name">Hemmet</th><td colspan="${n}"></td></tr>${routineRows.join("")}</tbody>
    </table></div>
    <div class="legend"><span class="cell lv1"></span>tungt <span class="cell lv3"></span>okej <span class="cell lv5"></span>toppen</div>`
  );
}

/* ---------------- Rutiner ---------------- */

function viewRoutines() {
  const t = today();
  const infos = live("routines").map((r) => routineInfo(r, t));
  const row = (i) => `<li data-act="editRoutine" data-id="${i.r.id}"><span class="c-name">${esc(i.r.name)}<span class="c-meta">${
    i.r.mode === "weekday" ? "varje " + WD_LONG[i.r.weekday] : `var ${i.r.every}:e dag · ${i.label}`
  }</span></span>${i.due && !i.done ? '<span class="tag">dags</span>' : ""}</li>`;
  const byName = (a, b) => a.r.name.localeCompare(b.r.name, "sv");
  const zone = zoneForWeek(t);
  const zones = live("zones").sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const specials = missingSpecials()
    ? live("routines").length
      ? `<div class="banner"><span>Uppdaterade städspecialer: dammsugningen är uppdelad efter vad roboten inte hinner med.</span><button class="btn-small" data-act="addSpecials">Uppdatera</button></div>`
      : `<div class="banner"><span>Dina städspecialer: ${STADSPECIALER.routines.length} sysslor och ${STADSPECIALER.zones.length} zoner.</span><button class="btn-small" data-act="addSpecials">Lägg in mina städspecialer</button></div>`
    : "";
  return (
    head("Hemmet och vardagen", "Rutiner", null, null) +
    specials +
    block("Med intervall", `<ul class="chores linked">${infos.filter((i) => i.r.mode !== "weekday").sort(byName).map(row).join("")}</ul>`) +
    block("Fasta veckodagar", `<ul class="chores linked">${infos.filter((i) => i.r.mode === "weekday").sort(byName).map(row).join("") || '<li class="empty">Inga än.</li>'}</ul>`) +
    `<button class="btn-primary" data-act="editRoutine">Ny rutin</button>` +
    block(
      "Hur mycket per dag?",
      `<p class="hint">Högst så här många sysslor föreslås per dag. Dagliga sysslor räknas inte, och en full kalender ger färre.</p>
       <div class="row">
         <label class="field"><span>Måndag till fredag</span><input type="number" inputmode="numeric" min="0" max="10" data-change="choresWeekday" value="${settings().choresWeekday ?? DEFAULT_CHORES.weekday}" /></label>
         <label class="field"><span>Lördag och söndag</span><input type="number" inputmode="numeric" min="0" max="10" data-change="choresWeekend" value="${settings().choresWeekend ?? DEFAULT_CHORES.weekend}" /></label>
       </div>`
    ) +
    (skincare()
      ? block(
          "Hudvård, kväll",
          `<p class="hint">Tryck på en dag för att ändra stegen.</p>
           <ul class="chores linked">${[1, 2, 3, 4, 5, 6, 0]
             .map((wd) => {
               const steps = skincare().days?.[wd] || [];
               const special = steps.filter((st) => !BASE.includes(st) && !EYES.includes(st));
               return `<li data-act="editSkin" data-wd="${wd}"><span class="c-name">${WD_LONG[wd]}<span class="c-meta">${esc(special.join(", ") || steps.length + " steg")}</span></span></li>`;
             })
             .join("")}</ul>`
        )
      : `<div class="banner"><span>Din hudvårdsrutin för kvällen, en variant per veckodag.</span><button class="btn-small" data-act="addSkincare">Lägg in hudvård</button></div>`) +
    block(
      "Dagliga vanor",
      `<p class="hint">Bockas av i dagvyn och syns i veckans och månadens tracker.</p>
       <ul class="chores linked">${live("habits")
         .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
         .map((h) => `<li data-act="editHabit" data-id="${h.id}"><span class="c-name">${esc(h.name)}</span></li>`)
         .join("") || '<li class="empty">Inga vanor än.</li>'}</ul>
       <button class="btn-small ghost" data-act="editHabit">Ny vana</button>`
    ) +
    block(
      "Zoner",
      `<p class="hint">En zon i veckan, i tur och ordning. Den här veckan: <b>${esc(zone ? zone.name : "ingen")}</b>.</p>
       ${zones.length ? "" : '<p class="hint">Inga zoner än. Lägg till rum, t.ex. Kök eller Tvättstuga, med det som ska göras där.</p>'}
       <ul class="chores linked">${zones.map((z) => `<li data-act="editZone" data-id="${z.id}"><span class="c-name">${esc(z.name)}<span class="c-meta">${esc((z.tasks || []).join(", "))}</span></span>${zone && z.id === zone.id ? '<span class="tag">denna vecka</span>' : ""}</li>`).join("")}</ul>
       <button class="btn-small ghost" data-act="editZone">Ny zon</button>`
    )
  );
}

/* ---------------- Nyckel ---------------- */

function viewKey() {
  const r = (k, label) => `<li><span class="sym static">${sym(k)}</span><span>${label}</span></li>`;
  const s = (c, label) => `<li><span class="sym static txt">${c}</span><span>${label}</span></li>`;
  return (
    head("Så läser du sidorna", "Nyckel", null, null) +
    block(
      "",
      `<ul class="key-list">${r("open", "Uppgift")}${r("done", "Klar")}${r("started", "Påbörjad")}${r("migrated", "Framflyttad")}${r("struck", "Struken")}</ul>
       <ul class="key-list">${r("event", "Event")}${r("meeting", "Möte")}${r("note", "Notering")}${r("birthday", "Födelsedag")}</ul>
       <ul class="key-list">${s("!", "Deadline")}${s("*", "Viktigt")}${s("?", "Kolla upp")}</ul>
       <p class="hint">Tryck på rutan för att gå uppgift, påbörjad, klar. Tryck på texten för att flytta fram, stryka eller ändra.</p>
       <p class="hint">Snabbskriv: <code>o</code> event, <code>m</code> möte, <code>.</code> notering, <code>!</code> <code>*</code> <code>?</code> först på raden, och <code>14:00</code> för tid.</p>`
    )
  );
}

/* ---------------- Inställningar ---------------- */

function viewSettings() {
  const s = settings();
  const gcal = get("meta", "gcal");
  const tokenOk = local.gToken && local.gTokenExp > Date.now();
  return (
    head("Inställningar", "Inställningar", null, null) +
    block(
      "Synk",
      `<p class="hint">Samma nyckel på mobil och dator, så delar de data. Nyckeln sätts i workern med <code>wrangler secret put JOURNAL_KEY</code>.</p>
       <label class="field"><span>Workerns adress</span><input data-change="workerUrl" value="${esc(workerUrl())}" autocomplete="off" /></label>
       <label class="field"><span>Synknyckel</span><input type="password" data-change="syncKey" value="${esc(local.syncKey || "")}" autocomplete="off" /></label>
       <p class="hint" id="sync-status">${esc(syncStatusText())}</p>
       <button class="btn-small" data-act="syncNow">Synka nu</button>`
    ) +
    block(
      "Notiser",
      `<p class="hint">06:30 morgonsammanfattning med deadlines och födelsedagar, 20:30 migrering. Kräver synknyckel.</p>
       <div class="btn-row"><button class="btn-small" data-act="enablePush">Slå på på den här enheten</button>
       <button class="btn-small ghost" data-act="testPush" data-which="morning">Testa morgon</button>
       <button class="btn-small ghost" data-act="testPush" data-which="evening">Testa kväll</button></div>`
    ) +
    block(
      "Mat",
      `<div class="row">
         <label class="field"><span>Kalorier per dag</span><input type="number" inputmode="numeric" min="0" step="50" data-change="kcalGoal" value="${esc(settings().kcalGoal || "")}" placeholder="t.ex. 2000" /></label>
         <label class="field"><span>Protein per dag, gram</span><input type="number" inputmode="numeric" min="0" step="5" data-change="proteinGoal" value="${esc(settings().proteinGoal || "")}" placeholder="t.ex. 120" /></label>
       </div>
       <h3>Mina maträtter</h3>
       <ul class="chores linked">${live("foods")
         .sort((a, b) => a.name.localeCompare(b.name, "sv"))
         .map((f) => `<li data-act="editFood" data-id="${f.id}"><span class="c-name">${esc(f.name)}<span class="c-meta">${f.per100 ? "per 100 g: " : "per portion: "}${macroLine(f)}</span></span></li>`)
         .join("") || '<li class="empty">Inga sparade än.</li>'}</ul>`
    ) +
    block(
      "Google Kalender",
      `<p class="hint">Läses bara. Inget skrivs till Google.</p>
       <label class="field"><span>OAuth klient ID</span><input data-change="clientId" value="${esc(s.gcalClientId || DEFAULT_GCAL_CLIENT_ID)}" placeholder="xxxx.apps.googleusercontent.com" /></label>
       <div class="btn-row"><button class="btn-small" data-act="gcalConnect">${tokenOk ? "Hämta igen" : "Koppla och hämta"}</button>
       ${local.gToken ? '<button class="btn-small ghost" data-act="gcalDisconnect">Koppla från</button>' : ""}</div>
       ${gcal && gcal.calendars ? `<h3>Vilka kalendrar ska synas?</h3><ul class="cal-choose">${gcal.calendars
         .map((c) => `<li><label class="check-field"><input type="checkbox" data-change="gcalCal" data-id="${esc(c.id)}" ${chosenCalendars(gcal.calendars).includes(c.id) ? "checked" : ""} />
           <span class="cal-dot" style="background:${esc(c.color || "#999")}"></span>${esc(c.name)}${c.primary ? " <small>(huvudkalender)</small>" : ""}</label></li>`)
         .join("")}</ul>` : ""}
       ${(settings().gcalHiddenTitles || []).length || (settings().gcalHiddenKeys || []).length
         ? `<h3>Dolda i appen</h3><ul class="chores">${(settings().gcalHiddenTitles || [])
             .map((t) => `<li><span class="c-name">Alla "${esc(t)}"</span><button class="plus-btn" data-act="gcalUnhide" data-kind="title" data-val="${esc(t)}">visa igen</button></li>`)
             .join("")}${(settings().gcalHiddenKeys || []).length ? `<li><span class="c-name">${settings().gcalHiddenKeys.length} enstaka händelser</span><button class="plus-btn" data-act="gcalUnhide" data-kind="keys">visa igen</button></li>` : ""}</ul>`
         : ""}
       <p class="hint">${gcal && gcal.fetchedAt ? `Senast hämtat ${new Date(gcal.fetchedAt).toLocaleString("sv-SE")}, ${gcal.events.length} händelser.` : "Inte hämtat än."}</p>`
    ) +
    block(
      "Data",
      `<div class="btn-row"><button class="btn-small ghost" data-act="export">Exportera</button>
       <label class="btn-small ghost file-btn">Importera<input type="file" accept="application/json" data-change="import" hidden /></label></div>`
    )
  );
}

/* ---------------- Dialog ---------------- */

const sheet = () => $("#sheet");

// Öppnar en meny eller ett formulär. Resolvar med knappens värde och fälten.
// Stänger dialogen och väntar tills stängningshändelsen har körts klart,
// så den inte råkar stänga eller avsluta nästa dialog som öppnas direkt.
function closeSheet() {
  const dlg = sheet();
  if (!dlg.open) return Promise.resolve();
  return new Promise((resolve) => {
    dlg.addEventListener("close", () => setTimeout(resolve, 0), { once: true });
    dlg.close();
  });
}

async function openSheet(title, fields, buttons) {
  await closeSheet();
  const dlg = sheet();
  dlg.innerHTML = `<form method="dialog" class="sheet-form">
    ${title ? `<p class="sheet-title">${title}</p>` : ""}
    ${fields || ""}
    <div class="sheet-buttons">${buttons
      .map((b) => `<button value="${b.value}" class="${b.cls || ""}" ${b.novalidate ? "formnovalidate" : ""}>${b.label}</button>`)
      .join("")}</div>
  </form>`;
  return new Promise((resolve) => {
    dlg.onclose = () => {
      const data = Object.fromEntries(new FormData(dlg.querySelector("form")));
      resolve({ action: dlg.returnValue, data });
    };
    dlg.returnValue = "";
    dlg.showModal();
    const first = dlg.querySelector("input, textarea, select");
    if (first && !("ontouchstart" in window)) first.focus();
  });
}
const CLOSE = { value: "close", label: "Stäng", cls: "ghost", novalidate: true };

async function entryMenu(id) {
  const e = get("entries", id);
  if (!e) return;
  const isTask = e.type === "task";
  const buttons = [
    ...(isTask
      ? [
          { value: "done", label: `${sym("done")} Klar` },
          { value: "started", label: `${sym("started")} Påbörjad` },
          { value: "open", label: `${sym("open")} Uppgift (öppen)` },
          { value: "struck", label: `${sym("struck")} Stryk` }
        ]
      : []),
    { value: "tomorrow", label: `${sym("migrated")} Flytta till imorgon` },
    { value: "pickDate", label: `${sym("migrated")} Flytta till dag...` },
    { value: "pickMonth", label: `${sym("migrated")} Flytta till månad...` },
    ...(e.parent ? [] : [{ value: "sub", label: "Lägg till delsteg" }]),
    { value: "edit", label: "Ändra" },
    { value: "delete", label: "Ta bort", cls: "danger" },
    CLOSE
  ];
  const { action } = await openSheet(`${e.sig ? esc(e.sig) + " " : ""}${esc(e.text)}`, "", buttons);
  const base = e.date || today();
  if (["done", "started", "open", "struck"].includes(action)) {
    put("entries", { ...e, status: action });
    if (e.routine && action === "done") setDone(e.routine, e.date, true);
  } else if (action === "tomorrow") moveEntry(e, { date: addDays(base, 1) });
  else if (action === "pickDate") {
    const r = await openSheet("Flytta till dag", `<label class="field"><span>Datum</span><input type="date" name="date" value="${addDays(base, 1)}" required /></label>`, [
      { value: "ok", label: "Flytta", cls: "btn-primary" },
      CLOSE
    ]);
    if (r.action === "ok" && r.data.date) moveEntry(e, { date: r.data.date });
  } else if (action === "pickMonth") {
    const r = await openSheet("Flytta till månad", `<label class="field"><span>Månad</span><input type="month" name="month" value="${addMonths(base.slice(0, 7), 1)}" required /></label>`, [
      { value: "ok", label: "Flytta", cls: "btn-primary" },
      CLOSE
    ]);
    if (r.action === "ok" && r.data.month) moveEntry(e, { month: r.data.month });
  } else if (action === "edit") {
    const r = await openSheet(
      "Ändra",
      `<label class="field"><span>Text</span><input name="text" value="${esc(e.text)}" required /></label>
       <div class="row">
         <label class="field"><span>Typ</span><select name="type">${Object.entries(TYPE_LABEL).map(([k, v]) => `<option value="${k}" ${e.type === k ? "selected" : ""}>${v}</option>`).join("")}</select></label>
         <label class="field"><span>Markering</span><select name="sig"><option value="">Ingen</option>${Object.entries(SIG_LABEL).map(([k, v]) => `<option value="${k}" ${e.sig === k ? "selected" : ""}>${k} ${v}</option>`).join("")}</select></label>
         ${e.date ? `<label class="field"><span>Tid</span><input type="time" name="time" value="${e.time || ""}" /></label>` : ""}
       </div>`,
      [{ value: "ok", label: "Spara", cls: "btn-primary" }, CLOSE]
    );
    if (r.action === "ok") {
      const next = { ...e, text: r.data.text.trim() || e.text, type: r.data.type, sig: r.data.sig };
      if (e.date) next.time = r.data.time || undefined;
      put("entries", next);
    }
  } else if (action === "sub") {
    const r = await openSheet("Delsteg till: " + esc(e.text), `<label class="field"><span>Delsteg</span><input name="text" required /></label>`, [
      { value: "ok", label: "Lägg till", cls: "btn-primary" },
      CLOSE
    ]);
    if (r.action === "ok" && r.data.text.trim()) {
      const scope = e.date ? { date: e.date } : e.month ? { month: e.month } : { coll: e.coll };
      addEntry({ ...scope, parent: e.id }, r.data.text);
    }
  } else if (action === "delete") {
    childrenOf(id).forEach((c) => remove("entries", c.id));
    remove("entries", id);
  }
  render();
}

async function migrateDialog() {
  const items = openBacklog();
  if (!items.length) return render();
  const rows = items
    .map(
      (e) => `<li><span class="sig">${esc(e.sig || "")}</span><span class="sym static">${entrySym(e)}</span>
      <span class="txt">${esc(e.text)}<span class="e-from">${e.date ? niceDate(e.date) : monthName(e.month)}</span></span>
      <span class="mig-actions">
        <button type="button" class="btn-small" data-mig="today" data-id="${e.id}">Idag</button>
        <button type="button" class="btn-small ghost" data-mig="tomorrow" data-id="${e.id}">Imorgon</button>
        <button type="button" class="btn-small ghost" data-mig="month" data-id="${e.id}" title="Nästa månad">Senare</button>
        <button type="button" class="btn-small ghost" data-mig="struck" data-id="${e.id}" aria-label="Stryk">${sym("struck")}</button>
      </span></li>`
    )
    .join("");
  await openSheet("Migrering", `<p class="hint">Spelar det här fortfarande roll? Flytta hit, skjut fram eller stryk.</p><ul class="migrate-list">${rows}</ul>`, [
    { value: "close", label: "Klar", cls: "btn-primary", novalidate: true }
  ]);
  render();
}

async function routineDialog(id) {
  const r = id ? get("routines", id) : { mode: "interval", every: 7, cat: "hem" };
  const res = await openSheet(
    id ? "Ändra rutin" : "Ny rutin",
    `<label class="field"><span>Namn</span><input name="name" value="${esc(r.name || "")}" required maxlength="60" /></label>
     <div class="row">
       <label class="field"><span>Upprepas</span><select name="mode">
         <option value="interval" ${r.mode !== "weekday" ? "selected" : ""}>Med intervall</option>
         <option value="weekday" ${r.mode === "weekday" ? "selected" : ""}>Fast veckodag</option></select></label>
       <label class="field"><span>Var n:e dag</span><input type="number" name="every" min="1" max="365" value="${r.every || 7}" /></label>
       <label class="field"><span>Veckodag</span><select name="weekday">${[1, 2, 3, 4, 5, 6, 0].map((d) => `<option value="${d}" ${r.weekday === d ? "selected" : ""}>${WD_LONG[d]}</option>`).join("")}</select></label>
     </div>`,
    [{ value: "ok", label: "Spara", cls: "btn-primary" }, ...(id ? [{ value: "delete", label: "Ta bort", cls: "danger", novalidate: true }] : []), CLOSE]
  );
  if (res.action === "ok") {
    put("routines", {
      since: today(),
      ...r,
      id: id || "r-" + uid(),
      name: res.data.name.trim(),
      mode: res.data.mode,
      every: Math.max(1, +res.data.every || 7),
      weekday: +res.data.weekday,
      cat: r.cat || "hem"
    });
  } else if (res.action === "delete") remove("routines", id);
  render();
}

async function zoneDialog(id) {
  const z = id ? get("zones", id) : { tasks: [] };
  const res = await openSheet(
    id ? "Ändra zon" : "Ny zon",
    `<label class="field"><span>Namn</span><input name="name" value="${esc(z.name || "")}" required /></label>
     <label class="field"><span>Uppgifter, en per rad</span><textarea name="tasks" rows="5">${esc((z.tasks || []).join("\n"))}</textarea></label>`,
    [{ value: "ok", label: "Spara", cls: "btn-primary" }, ...(id ? [{ value: "delete", label: "Ta bort", cls: "danger", novalidate: true }] : []), CLOSE]
  );
  if (res.action === "ok") {
    const tasks = res.data.tasks.split("\n").map((s) => s.trim()).filter(Boolean);
    put("zones", { ...z, id: id || "z-" + uid(), name: res.data.name.trim(), tasks, order: z.order ?? live("zones").length });
  } else if (res.action === "delete") remove("zones", id);
  render();
}

async function birthdayDialog(id) {
  const b = id ? get("birthdays", id) : {};
  const dateVal = b.md ? `${b.year || 2000}-${b.md}` : "";
  const res = await openSheet(
    id ? "Ändra födelsedag" : "Ny födelsedag",
    `<label class="field"><span>Namn</span><input name="name" value="${esc(b.name || "")}" required /></label>
     <label class="field"><span>Födelsedatum</span><input type="date" name="date" value="${dateVal}" required /></label>
     <label class="check-field"><input type="checkbox" name="noYear" ${b.md && !b.year ? "checked" : ""} /> Jag vet inte året</label>`,
    [{ value: "ok", label: "Spara", cls: "btn-primary" }, ...(id ? [{ value: "delete", label: "Ta bort", cls: "danger", novalidate: true }] : []), CLOSE]
  );
  if (res.action === "ok" && res.data.date) {
    const year = res.data.noYear ? null : +res.data.date.slice(0, 4);
    put("birthdays", { id: id || "b-" + uid(), name: res.data.name.trim(), md: res.data.date.slice(5), year });
  } else if (res.action === "delete") remove("birthdays", id);
  render();
}

async function habitDialog(id) {
  const h = id ? get("habits", id) : {};
  const res = await openSheet(id ? "Ändra vana" : "Ny vana", `<label class="field"><span>Namn</span><input name="name" value="${esc(h.name || "")}" required maxlength="40" /></label>`, [
    { value: "ok", label: "Spara", cls: "btn-primary" },
    ...(id ? [{ value: "delete", label: "Ta bort", cls: "danger", novalidate: true }] : []),
    CLOSE
  ]);
  if (res.action === "ok") put("habits", { ...h, id: id || "h-" + uid(), name: res.data.name.trim(), order: h.order ?? live("habits").length });
  else if (res.action === "delete") remove("habits", id);
  render();
}

async function collMenu(id) {
  const c = getColl(id);
  const res = await openSheet(
    "Samling",
    `<label class="field"><span>Namn</span><input name="name" value="${esc(c.name)}" required /></label>
     <label class="field"><span>Visa som</span><select name="view"><option value="list">Lista</option><option value="shelf" ${c.view === "shelf" ? "selected" : ""}>Bokhylla</option></select></label>`,
    [
    { value: "ok", label: "Spara", cls: "btn-primary" },
    { value: "delete", label: "Ta bort samlingen", cls: "danger", novalidate: true },
    CLOSE
  ]);
  if (res.action === "ok") put("collections", { ...c, name: res.data.name.trim(), view: res.data.view });
  else if (res.action === "delete") {
    live("entries").filter((e) => e.coll === id).forEach((e) => remove("entries", e.id));
    remove("collections", id);
    return go("index");
  }
  render();
}

async function handleMig(btn) {
  const e = get("entries", btn.dataset.id);
  if (!e) return;
  const inSheet = sheet().open && sheet().contains(btn);
  const kind = btn.dataset.mig;
  if (kind === "today") moveEntry(e, { date: today() });
  else if (kind === "tomorrow") moveEntry(e, { date: addDays(today(), 1) });
  else if (kind === "month") moveEntry(e, { month: addMonths(today().slice(0, 7), 1) });
  else if (kind === "pick") {
    const r = await openSheet("Flytta till dag", `<label class="field"><span>Datum</span><input type="date" name="date" value="${addDays(today(), 1)}" required /></label>`, [
      { value: "ok", label: "Flytta", cls: "btn-primary" },
      CLOSE
    ]);
    if (r.action !== "ok" || !r.data.date) return render();
    moveEntry(e, { date: r.data.date });
  } else put("entries", { ...e, status: "struck" });
  if (inSheet) {
    btn.closest("li").remove();
    if (!sheet().querySelector(".migrate-list li")) sheet().close();
  } else render();
}

/* ---------------- Händelser ---------------- */

const actions = {
  cycle: (d) => {
    const e = get("entries", d.id);
    if (e && e.type === "task") cycleStatus(e);
    else if (e) entryMenu(d.id);
    render();
  },
  entryMenu: (d) => entryMenu(d.id),
  migrate: () => migrateDialog(),
  goDay: (d) => go(`day/${d.date}`),
  toggleRoutine: (d) => {
    setDone(d.id, d.date, !isDone(d.id, d.date));
    render();
  },
  toggleZone: (d) => {
    const key = zoneKey({ id: d.zone }, d.task);
    setDone(key, d.week, !isDone(key, d.week));
    render();
  },
  choreToLog: (d) => {
    const r = get("routines", d.id);
    put("entries", { id: uid(), type: "task", text: r.name, sig: "", status: "open", date: d.date, order: Date.now(), routine: r.id });
    render();
  },
  allChores: () => {
    showAllChores = !showAllChores;
    render();
  },
  addWorkout: (d) => {
    put("workouts", { id: "w-" + uid(), date: d.date, type: d.type });
    toast(`${WORKOUT_TYPES[d.type]} loggat`);
    render();
  },
  workoutMenu: async (d) => {
    const w = get("workouts", d.id);
    const res = await openSheet(WORKOUT_TYPES[w.type], "", [{ value: "delete", label: "Ta bort passet", cls: "danger" }, CLOSE]);
    if (res.action === "delete") remove("workouts", d.id);
    render();
  },
  setScale: (d) => {
    const cur = dayRec(d.date)[d.field];
    setDay(d.date, { [d.field]: cur === +d.val ? null : +d.val });
    render();
  },
  setWater: (d) => {
    const cur = dayRec(d.date).water || 0;
    setDay(d.date, { water: cur === +d.val ? +d.val - 1 : +d.val });
    render();
  },
  toggleMeal: (d) => {
    const meals = [...(dayRec(d.date).meals || [false, false, false])];
    meals[+d.i] = !meals[+d.i];
    setDay(d.date, { meals });
    render();
  },
  skipChores: (d) => {
    const on = !dayRec(d.date).skipChores;
    setDay(d.date, { skipChores: on });
    if (on) toast("Sysslorna kommer imorgon i stället");
    render();
  },
  setHealth: (d) => {
    setDay(d.date, { health: d.val || null, sick: d.val === "sjuk" });
    render();
  },
  toggleMeds: (d) => {
    setDay(d.date, { [d.key]: !dayRec(d.date)[d.key] });
    render();
  },
  editRoutine: (d) => routineDialog(d.id),
  editZone: (d) => zoneDialog(d.id),
  editBirthday: (d) => birthdayDialog(d.id),
  editHabit: (d) => habitDialog(d.id),
  gcalMenu: async (d) => {
    const res = await openSheet(esc(d.title), '<p class="hint">Från Google Kalender. Att dölja påverkar bara appen, inte din kalender.</p>', [
      { value: "one", label: "Dölj den här" },
      { value: "all", label: `Dölj alla som heter "${esc(d.title)}"` },
      CLOSE
    ]);
    const s = settings();
    if (res.action === "one") put("meta", { ...s, gcalHiddenKeys: [...new Set([...(s.gcalHiddenKeys || []), d.key])] });
    else if (res.action === "all") put("meta", { ...s, gcalHiddenTitles: [...new Set([...(s.gcalHiddenTitles || []), d.title.trim()])] });
    else return;
    toast("Dold. Ta fram den igen under Inställningar.");
    render();
  },
  gcalUnhide: (d) => {
    const s = settings();
    if (d.kind === "title") put("meta", { ...s, gcalHiddenTitles: (s.gcalHiddenTitles || []).filter((t) => t !== d.val) });
    else put("meta", { ...s, gcalHiddenKeys: [] });
    render();
  },
  addSkincare: () => {
    if (!skincare()) put("meta", { id: "skincare", days: SKINCARE_PRESET });
    toast("Hudvårdsrutinen är inlagd");
    render();
  },
  toggleSkin: (d) => {
    const k = skinKey(d.step);
    setDone(k, d.date, !isDone(k, d.date));
    if (skinStatus(d.date).all) toast("Hudvården klar för ikväll");
    render();
  },
  skinAll: (d) => {
    skinStepsOn(d.date).forEach((st) => isDone(skinKey(st), d.date) || setDone(skinKey(st), d.date, true));
    render();
  },
  editSkin: async (d) => {
    const wd = +d.wd;
    const sc = skincare();
    const res = await openSheet(
      "Hudvård " + WD_LONG[wd],
      `<label class="field"><span>Ett steg per rad, i ordning</span><textarea name="steps" rows="9">${esc((sc.days?.[wd] || []).join("\n"))}</textarea></label>`,
      [{ value: "ok", label: "Spara", cls: "btn-primary" }, CLOSE]
    );
    if (res.action === "ok") {
      const steps = res.data.steps.split("\n").map((x) => x.trim()).filter(Boolean);
      put("meta", { ...sc, days: { ...sc.days, [wd]: steps } });
    }
    render();
  },
  addFood: (d) => openFoodSearch(d.date, d.meal),
  mealMenu: (d) => {
    const m = get("meals", d.id);
    foodCtx = { date: m.date, meal: m.meal };
    const src = m.src || { per100: false, kcal: m.kcal, p: m.p, f: m.f, c: m.c };
    portionDialog({ ...src, name: m.name, mine: true }, m);
  },
  editFood: async (d) => {
    const f = get("foods", d.id);
    const res = await openSheet(
      "Min maträtt",
      `<label class="field"><span>Namn</span><input name="name" value="${esc(f.name)}" required /></label>
       <p class="hint">${f.per100 ? "Per 100 g" : "Per portion"}</p>
       <div class="row">
         <label class="field"><span>Kalorier</span><input name="kcal" type="number" inputmode="decimal" step="any" value="${f.kcal ?? ""}" /></label>
         <label class="field"><span>Protein g</span><input name="p" type="number" inputmode="decimal" step="any" value="${f.p ?? ""}" /></label>
       </div>
       <div class="row">
         <label class="field"><span>Fett g</span><input name="f" type="number" inputmode="decimal" step="any" value="${f.f ?? ""}" /></label>
         <label class="field"><span>Kolhydrater g</span><input name="c" type="number" inputmode="decimal" step="any" value="${f.c ?? ""}" /></label>
       </div>`,
      [{ value: "ok", label: "Spara", cls: "btn-primary" }, { value: "delete", label: "Ta bort", cls: "danger", novalidate: true }, CLOSE]
    );
    const n = (k) => parseFloat(String(res.data[k] || 0).replace(",", ".")) || 0;
    if (res.action === "ok") put("foods", { ...f, name: res.data.name.trim(), kcal: n("kcal"), p: n("p"), f: n("f"), c: n("c") });
    else if (res.action === "delete") remove("foods", f.id);
    render();
  },
  addSpecials: () => {
    addSpecials();
    toast("Städspecialerna är inlagda");
    render();
  },
  toggleHabit: (d) => {
    setDone(d.id, d.date, !isDone(d.id, d.date));
    render();
  },
  collMenu: (d) => collMenu(d.id),
  syncNow: () => syncNow(true),
  enablePush: () => enablePush(),
  testPush: (d) => testPush(d.which),
  search: async () => {
    await closeSheet();
    const dlg = sheet();
    dlg.innerHTML = `<form method="dialog" class="sheet-form search-sheet">
      <input type="search" id="global-search" placeholder="Sök i hela boken..." value="${esc(searchQuery)}" autocomplete="off" />
      <div id="global-results">${searchResults()}</div>
      <div class="sheet-buttons"><button value="close" class="ghost">Stäng</button></div>
    </form>`;
    dlg.onclose = null;
    dlg.showModal();
    const input = dlg.querySelector("#global-search");
    input.focus();
    input.select();
  },
  capture: async () => {
    const res = await openSheet("Brain dump", `<label class="field"><span>Vad snurrar i huvudet?</span><textarea name="text" rows="4" required></textarea></label><p class="hint">En rad per tanke.</p>`, [
      { value: "ok", label: "Spara", cls: "btn-primary" },
      CLOSE
    ]);
    if (res.action === "ok") {
      const lines = res.data.text.split("\n").map((l) => l.trim()).filter(Boolean);
      lines.forEach((l) => addEntry({ coll: "c-braindump" }, l, { type: "note" }));
      if (lines.length) toast(`${lines.length} ${lines.length === 1 ? "tanke" : "tankar"} sparade`);
      render();
    }
  },
  gcalConnect: () => gcalConnect(),
  gcalDisconnect: () => {
    if (local.gToken && window.google?.accounts?.oauth2) google.accounts.oauth2.revoke(local.gToken, () => {});
    delete local.gToken;
    delete local.gTokenExp;
    saveLocal();
    render();
  },
  export: () => {
    const blob = new Blob([JSON.stringify(state, null, 1)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `bellas-bullet-${today()}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  }
};

document.addEventListener("click", (ev) => {
  const chip = ev.target.closest("[data-chip]");
  if (chip) {
    const form = chip.closest("form");
    const group = chip.dataset.chip;
    const wasOn = chip.classList.contains("on");
    form.querySelectorAll(`[data-chip="${group}"]`).forEach((c) => c.classList.remove("on"));
    if (group === "type" || !wasOn) chip.classList.add("on");
    form.querySelector("input[name=text]").focus();
    return;
  }
  const fp = ev.target.closest("[data-food-pick]");
  if (fp) return pickFood({ ...foodResults[fp.dataset.foodPick] });
  const fa = ev.target.closest("[data-food-act]");
  if (fa) {
    if (fa.dataset.foodAct === "scan") scanBarcode();
    else if (fa.dataset.foodAct === "manual") manualFood();
    else if (fa.dataset.foodAct === "code") lookupBarcode($("#scan-code").value);
    return;
  }
  const mig = ev.target.closest("[data-mig]");
  if (mig) {
    handleMig(mig);
    return;
  }
  if (ev.target.closest("#global-results a")) sheet().close();
  const el = ev.target.closest("[data-act]");
  if (el && actions[el.dataset.act]) {
    ev.preventDefault();
    actions[el.dataset.act](el.dataset, el);
  }
});

document.addEventListener("submit", (ev) => {
  const form = ev.target;
  if (form.dataset.form === "log") {
    ev.preventDefault();
    const input = form.querySelector("input[name=text]");
    const scope = {};
    for (const k of ["date", "month", "coll"]) if (form.dataset[k]) scope[k] = form.dataset[k];
    const preset = {
      type: form.querySelector('[data-chip="type"].on')?.dataset.val,
      sig: form.querySelector('[data-chip="sig"].on')?.dataset.val
    };
    addEntry(scope, input.value, preset);
    const keep = form.closest("section")?.querySelector("h2")?.textContent;
    render();
    // behåll fokus i samma formulär så man kan skriva flera rader i rad
    const again = [...document.querySelectorAll('form[data-form="log"]')].find((f) => f.closest("section")?.querySelector("h2")?.textContent === keep && Object.keys(scope).every((k) => f.dataset[k] === scope[k]));
    again?.querySelector("input[name=text]").focus();
  } else if (form.dataset.form === "plan") {
    ev.preventDefault();
    const input = form.querySelector("input[name=text]");
    const { scope, rest } = parseWhen(input.value);
    const e = addEntry(scope, rest);
    if (e) planned.unshift({ e, where: whereLabel(scope) });
    render();
    $("#plan-input")?.focus();
  } else if (form.dataset.form === "dayNote") {
    ev.preventDefault();
    addEntry({ date: today() }, form.text.value, { type: "note" });
    toast("Sparat i dagens logg");
    render();
  } else if (form.dataset.form === "newColl") {
    ev.preventDefault();
    const name = form.name.value.trim();
    if (!name) return;
    const id = "c-" + uid();
    put("collections", { id, name });
    go(`coll/${id}`);
  }
});

let searchTimer;
document.addEventListener("keydown", (e) => {
  const typing = e.target.closest("input, textarea, select");
  if ((e.key === "k" && (e.ctrlKey || e.metaKey)) || (e.key === "/" && !typing)) {
    e.preventDefault();
    if (!sheet().open) actions.search();
  }
});
document.addEventListener("input", (ev) => {
  const el = ev.target;
  if (el.id === "food-q") {
    clearTimeout(foodTimer);
    const q = el.value.trim();
    if (q.length < 2) return;
    foodTimer = setTimeout(() => runFoodSearch(q), 300);
    return;
  }
  if (el.id === "portion-amount") {
    const f = JSON.parse($("#portion-food").value);
    const a = parseFloat(el.value.replace(",", ".")) || 0;
    const k = f.per100 ? a / 100 : a;
    $("#portion-preview").textContent = macroLine({ kcal: (f.kcal || 0) * k, p: (f.p || 0) * k, f: (f.f || 0) * k, c: (f.c || 0) * k });
    return;
  }
  if (el.id === "plan-input") {
    const prev = $("#plan-preview");
    if (!el.value.trim()) return (prev.textContent = "");
    const { scope, rest } = parseWhen(el.value);
    const p = parseQuick(rest, {});
    prev.textContent = p.text ? `${TYPE_LABEL[p.type]}${p.sig ? " " + p.sig : ""}${p.time ? " kl " + p.time : ""} → ${whereLabel(scope)}` : "";
    return;
  }
  if (el.id === "global-search") {
    searchQuery = el.value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => ($("#global-results").innerHTML = searchResults()), 100);
    return;
  }
  if (el.dataset.change === "search") {
    searchQuery = el.value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => ($("#search-results").innerHTML = searchResults()), 120);
  }
});

document.addEventListener("change", async (ev) => {
  const el = ev.target;
  const c = el.dataset.change;
  if (!c) return;
  if (c === "steps") setDay(el.dataset.date, { steps: Math.max(0, parseInt(el.value, 10) || 0) });
  else if (c === "grateful") setDay(el.dataset.date, { grateful: el.value.trim() });
  else if (c === "work") setDay(el.dataset.date, { work: el.value.trim() });
  else if (c === "weight") {
    const kg = parseFloat(el.value.replace(",", "."));
    setDay(el.dataset.date, { weight: Number.isFinite(kg) && kg > 0 ? Math.round(kg * 10) / 10 : null });
  } else if (c === "weightGoal") {
    const kg = parseFloat(el.value.replace(",", "."));
    put("meta", { ...settings(), weightGoal: Number.isFinite(kg) && kg > 0 ? kg : null });
    return render();
  }
  else if (c === "symptoms") setDay(el.dataset.date, { symptoms: el.value.trim() });
  else if (c === "sleep") setDay(el.dataset.date, { sleep: el.value === "" ? null : Math.max(0, +el.value) });
  else if (c === "weekFocus") put("weeks", { ...(get("weeks", el.dataset.week) || { id: el.dataset.week }), focus: el.value.trim() });
  else if (c === "workerUrl") {
    local.workerUrl = el.value.trim();
    saveLocal();
    return syncNow(true);
  } else if (c === "syncKey") {
    local.syncKey = el.value.trim();
    saveLocal();
    return syncNow(true);
  } else if (c === "clientId") put("meta", { ...settings(), gcalClientId: el.value.trim() });
  else if (c === "gcalCal") {
    const g = get("meta", "gcal");
    const cur = chosenCalendars(g.calendars).filter((id) => id !== el.dataset.id);
    if (el.checked) cur.push(el.dataset.id);
    put("meta", { ...settings(), gcalCals: cur });
    // bortvalda försvinner direkt, tillvalda kräver en ny hämtning
    put("meta", { ...g, events: g.events.filter((e) => !e.c || cur.includes(e.c)) });
    if (el.checked) {
      if (local.gToken && local.gTokenExp > Date.now() + 60000) gcalFetch();
      else toast("Tryck Hämta igen för att hämta den kalendern");
    }
    return render();
  }
  else if (c === "choresWeekday" || c === "choresWeekend") put("meta", { ...settings(), [c]: Math.max(0, Math.min(10, parseInt(el.value, 10) || 0)) });
  else if (c === "kcalGoal" || c === "proteinGoal") put("meta", { ...settings(), [c]: Math.max(0, parseInt(el.value, 10) || 0) || null });
  else if (c === "import") {
    try {
      const data = JSON.parse(await el.files[0].text());
      state = mergeStates(state, data);
      persist();
      scheduleSync();
      toast("Importerat");
    } catch (e) {
      toast("Kunde inte läsa filen");
    }
  } else return;
  if (["steps", "import", "sleep", "work"].includes(c)) render();
});

/* ---------------- Synk ---------------- */

let syncTimer;
let lastSync = local.lastSync || null;
let syncError = "";
function scheduleSync() {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => syncNow(false), 1500);
}
function syncStatusText() {
  if (!local.syncKey) return "Ingen nyckel, datan finns bara på den här enheten.";
  if (syncError) return "Fel: " + syncError;
  return lastSync ? `Senast synkat ${new Date(lastSync).toLocaleString("sv-SE")}` : "Inte synkat än.";
}

async function syncNow(manual) {
  if (!local.syncKey) return;
  try {
    const res = await fetch(workerUrl() + "/state", {
      method: "PUT",
      headers: { "Content-Type": "application/json", "X-Journal-Key": local.syncKey },
      body: JSON.stringify({ state })
    });
    if (res.status === 401) throw new Error("fel synknyckel");
    if (!res.ok) throw new Error("servern svarade " + res.status);
    const body = await res.json();
    const before = JSON.stringify(state);
    state = mergeStates(state, body.state || {});
    persist();
    syncError = "";
    lastSync = local.lastSync = Date.now();
    saveLocal();
    const active = document.activeElement;
    const typing = active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA") && active.value;
    if (JSON.stringify(state) !== before && !typing && !sheet().open) render();
    if (manual) toast("Synkat");
  } catch (e) {
    syncError = e.message || "nätverksfel";
    if (manual) toast("Synk misslyckades: " + syncError);
  }
  const st = $("#sync-status");
  if (st) st.textContent = syncStatusText();
}

/* ---------------- Push ---------------- */

function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const raw = atob((base64String + padding).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

async function enablePush() {
  if (!local.syncKey) return toast("Lägg in synknyckeln först");
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
    return toast("Webbläsaren stödjer inte push. På iPhone: lägg appen på hemskärmen först.");
  }
  if ((await Notification.requestPermission()) !== "granted") return toast("Notiser nekades");
  const vapid = await fetch(workerUrl() + "/vapid", { headers: { "X-Journal-Key": local.syncKey } })
    .then((r) => (r.ok ? r.json() : {}))
    .catch(() => ({}));
  if (!vapid.publicKey) return toast("Workern saknar VAPID-nyckel eller svarar inte");
  const reg = await navigator.serviceWorker.ready;
  const sub = (await reg.pushManager.getSubscription()) || (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(vapid.publicKey) }));
  const res = await fetch(workerUrl() + "/subscribe", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Journal-Key": local.syncKey },
    body: JSON.stringify(sub)
  }).catch(() => null);
  toast(res && res.ok ? "Notiser påslagna" : "Kunde inte registrera notiser");
}

async function testPush(which) {
  if (!local.syncKey) return toast("Lägg in synknyckeln först");
  await syncNow(false);
  const res = await fetch(`${workerUrl()}/test-push?which=${which}`, { method: "POST", headers: { "X-Journal-Key": local.syncKey } }).catch(() => null);
  const body = res && res.ok ? await res.json() : null;
  toast(body && body.ok ? "Skickad" : "Ingen notis skickad. Är notiser påslagna?");
}

/* ---------------- Google Kalender (bara läsning) ---------------- */

function loadGis() {
  return new Promise((resolve, reject) => {
    if (window.google?.accounts?.oauth2) return resolve();
    const s = document.createElement("script");
    s.src = "https://accounts.google.com/gsi/client";
    s.onload = resolve;
    s.onerror = () => reject(new Error("kunde inte ladda Google"));
    document.head.append(s);
  });
}

async function gcalConnect() {
  const clientId = settings().gcalClientId || DEFAULT_GCAL_CLIENT_ID;
  if (!clientId) return toast("Lägg in klient ID först");
  if (local.gToken && local.gTokenExp > Date.now() + 60000) return gcalFetch();
  try {
    await loadGis();
  } catch (e) {
    return toast(e.message);
  }
  const client = google.accounts.oauth2.initTokenClient({
    client_id: clientId,
    scope: GCAL_SCOPE,
    callback: (resp) => {
      if (resp.error) return toast("Google: " + resp.error);
      local.gToken = resp.access_token;
      local.gTokenExp = Date.now() + (resp.expires_in || 3600) * 1000;
      local.gConnected = true;
      saveLocal();
      gcalFetch();
    }
  });
  client.requestAccessToken({ prompt: local.gConnected ? "" : "consent" });
}

function chosenCalendars(calendars) {
  const chosen = settings().gcalCals;
  if (Array.isArray(chosen)) return chosen;
  return calendars.filter((c) => c.primary).map((c) => c.id);
}

async function gcalFetch() {
  const auth = { headers: { Authorization: "Bearer " + local.gToken } };
  const api = "https://www.googleapis.com/calendar/v3";
  try {
    const calRes = await fetch(`${api}/users/me/calendarList?minAccessRole=reader`, auth);
    if (calRes.status === 401) {
      delete local.gToken;
      saveLocal();
      return toast("Google-inloggningen har gått ut, tryck Hämta igen");
    }
    const all = (await calRes.json()).items || [];
    const calendars = all.map((c) => ({ id: c.id, name: c.summaryOverride || c.summary || c.id, primary: !!c.primary, color: c.backgroundColor || null }));
    // Bara de kalendrar du valt i Inställningar. Utan val: bara din huvudkalender.
    const chosen = chosenCalendars(calendars);
    const cals = calendars.filter((c) => chosen.includes(c.id));
    const from = parseYmd(addDays(today(), -14)).toISOString();
    const to = parseYmd(addDays(today(), 120)).toISOString();
    const events = [];
    for (const cal of cals) {
      const url = `${api}/calendars/${encodeURIComponent(cal.id)}/events?singleEvents=true&orderBy=startTime&maxResults=500&timeMin=${encodeURIComponent(from)}&timeMax=${encodeURIComponent(to)}`;
      const data = await (await fetch(url, auth)).json();
      for (const ev of data.items || []) {
        if (ev.status === "cancelled" || !ev.start) continue;
        const ad = !!ev.start.date;
        const s = ev.start.dateTime || ev.start.date;
        const e = ev.end?.dateTime || ev.end?.date || s;
        events.push({
          id: ev.id,
          c: cal.id,
          t: ev.summary || "(utan titel)",
          ad,
          s: ad ? s : ymd(new Date(s)) + "T" + new Date(s).toTimeString().slice(0, 5),
          e: ad ? e : ymd(new Date(e)) + "T" + new Date(e).toTimeString().slice(0, 5),
          sd: ad ? s : ymd(new Date(s)),
          ed: ad ? addDays(e, -1) : ymd(new Date(new Date(e) - 1))
        });
      }
    }
    events.sort((a, b) => a.s.localeCompare(b.s));
    put("meta", { id: "gcal", events, calendars, fetchedAt: Date.now() });
    toast(`Hämtade ${events.length} händelser`);
    render();
  } catch (e) {
    toast("Kunde inte hämta kalendern");
  }
}

/* ---------------- Start ---------------- */

window.addEventListener("hashchange", () => {
  showAllChores = false;
  if (route().view !== "kvall") planned = [];
  render();
  window.scrollTo(0, 0);
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    syncNow(false);
    if (local.gToken && local.gTokenExp > Date.now() + 60000) {
      const g = get("meta", "gcal");
      if (!g || Date.now() - g.fetchedAt > 30 * 60000) gcalFetch();
    }
  }
});
// Byt dag vid midnatt även om appen står öppen.
let renderedDay = today();
setInterval(() => {
  if (today() !== renderedDay) {
    renderedDay = today();
    render();
  }
}, 60000);

// Ny version av appen: service workern byts ut och sidan laddas om en gång.
if ("serviceWorker" in navigator) {
  const hadController = !!navigator.serviceWorker.controller;
  let reloaded = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (hadController && !reloaded) {
      reloaded = true;
      location.reload();
    }
  });
  navigator.serviceWorker
    .register("sw.js", { updateViaCache: "none" })
    .then((reg) => {
      // leta efter ny version när appen öppnas igen
      document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && reg.update().catch(() => {}));
    })
    .catch(() => {});
}
render();
syncNow(false);
