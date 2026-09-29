// Bellas Bullet: synk mellan enheter och push-notiser (morgon 06:30, kväll 20:30).
// Allt utom startsidan kräver hemligheten JOURNAL_KEY
// (`npx wrangler secret put JOURNAL_KEY`), samma nyckel som skrivs in i appen.
import { buildPushPayload } from "@block65/webcrypto-web-push";

const STATE_KEY = "state";
const SUB_KEY = "subscription";
const SENT_PREFIX = "sent:";

const MORNING_MIN = 6 * 60 + 30;
const EVENING_MIN = 20 * 60 + 30;
const MAPS = ["entries", "collections", "routines", "zones", "done", "days", "weeks", "workouts", "birthdays", "habits", "meals", "foods", "meta"];

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Journal-Key"
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...CORS } });
}

// Samma sammanslagning som i appen: per post vinner den senast ändrade.
function mergeStates(a, b) {
  const out = { v: 1 };
  for (const m of MAPS) {
    const A = (a && a[m]) || {};
    const B = (b && b[m]) || {};
    const merged = {};
    for (const id of new Set([...Object.keys(A), ...Object.keys(B)])) {
      const x = A[id];
      const y = B[id];
      merged[id] = !x ? y : !y ? x : (y.u || 0) > (x.u || 0) ? y : x;
    }
    out[m] = merged;
  }
  return out;
}

function keyOk(request, env) {
  const given = request.headers.get("X-Journal-Key") || "";
  return !!env.JOURNAL_KEY && given.length > 0 && given === env.JOURNAL_KEY;
}

async function readState(env) {
  const raw = await env.BULLET_KV.get(STATE_KEY);
  return raw ? JSON.parse(raw) : null;
}

async function handleRequest(request, env, url) {
  if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (url.pathname === "/") return new Response("Bellas Bullet worker", { headers: CORS });
  if (!env.JOURNAL_KEY) return json({ error: "JOURNAL_KEY är inte satt i workern" }, 503);
  if (!keyOk(request, env)) return json({ error: "fel nyckel" }, 401);

  if (url.pathname === "/state" && request.method === "GET") {
    return json({ state: await readState(env) });
  }

  if (url.pathname === "/state" && request.method === "PUT") {
    const body = await request.json().catch(() => null);
    if (!body || typeof body.state !== "object") return json({ error: "ingen state" }, 400);
    const merged = mergeStates(await readState(env), body.state);
    await env.BULLET_KV.put(STATE_KEY, JSON.stringify(merged));
    return json({ state: merged });
  }

  // Appen hämtar den publika VAPID-nyckeln här, så den bara finns på ett ställe.
  if (url.pathname === "/vapid" && request.method === "GET") {
    return json({ publicKey: env.VAPID_PUBLIC_KEY || null });
  }

  if (url.pathname === "/food/list" && request.method === "GET") {
    try {
      return json({ list: (await lmvList(env)).map((f) => [f.nummer, f.namn]) });
    } catch (err) {
      return json({ error: err.message });
    }
  }
  if (url.pathname === "/food/search" && request.method === "GET") {
    return json(await foodSearch(env, url.searchParams.get("q") || ""));
  }
  const food = url.pathname.match(/^\/food\/(\d+)$/);
  if (food && request.method === "GET") {
    return json(await foodNutrients(env, food[1]));
  }

  if (url.pathname === "/subscribe" && request.method === "POST") {
    const sub = await request.json().catch(() => null);
    if (!sub || !sub.endpoint) return json({ error: "ogiltig prenumeration" }, 400);
    await env.BULLET_KV.put(SUB_KEY, JSON.stringify(sub));
    return json({ ok: true });
  }

  if (url.pathname === "/unsubscribe" && request.method === "POST") {
    await env.BULLET_KV.delete(SUB_KEY);
    return json({ ok: true });
  }

  if (url.pathname === "/test-push" && request.method === "POST") {
    const which = url.searchParams.get("which");
    const state = (await readState(env)) || {};
    const { dateStr } = stockholmParts(new Date());
    const msg = which === "evening" ? eveningMessage(state, dateStr) : which === "morning" ? morningMessage(state, dateStr) : { title: "Bellas Bullet", body: "Testnotis. Allt fungerar." };
    return json({ ok: await sendJournalPush(env, msg) });
  }

  return json({ error: "not found" }, 404);
}

