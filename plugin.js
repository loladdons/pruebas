// CineHax+ — Plugin adaptado para la App (CommonJS / QuickJS Runtime)
// Basado íntegramente en la lógica oficial de cinehaxplus.com (JuandreXter)

const DEFAULT_BASE = "https://cinehaxplus.com";
const CACHE_MS = 7 * 24 * 3600 * 1000;
const UA = "Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36 Chrome/120 Safari/537.36";

function getConfig() {
  return (globalThis.__nuvioConfig && globalThis.__nuvioConfig.current) || {};
}

function getBase() {
  const cfg = getConfig();
  const custom = String(cfg.base_url || "").trim().replace(/\/+$/, "");
  return custom && /^https?:\/\//i.test(custom) ? custom : DEFAULT_BASE;
}

// Caché en memoria con TTL para acelerar búsquedas y temporadas
const _memCache = new Map();
function cacheGet(key) {
  try {
    const entry = _memCache.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      _memCache.delete(key);
      return null;
    }
    return JSON.parse(entry.raw);
  } catch (e) {
    return null;
  }
}

function cacheSet(key, value) {
  try {
    const raw = JSON.stringify(value);
    if (raw && raw.length < 120000) {
      _memCache.set(key, { raw: raw, expiresAt: Date.now() + CACHE_MS });
    }
  } catch (e) {}
}

// ──────────────────────────────────────────────────────────────
// RANKING & SIMILARITY (de sdk/kino-rank.mjs)
// ──────────────────────────────────────────────────────────────
const FOLD_ACCENTS = {
  á: "a", à: "a", ä: "a", â: "a", ã: "a", å: "a", é: "e", è: "e", ë: "e", ê: "e",
  í: "i", ì: "i", ï: "i", î: "i", ó: "o", ò: "o", ö: "o", ô: "o", õ: "o",
  ú: "u", ù: "u", ü: "u", û: "u", ñ: "n", ç: "c"
};

function foldAccents(text) {
  return String(text || "").replace(/[áàäâãåéèëêíìïîóòöôõúùüûñç]/g, function (c) {
    return FOLD_ACCENTS[c] || c;
  });
}

function titleTokens(text) {
  const plain = foldAccents(String(text || "").toLowerCase());
  const words = (plain.match(/[a-z0-9]+/g) || []).filter(function (w) { return w.length > 2; });
  return new Set(words);
}

function sharedCount(a, b) {
  let n = 0;
  a.forEach(function (t) { if (b.has(t)) n++; });
  return n;
}

function shortQuery(query) {
  const text = String(query || "").trim();
  const head = text.split(/[:,|–—]/)[0].trim();
  return head.length >= 3 ? head : text;
}

function sortBySimilarity(items, queries) {
  if (!Array.isArray(items)) return [];
  const qList = [].concat(queries).filter(function (q) { return typeof q === "string" && q.length > 0; });
  const requested = qList.map(titleTokens).filter(function (t) { return t.size > 0; });
  if (!requested.length) return items;

  return items
    .map(function (item, index) {
      const t = item && item.title ? String(item.title) : "";
      const ofItem = titleTokens(t);
      let maxScore = -1;
      if (t.length > 0) {
        maxScore = Math.max.apply(null, requested.map(function (r) { return sharedCount(r, ofItem); }));
      }
      return { item: item, index: index, score: maxScore };
    })
    .sort(function (a, b) { return b.score - a.score || a.index - b.index; })
    .map(function (x) { return x.item; });
}

// ──────────────────────────────────────────────────────────────
// HELPERS – URL, ids y texto (de plugin.js original)
// ──────────────────────────────────────────────────────────────
function siteUrl(href) {
  const BASE = getBase();
  const s = String(href || "");
  return /^https?:\/\//i.test(s) ? s : BASE + (s.charAt(0) === "/" ? s : "/" + s);
}

