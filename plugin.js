/**
 * JKAnime – addon JS para ContentService (Flutter)
 * Adaptado del plugin Cloudstream JKAnimeProvider (com.stormunblessed)
 *
 * Tabs: home | search | library | settings  (sin discover)
 * Config: appendVose (boolean) → si está activo, a cada búsqueda se añade " vose"
 *
 * Métodos: getHome, getCatalogs, getCatalog, search, getMeta, getStreams, getNews
 */

const MAIN_URL = 'https://jkanime.net';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const DEFAULT_HEADERS = {
  'User-Agent': UA,
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
  Referer: MAIN_URL + '/',
};

/** Secciones del home */
const CATALOGS = [
  { id: 'emision', title: 'En emisión', path: '/directorio?filtro=popularidad&estado=emision', type: 'series' },
  { id: 'animes', title: 'Animes', path: '/directorio?filtro=popularidad&tipo=animes', type: 'series' },
  { id: 'peliculas', title: 'Películas', path: '/directorio?filtro=popularidad&tipo=peliculas', type: 'movie' },
];

// Token CSRF + cookies (cache en memoria del runtime)
var latestToken = '';
var latestCookieHeader = '';

// ─── config ─────────────────────────────────────────────────────────────────

function getUserConfig() {
  try {
    const c =
      (typeof globalThis !== 'undefined' &&
        globalThis.__nuvioConfig &&
        (globalThis.__nuvioConfig.current || globalThis.__nuvioConfig['jkanime'])) ||
      {};
    return c && typeof c === 'object' ? c : {};
  } catch (_) {
    return {};
  }
}

function shouldAppendVose() {
  const c = getUserConfig();
  const v = c.appendVose ?? c.append_vose ?? c.vose;
  return v === true || v === 'true' || v === '1' || v === 'yes' || v === 'on';
}

// ─── HTTP ───────────────────────────────────────────────────────────────────

async function httpGet(url, headers) {
  headers = headers || {};
  const res = await fetch(url, {
    method: 'GET',
    headers: Object.assign({}, DEFAULT_HEADERS, headers),
  });
  if (!res.ok) throw new Error('GET ' + url + ' → ' + res.status);
  return res;
}

async function httpPost(url, body, headers) {
  headers = headers || {};
  var payload;
  var contentType;
  if (body && typeof body === 'object' && !(typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams)) {
    payload = new URLSearchParams(body).toString();
    contentType = 'application/x-www-form-urlencoded; charset=UTF-8';
  } else {
    payload = String(body || '');
    contentType = 'application/x-www-form-urlencoded; charset=UTF-8';
  }
  const res = await fetch(url, {
    method: 'POST',
    headers: Object.assign({}, DEFAULT_HEADERS, { 'Content-Type': contentType }, headers),
    body: payload,
  });
  if (!res.ok) throw new Error('POST ' + url + ' → ' + res.status);
  return res;
}

function fixUrl(href) {
  if (!href) return '';
  href = String(href).replace(/&amp;/g, '&');
  if (href.startsWith('//')) return 'https:' + href;
  if (href.startsWith('/')) return MAIN_URL + href;
  return href;
}

function absUrl(href) {
  return fixUrl(href);
}

function base64Decode(str) {
  try {
    if (typeof atob === 'function') return atob(str);
  } catch (_) {}
  try {
    // polyfill mínimo
    var chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=';
    var output = '';
    str = String(str).replace(/=+$/, '');
    for (var bc = 0, bs, buffer, idx = 0; (buffer = str.charAt(idx++)); ~buffer && ((bs = bc % 4 ? bs * 64 + buffer : buffer), bc++ % 4)
      ? (output += String.fromCharCode(255 & (bs >> ((-2 * bc) & 6))))
      : 0) {
      buffer = chars.indexOf(buffer);
    }
    return output;
  } catch (_) {
    return str;
  }
}

function getAnimeType(t) {
  if (!t) return 'series';
  t = String(t);
  if (t.indexOf('OVA') !== -1 || t.indexOf('Especial') !== -1 || t.indexOf('Special') !== -1) return 'series';
  if (t.indexOf('Pelicula') !== -1 || t.indexOf('Película') !== -1 || t.indexOf('Movie') !== -1) return 'movie';
  return 'series';
}

