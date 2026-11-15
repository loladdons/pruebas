/**
 * OKRu – addon JS para ContentService (Flutter)
 * Adaptado del plugin Cloudstream OKRU (@ByAyzen)
 *
 * Tabs: home | search | library | settings  (sin discover)
 * Config: appendVose (boolean) → si está activo, a cada búsqueda se añade " vose"
 *
 * Métodos: getHome, getCatalogs, getCatalog, search, getMeta, getStreams, getNews
 */

const MAIN_URL = 'https://ok.ru';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const DEFAULT_HEADERS = {
  'User-Agent': UA,
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'ru-RU,ru;q=0.9,es-ES;q=0.8,en;q=0.7',
  Referer: MAIN_URL + '/',
};

/** Secciones del home (equivalente a mainPage de Cloudstream) */
const CATALOGS = [
  { id: 'showcase', title: 'Videos', path: '/video/showcase', type: 'movie' },
  { id: 'soviet', title: 'Soviet', path: '/video/kino/soviet', type: 'movie' },
  { id: 'drama', title: 'Drama', path: '/video/kino/drama', type: 'movie' },
  { id: 'action', title: 'Action', path: '/video/kino/action', type: 'movie' },
  { id: 'family', title: 'Family', path: '/video/kino/family', type: 'movie' },
  { id: 'comedy', title: 'Comedy', path: '/video/kino/comedy', type: 'movie' },
  { id: 'serial', title: 'Series', path: '/video/serial', type: 'series' },
];

// ─── config del usuario (RepoConfigField → userConfig) ───────────────────────

function getUserConfig() {
  try {
    const c =
      (typeof globalThis !== 'undefined' &&
        globalThis.__nuvioConfig &&
        (globalThis.__nuvioConfig.current || globalThis.__nuvioConfig['okru'])) ||
      {};
    return c && typeof c === 'object' ? c : {};
  } catch (_) {
    return {};
  }
}

/** true si el usuario activó "Añadir VOSE a búsquedas" */
function shouldAppendVose() {
  const c = getUserConfig();
  const v = c.appendVose ?? c.append_vose ?? c.vose;
  if (v === true || v === 'true' || v === '1' || v === 'yes' || v === 'on') return true;
  return false;
}

// ─── HTTP ───────────────────────────────────────────────────────────────────

async function httpGet(url, headers = {}) {
  const res = await fetch(url, {
    method: 'GET',
    headers: { ...DEFAULT_HEADERS, ...headers },
  });
  if (!res.ok) throw new Error('GET ' + url + ' → ' + res.status);
  return res;
}

async function httpPost(url, body, headers = {}) {
  const isPlainObject =
    body !== null && typeof body === 'object' && !(body instanceof URLSearchParams);
  let payload;
  let contentType;
  if (isPlainObject) {
    payload = new URLSearchParams(body).toString();
    contentType = 'application/x-www-form-urlencoded; charset=UTF-8';
  } else if (typeof body === 'string') {
    payload = body;
    contentType = 'text/plain;charset=UTF-8';
  } else {
    payload = String(body);
    contentType = 'text/plain;charset=UTF-8';
  }
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      ...DEFAULT_HEADERS,
      'Content-Type': contentType,
      'X-Requested-With': 'XMLHttpRequest',
      'ok-screen': 'anonymVideo',
      ...headers,
    },
    body: payload,
  });
  if (!res.ok) throw new Error('POST ' + url + ' → ' + res.status);
  return res;
}

function fixUrl(href) {
  if (!href) return '';
  href = String(href)
    .replace(/\\u0026/g, '&')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"');
  if (href.startsWith('//')) return 'https:' + href;
  if (href.startsWith('/')) return MAIN_URL + href;
  return href;
}

function extractVideoId(urlOrId) {
  if (!urlOrId) return null;
  const s = String(urlOrId);
  const m = s.match(/video(?:embed)?\/(\d+)/i) || s.match(/^(\d+)$/);
  return m ? m[1] : null;
}

