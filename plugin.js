/*
 * Magis Service Catalog - optimizado + fixes:
 *  - Discover: filtros tipo + categoría funcionan juntos (no solo el primero)
 *  - Episodios de otras temporadas: resuelve contentId real del capítulo
 *  - Subtítulos: extrae todos los tracks del play response para el player
 *
 * Perf (Home / Buscar / Descubrir) — sin cambiar la extracción de datos Magis:
 *  - Home: homeRows de movies/series/anime en paralelo
 *  - Descubrir: ROOT directo si no hay categoría; menos beans getShelveData;
 *    pageSize bajo en filtros; posters (imageStyle poster) no banner
 *  - Caché TTL un poco más larga en home/discover
 *  - TMDB opcional (config.tmdbApiKey): solo stills de capítulos ya listados por Magis
 */
'use strict';

const ADDON_ID = 'magis-service-catalog';
const DEFAULTS = {
  hosts: 'sqacjy.s5lm5aydc.xyz,osuhk.m3x8o50te.com',
  scheme: 'https',
  appId: 'com.android.msandroid',
  apkVersion: '49902',
  desKeyHex: 'e7af1ed7de1ffddd7bd3fe37ebdffde9ef3fe1ae39edfeb8',
  newsLimit: '12',
  // Opcional: clave TMDB (solo enriquece stills de capítulos / posters si falta). Sin clave no hace nada.
  tmdbApiKey: ''
};
const API_VERSION = '43404';
const SPKG_VERSION = '2025-08-07 05:40:11_36_16_';
const PORTAL_CODE = 'masnew';
const SN_SALT = 'ntFT65w6itH!lHCPw7D=@qnsFC5adD28';
const FIXED_MAC = '02:00:00:00:00:00';
const HOME = { movies: 'masnew_movies', series: 'masnew_series', anime: 'masnew_anime', featured: 'masnew_featured' };
const ROOT = { movies: '76263', series: '76235', anime: '76209' };

let session = null;
let sessionPromise = null;
let preferredHost = null;
let lastCallAt = 0;
let rateQueue = Promise.resolve();

const MAX_CACHE = 120;
const MAX_MAP = 500;

const responseCache = new Map();
const inFlight = new Map();
const categoryKinds = new Map();
const itemKinds = new Map();
// parentSeriesId:season:episode -> episode contentId
const episodeContentIds = new Map();
// episode contentId -> parent series contentId
const episodeParent = new Map();
// parentSeriesId:seasonNumber -> contentId de esa temporada en Magis
const seasonContentIds = new Map();
// episode contentId -> contentId de su temporada (startPlayVOD.seriesContentId)
const episodeSeasonId = new Map();
// categoryId -> { items, kind, title }  (estilo Kino: assetList de getNextColumns)
const categoryItemsCache = new Map();

const CACHE_TTL = {
  getHome: 8 * 60e3,
  getNextColumns: 8 * 60e3,
  'v3/getShelveData': 3 * 60e3,
  'v3/getRecommends': 8 * 60e3,
  'v3/searchByName': 30e3,
  'v4/getItemData': 6 * 60e3,
  'v14/getSlbInfo': 8 * 60e3
};

function limitMap(map, max) {
  while (map.size > max) {
    const first = map.keys().next().value;
    map.delete(first);
  }
}

function cacheKey(path, bean) {
  return path + ':' + JSON.stringify(bean || {});
}

async function cached(key, ttl, work) {
  const now = Date.now();
  const hit = responseCache.get(key);
  if (hit && hit.expires > now) return hit.value;
  if (hit) responseCache.delete(key);
  if (inFlight.has(key)) return inFlight.get(key);

  const task = Promise.resolve()
    .then(work)
    .then(value => {
      if (ttl > 0) {
        responseCache.set(key, { value, expires: Date.now() + ttl });
        limitMap(responseCache, MAX_CACHE);
      }
      return value;
    })
    .finally(() => inFlight.delete(key));

  inFlight.set(key, task);
  return task;
}

function timeoutError(e) {
  const m = String(e && (e.name || e.message) || e).toLowerCase();
  return m.includes('abort') || m.includes('timeout');
}

async function rateTurn() {
  let release;
  const previous = rateQueue;
  rateQueue = new Promise(resolve => { release = resolve; });
  await previous;
  try {
    const wait = Math.max(0, 300 - (Date.now() - lastCallAt));
    if (wait) await new Promise(r => setTimeout(r, wait));
    lastCallAt = Date.now();
  } finally {
    release();
  }
}

function config() {
  let supplied = {};
  try {
    const all = globalThis.__nuvioConfig || {};
    supplied = all[ADDON_ID] || all.current || {};
  } catch (_) {}
  const c = Object.assign({}, DEFAULTS, supplied);
  c.hosts = String(c.hosts || DEFAULTS.hosts).split(/[,;\s]+/).map(s => s.trim()).filter(Boolean);
  c.scheme = String(c.scheme || 'https').replace(':', '');
  return c;
}

function cryptoJS() {
  if (typeof CryptoJS === 'undefined' || !CryptoJS.TripleDES) {
    throw new Error('CryptoJS no está disponible en el runtime');
  }
  return CryptoJS;
}

function encryptBody(value) {
  const c = config(), C = cryptoJS();
  const key = C.enc.Hex.parse(c.desKeyHex);
  const encrypted = C.TripleDES.encrypt(String(value), key, {
    mode: C.mode.ECB,
    padding: C.pad.Pkcs7
  });
  const b64 = encrypted.ciphertext.toString(C.enc.Base64);
  return C.enc.Utf8.parse(b64).toString(C.enc.Hex);
}

function decryptBlob(wire) {
  const C = cryptoJS();
  const b64 = C.enc.Utf8.stringify(C.enc.Hex.parse(String(wire)));
  const params = C.lib.CipherParams.create({ ciphertext: C.enc.Base64.parse(b64) });
  return C.TripleDES.decrypt(params, C.enc.Hex.parse(config().desKeyHex), {
    mode: C.mode.ECB,
    padding: C.pad.Pkcs7
  }).toString(C.enc.Utf8);
}

function randHex(n) {
  let out = '';
  for (let i = 0; i < n; i++) out += Math.floor(Math.random() * 256).toString(16).padStart(2, '0');
  return out;
}

function randMac() {
  return Array.from({ length: 6 }, () => Math.floor(Math.random() * 256).toString(16).padStart(2, '0')).join(':');
}

function md5(s) {
  return cryptoJS().MD5(String(s)).toString().toLowerCase();
}

function deviceDict(sn) {
  return {
    loginType: '2',
    appLanguage: 'en',
    apkVersion: config().apkVersion,
    sysVersion: SPKG_VERSION,
    appId: config().appId,
    hardwareInfo: 'ranchu',
    model: 'sdk_gphone64_arm64',
    product: 'sdk_gphone64_arm64',
    cpu: 'arm64-v8a',
    B29: '',
    reserve1: '',
    deviceToken: '',
    sn: sn || (session && session.sn) || '',
    drmId: '',
    sdkVer: 36
  };
}

function hardwareFingerprint() {
  return {
    androidId: randHex(8),
    board: 'goldfish_arm64',
    brand: 'google',
    cpuAbi: 'arm64-v8a',
    cpuId: randHex(8),
    device: 'emu64a',
    diskInfo: '8GB',
    display: 'sdk_gphone64_arm64',
    etheMac: randMac(),
    fingerprint: 'google/sdk_gphone64_arm64/emu64a:14/UE1A.230829.036/11228894:user/release-keys',
    gatewayMac: randMac(),
    hardware: 'ranchu',
    host: 'abfarm',
    manufacturer: 'Google',
    ramSize: '4GB',
    romSize: '8GB',
    serialNumber: randHex(8),
    tags: 'release-keys',
    verId: '',
    wifiMac: randMac()
  };
}

async function portal(path, bean, baseFields = true) {
  await rateTurn();
  const c = config();
  const body = Object.assign(
    {},
    baseFields ? { portalCode: PORTAL_CODE, userId: session?.userId || '', userToken: session?.userToken || '' } : {},
    bean || {},
    deviceDict()
  );
  const wire = encryptBody(JSON.stringify(body));
  let lastError = 'No se pudo conectar con los hosts configurados';
  const hosts = preferredHost ? [preferredHost, ...c.hosts.filter(h => h !== preferredHost)] : c.hosts;

  for (const host of hosts) {
    try {
      const opts = {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          apk: c.appId,
          apkVer: API_VERSION,
          spkgVer: SPKG_VERSION,
          'User-Agent': 'okhttp/3.12.12'
        },
        body: wire
      };
      if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
        opts.signal = AbortSignal.timeout(6500);
      }
      const response = await fetch(`${c.scheme}://${host}/api/portalCore/${path}`, opts);
      if (!response.ok) {
        lastError = `HTTP ${response.status}`;
        continue;
      }
      const json = await response.json();
      const code = String(json.returnCode ?? '');
      if (code && code !== '0') throw new Error(String(json.errorMessage || json.msg || `Portal ${code}`));
      preferredHost = host;
      let data = json.data;
      if (typeof data === 'string' && data) {
        try {
          data = JSON.parse(decryptBlob(data));
        } catch (_) {}
      }
      return data && typeof data === 'object' ? data : json;
    } catch (e) {
      lastError = String(e && e.message || e);
      if (timeoutError(e)) break;
    }
  }
  throw new Error(`${path}: ${lastError}`);
}