function parseHref(href) {
  const m = href && String(href).match(/\/(pelicula|serie)\/([^/#?]+)/);
  return m ? { type: m[1], slug: m[2] } : null;
}

function buildId(type, slug) {
  return type + "." + slug;
}

function parseItemId(rawId) {
  const s = String(rawId || "").trim();
  if (!s) return null;
  // Si viene como JSON ref {"type":"pelicula","slug":"..."}
  if (s.charAt(0) === "{") {
    try {
      const obj = JSON.parse(s);
      if (obj && obj.type && obj.slug) return obj;
    } catch (e) {}
  }
  // Si viene como URL o path /pelicula/slug
  const fromHref = parseHref(s);
  if (fromHref) return fromHref;
  // Si viene como "pelicula.slug_s1e2" o "serie.slug"
  const epMatch = /^(pelicula|serie)\.(.+?)_s(\d+)e(\d+)$/i.exec(s);
  if (epMatch) {
    return {
      type: "episodio",
      slug: epMatch[2],
      season: parseInt(epMatch[3], 10),
      episode: parseInt(epMatch[4], 10)
    };
  }
  const dotMatch = /^(pelicula|serie)\.(.+)$/i.exec(s);
  if (dotMatch) {
    return { type: dotMatch[1].toLowerCase(), slug: dotMatch[2] };
  }
  return { type: "pelicula", slug: s.replace(/^\/+/, "") };
}

function yearFromSlug(slug) {
  const m = String(slug || "").match(/-(\d{4})$/);
  return m ? m[1] : undefined;
}

function slugify(value) {
  const s = foldAccents(String(value || "").toLowerCase());
  return (s.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "fila").slice(0, 60);
}

function decodeEntities(value) {
  return String(value || "")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&");
}

function textOf(html) {
  return decodeEntities(String(html || "").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

function jsonLd(html) {
  const out = [];
  const re = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g;
  let m;
  const src = String(html || "");
  while ((m = re.exec(src)) !== null) {
    try {
      const data = JSON.parse(m[1]);
      if (Array.isArray(data)) out.push.apply(out, data);
      else if (data && Array.isArray(data["@graph"])) out.push.apply(out, data["@graph"]);
      else if (data) out.push(data);
    } catch (e) {}
  }
  return out;
}

function ldOf(html, types) {
  const all = jsonLd(html);
  const hasType = function (x) { return x && types && types.indexOf(x["@type"]) >= 0; };
  return all.find(hasType) || all.map(function (x) { return x && x.mainEntity; }).find(hasType) || null;
}

async function getText(path, customHeaders) {
  try {
    const r = await fetch(siteUrl(path), {
      method: "GET",
      headers: Object.assign({ "User-Agent": UA }, customHeaders || {})
    });
    return r.ok ? await r.text() : null;
  } catch (e) {
    return null;
  }
}

async function getJson(url, options) {
  try {
    const r = await fetch(url, options || { headers: { "User-Agent": UA } });
    if (!r.ok) return null;
    const txt = await r.text();
    return JSON.parse(txt);
  } catch (e) {
    return null;
  }
}

// ──────────────────────────────────────────────────────────────
// PARSEO DE TARJETAS Y SUGGEST
// ──────────────────────────────────────────────────────────────
function parseCards(html, limit) {
  const max = limit || 100;
  const out = [];
  const seen = new Set();
  const src = String(html || "");
  const blocks = [];
  const cardRe = /<a class="(?:pc|cd|t10)" href="([^"]+)">([\s\S]*?)<\/a>/g;
  let m;
  while ((m = cardRe.exec(src)) !== null) blocks.push([m[1], m[2]]);
  const rk = /<ol class="rk">([\s\S]*?)<\/ol>/.exec(src);
  if (rk) {
    const liRe = /<li><a href="([^"]+)">([\s\S]*?)<\/a><\/li>/g;
    while ((m = liRe.exec(rk[1])) !== null) blocks.push([m[1], m[2]]);
  }

  for (let i = 0; i < blocks.length; i++) {
    if (out.length >= max) break;
    const href = blocks[i][0];
    const block = blocks[i][1];
    const where = parseHref(href);
    if (!where) continue;
    const type = where.type;
    const slug = where.slug;
    const id = buildId(type, slug);
    if (seen.has(id)) continue;
    seen.add(id);

    const titleTag = /<span class="(?:pc-t|cd-t)">([\s\S]*?)<\/span>/.exec(block);
    const alt = /alt="([^"]*)"/.exec(block);
    const title = textOf(titleTag ? titleTag[1] : alt ? alt[1] : "") || slug.replace(/-/g, " ");

    const yearM = /<span>(\d{4})<\/span>/.exec(block);
    const stkM = /class="stk">([\d.]+)</.exec(block);
    const pctM = /class="match">(\d{1,3})%/.exec(block) || /(\d{1,3})%/.exec(block);
    const imgM = /<img[^>]+src="(https:\/\/image\.tmdb\.org\/[^"]+)"/.exec(block);
    const image = imgM ? imgM[1] : undefined;

    const item = {
      id: id,
      title: title,
      type: type === "pelicula" ? "movie" : "series",
      year: yearM ? yearM[1] : yearFromSlug(slug),
      poster: image,
      backdrop: image
    };
    if (stkM) item.rating = Number(stkM[1]);
    else if (pctM) item.rating = Number(pctM[1]) / 10;
    out.push(item);
  }
  return out;
}