// ─── parsers ────────────────────────────────────────────────────────────────

function parseVideoCards(html) {
  const items = [];
  const blocks = html.split(/class="[^"]*video-card[^"]*"/i);
  for (let i = 1; i < blocks.length; i++) {
    const block = blocks[i];
    const idMatch = block.match(/data-id="(\d+)"/i) || block.match(/video\/(\d+)/i);
    const titleMatch =
      block.match(/video-card_n[^>]*>([^<]+)</i) ||
      block.match(/alt="([^"]+)"/i) ||
      block.match(/aria-label="([^"]+)"/i);
    const hrefMatch = block.match(/href="(\/video\/[^"?]+)/i);
    const imgMatch = block.match(
      /src="(https?:\/\/[^"]+okcdn[^"]+|\/\/[^"]+okcdn[^"]+|https?:\/\/i\.mycdn[^"]+)"/i
    );

    const id = idMatch ? idMatch[1] : null;
    if (!id && !hrefMatch) continue;

    const title = (titleMatch ? titleMatch[1] : '')
      .trim()
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, '&');
    if (!title) continue;

    const href = hrefMatch ? fixUrl(hrefMatch[1]) : MAIN_URL + '/video/' + id;
    const poster = imgMatch ? fixUrl(imgMatch[1]) : '';

    items.push({
      id: String(id || extractVideoId(href)),
      title,
      poster: poster || null,
      backdrop: poster || null,
      type: 'movie',
      url: href,
    });
  }

  const seen = new Set();
  return items.filter(function (it) {
    if (!it.id || seen.has(it.id)) return false;
    seen.add(it.id);
    return true;
  });
}

function parseSerialSliders(html) {
  const items = [];
  const sliderRe = /<video-channels-vitrine-slider[^>]*data-props="([^"]+)"/gi;
  let m;
  while ((m = sliderRe.exec(html)) !== null) {
    const props = m[1]
      .replace(/&quot;/g, '"')
      .replace(/\\u0026/g, '&')
      .replace(/&amp;/g, '&');
    const entryRe =
      /\{"id":"([^"]*)"[^}]*?"href":"([^"]*)"[^}]*?"name":"([^"]*)"[^}]*?"imageUrl":"([^"]*)"/g;
    let em;
    while ((em = entryRe.exec(props)) !== null) {
      const href = fixUrl(em[2]);
      const name = em[3].replace(/\\"/g, '"');
      const poster = fixUrl(em[4]);
      const id = em[1] || extractVideoId(href) || href;
      items.push({
        id: String(id),
        title: name,
        poster: poster || null,
        backdrop: poster || null,
        type: 'series',
        url: href,
      });
    }
  }
  const seen = new Set();
  return items.filter(function (it) {
    if (!it.id || seen.has(it.id)) return false;
    seen.add(it.id);
    return true;
  });
}

/** ContentItem compatible con ContentItem.fromJson */
function toContentItem(raw) {
  return {
    id: String(raw.id),
    title: raw.title || 'Sin título',
    poster: raw.poster || null,
    backdrop: raw.backdrop || raw.poster || null,
    type: raw.type || 'movie',
    overview: raw.overview || null,
    year: raw.year || null,
    rating: raw.rating != null ? Number(raw.rating) : null,
    genres: Array.isArray(raw.genres) ? raw.genres : [],
    url: raw.url || MAIN_URL + '/video/' + raw.id,
  };
}

// ─── catálogo / home ────────────────────────────────────────────────────────

async function fetchCatalogPage(catalog, page) {
  page = page || 1;
  const path = catalog.path || '/video/' + catalog.id;
  const isSerial = path.indexOf('serial') !== -1;
  const isShowcase = path.indexOf('showcase') !== -1;
  const tag = path.substring(path.lastIndexOf('/') + 1);

  let html;
  if (page <= 1) {
    const res = await httpGet(MAIN_URL + path);
    html = await res.text();
  } else {
    var postUrl;
    if (isShowcase) {
      postUrl =
        MAIN_URL +
        '/video/showcase?st.cmd=anonymVideo&st.m=SHOWCASE&st.ft=showcase&st.furl=%2Fvideo%2Fshowcase&cmd=VideoUniversalContentBlock';
    } else {
      const ft = isSerial
        ? 'serial'
        : path.substring(0, path.lastIndexOf('/')).split('/').pop();
      postUrl =
        MAIN_URL +
        path.substring(0, path.lastIndexOf('/')) +
        '?st.cmd=anonymVideo&st.fltag=' +
        tag +
        '&st.m=ALBUMS_CATALOG&st.ft=' +
        ft +
        '&st.furl=' +
        path +
        '&cmd=VideoUniversalContentBlock';
    }
    const lastElement = isShowcase ? '18' : '1669805881145';
    const res = await httpPost(
      postUrl,
      {
        fetch: 'false',
        'st.page': String(page),
        'st.lastelem': lastElement,
        'gwt.requested': '9579ea2eT1774883610506',
      },
      { 'ok-screen': 'anonymVideo' }
    );
    html = await res.text();
  }

  const rawItems = isSerial ? parseSerialSliders(html) : parseVideoCards(html);
  const items = rawItems.map(toContentItem);
  return {
    items: items,
    hasMore: items.length >= 12,
    page: page,
  };
}

// ─── API pública ────────────────────────────────────────────────────────────

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
    }) || {
      id: catalogId,
      path: '/video/' + catalogId,
      title: catalogId,
    };
  return fetchCatalogPage(catalog, page);
}

