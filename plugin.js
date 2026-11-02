/*
 * Magis VOD — repo para XuperTV / Nuvio
 *
 * - Home, Descubrir (filtros), Búsqueda, Meta completa, Streams
 * - Sesión automática vía seeds (el usuario no inicia sesión)
 * - Ficha de serie: TODAS las temporadas con TODOS los capítulos
 * - TMDB opcional (logos/stills), IntroDB solo al reproducir
 * - Rate gap 80 ms, caches, slim list items
 *
 * Requiere CryptoJS en el runtime (la app lo carga al detectar "CryptoJS").
 */
'use strict';

const ADDON_ID = 'magis-vod';
const DEFAULTS = {
  hosts: 'sqacjy.s5lm5aydc.xyz,osuhk.m3x8o50te.com',
  scheme: 'https',
  appId: 'com.android.msandroid',
  apkVersion: '49902',
  desKeyHex: 'e7af1ed7de1ffddd7bd3fe37ebdffde9ef3fe1ae39edfeb8',
  newsLimit: '12',
  tmdbApiKey: 'a2d9bbed370d9f678e34006f8750a5a5',
  tmdbEnrichMeta: true,
  // Seeds: sesión automática (sin activar dispositivo)
  seedsUrl: 'https://raw.githubusercontent.com/xuper-plugin/kino-plugin-xuper/seeds/seeds.json',
  // Máx temporadas a cargar en meta (todas las hermanas)
  maxSeasonsMeta: '30'
};

const API_VERSION = '43404';
const SPKG_VERSION = '2025-08-07 05:40:11_36_16_';
const PORTAL_CODE = 'masnew';
const SN_SALT = 'ntFT65w6itH!lHCPw7D=@qnsFC5adD28';
const FIXED_MAC = '02:00:00:00:00:00';
const HOME = { movies: 'masnew_movies', series: 'masnew_series', anime: 'masnew_anime', featured: 'masnew_featured' };
const ROOT = { movies: '76263', series: '76235', anime: '76209' };

const RATE_GAP_MS = 80;
const PORTAL_TIMEOUT_MS = 4500;
const MAX_CACHE = 180;
const MAX_MAP = 600;

let session = null;
let sessionPromise = null;
let preferredHost = null;
let lastCallAt = 0;
let rateQueue = Promise.resolve();

let _cfgCache = null;
let _cfgCacheAt = 0;
const CFG_CACHE_MS = 30e3;
let _desKey = null;
let _desKeyHex = '';
let _C = null;

const responseCache = new Map();
const inFlight = new Map();
const categoryKinds = new Map();
const itemKinds = new Map();
// parent:season:episode -> episode contentId
const episodeContentIds = new Map();
const episodeParent = new Map();
// parent:seasonNumber -> season contentId (portal)
const seasonContentIds = new Map();
const episodeSeasonId = new Map();
const categoryItemsCache = new Map();
const contentImdbIds = new Map();
const introdbCache = new Map();
const tmdbCache = new Map();

const CACHE_TTL = {
  getHome: 12 * 60e3,
  getNextColumns: 12 * 60e3,
  'v3/getShelveData': 5 * 60e3,
  'v3/getRecommends': 12 * 60e3,
  'v3/searchByName': 40e3,
  'v4/getItemData': 10 * 60e3,
  'v14/getSlbInfo': 15 * 60e3
};

// ─── utils ───────────────────────────────────────────────────────────────────

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
    const wait = Math.max(0, RATE_GAP_MS - (Date.now() - lastCallAt));
    if (wait) await new Promise(r => setTimeout(r, wait));
    lastCallAt = Date.now();
  } finally {
    release();
  }
}

function config() {
  const now = Date.now();
  if (_cfgCache && now - _cfgCacheAt < CFG_CACHE_MS) return _cfgCache;
  let supplied = {};
  try {
    const all = globalThis.__nuvioConfig || {};
    supplied = all[ADDON_ID] || all.current || {};
  } catch (_) {}
  const c = Object.assign({}, DEFAULTS, supplied);
  c.hosts = String(c.hosts || DEFAULTS.hosts).split(/[,;\s]+/).map(s => s.trim()).filter(Boolean);
  c.scheme = String(c.scheme || 'https').replace(':', '');
  c.tmdbEnrichMeta = c.tmdbEnrichMeta !== false && c.tmdbEnrichMeta !== 'false';
  _cfgCache = c;
  _cfgCacheAt = now;
  return c;
}

function cryptoJS() {
  if (_C) return _C;
  if (typeof CryptoJS === 'undefined' || !CryptoJS.TripleDES) {
    throw new Error('CryptoJS no está disponible en el runtime');
  }
  _C = CryptoJS;
  return _C;
}

function desKey() {
  const C = cryptoJS();
  const hex = config().desKeyHex;
  if (_desKey && _desKeyHex === hex) return _desKey;
  _desKey = C.enc.Hex.parse(hex);
  _desKeyHex = hex;
  return _desKey;
}

