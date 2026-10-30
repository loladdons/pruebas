// @ts-check
// Fútbol Libre — adaptado para Nuvio / Mi Comunidad (lolplus)
// API esperada por la app: getHome, search, getStreams
// Canales / partidos: type "channel" | "live" → player en vivo sin barra de progreso
//
// Sitios (orden de intento):
//   primary   futbollibretvplus.com   agenda: api.wqxag.com/diaries.json
//   backup 1  futbolvivo.site         agenda: /api/agenda
//   backup 2  futbol-libre.app        agenda: /agenda (HTML), playback: /api/direct-playback.php

// ---- textos ----
const TEXTS = {
  es: {
    now: "En vivo ahora",
    next: "Próximos partidos",
    channels: "Canales deportivos",
    more: "Más canales",
    live: "EN VIVO",
    offline: "Sin señal por ahora. Si el partido aún no empieza, vuelve en un rato.",
    unavailable: "Ningún servidor responde ahora. Intenta de nuevo en un momento.",
  },
  en: {
    now: "Live now",
    next: "Upcoming matches",
    channels: "Sports channels",
    more: "More channels",
    live: "LIVE",
    offline: "No signal right now. If the match has not started, try later.",
    unavailable: "No server answers right now. Try again in a moment.",
  },
};

function t(key) {
  const lang = (typeof navigator !== "undefined" && navigator.language || "es").toLowerCase().startsWith("es") ? "es" : "en";
  return (TEXTS[lang] && TEXTS[lang][key]) || TEXTS.es[key] || key;
}

// ---- sitios ----
const PRIMARY = "https://futbollibretvplus.com";
const BACKUP1 = "https://futbolvivo.site";
const BACKUP2 = "https://futbol-libre.app";
const AGENDA_API = "https://api.wqxag.com/diaries.json";
const IMG = "https://img.wqxag.com";
const HOUR = 3600000;
const MATCH_MS = 150 * 60000; // 2h 30 después del inicio cuenta como en vivo
const MEM = new Map();

async function cached(key, ttlMs, fn) {
  const hit = MEM.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.v;
  const v = await fn();
  MEM.set(key, { at: Date.now(), v });
  return v;
}

function offsetHours() {
  // La app pasa config en globalThis.__nuvioConfig.current (o por addonId)
  try {
    const cfg =
      (globalThis.__nuvioConfig && (globalThis.__nuvioConfig.current || globalThis.__nuvioConfig)) ||
      {};
    if (cfg.utcOffset != null) {
      const n = parseInt(String(cfg.utcOffset), 10);
      if (Number.isFinite(n)) return n;
    }
  } catch (_) {}
  return -5;
}

function pad(n) {
  return n < 10 ? "0" + n : String(n);
}

function clock(ms) {
  const d = new Date(ms + offsetHours() * HOUR);
  return pad(d.getUTCHours()) + ":" + pad(d.getUTCMinutes());
}

function whenText(ms) {
  const shift = offsetHours() * HOUR;
  const d = new Date(ms + shift);
  const today = new Date(Date.now() + shift);
  const same =
    d.getUTCFullYear() === today.getUTCFullYear() &&
    d.getUTCMonth() === today.getUTCMonth() &&
    d.getUTCDate() === today.getUTCDate();
  const days = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"];
  return same ? clock(ms) : days[d.getUTCDay()] + " " + clock(ms);
}