async function ensureSession() {
  if (session && session.userToken) return;
  if (sessionPromise) return sessionPromise;

  sessionPromise = (async () => {
    if (typeof CryptoJS === 'undefined') {
      throw new Error('El runtime no ha cargado CryptoJS; revisa que index.js incluya la palabra CryptoJS.');
    }
    const tokenResponse = await portal('v3/snToken', hardwareFingerprint(), false);
    const snToken = String(tokenResponse.snToken || '');
    if (!snToken) throw new Error('El servicio no devolvió snToken');
    const sn = String(tokenResponse.sn || md5(snToken + SN_SALT)).toLowerCase();
    session = { sn, userId: '', userToken: '', jwtToken: '' };
    const active = await portal('v8/active', {
      snToken,
      authVersion: '',
      authCode: '',
      preCode: '',
      macAddr: FIXED_MAC,
      reserve1: '',
      openNum: 4,
      channel: 'default',
      matadata: '',
      signdata: ''
    }, false);
    if (!active.userToken) {
      session = null;
      throw new Error('La activación no devolvió userToken');
    }
    session.userId = String(active.userId || '');
    session.userToken = String(active.userToken || '');
    session.jwtToken = String(active.jwtToken || '');
  })();

  try {
    await sessionPromise;
  } finally {
    sessionPromise = null;
  }
}

async function api(path, bean) {
  const ttl = CACHE_TTL[path] || 0;
  if (!ttl) {
    await ensureSession();
    return portal(path, bean, true);
  }
  return cached(cacheKey(path, bean), ttl, async () => {
    await ensureSession();
    return portal(path, bean, true);
  });
}

function listFrom(o, keys) {
  for (const k of keys) if (o && Array.isArray(o[k])) return o[k];
  if (o && o.data && typeof o.data === 'object' && o.data !== o) return listFrom(o.data, keys);
  if (o && o.result && typeof o.result === 'object' && o.result !== o) return listFrom(o.result, keys);
  return [];
}

function flattenItems(data, forcedType) {
  if (!data || typeof data !== 'object') return [];
  if (!Array.isArray(data) && data.data && typeof data.data === 'object' && !Array.isArray(data.assetList) && !Array.isArray(data.columnList)) {
    const nested = flattenItems(data.data, forcedType);
    if (nested.length) return nested;
  }
  if (!Array.isArray(data) && data.result && typeof data.result === 'object') {
    const nested = flattenItems(data.result, forcedType);
    if (nested.length) return nested;
  }
  if (Array.isArray(data)) {
    return data.filter(x => x && typeof x === 'object').map(x => normalizeItem(x, forcedType));
  }
  for (const key of ['assetList', 'itemList', 'contentList', 'movieList', 'programList', 'list', 'results', 'items']) {
    if (Array.isArray(data[key])) {
      return data[key].filter(x => x && typeof x === 'object').map(x => normalizeItem(x, forcedType));
    }
  }
  const groups = listFrom(data, ['searchItemList', 'recommendList', 'columnList', 'homeColumnList', 'rowList', 'columns', 'childColumnList', 'nextColumnList']);
  const out = [];
  for (const g of groups) {
    if (!g || typeof g !== 'object') continue;
    out.push(...flattenItems(g, forcedType));
  }
  return out;
}

function normalizeItem(raw, forcedType) {
  const images = Array.isArray(raw.posterList || raw.posters || raw.imageList) ? (raw.posterList || raw.posters || raw.imageList) : [];
  let poster = raw.poster || raw.posterUrl || raw.pic || raw.cover || raw.image || '';
  let backdrop = raw.backdrop || raw.backdropUrl || raw.background || '';
  for (const img of images) {
    if (!img || typeof img !== 'object') continue;
    const kind = String(img.fileType || img.type || '').toLowerCase();
    const url = String(img.fileUrl || img.url || img.picUrl || '');
    if (!url) continue;
    if (!poster && ['icon', 'h_poster', 'v_poster', 'cover', 'thumb'].includes(kind)) poster = url;
    if (!backdrop && kind === 'poster') backdrop = url;
    if (!poster) poster = url;
  }
  const programType = String(raw.programType || raw.contentType || raw.type || raw.mediaType || 'movie').toLowerCase();
  const explicitMovie = ['movie', 'film', '1', 'cinema', 'feature'].includes(programType);
  let type = forcedType || (!explicitMovie && ['teleplay', 'series', 'variety', '0'].includes(programType) ? 'series' : 'movie');
  if (type === 'movies') type = 'movie';
  if (type === 'animation') type = 'anime';

  const name = String(raw.name || raw.viewPoint || raw.alias || raw.title || raw.contentName || raw.programName || raw.assetName || raw.contentId || raw.id || raw.assetId || raw.programId || 'Sin título');
  const release = String(raw.releaseTime || raw.year || raw.releaseDate || raw.publishTime || raw.firstAirDate || '');
  const genres = raw.genres || raw.genreList || raw.categoryList || raw.categoryNameList || raw.categoryName || raw.genre || raw.tags || [];

  const item = Object.assign({}, raw, {
    id: String(raw.contentId || raw.id || raw.assetId || raw.programId || raw.videoId || ''),
    contentId: String(raw.contentId || raw.id || raw.assetId || raw.programId || raw.videoId || ''),
    title: name,
    name,
    type,
    media_type: type,
    year: /^\d{4}/.test(release) ? release.slice(0, 4) : release,
    poster,
    image: poster,
    backdrop,
    background: backdrop,
    description: String(raw.description || raw.desc || raw.introduction || raw.intro || raw.summary || raw.plot || raw.contentDesc || raw.programDesc || raw.assetDesc || raw.brief || ''),
    overview: String(raw.description || raw.desc || raw.introduction || raw.intro || raw.summary || raw.plot || raw.contentDesc || raw.programDesc || raw.assetDesc || raw.brief || ''),
    genres: Array.isArray(genres)
      ? genres.map(g => (typeof g === 'object' ? String(g.name || g.title || '') : String(g))).filter(Boolean)
      : String(genres || '').split(/[,|;]/).map(x => x.trim()).filter(Boolean),
    programType: type === 'series' ? 'series' : type === 'anime' ? (programType || 'anime') : 'movie'
  });

  if (raw.score != null && item.rating == null) item.rating = Number(raw.score) || null;
  if (item.id) {
    itemKinds.set(item.id, item.type);
    limitMap(itemKinds, MAX_MAP);
  }
  return item;
}

function rowName(row, fallback) {
  return String(row.name || row.columnName || row.title || row.recommendName || fallback);
}

function normalizeRows(data, fallback, forcedType) {
  if (data && data.data && typeof data.data === 'object' && !Array.isArray(data.data)) data = data.data;
  // Kino/Xuper: getNextColumns devuelve recommendList[{ name, assetList, columnId?, recommendCode? }]
  let rows = [];
  if (data && typeof data === 'object' && Array.isArray(data.recommendList)) rows = data.recommendList;
  if (!rows.length) {
    rows = listFrom(data, ['columnList', 'homeColumnList', 'rowList', 'list', 'columns', 'childColumnList', 'nextColumnList', 'columnInfoList']);
  }
  if (!rows.length && data && typeof data === 'object' && Array.isArray(data.assetList)) {
    const items = flattenItems(data, forcedType);
    return items.length ? [{ id: String(data.columnId || data.recommendCode || 'root'), code: String(data.columnCode || data.recommendCode || ''), title: rowName(data, fallback), name: rowName(data, fallback), items }] : [];
  }
  if (!rows.length) {
    const items = flattenItems(data, forcedType);
    return items.length ? [{ id: String(data.columnId || 'root'), code: String(data.columnCode || ''), title: fallback, name: fallback, items }] : [];
  }
  const out = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (!r || typeof r !== 'object') continue;
    const title = rowName(r, `${fallback} ${i + 1}`);
    // Preferir assetList directo (como parseTree de Kino) — suele ser solo preview (~10)
    let items = [];
    if (Array.isArray(r.assetList) && r.assetList.length) {
      items = r.assetList.filter(x => x && typeof x === 'object').map(x => normalizeItem(x, forcedType));
    } else {
      items = flattenItems(r, forcedType);
    }
    const code = String(r.columnCode || r.recommendCode || r.code || '');
    const rawCol = r.columnId ?? r.column_id ?? r.sectionId ?? r.recommendId ?? r.id;
    const shelveId = /^\d+$/.test(String(rawCol || '')) ? String(rawCol) : '';
    // id para el filtro de la app: preferir columnId numérico (sirve para getShelveData paginado)
    let id = shelveId || code || `cat_${i}`;
    if (!items.length && !id && !code) continue;
    out.push({ id, code, title, name: title, items: unique(items), shelveId });
  }
  return out;
}