function encryptBody(value) {
  const C = cryptoJS();
  const encrypted = C.TripleDES.encrypt(String(value), desKey(), {
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
  return C.TripleDES.decrypt(params, desKey(), {
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

// ─── portal ──────────────────────────────────────────────────────────────────

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
        opts.signal = AbortSignal.timeout(PORTAL_TIMEOUT_MS);
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


// ─── seeds (sesión sin activar dispositivo) ──────────────────────────────────

let _seedsCache = null;
let _seedsCacheAt = 0;
const SEEDS_TTL = 30 * 60e3;

async function fetchSeeds() {
  const now = Date.now();
  if (_seedsCache && now - _seedsCacheAt < SEEDS_TTL) return _seedsCache;
  const url = String(config().seedsUrl || DEFAULTS.seedsUrl || '').trim();
  if (!url) return [];
  try {
    const opts = { method: 'GET', headers: { Accept: 'application/json' } };
    if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
      opts.signal = AbortSignal.timeout(10000);
    }
    const res = await fetch(url, opts);
    if (!res.ok) return _seedsCache || [];
    const json = await res.json();
    const list = Array.isArray(json) ? json : (json && Array.isArray(json.seeds) ? json.seeds : []);
    _seedsCache = list.filter(s => s && s.userToken && s.sn);
    _seedsCacheAt = now;
    return _seedsCache;
  } catch (_) {
    return _seedsCache || [];
  }
}

function pickSeed(list) {
  if (!list || !list.length) return null;
  const nowSec = Math.floor(Date.now() / 1000);
  // Preferir seeds no expiradas
  const valid = list.filter(s => {
    const exp = Number(s.exp || 0);
    return !exp || exp > nowSec + 60;
  });
  const pool = valid.length ? valid : list;
  return pool[Math.floor(Math.random() * pool.length)] || null;
}

async function trySessionFromSeeds() {
  // 1) Config manual (usuario pegó token)
  try {
    const c = config();
    if (c.userToken && c.sn) {
      session = {
        sn: String(c.sn),
        userId: String(c.userId || ''),
        userToken: String(c.userToken),
        jwtToken: String(c.jwtToken || '')
      };
      return true;
    }
  } catch (_) {}

  // 2) Seeds remotas
  const seeds = await fetchSeeds();
  const seed = pickSeed(seeds);
  if (!seed) return false;
  session = {
    sn: String(seed.sn || ''),
    userId: String(seed.userId || ''),
    userToken: String(seed.userToken || ''),
    jwtToken: String(seed.jwtToken || '')
  };
  return !!(session.userToken && session.sn);
}


async function ensureSession() {
  if (session && session.userToken) return;
  if (sessionPromise) return sessionPromise;

  sessionPromise = (async () => {
    if (typeof CryptoJS === 'undefined') {
      throw new Error('El runtime no ha cargado CryptoJS; revisa que el addon mencione CryptoJS.');
    }

    // Preferir seeds / config (usuario no genera sesión)
    const fromSeed = await trySessionFromSeeds();
    if (fromSeed && session && session.userToken) return;

    // Fallback: activación clásica
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

// ─── parse helpers ───────────────────────────────────────────────────────────

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
  let poster = String(raw.poster || raw.posterUrl || raw.pic || raw.cover || raw.image || '').trim();
  let backdrop = String(raw.backdrop || raw.backdropUrl || raw.background || '').trim();
  for (const img of images) {
    if (!img || typeof img !== 'object') continue;
    const kind = String(img.fileType || img.type || '').toLowerCase();
    const url = String(img.fileUrl || img.url || img.picUrl || '').trim();
    if (!url) continue;
    if (['v_poster', 'icon', 'cover', 'thumb', 'vertical'].includes(kind)) {
      if (!poster) poster = url;
    } else if (['poster', 'h_poster', 'backdrop', 'background', 'banner', 'horizontal'].includes(kind)) {
      if (!backdrop) backdrop = url;
    } else if (!poster) {
      poster = url;
    } else if (!backdrop) {
      backdrop = url;
    }
  }
  if (!backdrop && poster) backdrop = poster;
  if (!poster && backdrop) poster = backdrop;

  const programType = String(raw.programType || raw.contentType || raw.type || raw.mediaType || 'movie').toLowerCase();
  const explicitMovie = ['movie', 'film', '1', 'cinema', 'feature'].includes(programType);
  let type = forcedType || (!explicitMovie && ['teleplay', 'series', 'variety', '0'].includes(programType) ? 'series' : 'movie');
  if (type === 'movies') type = 'movie';
  if (type === 'animation') type = 'anime';

  const name = String(raw.name || raw.viewPoint || raw.alias || raw.title || raw.contentName || raw.programName || raw.assetName || raw.contentId || raw.id || 'Sin título');
  const release = String(raw.releaseTime || raw.year || raw.releaseDate || raw.publishTime || raw.firstAirDate || '');
  const genres = raw.genres || raw.genreList || raw.categoryList || raw.categoryNameList || raw.categoryName || raw.genre || raw.tags || [];

  // NO copiar raw completo (Object.assign({}, raw, ...)) — eso hincha memoria en listas
  const item = {
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
  };

  if (raw.score != null) item.rating = Number(raw.score) || null;
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
    let items = [];
    if (Array.isArray(r.assetList) && r.assetList.length) {
      items = r.assetList.filter(x => x && typeof x === 'object').map(x => normalizeItem(x, forcedType));
    } else {
      items = flattenItems(r, forcedType);
    }
    const code = String(r.columnCode || r.recommendCode || r.code || '');
    const rawCol = r.columnId ?? r.column_id ?? r.sectionId ?? r.recommendId ?? r.id;
    const shelveId = /^\d+$/.test(String(rawCol || '')) ? String(rawCol) : '';
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

/** Ítem mínimo para listas (estilo Kino) */
function slimListItem(it, opts) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const withBackdrop = o.withBackdrop !== false;
  const id = String(it.contentId || it.id || '').trim();
  const type = it.type === 'anime' || it.media_type === 'anime'
    ? 'anime'
    : (it.type === 'series' || it.media_type === 'series' || it.programType === 'series' || it.programType === 'teleplay')
      ? 'series'
      : (it.type === 'movie' || it.media_type === 'movie' ? 'movie' : (itemType(it) || 'movie'));
  const title = String(it.title || it.name || id || 'Sin título');
  const poster = String(it.poster || it.image || '').trim();
  const backdrop = String(it.backdrop || it.background || poster).trim();
  const out = {
    id,
    contentId: id,
    title,
    name: title,
    type,
    media_type: type,
    programType: type === 'series' ? 'series' : type === 'anime' ? 'anime' : 'movie',
    poster,
    image: poster || backdrop
  };
  if (withBackdrop) {
    out.backdrop = backdrop || poster;
    out.background = backdrop || poster;
  }
  if (it.year) out.year = it.year;
  if (id) {
    itemKinds.set(id, type);
    limitMap(itemKinds, MAX_MAP);
  }
  return out;
}

function categoryKindsFromRows(rows, kind) {
  for (const row of rows) {
    if (row.id) { categoryKinds.set(String(row.id), kind); limitMap(categoryKinds, MAX_MAP); }
    if (row.code) { categoryKinds.set(String(row.code), kind); limitMap(categoryKinds, MAX_MAP); }
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

function resolveKind(raw) {
  const s = String(raw || '').toLowerCase();
  if (s.includes('anime') || s.includes('anim')) return 'anime';
  if (s.includes('series') || s === '0' || s === 'tv') return 'series';
  if (s.includes('all')) return 'all';
  if (s.includes('movie') || s === '1' || s === 'film') return 'movies';
  return 'movies';
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

const HOME_MAX_ITEMS_PER_ROW = 12;

// ─── Home / Discover (liviano) ───────────────────────────────────────────────

function rememberCategoryRow(row, kind) {
  const key = String(row.id || row.code || '');
  if (!key) return;
  const entry = {
    items: [],
    kind,
    title: row.title || row.name || key,
    code: row.code || '',
    shelveId: row.shelveId || (/^\d+$/.test(key) ? key : '')
  };
  categoryItemsCache.set(key, entry);
  if (row.code && String(row.code) !== key) categoryItemsCache.set(String(row.code), entry);
  if (entry.shelveId && entry.shelveId !== key) categoryItemsCache.set(entry.shelveId, entry);
  limitMap(categoryItemsCache, MAX_MAP);
}

async function fetchShelvePage(columnId, forcedType, page, pageSize) {
  const idNum = Number(columnId);
  if (!Number.isFinite(idNum) || idNum <= 0) {
    return { items: [], page, hasMore: false, total: 0 };
  }
  try {
    const data = await api('v3/getShelveData', {
      columnId: idNum,
      columnType: '2',
      pageNum: page,
      pageSize,
      encryptVersion: 0
    });
    let items = [];
    if (Array.isArray(data.assetList)) {
      items = data.assetList.filter(x => x && typeof x === 'object').map(x => normalizeItem(x, forcedType));
    }
    if (!items.length) items = flattenItems(data, forcedType);
    items = unique(items).map(it => {
      const slim = slimListItem(Object.assign({}, it, { type: forcedType || itemType(it) }), { withBackdrop: false });
      slim.imageStyle = 'poster';
      return slim;
    });
    const totalRaw = data.assetListTotalSize ?? data.listTotalSize ?? data.totalSize ?? data.total ?? data.count;
    const pageItems = items.length > pageSize ? items.slice(0, pageSize) : items;
    const total = totalRaw != null
      ? Number(totalRaw)
      : (page - 1) * pageSize + pageItems.length + (pageItems.length >= 10 ? pageSize : 0);
    const hasMore = totalRaw != null
      ? page * pageSize < Number(totalRaw)
      : pageItems.length >= 10;
    return { items: pageItems, page, hasMore, total: Number(total) || pageItems.length };
  } catch (_) {
    return { items: [], page, hasMore: false, total: 0 };
  }
}

async function categoryRows(kind) {
  const code = HOME[kind] || HOME.movies;
  const forcedType = kind === 'series' ? 'series' : kind === 'anime' ? 'anime' : 'movie';
  return cached('categoryRows:' + kind, CACHE_TTL.getNextColumns, async () => {
    try {
      const data = await api('getNextColumns', {
        columnCode: code,
        pageNum: 1,
        pageSize: 20,
        version: ''
      });
      const rows = normalizeRows(data, kindLabel(kind), forcedType);
      const usable = rows
        .filter(r => r.id || r.code || r.shelveId || (r.items && r.items.length))
        .map(r => ({
          id: r.id,
          code: r.code || '',
          shelveId: r.shelveId || (/^\d+$/.test(String(r.id || '')) ? String(r.id) : ''),
          title: r.title || r.name || '',
          name: r.name || r.title || '',
          items: []
        }));
      if (usable.length) {
        categoryKindsFromRows(usable, kind);
        for (const row of usable) rememberCategoryRow(row, kind);
        return usable;
      }
    } catch (_) {}
    return [];
  });
}

async function _getHome() {
  // 3 ROOT en paralelo + hero — sin cascada getNextColumns/getHome
  const specs = [
    { kind: 'movies', root: ROOT.movies, title: 'Últimas películas', forced: 'movie' },
    { kind: 'series', root: ROOT.series, title: 'Últimas series', forced: 'series' },
    { kind: 'anime', root: ROOT.anime, title: 'Últimas animaciones', forced: 'anime' }
  ];
  const pageSize = HOME_MAX_ITEMS_PER_ROW;

  const pages = await Promise.all(specs.map(async (s) => {
    try {
      const page = await fetchShelvePage(s.root, s.forced, 1, pageSize);
      const items = unique(page.items || []).slice(0, pageSize).map(it => slimListItem(it, { withBackdrop: true }));
      return { spec: s, items };
    } catch (_) {
      return { spec: s, items: [] };
    }
  }));

  const rows = [];
  const heroPool = [];

  for (const { spec, items } of pages) {
    if (!items.length) continue;
    heroPool.push(...items.slice(0, 4));
    rows.push({
      id: String(spec.root),
      code: HOME[spec.kind] || '',
      shelveId: String(spec.root),
      title: spec.title,
      name: spec.title,
      type: 'row',
      categoryType: spec.forced,
      category: spec.title,
      imageStyle: 'poster',
      items
    });
  }

  const limit = Math.max(1, Math.min(8, parseInt(config().newsLimit, 10) || 8));
  const newsItems = unique(heroPool).slice(0, limit).map((it, i) =>
    Object.assign({}, slimListItem(it, { withBackdrop: true }), {
      section: 'novedades',
      news: true,
      newsRank: i + 1
    })
  );
  if (newsItems.length) {
    rows.unshift({
      id: 'novedades',
      code: 'novedades',
      title: 'Novedades',
      name: 'Novedades',
      type: 'hero',
      imageStyle: 'backdrop',
      items: newsItems
    });
  }
  return rows;
}

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
      const id = String(row.shelveId || (/^\d+$/.test(String(row.id || '')) ? row.id : ''));
      if (!id || !/^\d+$/.test(id) || seen.has(id)) continue;
      seen.add(id);
      categoryKinds.set(id, kinds[i]);
      limitMap(categoryKinds, MAX_MAP);
      options.push({
        id,
        label: row.title || row.name || kindLabel(kinds[i]),
        columnId: id,
        columnCode: String(row.code || ''),
        type: kinds[i] === 'movies' ? 'movie' : kinds[i]
      });
    }
  }
  for (const k of kinds) {
    const rootId = String(ROOT[k] || ROOT.movies);
    if (seen.has(rootId)) continue;
    seen.add(rootId);
    categoryKinds.set(rootId, k);
    options.unshift({
      id: rootId,
      label: kindLabel(k) + ' (Todos)',
      columnId: rootId,
      columnCode: HOME[k] || '',
      type: k === 'movies' ? 'movie' : k
    });
  }
  return [
    { id: 'type', name: 'Tipo', label: 'Tipo', type: 'select', options: types },
    { id: 'category', name: 'Categoría', label: 'Categoría', type: 'select', options }
  ];
}

async function _getDiscover(options) {
  const opts = options && typeof options === 'object' ? options : {};
  const kind = resolveKind(opts.type || opts.kind || 'movie');
  const page = Math.max(1, parseInt(opts.page, 10) || 1);
  const pageSize = Math.min(40, Math.max(10, parseInt(opts.pageSize, 10) || 20));
  const rootKey = kind === 'anime' ? 'anime' : kind === 'series' ? 'series' : 'movies';
  const forcedType = rootKey === 'series' ? 'series' : rootKey === 'anime' ? 'anime' : 'movie';

  let selected = String(
    opts.columnId || opts.categoryId || opts.category || opts.genre || opts.filter || ''
  ).trim();
  if (!selected || selected === 'all' || selected === 'Todas las categorías' || selected === 'undefined' ||
      selected === 'null' || selected === 'type' || selected === 'movie' || selected === 'series' ||
      selected === 'anime' || selected === 'movies') {
    selected = '';
  }

  let shelveId = '';
  if (selected && /^\d+$/.test(selected)) {
    shelveId = selected;
  } else if (selected) {
    const rows = await categoryRows(rootKey).catch(() => []);
    const found = rows.find(r =>
      String(r.id) === selected || String(r.code) === selected ||
      String(r.shelveId || '') === selected || r.title === selected || r.name === selected
    );
    if (found) shelveId = String(found.shelveId || (/^\d+$/.test(String(found.id || '')) ? found.id : ''));
    const cached = categoryItemsCache.get(selected);
    if (!shelveId && cached && cached.shelveId) shelveId = String(cached.shelveId);
  }
  if (!shelveId || !/^\d+$/.test(shelveId)) {
    shelveId = String(ROOT[rootKey] || ROOT.movies);
  }

  const pageResult = await fetchShelvePage(shelveId, forcedType, page, pageSize);
  if (pageResult.items.length || pageResult.hasMore) {
    pageResult.items = (pageResult.items || []).map(it => {
      const slim = slimListItem(it, { withBackdrop: false });
      slim.imageStyle = 'poster';
      return slim;
    });
    return pageResult;
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
    }))).map(it => slimListItem(it, { withBackdrop: true }));

    const remember = (items, kind) => items.map(it => {
      const id = String(it.contentId || it.id || '');
      if (id) { itemKinds.set(id, kind); limitMap(itemKinds, MAX_MAP); }
      return Object.assign(it, { type: kind, media_type: kind });
    });

    if (requested === 'anime' || requested === 'animacion' || requested === 'animation') {
      try { return remember((await find('0')).filter(it => isAnime(it)), 'anime'); } catch (_) { return []; }
    }
    if (requested === 'movie' || requested === 'movies') {
      try { return remember(await find('1'), 'movie'); } catch (_) { return []; }
    }
    if (requested === 'series') {
      try { return remember(await find('0'), 'series'); } catch (_) { return []; }
    }
    const results = await Promise.all([find('1').catch(() => []), find('0').catch(() => [])]);
    return unique([...results[0], ...results[1]]).map(it => {
      const kind = itemType(it);
      const id = String(it.contentId || it.id || '');
      if (id) { itemKinds.set(id, kind); limitMap(itemKinds, MAX_MAP); }
      return Object.assign(it, { type: kind, media_type: kind });
    });
  });
}

// ─── Episodes / seasons (estilo Kino: 1 llamada) ─────────────────────────────

function unwrapDetail(response) {
  let data = response;
  for (let i = 0; i < 5 && data && typeof data === 'object'; i++) {
    if (data.assetData && typeof data.assetData === 'object') { data = data.assetData; continue; }
    if (data.item && typeof data.item === 'object') { data = data.item; continue; }
    if (data.result && typeof data.result === 'object') { data = data.result; continue; }
    if (data.data && typeof data.data === 'object' && !data.contentId && !data.name && !data.title && !data.programType) {
      data = data.data; continue;
    }
    break;
  }
  return data && typeof data === 'object' ? data : {};
}

/** Extrae poster (vertical) y backdrop (horizontal) del asset Magis. */
function imagesFromAsset(data) {
  let poster = '';
  let backdrop = '';
  const loosePoster = String(data && (data.poster || data.posterUrl || data.pic || data.cover || data.image) || '').trim();
  const looseBack = String(data && (data.backdrop || data.backdropUrl || data.background || data.banner) || '').trim();
  if (loosePoster) poster = loosePoster;
  if (looseBack) backdrop = looseBack;
  const list = (data && (data.posterList || data.posters || data.imageList)) || [];
  if (Array.isArray(list)) {
    for (const img of list) {
      if (!img || typeof img !== 'object') continue;
      const kind = String(img.fileType || img.type || '').toLowerCase();
      const url = String(img.fileUrl || img.url || img.picUrl || '').trim();
      if (!url) continue;
      if (['v_poster', 'icon', 'cover', 'thumb', 'vertical'].includes(kind)) {
        if (!poster) poster = url;
      } else if (['poster', 'h_poster', 'backdrop', 'background', 'banner', 'horizontal'].includes(kind)) {
        if (!backdrop) backdrop = url;
      } else if (!poster) {
        poster = url;
      } else if (!backdrop) {
        backdrop = url;
      }
    }
  }
  // Si solo hay uno, reutilizarlo (la UI de detalle necesita backdrop)
  if (!backdrop && poster) backdrop = poster;
  if (!poster && backdrop) poster = backdrop;
  return { poster, backdrop };
}

function parseSeasonFromName(name) {
  const s = String(name || '');
  // Orden: "Temporada 3", "Season 3", "Temp. 3", "T3", "T 3", "S03", al final del título
  const patterns = [
    /(?:temporada|season|temp\.?)\s*(\d{1,2})\b/i,
    /(?:^|[\s_\-])T\s*(\d{1,2})(?:\b|$)/i,
    /(?:^|[\s_\-])S\s*0*(\d{1,2})(?:\b|$)/i,
    /\b(\d{1,2})ª\s*temporada\b/i
  ];
  for (const re of patterns) {
    const m = s.match(re);
    if (m) {
      const n = Number(m[1]);
      if (n >= 1 && n <= 50) return n;
    }
  }
  return 0;
}

/** Número de temporada más fiable de un asset Magis (campo numérico > título). */
function seasonNumberOf(obj, fallback = 0) {
  if (!obj || typeof obj !== 'object') return fallback;
  const direct = Number(obj.seasonNumber ?? obj.season ?? obj.seasonNum ?? 0);
  if (Number.isFinite(direct) && direct >= 1 && direct <= 50) return direct;
  const fromName = parseSeasonFromName(obj.name || obj.title || obj.viewPoint || obj.alias || '');
  return fromName || fallback;
}

function episodeRows(data, seriesId, defaultSeason, seasonPortalId) {
  const raw = listFrom(data, ['simpleProgramList', 'episodeList', 'episodes', 'programList', 'movieList', 'assetList']);
  const seasonPortal = String(seasonPortalId || seriesId || '');
  return raw.map((ep, j) => {
    const number = Number(ep.seriesNumber || ep.episodeNum || ep.episodeNo || ep.episode || ep.number || j + 1) || j + 1;
    const id = String(ep.contentId || ep.id || ep.movieId || ep.assetId || '');
    if (!id) return null;
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
      still: String(ep.poster || ep.posterUrl || ''),
      poster: String(ep.poster || ep.posterUrl || ''),
      season,
      seriesContentId: String(seriesId || ''),
      seasonContentId: seasonPortal
    };
  }).filter(Boolean);
}

