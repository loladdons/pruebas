/**
 * SeriesKao Pro — Addon SDK v6 (port 1.0.0)
 * Fuente: https://serieskao.top
 * Compatible con loadAddonCode (CommonJS module.exports) + callMethod.
 * Basado en los scrapers Dart (SeriesKaoScraper + DetalleSeriesKao + Embed69Service).
 * Extractores HLS/MP4 portados del paquete Cuevana/latinuvio.
 */
var SITE = "https://serieskao.top";
var UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
var PAGE_SIZE = 24;
var TMDB_KEY = "a2d9bbed370d9f678e34006f8750a5a5";
var OMDB_KEY = "5b0e8a3e";

var GENRES = [
  ["accion", "Acción"],
  ["animacion", "Animación"],
  ["aventura", "Aventura"],
  ["belica", "Bélica"],
  ["ciencia-ficcion", "Ciencia Ficción"],
  ["comedia", "Comedia"],
  ["crimen", "Crimen"],
  ["documental", "Documental"],
  ["drama", "Drama"],
  ["fantasia", "Fantasía"],
  ["familia", "Familia"],
  ["guerra", "Guerra"],
  ["historia", "Historia"],
  ["romance", "Romance"],
  ["suspense", "Suspense"],
  ["terror", "Terror"],
  ["western", "Western"],
  ["misterio", "Misterio"]
];

var MIRRORS = [
  ["streamwish.to", "vibuxer.com"],
  ["hglink.to", "vibuxer.com"],
  ["swdyu.com", "vibuxer.com"],
  ["cybervynx.com", "vibuxer.com"],
  ["dumbalag.com", "vibuxer.com"],
  ["mivalyo.com", "vidhidepro.com"],
  ["dinisglows.com", "vidhidepro.com"],
  ["dhtpre.com", "vidhidepro.com"],
  ["filelions.to", "callistanise.com"]
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
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function text(s) {
  return decode(String(s || "").replace(/<[^>]+>/g, " "));
}

function sized(u, w) {
  return String(u || "").replace("/t/p/original/", "/t/p/" + w + "/").replace("/t/p/w500/", "/t/p/" + w + "/");
}

async function fetchText(url, opts) {
  opts = opts || {};
  var headers = Object.assign(
    {
      "User-Agent": UA,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "es-ES,es;q=0.9,en;q=0.8",
      "Accept-Encoding": "identity"
    },
    opts.headers || {}
  );
  var res = await fetch(url, {
    method: opts.method || "GET",
    headers: headers,
    redirect: "follow"
  });
  if (!res.ok) throw new Error("HTTP " + res.status + " for " + url);
  return await res.text();
}

/* ========== PARSERS SERIESKAO ========== */

function parseCards(html) {
  var out = [];
  var seen = {};
  var arts = String(html || "").match(/<article class="card">([\s\S]*?)<\/article>/g) || [];
  for (var i = 0; i < arts.length; i++) {
    var block = arts[i];
    var hrefM = /<a href="([^"]+)" class="card__link">/.exec(block);
    if (!hrefM) continue;
    var href = hrefM[1];
    var url = href.indexOf("http") === 0 ? href : SITE + href;
    var tipoM = /\/(pelicula|serie|anime)\//.exec(href);
    var tipo = "movie";
    if (tipoM) {
      if (tipoM[1] === "serie") tipo = "series";
      else if (tipoM[1] === "anime") tipo = "anime";
      else tipo = "movie";
    }
    var key = tipo + ":" + href;
    if (seen[key]) continue;
    seen[key] = true;

    var titleM = /<h[12] class="card__title">([^<]+)<\/h[12]>/.exec(block);
    var titulo = titleM ? decode(titleM[1]) : "";
    if (!titulo) continue;

    var imgM = /<img[^>]+src="([^"]+)"/.exec(block);
    var poster = imgM ? imgM[1] : "";

    var ratM = /card__rating">[\s\S]*?<\/svg>\s*([\d.]+)/.exec(block);
    var rating = ratM ? Number(ratM[1]) : undefined;

    var yearM = /card__badge--year">(\d{4})</.exec(block);
    var year = yearM ? Number(yearM[1]) : undefined;

    out.push({
      slug: href.replace(/^https?:\/\/[^/]+/, "").replace(/^\//, ""),
      kind: tipo === "series" ? "series" : tipo === "anime" ? "anime" : "movie",
      title: titulo,
      year: year,
      poster: poster,
      rating: rating,
      url: url
    });
  }
  return out;
}