async function suggest(text) {
  const BASE = getBase();
  const body = await getText(BASE + "/api/suggest?q=" + encodeURIComponent(text));
  if (!body) return [];
  let data;
  try { data = JSON.parse(body); } catch (e) { return []; }
  const out = [];
  const titles = (data && Array.isArray(data.titles)) ? data.titles : [];
  for (let i = 0; i < titles.length; i++) {
    const t = titles[i];
    const where = parseHref(t && t.url);
    if (!where) continue;
    out.push({
      type: where.type,
      slug: where.slug,
      title: typeof t.title === "string" && t.title ? t.title : undefined,
      year: t.year ? String(t.year) : undefined,
      poster: typeof t.poster === "string" ? t.poster : undefined,
      rating: typeof t.rating === "number" ? t.rating : undefined
    });
  }
  return out;
}

async function suggestHits(text) {
  const key = "buscar:" + String(text).toLowerCase();
  const saved = cacheGet(key);
  if (Array.isArray(saved)) return saved;

  let hits = await suggest(text);
  if (!hits.length) {
    const head = shortQuery(text);
    if (head && head !== text) hits = await suggest(head);
  }
  if (hits.length) cacheSet(key, hits);
  return hits;
}

function suggestItem(x) {
  const item = {
    id: buildId(x.type, x.slug),
    title: x.title || x.slug.replace(/-/g, " "),
    type: x.type === "pelicula" ? "movie" : "series",
    year: x.year || yearFromSlug(x.slug),
    poster: x.poster,
    backdrop: x.poster
  };
  if (typeof x.rating === "number") item.rating = x.rating;
  return item;
}

function mergeSuggest(items, extra) {
  if (!extra.length) return items;
  const byKey = new Map(extra.map(function (x) { return [x.type + "." + x.slug, x]; }));
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const hit = byKey.get(item.id);
    if (!hit) continue;
    if (hit.poster) { item.poster = hit.poster; item.backdrop = hit.poster; }
    if (typeof hit.rating === "number") item.rating = hit.rating;
    if (hit.year) item.year = hit.year;
    if (hit.title) item.title = hit.title;
  }
  return items;
}

// ──────────────────────────────────────────────────────────────
// 1. AVISOS / MODAL DE PRIMERA VERSIÓN (getNotices / getAds)
// ──────────────────────────────────────────────────────────────
async function getNotices() {
  return [
    {
      id: "aviso_primera_version_v1",
      title: "🚀 ¡Bienvenido a CineHax+ (Primera Versión)!",
      message:
        "Esta es la primera versión oficial del repositorio adaptada para la app. Si encuentras algún error al cargar algún título, catálogo o servidor, no te preocupes: se irá solucionando y optimizando en futuras actualizaciones."
    }
  ];
}

// ──────────────────────────────────────────────────────────────
// 2. NOVEDADES PARA EL HOME DEL LAUNCHER (getNews)
// ──────────────────────────────────────────────────────────────
async function getNews() {
  const BASE = getBase();
  const html = await getText(BASE + "/");
  if (!html) return [];
  const rows = parseHomeSections(html);
  const pool = rows.length ? rows[0].items : parseCards(html, 12);
  return pool.slice(0, 12).map(function (it) {
    return {
      id: it.id,
      title: it.title,
      subtitle: (it.type === "series" ? "Serie" : "Película") + (it.year ? " · " + it.year : ""),
      poster: it.poster,
      backdrop: it.backdrop || it.poster,
      imageStyle: "poster"
    };
  });
}

