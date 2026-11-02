/*
 * Magis Live TV — repo para XuperTV / Nuvio
 *
 * - getHome → filas = categorías de canales (type channel)
 * - getStreams → resuelve URL HLS autenticada del canal
 * - Sesión automática vía seeds (el usuario no inicia sesión)
 *
 * Requiere CryptoJS en el runtime.
 */
'use strict';

const ADDON_ID = 'magis-live';
const DEFAULTS = {
  hosts: 'sqacjy.s5lm5aydc.xyz,osuhk.m3x8o50te.com',
  scheme: 'https',
  appId: 'com.android.msandroid',
  apkVersion: '49902',
  desKeyHex: 'e7af1ed7de1ffddd7bd3fe37ebdffde9ef3fe1ae39edfeb8',
  seedsUrl: 'https://raw.githubusercontent.com/xuper-plugin/kino-plugin-xuper/seeds/seeds.json',
  liveRoot: 'masnew_live'
};

const API_VERSION = '43404';
const SPKG_VERSION = '2025-08-07 05:40:11_36_16_';
const PORTAL_CODE = 'masnew';
const SN_SALT = 'ntFT65w6itH!lHCPw7D=@qnsFC5adD28';
const FIXED_MAC = '02:00:00:00:00:00';
const UA_CDN = 'Ranger/4.9.4-17294ac0';

const RATE_GAP_MS = 100;
const PORTAL_TIMEOUT_MS = 8000;
const MAX_CACHE = 80;

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
const liveResolveCache = new Map();
let _seedsCache = null;
let _seedsCacheAt = 0;

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

function deviceDict() {
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
    sn: (session && session.sn) || '',
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

async function portal(path, bean, baseFields) {
  await rateTurn();
  const c = config();
  const body = Object.assign(
    {},
    baseFields !== false
      ? { portalCode: PORTAL_CODE, userId: (session && session.userId) || '', userToken: (session && session.userToken) || '' }
      : {},
    bean || {},
    deviceDict()
  );
  const wire = encryptBody(JSON.stringify(body));
  let lastError = 'No se pudo conectar con los hosts';
  const hosts = preferredHost
    ? [preferredHost].concat(c.hosts.filter(h => h !== preferredHost))
    : c.hosts.slice();

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
      const response = await fetch(c.scheme + '://' + host + '/api/portalCore/' + path, opts);
      if (!response.ok) {
        lastError = 'HTTP ' + response.status;
        continue;
      }
      const json = await response.json();
      const code = String(json.returnCode != null ? json.returnCode : '');
      if (code && code !== '0') throw new Error(String(json.errorMessage || json.msg || ('Portal ' + code)));
      preferredHost = host;
      let data = json.data;
      if (typeof data === 'string' && data) {
        try { data = JSON.parse(decryptBlob(data)); } catch (_) {}
      }
      return data && typeof data === 'object' ? data : json;
    } catch (e) {
      lastError = String(e && e.message || e);
    }
  }
  throw new Error(path + ': ' + lastError);
}

async function fetchSeeds() {
  const now = Date.now();
  if (_seedsCache && now - _seedsCacheAt < 30 * 60e3) return _seedsCache;
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
  const valid = list.filter(s => {
    const exp = Number(s.exp || 0);
    return !exp || exp > nowSec + 60;
  });
  const pool = valid.length ? valid : list;
  return pool[Math.floor(Math.random() * pool.length)] || null;
}

async function trySessionFromSeeds() {
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
      throw new Error('CryptoJS no disponible');
    }
    if (await trySessionFromSeeds()) return;

    const tokenResponse = await portal('v3/snToken', hardwareFingerprint(), false);
    const snToken = String(tokenResponse.snToken || '');
    if (!snToken) throw new Error('sin snToken');
    const sn = String(tokenResponse.sn || md5(snToken + SN_SALT)).toLowerCase();
    session = { sn, userId: '', userToken: '', jwtToken: '' };
    const active = await portal('v8/active', {
      snToken, authVersion: '', authCode: '', preCode: '',
      macAddr: FIXED_MAC, reserve1: '', openNum: 4,
      channel: 'default', matadata: '', signdata: ''
    }, false);
    if (!active || !active.userToken) {
      session = null;
      throw new Error('activación sin userToken');
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
  await ensureSession();
  return portal(path, bean, true);
}

function text(v) { return v == null ? '' : String(v); }
function trim(v) { return text(v).replace(/^\s+|\s+$/g, ''); }