async function sendJournalPush(env, { title, body, tag }) {
  const subRaw = await env.BULLET_KV.get(SUB_KEY);
  if (!subRaw) return false;
  try {
    const subscription = JSON.parse(subRaw);
    const payload = await buildPushPayload(
      { data: JSON.stringify({ title, body, tag: tag || "bullet" }), options: { ttl: 3600 } },
      subscription,
      { subject: env.VAPID_SUBJECT, publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY }
    );
    const res = await fetch(subscription.endpoint, payload);
    if (res.status === 404 || res.status === 410) await env.BULLET_KV.delete(SUB_KEY);
    return res.ok;
  } catch (err) {
    console.error("journal push kastade fel", err && err.message);
    return false;
  }
}

/* ---------------- Livsmedelsverket ---------------- */
// Livsmedelsdatabasen (öppna data, API v1). Workern hämtar listan en gång
// i veckan och söker själv, så appen slipper CORS och stora nedladdningar.
// Tolkningen är tålig mot stora/små bokstäver i fältnamnen.

const LMV = "https://dataportal.livsmedelsverket.se/livsmedel/api/v1";
const LMV_LIST_KEY = "lmv:list";
const pick = (o, ...keys) => {
  for (const k of keys) {
    for (const key of Object.keys(o || {})) if (key.toLowerCase() === k.toLowerCase()) return o[key];
  }
  return undefined;
};
// Svaret är antingen en lista eller ett objekt med t.ex. _meta, _links och
// själva listan. Ta listan med det namnet om den finns, annars den största
// listan som inte är _links.
const listIn = (data, ...names) => {
  if (Array.isArray(data)) return data;
  const entries = Object.entries(data || {}).filter(([k, v]) => Array.isArray(v));
  for (const n of names) {
    const hit = entries.find(([k]) => k.toLowerCase() === n.toLowerCase());
    if (hit) return hit[1];
  }
  return entries.filter(([k]) => !k.startsWith("_")).sort((a, b) => b[1].length - a[1].length)[0]?.[1] || [];
};
const num = (v) => {
  const n = parseFloat(String(v ?? "").replace(",", ".").replace(/\s/g, ""));
  return Number.isFinite(n) ? n : null;
};

async function lmvGet(path) {
  const res = await fetch(LMV + path, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`Livsmedelsverket svarade ${res.status} på ${path}`);
  return res.json();
}

async function lmvList(env) {
  const cached = await env.BULLET_KV.get(LMV_LIST_KEY);
  if (cached) return JSON.parse(cached);
  const data = await lmvGet("/livsmedel?offset=0&limit=5000&sprak=1");
  const list = listIn(data, "livsmedel")
    .map((f) => ({ nummer: pick(f, "nummer", "id"), namn: pick(f, "namn", "name") }))
    .filter((f) => f.nummer != null && f.namn);
  if (!list.length) throw new Error("Livsmedelsverket gav en tom lista: " + JSON.stringify(data).slice(0, 300));
  await env.BULLET_KV.put(LMV_LIST_KEY, JSON.stringify(list), { expirationTtl: 60 * 60 * 24 * 7 });
  return list;
}

// Förlåtande sökning:
// - mängder och enheter ignoreras ("2 dl"), "soya" blir "soja"
// - stavfel tolereras (ett eller två tecken fel beroende på ordlängd)
// - sammansatta ord matchar delarna ("sojayoghurt" hittar "Yoghurt soja")
// - sällsynta ord väger tyngre än vanliga ("soja" före "osötad")
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