/**
 * getHome([opts])
 * - structureOnly / lightweight → solo esqueleto (carga progresiva)
 * - rowId / catalogId / id + page → una fila
 * - sin args → home completo (legado)
 */
async function getHome(opts) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const structureOnly = o.structureOnly === true || o.lightweight === true;
  const page = o.page || 1;
  const rowId = o.rowId || o.catalogId || o.id;

  if (rowId) {
    const catalog =
      CATALOGS.find(function (c) {
        return c.id === rowId;
      }) || {
        id: rowId,
        path: '/video/' + rowId,
        title: rowId,
      };
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
    return CATALOGS.map(function (c) {
      return {
        id: c.id,
        title: c.title,
        type: 'row',
        items: [],
        catalogId: c.id,
        imageStyle: 'poster',
      };
    });
  }

  const rows = [];
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
    const page = await fetchCatalogPage(CATALOGS[0], 1);
    return page.items.slice(0, 20);
  } catch (_) {
    return [];
  }
}

/**
 * search(query)
 * Si appendVose está activo en config del repo → query + " vose"
 */
async function search(query) {
  if (!query || !String(query).trim()) return [];

  var q = String(query).trim();
  if (shouldAppendVose()) {
    if (!/\bvose\b/i.test(q)) {
      q = q + ' vose';
    }
  }

  try {
    const res = await httpPost(
      MAIN_URL +
        '/video/search?st.cmd=video&st.psft=showcase&st.m=SEARCH&st.ft=search&st.fuvh=on&st.furl=%2Fvideo%2Fshowcase&cmd=VideoContentBlock',
      {
        'st.v.sq': q,
        'gwt.requested': '9579ea2eT1774883610506',
      }
    );
    const html = await res.text();

    const propsMatch = html.match(/<video-search-result[^>]*data-props="([^"]+)"/i);
    if (propsMatch) {
      var jsonStr = propsMatch[1]
        .replace(/&quot;/g, '"')
        .replace(/\\u0026/g, '&')
        .replace(/&amp;/g, '&');
      try {
        const data = JSON.parse(jsonStr);
        const list = (data.videos && data.videos.list) || data.list || [];
        const out = list
          .map(function (item) {
            const movie = item.movie || item;
            const id = movie.id || item.id;
            if (!id) return null;
            const title = movie.title || item.name || item.title;
            const poster =
              (movie.thumbnail && (movie.thumbnail.big || movie.thumbnail.small)) ||
              item.imageUrl ||
              null;
            return toContentItem({
              id: id,
              title: title,
              poster: poster ? fixUrl(poster) : null,
              type: 'movie',
              url: MAIN_URL + '/video/' + id,
            });
          })
          .filter(Boolean);
        if (out.length) return out;
      } catch (_) {}
    }

    return parseVideoCards(html).map(toContentItem);
  } catch (_) {
    try {
      const body = JSON.stringify({
        id: 1,
        parameters: {
          displayMode: 'Movie',
          videosOffset: 0,
          channelsOffset: 0,
          searchQuery: q,
          currentStateId: 'video',
          durationType: 'ANY',
          hd: false,
        },
      });
      const res = await httpPost(MAIN_URL + '/web-api/v2/video/fetchSearchResult', body, {
        Accept: 'application/json, text/javascript, */*; q=0.01',
        'ok-screen': 'anonymVideo',
        'x-client-flags': 'ms:0;dcss:0;mpv2:1;dz:0',
      });
      const text = await res.text();
      const data = JSON.parse(text);
      const list = (data.result && data.result.videos && data.result.videos.list) || [];
      return list
        .map(function (item) {
          const movie = item.movie || item;
          const id = movie.id;
          if (!id) return null;
          return toContentItem({
            id: id,
            title: movie.title || item.name,
            poster: movie.thumbnail
              ? fixUrl(movie.thumbnail.big || movie.thumbnail.small)
              : item.imageUrl
                ? fixUrl(item.imageUrl)
                : null,
            type: 'movie',
          });
        })
        .filter(Boolean);
    } catch (_) {
      return [];
    }
  }
}

