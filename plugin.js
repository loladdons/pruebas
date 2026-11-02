
/*
 * Magis Live TV — misma lógica que Xuper original
 * Categorías: getNextColumns(masnew_live)
 * Canales: v6/getLiveData
 * Play: v4/startPlayLive + getSlbInfo + sign_o3
 * Seeds para sesión automática. CryptoJS requerido.
 */
'use strict';

const ADDON_ID = 'magis-live';
const DEFAULTS = {
  hosts: 'sqacjy.s5lm5aydc.xyz,osuhk.m3x8o50te.com,oogoy.f30c96w8.com',
  scheme: 'https',
  appId: 'com.android.msandroid',
  apkVersion: '49902',
  desKeyHex: 'e7af1ed7de1ffddd7bd3fe37ebdffde9ef3fe1ae39edfeb8',
  seedsUrl: 'https://raw.githubusercontent.com/xuper-plugin/kino-plugin-xuper/seeds/seeds.json',
  liveRoot: 'masnew_live',
  defaultLiveColumnId: '76182'
};

const API_VERSION = '43404';
const SPKG_VERSION = '2025-08-07 05:40:11_36_16_';
const PORTAL_CODE = 'masnew';
const SN_SALT = 'ntFT65w6itH!lHCPw7D=@qnsFC5adD28';
const FIXED_MAC = '02:00:00:00:00:00';
const UA_CDN = 'Ranger/4.9.4-17294ac0';
const RATE_GAP_MS = 100;
const PORTAL_TIMEOUT_MS = 10000;
const MAX_CACHE = 100;
const HOME_TTL = 4 * 60e3;
const LIVE_STREAM_TTL = 90e3;

let session = null;
let sessionPromise = null;
let preferredHost = null;
let lastCallAt = 0;
let rateQueue = Promise.resolve();
let _cfgCache = null, _cfgCacheAt = 0;
const CFG_CACHE_MS = 30e3;
let _desKey = null, _desKeyHex = '', _C = null;
const responseCache = new Map();
const inFlight = new Map();
const liveResolveCache = new Map();
let _seedsCache = null, _seedsCacheAt = 0;