// ──────────────────────────────────────────────────────────────
// 3. CATÁLOGOS / COLECCIONES (getCatalogs & getCatalog)
// ──────────────────────────────────────────────────────────────
const CATALOGS_DEF = [
  { id: "peliculas", title: "Películas Recién Añadidas", description: "Últimas películas subidas a CineHax+" },
  { id: "trending", title: "Películas en Tendencia", description: "Las películas más vistas de la semana" },
  { id: "popular", title: "Películas Populares", description: "Favoritas de la comunidad" },
  { id: "rating", title: "Películas Mejor Valoradas", description: "Aclamadas por la crítica y usuarios" },
  { id: "peliculas-release", title: "Películas de Estreno", description: "Lanzamientos más recientes por fecha de estreno" },
  { id: "series", title: "Series Recién Añadidas", description: "Nuevas series agregadas al catálogo" },
  { id: "series-trending", title: "Series en Tendencia", description: "Series más vistas esta semana" },
  { id: "series-popular", title: "Series Populares", description: "Las series más reproducidas" },
  { id: "series-rating", title: "Series Mejor Valoradas", description: "Series con mejor calificación" },
  { id: "series-release", title: "Estrenos de Series", description: "Últimos estrenos en series" }
];

function listUrl(data, page) {
  const BASE = getBase();
  const p = Math.max(1, Number(page) || 1);
  const path = function (base, query) {
    return p > 1 ? base + "/page/" + p + (query || "") : base + (query || "");
  };
  if (data.genero) return path(BASE + "/genero/" + encodeURIComponent(data.genero));
  switch (data.list) {
    case "home": return p > 1 ? BASE + "/page/" + p : BASE + "/";
    case "trending": return path(BASE + "/peliculas", "?sort=trending");
    case "popular": return path(BASE + "/peliculas", "?sort=popular");
    case "rating": return path(BASE + "/peliculas", "?sort=rating");
    case "peliculas-release": return path(BASE + "/peliculas", "?sort=release");
    case "peliculas": return path(BASE + "/peliculas");
    case "series-release": return path(BASE + "/series", "?sort=release");
    case "series-popular": return path(BASE + "/series", "?sort=popular");
    case "series-rating": return path(BASE + "/series", "?sort=rating");
    case "series-trending": return path(BASE + "/series", "?sort=trending");
    case "series": return path(BASE + "/series");
    default: return path(BASE + "/peliculas");
  }
}

async function getCatalogs() {
  const modo = String(getConfig().pestanas || "ambas");
  return CATALOGS_DEF.filter(function (c) {
    if (modo === "peliculas") return c.id.indexOf("series") !== 0;
    if (modo === "series") return c.id.indexOf("series") === 0;
    return true;
  });
}

async function getCatalog(catalogId, opts) {
  const page = (opts && opts.page) ? Number(opts.page) : 1;
  const id = String(catalogId || "peliculas");
  let data = { list: id };
  if (id.indexOf("genero-") === 0) {
    data = { genero: id.replace(/^genero-/, "") };
  }
  const url = listUrl(data, page);
  const html = await getText(url);
  if (!html) return { items: [], hasMore: false, page: page };
  const items = parseCards(html, 100);
  const hasMore = /<link rel="next"/.test(html) || items.length >= 20;
  return {
    items: items,
    hasMore: hasMore,
    page: page
  };
}

// ──────────────────────────────────────────────────────────────
// 4. HOME DEL REPO (getHome)
// ──────────────────────────────────────────────────────────────
function parseHomeSections(html) {
  const rows = [];
  const ids = new Set();
  const sections = String(html || "").split('<section class="row">').slice(1);
  for (let i = 0; i < sections.length; i++) {
    const section = sections[i].split("</section>")[0];
    const titleM = /<h2 class="row-t">([\s\S]*?)<\/h2>/.exec(section);
    const title = titleM ? textOf(titleM[1]) : "";
    if (!title) continue;
    const items = parseCards(section, 60);
    if (!items.length) continue;

    let id = slugify(title);
    for (let n = 2; ids.has(id); n++) id = slugify(title) + "-" + n;
    ids.add(id);

    rows.push({
      id: id,
      title: title,
      type: "row",
      imageStyle: "poster",
      items: items
    });
    if (rows.length >= 18) break;
  }
  return rows;
}

async function getHome() {
  const BASE = getBase();
  const html = await getText(BASE + "/");
  if (!html) return [];

  const parsedRows = parseHomeSections(html);
  if (!parsedRows.length) return [];

  const out = [];

  // 1) Hero principal con los destacados de la primera fila
  const firstRow = parsedRows[0];
  out.push({
    id: "hero_" + firstRow.id,
    title: firstRow.title,
    type: "hero",
    imageStyle: "backdrop",
    items: firstRow.items.slice(0, 8)
  });

  // 2) Fila de Catálogos Interactivos en el Home
  const cats = await getCatalogs();
  const sampleItems = firstRow.items;
  out.push({
    id: "catalogs_row",
    title: "Catálogos y Colecciones",
    type: "catalog",
    imageStyle: "backdrop",
    items: cats.map(function (c, i) {
      const sample = sampleItems[i % sampleItems.length];
      return {
        id: c.id,
        title: c.title,
        overview: c.description,
        poster: sample ? sample.poster : undefined,
        backdrop: sample ? (sample.backdrop || sample.poster) : undefined,
        type: "catalog"
      };
    })
  });

  // 3) Resto de filas de la portada de CineHax+
  for (let i = 0; i < parsedRows.length; i++) {
    out.push(parsedRows[i]);
  }

  return out;
}