// ─── token CSRF ─────────────────────────────────────────────────────────────

async function ensureToken(url) {
  if (latestToken) return;
  const res = await httpGet(url || MAIN_URL);
  const html = await res.text();
  const m = html.match(/name=["']csrf-token["']\s+content=["']([^"']+)["']/i) ||
    html.match(/content=["']([^"']+)["']\s+name=["']csrf-token["']/i);
  latestToken = m ? m[1] : '';
  // cookies del response si el runtime las expone
  try {
    if (res.headers && typeof res.headers.get === 'function') {
      const setCookie = res.headers.get('set-cookie');
      if (setCookie) latestCookieHeader = setCookie.split(';')[0];
    }
  } catch (_) {}
}

// ─── parsers ────────────────────────────────────────────────────────────────

function toContentItem(raw) {
  return {
    id: String(raw.id || raw.url || raw.slug || ''),
    title: raw.title || 'Sin título',
    poster: raw.poster || raw.image || null,
    backdrop: raw.backdrop || raw.poster || raw.image || null,
    type: raw.type || 'series',
    overview: raw.overview || raw.synopsis || null,
    year: raw.year || null,
    rating: raw.rating != null ? Number(raw.rating) : null,
    genres: Array.isArray(raw.genres) ? raw.genres : [],
    url: raw.url || null,
  };
}

/** Últimos episodios desde home */
function parseLatestEpisodes(html) {
  const items = [];
  // bloques: div.mb-4.d-flex... dentro de #animes
  const blocks = html.split(/class="[^"]*mb-4[^"]*d-flex[^"]*align-items-stretch[^"]*"/i);
  for (var i = 1; i < blocks.length; i++) {
    const b = blocks[i];
    const titleM = b.match(/<h5[^>]*>([\s\S]*?)<\/h5>/i);
    const hrefM = b.match(/<a[^>]+href=["']([^"']+)["']/i);
    const imgM =
      b.match(/<img[^>]+class=["'][^"']*card-img-top[^"']*["'][^>]+src=["']([^"']+)["']/i) ||
      b.match(/src=["']([^"']+)["'][^>]*class=["'][^"']*card-img-top/i) ||
      b.match(/<img[^>]+src=["']([^"']+)["']/i);
    const epM = b.match(/badge[^>]*>\s*Ep\s*(\d+)/i);

    if (!titleM || !hrefM) continue;
    var title = titleM[1].replace(/<[^>]+>/g, '').trim();
    var href = fixUrl(hrefM[1]);
    // quitar /episodio o /N/ del final para URL de la serie
    href = href.replace(/\/(\d+)\/?$/, '/').replace(/\/especial\/?$/, '/').replace(/\/ova\/?$/, '/');
    if (href.endsWith('/')) href = href.slice(0, -1);

    const poster = imgM ? fixUrl(imgM[1]) : null;
    const epNum = epM ? parseInt(epM[1], 10) : null;

    items.push(
      toContentItem({
        id: href,
        title: title + (epNum ? ' · Ep ' + epNum : ''),
        poster: poster,
        type: 'series',
        url: href,
        overview: epNum ? 'Episodio ' + epNum : null,
      })
    );
  }
  return items;
}

/** Directorio: script var animes = { ... "data":[ ... ] } */
function parseDirectoryJson(html) {
  const items = [];
  const scripts = html.match(/<script[^>]*>[\s\S]*?<\/script>/gi) || [];
  for (var i = 0; i < scripts.length; i++) {
    const s = scripts[i];
    if (s.indexOf('var animes') === -1 && s.indexOf('"data":[') === -1) continue;
    var chunk = s;
    var after = chunk.indexOf('"data":[');
    if (after === -1) after = chunk.indexOf("'data':[");
    if (after === -1) continue;
    chunk = chunk.substring(after + 7); // desde [
    // encontrar fin del array de data
    var depth = 0;
    var end = -1;
    for (var j = 0; j < chunk.length; j++) {
      if (chunk[j] === '[') depth++;
      else if (chunk[j] === ']') {
        depth--;
        if (depth === 0) {
          end = j;
          break;
        }
      }
    }
    if (end === -1) continue;
    var jsonStr = chunk.substring(0, end + 1);
    try {
      const list = JSON.parse(jsonStr);
      if (!Array.isArray(list)) continue;
      for (var k = 0; k < list.length; k++) {
        const it = list[k];
        if (!it) continue;
        const title = it.title || it.name;
        const url = it.url || (it.slug ? MAIN_URL + '/' + it.slug : null);
        if (!title || !url) continue;
        items.push(
          toContentItem({
            id: url,
            title: title,
            poster: it.image || it.thumbnail || null,
            type: getAnimeType(it.type),
            overview: it.synopsis || null,
            url: fixUrl(url),
          })
        );
      }
      if (items.length) break;
    } catch (_) {}
  }
  return items;
}

/** Cards de búsqueda: div.anime__item */
function parseSearchCards(html) {
  const items = [];
  const blocks = html.split(/class="[^"]*anime__item[^"]*"/i);
  for (var i = 1; i < blocks.length; i++) {
    const b = blocks[i];
    const titleM = b.match(/class=["'][^"']*title[^"']*["'][^>]*>([\s\S]*?)</i) || b.match(/<h[1-6][^>]*>([\s\S]*?)<\/h/i);
    const hrefM = b.match(/<a[^>]+href=["']([^"']+)["']/i);
    const imgM =
      b.match(/data-setbg=["']([^"']+)["']/i) ||
      b.match(/src=["']([^"']+)["']/i);

    if (!titleM || !hrefM) continue;
    const title = titleM[1].replace(/<[^>]+>/g, '').trim();
    const href = fixUrl(hrefM[1]);
    const poster = imgM ? fixUrl(imgM[1]) : null;
    items.push(
      toContentItem({
        id: href,
        title: title,
        poster: poster,
        type: 'series',
        url: href,
      })
    );
  }
  return items;
}

// ─── catálogo / home ────────────────────────────────────────────────────────

async function fetchCatalogPage(catalog, page) {
  page = page || 1;
  var path = catalog.path || catalog.id;
  // paginación del directorio si existe
  var url = MAIN_URL + path;
  if (page > 1) {
    url += (path.indexOf('?') !== -1 ? '&' : '?') + 'p=' + page;
  }
  const res = await httpGet(url);
  const html = await res.text();
  var items = parseDirectoryJson(html);
  if (!items.length) {
    // fallback cards genéricas
    items = parseSearchCards(html);
  }
  return { items: items, hasMore: items.length >= 20, page: page };
}

async function getCatalogs() {
  return CATALOGS.map(function (c) {
    return { id: c.id, title: c.title, type: c.type };
  });
}

async function getCatalog(catalogId, opts) {
  opts = opts || {};
  const page = opts.page || 1;
  const catalog =
    CATALOGS.find(function (c) {
      return c.id === catalogId;
    }) || { id: catalogId, path: '/' + catalogId, title: catalogId };
  return fetchCatalogPage(catalog, page);
}

async function getHome(opts) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const structureOnly = o.structureOnly === true || o.lightweight === true;
  const page = o.page || 1;
  const rowId = o.rowId || o.catalogId || o.id;

  if (rowId) {
    if (rowId === 'ultimos' || rowId === 'latest') {
      const res = await httpGet(MAIN_URL);
      const html = await res.text();
      const items = parseLatestEpisodes(html);
      return {
        id: 'ultimos',
        title: 'Últimos episodios',
        type: 'row',
        items: items,
        catalogId: 'ultimos',
        imageStyle: 'poster',
        hasMore: false,
      };
    }
    const catalog =
      CATALOGS.find(function (c) {
        return c.id === rowId;
      }) || { id: rowId, path: '/' + rowId, title: rowId };
    const pageResult = await fetchCatalogPage(catalog, page);
    return {
      id: catalog.id,
      title: catalog.title || catalog.id,
      type: 'row',
      items: pageResult.items,
      catalogId: catalog.id,
      imageStyle: 'poster',
      hasMore: pageResult.hasMore,
    };
  }

  if (structureOnly) {
    const rows = [
      { id: 'ultimos', title: 'Últimos episodios', type: 'row', items: [], catalogId: 'ultimos', imageStyle: 'poster' },
    ];
    CATALOGS.forEach(function (c) {
      rows.push({
        id: c.id,
        title: c.title,
        type: 'row',
        items: [],
        catalogId: c.id,
        imageStyle: 'poster',
      });
    });
    return rows;
  }

  // Home completo
  const rows = [];
  try {
    const res = await httpGet(MAIN_URL);
    const html = await res.text();
    const latest = parseLatestEpisodes(html);
    rows.push({
      id: 'ultimos',
      title: 'Últimos episodios',
      type: 'row',
      items: latest,
      catalogId: 'ultimos',
      imageStyle: 'poster',
    });
  } catch (_) {
    rows.push({
      id: 'ultimos',
      title: 'Últimos episodios',
      type: 'row',
      items: [],
      catalogId: 'ultimos',
      imageStyle: 'poster',
    });
  }

  for (var i = 0; i < CATALOGS.length; i++) {
    const c = CATALOGS[i];
    try {
      const pageResult = await fetchCatalogPage(c, 1);
      rows.push({
        id: c.id,
        title: c.title,
        type: 'row',
        items: pageResult.items,
        catalogId: c.id,
        imageStyle: 'poster',
      });
    } catch (_) {
      rows.push({
        id: c.id,
        title: c.title,
        type: 'row',
        items: [],
        catalogId: c.id,
        imageStyle: 'poster',
      });
    }
  }
  return rows;
}

async function getNews() {
  try {
    const res = await httpGet(MAIN_URL);
    const html = await res.text();
    return parseLatestEpisodes(html).slice(0, 20);
  } catch (_) {
    return [];
  }
}

async function search(query) {
  if (!query || !String(query).trim()) return [];
  var q = String(query).trim();
  if (shouldAppendVose() && !/\bvose\b/i.test(q)) {
    q = q + ' vose';
  }
  const url = MAIN_URL + '/buscar/' + encodeURIComponent(q);
  const res = await httpGet(url);
  const html = await res.text();
  return parseSearchCards(html);
}

/**
 * getMeta(url de la serie o slug)
 */
async function getMeta(id, opts) {
  opts = opts || {};
  var url = String(id);
  if (url.indexOf('http') !== 0) {
    url = MAIN_URL + (url.startsWith('/') ? url : '/' + url);
  }
  url = url.replace(/\/(\d+)\/?$/, '/').replace(/\/$/, '');

  await ensureToken(url);
  const res = await httpGet(url);
  const html = await res.text();

  const posterM = html.match(/class=["'][^"']*anime_pic[^"']*["'][\s\S]*?<img[^>]+src=["']([^"']+)["']/i) ||
    html.match(/anime_pic[\s\S]*?src=["']([^"']+)["']/i);
  const titleM = html.match(/class=["'][^"']*anime_info[^"']*["'][\s\S]*?<h3[^>]*>([\s\S]*?)<\/h3>/i) ||
    html.match(/<h3[^>]*>([\s\S]*?)<\/h3>/i);
  const descM = html.match(/<p[^>]*class=["'][^"']*scroll[^"']*["'][^>]*>([\s\S]*?)<\/p>/i);

  const poster = posterM ? fixUrl(posterM[1]) : null;
  const title = titleM ? titleM[1].replace(/<[^>]+>/g, '').trim() : 'Anime';
  const overview = descM ? descM[1].replace(/<[^>]+>/g, '').trim() : null;

  // géneros
  const genres = [];
  const genreRe = /div\.card[\s\S]{0,200}<a[^>]*>([^<]+)<\/a>/gi;
  // más simple: links de género en la ficha
  const genreBlocks = html.match(/href=["'][^"']*genero[^"']*["'][^>]*>([^<]+)</gi) || [];
  genreBlocks.forEach(function (g) {
    const m = g.match(/>([^<]+)</);
    if (m) genres.push(m[1].trim());
  });

  // estado / año / tipo
  var year = null;
  var statusText = null;
  var typeText = null;
  const liRe = /<li[^>]*>([\s\S]*?)<\/li>/gi;
  var lim;
  while ((lim = liRe.exec(html)) !== null) {
    const t = lim[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (t.indexOf('Estado') !== -1) statusText = t.replace(/.*Estado:\s*/i, '').trim();
    if (t.indexOf('Emitido') !== -1) {
      const ym = t.match(/(\d{4})/);
      if (ym) year = ym[1];
    }
    if (!typeText && (t.indexOf('Anime') !== -1 || t.indexOf('OVA') !== -1 || t.indexOf('Pel') !== -1)) {
      typeText = t;
    }
  }

  // anime ID para ajax de episodios
  const animeIdM =
    html.match(/id=["']guardar-anime["'][^>]*data-anime=["'](\d+)["']/i) ||
    html.match(/data-anime=["'](\d+)["']/i);
  const animeID = animeIdM ? animeIdM[1] : null;

  const episodes = [];
  if (animeID) {
    var finished = false;
    var pagnum = 1;
    while (!finished && pagnum <= 50) {
      try {
        const headers = { Referer: url };
        if (latestCookieHeader) headers['Cookie'] = latestCookieHeader;
        const postRes = await httpPost(
          MAIN_URL + '/ajax/episodes/' + animeID + '/' + pagnum + '/',
          { _token: latestToken },
          headers
        );
        const text = await postRes.text();
        pagnum++;
        var json;
        try {
          json = JSON.parse(text);
        } catch (_) {
          // a veces viene envuelto en HTML
          const jm = text.match(/\{[\s\S]*"data"[\s\S]*\}/);
          if (jm) json = JSON.parse(jm[0]);
        }
        if (!json || !json.data || !json.data.length) {
          finished = true;
          break;
        }
        for (var ei = 0; ei < json.data.length; ei++) {
          const info = json.data[ei];
          const num = info.number || info.episode || String(ei + 1);
          const epUrl = url.replace(/\/$/, '') + '/' + num;
          var still = null;
          if (info.image) {
            still = 'https://cdn.jkdesu.com/assets/images/animes/video/image_thumb/' + info.image;
          }
          episodes.push({
            number: parseInt(num, 10) || ei + 1,
            id: epUrl,
            title: info.title || 'Episodio ' + num,
            still: still,
          });
        }
        if (!json.next_page_url && !json.nextPageurl) finished = true;
      } catch (_) {
        finished = true;
      }
    }
  }

  // si no hubo ajax, intentar links de episodios en la página
  if (!episodes.length) {
    const epLinks = html.match(/href=["']([^"']*\/\d+\/?)["']/gi) || [];
    const seen = new Set();
    epLinks.forEach(function (raw) {
      const hm = raw.match(/href=["']([^"']+)["']/);
      if (!hm) return;
      var href = fixUrl(hm[1]);
      const nm = href.match(/\/(\d+)\/?$/);
      if (!nm) return;
      if (href.indexOf(url.replace(MAIN_URL, '')) === -1 && href.indexOf(url) === -1) {
        // solo del mismo anime
        if (href.indexOf(url.split('/').pop()) === -1) return;
      }
      if (seen.has(nm[1])) return;
      seen.add(nm[1]);
      episodes.push({
        number: parseInt(nm[1], 10),
        id: href.replace(/\/$/, ''),
        title: 'Episodio ' + nm[1],
        still: null,
      });
    });
    episodes.sort(function (a, b) {
      return a.number - b.number;
    });
  }

  const contentType = getAnimeType(typeText || '');
  if (contentType === 'movie' && episodes.length <= 1) {
    return {
      id: url,
      title: title,
      poster: poster,
      backdrop: poster,
      overview: overview,
      type: 'movie',
      year: year,
      genres: genres,
      url: url,
    };
  }

  return {
    id: url,
    title: title,
    poster: poster,
    backdrop: poster,
    overview: overview,
    type: 'series',
    year: year,
    genres: genres,
    seasons: [
      {
        number: 1,
        name: 'Temporada 1',
        episodes: episodes,
      },
    ],
    url: url,
  };
}

// ─── streams / extractores ──────────────────────────────────────────────────

function rewriteEmbedUrl(u) {
  if (!u) return u;
  u = String(u)
    .replace('https://hglink.to', 'https://streamwish.to')
    .replace('https://swdyu.com', 'https://streamwish.to')
    .replace('https://mivalyo.com', 'https://vidhidepro.com')
    .replace('https://filemoon.link', 'https://filemoon.sx')
    .replace('https://sblona.com', 'https://watchsb.com')
    .replace(MAIN_URL + '/jkfembed.php?u=', 'https://embedsito.com/v/')
    .replace(MAIN_URL + '/jkokru.php?u=', 'https://ok.ru/videoembed/')
    .replace(MAIN_URL + '/jkvmixdrop.php?u=', 'https://mixdrop.co/e/')
    .replace('/jkfembed.php?u=', 'https://embedsito.com/v/')
    .replace('/jkokru.php?u=', 'https://ok.ru/videoembed/')
    .replace('/jkvmixdrop.php?u=', 'https://mixdrop.co/e/')
    .replace(MAIN_URL + '/jk.php?u=', MAIN_URL + '/')
    .replace('/jk.php?u=', MAIN_URL + '/');
  return u;
}

function extractUrlsFromText(text) {
  if (!text) return [];
  const re = /https?:\/\/[^\s"'<>\\]+/g;
  const found = text.match(re) || [];
  return found.map(function (u) {
    return u.replace(/[.,;)\]]+$/, '');
  });
}

/**
 * getStreams(episodeUrl)
 * Parsea var servers = [...] (base64 remote) + um/um2/jkmedia/nozomi
 */
async function getStreams(id, type, season, episode) {
  var dataUrl = String(id);
  if (dataUrl.indexOf('http') !== 0) {
    dataUrl = MAIN_URL + (dataUrl.startsWith('/') ? dataUrl : '/' + dataUrl);
  }

  const streams = [];
  const headersBase = {
    'User-Agent': UA,
    Referer: MAIN_URL + '/',
  };

  function pushStream(name, url, extra) {
    if (!url) return;
    url = String(url);
    const isHls = url.indexOf('.m3u8') !== -1;
    streams.push(
      Object.assign(
        {
          url: url,
          name: name || 'JKAnime',
          quality: extra && extra.quality ? extra.quality : 'auto',
          language: 'es',
          provider: 'jkanime',
          headers: Object.assign({}, headersBase, (extra && extra.headers) || {}),
          isHls: isHls,
          subtitles: (extra && extra.subtitles) || [],
        },
        {}
      )
    );
  }

  const res = await httpGet(dataUrl);
  const html = await res.text();

  // 1) var servers = [ { remote: "base64..." }, ... ]
  var serversJson = null;
  const serversMatch = html.match(/var\s+servers\s*=\s*\[([\s\S]*?)\];/);
  if (serversMatch) {
    try {
      serversJson = JSON.parse('[' + serversMatch[1] + ']');
    } catch (_) {
      // intentar objetos sueltos
      const remoteRe = /"remote"\s*:\s*"([^"]+)"/g;
      var rm;
      serversJson = [];
      while ((rm = remoteRe.exec(serversMatch[1])) !== null) {
        serversJson.push({ remote: rm[1] });
      }
    }
  }

  if (serversJson && Array.isArray(serversJson)) {
    for (var i = 0; i < serversJson.length; i++) {
      const enc = serversJson[i] && serversJson[i].remote;
      if (!enc) continue;
      var decoded = base64Decode(enc);
      decoded = rewriteEmbedUrl(decoded);
      // Si ya es m3u8/mp4 directo
      if (/\.m3u8|\.mp4|googlevideo|okcdn/i.test(decoded)) {
        pushStream('JKAnime Server', decoded, { quality: 'auto' });
        continue;
      }
      // Devolver el embed como "servidor" para que el player / proxy de la app lo resuelva
      // (ContentService / stream_proxy puede cargar extractores)
      pushStream('JKAnime Embed', decoded, {
        quality: 'auto',
        headers: { Referer: MAIN_URL + '/' },
      });
    }
  }

  // 2) iframe / player links en la página (jk.php, um, um2, jkmedia, ok.ru…)
  const iframeRe = /(?:src|href)=["']([^"']*(?:jk\.php|um2?\.php|jkmedia|jkokru|jkfembed|jkvmixdrop|ok\.ru|streamwish|filemoon|mixdrop)[^"']*)["']/gi;
  var im;
  const seenEmbeds = new Set();
  while ((im = iframeRe.exec(html)) !== null) {
    var link = rewriteEmbedUrl(fixUrl(im[1]));
    if (!link || seenEmbeds.has(link)) continue;
    seenEmbeds.add(link);

    // um2.php → Nozomi / gsplay
    if (link.indexOf('um2.php') !== -1) {
      try {
        const dres = await httpGet(link, { Referer: dataUrl });
        const dhtml = await dres.text();
        const keyM = dhtml.match(/<input[^>]+value=["']([^"']+)["']/i);
        if (keyM) {
          const postRes = await fetch(MAIN_URL + '/gsplay/redirect_post.php', {
            method: 'POST',
            headers: Object.assign({}, DEFAULT_HEADERS, {
              'Content-Type': 'application/x-www-form-urlencoded',
              Referer: link,
              Origin: MAIN_URL,
            }),
            body: 'data=' + encodeURIComponent(keyM[1]),
            redirect: 'manual',
          });
          var loc = null;
          try {
            loc = postRes.headers.get('location') || postRes.headers.get('Location');
          } catch (_) {}
          if (loc) {
            const postkey = String(loc).replace(/.*#/, '').replace(/.*player\.html#/, '');
            const apiRes = await httpPost(
              MAIN_URL + '/gsplay/api.php',
              { v: postkey },
              {
                'X-Requested-With': 'XMLHttpRequest',
                Origin: MAIN_URL,
                Referer: MAIN_URL + '/',
              }
            );
            const apiText = await apiRes.text();
            try {
              const j = JSON.parse(apiText);
              if (j.file) pushStream('Nozomi', j.file, { quality: 'auto' });
            } catch (_) {}
          }
        }
      } catch (_) {}
      continue;
    }

    // /um.php → m3u8 Desu
    if (link.indexOf('/um') !== -1 && link.indexOf('um2') === -1) {
      try {
        const dres = await httpGet(link, { Referer: dataUrl });
        const dhtml = await dres.text();
        const m3 = dhtml.match(/(https?:\/\/[^\s"'\\]+\.m3u8[^\s"'\\]*)/i);
        if (m3) {
          pushStream('Desu', m3[1], {
            quality: 'auto',
            headers: { Referer: MAIN_URL + '/' },
          });
        }
      } catch (_) {}
      continue;
    }

    // jkmedia → redirect location
    if (link.indexOf('jkmedia') !== -1) {
      try {
        const xres = await fetch(link, {
          method: 'GET',
          headers: Object.assign({}, DEFAULT_HEADERS, { Referer: dataUrl }),
          redirect: 'manual',
        });
        var xloc = null;
        try {
          xloc = xres.headers.get('location') || xres.headers.get('Location');
        } catch (_) {}
        if (xloc) pushStream('Xtreme S', xloc, { quality: 'auto' });
      } catch (_) {}
      continue;
    }

    // resto: embed genérico
    pushStream('JKAnime', link, { quality: 'auto' });
  }

  // 3) m3u8 directos en el HTML
  const directM3u8 = html.match(/https?:\/\/[^\s"'\\]+\.m3u8[^\s"'\\]*/gi) || [];
  directM3u8.forEach(function (u) {
    pushStream('JKAnime HLS', u, { quality: 'auto', headers: { Referer: MAIN_URL + '/' } });
  });

  // dedup por url
  const seen = new Set();
  return streams.filter(function (s) {
    if (!s.url || seen.has(s.url)) return false;
    seen.add(s.url);
    return true;
  });
}

async function getDiscover() {
  return { items: [], hasMore: false, page: 1 };
}

async function getDiscoverFilters() {
  return [];
}

module.exports = {
  getHome: getHome,
  getCatalogs: getCatalogs,
  getCatalog: getCatalog,
  search: search,
  getMeta: getMeta,
  getStreams: getStreams,
  getNews: getNews,
  getDiscover: getDiscover,
  getDiscoverFilters: getDiscoverFilters,
};
