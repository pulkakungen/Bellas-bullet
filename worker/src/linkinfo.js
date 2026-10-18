// Plockar ut namn, pris, bild och butik ur en produktsida.
// Först strukturerad data (JSON-LD Product), sedan metataggar (og:, product:),
// sist sidans titel. Ingen DOM i workern, så det är tåliga reguljära uttryck.

const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
const decode = (s) =>
  String(s || "")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&([a-z]+);/gi, (m, n) => ENT[n.toLowerCase()] ?? m)
    .replace(/\s+/g, " ")
    .trim();

function metaTags(html) {
  const out = {};
  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = m[0];
    const key = (tag.match(/\b(?:property|name|itemprop)\s*=\s*["']([^"']+)["']/i) || [])[1];
    const val = (tag.match(/\bcontent\s*=\s*"([^"]*)"/i) || tag.match(/\bcontent\s*=\s*'([^']*)'/i) || [])[1];
    if (key && val != null && !(key.toLowerCase() in out)) out[key.toLowerCase()] = decode(val);
  }
  return out;
}

// Alla objekt i JSON-LD, även inbäddade i @graph, listor och varianter.
function ldObjects(html) {
  const out = [];
  const walk = (x) => {
    if (!x || typeof x !== "object") return;
    if (Array.isArray(x)) return x.forEach(walk);
    out.push(x);
    ["@graph", "hasVariant", "mainEntity", "itemListElement", "item"].forEach((k) => walk(x[k]));
  };
  for (const m of html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      walk(JSON.parse(m[1].trim()));
    } catch (e) {}
  }
  return out;
}

const isType = (o, t) => [].concat(o["@type"] || []).some((x) => String(x).toLowerCase() === t);
const first = (v) => (Array.isArray(v) ? v[0] : v);
const imageOf = (v) => {
  v = first(v);
  return typeof v === "string" ? v : v && (v.url || v.contentUrl) ? v.url || v.contentUrl : null;
};

function priceFromOffers(offers) {
  for (const o of [].concat(offers || [])) {
    if (!o || typeof o !== "object") continue;
    const spec = first(o.priceSpecification) || {};
    const price = o.price ?? o.lowPrice ?? spec.price;
    if (price != null && price !== "") return { price: num(price), currency: o.priceCurrency || spec.priceCurrency || null };
    const inner = priceFromOffers(o.offers);
    if (inner) return inner;
  }
  return null;
}

// "1 299,00" och "1,299.00" blir 1299.
function num(v) {
  if (typeof v === "number") return v;
  let s = String(v).replace(/[^\d.,]/g, "");
  if (/,\d{1,2}$/.test(s)) s = s.replace(/\./g, "").replace(",", ".");
  else s = s.replace(/,/g, "");
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

// Namn ur adressen när sidan inte går att läsa, t.ex. ".../linneskjorta-i-bla-123456.html".
export function nameFromUrl(url) {
  try {
    const u = new URL(url);
    const parts = u.pathname.split("/").filter(Boolean).map((p) => decodeURIComponent(p).replace(/\.(html?|aspx?|php)$/i, ""));
    const best = parts.filter((p) => /[a-zåäö]{3,}[-_][a-zåäö]/i.test(p)).sort((a, b) => b.length - a.length)[0];
    if (!best) return null;
    const words = best.split(/[-_+]+/).filter((w) => w && !/\d/.test(w));
    if (!words.length) return null;
    const s = words.join(" ");
    return s.charAt(0).toUpperCase() + s.slice(1);
  } catch (e) {
    return null;
  }
}

const siteName = (url) => {
  try {
    const host = new URL(url).hostname.replace(/^(www\d?|m|shop)\./, "").split(".")[0];
    return host.charAt(0).toUpperCase() + host.slice(1);
  } catch (e) {
    return "";
  }
};

export function parseProductPage(html, url) {
  const meta = metaTags(html);
  const product = ldObjects(html).find((o) => isType(o, "product") || isType(o, "productgroup"));
  const info = { title: null, price: null, currency: null, image: null, site: meta["og:site_name"] || siteName(url) };
  if (product) {
    info.title = decode(product.name) || null;
    info.image = imageOf(product.image);
    const p = priceFromOffers(product.offers) || priceFromOffers([].concat(product.hasVariant || []).map((v) => v.offers));
    if (p) Object.assign(info, p);
    if (!info.site && product.brand) info.site = decode(first(product.brand).name || first(product.brand));
  }
  info.title ||= meta["og:title"] || meta["twitter:title"] || decode((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1]) || null;
  info.image ||= meta["og:image"] || meta["og:image:secure_url"] || meta["twitter:image"] || null;
  if (info.price == null) {
    const amount = meta["product:price:amount"] || meta["og:price:amount"] || meta["price"];
    if (amount) {
      info.price = num(amount);
      info.currency = meta["product:price:currency"] || meta["og:price:currency"] || meta["pricecurrency"] || null;
    }
  }
  if (info.price == null) {
    const m = html.match(/itemprop=["']price["'][^>]*content=["']([\d.,\s]+)["']/i) || html.match(/content=["']([\d.,\s]+)["'][^>]*itemprop=["']price["']/i);
    if (m) info.price = num(m[1]);
  }
  // Butikens namn bort ur titeln: "Linneskjorta | Lindex" blir "Linneskjorta".
  if (info.title && info.site) {
    const parts = info.title.split(/\s+[|–—-]\s+/);
    if (parts.length > 1) {
      const site = info.site.toLowerCase().split(".")[0];
      const kept = parts.filter((p) => !p.toLowerCase().includes(site));
      if (kept.length) info.title = kept.join(" – ");
    }
  }
  if (!info.title) info.title = nameFromUrl(url);
  if (info.image && !/^https?:/i.test(info.image)) {
    try {
      info.image = new URL(info.image, url).href;
    } catch (e) {
      info.image = null;
    }
  }
  return info;
}
