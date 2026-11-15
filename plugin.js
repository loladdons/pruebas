/**
 * JKAnime – addon JS para ContentService (Flutter)
 * Corregido: búsqueda paginada + imágenes, episodios (pagination_episodes),
 * servidores (servers base64 + Desu/Magi + embeds).
 */

const MAIN_URL = 'https://jkanime.net';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const DEFAULT_HEADERS = {
  'User-Agent': UA,
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
  Referer: MAIN_URL + '/',
};

const CATALOGS = [
  { id: 'emision', title: 'En emisión', path: '/directorio?filtro=popularidad&estado=emision', type: 'series' },
  { id: 'animes', title: 'Animes', path: '/directorio?filtro=popularidad&tipo=animes', type: 'series' },
  { id: 'peliculas', title: 'Películas', path: '/directorio?filtro=popularidad&tipo=peliculas', type: 'movie' },
];

function getUserConfig() {
  try {
    const c = (typeof globalThis !== 'undefined' && globalThis.__nuvioConfig &&
      (globalThis.__nuvioConfig.current || globalThis.__nuvioConfig['jkanime'])) || {};
    return c && typeof c === 'object' ? c : {};
  } catch (_) { return {}; }
}
function shouldAppendVose() {
  const v = getUserConfig().appendVose;
  return v === true || v === 'true' || v === '1' || v === 'yes' || v === 'on';
}

async function httpGet(url, headers) {
  const res = await fetch(url, { method: 'GET', headers: Object.assign({}, DEFAULT_HEADERS, headers || {}) });
  if (!res.ok) throw new Error('GET ' + url + ' → ' + res.status);
  return res;
}
async function httpPost(url, body, headers) {
  const payload = typeof body === 'string' ? body : new URLSearchParams(body || {}).toString();
  const res = await fetch(url, {
    method: 'POST',
    headers: Object.assign({}, DEFAULT_HEADERS, {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'X-Requested-With': 'XMLHttpRequest',
    }, headers || {}),
    body: payload,
  });
  if (!res.ok) throw new Error('POST ' + url + ' → ' + res.status);
  return res;
}
function fixUrl(href) {
  if (!href) return '';
  href = String(href).replace(/&amp;/g, '&').trim();
  if (href.startsWith('//')) return 'https:' + href;
  if (href.startsWith('/')) return MAIN_URL + href;
  return href;
}
function base64Decode(str) {
  try { if (typeof atob === 'function') return atob(str); } catch (_) {}
  try {
    var chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=';
    var output = '';
    str = String(str).replace(/=+$/, '');
    for (var bc = 0, bs, buffer, idx = 0; (buffer = str.charAt(idx++)); ~buffer && ((bs = bc % 4 ? bs * 64 + buffer : buffer), bc++ % 4)
      ? (output += String.fromCharCode(255 & (bs >> ((-2 * bc) & 6)))) : 0) {
      buffer = chars.indexOf(buffer);
    }
    return output;
  } catch (_) { return str; }
}
function getAnimeType(t) {
  if (!t) return 'series';
  t = String(t);
  if (/OVA|Especial|Special/i.test(t)) return 'series';
  if (/Pel[ií]cula|Movie/i.test(t)) return 'movie';
  return 'series';
}
function toItem(raw) {
  return {
    id: String(raw.id || raw.url || ''),
    title: raw.title || 'Sin título',
    poster: raw.poster || null,
    backdrop: raw.backdrop || raw.poster || null,
    type: raw.type || 'series',
    overview: raw.overview || null,
    year: raw.year || null,
    rating: raw.rating != null ? Number(raw.rating) : null,
    genres: Array.isArray(raw.genres) ? raw.genres : [],
    url: raw.url || null,
  };
}

// ─── SEARCH (paginado /1 /2 /3 + data-setbg) ─────────────────────────────────