// ──────────────────────────────────────────────────────────────
// 5. DESCUBRIR + FILTROS (getDiscoverFilters & getDiscover)
// ──────────────────────────────────────────────────────────────
const GENRES = [
  ["drama", "Drama"], ["comedia", "Comedia"], ["suspense", "Suspense"], ["accion", "Acción"],
  ["terror", "Terror"], ["animacion", "Animación"], ["crimen", "Crimen"], ["romance", "Romance"],
  ["aventura", "Aventura"], ["misterio", "Misterio"], ["familia", "Familia"], ["ciencia-ficcion", "Ciencia ficción"],
  ["fantasia", "Fantasía"], ["ciencia-ficcion-y-fantasia", "Ciencia ficción y fantasía"],
  ["accion-y-aventura", "Acción y aventura"], ["documental", "Documental"], ["pelicula-de-tv", "Película de TV"],
  ["historia", "Historia"], ["musica", "Música"], ["belica", "Bélica"], ["western", "Western"],
  ["infantil", "Infantil"], ["belica-y-politica", "Bélica y política"], ["reality", "Reality"],
  ["telenovela", "Telenovela"], ["talk-show", "Talk show"]
];

async function getDiscoverFilters() {
  return [
    {
      id: "list",
      label: "Lista",
      options: [
        { id: "peliculas", label: "Películas recién añadidas" },
        { id: "trending", label: "Películas en tendencia" },
        { id: "popular", label: "Películas populares" },
        { id: "rating", label: "Películas mejor valoradas" },
        { id: "peliculas-release", label: "Películas de estreno" },
        { id: "series", label: "Series recién añadidas" },
        { id: "series-trending", label: "Series en tendencia" },
        { id: "series-popular", label: "Series populares" },
        { id: "series-rating", label: "Series mejor valoradas" },
        { id: "series-release", label: "Series de estreno" }
      ]
    },
    {
      id: "genero",
      label: "Género",
      options: [{ id: "todos", label: "Todos (usar Lista)" }].concat(
        GENRES.map(function (g) { return { id: g[0], label: g[1] }; })
      )
    }
  ];
}

async function getDiscover(opts) {
  opts = opts || {};
  const page = Math.max(1, Number(opts.page) || 1);
  const genero = opts.genero && opts.genero !== "todos" ? String(opts.genero) : null;
  const list = String(opts.list || opts.filter || "peliculas");

  const url = listUrl(genero ? { genero: genero } : { list: list }, page);
  const html = await getText(url);
  if (!html) return { items: [], hasMore: false, page: page };

  const items = parseCards(html, 100);
  const hasMore = /<link rel="next"/.test(html) || items.length >= 20;
  return {
    items: items,
    hasMore: hasMore,
    page: page
  };
}

// ──────────────────────────────────────────────────────────────
// 6. BUSCADOR (search)
// ──────────────────────────────────────────────────────────────
async function search(query) {
  const q = typeof query === "string"
    ? query.trim()
    : String((query && (query.q || query.query)) || "").trim();
  if (!q) return [];

  const BASE = getBase();
  let html = await getText(BASE + "/search?q=" + encodeURIComponent(q));
  let items = html ? parseCards(html, 100) : [];

  if (!items.length) {
    items = (await suggestHits(q)).map(suggestItem);
  } else {
    mergeSuggest(items, await suggestHits(q));
  }

  if (!items.length) return [];
  return sortBySimilarity(items, [q]).slice(0, 100);
}