// ─── TMDB (opcional, liviano, no bloquea) ────────────────────────────────────

const TMDB_BASE = 'https://api.themoviedb.org/3';
const TMDB_IMG = 'https://image.tmdb.org/t/p';

function tmdbKey() {
  try {
    return String(config().tmdbApiKey || '').trim() || 'a2d9bbed370d9f678e34006f8750a5a5';
  } catch (_) {
    return 'a2d9bbed370d9f678e34006f8750a5a5';
  }
}

async function tmdbGet(path, params) {
  const key = tmdbKey();
  if (!key) return null;
  const q = Object.assign({ api_key: key, language: 'es-MX' }, params || {});
  const qs = Object.keys(q).map(k => encodeURIComponent(k) + '=' + encodeURIComponent(String(q[k]))).join('&');
  const ck = 'tmdb:' + path + ':' + qs;
  const hit = tmdbCache.get(ck);
  if (hit && hit.expires > Date.now()) return hit.value;
  try {
    const opts = { method: 'GET', headers: { Accept: 'application/json' } };
    if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
      opts.signal = AbortSignal.timeout(6000);
    }
    const res = await fetch(TMDB_BASE + path + '?' + qs, opts);
    if (!res.ok) return null;
    const json = await res.json();
    tmdbCache.set(ck, { value: json, expires: Date.now() + 40 * 60e3 });
    limitMap(tmdbCache, 80);
    return json;
  } catch (_) {
    return null;
  }
}