/**
 * getMeta(id) | getMeta(id, { season, episode })
 */
async function getMeta(id, opts) {
  opts = opts || {};
  const videoId = extractVideoId(id) || String(id);
  const url = MAIN_URL + '/video/' + videoId;
  const res = await httpGet(url);
  const html = await res.text();

  const title =
    (html.match(/property="og:title"\s+content="([^"]+)"/i) || [])[1] ||
    (html.match(/<title>([^<]+)<\/title>/i) || [])[1] ||
    'Video ' + videoId;

  const poster =
    (html.match(/property="og:image"\s+content="([^"]+)"/i) || [])[1] || null;

  const overview =
    (html.match(/property="og:description"\s+content="([^"]+)"/i) || [])[1] || null;

  const durationSec = parseInt(
    (html.match(/property="video:duration"\s+content="(\d+)"/i) || [])[1] || '0',
    10
  );
  const author =
    (html.match(/property="ya:ovs:login"\s+content="([^"]+)"/i) || [])[1] || null;

  const isAlbum = /\/video\/c\d+/.test(url) || html.indexOf('album-info_name') !== -1;

  const recs = [];
  const recBlocks = html.split(/recommendations_block_reco-content_item/i);
  for (var i = 1; i < Math.min(recBlocks.length, 20); i++) {
    const b = recBlocks[i];
    const href = (b.match(/href="(\/video\/\d+)/i) || [])[1];
    const t =
      (b.match(/recommendations_block_card-title[^>]*>([^<]+)/i) || [])[1] ||
      (b.match(/alt="([^"]+)"/i) || [])[1];
    const img = (b.match(/src="(https?:\/\/[^"]+)"/i) || [])[1];
    if (href && t) {
      const rid = extractVideoId(href);
      recs.push(
        toContentItem({
          id: rid,
          title: t.trim(),
          poster: img ? fixUrl(img) : null,
          type: 'movie',
        })
      );
    }
  }

  if (isAlbum) {
    const episodes = [];
    const cards = parseVideoCards(html);
    cards.forEach(function (c, idx) {
      episodes.push({
        number: idx + 1,
        id: String(c.id),
        title: c.title,
        still: c.poster,
      });
    });

    const aidMatch = url.match(/\/video\/c(\d+)/) || html.match(/st\.aid=c(\d+)/);
    if (aidMatch) {
      const aid = aidMatch[1];
      var page = 1;
      var lelem = (html.match(/data-last-element="([^"]+)"/i) || [])[1] || null;
      while (page < 8 && lelem) {
        page++;
        try {
          const pres = await httpPost(
            MAIN_URL +
              '/video/c' +
              aid +
              '?st.cmd=anonymVideo&st.m=ALBUM&st.ft=album&st.aid=c' +
              aid +
              '&cmd=VideoAlbumBlock',
            {
              fetch: 'false',
              'st.page': String(page),
              'st.lastelem': lelem,
            },
            { Referer: url }
          );
          const phtml = await pres.text();
          const more = parseVideoCards(phtml);
          if (!more.length) break;
          more.forEach(function (c) {
            episodes.push({
              number: episodes.length + 1,
              id: String(c.id),
              title: c.title,
              still: c.poster,
            });
          });
          lelem = (phtml.match(/data-last-element="([^"]+)"/i) || [])[1] || null;
        } catch (_) {
          break;
        }
      }
    }

    const uniqueEps = [];
    const seen = new Set();
    for (var ei = 0; ei < episodes.length; ei++) {
      const e = episodes[ei];
      if (seen.has(e.id)) continue;
      seen.add(e.id);
      uniqueEps.push(e);
    }

    const cleanTitle = title.replace(/\s*[|\-].*$/, '').trim();

    if (uniqueEps.length <= 1) {
      return {
        id: videoId,
        title: cleanTitle,
        poster: poster ? fixUrl(poster) : (uniqueEps[0] && uniqueEps[0].still) || null,
        backdrop: poster ? fixUrl(poster) : null,
        overview: overview,
        type: 'movie',
        duration: durationSec ? Math.round(durationSec / 60) : null,
        genres: author ? [author] : [],
        recommendations: recs,
      };
    }

    return {
      id: videoId,
      title: cleanTitle,
      poster: poster ? fixUrl(poster) : (uniqueEps[0] && uniqueEps[0].still) || null,
      backdrop: poster ? fixUrl(poster) : null,
      overview: overview,
      type: 'series',
      genres: author ? [author] : [],
      seasons: [
        {
          number: 1,
          name: 'Temporada 1',
          episodes: uniqueEps.map(function (e, i) {
            return {
              number: i + 1,
              id: e.id,
              title: e.title || 'Episodio ' + (i + 1),
              still: e.still || null,
            };
          }),
        },
      ],
      recommendations: recs,
    };
  }

  return {
    id: videoId,
    title: title.replace(/\s*[|\-].*$/, '').trim(),
    poster: poster ? fixUrl(poster) : null,
    backdrop: poster ? fixUrl(poster) : null,
    overview: overview,
    type: 'movie',
    duration: durationSec ? Math.round(durationSec / 60) : null,
    genres: author ? [author] : [],
    recommendations: recs,
  };
}

/**
 * getStreams(id, type?, season?, episode?)
 * Formato StreamServer.fromJson:
 *   { url, name, quality, language, headers, isHls, subtitles[], provider }
 */
async function getStreams(id, type, season, episode) {
  const videoId = extractVideoId(id) || String(id);
  if (!videoId) return [];

  const streams = [];
  const streamHeaders = {
    'User-Agent': UA,
    Referer: MAIN_URL + '/',
    Origin: MAIN_URL,
  };

  function pushVideos(videos, source) {
    if (!Array.isArray(videos)) return;
    for (var i = 0; i < videos.length; i++) {
      const v = videos[i];
      if (!v || !v.url) continue;
      const q = String(v.name || v.quality || v.type || '').toLowerCase();
      var quality = 'auto';
      if (q.indexOf('full') !== -1 || q.indexOf('1080') !== -1 || (v.height && v.height >= 1080))
        quality = '1080p';
      else if (q.indexOf('hd') !== -1 || q.indexOf('720') !== -1 || (v.height && v.height >= 720))
        quality = '720p';
      else if (q.indexOf('sd') !== -1 || q.indexOf('480') !== -1 || (v.height && v.height >= 480))
        quality = '480p';
      else if (
        q.indexOf('mobile') !== -1 ||
        q.indexOf('360') !== -1 ||
        q.indexOf('low') !== -1 ||
        (v.height && v.height >= 360)
      )
        quality = '360p';
      else if (v.height) quality = v.height + 'p';

      const url = String(v.url);
      const isHls = url.indexOf('.m3u8') !== -1 || /hls|m3u8/i.test(String(v.type || ''));

      streams.push({
        url: url,
        name: 'OKRu ' + quality,
        quality: quality,
        language: 'ru',
        provider: source || 'okru',
        headers: streamHeaders,
        isHls: isHls,
        subtitles: [],
      });
    }
  }

  // 1) Metadata API
  try {
    const res = await httpPost(
      'https://www.ok.ru/dk?cmd=videoPlayerMetadata',
      { mid: videoId },
      { Origin: MAIN_URL, Referer: MAIN_URL + '/' }
    );
    const meta = await res.json();
    if (meta) {
      pushVideos(meta.videos, 'okru-api');
      try {
        const subsRaw =
          (meta.movie && meta.movie.subtitles) || meta.subtitles || [];
        if (Array.isArray(subsRaw) && streams.length) {
          const parsed = subsRaw
            .map(function (s) {
              if (!s) return null;
              if (typeof s === 'string') {
                return { lang: 'und', label: 'Sub', url: s };
              }
              const u = s.url || s.src || s.file;
              if (!u) return null;
              return {
                lang: s.lang || s.language || s.idioma || 'und',
                label: s.label || s.name || s.title || s.lang || 'Sub',
                url: String(u),
                format: s.format || s.type || undefined,
              };
            })
            .filter(Boolean);
          if (parsed.length) {
            streams.forEach(function (s) {
              s.subtitles = parsed;
            });
          }
        }
      } catch (_) {}
    }
  } catch (_) {}

  // 2) Fallback embed
  if (streams.length === 0) {
    try {
      const embedUrl = MAIN_URL + '/videoembed/' + videoId;
      const res = await httpGet(embedUrl);
      const html = await res.text();

      const optMatch =
        html.match(/data-options=(["'])(\{[\s\S]*?\})\1/i) ||
        html.match(/data-options="(\{[^"]+\})"/i);
      if (optMatch) {
        var optStr = (optMatch[2] || optMatch[1])
          .replace(/&quot;/g, '"')
          .replace(/&amp;/g, '&')
          .replace(/\\u0026/g, '&');
        const player = JSON.parse(optStr);
        var metadata = null;

        if (player.flashvars && player.flashvars.metadata) {
          metadata =
            typeof player.flashvars.metadata === 'string'
              ? JSON.parse(player.flashvars.metadata)
              : player.flashvars.metadata;
        } else if (player.flashvars && player.flashvars.metadataUrl) {
          const metaUrl = decodeURIComponent(player.flashvars.metadataUrl);
          const mres = await httpPost(metaUrl, {
            'st.location': player.flashvars.location || '',
          });
          metadata = await mres.json();
        }

        if (metadata) {
          pushVideos(metadata.videos, 'okru-embed');
        }
      }
    } catch (_) {}
  }

  const order = { '1080p': 4, '720p': 3, '480p': 2, '360p': 1, auto: 0 };
  streams.sort(function (a, b) {
    return (order[b.quality] || 0) - (order[a.quality] || 0);
  });

  const seen = new Set();
  return streams.filter(function (s) {
    if (!s.url || seen.has(s.url)) return false;
    seen.add(s.url);
    return true;
  });
}

// Descubrir deshabilitado (tabs sin discover)
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