function parseSearchHtml(html) {
  const items = [];
  // Regex robusto del módulo Sora
  const re = /<div class="anime__item">[\s\S]*?<a\s+href="([^"]+)"[\s\S]*?data-setbg="([^"]+)"[\s\S]*?<h5>[\s\S]*?<a[^>]*>([^<]+)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    items.push(toItem({
      id: fixUrl(m[1]),
      url: fixUrl(m[1]),
      poster: fixUrl(m[2]),
      title: m[3].trim(),
      type: 'series',
    }));
  }
  if (items.length) return items;

  // Fallback: bloques anime__item
  const blocks = html.split(/class="[^"]*anime__item[^"]*"/i);
  for (var i = 1; i < blocks.length; i++) {
    const b = blocks[i];
    const hrefM = b.match(/href=["']([^"']+)["']/i);
    const imgM = b.match(/data-setbg=["']([^"']+)["']/i) || b.match(/src=["']([^"']+)["']/i);
    const titleM = b.match(/<h5[^>]*>[\s\S]*?<a[^>]*>([^<]+)<\/a>/i) ||
      b.match(/class=["'][^"']*title[^"']*["'][^>]*>([^<]+)/i) ||
      b.match(/<h5[^>]*>([^<]+)/i);
    if (!hrefM || !titleM) continue;
    items.push(toItem({
      id: fixUrl(hrefM[1]),
      url: fixUrl(hrefM[1]),
      poster: imgM ? fixUrl(imgM[1]) : null,
      title: titleM[1].trim(),
      type: 'series',
    }));
  }
  return items;
}

async function search(query) {
  if (!query || !String(query).trim()) return [];
  var q = String(query).trim();
  if (shouldAppendVose() && !/\bvose\b/i.test(q)) q = q + ' vose';

  const enc = encodeURIComponent(q);
  const urls = [
    MAIN_URL + '/buscar/' + enc + '/1/',
    MAIN_URL + '/buscar/' + enc + '/2/',
    MAIN_URL + '/buscar/' + enc + '/3/',
    MAIN_URL + '/buscar?q=' + enc,
  ];
  const seen = new Set();
  const out = [];
  for (var i = 0; i < urls.length; i++) {
    try {
      const res = await httpGet(urls[i]);
      const html = await res.text();
      const list = parseSearchHtml(html);
      for (var j = 0; j < list.length; j++) {
        const it = list[j];
        if (seen.has(it.id)) continue;
        seen.add(it.id);
        out.push(it);
      }
    } catch (_) {}
  }
  return out;
}

// ─── HOME / CATALOGS ────────────────────────────────────────────────────────

function parseDirectoryJson(html) {
  const items = [];
  const scripts = html.match(/<script[^>]*>[\s\S]*?<\/script>/gi) || [];
  for (var i = 0; i < scripts.length; i++) {
    const s = scripts[i];
    if (s.indexOf('"data":[') === -1 && s.indexOf('var animes') === -1) continue;
    var after = s.indexOf('"data":[');
    if (after === -1) continue;
    var chunk = s.substring(after + 7);
    var depth = 0, end = -1;
    for (var j = 0; j < chunk.length; j++) {
      if (chunk[j] === '[') depth++;
      else if (chunk[j] === ']') { depth--; if (depth === 0) { end = j; break; } }
    }
    if (end === -1) continue;
    try {
      const list = JSON.parse(chunk.substring(0, end + 1));
      if (!Array.isArray(list)) continue;
      for (var k = 0; k < list.length; k++) {
        const it = list[k];
        if (!it || !it.title) continue;
        const url = it.url || (it.slug ? MAIN_URL + '/' + it.slug + '/' : null);
        if (!url) continue;
        items.push(toItem({
          id: fixUrl(url),
          url: fixUrl(url),
          title: it.title,
          poster: it.image || it.thumbnail || null,
          type: getAnimeType(it.type),
          overview: it.synopsis || null,
        }));
      }
      if (items.length) break;
    } catch (_) {}
  }
  return items;
}

function parseLatestEpisodes(html) {
  const items = [];
  const re = /<div[^>]*class="[^"]*mb-4[^"]*d-flex[^"]*"[\s\S]*?<a[^>]+href=["']([^"']+)["'][\s\S]*?<img[^>]+src=["']([^"']+)["'][\s\S]*?<h5[^>]*>([\s\S]*?)<\/h5>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    var href = fixUrl(m[1]).replace(/\/(\d+)\/?$/, '/').replace(/\/$/, '');
    var title = m[3].replace(/<[^>]+>/g, '').trim();
    items.push(toItem({ id: href, url: href, poster: fixUrl(m[2]), title: title, type: 'series' }));
  }
  if (items.length) return items;
  // fallback más simple
  const blocks = html.split(/class="[^"]*card-img-top[^"]*"/i);
  return items;
}