function tmdbImg(path, size) {
  if (!path || path === 'null') return '';
  return TMDB_IMG + '/' + (size || 'w300') + path;
}

function pickLogo(images) {
  if (!images || !Array.isArray(images.logos) || !images.logos.length) return '';
  const logos = images.logos.filter(l => l && l.file_path);
  if (!logos.length) return '';
  const rank = (l) => {
    const lang = String(l.iso_639_1 || '');
    if (lang === 'es') return 0;
    if (!lang) return 1;
    if (lang === 'en') return 2;
    return 3;
  };
  logos.sort((a, b) => rank(a) - rank(b) || (b.vote_average || 0) - (a.vote_average || 0));
  return tmdbImg(logos[0].file_path, 'w500');
}

function cleanTitleForSearch(name) {
  return String(name || '')
    .replace(/\s*[Tt]emp(orada)?\.?\s*\d+.*$/i, '')
    .replace(/\s*[Ss]eason\s*\d+.*$/i, '')
    .replace(/\s*\(\d{4}\)\s*$/, '')
    .replace(/\s*[-–—]\s*(Latino|Castellano|Español|Sub\w*).*$/i, '')
    .replace(/\s+(español|castellano|latino|latam|subtitulado|doblado|dual|sub|hd|4k|\d{3,4}p)\s*$/i, '')
    .trim();
}