// ──────────────────────────────────────────────────────────────
// 7. DETALLES Y TEMPORADAS / EPISODIOS (getMeta)
// ──────────────────────────────────────────────────────────────
function seasonNumbers(html) {
  const found = new Set();
  const series = ldOf(html, ["TVSeries"]);
  const contains = (series && Array.isArray(series.containsSeason)) ? series.containsSeason : [];
  for (let i = 0; i < contains.length; i++) {
    const s = contains[i];
    const n = s && Number(s.seasonNumber);
    if (Number.isInteger(n) && n >= 1 && n <= 999) found.add(n);
  }
  const re = /\/serie\/[^"'?]+\/temporada\/(\d+)/g;
  let m;
  const src = String(html || "");
  while ((m = re.exec(src)) !== null) {
    const n = parseInt(m[1], 10);
    if (n >= 1 && n <= 999) found.add(n);
  }
  return Array.from(found).sort(function (a, b) { return a - b; }).slice(0, 50);
}

function parseEpisodes(html, slug) {
  const out = [];
  const re = /<a class="ep" href="([^"]+)">([\s\S]*?)<\/a>/g;
  let m;
  const src = String(html || "");
  while ((m = re.exec(src)) !== null) {
    const where = /\/temporada\/(\d+)\/episodio\/(\d+)/.exec(m[1]);
    if (!where) continue;
    const season = parseInt(where[1], 10);
    const number = parseInt(where[2], 10);
    if (!(season >= 1 && number >= 1)) continue;
    const block = m[2];

    const titleM = /<span class="ep-t">([\s\S]*?)<\/span>/.exec(block);
    const overviewM = /<span class="ep-o">([\s\S]*?)<\/span>/.exec(block);
    const durationM = /<span class="ep-d">(\d+)\s*min/.exec(block);
    const stillM = /<img[^>]+src="(https:\/\/image\.tmdb\.org\/[^"]+)"/.exec(block);

    const ep = {
      number: number,
      id: buildId("serie", slug) + "_s" + season + "e" + number,
      title: (titleM ? textOf(titleM[1]).replace(/^\d+\.\s*/, "") : "") || ("Capítulo " + number)
    };
    const overview = overviewM ? textOf(overviewM[1]) : "";
    if (overview) ep.overview = overview;
    if (durationM) ep.runtime = parseInt(durationM[1], 10);
    if (stillM) ep.still = stillM[1].replace(/\/t\/p\/[a-z0-9]+\//, "/t/p/w500/");
    out.push(ep);
  }

  if (!out.length) {
    const seasonLd = ldOf(html, ["TVSeason"]);
    const eps = (seasonLd && Array.isArray(seasonLd.episode)) ? seasonLd.episode : [];
    const sNum = (seasonLd && Number(seasonLd.seasonNumber)) || 1;
    for (let i = 0; i < eps.length; i++) {
      const e = eps[i];
      const number = e && Number(e.episodeNumber);
      if (!Number.isInteger(number) || number < 1) continue;
      out.push({
        number: number,
        id: buildId("serie", slug) + "_s" + sNum + "e" + number,
        title: (typeof e.name === "string" && e.name) || ("Capítulo " + number)
      });
    }
  }
  return out;
}

async function getMeta(rawId) {
  const parsed = parseItemId(rawId);
  if (!parsed) return null;

  const BASE = getBase();
  const type = parsed.type === "serie" || parsed.type === "series" ? "serie" : "pelicula";
  const slug = parsed.slug;

  if (type === "pelicula") {
    const html = await getText(BASE + "/pelicula/" + slug);
    if (!html) return null;
    const movie = ldOf(html, ["Movie"]);
    const images = movie && movie.image ? (Array.isArray(movie.image) ? movie.image : [movie.image]) : [];
    const ratingVal = movie && movie.aggregateRating && movie.aggregateRating.ratingValue
      ? Number(movie.aggregateRating.ratingValue)
      : undefined;
    const year = (movie && typeof movie.datePublished === "string" && movie.datePublished.slice(0, 4)) || yearFromSlug(slug);

    return {
      id: buildId("pelicula", slug),
      title: (movie && movie.name) || slug.replace(/-/g, " "),
      poster: images[0],
      backdrop: images[1] || images[0],
      overview: (movie && movie.description) || "",
      type: "movie",
      rating: ratingVal,
      year: year,
      genres: (movie && Array.isArray(movie.genre)) ? movie.genre.slice(0, 5) : []
    };
  }

  // Serie: cargar temporadas y sus episodios (con caché)
  const cacheKey = "meta_serie:" + slug;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const serieHtml = await getText(BASE + "/serie/" + slug);
  if (!serieHtml) return null;

  const series = ldOf(serieHtml, ["TVSeries"]);
  const images = series && series.image ? (Array.isArray(series.image) ? series.image : [series.image]) : [];
  const ratingVal = series && series.aggregateRating && series.aggregateRating.ratingValue
    ? Number(series.aggregateRating.ratingValue)
    : undefined;
  const year = (series && typeof series.startDate === "string" && series.startDate.slice(0, 4)) || yearFromSlug(slug);

  const sNums = seasonNumbers(serieHtml);
  const seasons = [];

  for (let i = 0; i < sNums.length; i += 6) {
    const chunk = sNums.slice(i, i + 6);
    const pages = await Promise.all(chunk.map(function (n) {
      return getText(BASE + "/serie/" + slug + "/temporada/" + n);
    }));
    for (let j = 0; j < chunk.length; j++) {
      const sNum = chunk[j];
      const pHtml = pages[j];
      if (!pHtml) continue;
      const eps = parseEpisodes(pHtml, slug);
      if (eps.length) {
        seasons.push({
          number: sNum,
          name: "Temporada " + sNum,
          episodes: eps
        });
      }
    }
  }

  const result = {
    id: buildId("serie", slug),
    title: (series && series.name) || slug.replace(/-/g, " "),
    poster: images[0],
    backdrop: images[1] || images[0],
    overview: (series && series.description) || "",
    type: "series",
    rating: ratingVal,
    year: year,
    genres: (series && Array.isArray(series.genre)) ? series.genre.slice(0, 5) : [],
    seasons: seasons
  };

  if (seasons.length) cacheSet(cacheKey, result);
  return result;
}