// ---- utils ----
function entities(s) {
  return String(s || "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function hash(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

function b64(s) {
  let x = String(s).replace(/-/g, "+").replace(/_/g, "/");
  while (x.length % 4) x += "=";
  try {
    return atob(x);
  } catch {
    return "";
  }
}

function tokenOf(url) {
  const u = String(url || "");
  const id = (/[?&](?:stream|canal)=([A-Za-z0-9_-]{1,40})/.exec(u) || [])[1];
  if (!id) return "";
  if (/^https:\/\/(?:www\.)?tvf90\.com\//.test(u)) return "tvf90." + id;
  if (/^https:\/\/(?:www\.)?la18hd\.su\/vivo\/canales\.php/.test(u)) return "la18c." + id;
  if (/^https:\/\/(?:www\.)?la18hd\.su\//.test(u)) return "la18." + id;
  if (/^https:\/\/streamxhd\.st\//.test(u)) return "sxhd." + id;
  if (/^https:\/\/(?:futbollibretv\.sx|streamtp[a-z0-9.-]*)\//.test(u)) return "tp." + id;
  return "";
}

function withSisters(tokens) {
  const out = [];
  const add = (x) => {
    if (x && !out.includes(x)) out.push(x);
  };
  tokens.forEach(add);
  for (const x of tokens) {
    const [kind, id] = x.split(".");
    if (kind === "tvf90") add("la18." + id);
    if (kind === "la18" || kind === "la18c") add("tvf90." + id);
  }
  return out.slice(0, 7);
}

function makeEvent(source, startMs, league, title, flag, tokens) {
  const clean = withSisters(tokens);
  if (!clean.length || !title || !(startMs > 0)) return null;
  return {
    id: "e" + hash(source === "backup2" ? title + startMs : title + "|" + startMs),
    start: startMs,
    league,
    title,
    flag,
    tokens: clean,
    source,
  };
}

function limaMs(date, hour) {
  const d = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(date));
  const h = /^(\d{1,2}):(\d{2})/.exec(String(hour));
  if (!d || !h) return 0;
  return Date.UTC(+d[1], +d[2] - 1, +d[3], +h[1], +h[2]) + 5 * HOUR;
}

function splitTitle(raw) {
  const text = entities(raw);
  const m = /^([^:]{2,80}):\s*(.+)$/.exec(text);
  return m ? { league: m[1].trim(), title: m[2].trim() } : { league: "", title: text };
}

// ---- agenda ----
async function fetchText(url, timeoutMs) {
  const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs || 10000) : null;
  try {
    const r = await fetch(url, {
      signal: ctrl ? ctrl.signal : undefined,
      headers: { "User-Agent": "Mozilla/5.0 (Linux; Android 12) AppleWebKit/537.36 Chrome/120.0.0.0 Mobile Safari/537.36" },
    });
    if (!r.ok) throw new Error("HTTP " + r.status);
    return await r.text();
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function fetchJson(url, timeoutMs) {
  const text = await fetchText(url, timeoutMs);
  return JSON.parse(text);
}

async function agendaPrimary() {
  const data = await fetchJson(AGENDA_API, 8000);
  const rows = data && data.data;
  if (!Array.isArray(rows)) throw new Error("agenda shape");
  const out = [];
  for (const row of rows) {
    const a = (row && row.attributes) || {};
    const { league, title } = splitTitle(a.diary_description);
    const c = a.country && a.country.data && a.country.data.attributes;
    const img = c && c.image && c.image.data && c.image.data.attributes && c.image.data.attributes.url;
    const tokens = [];
    for (const em of (a.embeds && a.embeds.data) || []) {
      const frame = (em.attributes && em.attributes.embed_iframe) || "";
      const m = /[?&]r=([^&]+)/.exec(frame);
      const tok = tokenOf(m ? b64(decodeURIComponent(m[1])) : frame);
      if (tok && !tokens.includes(tok)) tokens.push(tok);
    }
    const ev = makeEvent(
      "primary",
      limaMs(a.date_diary, a.diary_hour),
      league || (c && c.name) || "",
      title,
      img ? IMG + img : undefined,
      tokens
    );
    if (ev) out.push(ev);
  }
  return out;
}

async function agendaBackup1() {
  const data = await fetchJson(BACKUP1 + "/api/agenda", 8000);
  const events = data && data.events;
  if (!Array.isArray(events)) throw new Error("agenda shape");
  const out = [];
  for (const e of events) {
    const { league, title } = splitTitle(e.title);
    const tokens = [];
    for (const em of e.embeds || []) {
      const tok = tokenOf(em.iframe);
      if (tok && !tokens.includes(tok)) tokens.push(tok);
    }
    const ev = makeEvent(
      "backup1",
      limaMs(e.date, e.time),
      league,
      title,
      typeof e.flag === "string" && /^https:/.test(e.flag) ? e.flag : undefined,
      tokens
    );
    if (ev) out.push(ev);
  }
  return out;
}

async function agendaBackup2() {
  const html = await fetchText(BACKUP2 + "/agenda", 9000);
  const out = [];
  for (const chunk of html.split('<div class="source-agenda-event"').slice(1)) {
    const instant = Date.parse((/data-source-instant="([^"]+)"/.exec(chunk) || [])[1] || "");
    const comp = entities((/source-agenda-competition">([^<]*)</.exec(chunk) || [])[1] || "").replace(/:$/, "");
    const strong = entities(((/<strong>([\s\S]*?)<\/strong>/.exec(chunk) || [])[1] || "").replace(/<[^>]+>/g, " "));
    const title = comp && strong.startsWith(comp) ? strong.slice(comp.length).replace(/^[:\s]+/, "") : strong;
    const flagPath = (/source-agenda-flag" src="([^"]+)"/.exec(chunk) || [])[1];
    const tokens = [];
    const re = /href="\/match\/([a-z0-9-]{1,100})#source=(\d{1,8})"/g;
    let m;
    while ((m = re.exec(chunk))) tokens.push(`b2e.${m[1]}.${m[2]}`);
    const ev = makeEvent(
      "backup2",
      instant,
      comp,
      title,
      flagPath ? BACKUP2 + flagPath : undefined,
      tokens.slice(0, 7)
    );
    if (ev) out.push(ev);
  }
  return out;
}

function upcoming(list) {
  const now = Date.now();
  return list.filter((e) => e.start + 3 * HOUR > now).sort((a, b) => a.start - b.start);
}

const AGENDA_SITES = [
  ["primary", agendaPrimary, 0],
  ["backup1", agendaBackup1, 2500],
  ["backup2", agendaBackup2, 4500],
];

async function loadAgenda() {
  let resolved = null;
  const promises = AGENDA_SITES.map(([name, fn, delay]) =>
    (async () => {
      if (delay) await new Promise((r) => setTimeout(r, delay));
      try {
        const kept = upcoming(await fn());
        if (kept.length && !resolved) {
          resolved = kept;
          return kept;
        }
        return kept;
      } catch (e) {
        return [];
      }
    })()
  );
  // Espera la primera que tenga partidos, o todas si ninguna responde
  await Promise.race([
    Promise.all(promises).then((lists) => {
      if (!resolved) {
        for (const list of lists) {
          if (list && list.length) {
            resolved = list;
            break;
          }
        }
      }
    }),
    new Promise((r) => setTimeout(r, 14000)),
  ]);
  return resolved || [];
}

function agenda() {
  return cached("agenda", 45000, loadAgenda);
}

function isLive(e) {
  const now = Date.now();
  return e.start - 10 * 60000 <= now && now <= e.start + MATCH_MS;
}

// ---- canales ----
const B1_LOGO = BACKUP1 + "/img/channels/";
const B2_LOGO = BACKUP2 + "/assets/channel-logos/manual/";

const MAIN = [
  ["espn", "ESPN", "espn", B1_LOGO + "espn-1.webp"],
  ["espn2", "ESPN 2", "espn2", B1_LOGO + "espn-2.webp"],
  ["espn3", "ESPN 3", "espn3", B1_LOGO + "espn-3.webp"],
  ["foxsports", "Fox Sports", "foxsports", B1_LOGO + "fox-sports-1.webp"],
  ["foxsports2", "Fox Sports 2", "foxsports2", B1_LOGO + "fox-sports-2.webp"],
  ["foxsports3", "Fox Sports 3", "foxsports3", B1_LOGO + "fox-sports-3.webp"],
  ["dsports", "DSports", "dsports", B2_LOGO + "channel-8.jpg"],
  ["dsports2", "DSports 2", "dsports2", B2_LOGO + "channel-8.jpg"],
  ["dsportsplus", "DSports Plus", "dsportsplus", B2_LOGO + "channel-8.jpg"],
  ["liga1max", "Liga 1 MAX", "liga1max", PRIMARY + "/img/logo-canal/liga_1_max.webp"],
  ["telemundo", "Telemundo", "telemundo", B2_LOGO + "channel-50.png"],
  ["espnmx", "ESPN México", "espnmx", B1_LOGO + "espn-1.webp"],
  ["espn2mx", "ESPN 2 México", "espn2mx", B1_LOGO + "espn-2.webp"],
  ["espn3mx", "ESPN 3 México", "espn3mx", B1_LOGO + "espn-3.webp"],
  ["foxsportsmx", "Fox Sports México", "foxsportsmx", B1_LOGO + "fox-sports-1.webp"],
  ["foxsports2mx", "Fox Sports 2 México", "foxsports2mx", B1_LOGO + "fox-sports-2.webp"],
  ["foxsports3mx", "Fox Sports 3 México", "foxsports3mx", B1_LOGO + "fox-sports-3.webp"],
  ["foxsportspremium", "Fox Sports Premium", "foxsportspremium", B1_LOGO + "fox-sports-premium.webp"],
  ["tudnmx", "TUDN México", "tudn_mx", B1_LOGO + "tudn-mx.webp"],
].map(([id, name, stream, logo]) => ({
  id: "c-" + id,
  name,
  stream,
  logo,
  tokens: withSisters(["tvf90." + stream, "la18." + stream]),
}));

async function moreChannels() {
  return cached("more", 30 * 60000, async () => {
    const html = await fetchText(BACKUP2 + "/channels", 12000);
    const out = [];
    const re = /<a class="channel-card" href="\/channel\/([a-z0-9-]{1,80})"><div class="channel-logo"><img src="([^"]+)" alt="([^"]*)"/g;
    let m;
    while ((m = re.exec(html))) {
      out.push({
        id: "b2-" + m[1],
        name: entities(m[3]) || m[1],
        logo: /\.svg$/i.test(m[2]) ? undefined : BACKUP2 + m[2],
        tokens: [1, 4, 2, 3].map((s) => `b2c.${m[1]}.${s}`),
      });
    }
    if (!out.length) throw new Error("channels empty");
    return out;
  }).catch(() => []);
}

// ---- shapes para la app (Nuvio) ----
// id = "c:" + tokens unidos → getStreams usa ese id para resolver
function refOf(tokens) {
  return "c:" + tokens.join(",");
}

function eventItem(e) {
  const live = isLive(e);
  return {
    id: refOf(e.tokens),
    title: e.title,
    type: "channel",
    poster: e.flag || undefined,
    overview: [e.league, whenText(e.start)].filter(Boolean).join(" · "),
    // extra para currentProgram / badge visual
    currentProgram: live ? t("live") : whenText(e.start),
    badges: [live ? t("live") : whenText(e.start)],
  };
}

function channelItem(c) {
  return {
    id: refOf(c.tokens),
    title: c.name,
    type: "channel",
    poster: c.logo || undefined,
    logo: c.logo || undefined,
  };
}

function norm(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// ---- API Nuvio que espera la app ----

/**
 * getHome() → filas del home del repo
 * Cada item con type "channel" abre el player en vivo (media_kit, sin barra).
 */
async function getHome() {
  const events = await agenda();
  const more = await moreChannels();
  const rows = [];

  const liveNow = events.filter(isLive).map(eventItem);
  if (liveNow.length) {
    rows.push({ id: "now", title: t("now"), type: "row", items: liveNow.slice(0, 30) });
  }

  const upcomingEv = events.filter((e) => !isLive(e) && e.start > Date.now()).map(eventItem);
  if (upcomingEv.length) {
    rows.push({ id: "next", title: t("next"), type: "row", items: upcomingEv.slice(0, 40) });
  }

  rows.push({
    id: "ch",
    title: t("channels"),
    type: "row",
    items: MAIN.map(channelItem),
  });

  if (more.length) {
    rows.push({
      id: "more",
      title: t("more"),
      type: "row",
      items: more.slice(0, 60).map(channelItem),
    });
  }

  return rows;
}

/**
 * search(query) → lista de ContentItem
 */
async function search(query) {
  const q = norm(typeof query === "string" ? query : (query && query.q) || "");
  if (q.length < 2) return [];
  const events = (await agenda())
    .filter((e) => norm(e.title + " " + e.league).includes(q))
    .map(eventItem);
  const chans = MAIN.filter((c) => norm(c.name).includes(q)).map(channelItem);
  const more = (await moreChannels()).filter((c) => norm(c.name).includes(q)).map(channelItem);
  return events.concat(chans).concat(more).slice(0, 50);
}

// ---- resolve de tokens (mismos servidores del plugin original) ----
const ID = /^[A-Za-z0-9_-]{1,40}$/;
const SLUG = /^[a-z0-9-]{1,100}$/;
const PLAYBACK = /playbackURL\s*=\s*"([^"]+)"/;

function unslash(s) {
  return String(s).replace(/\\\//g, "/");
}

async function get(url, headers, ms) {
  const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), ms || 8000) : null;
  try {
    const r = await fetch(url, {
      signal: ctrl ? ctrl.signal : undefined,
      headers: Object.assign(
        { "User-Agent": "Mozilla/5.0 (Linux; Android 12) AppleWebKit/537.36 Chrome/120.0.0.0 Mobile Safari/537.36" },
        headers || {}
      ),
    });
    return { ok: r.ok, status: r.status, text: await r.text() };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function viaTvf90(id, ms) {
  const r = await get(`https://tvf90.com/5.php?stream=${id}`, { Referer: "https://tvf90.com/" }, ms);
  const m = r.ok && PLAYBACK.exec(r.text);
  return m ? unslash(m[1]) : "";
}

async function viaLa18(id, plural, ms) {
  const r = await get(
    `https://la18hd.su/vivo/${plural ? "canales" : "canal"}.php?stream=${id}`,
    { "Sec-Fetch-Dest": "iframe" },
    ms
  );
  const m = r.ok && /"src":"([^"]+)"/.exec(r.text);
  return m ? unslash(m[1]) : "";
}

async function viaStreamxhd(id, ms) {
  const r = await get(`https://streamxhd.st/live1.php?stream=${id}`, { "Sec-Fetch-Dest": "iframe" }, ms);
  if (!r.ok) return "";
  const html = r.text;
  const arr = /var playbackURL="",(\w+)=\[\][^;]*;\s*\1=(\[\[[\s\S]*?\]\]);/.exec(html);
  const keyFns = /var k=(\w+)\(\)\+(\w+)\(\);/.exec(html);
  if (!arr || !keyFns) return "";
  const fn = (name) => {
    const f = new RegExp("function " + name + "\\(\\)\\{return (\\d+);\\}").exec(html);
    return f ? parseInt(f[1], 10) : NaN;
  };
  const k = fn(keyFns[1]) + fn(keyFns[2]);
  const pairs = [];
  const re = /\[(\d+),"([A-Za-z0-9+/=]+)"\]/g;
  let m;
  while ((m = re.exec(arr[2]))) pairs.push([parseInt(m[1], 10), m[2]]);
  if (!pairs.length || !Number.isFinite(k)) return "";
  pairs.sort((a, b) => a[0] - b[0]);
  let out = "";
  for (const [, b] of pairs) out += String.fromCharCode(parseInt(atob(b).replace(/\D/g, ""), 10) - k);
  return /^https:\/\//.test(out) ? out : "";
}

async function viaStreamtp(id, ms) {
  const r = await get(`https://streamtp99a.sbs/global1.php?stream=${id}`, {}, ms);
  const m = r.ok && PLAYBACK.exec(r.text);
  return m ? unslash(m[1]) : "";
}

async function viaBackup2(query, ms) {
  const r = await get(`${BACKUP2}/api/direct-playback.php?${query}`, {}, ms);
  if (!r.ok) return "";
  try {
    const data = JSON.parse(r.text);
    const tok = data && data.success ? tokenOf(data.url) : "";
    return tok && !tok.startsWith("b2") ? runToken(tok, ms) : "";
  } catch {
    return "";
  }
}

async function runToken(token, ms) {
  const [kind, a, b] = token.split(".");
  if (kind === "b2e" && SLUG.test(a) && /^\d{1,8}$/.test(b)) return viaBackup2(`type=event&slug=${a}&source=${b}`, ms);
  if (kind === "b2c" && SLUG.test(a) && /^[1-4]$/.test(b)) return viaBackup2(`type=channel&slug=${a}&server=${b}`, ms);
  if (!ID.test(a || "")) return "";
  if (kind === "tvf90") return viaTvf90(a, ms);
  if (kind === "la18") return viaLa18(a, false, ms);
  if (kind === "la18c") return viaLa18(a, true, ms);
  if (kind === "sxhd") return viaStreamxhd(a, ms);
  if (kind === "tp") return viaStreamtp(a, ms);
  return "";
}

async function verify(url) {
  // Solo verificamos hosts conocidos de playlist; el resto se confía
  if (!/^https:\/\/[^/]*\.(?:ftlly|fubo18|domhsd|futlivehd)\.com[:/]/.test(url)) return "ok";
  try {
    const r = await get(url, {}, 4500);
    if (r.ok) {
      if (/^#EXTM3U/.test(r.text.trimStart())) return "ok";
      return "offline";
    }
    return r.status >= 400 ? "offline" : "ok";
  } catch {
    return "slow";
  }
}

/**
 * getStreams(id) — la app llama esto al abrir un canal
 * id es "c:token1,token2,..."
 * Devuelve lista de { url, name?, quality?, headers? }
 */
async function getStreams(id) {
  const raw = String(id || "");
  const m = /^c:([A-Za-z0-9_.,-]{1,900})$/.exec(raw);
  if (!m) return [];

  const started = Date.now();
  const servers = [];
  let slow = "";

  for (const token of m[1].split(",").slice(0, 8)) {
    const left = 18000 - (Date.now() - started);
    if (left < 2500) break;
    try {
      const url = await runToken(token, Math.min(8000, left - 1500));
      if (!url) continue;
      const verdict = await verify(url);
      if (verdict === "offline") continue;
      if (verdict === "slow") {
        slow = slow || url;
        continue;
      }
      // Primer servidor bueno: devolver ya (la app puede pedir más, pero con uno basta para live)
      servers.push({
        url,
        name: token.split(".")[0].toUpperCase(),
        quality: "LIVE",
        headers: {},
      });
      // Devolvemos varios si hay tiempo, para que el usuario pueda cambiar de servidor
      if (servers.length >= 3) break;
    } catch (_) {}
  }

  if (!servers.length && slow) {
    servers.push({ url: slow, name: "BACKUP", quality: "LIVE", headers: {} });
  }
  return servers;
}

// Export CommonJS (la app carga con module.exports)
module.exports = {
  getHome,
  search,
  getStreams,
};