function limitMap(map, max) { while (map.size > max) map.delete(map.keys().next().value); }
async function cached(key, ttl, work) {
  const now = Date.now();
  const hit = responseCache.get(key);
  if (hit && hit.expires > now) return hit.value;
  if (hit) responseCache.delete(key);
  if (inFlight.has(key)) return inFlight.get(key);
  const task = Promise.resolve().then(work).then(value => {
    if (ttl > 0) { responseCache.set(key, { value, expires: Date.now() + ttl }); limitMap(responseCache, MAX_CACHE); }
    return value;
  }).finally(() => inFlight.delete(key));
  inFlight.set(key, task);
  return task;
}
async function rateTurn() {
  let release;
  const previous = rateQueue;
  rateQueue = new Promise(r => { release = r; });
  await previous;
  try {
    const wait = Math.max(0, RATE_GAP_MS - (Date.now() - lastCallAt));
    if (wait) await new Promise(r => setTimeout(r, wait));
    lastCallAt = Date.now();
  } finally { release(); }
}
function config() {
  const now = Date.now();
  if (_cfgCache && now - _cfgCacheAt < CFG_CACHE_MS) return _cfgCache;
  let supplied = {};
  try { const all = globalThis.__nuvioConfig || {}; supplied = all[ADDON_ID] || all.current || {}; } catch (_) {}
  const c = Object.assign({}, DEFAULTS, supplied);
  c.hosts = String(c.hosts || DEFAULTS.hosts).split(/[,;\s]+/).map(s => s.trim()).filter(Boolean);
  c.scheme = String(c.scheme || 'https').replace(':', '');
  _cfgCache = c; _cfgCacheAt = now; return c;
}
function cryptoJS() {
  if (_C) return _C;
  if (typeof CryptoJS === 'undefined' || !CryptoJS.TripleDES) throw new Error('CryptoJS no disponible');
  _C = CryptoJS; return _C;
}
function desKey() {
  const C = cryptoJS(); const hex = config().desKeyHex;
  if (_desKey && _desKeyHex === hex) return _desKey;
  _desKey = C.enc.Hex.parse(hex); _desKeyHex = hex; return _desKey;
}
function encryptBody(value) {
  const C = cryptoJS();
  const encrypted = C.TripleDES.encrypt(String(value), desKey(), { mode: C.mode.ECB, padding: C.pad.Pkcs7 });
  return C.enc.Utf8.parse(encrypted.ciphertext.toString(C.enc.Base64)).toString(C.enc.Hex);
}
function decryptBlob(wire) {
  const C = cryptoJS();
  const b64 = C.enc.Utf8.stringify(C.enc.Hex.parse(String(wire)));
  const params = C.lib.CipherParams.create({ ciphertext: C.enc.Base64.parse(b64) });
  return C.TripleDES.decrypt(params, desKey(), { mode: C.mode.ECB, padding: C.pad.Pkcs7 }).toString(C.enc.Utf8);
}
function randHex(n) { let o = ''; for (let i = 0; i < n; i++) o += Math.floor(Math.random() * 256).toString(16).padStart(2, '0'); return o; }
function randMac() { return Array.from({ length: 6 }, () => randHex(1)).join(':'); }
function md5(s) { return cryptoJS().MD5(String(s)).toString().toLowerCase(); }
function text(v) { return v == null ? '' : String(v); }
function trim(v) { return text(v).replace(/^\s+|\s+$/g, ''); }
function deviceDict() {
  return { loginType: '2', appLanguage: 'en', apkVersion: config().apkVersion, sysVersion: SPKG_VERSION, appId: config().appId,
    hardwareInfo: 'ranchu', model: 'sdk_gphone64_arm64', product: 'sdk_gphone64_arm64', cpu: 'arm64-v8a',
    B29: '', reserve1: '', deviceToken: '', sn: (session && session.sn) || '', drmId: '', sdkVer: 36 };
}
function hardwareFingerprint() {
  return { androidId: randHex(8), board: 'goldfish_arm64', brand: 'google', cpuAbi: 'arm64-v8a', cpuId: randHex(8),
    device: 'emu64a', diskInfo: '8GB', display: 'sdk_gphone64_arm64', etheMac: randMac(),
    fingerprint: 'google/sdk_gphone64_arm64/emu64a:14/UE1A.230829.036/11228894:user/release-keys',
    gatewayMac: randMac(), hardware: 'ranchu', host: 'abfarm', manufacturer: 'Google',
    ramSize: '4GB', romSize: '8GB', serialNumber: randHex(8), tags: 'release-keys', verId: '', wifiMac: randMac() };
}

