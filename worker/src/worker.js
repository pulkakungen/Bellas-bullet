// Bellas Bullet: synk mellan enheter och push-notiser (morgon 06:30, kväll 20:30).
// Allt utom startsidan kräver hemligheten JOURNAL_KEY
// (`npx wrangler secret put JOURNAL_KEY`), samma nyckel som skrivs in i appen.
import { buildPushPayload } from "@block65/webcrypto-web-push";

const STATE_KEY = "state";
const SUB_KEY = "subscription";
const SENT_PREFIX = "sent:";

const MORNING_MIN = 6 * 60 + 30;
const EVENING_MIN = 20 * 60 + 30;
const MAPS = ["entries", "collections", "routines", "zones", "done", "days", "weeks", "workouts", "birthdays", "habits", "meta"];

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

function dueRoutines(state, date) {
  const weekday = new Date(date + "T12:00:00Z").getUTCDay();
  const out = [];
  for (const r of live(state.routines)) {
    if (doneOn(state, r.id, date)) continue;
    if (r.mode === "weekday") {
      if (r.weekday === weekday) out.push({ name: r.name, score: 99 });
      continue;
    }
    const last = lastDone(state, r.id, date);
    const since = last ? daysBetween(last, date) : Infinity;
    if (since >= r.every) out.push({ name: r.name, score: last ? since / r.every : 50 });
  }
  return out.sort((a, b) => b.score - a.score).map((r) => r.name);
}

function zoneForWeek(state, date) {
  const zones = live(state.zones).sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.id.localeCompare(b.id));
  if (!zones.length) return null;
  const weeks = Math.floor(daysBetween("2024-01-01", weekStart(date)) / 7);
  return zones[((weeks % zones.length) + zones.length) % zones.length];
}

function gcalOn(state, date) {
  const cache = (state.meta || {}).gcal;
  const events = cache && Array.isArray(cache.events) ? cache.events : [];
  return events.filter((e) => e.sd <= date && date <= e.ed);
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

  return { title: "God morgon", body: lines.join("\n") || "Ett tomt blad idag. Vad vill du hinna med?", tag: "bullet-morgon" };
}

function eveningMessage(state, date) {
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