async function foodSearch(env, q) {
  const words = norm(q).split(/\s+/).filter((w) => w.length > 1 && !/^\d/.test(w) && !STOP.has(w));
  if (!words.length) return { results: [] };
  try {
    const list = await lmvList(env);
    const items = list.map((f) => {
      const name = norm(f.namn);
      return { f, name, tokens: name.split(/\s+/).filter(Boolean) };
    });
    const matches = items.map((it) => words.map((w) => wordMatch(w, it.name, it.tokens)));
    // vikt per sökord: ju fler livsmedel ordet finns i, desto mindre väger det
    const weights = words.map((_, wi) => {
      const df = matches.filter((m) => m[wi] >= 0.6).length;
      return Math.log((items.length + 1) / (df + 1)) + 0.5;
    });
    const scored = items
      .map((it, idx) => ({ ...it, score: matches[idx].reduce((sum, m, wi) => sum + m * weights[wi], 0) }))
      .filter((x) => x.score > 0);
    const best = Math.max(0, ...scored.map((x) => x.score));
    const hits = scored
      .filter((x) => x.score >= best * 0.45)
      .sort((a, b) => b.score - a.score || a.f.namn.length - b.f.namn.length)
      .slice(0, 25)
      .map((x) => x.f);
    return { results: hits };
  } catch (err) {
    return { results: [], error: err.message };
  }
}

// Näringsvärden per 100 g: kcal, protein, fett och kolhydrater.
async function foodNutrients(env, nummer) {
  const key = "lmv:food:" + nummer;
  const cached = await env.BULLET_KV.get(key);
  if (cached) return JSON.parse(cached);
  try {
    const rows = listIn(await lmvGet(`/livsmedel/${nummer}/naringsvarden?sprak=1`), "naringsvarden", "naringsvarde");
    const out = { nummer: +nummer, kcal: null, p: null, f: null, c: null };
    for (const r of rows) {
      const namn = String(pick(r, "namn", "name") || "").toLowerCase();
      const kod = String(pick(r, "euroFIRkod", "eurofir") || "").toUpperCase();
      const enhet = String(pick(r, "enhet", "unit") || "").toLowerCase();
      const varde = num(pick(r, "varde", "value"));
      if (varde == null) continue;
      if ((kod === "ENERC" && enhet === "kcal") || /energi.*kcal/.test(namn)) out.kcal = varde;
      else if (kod === "PROT" || /^protein/.test(namn)) out.p = varde;
      else if (kod === "FAT" || /^fett(,? totalt)?$/.test(namn)) out.f = varde;
      else if (kod === "CHO" || /^kolhydrater/.test(namn)) out.c ??= varde;
    }
    if (out.kcal == null) return { error: "Hittade inte kalorier i svaret: " + JSON.stringify(rows.slice(0, 3)).slice(0, 300) };
    await env.BULLET_KV.put(key, JSON.stringify(out), { expirationTtl: 60 * 60 * 24 * 30 });
    return out;
  } catch (err) {
    return { error: err.message };
  }
}

/* ---------------- Datum ---------------- */

function stockholmParts(date) {
  const fmt = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Europe/Stockholm",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false
  });
  const p = Object.fromEntries(fmt.formatToParts(date).map((x) => [x.type, x.value]));
  return { dateStr: `${p.year}-${p.month}-${p.day}`, minutesOfDay: parseInt(p.hour, 10) * 60 + parseInt(p.minute, 10) };
}