async function portal(path, bean, baseFields) {
  await rateTurn();
  const c = config();
  const body = Object.assign({},
    baseFields !== false ? { portalCode: PORTAL_CODE, userId: (session && session.userId) || '', userToken: (session && session.userToken) || '' } : {},
    bean || {}, deviceDict());
  const wire = encryptBody(JSON.stringify(body));
  let lastError = 'No se pudo conectar';
  const hosts = preferredHost ? [preferredHost].concat(c.hosts.filter(h => h !== preferredHost)) : c.hosts.slice();
  for (const host of hosts) {
    try {
      const opts = { method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8', apk: c.appId, apkVer: API_VERSION, spkgVer: SPKG_VERSION, 'User-Agent': 'okhttp/3.12.12' }, body: wire };
      if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') opts.signal = AbortSignal.timeout(PORTAL_TIMEOUT_MS);
      const response = await fetch(c.scheme + '://' + host + '/api/portalCore/' + path, opts);
      if (!response.ok) { lastError = 'HTTP ' + response.status; continue; }
      const json = await response.json();
      const code = String(json.returnCode != null ? json.returnCode : '');
      if (code && code !== '0') throw new Error(String(json.errorMessage || json.msg || ('Portal ' + code)));
      preferredHost = host;
      let data = json.data;
      if (typeof data === 'string' && data) { try { data = JSON.parse(decryptBlob(data)); } catch (_) {} }
      return data && typeof data === 'object' ? data : json;
    } catch (e) { lastError = String(e && e.message || e); }
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
    if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') opts.signal = AbortSignal.timeout(12000);
    const res = await fetch(url, opts);
    if (!res.ok) return _seedsCache || [];
    const json = await res.json();
    const list = Array.isArray(json) ? json : (json && Array.isArray(json.seeds) ? json.seeds : []);
    _seedsCache = list.filter(s => s && s.userToken && s.sn);
    _seedsCacheAt = now;
    return _seedsCache;
  } catch (_) { return _seedsCache || []; }
}
function pickSeed(list) {
  if (!list || !list.length) return null;
  const nowSec = Math.floor(Date.now() / 1000);
  const valid = list.filter(s => { const exp = Number(s.exp || 0); return !exp || exp > nowSec + 60; });
  const pool = valid.length ? valid : list;
  return pool[Math.floor(Math.random() * pool.length)] || null;
}
async function trySessionFromSeeds() {
  try {
    const c = config();
    if (c.userToken && c.sn) {
      session = { sn: String(c.sn), userId: String(c.userId || ''), userToken: String(c.userToken), jwtToken: String(c.jwtToken || '') };
      return true;
    }
  } catch (_) {}
  const seed = pickSeed(await fetchSeeds());
  if (!seed) return false;
  session = { sn: String(seed.sn || ''), userId: String(seed.userId || ''), userToken: String(seed.userToken || ''), jwtToken: String(seed.jwtToken || '') };
  return !!(session.userToken && session.sn);
}
async function ensureSession() {
  if (session && session.userToken) return;
  if (sessionPromise) return sessionPromise;
  sessionPromise = (async () => {
    if (typeof CryptoJS === 'undefined') throw new Error('CryptoJS no disponible');
    if (await trySessionFromSeeds()) return;
    const tokenResponse = await portal('v3/snToken', hardwareFingerprint(), false);
    const snToken = String(tokenResponse.snToken || '');
    if (!snToken) throw new Error('sin snToken');
    const sn = String(tokenResponse.sn || md5(snToken + SN_SALT)).toLowerCase();
    session = { sn, userId: '', userToken: '', jwtToken: '' };
    const active = await portal('v8/active', {
      snToken, authVersion: '', authCode: '', preCode: '', macAddr: FIXED_MAC, reserve1: '',
      openNum: 4, channel: 'default', matadata: '', signdata: ''
    }, false);
    if (!active || !active.userToken) { session = null; throw new Error('activación sin userToken'); }
    session.userId = String(active.userId || '');
    session.userToken = String(active.userToken || '');
    session.jwtToken = String(active.jwtToken || '');
  })();
  try { await sessionPromise; } finally { sessionPromise = null; }
}
async function api(path, bean) { await ensureSession(); return portal(path, bean, true); }

function logoOf(u) {
  let l = trim(u && u.posterUrl);
  if (!l && u && Array.isArray(u.posterList) && u.posterList.length) l = trim(u.posterList[0].fileUrl || u.posterList[0].url || '');
  if (!l) l = trim(u && (u.logo || u.poster || u.pic || u.cover || u.image) || '');
  return l;
}
function channelItem(u, index) {
  if (!u) return null;
  const code = trim(u.channelCode || u.contentId || u.id || u.playCode || '');
  if (!code) return null;
  const logo = logoOf(u);
  const name = text(u.name || u.alias || u.title || u.channelName || ('Canal ' + (index || 1)));
  return {
    id: code, contentId: code, channelCode: code, title: name, name: name,
    type: 'channel', media_type: 'channel',
    poster: logo, image: logo, logo: logo, backdrop: logo, background: logo,
    index: u.channelNumber || index || 0, uhd: String(u.quality || '') === '3', now: 'En vivo'
  };
}

/** v6/getLiveData — igual que Xuper original */
async function fetchLivePage(columnId, pageNum, pageSize) {
  const col = (columnId == null || columnId === '' || columnId === '0')
    ? Number(config().defaultLiveColumnId || 76182)
    : (/^\d+$/.test(String(columnId)) ? Number(columnId) : columnId);
  const data = await api('v6/getLiveData', {
    columnId: col, dataVersion: '', pageSize: pageSize || 50, pageNum: pageNum || 1, expireTimeStr: ''
  });
  const list = (data && data.channelList) || [];
  const channels = [];
  const seen = Object.create(null);
  for (let s = 0; s < list.length; s++) {
    const u = list[s];
    if (!u || !u.channelCode || seen[u.channelCode]) continue;
    seen[u.channelCode] = true;
    const ch = channelItem(u, u.channelNumber || channels.length + 1);
    if (ch) channels.push(ch);
  }
  return { channels, hasMore: list.length >= (pageSize || 50) };
}
async function fetchAllChannels(columnId, maxPages) {
  const pages = Math.max(1, Math.min(maxPages || 8, 15));
  const all = []; const seen = Object.create(null);
  for (let p = 1; p <= pages; p++) {
    try {
      const { channels, hasMore } = await fetchLivePage(columnId, p, 50);
      for (const ch of channels) { if (seen[ch.id]) continue; seen[ch.id] = true; all.push(ch); }
      if (!hasMore || !channels.length) break;
    } catch (_) { break; }
  }
  return all;
}

/** getNextColumns(masnew_live) → recommendList */
async function fetchLiveCategories() {
  const data = await api('getNextColumns', {
    columnCode: String(config().liveRoot || 'masnew_live'), pageNum: 1, pageSize: 50, version: ''
  });
  const recommendList = (data && data.recommendList) || [];
  const categories = [];
  for (let i = 0; i < recommendList.length; i++) {
    const o = recommendList[i];
    if (!o || !o.columnId) continue;
    categories.push({
      id: String(o.columnId), columnId: String(o.columnId),
      name: text(o.name || o.title || o.alias || ('Categoría ' + (i + 1))),
      code: String(o.code || o.columnCode || '')
    });
  }
  if (!categories.length) {
    const alt = (data && (data.columnList || data.nextColumnList || data.childColumnList)) || [];
    for (let i = 0; i < alt.length; i++) {
      const o = alt[i]; if (!o) continue;
      const id = String(o.columnId || o.id || ''); if (!id) continue;
      categories.push({ id, columnId: id, name: text(o.name || o.columnName || o.title || ('Categoría ' + (i + 1))), code: String(o.columnCode || o.code || '') });
    }
  }
  return categories;
}

async function _getHome() {
  await ensureSession();
  let categories = [];
  try { categories = await fetchLiveCategories(); } catch (_) { categories = []; }
  if (!categories.length) {
    categories = [{ id: String(config().defaultLiveColumnId || 76182), columnId: String(config().defaultLiveColumnId || 76182), name: 'Canales en vivo', code: '' }];
  }
  const limited = categories.slice(0, 15);
  const rows = [];
  for (let i = 0; i < limited.length; i += 3) {
    const batch = limited.slice(i, i + 3);
    const results = await Promise.all(batch.map(async cat => {
      const items = await fetchAllChannels(cat.columnId || cat.id, 5);
      return { cat, items };
    }));
    for (const { cat, items } of results) {
      if (!items.length) continue;
      rows.push({ id: String(cat.columnId || cat.id), title: cat.name || 'Canales', name: cat.name || 'Canales', type: 'row', imageStyle: 'poster', items });
    }
  }
  if (!rows.length) {
    const fallbackId = Number(config().defaultLiveColumnId || 76182);
    const items = await fetchAllChannels(fallbackId, 8);
    if (items.length) rows.push({ id: String(fallbackId), title: 'Canales en vivo', name: 'Canales en vivo', type: 'row', imageStyle: 'poster', items });
  }
  return rows;
}

const LIVE_K = [3614090360,3905402710,606105819,3250441966,4118548399,1200080426,2821735955,4249261313,1770035416,2336552879,4294925233,2304563134,1804603682,4254626195,2792965006,1236535329,4129170786,3225465664,643717713,3921069994,3593408605,38016083,3634488961,3889429448,568446438,3275163606,4107603335,1163531501,2850285829,4243563512,1735328473,2368359562,4294588738,2272392833,1839030562,4259657740,2763975236,1272893353,4139469664,3200236656,681279174,3936430074,3564056709,76029189,3654602809,3871185381,530742520,3299628645,4096336452,1126891415,2878612391,4237533241,1700485571,2399980690,4293706877,2240044497,1873313359,4264355552,2734768916,1309151649,4149444226,3174756917,765973179,3951481745];
const LIVE_S = [7,12,17,22,7,12,17,22,7,12,17,22,7,12,17,22,5,9,14,20,5,9,14,20,5,9,14,20,5,9,14,20,4,11,16,23,4,11,16,23,4,11,16,23,4,11,16,23,6,10,15,21,6,10,15,21,6,10,15,21,6,10,15,21];
const LIVE_ROUND1 = [10,11,12,13,14,15,6,7,8,9,0,1,2,3,4,5];
const LIVE_G = [];
for (let i = 0; i < 64; i++) LIVE_G.push(i < 16 ? LIVE_ROUND1[i] : i < 32 ? (5 * i + 1) % 16 : i < 48 ? (3 * i + 5) % 16 : (7 * i) % 16);
const LIVE_SALT_HEX = '73616c74333333333d34980d0a1532c9c3821708c0';
function rotl(x, n) { return ((x << n) | (x >>> (32 - n))) >>> 0; }
function liveCompress(state, block, offset) {
  const n = new Array(16);
  for (let a = 0; a < 16; a++) { const i = offset + 4 * a; n[a] = (block[i] | (block[i + 1] << 8) | (block[i + 2] << 16) | (block[i + 3] << 24)) >>> 0; }
  let o = state[0], s = state[1], u = state[2], l = state[3];
  for (let c = 0; c < 64; c++) {
    const f = c < 16 ? (s & u) | (~s & l) : c < 32 ? (l & s) | (~l & u) : c < 48 ? s ^ u ^ l : u ^ (s | ~l);
    const d = (f + o + LIVE_K[c] + n[LIVE_G[c]]) >>> 0;
    o = l; l = u; u = s; s = (s + rotl(d, LIVE_S[c])) >>> 0;
  }
  state[0] = (state[0] + o) >>> 0; state[1] = (state[1] + s) >>> 0; state[2] = (state[2] + u) >>> 0; state[3] = (state[3] + l) >>> 0;
}
function liveDigestHex(bytes) {
  const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const state = [1732584193, 4023233417, 2562383102, 271733878];
  const r = buf.length; const padLen = (56 - ((r + 1) % 64) + 64) % 64;
  const a = new Uint8Array(r + 1 + padLen + 8); a.set(buf, 0); a[r] = 128;
  const bitLo = (r % 536870912) * 8; const bitHi = Math.floor(r / 536870912);
  for (let s = 0; s < 4; s++) { a[r + 1 + padLen + s] = (bitLo >>> (8 * s)) & 255; a[r + 5 + padLen + s] = (bitHi >>> (8 * s)) & 255; }
  for (let u = 0; u < a.length; u += 64) liveCompress(state, a, u);
  let hex = '';
  for (let c = 0; c < 4; c++) for (let d = 0; d < 4; d++) { let f = ((state[c] >>> (8 * d)) & 255).toString(16); if (f.length < 2) f = '0' + f; hex += f; }
  return hex;
}
function utf8Bytes(str) {
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(str);
  const out = [];
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if (c < 128) out.push(c); else if (c < 2048) out.push(192 | (c >> 6), 128 | (c & 63));
    else out.push(224 | (c >> 12), 128 | ((c >> 6) & 63), 128 | (c & 63));
  }
  return new Uint8Array(out);
}
function signO3(token, startMoment) {
  const msg = 'token=' + token + '&sign2_method=sign_o3&instance=0&start_moment=' + startMoment;
  const msgBytes = utf8Bytes(msg);
  const salt = [];
  for (let i = 0; i < LIVE_SALT_HEX.length; i += 2) salt.push(parseInt(LIVE_SALT_HEX.substr(i, 2), 16));
  const combined = new Uint8Array(msgBytes.length + salt.length);
  combined.set(msgBytes, 0); combined.set(salt, msgBytes.length);
  return liveDigestHex(combined);
}
function bareHost(addr) {
  let t = String(addr || '');
  if (t.indexOf('https://') === 0) t = t.slice(8);
  if (t.indexOf('http://') === 0) t = t.slice(7);
  const slash = t.indexOf('/'); return slash >= 0 ? t.slice(0, slash) : t;
}