function imageOf(asset) {
  const list = (asset && (asset.posterList || asset.posters || asset.imageList)) || [];
  if (Array.isArray(list)) {
    for (const img of list) {
      if (!img) continue;
      const url = trim(img.fileUrl || img.url || img.picUrl || '');
      if (url) return url;
    }
  }
  return trim(asset && (asset.logo || asset.poster || asset.posterUrl || asset.pic || asset.cover || asset.image) || '');
}

function channelItem(raw) {
  const id = trim(raw.channelCode || raw.contentId || raw.id || raw.playCode || '');
  if (!id) return null;
  const logo = imageOf(raw);
  return {
    id,
    contentId: id,
    channelCode: id,
    title: text(raw.name || raw.title || raw.channelName || id),
    name: text(raw.name || raw.title || raw.channelName || id),
    type: 'channel',
    media_type: 'channel',
    poster: logo,
    image: logo,
    logo: logo,
    backdrop: logo,
    background: logo
  };
}

// ─── Live categories + channels via getHome ──────────────────────────────────

async function loadCategoryColumns() {
  const root = String(config().liveRoot || 'masnew_live');
  const data = await api('getNextColumns', {
    columnCode: root,
    pageNum: 1,
    pageSize: 40,
    version: ''
  });
  const rows = (data && (data.columnList || data.recommendList || data.nextColumnList || data.childColumnList)) || [];
  const out = [];
  for (const r of rows) {
    if (!r) continue;
    const colId = String(r.columnId || r.id || '');
    const code = String(r.columnCode || r.code || '');
    const title = text(r.name || r.columnName || r.title || code || colId);
    if (!colId && !code) continue;
    out.push({
      id: colId || code,
      columnId: colId,
      columnCode: code,
      title,
      name: title
    });
  }
  return out;
}

async function loadChannelsForColumn(columnId, pageNum, pageSize) {
  const idNum = Number(columnId);
  const bean = {
    columnId: Number.isFinite(idNum) && idNum > 0 ? idNum : columnId,
    columnType: '2',
    pageNum: pageNum || 1,
    pageSize: pageSize || 80,
    encryptVersion: 0
  };
  try {
    const data = await api('v3/getShelveData', bean);
    let assets = (data && data.assetList) || [];
    if (!assets.length && data && data.channelList) assets = data.channelList;
    const channels = [];
    const seen = new Set();
    for (const a of assets) {
      const ch = channelItem(a);
      if (!ch || seen.has(ch.id)) continue;
      seen.add(ch.id);
      channels.push(ch);
    }
    return channels;
  } catch (_) {
    return [];
  }
}

async function _getHome() {
  await ensureSession();
  let categories = [];
  try {
    categories = await loadCategoryColumns();
  } catch (_) {
    categories = [];
  }

  // Si no hay subcategorías, usar root como única
  if (!categories.length) {
    categories = [{
      id: 'root',
      columnId: String(config().liveRoot || 'masnew_live'),
      columnCode: String(config().liveRoot || 'masnew_live'),
      title: 'Canales en vivo',
      name: 'Canales en vivo'
    }];
  }

  // Cargar canales de cada categoría (máx 12 categorías en paralelo)
  const limited = categories.slice(0, 12);
  const pages = await Promise.all(limited.map(async cat => {
    const colKey = cat.columnId || cat.id || cat.columnCode;
    const items = await loadChannelsForColumn(colKey, 1, 100);
    return { cat, items };
  }));

  const rows = [];
  for (const { cat, items } of pages) {
    if (!items.length) continue;
    rows.push({
      id: String(cat.id || cat.columnId || cat.columnCode),
      title: cat.title || cat.name || 'Canales',
      name: cat.title || cat.name || 'Canales',
      type: 'row',
      imageStyle: 'poster',
      items
    });
  }

  // Si todo falló, intentar un shelve genérico
  if (!rows.length) {
    const items = await loadChannelsForColumn(0, 1, 100);
    if (items.length) {
      rows.push({
        id: 'todos',
        title: 'Todos los canales',
        name: 'Todos los canales',
        type: 'row',
        items
      });
    }
  }

  return rows;
}

// ─── resolve live stream ─────────────────────────────────────────────────────