async function fetchCatalogPage(catalog, page) {
  page = page || 1;
  var url = MAIN_URL + (catalog.path || '/' + catalog.id);
  if (page > 1) url += (url.indexOf('?') >= 0 ? '&' : '?') + 'p=' + page;
  const res = await httpGet(url);
  const html = await res.text();
  var items = parseDirectoryJson(html);
  if (!items.length) items = parseSearchHtml(html);
  return { items: items, hasMore: items.length >= 18, page: page };
}

async function getCatalogs() {
  return CATALOGS.map(function (c) { return { id: c.id, title: c.title, type: c.type }; });
}

async function getCatalog(catalogId, opts) {
  opts = opts || {};
  const page = opts.page || 1;
  const catalog = CATALOGS.find(function (c) { return c.id === catalogId; }) ||
    { id: catalogId, path: '/' + catalogId, title: catalogId };
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
      return {
        id: 'ultimos', title: 'Últimos episodios', type: 'row',
        items: parseLatestEpisodes(html), catalogId: 'ultimos', imageStyle: 'poster', hasMore: false,
      };
    }
    const catalog = CATALOGS.find(function (c) { return c.id === rowId; }) ||
      { id: rowId, path: '/' + rowId, title: rowId };
    const pr = await fetchCatalogPage(catalog, page);
    return {
      id: catalog.id, title: catalog.title || catalog.id, type: 'row',
      items: pr.items, catalogId: catalog.id, imageStyle: 'poster', hasMore: pr.hasMore,
    };
  }

  if (structureOnly) {
    return [{ id: 'ultimos', title: 'Últimos episodios', type: 'row', items: [], catalogId: 'ultimos', imageStyle: 'poster' }]
      .concat(CATALOGS.map(function (c) {
        return { id: c.id, title: c.title, type: 'row', items: [], catalogId: c.id, imageStyle: 'poster' };
      }));
  }

  const rows = [];
  try {
    const res = await httpGet(MAIN_URL);
    const html = await res.text();
    rows.push({
      id: 'ultimos', title: 'Últimos episodios', type: 'row',
      items: parseLatestEpisodes(html), catalogId: 'ultimos', imageStyle: 'poster',
    });
  } catch (_) {
    rows.push({ id: 'ultimos', title: 'Últimos episodios', type: 'row', items: [], catalogId: 'ultimos', imageStyle: 'poster' });
  }
  for (var i = 0; i < CATALOGS.length; i++) {
    const c = CATALOGS[i];
    try {
      const pr = await fetchCatalogPage(c, 1);
      rows.push({ id: c.id, title: c.title, type: 'row', items: pr.items, catalogId: c.id, imageStyle: 'poster' });
    } catch (_) {
      rows.push({ id: c.id, title: c.title, type: 'row', items: [], catalogId: c.id, imageStyle: 'poster' });
    }
  }
  return rows;
}

async function getNews() {
  try {
    const res = await httpGet(MAIN_URL);
    return parseLatestEpisodes(await res.text()).slice(0, 20);
  } catch (_) { return []; }
}

// ─── META + EPISODIOS ───────────────────────────────────────────────────────