async function resolveLiveStream(channelCode) {
  const code = trim(channelCode);
  if (!code) return [];
  const cachedHit = liveResolveCache.get(code);
  if (cachedHit && cachedHit.expires > Date.now()) return cachedHit.value;
  await ensureSession();
  const play = await api('v4/startPlayLive', { channelCode: code, columnId: 0, type: '1' });
  const list = (play && play.liveAddressList) || [];
  let chosen = null;
  for (let i = 0; i < list.length; i++) {
    if (list[i] && list[i].playCode && list[i].license) { chosen = list[i]; break; }
  }
  if (!chosen && list[0]) chosen = list[0];
  if (!chosen || !chosen.license) throw new Error('el portal no devolvió licencia para el canal');
  const playCode = chosen.playCode || code;
  const license = chosen.license;
  const slb = await api('v14/getSlbInfo', {
    hasPay: '0', userIdentity: '1', type: 'merge', appVer: config().apkVersion, lang: 'es',
    encMediaSupported: 1, liveCodeList: [code], appParams: '', reserve1: FIXED_MAC, pipFlag: '0'
  });
  const candidates = [];
  for (const c of (slb && slb.cdn_list) || []) {
    if (String(c.tag) !== 'live') continue;
    for (const u of (c.url_list || [])) {
      const p = String(u.url || '');
      if (String(u.sign_type) === 'cfl' || p.indexOf('sign_type=cfl') !== -1 || p.indexOf('cfl') !== -1) {
        const host = bareHost(c.main_addr);
        if (host) candidates.push({ cflHost: host, authBase: p });
      }
    }
  }
  if (!candidates.length) throw new Error('el portal no expuso CDN de vivo');
  const h = candidates[0];
  const url = 'http://' + h.cflHost + '/live/' + playCode + '.m3u8';
  const tokenMatch = h.authBase.match(/token=([0-9a-fA-F]{32})/);
  const token = tokenMatch ? tokenMatch[1] : '';
  const startMoment = Math.trunc(Date.now());
  const sign2 = signO3(token, startMoment);
  const stream = {
    name: 'Magis Live', title: text(play && play.name) || code, url, quality: 'Auto',
    type: 'hls', mimeType: 'application/x-mpegurl', isHls: true,
    headers: {
      'Content-Auth': h.authBase + '&sign2_method=sign_o3&instance=0&start_moment=' + startMoment + '&sign2=' + sign2,
      'Content-License': license, 'User-Agent': UA_CDN, App: config().appId, 'App-Version': config().apkVersion, 'X-Buffer': '0'
    },
    language: 'Español'
  };
  const out = [stream];
  liveResolveCache.set(code, { value: out, expires: Date.now() + LIVE_STREAM_TTL });
  limitMap(liveResolveCache, 120);
  return out;
}

async function getHome() { return cached('public:getHome', HOME_TTL, () => _getHome()); }
async function getStreams(id) {
  let channelId = id;
  if (id && typeof id === 'object') channelId = id.channelCode || id.id || id.contentId || id;
  return resolveLiveStream(String(channelId || ''));
}
async function getMeta(id) {
  let channelId = id;
  if (id && typeof id === 'object') channelId = id.channelCode || id.id || id.contentId || '';
  const cid = String(channelId || '');
  return { id: cid, contentId: cid, channelCode: cid, title: cid, name: cid, type: 'channel', media_type: 'channel' };
}
async function search(query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return [];
  const home = await getHome().catch(() => []);
  const out = []; const seen = Object.create(null);
  for (const row of home || []) {
    for (const it of row.items || []) {
      if (!it || !it.id || seen[it.id]) continue;
      if (String(it.title || it.name || '').toLowerCase().indexOf(q) !== -1) { seen[it.id] = true; out.push(it); }
    }
  }
  return out;
}

module.exports = { getHome, getStreams, getMeta, search };
