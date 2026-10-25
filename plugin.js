/**
 * Cuevana Pro — Addon SDK v6 (port 1.0.0)
 * Fuente: wv3.cuevana3.eu
 * Primera versión: catálogo, búsqueda, meta, episodios y servidores.
 * Se esperan mejoras en extractores y mirrors.
 */

const SITE = "https://wv3.cuevana3.eu";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const PAGE_SIZE = 24;

const GENRES = [
  ["accion", "Acción"],
  ["animacion", "Animación"],
  ["aventura", "Aventura"],
  ["ciencia-ficcion", "Ciencia Ficción"],
  ["crimen", "Crimen"],
  ["drama", "Drama"],
  ["familia", "Familia"],
  ["fantasia", "Fantasía"],
  ["misterio", "Misterio"],
  ["romance", "Romance"],
  ["suspense", "Suspense"],
  ["terror", "Terror"]
];

const MIRRORS = [
  ["streamwish.to", "vibuxer.com"],
  ["hglink.to", "vibuxer.com"],
  ["swdyu.com", "vibuxer.com"],
  ["cybervynx.com", "vibuxer.com"],
  ["dumbalag.com", "vibuxer.com"],
  ["mivalyo.com", "vidhidepro.com"],
  ["dinisglows.com", "vidhidepro.com"],
  ["dhtpre.com", "vidhidepro.com"]
];

// Preferencia de idioma (inyectada por setConfig)
let userConfig = { pref_lang: "latino" };

function setConfig(_addonId, cfg) {
  if (cfg && typeof cfg === "object") {
    userConfig = { ...userConfig, ...cfg };
  }
}

function fixHost(url) {
  try {
    const u = new URL(url);
    for (const [from, to] of MIRRORS) {
      if (u.hostname === from) {
        u.hostname = to;
        return u.href;
      }
    }
  } catch (_) {}
  return url;
}