function cardToItem(c) {
  var type = c.kind === "movie" ? "movie" : c.kind === "anime" ? "anime" : "series";
  var idPrefix = type === "movie" ? "m" : type === "anime" ? "a" : "s";
  var cleanSlug = (c.slug || "").replace(/^(pelicula|serie|anime)\//, "");
  return {
    id: idPrefix + ":" + cleanSlug,
    title: c.title,
    poster: c.poster || "",
    type: type,
    year: c.year ? String(c.year) : undefined,
    rating: c.rating
  };
}

function parsePagination(html) {
  var current = 1;
  var total = 1;
  var info = /pagination__info[^>]*>\s*P[^0-9]{0,4}gina\s+(\d+)\s+de\s+(\d+)/i.exec(html);
  if (info) {
    current = parseInt(info[1], 10);
    total = parseInt(info[2], 10);
  } else {
    var active = /pagination__btn--active[^>]*>\s*(\d+)\s*</.exec(html);
    if (active) current = parseInt(active[1], 10);
    var nums = [];
    var re = /[?&]page=(\d+)/g;
    var m;
    while ((m = re.exec(html))) nums.push(parseInt(m[1], 10));
    if (nums.length) total = Math.max.apply(null, nums);
    if (/aria-label="Siguiente"[^>]*href="[^"]+"/.test(html) && total <= current) total = current + 1;
  }
  return { current: current, total: total, hasNext: current < total };
}

/* ========== HOME / LIST ========== */

async function listCards(path, page) {
  page = page || 1;
  var url = SITE + path;
  if (page > 1) url += (url.indexOf("?") >= 0 ? "&" : "?") + "page=" + page;
  var html = await fetchText(url, { headers: { Referer: SITE + "/" } });
  return { cards: parseCards(html), pagination: parsePagination(html) };
}

async function getHome() {
  var rows = [];
  async function safe(id, title, path, type, imageStyle) {
    try {
      var res = await listCards(path, 1);
      var items = res.cards.slice(0, 18).map(cardToItem);
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

  await safe("hero_peliculas", "Películas destacadas", "/peliculas/populares", "hero", "backdrop");
  await safe("peliculas", "Películas actualizadas", "/peliculas", "row", "poster");
  await safe("series", "Series actualizadas", "/series", "row", "poster");
  await safe("series_populares", "Series populares", "/series/populares", "row", "poster");
  await safe("animes", "Animes", "/animes", "row", "poster");
  await safe("animes_populares", "Animes populares", "/animes/populares", "row", "poster");
  await safe("doramas", "Doramas", "/generos/dorama", "row", "poster");

  try {
    var genreItems = GENRES.slice(0, 10).map(function (g) {
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
    var series = await listCards("/series", 1);
    for (var i = 0; i < Math.min(12, series.cards.length); i++) {
      var c = series.cards[i];
      items.push({
        id: cardToItem(c).id,
        title: c.title,
        overview: "Serie actualizada recientemente en SeriesKao.",
        poster: c.poster,
        backdrop: c.poster,
        type: "series",
        year: c.year ? String(c.year) : undefined,
        rating: c.rating,
        imageStyle: "banner"
      });
    }
    var movies = await listCards("/peliculas", 1);
    for (var j = 0; j < Math.min(8, movies.cards.length); j++) {
      var m = movies.cards[j];
      items.push({
        id: cardToItem(m).id,
        title: m.title,
        overview: "Película reciente.",
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
      id: "aviso_sk_v1",
      title: "SeriesKao Pro 1.0.0 – Embed69 + Extractores",
      message:
        "Home por secciones, Discover con filtros, búsqueda y extractores StreamWish / VidHide / VOE (misma lógica que Cuevana). Solo se entregan enlaces HLS/MP4 funcionales.",
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
        { id: "series", label: "Series" },
        { id: "anime", label: "Animes" }
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
  if (genre && genre !== "all" && genre !== "movie" && genre !== "series" && genre !== "anime") {
    path = "/generos/" + genre;
  } else if (type === "series") {
    path = "/series";
  } else if (type === "anime") {
    path = "/animes";
  } else if (type === "movie" || type === "peliculas") {
    path = "/peliculas";
  }

  try {
    var res = await listCards(path, page);
    var items = res.cards.map(cardToItem);
    if (type === "movie") items = items.filter(function (it) { return it.type === "movie"; });
    if (type === "series") items = items.filter(function (it) { return it.type === "series"; });
    if (type === "anime") items = items.filter(function (it) { return it.type === "anime"; });
    return {
      page: page,
      hasMore: res.pagination.hasNext || res.cards.length >= PAGE_SIZE,
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
      description: "Películas, series y animes de " + g[1],
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
    var res = await listCards("/generos/" + slug, page);
    return {
      page: page,
      hasMore: res.pagination.hasNext || res.cards.length >= PAGE_SIZE,
      items: res.cards.map(cardToItem)
    };
  } catch (_) {
    return { page: page, hasMore: false, items: [] };
  }
}

async function search(query) {
  var q = String(query || "").trim();
  if (q.length < 2) return [];
  try {
    var html = await fetchText(SITE + "/search?s=" + encodeURIComponent(q), {
      headers: { Referer: SITE + "/" }
    });
    var cards = parseCards(html);
    return cards.slice(0, 40).map(cardToItem);
  } catch (_) {
    return [];
  }
}

/* ========== DETAIL / META ========== */

async function getMeta(id, opts) {
  opts = opts || {};
  var raw = String(id || "");
  var m = /^(m|s|a):([a-z0-9\-]+)/i.exec(raw);
  if (!m) return null;

  var kind = m[1].toLowerCase();
  var slug = m[2];
  var path = kind === "m" ? "/pelicula/" + slug : kind === "a" ? "/anime/" + slug : "/serie/" + slug;

  try {
    var html = await fetchText(SITE + path, { headers: { Referer: SITE + "/" } });

    var titulo = slug.replace(/-/g, " ");
    var h1 = /<h1 class="detail-hero__title">([^<]+)<\/h1>/.exec(html);
    if (h1) titulo = decode(h1[1]);

    var anio = null;
    var y1 = /\((\d{4})\)/.exec(html);
    if (y1) anio = y1[1];
    var y2 = /"datePublished":(\d{4}|"\d{4}")/.exec(html);
    if (y2) anio = y2[1].replace(/"/g, "");

    var sinopsis = null;
    var desc = /"description":"([^"]+)"/.exec(html);
    if (desc) sinopsis = decode(desc[1]);

    var rating = null;
    var rat = /"ratingValue":"([\d.]+)"/.exec(html);
    if (rat) rating = Number(rat[1]);

    var generos = [];
    var genM = /"genre":\[([^\]]+)\]/.exec(html);
    if (genM) {
      generos = genM[1].split(",").map(function (g) {
        return g.replace(/"/g, "").trim();
      }).filter(Boolean);
    }

    var imdbId = null;
    var imdbM = /data-url="\/vidurl\/(tt\d+)\//.exec(html) || /"(tt\d{7,})"/.exec(html);
    if (imdbM) imdbId = imdbM[1];

    var isMovie = kind === "m";
    var temporadas = [];

    if (!isMovie) {
      var blocks = html.match(/<div class="episodes-list\s*"[^>]*id="season-(\d+)"[^>]*>([\s\S]*?)<\/div>/g) || [];
      var map = {};
      for (var b = 0; b < blocks.length; b++) {
        var bm = /id="season-(\d+)"[^>]*>([\s\S]*?)<\/div>/.exec(blocks[b]);
        if (!bm) continue;
        var tNum = parseInt(bm[1], 10);
        var content = bm[2];
        var eps = content.match(/<a href="([^"]+)" class="episode-item">\s*<span class="episode-item__number">(\d+)<\/span>\s*<span class="episode-item__title">([^<]+)<\/span>/g) || [];
        if (!map[tNum]) map[tNum] = [];
        for (var e = 0; e < eps.length; e++) {
          var em = /href="([^"]+)"[\s\S]*?episode-item__number">(\d+)<[\s\S]*?episode-item__title">([^<]+)</.exec(eps[e]);
          if (!em) continue;
          var href = em[1];
          var full = href.indexOf("http") === 0 ? href : SITE + href;
          map[tNum].push({
            number: parseInt(em[2], 10),
            id: "e:" + slug + ":" + tNum + ":" + em[2],
            title: decode(em[3]),
            url: full
          });
        }
      }
      Object.keys(map).forEach(function (k) {
        var num = parseInt(k, 10);
        map[k].sort(function (a, b) { return a.number - b.number; });
        temporadas.push({
          number: num,
          name: "Temporada " + num,
          episodes: map[k]
        });
      });
      temporadas.sort(function (a, b) { return a.number - b.number; });
    }

    // Enriquecer con TMDB si tenemos imdb o título
    var poster = null, backdrop = null, tmdbId = null;
    if (imdbId) {
      try {
        var find = await fetchText(
          "https://api.themoviedb.org/3/find/" + imdbId + "?api_key=" + TMDB_KEY + "&external_source=imdb_id&language=es-MX"
        );
        var j = JSON.parse(find);
        var results = isMovie ? j.movie_results : j.tv_results;
        if (results && results.length) tmdbId = results[0].id;
      } catch (_) {}
    }
    if (!tmdbId && titulo) {
      try {
        var endpoint = isMovie ? "movie" : "tv";
        var api = "https://api.themoviedb.org/3/search/" + endpoint + "?api_key=" + TMDB_KEY + "&query=" + encodeURIComponent(titulo) + "&language=es-MX";
        if (anio) api += "&year=" + anio;
        var search = await fetchText(api);
        var sj = JSON.parse(search);
        if (sj.results && sj.results.length) tmdbId = sj.results[0].id;
      } catch (_) {}
    }
    if (tmdbId) {
      try {
        var endpoint = isMovie ? "movie" : "tv";
        var detail = await fetchText(
          "https://api.themoviedb.org/3/" + endpoint + "/" + tmdbId + "?api_key=" + TMDB_KEY + "&language=es-MX&append_to_response=images,external_ids"
        );
        var d = JSON.parse(detail);
        if (d.poster_path) poster = "https://image.tmdb.org/t/p/w500" + d.poster_path;
        if (d.backdrop_path) backdrop = "https://image.tmdb.org/t/p/original" + d.backdrop_path;
        if (d.overview && (!sinopsis || !sinopsis.length)) sinopsis = d.overview;
        if (d.vote_average) rating = Number(d.vote_average);
        if (d.external_ids && d.external_ids.imdb_id) imdbId = d.external_ids.imdb_id;
      } catch (_) {}
    }

    var meta = {
      id: (kind === "m" ? "m" : kind === "a" ? "a" : "s") + ":" + slug,
      title: titulo,
      poster: poster || "",
      backdrop: backdrop || "",
      overview: sinopsis || "",
      type: kind === "m" ? "movie" : kind === "a" ? "anime" : "series",
      year: anio || undefined,
      rating: rating,
      genres: generos.length ? generos : undefined,
      tmdbId: tmdbId || undefined,
      imdbId: imdbId || undefined
    };

    if (!isMovie && temporadas.length) {
      meta.seasons = temporadas;
    }

    return meta;
  } catch (e) {
    return null;
  }
}

/* ========== STREAMS (Embed69 + extractores Cuevana) ========== */

// --- Crypto helpers (SHA256 + AES-CBC) ---
function sha256(str) {
  // Minimal pure-JS SHA-256 (for PoW)
  function rightRotate(value, amount) {
    return (value >>> amount) | (value << (32 - amount));
  }
  var mathPow = Math.pow;
  var maxWord = mathPow(2, 32);
  var lengthProperty = "length";
  var i, j;
  var result = "";
  var words = [];
  var asciiBitLength = str[lengthProperty] * 8;
  var hash = (sha256.h = sha256.h || []);
  var k = (sha256.k = sha256.k || []);
  var primeCounter = k[lengthProperty];
  var isComposite = {};
  for (var candidate = 2; primeCounter < 64; candidate++) {
    if (!isComposite[candidate]) {
      for (i = 0; i < 313; i += candidate) isComposite[i] = candidate;
      hash[primeCounter] = (mathPow(candidate, 0.5) * maxWord) | 0;
      k[primeCounter++] = (mathPow(candidate, 1 / 3) * maxWord) | 0;
    }
  }
  str += "\x80";
  while ((str[lengthProperty] % 64) - 56) str += "\x00";
  for (i = 0; i < str[lengthProperty]; i++) {
    j = str.charCodeAt(i);
    if (j >> 8) return;
    words[i >> 2] |= j << (((3 - i) % 4) * 8);
  }
  words[words[lengthProperty]] = (asciiBitLength / maxWord) | 0;
  words[words[lengthProperty]] = asciiBitLength;
  for (j = 0; j < words[lengthProperty]; ) {
    var w = words.slice(j, (j += 16));
    var oldHash = hash;
    hash = hash.slice(0, 8);
    for (i = 0; i < 64; i++) {
      var w15 = w[i - 15], w2 = w[i - 2];
      var a = hash[0], e = hash[4];
      var temp1 =
        hash[7] +
        (rightRotate(e, 6) ^ rightRotate(e, 11) ^ rightRotate(e, 25)) +
        ((e & hash[5]) ^ (~e & hash[6])) +
        k[i] +
        (w[i] =
          i < 16
            ? w[i]
            : (w[i - 16] +
                (rightRotate(w15, 7) ^ rightRotate(w15, 18) ^ (w15 >>> 3)) +
                w[i - 7] +
                (rightRotate(w2, 17) ^ rightRotate(w2, 19) ^ (w2 >>> 10))) |
              0);
      var temp2 =
        (rightRotate(a, 2) ^ rightRotate(a, 13) ^ rightRotate(a, 22)) +
        ((a & hash[1]) ^ (a & hash[2]) ^ (hash[1] & hash[2]));
      hash = [(temp1 + temp2) | 0].concat(hash);
      hash[4] = (hash[4] + temp1) | 0;
    }
    for (i = 0; i < 8; i++) hash[i] = (hash[i] + oldHash[i]) | 0;
  }
  for (i = 0; i < 8; i++) {
    for (j = 3; j + 1; j--) {
      var b = (hash[i] >> (j * 8)) & 255;
      result += (b < 16 ? "0" : "") + b.toString(16);
    }
  }
  return result;
}

async function decryptAES(encryptedBase64, aesKeyBytes) {
  try {
    var raw = Uint8Array.from(atob(encryptedBase64), function (c) { return c.charCodeAt(0); });
    if (raw.length <= 16) return null;
    var iv = raw.slice(0, 16);
    var cipher = raw.slice(16);
    var key = await crypto.subtle.importKey("raw", aesKeyBytes, { name: "AES-CBC" }, false, ["decrypt"]);
    var decrypted = await crypto.subtle.decrypt({ name: "AES-CBC", iv: iv }, key, cipher);
    var text = new TextDecoder().decode(decrypted);
    if (text.indexOf("http") >= 0) return text;
    return null;
  } catch (_) {
    return null;
  }
}

function solvePow(challenge, difficulty) {
  var prefix = "0".repeat(difficulty || 3);
  for (var nonce = 0; nonce < 1000000; nonce++) {
    var hash = sha256(challenge + nonce);
    if (hash.indexOf(prefix) === 0) return nonce;
  }
  return null;
}

function generateAesKey(challenge, nonce, salt) {
  // SHA256 binary of challenge+nonce+salt (same as PHP hash(..., true))
  var hex = sha256(challenge + nonce + (salt || ""));
  var bytes = new Uint8Array(32);
  for (var i = 0; i < 32; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  return bytes;
}

function extractDataLink(html) {
  var patterns = [
    /let\s+dataLink\s*=\s*(\[[\s\S]*?\]);/,
    /dataLink\s*=\s*(\[[\s\S]*?\]);/
  ];
  for (var i = 0; i < patterns.length; i++) {
    var m = patterns[i].exec(html);
    if (m) {
      try {
        return JSON.parse(m[1].replace(/\\"/g, '"'));
      } catch (_) {}
    }
  }
  return null;
}

function extractPowConstants(html) {
  var c = {};
  var ch = /POW_CHALLENGE\s*=\s*['"]?([a-f0-9]+)['"]?/.exec(html);
  if (ch) c.challenge = ch[1];
  var sa = /POW_SALT\s*=\s*['"]?([a-f0-9]+)['"]?/.exec(html);
  if (sa) c.salt = sa[1];
  var di = /POW_DIFFICULTY\s*=\s*(\d+)/.exec(html);
  if (di) c.difficulty = parseInt(di[1], 10) || 3;
  return c;
}

function normalizeLang(idioma) {
  var upper = String(idioma || "").toUpperCase().trim();
  var mapa = {
    ESP: "es_MX", ES: "es_MX", ESPAÑOL: "es_MX", SPANISH: "es_MX",
    LATINO: "es_MX", LAT: "es_MX", MX: "es_MX", ES_MX: "es_MX",
    SUB: "subtitulado", SUBTITULADO: "subtitulado",
    INGLES: "en_US", EN: "en_US", ENGLISH: "en_US", EN_US: "en_US",
    CASTELLANO: "castellano", CAST: "castellano", ES_ES: "castellano"
  };
  for (var k in mapa) {
    if (upper.indexOf(k) >= 0) return mapa[k];
  }
  return String(idioma || "").toLowerCase();
}

async function fetchFromSeriesKao(idCompleto) {
  var url = SITE + "/vidurl/" + idCompleto + "/";
  var html;
  try {
    html = await fetchText(url, {
      headers: {
        Referer: SITE + "/",
        Origin: SITE,
        "X-Requested-With": "XMLHttpRequest"
      }
    });
  } catch (_) {
    return [];
  }
  var dataLink = extractDataLink(html);
  if (!dataLink) return [];
  var pow = extractPowConstants(html);
  if (!pow.challenge) return [];
  var nonce = solvePow(pow.challenge, pow.difficulty || 3);
  if (nonce == null) return [];
  var aesKey = generateAesKey(pow.challenge, nonce, pow.salt || "");
  var results = [];
  var filtrados = ["voe", "rapidvideo"];
  for (var i = 0; i < dataLink.length; i++) {
    var item = dataLink[i];
    var idioma = normalizeLang(item.video_language || "DESCONOCIDO");
    var embeds = item.sortedEmbeds || [];
    for (var j = 0; j < embeds.length; j++) {
      var emb = embeds[j];
      var servidor = String(emb.servername || "").toLowerCase();
      if (filtrados.indexOf(servidor) >= 0) continue;
      var enlaceCifrado = emb.link || "";
      if (!enlaceCifrado) continue;
      var urlReal = await decryptAES(enlaceCifrado, aesKey);
      if (!urlReal) continue;
      urlReal = urlReal
        .replace(/`/g, "")
        .replace(/hglink\.to/g, "vibuxer.com")
        .replace(/filelions\.to/g, "callistanise.com");
      results.push({
        serverName: servidor || "desconocido",
        url: urlReal,
        idioma: idioma,
        fuente: "serieskao"
      });
    }
  }
  return results;
}

async function fetchFromXupalace(idCompleto) {
  var url = "https://xupalace.org/video/" + idCompleto + "/";
  var html;
  try {
    html = await fetchText(url, {
      headers: {
        Referer: "https://xupalace.org/",
        Origin: "https://xupalace.org"
      }
    });
  } catch (_) {
    return [];
  }
  var mapLang = { "0": "es_MX", "1": "subtitulado", "2": "en_US", "3": "castellano" };
  var enlaces = [];
  var seen = {};
  var liBlocks = html.match(/<li\b[^>]*>[\s\S]*?<\/li>/gi) || [];
  var urlRe = /go_to_playerVast\(\s*['"]([^'"]+)['"]/;
  var langRe = /data-lang=["'](\d+)["']/;
  var spanRe = /<span[^>]*>([^<]+)<\/span>/;
  for (var i = 0; i < liBlocks.length; i++) {
    var block = liBlocks[i];
    var um = urlRe.exec(block);
    if (!um) continue;
    var u = um[1].trim();
    if (!u || seen[u]) continue;
    seen[u] = true;
    var lm = langRe.exec(block);
    var dataLang = lm ? lm[1] : "0";
    var sm = spanRe.exec(block);
    var servidor = sm ? sm[1].trim().toLowerCase() : "desconocido";
    enlaces.push({ servidor: servidor, url: u, idioma: mapLang[dataLang] || "es_MX" });
  }
  if (!enlaces.length) {
    // fallback window around each go_to_playerVast
    var all = [];
    var re = /go_to_playerVast\(\s*['"]([^'"]+)['"]/g;
    var mm;
    while ((mm = re.exec(html))) all.push({ url: mm[1], index: mm.index });
    for (var k = 0; k < all.length; k++) {
      var entry = all[k];
      if (seen[entry.url]) continue;
      seen[entry.url] = true;
      var start = Math.max(0, entry.index - 300);
      var end = Math.min(html.length, entry.index + 300);
      var before = html.substring(start, entry.index);
      var after = html.substring(entry.index, end);
      var langMs = before.match(/data-lang=["'](\d+)["']/g) || [];
      var dataLang2 = "0";
      if (langMs.length) {
        var last = langMs[langMs.length - 1];
        var lm2 = /data-lang=["'](\d+)["']/.exec(last);
        if (lm2) dataLang2 = lm2[1];
      }
      var servidor2 = "desconocido";
      var sm2 = spanRe.exec(after);
      if (sm2) servidor2 = sm2[1].trim().toLowerCase();
      else if (/hglink|streamwish|vibuxer/.test(entry.url)) servidor2 = "streamwish";
      else if (/filemoon|bysedikamoum/.test(entry.url)) servidor2 = "filemoon";
      else if (/vidhide|filelions|callistanise/.test(entry.url)) servidor2 = "vidhide";
      else if (/streamtape/.test(entry.url)) servidor2 = "stape";
      else if (/voe\.sx/.test(entry.url)) servidor2 = "voe";
      enlaces.push({
        servidor: servidor2,
        url: entry.url,
        idioma: mapLang[dataLang2] || "es_MX"
      });
    }
  }
  var results = [];
  for (var n = 0; n < enlaces.length; n++) {
    var en = enlaces[n];
    var servidor = (en.servidor || "desconocido").toLowerCase();
    var u = en.url || "";
    if (!u) continue;
    var esStreamwish = servidor === "streamwish" || /hglink|streamwish|vibuxer/.test(u);
    var esVidhide = servidor === "vidhide" || /vidhide|filelions|callistanise/.test(u);
    if (!esStreamwish && !esVidhide) continue;
    servidor = esStreamwish ? "streamwish" : "vidhide";
    u = u.replace(/hglink\.to/g, "vibuxer.com").replace(/filelions\.to/g, "callistanise.com");
    results.push({
      serverName: servidor,
      url: u,
      idioma: normalizeLang(en.idioma),
      fuente: "xupalace"
    });
  }
  return results;
}

async function getImdbFromTmdb(tmdbId, type) {
  // 1) external_ids
  try {
    var r1 = await fetchText(
      "https://api.themoviedb.org/3/" + type + "/" + tmdbId + "/external_ids?api_key=" + TMDB_KEY
    );
    var d1 = JSON.parse(r1);
    if (d1.imdb_id && /^tt\d+$/.test(d1.imdb_id)) return d1.imdb_id;
  } catch (_) {}
  // 2) detail + append
  try {
    var r2 = await fetchText(
      "https://api.themoviedb.org/3/" + type + "/" + tmdbId + "?api_key=" + TMDB_KEY + "&append_to_response=external_ids"
    );
    var d2 = JSON.parse(r2);
    if (d2.imdb_id && /^tt\d+$/.test(d2.imdb_id)) return d2.imdb_id;
    if (d2.external_ids && d2.external_ids.imdb_id) return d2.external_ids.imdb_id;
  } catch (_) {}
  // 3) OMDB fallback by title
  try {
    var r3 = await fetchText("https://api.themoviedb.org/3/" + type + "/" + tmdbId + "?api_key=" + TMDB_KEY);
    var d3 = JSON.parse(r3);
    var title = type === "movie" ? d3.title : d3.name;
    var dateStr = type === "movie" ? d3.release_date : d3.first_air_date;
    var year = dateStr && dateStr.length >= 4 ? dateStr.substr(0, 4) : null;
    if (!title) return null;
    var omdbUrl =
      "http://www.omdbapi.com/?apikey=" +
      OMDB_KEY +
      "&t=" +
      encodeURIComponent(title) +
      "&type=" +
      (type === "movie" ? "movie" : "series") +
      (year ? "&y=" + year : "");
    var omdb = await fetchText(omdbUrl);
    var od = JSON.parse(omdb);
    if (od.Response !== "False" && od.imdbID) return od.imdbID;
  } catch (_) {}
  return null;
}

/* ========== EXTRACTORES (igual que Cuevana) ========== */

function unpackPacked(p, a, k) {
  try {
    a = parseInt(a, 10);
    var chars = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
    function toBase(n, radix) {
      var res = "";
      while (n > 0) {
        res = chars[n % radix] + res;
        n = Math.floor(n / radix);
      }
      return res || "0";
    }
    return p.replace(/\b\w+\b/g, function (word) {
      var idx = parseInt(word, 36);
      if (isNaN(idx)) return word;
      return k[idx] && k[idx] !== "" ? k[idx] : toBase(idx, a);
    });
  } catch (_) {
    return null;
  }
}

function findM3u8InText(txt, baseOrigin) {
  if (!txt) return null;
  var m = txt.match(/"hls[234]"\s*:\s*"([^"]+)"/i);
  if (m) {
    var u = m[1];
    if (u.startsWith("/")) u = (baseOrigin || "") + u;
    return u;
  }
  m = txt.match(/file\s*:\s*["']([^"']+)["']/i);
  if (m) {
    var u2 = m[1];
    if (u2.startsWith("/")) u2 = (baseOrigin || "") + u2;
    return u2;
  }
  m = txt.match(/sources\s*:\s*\[\s*\{[^}]*file\s*:\s*["']([^"']+)["']/i);
  if (m) {
    var u3 = m[1];
    if (u3.startsWith("/")) u3 = (baseOrigin || "") + u3;
    return u3;
  }
  m =
    txt.match(/https?:\/\/[^"'\s\\]+\.m3u8[^"'\s\\]*/i) ||
    txt.match(/https?:\/\/[^"'\s\\]+\.mp4[^"'\s\\]*/i);
  if (m) return m[0];
  return null;
}

async function resolveStreamWish(embedUrl) {
  try {
    var urlObj = new URL(embedUrl);
    var rawId = urlObj.pathname.split("/").filter(Boolean).pop().replace(/\.html$/, "");
    var mirrors = [
      embedUrl,
      "https://vibuxer.com/e/" + rawId,
      "https://hanerix.com/e/" + rawId,
      "https://embedwish.com/e/" + rawId,
      "https://hglink.to/e/" + rawId,
      "https://streamwish.to/e/" + rawId,
      "https://awish.pro/e/" + rawId,
      "https://strwish.com/e/" + rawId,
      "https://wishfast.top/e/" + rawId,
      "https://sfastwish.com/e/" + rawId,
      "https://hlswish.com/e/" + rawId
    ].filter(function (v, i, a) { return a.indexOf(v) === i; });

    for (var i = 0; i < mirrors.length; i++) {
      try {
        var mirror = mirrors[i];
        var origin = new URL(mirror).origin;
        var html = await fetchText(mirror, {
          headers: { Referer: origin + "/", Origin: origin, "User-Agent": UA }
        });
        var hashMatch = html.match(/[0-9a-f]{32}/i);
        if (hashMatch) {
          var hash = hashMatch[0];
          var dlUrl =
            origin +
            "/dl?op=view&file_code=" +
            rawId +
            "&hash=" +
            hash +
            "&embed=1&referer=&adb=1&hls4=1";
          try {
            var dlText = await fetchText(dlUrl, {
              headers: {
                "User-Agent": UA,
                Referer: mirror,
                "X-Requested-With": "XMLHttpRequest"
              }
            });
            var m3 = dlText.match(/https?:\/\/[^"']+\.m3u8[^"']*/i);
            if (m3) {
              return { url: m3[0], headers: { "User-Agent": UA, Referer: origin + "/" } };
            }
          } catch (_) {}
        }
        var fileM = html.match(/file\s*:\s*["']([^"']+)["']/i);
        if (fileM) {
          var furl = fileM[1];
          if (furl.startsWith("/")) furl = origin + furl;
          if (furl.includes("vibuxer.com/stream/") || furl.includes("/hls/")) {
            try {
              var r = await fetch(furl, {
                headers: { "User-Agent": UA, Referer: origin + "/" },
                redirect: "follow"
              });
              if (r.url && (r.url.includes(".m3u8") || r.url.includes(".mp4"))) {
                return { url: r.url, headers: { "User-Agent": UA, Referer: origin + "/" } };
              }
            } catch (_) {}
          }
          if (furl.includes(".m3u8") || furl.includes(".mp4")) {
            return { url: furl, headers: { "User-Agent": UA, Referer: origin + "/" } };
          }
        }
        var packed = html.match(
          /eval\(function\(p,a,c,k,e,[a-z]\)\{[\s\S]*?\}\s*\('([\s\S]+?)',\s*(\d+),\s*(\d+),\s*'([\s\S]+?)'\.split\('\|'\)/
        );
        if (packed) {
          var unpacked = unpackPacked(packed[1], packed[2], packed[4].split("|"));
          if (unpacked) {
            var found = findM3u8InText(unpacked, origin);
            if (found) return { url: found, headers: { "User-Agent": UA, Referer: origin + "/" } };
          }
        }
        var direct = findM3u8InText(html, origin);
        if (direct) return { url: direct, headers: { "User-Agent": UA, Referer: origin + "/" } };
      } catch (_) {}
    }
  } catch (_) {}
  return null;
}

async function resolveVidHide(embedUrl) {
  try {
    var urlObj = new URL(embedUrl);
    var origin = urlObj.origin;
    var html = await fetchText(embedUrl, {
      headers: { "User-Agent": UA, Referer: origin + "/" }
    });
    var packedMatch = html.match(
      /eval\(function\(p,a,c,k,e,[rd]\)[\s\S]*?\.split\('\|'\)[^\)]*\)\)/
    );
    if (packedMatch) {
      var um = packedMatch[0].match(
        /eval\(function\(p,a,c,k,e,[rd]\)\{.*?\}\s*\('([\s\S]*?)',\s*(\d+),\s*(\d+),\s*'([\s\S]*?)'\.split\('\|'\)/
      );
      if (um) {
        var unpacked = unpackPacked(um[1], um[2], um[4].split("|"));
        if (unpacked) {
          var found = findM3u8InText(unpacked, origin);
          if (found) return { url: found, headers: { "User-Agent": UA, Referer: origin + "/" } };
        }
      }
    }
    var found2 = findM3u8InText(html, origin);
    if (found2) return { url: found2, headers: { "User-Agent": UA, Referer: origin + "/" } };
    var btn =
      html.match(/id=["']btn_enlace["'][^>]*>[\s\S]*?href=["']([^"']+)["']/i) ||
      html.match(/<iframe[^>]+src=["']([^"']+)["']/i);
    if (btn && btn[1] && btn[1].startsWith("http")) {
      return await resolveVidHide(btn[1]);
    }
  } catch (_) {}
  return null;
}

async function resolveVoe(embedUrl) {
  try {
    var html = await fetchText(embedUrl, {
      headers: { "User-Agent": UA, Referer: embedUrl }
    });
    if (/permanentToken/i.test(html)) {
      var redir = html.match(/window\.location\.href\s*=\s*['"]([^'"]+)['"]/i);
      if (redir) {
        html = await fetchText(redir[1], { headers: { "User-Agent": UA, Referer: embedUrl } });
      }
    }
    var b64 = html.match(/["'](aHR0[^"']{20,})["']/);
    if (b64) {
      try {
        var decoded = atob(b64[1]);
        if (decoded.includes(".m3u8") || decoded.includes(".mp4")) {
          return { url: decoded, headers: { "User-Agent": UA, Referer: embedUrl } };
        }
      } catch (_) {}
    }
    var found = findM3u8InText(html, new URL(embedUrl).origin);
    if (found) return { url: found, headers: { "User-Agent": UA, Referer: embedUrl } };
  } catch (_) {}
  return null;
}

async function resolveGeneric(embedUrl) {
  try {
    var origin = new URL(embedUrl).origin;
    var html = await fetchText(embedUrl, {
      headers: { "User-Agent": UA, Referer: origin + "/" }
    });
    var packed = html.match(
      /eval\(function\(p,a,c,k,e,[a-zrd]\)\{[\s\S]*?\}\s*\('([\s\S]+?)',\s*(\d+),\s*(\d+),\s*'([\s\S]+?)'\.split\('\|'\)/
    );
    if (packed) {
      var unpacked = unpackPacked(packed[1], packed[2], packed[4].split("|"));
      if (unpacked) {
        var f = findM3u8InText(unpacked, origin);
        if (f) return { url: f, headers: { "User-Agent": UA, Referer: origin + "/" } };
      }
    }
    var f2 = findM3u8InText(html, origin);
    if (f2) return { url: f2, headers: { "User-Agent": UA, Referer: origin + "/" } };
  } catch (_) {}
  return null;
}

async function resolveFinal(streamUrl, hostHint) {
  if (!streamUrl) return null;
  streamUrl = fixHost(streamUrl);
  var host = (hostHint || "").toLowerCase() + " " + streamUrl.toLowerCase();
  var result = null;

  if (/streamwish|hglink|swdyu|cybervynx|dumbalag|vibuxer|hlswish|awish|strwish|wishfast|sfastwish|hanerix|embedwish/.test(host)) {
    result = await resolveStreamWish(streamUrl);
  } else if (/vidhide|mivalyo|dinisglows|dhtpre|minochinos|vidhidepro|vidhidevip|dintezuvio|dramiyos|callistanise|filelions/.test(host)) {
    result = await resolveVidHide(streamUrl);
  } else if (/voe\.sx|voe-|voex|cloudwindow/.test(host)) {
    result = await resolveVoe(streamUrl);
  }

  if (!result) result = await resolveGeneric(streamUrl);

  if (!result && (/\.m3u8|\.mp4/i.test(streamUrl))) {
    result = { url: streamUrl, headers: { "User-Agent": UA, Referer: SITE + "/" } };
  }

  if (result && result.url && (/\.m3u8|\.mp4|\/hls|\/stream\//i.test(result.url))) {
    return result;
  }
  return null;
}

function langLabel(lang) {
  var map = {
    es_MX: "Latino",
    latino: "Latino",
    castellano: "Castellano",
    en_US: "Inglés",
    subtitulado: "Subtitulado"
  };
  var k = String(lang || "").toLowerCase();
  return map[k] || String(lang || "");
}

async function getStreams(id, type, season, episode) {
  var raw = String(id || "");
  var tmdbId = null;
  var isMovie = true;
  var seasonNum = Number(season) || 1;
  var episodeNum = Number(episode) || 1;
  var slug = null;

  // Resolve from id or meta
  var epMatch = /^e:([a-z0-9\-]+):(\d+):(\d+)$/i.exec(raw);
  if (epMatch) {
    slug = epMatch[1];
    seasonNum = Number(epMatch[2]);
    episodeNum = Number(epMatch[3]);
    isMovie = false;
  } else {
    var m = /^(m|s|a):([a-z0-9\-]+)/i.exec(raw);
    if (!m) return [];
    isMovie = m[1].toLowerCase() === "m";
    slug = m[2];
    if (!isMovie && (season == null || episode == null)) return [];
  }

  // Need tmdbId / imdb → try getMeta first
  try {
    var metaId = isMovie ? "m:" + slug : "s:" + slug;
    var meta = await getMeta(metaId);
    if (meta) {
      tmdbId = meta.tmdbId;
      if (meta.imdbId) {
        // already have imdb
      }
    }
  } catch (_) {}

  if (!tmdbId) {
    // last resort: search by title from slug
    return [];
  }

  var imdbId = null;
  try {
    imdbId = await getImdbFromTmdb(tmdbId, isMovie ? "movie" : "tv");
  } catch (_) {}
  if (!imdbId) return [];

  // Build id variants (igual que Embed69)
  var idVariants = [];
  if (isMovie) {
    idVariants.push(imdbId);
  } else {
    var s = seasonNum;
    var e = episodeNum;
    var e2 = String(e).padStart(2, "0");
    var s2 = String(s).padStart(2, "0");
    idVariants = [
      imdbId + "-" + s + "x" + e2,
      imdbId + "-" + s + "x" + e,
      imdbId + "-" + s2 + "x" + e2,
      imdbId + "-" + s + "-" + e2,
      imdbId + "-" + s + "-" + e
    ];
  }

  var servers = [];
  for (var v = 0; v < idVariants.length; v++) {
    var idCompleto = idVariants[v];
    var fromSk = await fetchFromSeriesKao(idCompleto);
    if (fromSk && fromSk.length) {
      servers = fromSk;
      break;
    }
    var fromXu = await fetchFromXupalace(idCompleto);
    if (fromXu && fromXu.length) {
      servers = fromXu;
      break;
    }
  }

  if (!servers.length) return [];

  // Prefer language
  var cfg = getUserConfig();
  var pref = String(cfg.pref_lang || "latino").toLowerCase();
  var order = [pref, "es_mx", "latino", "subtitulado", "castellano", "en_us"];
  servers.sort(function (a, b) {
    var ia = order.indexOf(String(a.idioma).toLowerCase());
    var ib = order.indexOf(String(b.idioma).toLowerCase());
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  });

  var streams = [];
  for (var i = 0; i < servers.length; i++) {
    var s = servers[i];
    var lang = langLabel(s.idioma);
    var host = String(s.serverName || "server").replace(/\s+/g, " ").trim() || "Server";
    var streamUrl = s.url;

    var final = null;
    try {
      final = await resolveFinal(streamUrl, host);
    } catch (_) {}

    if (!final || !final.url) continue;

    var isHls = /\.m3u8(\?|$)|\/hls\//i.test(final.url);
    var headers = Object.assign(
      { "User-Agent": UA, Referer: SITE + "/" },
      final.headers || {}
    );

    streams.push({
      name: host + " · " + lang,
      url: final.url,
      quality: "auto",
      language: lang,
      provider: host,
      isHls: isHls,
      headers: headers
    });
  }

  return streams;
}

/* ========== EXPORT ========== */

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