// ──────────────────────────────────────────────────────────────
// 8. SERVIDORES DE REPRODUCCIÓN (getStreams)
// ──────────────────────────────────────────────────────────────
function embedTag(html) {
  const m = /data-embed="([^"]+)"/.exec(String(html || ""));
  if (!m) return null;
  const tag = decodeEntities(m[1]);
  const src = (/\ssrc="([^"]+)"/.exec(tag) || [])[1];
  const pass = (/\sdata-pass="([^"]+)"/.exec(tag) || [])[1];
  return src && pass ? { src: siteUrl(src), pass: siteUrl(pass) } : null;
}

function originOf(url) {
  const m = /^https?:\/\/[^/]+/.exec(String(url || ""));
  return m ? m[0] : null;
}

function embParams(emb) {
  let qs = "tmdb=" + emb.tmdb + "&type=" + emb.type;
  if (emb.type === "tv") qs += "&season=" + (emb.season || 1) + "&episode=" + (emb.episode || 1);
  return qs;
}

function embFromSrc(src) {
  const m = /\/embed\/(movie|tv)\/(\d+)(?:\/(\d+)\/(\d+))?/.exec(String(src || ""));
  if (!m) return null;
  const emb = { type: m[1], tmdb: parseInt(m[2], 10) };
  if (m[1] === "tv") {
    emb.season = parseInt(m[3] || "1", 10) || 1;
    emb.episode = parseInt(m[4] || "1", 10) || 1;
  }
  const lang = (/[?&]lang=([A-Za-z]{3})/.exec(src) || [])[1];
  if (lang) emb.lang = lang;
  return emb;
}

function ordenaServidores(lista, lang) {
  const peso = function (s) { return lang && s.lang === lang ? 0 : 1; };
  return lista.slice().sort(function (a, b) {
    return (
      peso(a) - peso(b) ||
      ((a.mode === "proxy" ? 1 : 0) - (b.mode === "proxy" ? 1 : 0)) ||
      ((a.detras ? 1 : 0) - (b.detras ? 1 : 0)) ||
      ((a.src || 9) - (b.src || 9))
    );
  });
}