function decode(s) {
  return String(s || "")
    .replace(/&#0?38;|&amp;/g, "&")
    .replace(/&quot;|&#0?34;/g, '"')
    .replace(/&#0?39;|&#x27;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function text(s) {
  return decode(String(s || "").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

function posterOf(src) {
  const s = decode(src || "");
  if (s.startsWith("/_next/image?url=")) {
    try {
      return decodeURIComponent(s.slice("/_next/image?url=".length).split("&")[0]);
    } catch (_) {
      return "";
    }
  }
  return s.startsWith("/") ? SITE + s : s;
}

function sized(u, w) {
  return String(u || "").replace("/t/p/original/", `/t/p/${w}/`);
}

function yearOf(d) {
  const m = /^(\d{4})/.exec(d || "");
  return m ? Number(m[1]) : undefined;
}

async function fetchText(url, opts = {}) {
  const headers = {
    "User-Agent": UA,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "es-ES,es;q=0.9,en;q=0.8",
    ...(opts.headers || {})
  };
  const res = await fetch(url, {
    method: opts.method || "GET",
    headers,
    redirect: "follow"
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return await res.text();
}

function nextData(html) {
  const m = /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/.exec(String(html || ""));
  if (!m) return null;
  try {
    return JSON.parse(m[1]).props.pageProps || null;
  } catch (_) {
    return null;
  }
}

function parseCards(html) {
  const out = [];
  const seen = new Set();
  for (const c of String(html || "").split('<li class="TPostMv"').slice(1)) {
    const href = /href="\/ver-(pelicula|serie)\/([^"\/?#]+)"/.exec(c);
    const title = /<span class="Title block">([\s\S]*?)<\/span>/.exec(c);
    if (!href || !title || seen.has(href[1] + href[2])) continue;
    seen.add(href[1] + href[2]);
    const pic = /<img[^>]*\bsrc="([^"]+)"/.exec(c);
    const year = /<span class="Year">\s*(\d{4})/.exec(c) || /class="Date[^"]*">\s*(\d{4})/.exec(c);
    const vote = /<span class="Vote[^"]*">\s*([\d.]+)/.exec(c);
    out.push({
      slug: href[2],
      kind: href[1] === "pelicula" ? "movie" : "series",
      title: text(title[1]),
      year: year ? Number(year[1]) : undefined,
      poster: pic ? sized(posterOf(pic[1]), "w500") : "",
      rating: vote ? Number(vote[1]) : undefined
    });
  }
  return out;
}

function parseTitle(html) {
  const p = nextData(html);
  const t = p && (p.thisMovie || p.thisSerie);
  if (!t || !t.titles) return null;
  const seasons = (t.seasons || [])
    .map((s) => ({
      number: Number(s.number),
      name: `Temporada ${s.number}`,
      episodes: (s.episodes || []).map((e) => ({
        number: Number(e.number),
        id: e.id || `e${e.number}`,
        title: String(e.title || `Episodio ${e.number}`),
        overview: String(e.overview || e.description || "").trim() || undefined,
        still: sized(e.image, "w300") || undefined,
        runtime: e.runtime ? Number(e.runtime) : undefined
      }))
    }))
    .filter((s) => s.episodes.length);
  return {
    tmdb: Number(t.TMDbId) > 0 ? Number(t.TMDbId) : undefined,
    kind: p.thisMovie ? "movie" : "series",
    slug: t.slug && t.slug.name ? String(t.slug.name) : "",
    title: String(t.titles.name || ""),
    original: String((t.titles.original && t.titles.original.name) || ""),
    overview: String(t.overview || "").trim(),
    genres: (t.genres || []).map((g) => String(g.name)),
    year: yearOf(t.releaseDate),
    runtimeMinutes: t.runtime ? Number(t.runtime) : undefined,
    rating: t.rate && t.rate.average ? Number(t.rate.average) : undefined,
    poster: sized(t.images && t.images.poster, "w500"),
    backdrop: sized(t.images && t.images.backdrop, "w1280"),
    seasons
  };
}

function parseServers(html) {
  const p = nextData(html);
  const t = p && (p.thisMovie || p.episode);
  const v = t && t.videos;
  if (!v) return [];
  const out = [];
  for (const [lang, list] of Object.entries(v)) {
    for (const e of Array.isArray(list) ? list : []) {
      if (e && typeof e.result === "string") {
        out.push({
          lang: String(lang),
          host: String(e.cyberlocker || e.host || "server"),
          url: e.result
        });
      }
    }
  }
  return out;
}

function parsePlayer(html) {
  const m = /var url = '([^']+)'/.exec(String(html || ""));
  return m ? fixHost(m[1]) : null;
}

function cardToItem(c) {
  return {
    id: `${c.kind === "movie" ? "m" : "s"}:${c.slug}`,
    title: c.title,
    poster: c.poster || "",
    type: c.kind === "movie" ? "movie" : "series",
    year: c.year ? String(c.year) : undefined,
    rating: c.rating
  };
}

function langLabel(lang) {
  const map = {
    latino: "Latino",
    spanish: "Castellano",
    english: "Inglés",
    japanese: "Japonés",
    subtitulado: "Subtitulado"
  };
  return map[String(lang || "").toLowerCase()] || String(lang || "");
}

function preferLang(servers) {
  const pref = String(userConfig.pref_lang || "latino").toLowerCase();
  const order = [pref, "latino", "spanish", "english", "japanese"];
  return [...servers].sort((a, b) => {
    const ia = order.indexOf(String(a.lang).toLowerCase());
    const ib = order.indexOf(String(b.lang).toLowerCase());
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  });
}

const LIST_PATHS = {
  peliculas: { path: "/peliculas", title: "Películas actualizadas" },
  series: { path: "/series", title: "Series actualizadas" },
  estrenos: { path: "/estrenos", title: "Películas estrenos" },
  sestrenos: { path: "/series/estrenos", title: "Series estrenos" },
  tendencias: { path: "/tendencias/peliculas", title: "Películas en tendencia" },
  stendencias: { path: "/tendencias/series", title: "Series en tendencia" }
};

async function listCards(path, page = 1) {
  const url = SITE + path + (page > 1 ? `/page/${page}` : "");
  const html = await fetchText(url, { headers: { Referer: SITE + "/" } });
  return parseCards(html);
}

async function getPage(pathOrUrl) {
  const url = pathOrUrl.startsWith("http") ? pathOrUrl : SITE + pathOrUrl;
  return fetchText(url, { headers: { Referer: SITE + "/" } });
}

// ---------------------------------------------------------------------------
// API pública (SDK v6)
// ---------------------------------------------------------------------------

async function getHome() {
  const rows = [];
  const safe = async (id, title, path, type = "row", imageStyle = "poster") => {
    try {
      const cards = await listCards(path, 1);
      const items = cards.slice(0, 18).map(cardToItem);
      if (!items.length) return;
      rows.push({ id, title, type, imageStyle, items });
    } catch (e) {
      // silenciar filas fallidas
    }
  };

  await safe("hero_estrenos", "Destacados / Estrenos", "/estrenos", "hero", "backdrop");
  await safe("peliculas", "Películas actualizadas", "/peliculas");
  await safe("series", "Series actualizadas", "/series");
  await safe("tendencias", "Tendencias películas", "/tendencias/peliculas", "row", "backdrop");
  await safe("stendencias", "Tendencias series", "/tendencias/series");
  await safe("sestrenos", "Series estrenos", "/series/estrenos");

  // Fila de géneros como catálogos
  try {
    const genreItems = GENRES.slice(0, 8).map(([slug, name]) => ({
      id: `cat_genre_${slug}`,
      title: name,
      type: "catalog",
      poster: "",
      overview: `Catálogo de ${name}`
    }));
    rows.push({
      id: "catalogos_generos",
      title: "Géneros",
      type: "catalog",
      imageStyle: "poster",
      items: genreItems
    });
  } catch (_) {}

  return rows;
}

async function getNews() {
  const items = [];
  try {
    // Capítulos / series recientes
    const seriesCards = await listCards("/series", 1);
    for (const c of seriesCards.slice(0, 12)) {
      items.push({
        id: `s:${c.slug}`,
        title: c.title,
        overview: "Serie actualizada recientemente en Cuevana.",
        poster: c.poster,
        backdrop: c.poster,
        type: "series",
        year: c.year ? String(c.year) : undefined,
        rating: c.rating,
        imageStyle: "banner"
      });
    }
    // Estrenos de películas
    const movieCards = await listCards("/estrenos", 1);
    for (const c of movieCards.slice(0, 8)) {
      items.push({
        id: `m:${c.slug}`,
        title: c.title,
        overview: "Estreno reciente.",
        poster: c.poster,
        backdrop: c.poster,
        type: "movie",
        year: c.year ? String(c.year) : undefined,
        rating: c.rating,
        imageStyle: "banner"
      });
    }
  } catch (_) {}
  return items;
}

async function getAds() {
  return [
    {
      id: "aviso_v1",
      title: "Primera versión de Cuevana Pro",
      message:
        "Estás usando la versión 1.0.0 (port inicial). Incluye catálogo completo, búsqueda, detalles, episodios y listado de servidores. Algunas extracciones de video (especialmente VOE) pueden mejorar en próximas actualizaciones. ¡Gracias por probar!",
      buttonText: "Entendido"
    }
  ];
}

async function getDiscoverFilters() {
  return [
    {
      id: "type",
      label: "Tipo",
      options: [
        { id: "all", label: "Todo" },
        { id: "movie", label: "Películas" },
        { id: "series", label: "Series" }
      ]
    },
    {
      id: "genre",
      label: "Género",
      options: [
        { id: "all", label: "Todos" },
        ...GENRES.map(([slug, name]) => ({ id: slug, label: name }))
      ]
    }
  ];
}

async function getDiscover(opts = {}) {
  const page = Math.max(1, Number(opts.page) || 1);
  const type = String(opts.type || opts.filter || "all").toLowerCase();
  const genre = String(opts.genre || "all").toLowerCase();

  let path = "/peliculas";
  if (genre && genre !== "all") {
    path = `/genero/${genre}`;
  } else if (type === "series") {
    path = "/series";
  } else if (type === "movie" || type === "peliculas") {
    path = "/peliculas";
  }

  try {
    const cards = await listCards(path, page);
    let items = cards.map(cardToItem);
    if (type === "movie") items = items.filter((i) => i.type === "movie");
    if (type === "series") items = items.filter((i) => i.type === "series");
    const hasMore = cards.length >= PAGE_SIZE;
    return {
      page,
      hasMore,
      items
    };
  } catch (e) {
    return { page, hasMore: false, items: [] };
  }
}

async function getCatalogs() {
  return GENRES.map(([slug, name]) => ({
    id: `cat_genre_${slug}`,
    title: name,
    description: `Películas y series de ${name}`,
    poster: "",
    type: "catalog"
  }));
}

async function getCatalog(catalogId, options = {}) {
  const page = Math.max(1, Number(options.page) || 1);
  const m = /^cat_genre_(.+)$/.exec(String(catalogId || ""));
  if (!m) return { page, hasMore: false, items: [] };
  const slug = m[1];
  try {
    const cards = await listCards(`/genero/${slug}`, page);
    return {
      page,
      hasMore: cards.length >= PAGE_SIZE,
      items: cards.map(cardToItem)
    };
  } catch (_) {
    return { page, hasMore: false, items: [] };
  }
}

async function search(query) {
  const q = String(query || "").trim();
  if (q.length < 2) return [];
  try {
    const html = await fetchText(`${SITE}/search?q=${encodeURIComponent(q)}`, {
      headers: { Referer: SITE + "/" }
    });
    const cards = parseCards(html);
    return cards.slice(0, 40).map(cardToItem);
  } catch (_) {
    return [];
  }
}

async function getMeta(id, opts = {}) {
  const raw = String(id || "");
  const m = /^(m|s):([a-z0-9-]+)/i.exec(raw);
  if (!m) return null;
  const kind = m[1].toLowerCase() === "m" ? "movie" : "series";
  const slug = m[2];
  const path = kind === "movie" ? `/ver-pelicula/${slug}` : `/ver-serie/${slug}`;
  try {
    const html = await getPage(path);
    const p = parseTitle(html);
    if (!p) return null;

    const meta = {
      id: `${kind === "movie" ? "m" : "s"}:${slug}`,
      title: p.title,
      poster: p.poster || "",
      backdrop: p.backdrop || "",
      overview: p.overview || "",
      type: kind === "movie" ? "movie" : "series",
      year: p.year ? String(p.year) : undefined,
      rating: p.rating,
      genres: p.genres && p.genres.length ? p.genres : undefined
    };

    if (kind === "series" && p.seasons && p.seasons.length) {
      meta.seasons = p.seasons.map((s) => ({
        number: s.number,
        name: s.name || `Temporada ${s.number}`,
        episodes: s.episodes.map((e) => ({
          number: e.number,
          id: `e:${slug}:${s.number}:${e.number}`,
          title: e.title || `Episodio ${e.number}`,
          overview: e.overview,
          still: e.still,
          runtime: e.runtime
        }))
      }));
    }
    return meta;
  } catch (_) {
    return null;
  }
}

/**
 * getStreams(id, type, season, episode)
 * Devuelve servidores. En v1 se intentan resolver URLs directas cuando es posible
 * (player.php → stream). Si no, se entrega la URL del player con headers.
 */
async function getStreams(id, type, season, episode) {
  const raw = String(id || "");
  let pageUrl = null;

  // Episodio: e:slug:season:ep  o  id de serie + season/episode
  const epMatch = /^e:([a-z0-9-]+):(\d+):(\d+)$/i.exec(raw);
  if (epMatch) {
    const slug = epMatch[1];
    const s = Number(epMatch[2]);
    const e = Number(epMatch[3]);
    pageUrl = `${SITE}/ver-serie/${slug}/temporada/${s}/episodio/${e}`;
  } else {
    const m = /^(m|s):([a-z0-9-]+)/i.exec(raw);
    if (!m) return [];
    const kind = m[1].toLowerCase() === "m" ? "movie" : "series";
    const slug = m[2];
    if (kind === "series" && season != null && episode != null) {
      pageUrl = `${SITE}/ver-serie/${slug}/temporada/${Number(season)}/episodio/${Number(episode)}`;
    } else if (kind === "movie") {
      pageUrl = `${SITE}/ver-pelicula/${slug}`;
    } else {
      // Serie sin episodio: no hay streams directos
      return [];
    }
  }

  try {
    const html = await fetchText(pageUrl, { headers: { Referer: SITE + "/" } });
    let servers = parseServers(html);
    if (!servers.length) return [];

    servers = preferLang(servers);

    const streams = [];
    for (const s of servers) {
      const lang = langLabel(s.lang);
      const host = (s.host || "server").replace(/\s+/g, " ").trim() || "Server";
      let streamUrl = s.url;
      let isHls = false;
      let headers = {
        "User-Agent": UA,
        Referer: SITE + "/"
      };

      // Intento de resolución simple vía player.php
      try {
        if (streamUrl && streamUrl.includes("player.php")) {
          const playerHtml = await fetchText(streamUrl, {
            headers: { Referer: pageUrl, "User-Agent": UA }
          });
          const resolved = parsePlayer(playerHtml);
          if (resolved) {
            streamUrl = resolved;
            isHls = /\.m3u8(\?|$)/i.test(resolved);
            headers.Referer = streamUrl;
          }
        }
      } catch (_) {
        // mantener URL original del player
      }

      if (!streamUrl) continue;

      streams.push({
        name: `${host} · ${lang}`,
        url: streamUrl,
        quality: "auto",
        language: lang,
        provider: host,
        isHls,
        headers
      });
    }

    return streams;
  } catch (_) {
    return [];
  }
}

// Exponer para el runtime (algunos runtimes buscan en globalThis)
if (typeof globalThis !== "undefined") {
  globalThis.setConfig = setConfig;
  globalThis.getHome = getHome;
  globalThis.getNews = getNews;
  globalThis.getAds = getAds;
  globalThis.getDiscoverFilters = getDiscoverFilters;
  globalThis.getDiscover = getDiscover;
  globalThis.getCatalogs = getCatalogs;
  globalThis.getCatalog = getCatalog;
  globalThis.search = search;
  globalThis.getMeta = getMeta;
  globalThis.getStreams = getStreams;
}