async function getMeta(id, opts) {
  opts = opts || {};
  var url = String(id);
  if (url.indexOf('http') !== 0) url = MAIN_URL + (url.startsWith('/') ? url : '/' + url);
  // URL de la serie (sin número de episodio al final)
  url = url.replace(/\/(\d+)\/?$/, '/');
  if (!url.endsWith('/')) url += '/';

  const res = await httpGet(url);
  const html = await res.text();

  // Poster: data-setbg en .set-bg (Cloudstream actual)
  var poster = null;
  const posterM =
    html.match(/class=["'][^"']*set-bg[^"']*["'][^>]*data-setbg=["']([^"']+)["']/i) ||
    html.match(/data-setbg=["']([^"']+)["'][^>]*class=["'][^"']*set-bg/i) ||
    html.match(/class=["'][^"']*anime_pic[^"']*["'][\s\S]{0,300}src=["']([^"']+)["']/i) ||
    html.match(/property=["']og:image["']\s+content=["']([^"']+)["']/i);
  if (posterM) poster = fixUrl(posterM[1]);

  // Título
  var title = 'Anime';
  const titleM =
    html.match(/class=["'][^"']*anime__details__title[^"']*["'][\s\S]*?<h3[^>]*>([\s\S]*?)<\/h3>/i) ||
    html.match(/<h3[^>]*>([\s\S]*?)<\/h3>/i) ||
    html.match(/property=["']og:title["']\s+content=["']([^"']+)["']/i);
  if (titleM) title = titleM[1].replace(/<[^>]+>/g, '').trim();

  // Descripción
  var overview = null;
  const descM =
    html.match(/class=["'][^"']*anime__details__text[^"']*["'][\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/i) ||
    html.match(/<p[^>]*class=["'][^"']*scroll[^"']*["'][^>]*>([\s\S]*?)<\/p>/i);
  if (descM) overview = descM[1].replace(/<[^>]+>/g, '').trim();

  // Géneros
  const genres = [];
  const gRe = /href=["'][^"']*\/genero\/[^"']*["'][^>]*>([^<]+)</gi;
  var gm;
  while ((gm = gRe.exec(html)) !== null) {
    const g = gm[1].trim();
    if (g && genres.indexOf(g) === -1) genres.push(g);
  }

  // Año / tipo
  var year = null, typeText = null;
  const yearM = html.match(/Emitido:[\s\S]*?(\d{4})/i);
  if (yearM) year = yearM[1];
  const typeM = html.match(/rel=["']tipo["'][^>]*>([^<]+)/i) || html.match(/Tipo:[\s\S]*?<[^>]+>([^<]+)/i);
  if (typeM) typeText = typeM[1].trim();

  // animeID
  const idM =
    html.match(/data-anime=["'](\d+)["']/i) ||
    html.match(/class=["'][^"']*ml-2[^"']*["'][^>]*data-anime=["'](\d+)["']/i);
  const animeID = idM ? idM[1] : null;

  // slug
  const slugM = url.match(/jkanime\.net\/([^\/]+)/i);
  const slug = slugM ? slugM[1] : '';

  // CSRF
  const csrfM = html.match(/name=["']csrf-token["']\s+content=["']([^"']+)["']/i) ||
    html.match(/content=["']([^"']+)["']\s+name=["']csrf-token["']/i);
  const csrf = csrfM ? csrfM[1] : '';

  const episodes = [];
  const seenEp = new Set();

  function addEp(num, epUrl, still, epTitle) {
    const n = parseInt(num, 10);
    if (!n || seenEp.has(n)) return;
    seenEp.add(n);
    const link = epUrl || (MAIN_URL + '/' + slug + '/' + n + '/');
    episodes.push({
      number: n,
      id: link.replace(/\/$/, ''),
      title: epTitle || ('Episodio ' + n),
      still: still || null,
    });
  }

  // 1) Cloudstream actual: a.numbers → pagination_episodes
  if (animeID) {
    const pagNums = [];
    const pagRe = /href=["'][^"']*#pag(\d+)["']/gi;
    var pm;
    while ((pm = pagRe.exec(html)) !== null) pagNums.push(pm[1]);
    if (!pagNums.length) pagNums.push('1');

    for (var pi = 0; pi < pagNums.length; pi++) {
      try {
        const eres = await httpGet(MAIN_URL + '/ajax/pagination_episodes/' + animeID + '/' + pagNums[pi] + '/');
        const etext = await eres.text();
        var arr;
        try { arr = JSON.parse(etext); } catch (_) { arr = null; }
        if (Array.isArray(arr)) {
          for (var ei = 0; ei < arr.length; ei++) {
            const info = arr[ei];
            const num = info.number || info.episode;
            var still = null;
            if (info.image) still = 'https://cdn.jkdesu.com/assets/images/animes/video/image_thumb/' + info.image;
            addEp(num, MAIN_URL + '/' + slug + '/' + num, still, info.title);
          }
        }
      } catch (_) {}
    }
  }

  // 2) Fallback Sora: POST ajax/episodes → total
  if (!episodes.length && animeID && csrf) {
    try {
      const pres = await httpPost(
        MAIN_URL + '/ajax/episodes/' + animeID + '/1',
        { _token: csrf },
        { Referer: url }
      );
      const ptext = await pres.text();
      const data = JSON.parse(ptext);
      const total = data.total || (data.data && data.data.length) || 0;
      if (data.data && Array.isArray(data.data)) {
        for (var di = 0; di < data.data.length; di++) {
          const info = data.data[di];
          addEp(info.number, MAIN_URL + '/' + slug + '/' + info.number, null, info.title);
        }
      }
      if (total > episodes.length) {
        for (var t = 1; t <= total; t++) addEp(t, MAIN_URL + '/' + slug + '/' + t);
      }
      // más páginas si hay next
      var page = 2;
      while (data.next_page_url || data.nextPageurl) {
        try {
          const nres = await httpPost(
            MAIN_URL + '/ajax/episodes/' + animeID + '/' + page,
            { _token: csrf },
            { Referer: url }
          );
          const nd = JSON.parse(await nres.text());
          if (!nd.data || !nd.data.length) break;
          for (var ni = 0; ni < nd.data.length; ni++) {
            addEp(nd.data[ni].number, MAIN_URL + '/' + slug + '/' + nd.data[ni].number, null, nd.data[ni].title);
          }
          if (!nd.next_page_url && !nd.nextPageurl) break;
          page++;
          if (page > 40) break;
        } catch (_) { break; }
      }
    } catch (_) {}
  }

  // 3) Fallback: texto "Episodios: N"
  if (!episodes.length) {
    const epCountM = html.match(/Episodios:\s*<\/span>\s*(\d+)/i) || html.match(/Episodios:\s*(\d+)/i);
    const total = epCountM ? parseInt(epCountM[1], 10) : 0;
    if (total > 0 && slug) {
      for (var e = 1; e <= total; e++) addEp(e, MAIN_URL + '/' + slug + '/' + e);
    }
  }

  episodes.sort(function (a, b) { return a.number - b.number; });

  const contentType = getAnimeType(typeText || '');
  if (contentType === 'movie' && episodes.length <= 1) {
    return {
      id: url.replace(/\/$/, ''),
      title: title,
      poster: poster,
      backdrop: poster,
      overview: overview,
      type: 'movie',
      year: year,
      genres: genres,
      url: url.replace(/\/$/, ''),
    };
  }

  return {
    id: url.replace(/\/$/, ''),
    title: title,
    poster: poster,
    backdrop: poster,
    overview: overview,
    type: 'series',
    year: year,
    genres: genres,
    seasons: [{
      number: 1,
      name: 'Temporada 1',
      episodes: episodes,
    }],
    url: url.replace(/\/$/, ''),
  };
}

// ─── STREAMS ────────────────────────────────────────────────────────────────

function rewriteEmbed(u) {
  if (!u) return u;
  return String(u)
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
}

async function resolvePlayerPage(iframeSrc, label) {
  try {
    const res = await httpGet(fixUrl(iframeSrc), { Referer: MAIN_URL + '/' });
    const html = await res.text();
    // Desu / DPlayer
    var m = html.match(/url:\s*['"]([^'"]+)['"]/);
    if (m && /\.m3u8|\.mp4/i.test(m[1])) return { url: m[1], name: label || 'Desu' };
    // source tag
    m = html.match(/<source[^>]+src=['"]([^'"]+)['"]/i);
    if (m) return { url: m[1], name: label || 'Player' };
    // m3u8 genérico
    m = html.match(/(https?:\/\/[^\s"'\\]+\.m3u8[^\s"'\\]*)/i);
    if (m) return { url: m[1], name: label || 'HLS' };
    // mp4
    m = html.match(/(https?:\/\/[^\s"'\\]+\.mp4[^\s"'\\]*)/i);
    if (m) return { url: m[1], name: label || 'MP4' };
  } catch (_) {}
  return null;
}

async function getStreams(id, type, season, episode) {
  var dataUrl = String(id);
  if (dataUrl.indexOf('http') !== 0) dataUrl = MAIN_URL + (dataUrl.startsWith('/') ? dataUrl : '/' + dataUrl);
  if (!/\/\d+\/?$/.test(dataUrl) && episode) {
    dataUrl = dataUrl.replace(/\/$/, '') + '/' + episode + '/';
  }

  const streams = [];
  const headersBase = { 'User-Agent': UA, Referer: MAIN_URL + '/' };

  function push(name, url, extra) {
    if (!url) return;
    url = String(url).trim();
    if (!url) return;
    const isHls = /\.m3u8/i.test(url);
    streams.push({
      url: url,
      name: name || 'JKAnime',
      quality: (extra && extra.quality) || 'auto',
      language: 'es',
      provider: 'jkanime',
      headers: Object.assign({}, headersBase, (extra && extra.headers) || {}),
      isHls: isHls,
      subtitles: [],
    });
  }

  const res = await httpGet(dataUrl);
  const html = await res.text();

  // 1) video[n] = '<iframe src="...">'  → Desu / Magi
  const videoRe = /video\[(\d+)\]\s*=\s*['"]<iframe[^>]*?src=["']([^"']+)["']/gi;
  var vm;
  const playerJobs = [];
  while ((vm = videoRe.exec(html)) !== null) {
    const idx = vm[1];
    const src = fixUrl(vm[2]);
    const label = idx === '0' ? 'Desu' : idx === '1' ? 'Magi' : 'Video ' + idx;
    playerJobs.push(resolvePlayerPage(src, label).then(function (r) {
      if (r) push(r.name, r.url, { headers: { Referer: MAIN_URL + '/' } });
    }));
  }
  await Promise.all(playerJobs);

  // 2) var servers = [ { server, remote } ]
  var serversList = null;
  const sm = html.match(/var\s+servers\s*=\s*(\[[\s\S]*?\]);/);
  if (sm) {
    try { serversList = JSON.parse(sm[1]); } catch (_) {
      // regex remote fields
      serversList = [];
      const rr = /"remote"\s*:\s*"([^"]+)"/g;
      var rm;
      while ((rm = rr.exec(sm[1])) !== null) serversList.push({ remote: rm[1], server: 'Server' });
    }
  }
  // también regex cloudstream
  if (!serversList || !serversList.length) {
    const sre = /\[\s*\{[\s\S]*?"remote"[\s\S]*?\}\s*\]/;
    const srm = html.match(sre);
    if (srm) {
      try { serversList = JSON.parse(srm[0]); } catch (_) {}
    }
  }

  if (serversList && Array.isArray(serversList)) {
    for (var i = 0; i < serversList.length; i++) {
      const s = serversList[i];
      if (!s || !s.remote) continue;
      const name = s.server || s.name || 'Server';
      if (/mediafire|mega/i.test(name)) continue;
      var decoded = base64Decode(s.remote).trim();
      decoded = rewriteEmbed(decoded);
      if (!decoded) continue;

      // URL directa
      if (/\.m3u8|\.mp4|googlevideo|okcdn|mycdn/i.test(decoded)) {
        push(name, decoded, { headers: { Referer: MAIN_URL + '/' } });
        continue;
      }

      // um2 → Nozomi
      if (/um2\.php/i.test(decoded)) {
        try {
          const dres = await httpGet(decoded, { Referer: dataUrl });
          const dhtml = await dres.text();
          const keyM = dhtml.match(/<input[^>]+value=["']([^"']+)["']/i);
          if (keyM) {
            const postRes = await fetch(MAIN_URL + '/gsplay/redirect_post.php', {
              method: 'POST',
              headers: Object.assign({}, DEFAULT_HEADERS, {
                'Content-Type': 'application/x-www-form-urlencoded',
                Referer: decoded,
                Origin: MAIN_URL,
              }),
              body: 'data=' + encodeURIComponent(keyM[1]),
              redirect: 'manual',
            });
            var loc = null;
            try { loc = postRes.headers.get('location') || postRes.headers.get('Location'); } catch (_) {}
            if (loc) {
              const postkey = String(loc).replace(/.*#/, '');
              const apiRes = await httpPost(MAIN_URL + '/gsplay/api.php', { v: postkey }, {
                'X-Requested-With': 'XMLHttpRequest', Origin: MAIN_URL, Referer: MAIN_URL + '/',
              });
              const j = JSON.parse(await apiRes.text());
              if (j.file) push('Nozomi', j.file);
            }
          }
        } catch (_) {}
        continue;
      }

      // /um.php → Desu m3u8
      if (/\/um\.php|\/um\?/i.test(decoded) && !/um2/i.test(decoded)) {
        try {
          const dres = await httpGet(decoded, { Referer: dataUrl });
          const dhtml = await dres.text();
          const m3 = dhtml.match(/(https?:\/\/[^\s"'\\]+\.m3u8[^\s"'\\]*)/i);
          if (m3) push('Desu', m3[1], { headers: { Referer: MAIN_URL + '/' } });
          else {
            const resolved = await resolvePlayerPage(decoded, 'Desu');
            if (resolved) push(resolved.name, resolved.url);
          }
        } catch (_) {}
        continue;
      }

      // jkmedia redirect
      if (/jkmedia/i.test(decoded)) {
        try {
          const xres = await fetch(decoded, {
            method: 'GET',
            headers: Object.assign({}, DEFAULT_HEADERS, { Referer: dataUrl }),
            redirect: 'manual',
          });
          var xloc = null;
          try { xloc = xres.headers.get('location') || xres.headers.get('Location'); } catch (_) {}
          if (xloc) push('Xtreme S', xloc);
        } catch (_) {}
        continue;
      }

      // Intentar resolver página del embed
      if (/streamwish|filemoon|vidhide|mixdrop|ok\.ru|embedsito|mp4upload|voe|dood|streamtape/i.test(decoded)) {
        const resolved = await resolvePlayerPage(decoded, name);
        if (resolved) {
          push(name, resolved.url, { headers: { Referer: decoded } });
        } else {
          // Devolver embed para que stream_proxy de la app intente
          push(name + ' (embed)', decoded, { headers: { Referer: MAIN_URL + '/' } });
        }
        continue;
      }

      // genérico
      push(name, decoded, { headers: { Referer: MAIN_URL + '/' } });
    }
  }

  // 3) m3u8 sueltos en HTML
  const direct = html.match(/https?:\/\/[^\s"'\\]+\.m3u8[^\s"'\\]*/gi) || [];
  for (var d = 0; d < direct.length; d++) push('JKAnime HLS', direct[d]);

  // dedup
  const seen = new Set();
  return streams.filter(function (s) {
    if (!s.url || seen.has(s.url)) return false;
    seen.add(s.url);
    return true;
  });
}

async function getDiscover() { return { items: [], hasMore: false, page: 1 }; }
async function getDiscoverFilters() { return []; }

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