function soloAnuncios(direcciones) {
  if (!direcciones.length) return false;
  for (let i = 0; i < direcciones.length; i++) {
    if (!/tiktokcdn|ad-site|\/ad\//i.test(direcciones[i])) return false;
  }
  return true;
}

async function listaSana(url, opciones) {
  try {
    const r = await fetch(url, opciones);
    if (!r.ok) return true;
    const txt = await r.text();
    if (txt.indexOf("#EXTM3U") < 0) return false;
    const urls = txt.split("\n").filter(function (l) { return l && l.charAt(0) !== "#"; });
    if (txt.indexOf("#EXTINF") >= 0) return !soloAnuncios(urls);
    if (!urls[0]) return false;
    const nextUrl = new URL(urls[0], url).href;
    const v = await fetch(nextUrl, opciones);
    if (!v.ok) return false;
    const vt = await v.text();
    if (vt.indexOf("#EXTM3U") < 0) return false;
    return !soloAnuncios(vt.split("\n").filter(function (l) { return l && l.charAt(0) !== "#"; }));
  } catch (e) {
    return true;
  }
}

function mapLangLabel(code) {
  const c = String(code || "").toUpperCase();
  if (c === "LAT" || c.indexOf("LAT") >= 0) return "Latino";
  if (c === "ESP" || c === "CAS" || c.indexOf("CAST") >= 0) return "Castellano";
  if (c === "SUB" || c.indexOf("SUB") >= 0) return "Subtitulado";
  if (c === "ENG" || c === "EN") return "Inglés";
  return code || "Latino";
}

async function getStreams(rawId, type, season, episode) {
  const BASE = getBase();
  const parsed = parseItemId(rawId);
  if (!parsed || !parsed.slug) return [];

  const slug = parsed.slug;
  const sNum = Number(season || parsed.season || 0);
  const eNum = Number(episode || parsed.episode || 0);
  const isSeries =
    type === "series" ||
    type === "tv" ||
    parsed.type === "serie" ||
    parsed.type === "episodio" ||
    (sNum >= 1 && eNum >= 1);

  let watchUrl;
  if (isSeries) {
    const se = sNum >= 1 ? sNum : 1;
    const ep = eNum >= 1 ? eNum : 1;
    watchUrl = BASE + "/serie/" + slug + "/temporada/" + se + "/episodio/" + ep;
  } else {
    watchUrl = BASE + "/pelicula/" + slug;
  }

  const page = await getText(watchUrl);
  const embed = embedTag(page);
  if (!embed) return [];

  const pass = await getJson(embed.pass, {
    headers: { "User-Agent": UA, "Referer": watchUrl }
  });
  if (!pass || !pass.pass) return [];

  const sep = embed.src.indexOf("?") >= 0 ? "&" : "?";
  const embedRes = await fetch(embed.src + sep + "pass=" + encodeURIComponent(pass.pass), {
    headers: { "User-Agent": UA, "Referer": BASE + "/" }
  });
  const embedHtml = embedRes.ok ? await embedRes.text() : null;
  if (!embedHtml) return [];

  const ui = (embedHtml.match(/PM_UI="([^"]+)"/) || [])[1];
  let emb = null;
  try {
    emb = JSON.parse((embedHtml.match(/PM_EMBED=(\{[^}]+\})/) || [])[1] || "null");
  } catch (e) {}
  if (!emb) emb = embFromSrc(embed.src);
  const origin = originOf(embed.src);
  if (!ui || !emb || !emb.tmdb || !origin) return [];

  const params = embParams(emb);
  const pide = { headers: { "User-Agent": UA, "Referer": origin + "/" } };
  const srv = await getJson(origin + "/servers?" + params + "&ui=" + encodeURIComponent(ui), pide);
  const lista = (srv && Array.isArray(srv.servers)) ? srv.servers : [];
  if (!lista.length) return [];

  const orden = ordenaServidores(lista, emb.lang);
  const streams = [];

  for (let i = 0; i < orden.length && i < 10; i++) {
    const s = orden[i];
    const v = await getJson(
      origin + "/video?" + params + "&noiframe=1&embed=" + encodeURIComponent(s.id) + "&r=1&ui=" + encodeURIComponent(ui),
      pide
    );
    if (!v || !v.url || v.type === "iframe") continue;
    if ((v.type === "hls" || v.type === "dash") && !(await listaSana(v.url, pide))) {
      continue;
    }
    const langLabel = mapLangLabel(s.lang || emb.lang || "LAT");
    const srvName = s.name || s.host || ("Servidor " + (i + 1));
    streams.push({
      name: srvName + " · 1080p",
      url: v.url,
      quality: "1080p",
      language: langLabel,
      provider: s.site || s.host || "CineHax+",
      isHls: v.type === "hls" || String(v.url).indexOf(".m3u8") >= 0,
      headers: {
        "User-Agent": UA,
        "Referer": origin + "/"
      }
    });
  }

  return streams;
}

module.exports = {
  getNotices: getNotices,
  getAds: getNotices,
  getAnnouncements: getNotices,
  getNews: getNews,
  getHome: getHome,
  getCatalogs: getCatalogs,
  getCatalog: getCatalog,
  getDiscoverFilters: getDiscoverFilters,
  getDiscover: getDiscover,
  search: search,
  getMeta: getMeta,
  getStreams: getStreams
};