async function resolveTmdbId(item, isTv) {
  const imdb = String(
    (item.details && (item.details.keyWords || item.details.imdbId || item.details.imdb)) ||
    item.imdb || item.imdbId || item.keyWords || ''
  ).trim();
  if (/^tt\d{7,}$/i.test(imdb)) {
    const find = await tmdbGet('/find/' + imdb, { external_source: 'imdb_id' });
    if (isTv) {
      const tv = find && Array.isArray(find.tv_results) && find.tv_results[0];
      if (tv && tv.id) return Number(tv.id) || 0;
    } else {
      const mov = find && Array.isArray(find.movie_results) && find.movie_results[0];
      if (mov && mov.id) return Number(mov.id) || 0;
    }
  }
  const title = cleanTitleForSearch(item.title || item.name);
  if (title.length < 2) return 0;
  const year = String(item.year || '').slice(0, 4);
  if (isTv) {
    const search = await tmdbGet('/search/tv', { query: title });
    const hit = search && Array.isArray(search.results) && search.results[0];
    return hit && hit.id ? Number(hit.id) || 0 : 0;
  }
  const params = { query: title };
  if (/^\d{4}$/.test(year)) params.year = year;
  const search = await tmdbGet('/search/movie', params);
  const hit = search && Array.isArray(search.results) && search.results[0];
  return hit && hit.id ? Number(hit.id) || 0 : 0;
}

/**
 * Enriquecimiento TMDB liviano (estilo Kino):
 * - Solo temporada(s) ya presentes en item.seasons (no pide otras)
 * - Logo + overview/poster de serie/película
 * - Stills/títulos de capítulos ya listados por Magis
 * - SIN IntroDB aquí
 */
async function enrichMetaLight(item) {
  if (!item || !config().tmdbEnrichMeta) return item;
  try {
    const isSeries = item.type === 'series' || item.type === 'anime' ||
      (Array.isArray(item.seasons) && item.seasons.length > 0);

    if (isSeries) {
      const tvId = await resolveTmdbId(item, true);
      if (!tvId) return item;

      // detail + images en paralelo (2 llamadas, no external_ids salvo que haga falta imdb)
      const [detail, images] = await Promise.all([
        tmdbGet('/tv/' + tvId, {}),
        tmdbGet('/tv/' + tvId + '/images', { include_image_language: 'es,en,null' })
      ]);

      let imdbId = String(
        (item.details && (item.details.keyWords || item.details.imdbId || item.details.imdb)) ||
        item.imdb || item.imdbId || ''
      ).trim();
      if (!/^tt\d{7,}$/i.test(imdbId) && detail) {
        // external_ids solo si no tenemos imdb
        try {
          const ext = await tmdbGet('/tv/' + tvId + '/external_ids', {});
          const e = ext && String(ext.imdb_id || '').trim();
          if (/^tt\d{7,}$/i.test(e)) imdbId = e;
        } catch (_) {}
      }
      if (/^tt\d{7,}$/i.test(imdbId)) {
        item.imdbId = imdbId;
        item.imdb = imdbId;
        contentImdbIds.set(String(item.id || item.contentId || ''), imdbId);
        limitMap(contentImdbIds, MAX_MAP);
      }

      const logo = pickLogo(images);
      if (logo) { item.logo = logo; item.clearlogo = logo; }
      if (detail) {
        item.tmdbId = tvId;
        if (!item.overview && detail.overview) {
          item.overview = String(detail.overview);
          item.description = item.overview;
        }
        if (!item.backdrop && detail.backdrop_path) {
          item.backdrop = tmdbImg(detail.backdrop_path, 'w1280');
          item.background = item.backdrop;
        }
        if ((!item.poster || !item.poster.length) && detail.poster_path) {
          item.poster = tmdbImg(detail.poster_path, 'w500');
          item.image = item.poster;
        }
        if (detail.name) item.tmdbTitle = String(detail.name);
      }

      // Temporadas ya cargadas en meta (todas las que traen episodios)
      const seasons = (item.seasons || []).filter(s => s && Array.isArray(s.episodes) && s.episodes.length).slice(0, 8);
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
          const tmdbName = String(te.name || '').trim();
          if (tmdbName) { ep.title = tmdbName; ep.name = tmdbName; }
          const ov = String(te.overview || '').trim();
          if (ov) { ep.overview = ov; ep.description = ov; }
          const still = tmdbImg(te.still_path, 'w300');
          if (still) { ep.still = still; ep.poster = still; ep.image = still; }
          const rt = Number(te.runtime);
          if (rt > 0 && rt < 1000) { ep.runtime = rt; ep.duration = rt; }
          if (te.air_date) { ep.airDate = String(te.air_date); ep.air_date = ep.airDate; }
        }
      }));

      if (Array.isArray(item.episodes) && item.seasons && item.seasons.length) {
        const curSn = Number((item.episodes[0] && item.episodes[0].season) || 1) || 1;
        const cur = item.seasons.find(s => Number(s.number) === curSn) || item.seasons[0];
        if (cur && cur.episodes && cur.episodes.length) item.episodes = cur.episodes;
      }
    } else {
      // Película: logo + overview/poster (sin IntroDB)
      const movieId = await resolveTmdbId(item, false);
      if (!movieId) return item;
      const [detail, images] = await Promise.all([
        tmdbGet('/movie/' + movieId, {}),
        tmdbGet('/movie/' + movieId + '/images', { include_image_language: 'es,en,null' })
      ]);
      let imdbId = String(
        (item.details && (item.details.keyWords || item.details.imdbId || item.details.imdb)) ||
        item.imdb || item.imdbId || ''
      ).trim();
      if (!/^tt\d{7,}$/i.test(imdbId)) {
        try {
          const ext = await tmdbGet('/movie/' + movieId + '/external_ids', {});
          const e = ext && String(ext.imdb_id || '').trim();
          if (/^tt\d{7,}$/i.test(e)) imdbId = e;
        } catch (_) {}
      }
      if (/^tt\d{7,}$/i.test(imdbId)) {
        item.imdbId = imdbId;
        item.imdb = imdbId;
        contentImdbIds.set(String(item.id || item.contentId || ''), imdbId);
        limitMap(contentImdbIds, MAX_MAP);
      }
      const logo = pickLogo(images);
      if (logo) { item.logo = logo; item.clearlogo = logo; }
      if (detail) {
        item.tmdbId = movieId;
        if (!item.overview && detail.overview) {
          item.overview = String(detail.overview);
          item.description = item.overview;
        }
        if (!item.backdrop && detail.backdrop_path) {
          item.backdrop = tmdbImg(detail.backdrop_path, 'w1280');
          item.background = item.backdrop;
        }
        if ((!item.poster || !item.poster.length) && detail.poster_path) {
          item.poster = tmdbImg(detail.poster_path, 'w500');
          item.image = item.poster;
        }
        if (detail.runtime > 0) item.runtime = Number(detail.runtime);
      }
    }
  } catch (_) {}
  return item;
}