// sign_o3 (MD5-like) para CDN live
const LIVE_K = [3614090360,3905402710,606105819,3250441966,4118548399,1200080426,2821735955,4249261313,1770035416,2336552879,4294925233,2304563134,1804603682,4254626195,2792965006,1236535329,4129170786,3225465664,643717713,3921069994,3593408605,38016083,3634488961,3889429448,568446438,3275163606,4107603335,1163531501,2850285829,4243563512,1735328473,2368359562,4294588738,2272392833,1839030562,4259657740,2763975236,1272893353,4139469664,3200236656,681279174,3936430074,3564056709,76029189,3654602809,3871185381,530742520,3299628645,4096336452,1126891415,2878612391,4237533241,1700485571,2399980690,4293706877,2240044497,1873313359,4264355552,2734768916,1309151649,4149444226,3174756917,765973179,3951481745];
const LIVE_S = [7,12,17,22,7,12,17,22,7,12,17,22,7,12,17,22,5,9,14,20,5,9,14,20,5,9,14,20,5,9,14,20,4,11,16,23,4,11,16,23,4,11,16,23,4,11,16,23,6,10,15,21,6,10,15,21,6,10,15,21,6,10,15,21];
const LIVE_ROUND1 = [10,11,12,13,14,15,6,7,8,9,0,1,2,3,4,5];
const LIVE_G = [];
for (let i = 0; i < 64; i++) {
  LIVE_G.push(i < 16 ? LIVE_ROUND1[i] : i < 32 ? (5 * i + 1) % 16 : i < 48 ? (3 * i + 5) % 16 : (7 * i) % 16);
}
// salt bytes (mismo del cliente original)
const LIVE_SALT_HEX = '73616c74333333333d34980d0a1532c9c3821708c0';

function rotl(x, n) { return ((x << n) | (x >>> (32 - n))) >>> 0; }

function liveCompress(state, block, offset) {
  const n = new Array(16);
  for (let a = 0; a < 16; a++) {
    const i = offset + 4 * a;
    n[a] = (block[i] | (block[i + 1] << 8) | (block[i + 2] << 16) | (block[i + 3] << 24)) >>> 0;
  }
  let o = state[0], s = state[1], u = state[2], l = state[3];
  for (let c = 0; c < 64; c++) {
    const f = c < 16 ? (s & u) | (~s & l) : c < 32 ? (l & s) | (~l & u) : c < 48 ? s ^ u ^ l : u ^ (s | ~l);
    const d = (f + o + LIVE_K[c] + n[LIVE_G[c]]) >>> 0;
    o = l; l = u; u = s; s = (s + rotl(d, LIVE_S[c])) >>> 0;
  }
  state[0] = (state[0] + o) >>> 0;
  state[1] = (state[1] + s) >>> 0;
  state[2] = (state[2] + u) >>> 0;
  state[3] = (state[3] + l) >>> 0;
}

function liveDigestHex(bytes) {
  // bytes: Uint8Array or array of numbers
  const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const state = [1732584193, 4023233417, 2562383102, 271733878];
  const r = buf.length;
  const padLen = (56 - ((r + 1) % 64) + 64) % 64;
  const a = new Uint8Array(r + 1 + padLen + 8);
  a.set(buf, 0);
  a[r] = 128;
  const bitLo = (r % 536870912) * 8;
  const bitHi = Math.floor(r / 536870912);
  for (let s = 0; s < 4; s++) {
    a[r + 1 + padLen + s] = (bitLo >>> (8 * s)) & 255;
    a[r + 5 + padLen + s] = (bitHi >>> (8 * s)) & 255;
  }
  for (let u = 0; u < a.length; u += 64) liveCompress(state, a, u);
  let hex = '';
  for (let c = 0; c < 4; c++) {
    for (let d = 0; d < 4; d++) {
      let f = ((state[c] >>> (8 * d)) & 255).toString(16);
      if (f.length < 2) f = '0' + f;
      hex += f;
    }
  }
  return hex;
}

function utf8Bytes(str) {
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(str);
  const out = [];
  for (let i = 0; i < str.length; i++) {
    let c = str.charCodeAt(i);
    if (c < 128) out.push(c);
    else if (c < 2048) out.push(192 | (c >> 6), 128 | (c & 63));
    else out.push(224 | (c >> 12), 128 | ((c >> 6) & 63), 128 | (c & 63));
  }
  return new Uint8Array(out);
}

