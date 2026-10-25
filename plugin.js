/**
 * Cuevana Pro — Addon SDK v6 (port 1.0.1)
 * Fuente: https://wv3.cuevana3.eu
 * Compatible con loadAddonCode (CommonJS module.exports) + callMethod.
 * Primera versión: se esperan mejoras en extractores.
 */

var SITE = "https://wv3.cuevana3.eu";
var UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
var PAGE_SIZE = 24;

var GENRES = [
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

var MIRRORS = [
  ["streamwish.to", "vibuxer.com"],
  ["hglink.to", "vibuxer.com"],
  ["swdyu.com", "vibuxer.com"],
  ["cybervynx.com", "vibuxer.com"],
  ["dumbalag.com", "vibuxer.com"],
  ["mivalyo.com", "vidhidepro.com"],
  ["dinisglows.com", "vidhidepro.com"],
  ["dhtpre.com", "vidhidepro.com"]
];

function getUserConfig() {
  try {
    var cfg = (globalThis.__nuvioConfig && (globalThis.__nuvioConfig.current || globalThis.__nuvioConfig)) || {};
    if (cfg && typeof cfg === "object") return cfg;
  } catch (_) {}
  return {};
}

function fixHost(url) {
  try {
    var u = new URL(url);
    for (var i = 0; i < MIRRORS.length; i++) {
      if (u.hostname === MIRRORS[i][0]) {
        u.hostname = MIRRORS[i][1];
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
  var s = decode(src || "");
  if (s.indexOf("/_next/image?url=") === 0) {
    try {
      return decodeURIComponent(s.slice("/_next/image?url=".length).split("&")[0]);
    } catch (_) {
      return "";
    }
  }
  return s.charAt(0) === "/" ? SITE + s : s;
}

function sized(u, w) {
  return String(u || "").replace("/t/p/original/", "/t/p/" + w + "/");
}

function yearOf(d) {
  var m = /^(\d{4})/.exec(d || "");
  return m ? Number(m[1]) : undefined;
}

async function fetchText(url, opts) {
  opts = opts || {};
  var headers = Object.assign(
    {
      "User-Agent": UA,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "es-ES,es;q=0.9,en;q=0.8"
    },
    opts.headers || {}
  );
  var res = await fetch(url, {
    method: opts.method || "GET",
    headers: headers
  });
  if (!res.ok) throw new Error("HTTP " + res.status + " for " + url);
  return await res.text();
}

function nextData(html) {
  var m = /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/.exec(String(html || ""));
  if (!m) return null;
  try {
    return JSON.parse(m[1]).props.pageProps || null;
  } catch (_) {
    return null;
  }
}

function parseCards(html) {
  var out = [];
  var seen = {};
  var parts = String(html || "").split('<li class="TPostMv"');
  for (var i = 1; i < parts.length; i++) {
    var c = parts[i];
    var href = /href="\/ver-(pelicula|serie)\/([^"\/?#]+)"/.exec(c);
    var title = /<span class="Title block">([\s\S]*?)<\/span>/.exec(c);
    if (!href || !title) continue;
    var key = href[1] + href[2];
    if (seen[key]) continue;
    seen[key] = true;
    var pic = /<img[^>]*\bsrc="([^"]+)"/.exec(c);
    var year = /<span class="Year">\s*(\d{4})/.exec(c) || /class="Date[^"]*">\s*(\d{4})/.exec(c);
    var vote = /<span class="Vote[^"]*">\s*([\d.]+)/.exec(c);
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
  var p = nextData(html);
  var t = p && (p.thisMovie || p.thisSerie);
  if (!t || !t.titles) return null;
  var seasons = (t.seasons || [])
    .map(function (s) {
      return {
        number: Number(s.number),
        name: "Temporada " + s.number,
        episodes: (s.episodes || []).map(function (e) {
          return {
            number: Number(e.number),
            id: e.id || "e" + e.number,
            title: String(e.title || "Episodio " + e.number),
            overview: String(e.overview || e.description || "").trim() || undefined,
            still: sized(e.image, "w300") || undefined,
            runtime: e.runtime ? Number(e.runtime) : undefined
          };
        })
      };
    })
    .filter(function (s) {
      return s.episodes.length;
    });
  return {
    tmdb: Number(t.TMDbId) > 0 ? Number(t.TMDbId) : undefined,
    kind: p.thisMovie ? "movie" : "series",
    slug: t.slug && t.slug.name ? String(t.slug.name) : "",
    title: String(t.titles.name || ""),
    original: String((t.titles.original && t.titles.original.name) || ""),
    overview: String(t.overview || "").trim(),
    genres: (t.genres || []).map(function (g) {
      return String(g.name);
    }),
    year: yearOf(t.releaseDate),
    runtimeMinutes: t.runtime ? Number(t.runtime) : undefined,
    rating: t.rate && t.rate.average ? Number(t.rate.average) : undefined,
    poster: sized(t.images && t.images.poster, "w500"),
    backdrop: sized(t.images && t.images.backdrop, "w1280"),
    seasons: seasons
  };
}

function parseServers(html) {
  var p = nextData(html);
  var t = p && (p.thisMovie || p.episode);
  var v = t && t.videos;
  if (!v) return [];
  var out = [];
  var langs = Object.keys(v);
  for (var i = 0; i < langs.length; i++) {
    var lang = langs[i];
    var list = v[lang];
    if (!Array.isArray(list)) continue;
    for (var j = 0; j < list.length; j++) {
      var e = list[j];
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
  var m = /var url = '([^']+)'/.exec(String(html || ""));
  return m ? fixHost(m[1]) : null;
}

function cardToItem(c) {
  return {
    id: (c.kind === "movie" ? "m" : "s") + ":" + c.slug,
    title: c.title,
    poster: c.poster || "",
    type: c.kind === "movie" ? "movie" : "series",
    year: c.year ? String(c.year) : undefined,
    rating: c.rating
  };
}

function langLabel(lang) {
  var map = {
    latino: "Latino",
    spanish: "Castellano",
    english: "Inglés",
    japanese: "Japonés",
    subtitulado: "Subtitulado"
  };
  var k = String(lang || "").toLowerCase();
  return map[k] || String(lang || "");
}

function preferLang(servers) {
  var cfg = getUserConfig();
  var pref = String(cfg.pref_lang || "latino").toLowerCase();
  var order = [pref, "latino", "spanish", "english", "japanese"];
  return servers.slice().sort(function (a, b) {
    var ia = order.indexOf(String(a.lang).toLowerCase());
    var ib = order.indexOf(String(b.lang).toLowerCase());
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  });
}

async function listCards(path, page) {
  page = page || 1;
  var url = SITE + path + (page > 1 ? "/page/" + page : "");
  var html = await fetchText(url, { headers: { Referer: SITE + "/" } });
  return parseCards(html);
}

async function getPage(pathOrUrl) {
  var url = pathOrUrl.indexOf("http") === 0 ? pathOrUrl : SITE + pathOrUrl;
  return fetchText(url, { headers: { Referer: SITE + "/" } });
}

async function getHome() {
  var rows = [];
  async function safe(id, title, path, type, imageStyle) {
    try {
      var cards = await listCards(path, 1);
      var items = cards.slice(0, 18).map(cardToItem);
      if (!items.length) return;
      rows.push({
        id: id,
        title: title,
        type: type || "row",
        imageStyle: imageStyle || "poster",
        items: items
      });
    } catch (e) {}
  }

  await safe("hero_estrenos", "Destacados / Estrenos", "/peliculas/estrenos", "hero", "backdrop");
  await safe("peliculas", "Películas actualizadas", "/peliculas", "row", "poster");
  await safe("series", "Series actualizadas", "/series", "row", "poster");
  await safe("tendencias", "Tendencias películas", "/peliculas/tendencias/semana", "row", "backdrop");
  await safe("stendencias", "Tendencias series", "/series/tendencias/semana", "row", "poster");
  await safe("sestrenos", "Series estrenos", "/series/estrenos", "row", "poster");

  try {
    var genreItems = GENRES.slice(0, 8).map(function (g) {
      return {
        id: "cat_genre_" + g[0],
        title: g[1],
        type: "catalog",
        poster: "",
        overview: "Catálogo de " + g[1]
      };
    });
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
  var items = [];
  try {
    var seriesCards = await listCards("/series", 1);
    for (var i = 0; i < Math.min(12, seriesCards.length); i++) {
      var c = seriesCards[i];
      items.push({
        id: "s:" + c.slug,
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
    var movieCards = await listCards("/peliculas/estrenos", 1);
    for (var j = 0; j < Math.min(8, movieCards.length); j++) {
      var m = movieCards[j];
      items.push({
        id: "m:" + m.slug,
        title: m.title,
        overview: "Estreno reciente.",
        poster: m.poster,
        backdrop: m.poster,
        type: "movie",
        year: m.year ? String(m.year) : undefined,
        rating: m.rating,
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
        "Estás usando la versión 1.0.1 (port inicial). Incluye catálogo, búsqueda, detalles, episodios y listado de servidores. Algunas extracciones de video (especialmente VOE) pueden mejorar en próximas actualizaciones. ¡Gracias por probar!",
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
      options: [{ id: "all", label: "Todos" }].concat(
        GENRES.map(function (g) {
          return { id: g[0], label: g[1] };
        })
      )
    }
  ];
}

async function getDiscover(opts) {
  opts = opts || {};
  var page = Math.max(1, Number(opts.page) || 1);
  var type = String(opts.type || opts.filter || "all").toLowerCase();
  var genre = String(opts.genre || "all").toLowerCase();

  var path = "/peliculas";
  if (genre && genre !== "all" && genre !== "movie" && genre !== "series" && genre !== "peliculas") {
    path = "/genero/" + genre;
  } else if (type === "series") {
    path = "/series";
  } else if (type === "movie" || type === "peliculas") {
    path = "/peliculas";
  }

  try {
    var cards = await listCards(path, page);
    var items = cards.map(cardToItem);
    if (type === "movie") {
      items = items.filter(function (it) {
        return it.type === "movie";
      });
    }
    if (type === "series") {
      items = items.filter(function (it) {
        return it.type === "series";
      });
    }
    return {
      page: page,
      hasMore: cards.length >= PAGE_SIZE,
      items: items
    };
  } catch (e) {
    return { page: page, hasMore: false, items: [] };
  }
}

async function getCatalogs() {
  return GENRES.map(function (g) {
    return {
      id: "cat_genre_" + g[0],
      title: g[1],
      description: "Películas y series de " + g[1],
      poster: "",
      type: "catalog"
    };
  });
}

async function getCatalog(catalogId, options) {
  options = options || {};
  var page = Math.max(1, Number(options.page) || 1);
  var m = /^cat_genre_(.+)$/.exec(String(catalogId || ""));
  if (!m) return { page: page, hasMore: false, items: [] };
  var slug = m[1];
  try {
    var cards = await listCards("/genero/" + slug, page);
    return {
      page: page,
      hasMore: cards.length >= PAGE_SIZE,
      items: cards.map(cardToItem)
    };
  } catch (_) {
    return { page: page, hasMore: false, items: [] };
  }
}

async function search(query) {
  var q = String(query || "").trim();
  if (q.length < 2) return [];
  try {
    var html = await fetchText(SITE + "/search?q=" + encodeURIComponent(q), {
      headers: { Referer: SITE + "/" }
    });
    var cards = parseCards(html);
    return cards.slice(0, 40).map(cardToItem);
  } catch (_) {
    return [];
  }
}

async function getMeta(id, opts) {
  opts = opts || {};
  var raw = String(id || "");
  var m = /^(m|s):([a-z0-9-]+)/i.exec(raw);
  if (!m) return null;
  var kind = m[1].toLowerCase() === "m" ? "movie" : "series";
  var slug = m[2];
  var path = kind === "movie" ? "/ver-pelicula/" + slug : "/ver-serie/" + slug;
  try {
    var html = await getPage(path);
    var p = parseTitle(html);
    if (!p) return null;

    var meta = {
      id: (kind === "movie" ? "m" : "s") + ":" + slug,
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
      meta.seasons = p.seasons.map(function (s) {
        return {
          number: s.number,
          name: s.name || "Temporada " + s.number,
          episodes: s.episodes.map(function (e) {
            return {
              number: e.number,
              id: "e:" + slug + ":" + s.number + ":" + e.number,
              title: e.title || "Episodio " + e.number,
              overview: e.overview,
              still: e.still,
              runtime: e.runtime
            };
          })
        };
      });
    }
    return meta;
  } catch (_) {
    return null;
  }
}

async function getStreams(id, type, season, episode) {
  var raw = String(id || "");
  var pageUrl = null;

  var epMatch = /^e:([a-z0-9-]+):(\d+):(\d+)$/i.exec(raw);
  if (epMatch) {
    pageUrl =
      SITE +
      "/episodio/" +
      epMatch[1] +
      "-temporada-" +
      Number(epMatch[2]) +
      "-episodio-" +
      Number(epMatch[3]);
  } else {
    var m = /^(m|s):([a-z0-9-]+)/i.exec(raw);
    if (!m) return [];
    var kind = m[1].toLowerCase() === "m" ? "movie" : "series";
    var slug = m[2];
    if (kind === "series" && season != null && episode != null) {
      pageUrl =
        SITE +
        "/episodio/" +
        slug +
        "-temporada-" +
        Number(season) +
        "-episodio-" +
        Number(episode);
    } else if (kind === "movie") {
      pageUrl = SITE + "/ver-pelicula/" + slug;
    } else {
      return [];
    }
  }

  try {
    var html = await fetchText(pageUrl, { headers: { Referer: SITE + "/" } });
    var servers = parseServers(html);
    if (!servers.length) return [];

    servers = preferLang(servers);

    var streams = [];
    for (var i = 0; i < servers.length; i++) {
      var s = servers[i];
      var lang = langLabel(s.lang);
      var host = String(s.host || "server").replace(/\s+/g, " ").trim() || "Server";
      var streamUrl = s.url;
      var isHls = false;
      var headers = {
        "User-Agent": UA,
        Referer: SITE + "/"
      };

      try {
        if (streamUrl && streamUrl.indexOf("player.php") !== -1) {
          var playerHtml = await fetchText(streamUrl, {
            headers: { Referer: pageUrl, "User-Agent": UA }
          });
          var resolved = parsePlayer(playerHtml);
          if (resolved) {
            streamUrl = resolved;
            isHls = /\.m3u8(\?|$)/i.test(resolved);
            headers.Referer = streamUrl;
          }
        }
      } catch (_) {}

      if (!streamUrl) continue;

      streams.push({
        name: host + " · " + lang,
        url: streamUrl,
        quality: "auto",
        language: lang,
        provider: host,
        isHls: isHls,
        headers: headers
      });
    }

    return streams;
  } catch (_) {
    return [];
  }
}

// CommonJS export (requerido por loadAddonCode / callMethod de la app)
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    getHome: getHome,
    getNews: getNews,
    getAds: getAds,
    getDiscoverFilters: getDiscoverFilters,
    getDiscover: getDiscover,
    getCatalogs: getCatalogs,
    getCatalog: getCatalog,
    search: search,
    getMeta: getMeta,
    getStreams: getStreams
  };
}

if (typeof globalThis !== "undefined") {
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