function addDays(dateStr, n) {
  const d = new Date(dateStr + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function daysBetween(a, b) {
  return Math.round((new Date(b + "T12:00:00Z") - new Date(a + "T12:00:00Z")) / 86400000);
}

function weekStart(dateStr) {
  const wd = (new Date(dateStr + "T12:00:00Z").getUTCDay() + 6) % 7;
  return addDays(dateStr, -wd);
}

/* ---------------- Innehåll i notiserna ---------------- */
// Speglar logiken i journal/app.js (förfallna rutiner och veckans zon).

const live = (map) => Object.values(map || {}).filter((r) => r && !r.del);

function doneOn(state, id, date) {
  const r = (state.done || {})[`${id}|${date}`];
  return !!(r && !r.del);
}

function lastDone(state, id, before) {
  let last = null;
  for (const [key, r] of Object.entries(state.done || {})) {
    if (r.del) continue;
    const [rid, date] = key.split("|");
    if (rid === id && date <= before && (!last || date > last)) last = date;
  }
  return last;
}

// Samma regler som i appen: aldrig gjorda sprids ut över intervallet,
// dagliga räknas inte in i taket, och taket skiljer vardag och helg.
function firstDue(r) {
  const start = r.since || (r.u > 1 ? new Date(r.u).toISOString().slice(0, 10) : null);
  if (!start || r.every <= 1) return start;
  let h = 0;
  for (const ch of r.id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return addDays(start, h % r.every);
}

function dueRoutines(state, date) {
  const weekday = new Date(date + "T12:00:00Z").getUTCDay();
  const settings = (state.meta || {}).settings || {};
  const cap = weekday === 0 || weekday === 6 ? settings.choresWeekend ?? 3 : settings.choresWeekday ?? 1;
  const out = [];
  for (const r of live(state.routines)) {
    if (doneOn(state, r.id, date)) continue;
    if (r.mode === "weekday") {
      if (r.weekday === weekday) out.push({ name: r.name, score: 99 });
      continue;
    }
    if (r.every <= 1) continue; // dagliga nämns inte i morgonnotisen
    const last = lastDone(state, r.id, date);
    if (!last) {
      const first = firstDue(r);
      if (!first || first <= date) out.push({ name: r.name, score: 1 });
      continue;
    }
    const since = daysBetween(last, date);
    if (since >= r.every) out.push({ name: r.name, score: since / r.every });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, cap).map((r) => r.name);
}

function zoneForWeek(state, date) {
  const zones = live(state.zones).sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.id.localeCompare(b.id));
  if (!zones.length) return null;
  const weeks = Math.floor(daysBetween("2024-01-01", weekStart(date)) / 7);
  return zones[((weeks % zones.length) + zones.length) % zones.length];
}

// Samma som appen: utan dolda händelser och med dubbletter ihopslagna.
function gcalOn(state, date) {
  const cache = (state.meta || {}).gcal;
  const events = cache && Array.isArray(cache.events) ? cache.events : [];
  const settings = (state.meta || {}).settings || {};
  const keys = new Set(settings.gcalHiddenKeys || []);
  const titles = new Set((settings.gcalHiddenTitles || []).map((t) => t.trim().toLowerCase()));
  const seen = new Set();
  return events.filter((e) => {
    const title = String(e.t || "").trim().toLowerCase();
    if (!(e.sd <= date && date <= e.ed) || keys.has(`${e.t}|${e.s}`) || titles.has(title) || seen.has(title)) return false;
    seen.add(title);
    return true;
  });
}

function morningMessage(state, date) {
  const tomorrow = addDays(date, 1);
  const entries = live(state.entries);
  const todays = entries.filter((e) => e.date === date);
  const meetings = todays.filter((e) => e.type === "meeting").length;
  const events = todays.filter((e) => e.type === "event").length + gcalOn(state, date).length;
  const openTasks = todays.filter((e) => e.type === "task" && (e.status === "open" || e.status === "started")).length;
  const deadlines = entries
    .filter((e) => e.sig === "!" && (e.date === date || e.date === tomorrow) && !["done", "struck", "migrated"].includes(e.status))
    .map((e) => `${e.text} (${e.date === date ? "idag" : "imorgon"})`);

  const lines = [];
  const cal = [];
  if (meetings) cal.push(`${meetings} möte${meetings > 1 ? "n" : ""}`);
  if (events) cal.push(`${events} event`);
  if (cal.length) lines.push(cal.join(", "));
  if (deadlines.length) lines.push("! " + deadlines.slice(0, 3).join(", "));
  if (openTasks) lines.push(`${openTasks} uppgift${openTasks > 1 ? "er" : ""} i loggen`);
  const md = (d) => d.slice(5);
  for (const b of live(state.birthdays)) {
    if (b.md === md(date)) lines.unshift(`Födelsedag: ${b.name}${b.year ? ` fyller ${Number(date.slice(0, 4)) - b.year}` : ""}`);
    else if (b.md === md(tomorrow)) lines.push(`Imorgon fyller ${b.name} år`);
  }
  const due = dueRoutines(state, date);
  if (due.length) lines.push("Dags för: " + due.slice(0, 3).join(", "));
  const zone = zoneForWeek(state, date);
  if (zone) lines.push("Veckans zon: " + zone.name);

  lines.push("Ta morgonmedicinen.");
  return { title: "God morgon", body: lines.join("\n"), tag: "bullet-morgon" };
}

// Hudvården för kvällen: hur många steg som återstår.
function skinLeft(state, date) {
  const sc = (state.meta || {}).skincare;
  const steps = (sc && sc.days && sc.days[new Date(date + "T12:00:00Z").getUTCDay()]) || [];
  return steps.filter((st) => !doneOn(state, "sk:" + st, date)).length;
}

function eveningMessage(state, date) {
  const msg = eveningTasks(state, date);
  const day = (state.days || {})[date] || {};
  if (!day.medsPm) msg.body += "\nGlöm inte kvällsmedicinen.";
  const left = skinLeft(state, date);
  if (left) msg.body += `\nHudvård: ${left} steg kvar ikväll.`;
  return msg;
}

function eveningTasks(state, date) {
  const open = live(state.entries).filter(
    (e) => e.type === "task" && e.date && e.date <= date && (e.status === "open" || e.status === "started")
  );
  const today = open.filter((e) => e.date === date).length;
  const older = open.length - today;
  if (!open.length) {
    return { title: "Kvällsgenomgång", body: "Allt är klart idag. Skriv en rad tacksamhet innan du sover.", tag: "bullet-kvall" };
  }
  const parts = [];
  if (today) parts.push(`${today} öppna idag`);
  if (older) parts.push(`${older} från tidigare dagar`);
  return {
    title: "Dags att migrera",
    body: `${parts.join(" och ")}. Flytta fram det som spelar roll, stryk resten.`,
    tag: "bullet-kvall"
  };
}

async function runSchedule(env) {
  try {
    if (!(await env.BULLET_KV.get(SUB_KEY))) return;
    const { dateStr, minutesOfDay } = stockholmParts(new Date());
    const slots = [
      { id: "morgon", at: MORNING_MIN, build: morningMessage },
      { id: "kvall", at: EVENING_MIN, build: eveningMessage }
    ];
    const slot = slots.find((s) => minutesOfDay >= s.at && minutesOfDay < s.at + 15);
    if (!slot) return;

    const sentKey = SENT_PREFIX + dateStr;
    const sent = JSON.parse((await env.BULLET_KV.get(sentKey)) || "[]");
    if (sent.includes(slot.id)) return;

    const state = (await readState(env)) || {};
    if (await sendJournalPush(env, slot.build(state, dateStr))) {
      sent.push(slot.id);
      await env.BULLET_KV.put(sentKey, JSON.stringify(sent), { expirationTtl: 60 * 60 * 48 });
    }
  } catch (err) {
    console.error("journal schema kastade fel", err && err.stack);
  }
}

export default {
  async fetch(request, env) {
    try {
      return await handleRequest(request, env, new URL(request.url));
    } catch (err) {
      console.error("fetch kastade fel", err && err.stack);
      return json({ error: "internt fel" }, 500);
    }
  },
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(runSchedule(env));
  }
};