function signO3(token, startMoment) {
  const msg = 'token=' + token + '&sign2_method=sign_o3&instance=0&start_moment=' + startMoment;
  const msgBytes = utf8Bytes(msg);
  const salt = [];
  for (let i = 0; i < LIVE_SALT_HEX.length; i += 2) {
    salt.push(parseInt(LIVE_SALT_HEX.substr(i, 2), 16));
  }
  const combined = new Uint8Array(msgBytes.length + salt.length);
  combined.set(msgBytes, 0);
  combined.set(salt, msgBytes.length);
  return liveDigestHex(combined);
}

function bareHost(addr) {
  let t = String(addr || '');
  if (t.indexOf('https://') === 0) t = t.slice(8);
  if (t.indexOf('http://') === 0) t = t.slice(7);
  const slash = t.indexOf('/');
  return slash >= 0 ? t.slice(0, slash) : t;
}

async function resolveLiveStream(channelCode) {
  const code = trim(channelCode);
  if (!code) return [];

  const hit = liveResolveCache.get(code);
  if (hit && hit.expires > Date.now()) return hit.value;

  await ensureSession();

  const play = await api('v4/startPlayLive', {
    channelCode: code,
    columnId: 0,
    type: '1'
  });

  const list = (play && play.liveAddressList) || [];
  let chosen = null;
  for (const a of list) {
    if (a && a.playCode && a.license) { chosen = a; break; }
  }
  if (!chosen && list[0]) chosen = list[0];
  if (!chosen || !chosen.license) throw new Error('sin licencia de canal');

  const playCode = chosen.playCode || code;
  const license = chosen.license;

  const slb = await api('v14/getSlbInfo', {
    hasPay: '0',
    userIdentity: '1',
    type: 'merge',
    appVer: config().apkVersion,
    lang: 'es',
    encMediaSupported: 1,
    liveCodeList: [code],
    appParams: '',
    reserve1: FIXED_MAC,
    pipFlag: '0'
  });

  const candidates = [];
  for (const c of (slb && slb.cdn_list) || []) {
    if (String(c.tag) !== 'live') continue;
    for (const u of (c.url_list || [])) {
      const p = String(u.url || '');
      if (String(u.sign_type) === 'cfl' || p.indexOf('sign_type=cfl') !== -1) {
        const host = bareHost(c.main_addr);
        if (host) candidates.push({ cflHost: host, authBase: p });
      }
    }
  }
  if (!candidates.length) throw new Error('sin CDN live');

  const h = candidates[0];
  const url = 'http://' + h.cflHost + '/live/' + playCode + '.m3u8';
  const tokenMatch = h.authBase.match(/token=([0-9a-fA-F]{32})/);
  const token = tokenMatch ? tokenMatch[1] : '';
  const startMoment = Math.trunc(Date.now());
  const sign2 = signO3(token, startMoment);

  const stream = {
    name: 'Magis Live',
    title: text(play && play.name) || code,
    url,
    quality: 'Auto',
    type: 'hls',
    mimeType: 'application/x-mpegurl',
    isHls: true,
    headers: {
      'Content-Auth': h.authBase + '&sign2_method=sign_o3&instance=0&start_moment=' + startMoment + '&sign2=' + sign2,
      'Content-License': license,
      'User-Agent': UA_CDN,
      App: config().appId,
      'App-Version': config().apkVersion,
      'X-Buffer': '0'
    },
    language: 'Español'
  };

  const out = [stream];
  liveResolveCache.set(code, { value: out, expires: Date.now() + 90e3 });
  limitMap(liveResolveCache, 100);
  return out;
}

// ─── public API ──────────────────────────────────────────────────────────────

async function getHome() {
  return cached('public:getHome', 5 * 60e3, () => _getHome());
}

async function getStreams(id, type) {
  const channelId = typeof id === 'object' ? (id.id || id.contentId || id.channelCode) : id;
  return resolveLiveStream(String(channelId || ''));
}

async function getMeta(id) {
  const channelId = typeof id === 'object' ? (id.id || id.contentId) : id;
  const cid = String(channelId || '');
  return {
    id: cid,
    contentId: cid,
    title: cid,
    name: cid,
    type: 'channel',
    media_type: 'channel'
  };
}

async function search(query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return [];
  const home = await getHome().catch(() => []);
  const out = [];
  const seen = new Set();
  for (const row of home || []) {
    for (const it of row.items || []) {
      if (!it || !it.id || seen.has(it.id)) continue;
      const title = String(it.title || it.name || '').toLowerCase();
      if (title.indexOf(q) !== -1) {
        seen.add(it.id);
        out.push(it);
      }
    }
  }
  return out;
}

module.exports = {
  getHome,
  getStreams,
  getMeta,
  search
};