function unique(items) {
  const seen = new Set();
  return items.filter(it => {
    const id = String(it.contentId || it.id || it.title);
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function categoryKindsFromRows(rows, kind) {
  for (const row of rows) {
    if (row.id) {
      categoryKinds.set(String(row.id), kind);
      limitMap(categoryKinds, MAX_MAP);
    }
    if (row.code) {
      categoryKinds.set(String(row.code), kind);
      limitMap(categoryKinds, MAX_MAP);
    }
    for (const item of row.items || []) {
      const id = String(item.contentId || item.id || '');
      if (id) {
        itemKinds.set(id, kind === 'movies' ? 'movie' : kind === 'series' ? 'series' : 'anime');
        limitMap(itemKinds, MAX_MAP);
      }
    }
  }
}

function kindLabel(kind) {
  return kind === 'series' ? 'Series' : kind === 'anime' ? 'Animación' : 'Películas';
}

/** Normaliza el tipo que manda la UI (movie/series/anime/movies/all) */
function resolveKind(raw) {
  const s = String(raw || '').toLowerCase();
  if (s.includes('anime') || s.includes('anim')) return 'anime';
  if (s.includes('series') || s === '0' || s === 'tv') return 'series';
  if (s.includes('all')) return 'all';
  if (s.includes('movie') || s === '1' || s === 'film') return 'movies';
  return 'movies';
}

/** Limita filas e ítems del Home para no saturar la app */
const HOME_MAX_ROWS_PER_KIND = 4;
const HOME_MAX_ITEMS_PER_ROW = 12;

function trimHomeRows(rows) {
  return (rows || [])
    .slice(0, HOME_MAX_ROWS_PER_KIND)
    .map(r => Object.assign({}, r, {
      items: unique(r.items || []).slice(0, HOME_MAX_ITEMS_PER_ROW)
    }))
    .filter(r => (r.items && r.items.length) || r.id || r.code);
}

async function homeRows(kind) {
  const code = HOME[kind] || HOME.movies;
  const forcedType = kind === 'series' ? 'series' : kind === 'anime' ? 'anime' : 'movie';
  return cached('homeRows:' + kind, CACHE_TTL.getHome, async () => {
    // 1) getHome (rápido). Solo si timeout → no insistir en cadena larga.
    try {
      const data = await api('getHome', { homePageCode: code, version: '' });
      const rows = normalizeRows(data, kindLabel(kind), forcedType);
      if (rows.length) {
        categoryKindsFromRows(rows, kind);
        return trimHomeRows(rows);
      }
    } catch (e) {
      if (timeoutError(e)) return [];
    }
    // 2) Un solo fallback ligero (pageSize 8). Sin tercer intento en cold path.
    try {
      const data = await api('getNextColumns', { columnCode: code, pageNum: 1, pageSize: 8, version: '' });
      const rows = normalizeRows(data, kindLabel(kind), forcedType);
      if (rows.length) {
        categoryKindsFromRows(rows, kind);
        return trimHomeRows(rows);
      }
    } catch (e) {
      if (timeoutError(e)) return [];
    }
    // 3) Último recurso: una página de la raíz (solo si los anteriores no dieron filas)
    try {
      const rootId = ROOT[kind] || ROOT.movies;
      const data = await api('v3/getShelveData', {
        columnId: rootId,
        columnType: '2',
        pageNum: 1,
        pageSize: HOME_MAX_ITEMS_PER_ROW,
        encryptVersion: 0
      });
      const items = unique(flattenItems(data, forcedType)).slice(0, HOME_MAX_ITEMS_PER_ROW);
      if (items.length) return [{ id: rootId, code, title: kindLabel(kind), name: kindLabel(kind), items }];
    } catch (_) {}
    return [];
  });
}

async function featured() {
  return cached('featured-items', CACHE_TTL['v3/getRecommends'], async () => {
    try {
      // Solo 3 bloques featured (antes 6) → menos red y menos ítems
      const data = await api('v3/getRecommends', {
        recommendCodeArr: Array.from({ length: 3 }, (_, i) => `masnew_featured${String(i + 1).padStart(2, '0')}`)
      });
      const items = unique(flattenItems(data)).slice(0, 10);
      if (items.length) return items;
    } catch (_) {}
    // Solo reutiliza caché ya cargada; no dispara homeRows extra
    const cachedMovies = responseCache.get('homeRows:movies')?.value || [];
    const cachedSeries = responseCache.get('homeRows:series')?.value || [];
    return unique([
      ...cachedMovies.flatMap(r => r.items || []),
      ...cachedSeries.flatMap(r => r.items || [])
    ]).slice(0, 10);
  });
}

function isAnime(item) {
  const text = `${item.type || ''} ${item.programType || ''} ${item.name || ''} ${item.category || ''} ${item.columnName || ''}`.toLowerCase();
  return /anime|animaci|donghua|masnew_anime/.test(text);
}

function itemType(item) {
  return item.type === 'anime' || isAnime(item)
    ? 'anime'
    : item.type === 'series' || item.programType === 'series' || item.programType === 'teleplay' || item.programType === '0'
      ? 'series'
      : 'movie';
}

async function _getNews() {
  // News más corto en Home (el resto se ve en Descubrir / búsqueda)
  const limit = Math.max(1, Math.min(8, parseInt(config().newsLimit, 10) || 8));
  const items = await featured();
  return unique(items).slice(0, limit).map((it, i) => Object.assign({}, it, { section: 'novedades', news: true, newsRank: i + 1 }));
}

async function _getHome() {
  // Paraleliza los 3 tipos (el rateQueue sigue serializando el portal).
  // Misma forma de filas/ítems; menos tiempo de pared en cold start.
  const kinds = ['movies', 'series', 'anime'];
  const results = await Promise.all(kinds.map(k => homeRows(k).catch(() => [])));
  const rows = [];
  for (let i = 0; i < kinds.length; i++) {
    const kind = kinds[i];
    for (const row of results[i] || []) {
      rows.push(Object.assign({}, row, {
        type: 'row',
        categoryType: kind === 'movies' ? 'movie' : kind,
        category: row.title,
        // Home sigue en banner horizontal
        imageStyle: 'backdrop'
      }));
    }
  }
  const news = await getNews().catch(() => []);
  if (news.length) {
    rows.unshift({
      id: 'novedades',
      code: 'novedades',
      title: 'Novedades',
      name: 'Novedades',
      type: 'hero',
      imageStyle: 'backdrop',
      items: news.slice(0, 8)
    });
  }
  return rows;
}

async function getCatalogs() {
  return [
    { id: 'peliculas', title: 'Películas', name: 'Películas', type: 'movie', kinds: ['movie'], extra: { kind: 'movies' } },
    { id: 'series', title: 'Series', name: 'Series', type: 'series', kinds: ['series'], extra: { kind: 'series' } },
    { id: 'animacion', title: 'Animación', name: 'Animación', type: 'anime', kinds: ['anime'], extra: { kind: 'anime' } }
  ];
}

async function getCatalog(catalogId, options) {
  const id = String(catalogId || '').toLowerCase();
  const opts = options && typeof options === 'object' ? options : {};
  const kind = id.includes('anime') || id.includes('anim') ? 'anime' : id.includes('series') ? 'series' : 'movies';
  return getDiscover(Object.assign({}, opts, { kind }));
}

function rememberCategoryRow(row, kind) {
  const key = String(row.id || row.code || '');
  if (!key) return;
  const entry = {
    items: unique(row.items || []),
    kind,
    title: row.title || row.name || key,
    code: row.code || '',
    // columnId numérico para paginar con getShelveData (lista completa)
    shelveId: row.shelveId || (/^\d+$/.test(key) ? key : '')
  };
  categoryItemsCache.set(key, entry);
  if (row.code && String(row.code) !== key) categoryItemsCache.set(String(row.code), entry);
  if (entry.shelveId && entry.shelveId !== key) categoryItemsCache.set(entry.shelveId, entry);
  limitMap(categoryItemsCache, MAX_MAP);
}

async function categoryRows(kind) {
  const code = HOME[kind] || HOME.movies;
  const forcedType = kind === 'series' ? 'series' : kind === 'anime' ? 'anime' : 'movie';
  // Solo necesitamos nombres/IDs de categoría para filtros → pageSize bajo (menos payload/CPU)
  try {
    const data = await api('getNextColumns', { columnCode: code, pageNum: 1, pageSize: 12, version: '' });
    const rows = normalizeRows(data, kindLabel(kind), forcedType);
    const usable = rows.filter(r => (r.items && r.items.length) || r.id || r.code);
    if (usable.length) {
      categoryKindsFromRows(usable, kind);
      for (const row of usable) rememberCategoryRow(row, kind);
      return usable;
    }
  } catch (_) {}
  const rows = await homeRows(kind).catch(() => []);
  categoryKindsFromRows(rows, kind);
  for (const row of rows) rememberCategoryRow(row, kind);
  return rows.filter(r => r.id || r.code || (r.items && r.items.length));
}

/**
 * La UI envía filters = { type: 'movie'|'series'|'anime', category: columnId }
 * Sin opción "Todas las categorías": cada opción es una categoría real.
 * Al cambiar type se recargan solo las categorías de ese tipo.
 */
async function _getDiscoverFilters(filters) {
  const opts = filters && typeof filters === 'object' ? filters : {};
  const kind = resolveKind(opts.type || opts.kind || opts.filter || 'movie');
  const types = [
    { id: 'movie', label: 'Películas' },
    { id: 'series', label: 'Series' },
    { id: 'anime', label: 'Animación' }
  ];
  const kinds = kind === 'all' ? ['movies', 'series', 'anime'] : [kind === 'movies' ? 'movies' : kind];
  const rowsByKind = await Promise.all(kinds.map(k => categoryRows(k).catch(() => [])));
  const options = [];
  const seen = new Set();
  for (let i = 0; i < kinds.length; i++) {
    for (const row of rowsByKind[i]) {
      // XPPC: solo categorías con columnId numérico (getShelveData no acepta codes)
      const id = String(row.shelveId || (/^\d+$/.test(String(row.id || '')) ? row.id : ''));
      if (!id || !/^\d+$/.test(id) || seen.has(id)) continue;
      seen.add(id);
      categoryKinds.set(id, kinds[i]);
      limitMap(categoryKinds, MAX_MAP);
      if (row.code) {
        categoryKinds.set(String(row.code), kinds[i]);
        limitMap(categoryKinds, MAX_MAP);
      }
      options.push({
        id,
        label: row.title || row.name || kindLabel(kinds[i]),
        columnId: id,
        columnCode: String(row.code || ''),
        type: kinds[i] === 'movies' ? 'movie' : kinds[i]
      });
    }
  }
  if (!options.length) {
    for (const k of kinds) {
      const rootId = String(ROOT[k] || ROOT.movies);
      if (seen.has(rootId)) continue;
      seen.add(rootId);
      categoryKinds.set(rootId, k);
      options.push({
        id: rootId,
        label: kindLabel(k),
        columnId: rootId,
        columnCode: HOME[k] || '',
        type: k === 'movies' ? 'movie' : k
      });
    }
  }
  return [
    { id: 'type', name: 'Tipo', label: 'Tipo', type: 'select', options: types },
    { id: 'category', name: 'Categoría', label: 'Categoría', type: 'select', options }
  ];
}

/**
 * Lista completa paginada (XPPC):
 *   v3/getShelveData { columnId, columnType:'2', pageNum, pageSize, encryptVersion:0 }
 * El assetList del árbol (~10) es solo preview; aquí va la lista real.
 */
async function fetchShelvePage(columnId, forcedType, page, pageSize) {
  const idNum = Number(columnId);
  const idStr = String(columnId);
  if (!Number.isFinite(idNum) || idNum <= 0) {
    return { items: [], page, hasMore: false, total: 0 };
  }

  // Solo 2 beans (el portal acepta num o string). Evita 6 intentos rate-limited en frío.
  const beans = [
    { columnId: idNum, columnType: '2', pageNum: page, pageSize, encryptVersion: 0 },
    { columnId: idStr, columnType: '2', pageNum: page, pageSize, encryptVersion: 0 }
  ];

  for (const bean of beans) {
    try {
      const data = await api('v3/getShelveData', bean);
      let items = [];
      if (Array.isArray(data.assetList)) {
        items = data.assetList
          .filter(x => x && typeof x === 'object')
          .map(x => normalizeItem(x, forcedType));
      }
      if (!items.length) items = flattenItems(data, forcedType);
      items = unique(items).map(it => {
        const t = forcedType || itemType(it);
        if (it.id) {
          itemKinds.set(it.id, t);
          limitMap(itemKinds, MAX_MAP);
        }
        // Descubrir: posters verticales (no banner)
        const poster = it.poster || it.image || it.backdrop || '';
        return Object.assign({}, it, {
          type: t,
          media_type: t,
          poster,
          image: poster,
          imageStyle: 'poster'
        });
      });
      const totalRaw = data.assetListTotalSize ?? data.listTotalSize ?? data.totalSize ?? data.total ?? data.count;
      const pageItems = items.length > pageSize ? items.slice(0, pageSize) : items;
      const total = totalRaw != null
        ? Number(totalRaw)
        : (page - 1) * pageSize + pageItems.length + (pageItems.length >= 10 ? pageSize : 0);
      const hasMore = totalRaw != null
        ? page * pageSize < Number(totalRaw)
        : pageItems.length >= 10;
      if (pageItems.length || (totalRaw != null && Number(totalRaw) > 0)) {
        return { items: pageItems, page, hasMore, total: Number(total) || pageItems.length };
      }
    } catch (_) {}
  }

  // Sin cascada getNextColumns → nested fetchShelvePage (era muy pesada y duplicaba trabajo)
  return { items: [], page, hasMore: false, total: 0 };
}

async function _getDiscover(options) {
  const opts = options && typeof options === 'object' ? options : {};
  // Paginación servidor: v3/getShelveData (igual extracción XPPC). Optimizado: ROOT directo si no hay categoría.
  const kind = resolveKind(opts.type || opts.kind || 'movie');
  const page = Math.max(1, parseInt(opts.page, 10) || 1);
  const pageSize = Math.min(40, Math.max(10, parseInt(opts.pageSize, 10) || 20));
  const rootKey = kind === 'anime' ? 'anime' : kind === 'series' ? 'series' : 'movies';
  const forcedType = rootKey === 'series' ? 'series' : rootKey === 'anime' ? 'anime' : 'movie';

  let selected = String(
    opts.columnId ||
    opts.categoryId ||
    opts.category ||
    opts.genre ||
    opts.filter ||
    ''
  ).trim();

  if (
    !selected ||
    selected === 'all' ||
    selected === 'Todas las categorías' ||
    selected === 'undefined' ||
    selected === 'null' ||
    selected === 'type' ||
    selected === 'movie' ||
    selected === 'series' ||
    selected === 'anime' ||
    selected === 'movies'
  ) {
    selected = '';
  }

  let shelveId = '';
  if (selected && /^\d+$/.test(selected)) {
    shelveId = selected;
  } else if (selected) {
    // Resolver nombre/code → columnId solo si el usuario eligió categoría (no en cada página "todas")
    const rows = await categoryRows(rootKey).catch(() => []);
    const found = rows.find(r =>
      String(r.id) === selected ||
      String(r.code) === selected ||
      String(r.shelveId || '') === selected ||
      r.title === selected ||
      r.name === selected
    );
    if (found) {
      shelveId = String(found.shelveId || (/^\d+$/.test(String(found.id || '')) ? found.id : ''));
    }
    const cached = categoryItemsCache.get(selected);
    if (!shelveId && cached && cached.shelveId) shelveId = String(cached.shelveId);
  }

  // Sin categoría: ROOT fijo (evita getNextColumns extra en cada visita a Descubrir)
  if (!shelveId || !/^\d+$/.test(shelveId)) {
    shelveId = String(ROOT[rootKey] || ROOT.movies);
  }

  const pageResult = await fetchShelvePage(shelveId, forcedType, page, pageSize);
  if (pageResult.items.length || pageResult.hasMore) {
    pageResult.items = (pageResult.items || []).map(it => {
      const poster = it.poster || it.image || '';
      return Object.assign({}, it, {
        poster,
        image: poster,
        imageStyle: 'poster'
      });
    });
    return pageResult;
  }

  const rootId = String(ROOT[rootKey] || ROOT.movies);
  if (shelveId !== rootId) {
    const rootPage = await fetchShelvePage(rootId, forcedType, page, pageSize);
    if (rootPage.items.length || rootPage.hasMore) {
      rootPage.items = (rootPage.items || []).map(it => {
        const poster = it.poster || it.image || '';
        return Object.assign({}, it, { poster, image: poster, imageStyle: 'poster' });
      });
      return rootPage;
    }
  }

  return { items: [], page, hasMore: false, total: 0 };
}

async function search(query, options) {
  const q = String(query || '').trim();
  if (!q) return [];
  const opts = options && typeof options === 'object' ? options : {};
  const page = Math.max(1, parseInt(opts.page, 10) || 1);
  const requested = String(opts.type || '').toLowerCase();
  return cached('search:' + q.toLowerCase() + ':' + requested + ':' + page, 25e3, async () => {
    const find = async type => unique(flattenItems(await api('v3/searchByName', {
      value: q,
      type,
      columnId: '',
      filter: '',
      pageNum: page,
      pageSize: 20
    })));
    const remember = (items, kind) => items.map(it => {
      const id = String(it.contentId || it.id || '');
      if (id) {
        itemKinds.set(id, kind);
        limitMap(itemKinds, MAX_MAP);
      }
      return Object.assign(it, { type: kind, media_type: kind });
    });
    if (requested === 'anime' || requested === 'animacion' || requested === 'animation') {
      try {
        return remember((await find('0')).filter(it => isAnime(it)), 'anime');
      } catch (_) {
        return [];
      }
    }
    if (requested === 'movie' || requested === 'movies') {
      try {
        return remember(await find('1'), 'movie');
      } catch (_) {
        return [];
      }
    }
    if (requested === 'series') {
      try {
        return remember(await find('0'), 'series');
      } catch (_) {
        return [];
      }
    }
    const results = await Promise.all([find('1').catch(() => []), find('0').catch(() => [])]);
    return unique([...results[0], ...results[1]]).map(it => {
      const kind = itemType(it);
      const id = String(it.contentId || it.id || '');
      if (id) {
        itemKinds.set(id, kind);
        limitMap(itemKinds, MAX_MAP);
      }
      return Object.assign(it, { type: kind, media_type: kind });
    });
  });
}

function unwrapDetail(response) {
  let data = response;
  for (let i = 0; i < 5 && data && typeof data === 'object'; i++) {
    if (data.assetData && typeof data.assetData === 'object') {
      data = data.assetData;
      continue;
    }
    if (data.item && typeof data.item === 'object') {
      data = data.item;
      continue;
    }
    if (data.result && typeof data.result === 'object') {
      data = data.result;
      continue;
    }
    if (data.data && typeof data.data === 'object' && !data.contentId && !data.name && !data.title && !data.programType) {
      data = data.data;
      continue;
    }
    break;
  }
  return data && typeof data === 'object' ? data : {};
}

function episodeRows(data, seriesId, defaultSeason, seasonPortalId) {
  const raw = listFrom(data, ['simpleProgramList', 'episodeList', 'episodes', 'programList', 'movieList', 'assetList']);
  const seasonPortal = String(seasonPortalId || seriesId || '');
  return raw.map((ep, j) => {
    const e = normalizeItem(ep);
    const number = Number(ep.seriesNumber || ep.episodeNum || ep.episodeNo || ep.episode || ep.number || j + 1) || j + 1;
    const id = String(ep.contentId || ep.id || ep.movieId || ep.assetId || '');
    if (!id) return null;
    // Forzar la temporada que estamos cargando (no la que diga el portal a veces mal)
    const season = Number(defaultSeason || ep.seasonNumber || ep.seasonNum || ep.season || 1) || 1;
    if (seriesId) {
      episodeContentIds.set(`${seriesId}:${season}:${number}`, id);
      episodeParent.set(id, String(seriesId));
      if (seasonPortal) {
        episodeSeasonId.set(id, seasonPortal);
        seasonContentIds.set(`${seriesId}:${season}`, seasonPortal);
        episodeContentIds.set(`${seasonPortal}:${season}:${number}`, id);
      }
      limitMap(episodeContentIds, MAX_MAP);
      limitMap(episodeParent, MAX_MAP);
      limitMap(episodeSeasonId, MAX_MAP);
      limitMap(seasonContentIds, MAX_MAP);
    }
    return {
      number,
      episode: number,
      id,
      contentId: id,
      title: String(ep.name || ep.viewPoint || ep.alias || ep.title || `Capítulo ${number}`),
      name: String(ep.name || ep.viewPoint || ep.alias || ep.title || `Capítulo ${number}`),
      overview: String(ep.description || ep.desc || ep.introduction || ''),
      description: String(ep.description || ep.desc || ep.introduction || ''),
      still: String(ep.poster || ep.posterUrl || e.poster || e.backdrop || ''),
      poster: String(ep.poster || ep.posterUrl || e.poster || ''),
      season,
      seriesContentId: String(seriesId || ''),
      seasonContentId: seasonPortal
    };
  }).filter(Boolean);
}

function parseSeasonFromName(name) {
  const m = String(name || '').match(/(?:temporada|season|temp\.?|\bT|\bS)\s*(\d+)/i);
  return m ? Number(m[1]) : 0;
}

function rememberEpisodeMap(parentId, seasons) {
  for (const s of seasons || []) {
    const sn = Number(s.number || s.season || 1) || 1;
    for (const ep of s.episodes || []) {
      const en = Number(ep.number || ep.episode || 0);
      const eid = String(ep.id || ep.contentId || '');
      if (!en || !eid) continue;
      episodeContentIds.set(`${parentId}:${sn}:${en}`, eid);
      episodeParent.set(eid, String(parentId));
    }
  }
  limitMap(episodeContentIds, MAX_MAP);
  limitMap(episodeParent, MAX_MAP);
}


// ─── TMDB opcional (estilo Kino: enriquecimiento, nunca requisito) ───────────
const TMDB_BASE = 'https://api.themoviedb.org/3';
const TMDB_IMG = 'https://image.tmdb.org/t/p';
const tmdbCache = new Map();

function tmdbKey() {
  try {
    const k = String(config().tmdbApiKey || '').trim();
    return k || '';
  } catch (_) {
    return '';
  }
}

async function tmdbGet(path, params) {
  const key = tmdbKey();
  if (!key) return null;
  const q = Object.assign({ api_key: key, language: 'es-MX' }, params || {});
  const qs = Object.keys(q).map(k => encodeURIComponent(k) + '=' + encodeURIComponent(String(q[k]))).join('&');
  const url = TMDB_BASE + path + '?' + qs;
  const ck = 'tmdb:' + path + ':' + qs;
  const hit = tmdbCache.get(ck);
  if (hit && hit.expires > Date.now()) return hit.value;
  try {
    const opts = { method: 'GET', headers: { Accept: 'application/json' } };
    if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
      opts.signal = AbortSignal.timeout(6000);
    }
    const res = await fetch(url, opts);
    if (!res.ok) return null;
    const json = await res.json();
    tmdbCache.set(ck, { value: json, expires: Date.now() + 30 * 60e3 });
    limitMap(tmdbCache, 80);
    return json;
  } catch (_) {
    return null;
  }
}

function tmdbStill(path) {
  if (!path || path === 'null') return '';
  return TMDB_IMG + '/w300' + path;
}

/**
 * Rellena still/poster de capítulos Magis con stills TMDB (misma S/E).
 * No cambia estructura ni IDs; solo campos de imagen vacíos o débiles.
 * Si no hay clave TMDB o falla la red → no-op.
 */
async function enrichEpisodeStillsFromTmdb(item) {
  if (!item || !Array.isArray(item.seasons) || !item.seasons.length) return item;
  if (!tmdbKey()) return item;
  try {
    const imdb = String(
      (item.details && (item.details.keyWords || item.details.imdbId || item.details.imdb)) ||
      item.imdb || item.imdbId || ''
    ).trim();
    let tvId = 0;
    if (/^tt\d{7,}$/i.test(imdb)) {
      const find = await tmdbGet('/find/' + imdb, { external_source: 'imdb_id' });
      const tv = find && Array.isArray(find.tv_results) && find.tv_results[0];
      if (tv && tv.id) tvId = Number(tv.id) || 0;
    }
    if (!tvId) {
      const title = String(item.title || item.name || '').replace(/\s*[Tt]emp(orada)?\.?\s*\d+.*$/, '').trim();
      if (title.length < 2) return item;
      const search = await tmdbGet('/search/tv', { query: title });
      const hit = search && Array.isArray(search.results) && search.results[0];
      if (hit && hit.id) tvId = Number(hit.id) || 0;
    }
    if (!tvId) return item;

    // Solo temporadas presentes en Magis (máx 6 para no saturar)
    const seasons = item.seasons.slice(0, 6);
    await Promise.all(seasons.map(async (s) => {
      const sn = Number(s.number || s.season || 1) || 1;
      const body = await tmdbGet('/tv/' + tvId + '/season/' + sn, {});
      if (!body || !Array.isArray(body.episodes)) return;
      const byNum = new Map();
      for (const e of body.episodes) {
        const n = Number(e.episode_number);
        if (n) byNum.set(n, e);
      }
      for (const ep of s.episodes || []) {
        const n = Number(ep.number || ep.episode || 0);
        const te = byNum.get(n);
        if (!te) continue;
        const still = tmdbStill(te.still_path);
        if (!still) continue;
        // Solo si Magis no traía still decente
        if (!ep.still || ep.still === ep.poster) ep.still = still;
        if (!ep.poster) ep.poster = still;
        if (!ep.image) ep.image = still;
      }
    }));

    // Reflejar episodes de la temporada actual
    if (Array.isArray(item.episodes) && item.seasons.length) {
      const cur = item.seasons.find(s => Number(s.number) === Number((item.episodes[0] && item.episodes[0].season) || 1)) || item.seasons[0];
      if (cur && cur.episodes && cur.episodes.length) item.episodes = cur.episodes;
    }
  } catch (_) {}
  return item;
}

async function _getMeta(id, options) {
  const opts = options && typeof options === 'object' ? options : (typeof options === 'string' ? { type: options } : {});
  const contentId = String(id && typeof id === 'object' ? (id.contentId || id.id || id.assetId || id.programId) : id || '').trim();
  if (!contentId) return null;
  const seed = id && typeof id === 'object' ? normalizeItem(id) : null;
  let knownType = String((seed && seed.type) || itemKinds.get(contentId) || '');
  const explicit = String(opts.type || '').toLowerCase();
  let preferred = explicit || (knownType === 'series' || knownType === 'anime' ? '0' : knownType === 'movie' ? '1' : '');
  if (preferred === 'movie' || preferred === 'movies') preferred = '1';
  if (preferred === 'series' || preferred === 'anime' || preferred === 'tv') preferred = '0';
  const types = preferred ? [preferred, preferred === '0' ? '1' : '0'] : ['1', '0'];

  return cached('meta:' + contentId + ':' + (preferred || 'auto'), CACHE_TTL['v4/getItemData'], async () => {
    let data = {}, fetchedType = preferred || '1';
    for (const t of types) {
      try {
        const response = await api('v4/getItemData', {
          contentId,
          type: t,
          sortType: '0',
          language: 'en',
          macAddr: FIXED_MAC
        });
        const candidate = unwrapDetail(response);
        const hasIdentity = !!(candidate.contentId || candidate.id || candidate.name || candidate.title || candidate.viewPoint || candidate.assetName);
        const hasDetail = !!(candidate.description || candidate.introduction || candidate.desc || candidate.posterList || candidate.simpleProgramList || candidate.sameSeasonSeriesList);
        if (hasIdentity || hasDetail) {
          data = candidate;
          fetchedType = t;
          if (t === '0' || candidate.simpleProgramList || candidate.sameSeasonSeriesList) break;
        }
      } catch (_) {}
    }

    const merged = Object.assign({}, seed || {}, data);
    merged.contentId = String(data.contentId || data.id || contentId);
    if (!(data.name || data.title || data.viewPoint || data.alias) && seed) {
      merged.name = seed.title || seed.name;
    }
    const detailTitleForSeason = String(data.name || data.viewPoint || data.alias || data.title || '');
    const defaultSeason = Number(data.seasonNumber || data.season || parseSeasonFromName(detailTitleForSeason) || 1) || 1;
    // Esta ficha puede ser YA una temporada concreta: su contentId es el de esa temporada
    const simple = episodeRows(data, contentId, defaultSeason, contentId);
    seasonContentIds.set(`${contentId}:${defaultSeason}`, contentId);
    const ptype = String(data.programType || data.contentType || data.type || '').toLowerCase();
    const isSeries = ['teleplay', 'series', 'variety', '0', 'tv'].includes(ptype) || fetchedType === '0' || simple.length > 1 || Array.isArray(data.sameSeasonSeriesList);
    const type = isSeries ? (knownType === 'anime' ? 'anime' : 'series') : 'movie';
    const item = normalizeItem(merged, type);
    item.type = type;
    item.media_type = type;
    item.programType = isSeries ? 'series' : 'movie';
    item.id = String(data.contentId || data.id || contentId);
    item.contentId = item.id;
    item.title = String(data.name || data.viewPoint || data.alias || data.title || data.contentName || data.programName || item.title || contentId);
    item.name = item.title;
    item.description = String(data.description || data.introduction || data.desc || data.contentDesc || data.programDesc || item.description || '');
    item.overview = item.description;
    item.details = data;

    const bySeason = new Map();
    for (const ep of simple) {
      const n = Number(ep.season || 1);
      if (!bySeason.has(n)) bySeason.set(n, []);
      bySeason.get(n).push(ep);
    }

    const siblings = Array.isArray(data.sameSeasonSeriesList) ? data.sameSeasonSeriesList : [];
    const currentSeason = Number(data.seasonNumber || data.season || parseSeasonFromName(item.title) || defaultSeason || 1) || 1;

    if (isSeries && !bySeason.has(currentSeason) && simple.length) {
      bySeason.set(currentSeason, simple);
    }

    const seasons = [];
    for (const [number, episodes] of Array.from(bySeason.entries()).sort((a, b) => a[0] - b[0])) {
      seasons.push({
        number,
        season: number,
        name: `Temporada ${number}`,
        title: `Temporada ${number}`,
        episodes: episodes.sort((a, b) => a.number - b.number),
        // contentId de esta temporada en el portal (= ficha actual si es su temporada)
        contentId: contentId
      });
      seasonContentIds.set(`${contentId}:${number}`, contentId);
    }

    // Cada temporada suele ser otro contentId (sameSeasonSeriesList)
    if (isSeries && siblings.length) {
      const links = [];
      const seen = new Set([item.id]);
      for (const sibling of siblings) {
        const sid = String(sibling.contentId || sibling.id || '').trim();
        if (!sid || seen.has(sid)) continue;
        seen.add(sid);
        let sn = Number(sibling.seasonNumber || sibling.season || parseSeasonFromName(sibling.name || sibling.title || '') || 0) || 0;
        links.push({
          id: sid,
          number: sn,
          name: String(sibling.name || sibling.viewPoint || sibling.title || (sn ? `Temporada ${sn}` : 'Temporada')),
          poster: sibling.poster || sibling.posterUrl || ''
        });
      }
      // Si el portal no numera bien, asignar 1..N ordenando por nombre/id
      const usedNums = new Set(seasons.map(s => Number(s.number)));
      if (usedNums.has(currentSeason) === false && simple.length) usedNums.add(currentSeason);
      let auto = 1;
      for (const link of links) {
        if (!link.number || usedNums.has(link.number)) {
          while (usedNums.has(auto)) auto++;
          link.number = auto;
        }
        usedNums.add(link.number);
        auto = link.number + 1;
      }

      for (const link of links.slice(0, 8)) {
        try {
          const sr = await api('v4/getItemData', {
            contentId: link.id,
            type: '0',
            sortType: '0',
            language: 'en',
            macAddr: FIXED_MAC
          });
          const sd = unwrapDetail(sr);
          const seasonNum = link.number || Number(sd.seasonNumber || sd.season || parseSeasonFromName(link.name) || seasons.length + 1) || 1;
          // Episodios de ESTA temporada: indexados bajo item.id y bajo link.id (contentId de la temporada)
          let eps = episodeRows(sd, item.id, seasonNum, link.id);
          eps = eps.map(ep => Object.assign({}, ep, {
            season: seasonNum,
            seriesContentId: item.id,
            seasonContentId: link.id
          }));
          seasonContentIds.set(`${item.id}:${seasonNum}`, link.id);
          seasonContentIds.set(`${link.id}:${seasonNum}`, link.id);
          for (const ep of eps) {
            const eid = String(ep.id);
            episodeContentIds.set(`${item.id}:${seasonNum}:${Number(ep.number)}`, eid);
            episodeContentIds.set(`${link.id}:${seasonNum}:${Number(ep.number)}`, eid);
            episodeParent.set(eid, String(item.id));
            episodeSeasonId.set(eid, link.id);
          }
          limitMap(episodeContentIds, MAX_MAP);
          limitMap(seasonContentIds, MAX_MAP);
          const existing = seasons.find(x => x.number === seasonNum);
          if (existing) {
            if (!existing.episodes.length) {
              existing.episodes = eps;
              existing.contentId = link.id;
            }
          } else {
            seasons.push({
              number: seasonNum,
              season: seasonNum,
              name: link.name || `Temporada ${seasonNum}`,
              title: link.name || `Temporada ${seasonNum}`,
              episodes: eps,
              contentId: link.id
            });
          }
        } catch (_) {}
      }
      if (!seasons.length) {
        for (const link of links) {
          seasons.push({
            number: link.number || seasons.length + 1,
            season: link.number || seasons.length + 1,
            name: link.name,
            episodes: [],
            contentId: link.id
          });
        }
      }
    }

    if (isSeries && !seasons.length) {
      seasons.push({
        number: currentSeason,
        season: currentSeason,
        name: `Temporada ${currentSeason}`,
        episodes: simple
      });
    }

    // Garantizar Temporada 1: si solo hay T2+ y un sibling sin número, promover el de menor número o el actual si es 1
    if (isSeries && seasons.length && !seasons.some(s => Number(s.number) === 1)) {
      // Renumerar la temporada con más episodios "base" o la de menor número a 1 si currentSeason era mal etiquetada
      seasons.sort((a, b) => Number(a.number) - Number(b.number));
      const first = seasons[0];
      if (first && Number(first.number) !== 1) {
        const oldN = Number(first.number);
        first.number = 1;
        first.season = 1;
        first.name = first.name && /temporada/i.test(first.name) ? 'Temporada 1' : (first.name || 'Temporada 1');
        first.title = first.name;
        for (const ep of first.episodes || []) {
          ep.season = 1;
          episodeContentIds.set(`${item.id}:1:${Number(ep.number)}`, String(ep.id || ep.contentId));
          if (oldN) episodeContentIds.set(`${item.id}:${oldN}:${Number(ep.number)}`, String(ep.id || ep.contentId));
        }
      }
    }

    seasons.sort((a, b) => Number(a.number) - Number(b.number));
    // Re-indexar todas las temporadas bajo item.id para que getStreams(seriesId, S, E) siempre resuelva
    for (const s of seasons) {
      const sn = Number(s.number) || 1;
      for (const ep of s.episodes || []) {
        const eid = String(ep.id || ep.contentId || '');
        if (!eid) continue;
        ep.season = sn;
        ep.seriesContentId = item.id;
        episodeContentIds.set(`${item.id}:${sn}:${Number(ep.number)}`, eid);
        episodeParent.set(eid, String(item.id));
      }
    }
    limitMap(episodeContentIds, MAX_MAP);

    item.seasons = seasons;
    item.episodes = seasons.length ? (seasons.find(s => Number(s.number) === currentSeason) || seasons[0]).episodes : simple;
    item.seasonSiblings = siblings;
    item.genres = item.genres || [];
    rememberEpisodeMap(item.id, seasons);
    if (item.id) {
      itemKinds.set(item.id, type);
      limitMap(itemKinds, MAX_MAP);
    }
    // Post-proceso opcional: stills TMDB solo para capítulos que Magis ya listó
    try {
      await enrichEpisodeStillsFromTmdb(item);
    } catch (_) {}
    return item;
  });
}

function normalizeSubLang(raw) {
  const s = String(raw || '').trim().toLowerCase();
  if (!s || s === 'und' || s === 'unknown' || s === 'null') return { code: 'es', label: 'Español' };
  if (/^(es|spa|spanish|español|castellano)/.test(s)) return { code: 'es', label: 'Español' };
  if (/^(en|eng|english|inglés|ingles)/.test(s)) return { code: 'en', label: 'English' };
  if (/^(pt|por|portuguese|portugu)/.test(s)) return { code: 'pt', label: 'Português' };
  if (/^(fr|fre|french|franc)/.test(s)) return { code: 'fr', label: 'Français' };
  if (/^(de|ger|german|alem)/.test(s)) return { code: 'de', label: 'Deutsch' };
  if (/^(it|ita|italian)/.test(s)) return { code: 'it', label: 'Italiano' };
  if (/^(zh|chi|chinese|mandarin)/.test(s)) return { code: 'zh', label: '中文' };
  if (/^(ja|jpn|japanese|japon)/.test(s)) return { code: 'ja', label: '日本語' };
  if (/^(ko|kor|korean|corean)/.test(s)) return { code: 'ko', label: '한국어' };
  if (s.length <= 3) return { code: s, label: s.toUpperCase() };
  return { code: s.slice(0, 2), label: String(raw) };
}

/**
 * Subtítulos estilo Kino/Xuper:
 *   play.episodeList[0].subtitleList[].file[0].url + language + fileType
 * Más cualquier otra lista conocida. Devuelve TODOS los disponibles con URL.
 */
function extractSubtitles(baseUrl, ...sources) {
  const out = [];
  const seen = new Set();
  const base = String(baseUrl || '').replace(/\/$/, '');

  const absolutize = (url) => {
    let u = String(url || '').trim();
    if (!u) return '';
    if (/^https?:\/\//i.test(u)) return u;
    if (u.startsWith('//')) return 'https:' + u;
    if (!base) return u;
    if (u.startsWith('/')) return base + u;
    return base + '/' + u;
  };

  const push = (url, lang, label, format) => {
    const u = absolutize(url);
    if (!u || seen.has(u)) return;
    if (!/^https?:\/\//i.test(u)) return;
    seen.add(u);
    let fmt = String(format || '').toLowerCase().replace(/^\./, '');
    const lower = u.toLowerCase();
    if (!fmt || fmt === 'text' || fmt === 'file') {
      if (lower.includes('.vtt')) fmt = 'vtt';
      else if (lower.includes('.srt')) fmt = 'srt';
      else if (lower.includes('.ass') || lower.includes('.ssa')) fmt = 'ass';
      else fmt = 'srt';
    }
    const nl = normalizeSubLang(lang || label);
    out.push({
      url: u,
      lang: nl.code,
      language: nl.code,
      label: label && String(label).length > 1 && !/^und$/i.test(String(label)) ? String(label) : nl.label,
      format: fmt,
      type: fmt
    });
  };

  // Camino principal Kino: subtitleList[].file[0].url
  const readKinoSubs = (node) => {
    if (!node || typeof node !== 'object') return;
    const episodes = Array.isArray(node.episodeList) ? node.episodeList : [node];
    for (const ep of episodes) {
      if (!ep || typeof ep !== 'object') continue;
      const list = ep.subtitleList || ep.subtitles || node.subtitleList;
      if (!Array.isArray(list)) continue;
      for (const sub of list) {
        if (!sub || typeof sub !== 'object') continue;
        const files = Array.isArray(sub.file) ? sub.file : (sub.file ? [sub.file] : []);
        const file = files[0] || sub;
        const url = (file && (file.url || file.fileUrl || file.src)) || sub.url || sub.fileUrl || '';
        if (!url) continue;
        const lang = sub.language || sub.lang || sub.languageCode || file.language || '';
        const format = (file && (file.fileType || file.format || file.type)) || sub.format || 'srt';
        push(url, lang, lang || 'Subtítulo', format);
      }
    }
  };

  for (const src of sources) {
    if (!src || typeof src !== 'object') continue;
    readKinoSubs(src);

    const lists = [
      src.subtitleList, src.subtitles, src.subs, src.captionList, src.captions,
      src.lanList, src.languageList, src.subtitleInfoList, src.subTitleList,
      src.trackList, src.tracks, src.subtitleTrackList, src.subList
    ];
    for (const list of lists) {
      if (!Array.isArray(list)) continue;
      for (const s of list) {
        if (!s) continue;
        if (typeof s === 'string') {
          push(s, 'es', 'Español');
          continue;
        }
        if (typeof s !== 'object') continue;
        // file[] anidado (formato portal)
        if (Array.isArray(s.file) && s.file[0]) {
          const f = s.file[0];
          const url = f.url || f.fileUrl || f.src || '';
          if (url) {
            push(url, s.language || s.lang || f.language, s.language || s.name || 'Subtítulo', f.fileType || f.format || 'srt');
            continue;
          }
        }
        const url = s.url || s.fileUrl || s.src || s.subtitleUrl || s.subUrl ||
          s.path || s.address || s.downloadUrl || s.playUrl || s.uri || '';
        const lang = s.lang || s.language || s.languageCode || s.code || s.lan || s.iso || '';
        const label = s.label || s.name || s.title || s.languageName || lang;
        const format = s.format || s.type || s.fileType || s.ext || '';
        const kind = String(s.trackType || s.mediaType || s.streamType || '').toLowerCase();
        if (kind && (kind.includes('audio') || kind === 'video')) continue;
        if (url) push(url, lang, label, format);
      }
    }
    if (src.subtitleUrl) push(src.subtitleUrl, src.subtitleLang || src.lang || 'es', src.subtitleName || 'Español');
    if (src.subUrl) push(src.subUrl, 'es', 'Español');
  }
  return out;
}

/** Devuelve { playableId, seasonPortalId } para el capítulo pedido */
async function resolveEpisodePlayable(seriesContentId, season, episode) {
  const sn = Number(season || 1) || 1;
  const en = Number(episode || 1) || 1;

  const tryKeys = (parent) => {
    const pid = episodeContentIds.get(`${parent}:${sn}:${en}`);
    if (!pid) return null;
    const seasonPortalId = episodeSeasonId.get(pid) ||
      seasonContentIds.get(`${parent}:${sn}`) ||
      parent;
    return { playableId: pid, seasonPortalId: String(seasonPortalId) };
  };

  let hit = tryKeys(seriesContentId);
  if (hit) return hit;

  // Buscar otros padres indexados
  for (const key of episodeContentIds.keys()) {
    if (!key.endsWith(`:${sn}:${en}`)) continue;
    const parent = key.split(':')[0];
    hit = tryKeys(parent);
    if (hit) {
      // Alias bajo el id que mandó la app
      episodeContentIds.set(`${seriesContentId}:${sn}:${en}`, hit.playableId);
      if (hit.seasonPortalId) {
        seasonContentIds.set(`${seriesContentId}:${sn}`, hit.seasonPortalId);
        episodeSeasonId.set(hit.playableId, hit.seasonPortalId);
      }
      return hit;
    }
  }

  try {
    // Bypassear caché pública si hace falta datos frescos de otra temporada
    const meta = await _getMeta(seriesContentId, { type: 'series' });
    hit = tryKeys(seriesContentId) || tryKeys(meta && meta.id) || tryKeys(meta && meta.contentId);
    if (hit) return hit;

    if (meta && Array.isArray(meta.seasons)) {
      let foundSeason = meta.seasons.find(x => Number(x.number) === sn);
      if (foundSeason && Array.isArray(foundSeason.episodes)) {
        const foundEp = foundSeason.episodes.find(x => Number(x.number) === en || Number(x.episode) === en);
        if (foundEp && (foundEp.id || foundEp.contentId)) {
          const playableId = String(foundEp.id || foundEp.contentId);
          const seasonPortalId = String(
            foundSeason.contentId ||
            foundEp.seasonContentId ||
            seasonContentIds.get(`${seriesContentId}:${sn}`) ||
            seriesContentId
          );
          episodeContentIds.set(`${seriesContentId}:${sn}:${en}`, playableId);
          episodeParent.set(playableId, String(seriesContentId));
          episodeSeasonId.set(playableId, seasonPortalId);
          seasonContentIds.set(`${seriesContentId}:${sn}`, seasonPortalId);
          return { playableId, seasonPortalId };
        }
      }

      // Cargar la temporada pedida por sibling bajo demanda
      let sibling = (meta.seasonSiblings || []).find(s => {
        const n = Number(s.seasonNumber || s.season || parseSeasonFromName(s.name || s.title || '') || 0);
        return n === sn;
      });
      // Si no hay número, usar el de seasons[contentId]
      if (!sibling && foundSeason && foundSeason.contentId) {
        sibling = { contentId: foundSeason.contentId, id: foundSeason.contentId, seasonNumber: sn };
      }
      if (!sibling) {
        const byIdx = (meta.seasonSiblings || [])[sn - 1];
        if (byIdx) sibling = byIdx;
      }
      if (sibling) {
        const sid = String(sibling.contentId || sibling.id || '');
        if (sid) {
          try {
            const sr = await api('v4/getItemData', {
              contentId: sid,
              type: '0',
              sortType: '0',
              language: 'en',
              macAddr: FIXED_MAC
            });
            const sd = unwrapDetail(sr);
            const eps = episodeRows(sd, seriesContentId, sn, sid);
            const byNum = eps.find(e => Number(e.number) === en);
            if (byNum) {
              return {
                playableId: String(byNum.id),
                seasonPortalId: sid
              };
            }
          } catch (_) {}
        }
      }
    }
  } catch (_) {}

  return { playableId: '', seasonPortalId: '' };
}

async function _getStreams(id, type, season, episode) {
  const parentId = String(id && typeof id === 'object' ? (id.contentId || id.id || id.assetId) : id || '').trim();
  if (!parentId) return [];

  const itemTypeHint = String(type || (id && id.type) || itemKinds.get(parentId) || 'movie').toLowerCase();
  const isSeries = ['series', 'anime', 'tv', 'teleplay', '0'].includes(itemTypeHint);

  let playableId = parentId;
  // Magis espera el contentId de la TEMPORADA (no solo el de la serie genérica)
  let seriesContentId = '';

  if (isSeries) {
    const rootId = String((id && id.seriesContentId) || episodeParent.get(parentId) || parentId);
    // ¿Ya es un contentId de episodio?
    if (episodeSeasonId.has(parentId) || [...episodeContentIds.values()].includes(parentId)) {
      playableId = parentId;
      seriesContentId = episodeSeasonId.get(parentId) || seasonContentIds.get(`${rootId}:${Number(season || 1)}`) || rootId;
    } else {
      const resolved = await resolveEpisodePlayable(rootId, season, episode);
      playableId = resolved.playableId;
      seriesContentId = resolved.seasonPortalId ||
        seasonContentIds.get(`${rootId}:${Number(season || 1)}`) ||
        rootId;
    }
    if (!playableId) return [];
  }

  const play = await api('v10/startPlayVOD', {
    contentId: playableId,
    seriesContentId: seriesContentId || '',
    type: '1',
    startTime: 0,
    columnId: 0,
    authType: ''
  });

  let mediaCandidates = [];
  const episodeList = listFrom(play, ['episodeList']);
  if (episodeList.length) {
    const wanted = Number(episode || 0);
    let selectedEpisode = episodeList.find(ep => Number(ep.seriesNumber || ep.episodeNum || ep.episode || ep.number || 0) === wanted);
    if (!selectedEpisode && playableId) {
      selectedEpisode = episodeList.find(ep => String(ep.contentId || ep.id || '') === playableId);
    }
    if (!selectedEpisode) selectedEpisode = episodeList[0];
    for (const group of listFrom(selectedEpisode, ['totalMovieList'])) {
      mediaCandidates.push(...listFrom(group, ['movieList']));
    }
  }
  if (!mediaCandidates.length) mediaCandidates = listFrom(play, ['mediaList', 'movieList']);
  if (!mediaCandidates.length && play && play.contentId && play.licenseList) mediaCandidates = [play];
  if (!mediaCandidates.length) return [];

  mediaCandidates.sort((a, b) => {
    const score = m => (String(m.encodeFormat || '').toLowerCase() === 'h264' ? 0 : 2) + (String(m.videoFormat || '').toLowerCase() === 'mp4' ? 0 : 1);
    return score(a) - score(b);
  });

  const media = mediaCandidates[0];
  const licenses = listFrom(media, ['licenseList']);
  const license = licenses.length ? String(licenses[0].license || '') : '';
  if (!license) return [];

  const slb = await api('v14/getSlbInfo', {
    hasPay: '0',
    userIdentity: '1',
    type: 'merge',
    appVer: config().apkVersion,
    lang: 'es',
    encMediaSupported: 1,
    liveCodeList: ['masnew_live'],
    appParams: '',
    reserve1: FIXED_MAC,
    pipFlag: '0'
  });

  const cdns = listFrom(slb, ['cdn_list']);
  let chosen = null;
  for (const cdn of cdns) {
    if (String(cdn.tag) !== 'vod') continue;
    for (const u of listFrom(cdn, ['url_list'])) {
      const url = String(u.url || '');
      if (String(u.tag) === 'free' && (url.includes('cfl') || String(u.sign_type) === 'cfl')) {
        chosen = { cdn, u };
        break;
      }
    }
    if (chosen) break;
  }
  if (!chosen) return [];

  const base = String(chosen.cdn.main_addr || '').replace(/\/$/, '');
  const ext = String(media.videoFormat || '').toLowerCase() === 'ts' ? 'ts' : 'mp4';
  const mediaId = String(media.contentId || playableId || parentId);
  const url = `${base}/vod/${mediaId}_media.${ext}`;

  // Subtítulos con URL absoluta (el player descarga sin headers de auth)
  const subtitles = extractSubtitles(
    base,
    play,
    media,
    ...(mediaCandidates || []),
    ...(episodeList || [])
  );

  return [{
    name: 'Magis Service',
    title: 'Magis Service',
    url,
    quality: String(media.definition || media.resolution || 'Auto'),
    type: ext,
    mimeType: ext === 'mp4' ? 'video/mp4' : 'video/mp2t',
    headers: {
      'Content-Auth': String(chosen.u.url),
      'Content-License': license,
      'User-Agent': 'Ranger/4.9.4-17294ac0',
      App: config().appId,
      'App-Version': config().apkVersion
    },
    language: 'Español',
    isHls: false,
    subtitles,
    subs: subtitles,
    captions: subtitles
  }];
}

// ─── API pública ───────────────────────────────────────────────────────────
async function getNews() {
  return cached('public:getNews', 90e3, () => _getNews());
}
async function getHome() {
  return cached('public:getHome', 3 * 60e3, () => _getHome());
}
async function getDiscoverFilters(filters) {
  const opts = filters && typeof filters === 'object' ? filters : {};
  const type = resolveKind(opts.type || opts.kind || 'movie');
  // Cache por tipo para que al cambiar Tipo se recarguen categorías
  return cached('public:getDiscoverFilters:' + type, 8 * 60e3, () => _getDiscoverFilters(opts));
}
async function getDiscover(options) {
  const opts = options && typeof options === 'object' ? options : {};
  // Clave estable: type + category + page
  const type = resolveKind(opts.type || opts.kind || 'movie');
  const cat = String(opts.category || opts.columnId || opts.categoryId || opts.filter || 'all');
  const page = parseInt(opts.page, 10) || 1;
  return cached(`public:getDiscover:${type}:${cat}:${page}`, 90e3, () => _getDiscover(opts));
}
async function getMeta(id, options) {
  const keyId = id && typeof id === 'object' ? (id.contentId || id.id || id.assetId || id.programId || JSON.stringify(id)) : String(id || '');
  const opts = options && typeof options === 'object' ? options : (typeof options === 'string' ? { type: options } : {});
  return cached('public:getMeta:' + String(keyId) + ':' + JSON.stringify(opts), 4 * 60e3, () => _getMeta(id, opts));
}
async function getStreams(id, type, season, episode) {
  const keyId = id && typeof id === 'object' ? (id.contentId || id.id || id.assetId || JSON.stringify(id)) : String(id || '');
  const key = ['public:getStreams', keyId, type || '', season || '', episode || ''].join(':');
  return cached(key, 18e3, () => _getStreams(id, type, season, episode));
}

module.exports = {
  getNews,
  getHome,
  getDiscoverFilters,
  getDiscover,
  getCatalog,
  search,
  getMeta,
  getStreams,
  getCatalogs
};