// ─── IntroDB solo en play ────────────────────────────────────────────────────

function introdbCacheKey(imdbId, season, episode, isMovie) {
  const id = String(imdbId || '').toLowerCase();
  if (isMovie) return id + ':movie';
  return id + ':s' + Number(season || 1) + 'e' + Number(episode || 1);
}

function rangeFromSegment(seg) {
  if (!seg || typeof seg !== 'object') return null;
  const a = Number(seg.start_sec);
  const b = Number(seg.end_sec);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) return null;
  return [Math.floor(a), Math.ceil(b)];
}

async function fetchIntroDbSegments(imdbId, season, episode, isMovie) {
  const id = String(imdbId || '').trim();
  if (!/^tt\d{7,}$/i.test(id)) return null;
  const ck = introdbCacheKey(id, season, episode, isMovie);
  const hit = introdbCache.get(ck);
  if (hit !== undefined) return hit;

  let url = 'https://api.introdb.app/segments?imdb_id=' + encodeURIComponent(id);
  if (!isMovie) {
    url += '&season=' + encodeURIComponent(String(Number(season || 1) || 1));
    url += '&episode=' + encodeURIComponent(String(Number(episode || 1) || 1));
  }
  try {
    const opts = { method: 'GET', headers: { Accept: 'application/json' } };
    if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
      opts.signal = AbortSignal.timeout(4500);
    }
    const res = await fetch(url, opts);
    if (!res.ok) {
      introdbCache.set(ck, null);
      limitMap(introdbCache, 300);
      return null;
    }
    const json = await res.json();
    const intro = rangeFromSegment(json && json.intro);
    const outro = rangeFromSegment(json && json.outro);
    const segments = {};
    if (intro) segments.intro = intro;
    if (outro) segments.outro = outro;
    const out = (segments.intro || segments.outro) ? segments : null;
    introdbCache.set(ck, out);
    limitMap(introdbCache, 300);
    return out;
  } catch (_) {
    introdbCache.set(ck, null);
    limitMap(introdbCache, 300);
    return null;
  }
}

// ─── Meta liviana (1 getItemData) ────────────────────────────────────────────

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
    // Episodios SOLO de este contentId (la temporada a la que entró)
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

    // Backdrop / poster: forzar desde posterList del portal (muchas fichas solo traen ahí el horizontal)
    const imgs = imagesFromAsset(data);
    if (imgs.poster) {
      item.poster = imgs.poster;
      item.image = imgs.poster;
    }
    if (imgs.backdrop) {
      item.backdrop = imgs.backdrop;
      item.background = imgs.backdrop;
    } else if (item.poster) {
      item.backdrop = item.poster;
      item.background = item.poster;
    }
    // Si el seed (tarjeta de lista) traía backdrop y el detalle no, conservarlo
    if (seed) {
      const seedBack = String(seed.backdrop || seed.background || '').trim();
      const seedPoster = String(seed.poster || seed.image || '').trim();
      if (!item.backdrop && seedBack) {
        item.backdrop = seedBack;
        item.background = seedBack;
      }
      if (!item.poster && seedPoster) {
        item.poster = seedPoster;
        item.image = seedPoster;
      }
    }

    // Guardar imdb del portal si viene
    const portalImdb = String(data.keyWords || data.imdbId || data.imdb || '').trim();
    if (/^tt\d{7,}$/i.test(portalImdb)) {
      item.imdb = portalImdb;
      item.imdbId = portalImdb;
      contentImdbIds.set(item.id, portalImdb);
      limitMap(contentImdbIds, MAX_MAP);
    }

    const siblings = Array.isArray(data.sameSeasonSeriesList) ? data.sameSeasonSeriesList : [];
    // Número de la temporada abierta: campo portal > título > default (nunca forzar 1 si el título dice T3)
    const currentSeason = seasonNumberOf(data, parseSeasonFromName(item.title) || defaultSeason || 1) || 1;

    // Serie completa con números fiables. Si el portal no numera, TMDB ordena después.
    const seasons = [];
    if (isSeries) {
      const seriesRootId = contentId;
      const byNumber = new Map(); // seasonNum -> season object
      const pending = []; // { id, number, name, known }

      const currentEps = simple.slice().sort((a, b) => a.number - b.number);
      // Marcar episodios con la temporada correcta
      for (const ep of currentEps) {
        ep.season = currentSeason;
        ep.seriesContentId = seriesRootId;
        ep.seasonContentId = contentId;
      }
      byNumber.set(currentSeason, {
        number: currentSeason,
        season: currentSeason,
        name: `Temporada ${currentSeason}`,
        title: `Temporada ${currentSeason}`,
        episodes: currentEps,
        contentId: contentId,
        current: true,
        known: !!(data.seasonNumber || data.season || parseSeasonFromName(item.title))
      });
      seasonContentIds.set(`${seriesRootId}:${currentSeason}`, contentId);

      for (const sibling of siblings) {
        const sid = String(sibling.contentId || sibling.id || '').trim();
        if (!sid || sid === contentId) continue;
        const sn = seasonNumberOf(sibling, 0);
        pending.push({
          id: sid,
          number: sn,
          name: String(sibling.name || sibling.viewPoint || sibling.title || ''),
          known: sn > 0
        });
      }

      // Asignar números solo a los que NO tienen número conocido (al final, sin pisar T1/T2/T3 reales)
      const used = new Set(byNumber.keys());
      for (const p of pending) if (p.known) used.add(p.number);
      let auto = 1;
      for (const p of pending) {
        if (p.known) continue;
        while (used.has(auto)) auto++;
        p.number = auto;
        used.add(auto);
        auto++;
        if (!p.name) p.name = `Temporada ${p.number}`;
      }
      // Los conocidos sin nombre
      for (const p of pending) {
        if (!p.name) p.name = `Temporada ${p.number}`;
      }

      // Cargar episodios de hermanas en paralelo (máx 8)
      const maxSeasons = Math.min(40, Math.max(1, parseInt(config().maxSeasonsMeta, 10) || 30));
      await Promise.all(pending.slice(0, maxSeasons).map(async (link) => {
        try {
          const sr = await api('v4/getItemData', {
            contentId: link.id,
            type: '0',
            sortType: '0',
            language: 'en',
            macAddr: FIXED_MAC
          });
          const sd = unwrapDetail(sr);
          // Preferir número del sibling; si el detalle trae uno claro y el link era auto, usar el del detalle
          let seasonNum = link.number;
          const fromDetail = seasonNumberOf(sd, 0);
          if (fromDetail > 0 && (link.known || !byNumber.has(fromDetail))) {
            seasonNum = fromDetail;
            link.number = fromDetail;
            link.known = true;
          }
          let eps = episodeRows(sd, seriesRootId, seasonNum, link.id);
          eps = eps.map(ep => Object.assign({}, ep, {
            season: seasonNum,
            seriesContentId: seriesRootId,
            seasonContentId: link.id
          }));
          seasonContentIds.set(`${seriesRootId}:${seasonNum}`, link.id);
          seasonContentIds.set(`${link.id}:${seasonNum}`, link.id);
          for (const ep of eps) {
            const eid = String(ep.id || ep.contentId || '');
            if (!eid) continue;
            episodeContentIds.set(`${seriesRootId}:${seasonNum}:${Number(ep.number)}`, eid);
            episodeContentIds.set(`${link.id}:${seasonNum}:${Number(ep.number)}`, eid);
            episodeParent.set(eid, String(seriesRootId));
            episodeSeasonId.set(eid, link.id);
          }
          // No pisar la temporada actual si coincide el número
          if (byNumber.has(seasonNum) && byNumber.get(seasonNum).current) return;
          byNumber.set(seasonNum, {
            number: seasonNum,
            season: seasonNum,
            name: link.name || `Temporada ${seasonNum}`,
            title: link.name || `Temporada ${seasonNum}`,
            episodes: eps.sort((a, b) => a.number - b.number),
            contentId: link.id,
            current: false,
            known: link.known
          });
        } catch (_) {
          if (!byNumber.has(link.number)) {
            byNumber.set(link.number, {
              number: link.number,
              season: link.number,
              name: link.name || `Temporada ${link.number}`,
              title: link.name || `Temporada ${link.number}`,
              episodes: [],
              contentId: link.id,
              current: false,
              known: link.known
            });
          }
        }
      }));

      // Corregir orden/números con TMDB cuando hay duda (temporadas sin número conocido o desorden)
      try {
        const needsTmdbOrder = [...byNumber.values()].some(s => !s.known) || byNumber.size >= 2;
        if (needsTmdbOrder && config().tmdbEnrichMeta) {
          const tvId = await resolveTmdbId(item, true);
          if (tvId) {
            const tv = await tmdbGet('/tv/' + tvId, {});
            const tmdbSeasons = (tv && Array.isArray(tv.seasons) ? tv.seasons : [])
              .filter(s => s && Number(s.season_number) >= 1)
              .sort((a, b) => Number(a.season_number) - Number(b.season_number));
            if (tmdbSeasons.length) {
              // Emparejar por cantidad de episodios (portal vs TMDB) cuando el número no era conocido
              const portalList = [...byNumber.values()].filter(s => Array.isArray(s.episodes));
              const usedTmdb = new Set();
              const usedPortal = new Set();
              const remapped = new Map();

              // 1) Las que ya tenían número conocido y existe en TMDB: se quedan
              for (const s of portalList) {
                if (!s.known) continue;
                const ts = tmdbSeasons.find(t => Number(t.season_number) === Number(s.number));
                if (ts) {
                  usedTmdb.add(Number(ts.season_number));
                  usedPortal.add(s.contentId);
                  remapped.set(Number(s.number), s);
                }
              }
              // 2) Desconocidas: emparejar por episode_count más cercano
              const unknown = portalList.filter(s => !usedPortal.has(s.contentId));
              for (const s of unknown) {
                const count = (s.episodes || []).length;
                let best = null;
                let bestDiff = Infinity;
                for (const t of tmdbSeasons) {
                  const tn = Number(t.season_number);
                  if (usedTmdb.has(tn)) continue;
                  const tc = Number(t.episode_count || 0);
                  const diff = Math.abs(tc - count);
                  // Preferir coincidencia exacta de conteo
                  if (diff < bestDiff) {
                    bestDiff = diff;
                    best = t;
                  }
                }
                if (best && (bestDiff <= 2 || count === 0)) {
                  const tn = Number(best.season_number);
                  usedTmdb.add(tn);
                  usedPortal.add(s.contentId);
                  const copy = Object.assign({}, s, {
                    number: tn,
                    season: tn,
                    name: s.known ? s.name : `Temporada ${tn}`,
                    title: s.known ? s.title : `Temporada ${tn}`,
                    known: true
                  });
                  for (const ep of copy.episodes || []) ep.season = tn;
                  remapped.set(tn, copy);
                  seasonContentIds.set(`${seriesRootId}:${tn}`, s.contentId);
                }
              }
              // 3) Lo que no se pudo mapear: mantener número actual
              for (const s of portalList) {
                if (usedPortal.has(s.contentId)) continue;
                let n = Number(s.number);
                while (remapped.has(n)) n += 1;
                const copy = Object.assign({}, s, { number: n, season: n });
                for (const ep of copy.episodes || []) ep.season = n;
                remapped.set(n, copy);
              }
              if (remapped.size) {
                byNumber.clear();
                for (const [n, s] of remapped) byNumber.set(n, s);
              }
            }
          }
        }
      } catch (_) { /* orden portal se mantiene */ }

      for (const s of byNumber.values()) {
        s.number = Number(s.number);
        s.season = s.number;
        seasons.push(s);
      }
      seasons.sort((a, b) => Number(a.number) - Number(b.number));

      // Reindexar mapas de reproducción con números finales
      for (const s of seasons) {
        const sn = Number(s.number);
        seasonContentIds.set(`${seriesRootId}:${sn}`, s.contentId);
        seasonContentIds.set(`${s.contentId}:${sn}`, s.contentId);
        for (const ep of s.episodes || []) {
          const eid = String(ep.id || ep.contentId || '');
          if (!eid) continue;
          ep.season = sn;
          episodeContentIds.set(`${seriesRootId}:${sn}:${Number(ep.number)}`, eid);
          episodeContentIds.set(`${s.contentId}:${sn}:${Number(ep.number)}`, eid);
          episodeParent.set(eid, seriesRootId);
          episodeSeasonId.set(eid, s.contentId);
        }
      }
      limitMap(episodeContentIds, MAX_MAP);
      limitMap(seasonContentIds, MAX_MAP);
      limitMap(episodeParent, MAX_MAP);
      limitMap(episodeSeasonId, MAX_MAP);
    }

    item.seasons = seasons;
    // episodes de la temporada abierta; seasons[] tiene todas ordenadas
    if (isSeries) {
      const cur = seasons.find(s => s.current) || seasons.find(s => Number(s.number) === currentSeason) || seasons[0];
      item.episodes = (cur && cur.episodes) ? cur.episodes : simple;
    } else {
      item.episodes = undefined;
    }
    item.seasonSiblings = siblings;
    item.genres = item.genres || [];

    if (item.id) {
      itemKinds.set(item.id, type);
      limitMap(itemKinds, MAX_MAP);
    }

    // TMDB liviano (stills de temporadas ya cargadas)
    try {
      await enrichMetaLight(item);
    } catch (_) {}

    if (!item.backdrop && item.poster) {
      item.backdrop = item.poster;
      item.background = item.poster;
    }

    return item;
  });
}

// ─── Resolver episodio de otra temporada (bajo demanda) ──────────────────────

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

  for (const key of episodeContentIds.keys()) {
    if (!key.endsWith(`:${sn}:${en}`)) continue;
    const parent = key.split(':')[0];
    hit = tryKeys(parent);
    if (hit) {
      episodeContentIds.set(`${seriesContentId}:${sn}:${en}`, hit.playableId);
      if (hit.seasonPortalId) {
        seasonContentIds.set(`${seriesContentId}:${sn}`, hit.seasonPortalId);
        episodeSeasonId.set(hit.playableId, hit.seasonPortalId);
      }
      return hit;
    }
  }

  // Cargar solo la temporada pedida (1 getItemData)
  try {
    let seasonPortalId = seasonContentIds.get(`${seriesContentId}:${sn}`) || '';
    if (!seasonPortalId) {
      // Intentar desde meta en caché (siblings chips)
      const metaKey = 'meta:' + seriesContentId + ':0';
      const cachedMeta = responseCache.get(metaKey) || responseCache.get('meta:' + seriesContentId + ':auto');
      const meta = cachedMeta && cachedMeta.value;
      if (meta && Array.isArray(meta.seasons)) {
        const found = meta.seasons.find(s => Number(s.number) === sn);
        if (found && found.contentId) seasonPortalId = String(found.contentId);
      }
      if (!seasonPortalId && meta && Array.isArray(meta.seasonSiblings)) {
        const sib = meta.seasonSiblings.find(s => {
          const n = Number(s.seasonNumber || s.season || parseSeasonFromName(s.name || s.title || '') || 0);
          return n === sn;
        }) || meta.seasonSiblings[sn - 1];
        if (sib) seasonPortalId = String(sib.contentId || sib.id || '');
      }
    }
    if (!seasonPortalId) seasonPortalId = seriesContentId;

    const sr = await api('v4/getItemData', {
      contentId: seasonPortalId,
      type: '0',
      sortType: '0',
      language: 'en',
      macAddr: FIXED_MAC
    });
    const sd = unwrapDetail(sr);
    const eps = episodeRows(sd, seriesContentId, sn, seasonPortalId);
    const byNum = eps.find(e => Number(e.number) === en);
    if (byNum) {
      return { playableId: String(byNum.id), seasonPortalId };
    }
  } catch (_) {}

  return { playableId: '', seasonPortalId: '' };
}

// ─── Streams ─────────────────────────────────────────────────────────────────

function normalizeSubLang(raw) {
  const s = String(raw || '').trim().toLowerCase();
  if (!s || s === 'und' || s === 'unknown' || s === 'null') return { code: 'es', label: 'Español' };
  if (/^(es|spa|spanish|español|castellano)/.test(s)) return { code: 'es', label: 'Español' };
  if (/^(en|eng|english|inglés|ingles)/.test(s)) return { code: 'en', label: 'English' };
  if (/^(pt|por|portuguese|portugu)/.test(s)) return { code: 'pt', label: 'Português' };
  if (/^(fr|fre|french|franc)/.test(s)) return { code: 'fr', label: 'Français' };
  if (/^(de|ger|german|alem)/.test(s)) return { code: 'de', label: 'Deutsch' };
  if (/^(it|ita|italian)/.test(s)) return { code: 'it', label: 'Italiano' };
  if (s.length <= 3) return { code: s, label: s.toUpperCase() };
  return { code: s.slice(0, 2), label: String(raw) };
}

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
    if (!u || seen.has(u) || !/^https?:\/\//i.test(u)) return;
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
        if (typeof s === 'string') { push(s, 'es', 'Español'); continue; }
        if (typeof s !== 'object') continue;
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

async function _getStreams(id, type, season, episode) {
  const parentId = String(id && typeof id === 'object' ? (id.contentId || id.id || id.assetId) : id || '').trim();
  if (!parentId) return [];

  const itemTypeHint = String(type || (id && id.type) || itemKinds.get(parentId) || 'movie').toLowerCase();
  const isSeries = ['series', 'anime', 'tv', 'teleplay', '0'].includes(itemTypeHint);

  let playableId = parentId;
  let seriesContentId = '';

  if (isSeries) {
    const rootId = String((id && id.seriesContentId) || episodeParent.get(parentId) || parentId);
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

  const subtitles = extractSubtitles(base, play, media, ...(mediaCandidates || []), ...(episodeList || []));

  // IntroDB solo aquí (al reproducir)
  let streamSegments = null;
  try {
    const rootForImdb = String(
      (id && typeof id === 'object' && (id.seriesContentId || id.contentId || id.id)) ||
      episodeParent.get(playableId) ||
      parentId
    );
    let imdbId = contentImdbIds.get(rootForImdb) || contentImdbIds.get(parentId) || contentImdbIds.get(playableId) || '';
    if (imdbId) {
      if (isSeries) {
        streamSegments = await fetchIntroDbSegments(imdbId, season, episode, false);
      } else {
        streamSegments = await fetchIntroDbSegments(imdbId, 0, 0, true);
      }
    }
  } catch (_) {}

  const stream = {
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
  };
  if (streamSegments) {
    stream.segments = streamSegments;
    stream.skip = streamSegments;
    stream.markers = streamSegments;
  }
  return [stream];
}

// ─── API pública ─────────────────────────────────────────────────────────────

async function getNews() {
  return cached('public:getNews', 4 * 60e3, async () => {
    const home = await _getHome().catch(() => []);
    const hero = (home || []).find(r => r.type === 'hero' || r.id === 'novedades');
    return (hero && hero.items) || [];
  });
}

async function getHome() {
  return cached('public:getHome', 8 * 60e3, () => _getHome());
}

async function getDiscoverFilters(filters) {
  const opts = filters && typeof filters === 'object' ? filters : {};
  const type = resolveKind(opts.type || opts.kind || 'movie');
  return cached('public:getDiscoverFilters:' + type, 15 * 60e3, () => _getDiscoverFilters(opts));
}

async function getDiscover(options) {
  const opts = options && typeof options === 'object' ? options : {};
  const type = resolveKind(opts.type || opts.kind || 'movie');
  const cat = String(opts.category || opts.columnId || opts.categoryId || opts.filter || 'all');
  const page = parseInt(opts.page, 10) || 1;
  return cached(`public:getDiscover:${type}:${cat}:${page}`, 4 * 60e3, () => _getDiscover(opts));
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

async function getMeta(id, options) {
  const keyId = id && typeof id === 'object' ? (id.contentId || id.id || id.assetId || id.programId || JSON.stringify(id)) : String(id || '');
  const opts = options && typeof options === 'object' ? options : (typeof options === 'string' ? { type: options } : {});
  return cached('public:getMeta:' + String(keyId) + ':' + JSON.stringify(opts), 8 * 60e3, () => _getMeta(id, opts));
}

async function getStreams(id, type, season, episode) {
  const keyId = id && typeof id === 'object' ? (id.contentId || id.id || id.assetId || JSON.stringify(id)) : String(id || '');
  const key = ['public:getStreams', keyId, type || '', season || '', episode || ''].join(':');
  return cached(key, 25e3, () => _getStreams(id, type, season, episode));
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
