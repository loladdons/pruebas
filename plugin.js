/**
 * Magis Live TV — plugin para Nuvio / lolplus launcher
 * Protocolo portal: body = hex(base64(3DES-EDE/ECB/PKCS5(json)))
 * Sesión: anónimo (snToken + active) o login (v8/login)
 * Live: v6/getLiveData + v4/startPlayLive + v14/getSlbInfo
 *
 * Config (lol.json): solo email + password.
 * Hosts, clave 3DES, appId y portalCode van FIJOS (MagisConfig.defaults del lib).
 *
 * Nota: el player de la app debe enviar los headers Content-Auth / Content-License
 * en cada request HLS. Si el player no reenvía headers a segmentos, la
 * reproducción puede fallar; en ese caso usa el módulo Dart MagisLiveService
 * (lib) con LiveHlsProxy.
 */

'use strict';

// ─── Config / estado ───────────────────────────────────────────────────────
var CFG = {
  desKeyHex: 'e7af1ed7de1ffddd7bd3fe37ebdffde9ef3fe1ae39edfeb8',
  hosts: ['bcdod.faolmbghu.com', 'osuhk.m3x8o50te.com'],
  appId: 'com.android.msandroid',
  apkVersion: '49902',
  scheme: 'https',
  portalCode: 'masnew',
  spkgVer: '2025-08-07 05:40:11_36_16_',
  snTokenSalt: 'ntFT65w6itH!lHCPw7D=@qnsFC5adD28',
  passwordSalt: 'cloudstream',
  fixedMac: '02:00:00:00:00:00',
  liveRoot: 'masnew_live',
  allCategoryId: 76182,
};

var STATE = {
  userId: '',
  userToken: '',
  jwtToken: '',
  sn: '',
  email: '',
  password: '',
  preferredHost: null,
  categoriesCache: null,
  channelsCache: {},
  lastCallMs: 0,
};

// ─── Utilidades ────────────────────────────────────────────────────────────
function log() {
  try {
    if (typeof console !== 'undefined' && console.log) {
      console.log.apply(console, ['[MagisLive]'].concat([].slice.call(arguments)));
    }
  } catch (_) {}
}

function hexToBytes(hex) {
  var clean = String(hex || '').replace(/[^0-9a-fA-F]/g, '');
  var out = [];
  for (var i = 0; i < clean.length; i += 2) {
    out.push(parseInt(clean.substr(i, 2), 16));
  }
  return out;
}

function bytesToHex(bytes) {
  var s = '';
  for (var i = 0; i < bytes.length; i++) {
    var h = (bytes[i] & 0xff).toString(16);
    if (h.length < 2) h = '0' + h;
    s += h;
  }
  return s;
}

function utf8Encode(str) {
  if (typeof TextEncoder !== 'undefined') {
    return Array.from(new TextEncoder().encode(str));
  }
  var out = [];
  for (var i = 0; i < str.length; i++) {
    var c = str.charCodeAt(i);
    if (c < 0x80) out.push(c);
    else if (c < 0x800) {
      out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    } else if (c < 0xd800 || c >= 0xe000) {
      out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    } else {
      i++;
      var c2 = str.charCodeAt(i);
      var u = 0x10000 + (((c & 0x3ff) << 10) | (c2 & 0x3ff));
      out.push(
        0xf0 | (u >> 18),
        0x80 | ((u >> 12) & 0x3f),
        0x80 | ((u >> 6) & 0x3f),
        0x80 | (u & 0x3f)
      );
    }
  }
  return out;
}

function utf8Decode(bytes) {
  if (typeof TextDecoder !== 'undefined') {
    return new TextDecoder().decode(new Uint8Array(bytes));
  }
  var s = '';
  for (var i = 0; i < bytes.length; ) {
    var b = bytes[i++];
    if (b < 0x80) s += String.fromCharCode(b);
    else if (b < 0xe0) s += String.fromCharCode(((b & 0x1f) << 6) | (bytes[i++] & 0x3f));
    else if (b < 0xf0) {
      s += String.fromCharCode(
        ((b & 0x0f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f)
      );
    } else {
      var u =
        ((b & 0x07) << 18) |
        ((bytes[i++] & 0x3f) << 12) |
        ((bytes[i++] & 0x3f) << 6) |
        (bytes[i++] & 0x3f);
      u -= 0x10000;
      s += String.fromCharCode(0xd800 + (u >> 10), 0xdc00 + (u & 0x3ff));
    }
  }
  return s;
}

function pkcs5Pad(data) {
  var block = 8;
  var pad = block - (data.length % block);
  var out = data.slice();
  for (var i = 0; i < pad; i++) out.push(pad);
  return out;
}

function pkcs5Unpad(data) {
  if (!data || !data.length) return data;
  var pad = data[data.length - 1];
  if (pad < 1 || pad > 8 || pad > data.length) return data;
  return data.slice(0, data.length - pad);
}

// Base64 (sin depender de btoa en todos los runtimes)
var B64 =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function base64Encode(bytes) {
  var out = '';
  for (var i = 0; i < bytes.length; i += 3) {
    var a = bytes[i],
      b = i + 1 < bytes.length ? bytes[i + 1] : 0,
      c = i + 2 < bytes.length ? bytes[i + 2] : 0;
    out += B64[a >> 2];
    out += B64[((a & 3) << 4) | (b >> 4)];
    out += i + 1 < bytes.length ? B64[((b & 15) << 2) | (c >> 6)] : '=';
    out += i + 2 < bytes.length ? B64[c & 63] : '=';
  }
  return out;
}

function base64Decode(str) {
  str = String(str).replace(/=+$/, '');
  var out = [];
  for (var i = 0; i < str.length; i += 4) {
    var a = B64.indexOf(str[i]),
      b = B64.indexOf(str[i + 1]),
      c = B64.indexOf(str[i + 2]),
      d = B64.indexOf(str[i + 3]);
    out.push((a << 2) | (b >> 4));
    if (c >= 0) out.push(((b & 15) << 4) | (c >> 2));
    if (d >= 0) out.push(((c & 3) << 6) | d);
  }
  return out;
}

// ─── 3DES (CryptoJS si está, sino error claro) ─────────────────────────────
function ensureCrypto() {
  if (typeof CryptoJS === 'undefined') {
    throw new Error(
      'CryptoJS no está cargado. El runtime de la app debe inyectar crypto-js (assets).'
    );
  }
}

function encryptBody(plain) {
  ensureCrypto();
  var keyWords = CryptoJS.enc.Hex.parse(CFG.desKeyHex);
  var encrypted = CryptoJS.TripleDES.encrypt(plain, keyWords, {
    mode: CryptoJS.mode.ECB,
    padding: CryptoJS.pad.Pkcs7,
  });
  // CryptoJS da Base64 del ciphertext; Magis espera hex(utf8(base64))
  var b64 = encrypted.toString(); // Base64
  return bytesToHex(utf8Encode(b64));
}

function decryptBlob(wire) {
  ensureCrypto();
  var inner = utf8Decode(hexToBytes(wire));
  var keyWords = CryptoJS.enc.Hex.parse(CFG.desKeyHex);
  var decrypted = CryptoJS.TripleDES.decrypt(
    { ciphertext: CryptoJS.enc.Base64.parse(inner) },
    keyWords,
    { mode: CryptoJS.mode.ECB, padding: CryptoJS.pad.Pkcs7 }
  );
  return decrypted.toString(CryptoJS.enc.Utf8);
}

// ─── MD5 estándar (para sn) ────────────────────────────────────────────────
function md5Hex(str) {
  ensureCrypto();
  return CryptoJS.MD5(str).toString(CryptoJS.enc.Hex);
}

// ─── Tweaked MD5 (sign_o3) — port de TweakedMd5.kt ─────────────────────────
var TMD5_SALT = utf8Encode('salt3333=4');
var TMD5_S = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5,
  9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11,
  16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15,
  21,
];
var TMD5_KT = (function () {
  var t = [];
  for (var i = 0; i < 64; i++) {
    t[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) >>> 0;
  }
  return t;
})();
var TMD5_ROUND1 = [
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
];
var TMD5_G = (function () {
  var g = [];
  for (var i = 0; i < 64; i++) {
    if (i < 16) g[i] = TMD5_ROUND1[i];
    else if (i < 32) g[i] = (5 * i + 1) % 16;
    else if (i < 48) g[i] = (3 * i + 5) % 16;
    else g[i] = (7 * i) % 16;
  }
  return g;
})();

function rotl(x, n) {
  var u = x >>> 0;
  return ((u << n) | (u >>> (32 - n))) >>> 0;
}

function tmd5Compress(state, block, off) {
  var m = [];
  for (var j = 0; j < 16; j++) {
    var p = off + j * 4;
    m[j] =
      (block[p] & 0xff) |
      ((block[p + 1] & 0xff) << 8) |
      ((block[p + 2] & 0xff) << 16) |
      ((block[p + 3] & 0xff) << 24);
  }
  var a = state[0],
    b = state[1],
    c = state[2],
    d = state[3];
  for (var i = 0; i < 64; i++) {
    var f;
    if (i < 16) f = (b & c) | (~b & d);
    else if (i < 32) f = (d & b) | (~d & c);
    else if (i < 48) f = b ^ c ^ d;
    else f = c ^ (b | ~d);
    f = f >>> 0;
    var sum = (f + a + TMD5_KT[i] + m[TMD5_G[i]]) >>> 0;
    a = d;
    d = c;
    c = b;
    b = (b + rotl(sum, TMD5_S[i])) >>> 0;
  }
  state[0] = (state[0] + a) >>> 0;
  state[1] = (state[1] + b) >>> 0;
  state[2] = (state[2] + c) >>> 0;
  state[3] = (state[3] + d) >>> 0;
}

function tweakedMd5Hex(msgBytes) {
  var state = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476];
  var remainder = msgBytes.length % 64;
  var i = 0;
  while (i + 64 <= msgBytes.length - remainder) {
    tmd5Compress(state, msgBytes, i);
    i += 64;
  }
  var tail = msgBytes.slice(msgBytes.length - remainder);
  var padLen = ((56 - (tail.length + 1)) % 64 + 64) % 64;
  var padding = [];
  for (var p = 0; p < padLen; p++) padding.push(0);
  var bits = msgBytes.length * 8;
  var length = [];
  for (var k = 0; k < 8; k++) length.push((bits >>> (k * 8)) & 0xff);
  var finalBlock = tail.concat([0x80], padding, length);
  for (var j = 0; j < finalBlock.length; j += 64) {
    tmd5Compress(state, finalBlock, j);
  }
  var sb = '';
  for (var w = 0; w < 4; w++) {
    for (var b = 0; b < 4; b++) {
      var hx = ((state[w] >>> (b * 8)) & 0xff).toString(16);
      if (hx.length < 2) hx = '0' + hx;
      sb += hx;
    }
  }
  return sb;
}

function signO3(token, startMoment) {
  var prefix =
    'token=' +
    token +
    '&sign2_method=sign_o3&instance=0&start_moment=' +
    startMoment;
  var bytes = utf8Encode(prefix).concat(TMD5_SALT);
  return tweakedMd5Hex(bytes);
}

// ─── HTTP (fetch del runtime) ──────────────────────────────────────────────
function httpPost(url, headers, body) {
  return new Promise(function (resolve, reject) {
    // El runtime de la app expone fetch / axios vía puente
    var opts = {
      method: 'POST',
      headers: headers || {},
      body: body,
    };
    var p;
    if (typeof fetch === 'function') {
      p = fetch(url, opts).then(function (r) {
        return r.text().then(function (t) {
          return { status: r.status, body: t };
        });
      });
    } else if (typeof httpFetch === 'function') {
      p = httpFetch(url, opts);
    } else {
      reject(new Error('No hay fetch HTTP en el runtime JS'));
      return;
    }
    p.then(resolve).catch(reject);
  });
}

function sleep(ms) {
  return new Promise(function (r) {
    setTimeout(r, ms);
  });
}

async function throttle() {
  var now = Date.now();
  var delta = now - STATE.lastCallMs;
  if (delta < 400) await sleep(400 - delta);
  STATE.lastCallMs = Date.now();
}

function deviceDict(snOverride) {
  return {
    loginType: '2',
    appLanguage: 'en',
    apkVersion: CFG.apkVersion,
    sysVersion: CFG.spkgVer,
    appId: CFG.appId,
    hardwareInfo: 'ranchu',
    model: 'sdk_gphone64_arm64',
    product: 'sdk_gphone64_arm64',
    cpu: 'arm64-v8a',
    B29: '',
    reserve1: '',
    deviceToken: '',
    sn: snOverride != null ? snOverride : STATE.sn || '',
    drmId: '',
    sdkVer: 36,
  };
}

function hostOrder() {
  var hosts = CFG.hosts.filter(Boolean);
  if (!hosts.length) return [];
  if (STATE.preferredHost && hosts.indexOf(STATE.preferredHost) >= 0) {
    return [STATE.preferredHost].concat(
      hosts.filter(function (h) {
        return h !== STATE.preferredHost;
      })
    );
  }
  return hosts;
}

async function portalCall(path, bean, opts) {
  opts = opts || {};
  var baseFields = opts.baseFields !== false;
  var bodyMap = {};
  if (baseFields) {
    bodyMap.portalCode = CFG.portalCode;
    bodyMap.userId = STATE.userId || '';
    bodyMap.userToken = STATE.userToken || '';
  }
  if (bean) {
    for (var k in bean) if (Object.prototype.hasOwnProperty.call(bean, k)) bodyMap[k] = bean[k];
  }
  var dd = deviceDict(opts.sn);
  for (var d in dd) if (Object.prototype.hasOwnProperty.call(dd, d)) bodyMap[d] = dd[d];

  var plain = JSON.stringify(bodyMap);
  var wire = encryptBody(plain);
  var headers = {
    'Content-Type': 'application/json;charset=utf-8',
    apk: CFG.appId,
    apkVer: '43404',
    spkgVer: CFG.spkgVer,
    'User-Agent': 'okhttp/3.12.12',
  };

  await throttle();
  var lastError = null;
  var hosts = hostOrder();
  for (var hi = 0; hi < hosts.length; hi++) {
    var host = hosts[hi];
    var url = CFG.scheme + '://' + host + '/api/portalCore/' + path;
    try {
      var res = await httpPost(url, headers, wire);
      if (!res || res.status < 200 || res.status >= 300) {
        lastError = 'HTTP ' + (res && res.status);
        continue;
      }
      var j = JSON.parse(res.body);
      var rc = String(j.returnCode != null ? j.returnCode : j.retCode != null ? j.retCode : '');
      if (rc && rc !== '0' && rc !== '0000' && rc !== '200') {
        var msg = String(j.returnMsg || j.retMsg || j.msg || j.message || rc);
        return { ok: false, code: rc, message: msg };
      }
      STATE.preferredHost = host;
      var dataField = j.data;
      if (typeof dataField === 'string' && dataField.trim()) {
        try {
          var decrypted = decryptBlob(dataField.trim());
          var inner = JSON.parse(decrypted);
          return { ok: true, data: inner };
        } catch (e) {
          try {
            var inner2 = JSON.parse(dataField);
            return { ok: true, data: inner2 };
          } catch (_) {
            lastError = 'decrypt: ' + e;
            continue;
          }
        }
      }
      if (dataField && typeof dataField === 'object') {
        return { ok: true, data: dataField };
      }
      return { ok: true, data: j };
    } catch (e) {
      lastError = e;
    }
  }
  return {
    ok: false,
    code: 'network',
    message: 'todos los hosts fallaron: ' + lastError,
  };
}

// ─── Sesión ────────────────────────────────────────────────────────────────
async function ensureAnonymous() {
  if (STATE.userToken) return { ok: true };
  if (STATE.sn) {
    var act = await activate('');
    if (act.ok) return act;
  }
  return mintDevice();
}

async function mintDevice() {
  var r = await portalCall(
    'v3/snToken',
    {
      loginType: '2',
      appLanguage: 'en',
      apkVersion: CFG.apkVersion,
      sysVersion: CFG.spkgVer,
      appId: CFG.appId,
      hardwareInfo: 'ranchu',
      model: 'sdk_gphone64_arm64',
      product: 'sdk_gphone64_arm64',
      cpu: 'arm64-v8a',
      B29: '',
      reserve1: '',
      deviceToken: '',
      sn: '',
      drmId: '',
      sdkVer: 36,
    },
    { baseFields: false }
  );
  if (!r.ok) return r;
  var snToken = String((r.data && r.data.snToken) || '').trim();
  if (!snToken) {
    return { ok: false, code: 'snToken_failed', message: 'sin snToken' };
  }
  var snVal = String((r.data && r.data.sn) || '')
    .trim()
    .toLowerCase();
  if (!snVal) snVal = md5Hex(snToken + CFG.snTokenSalt);
  STATE.sn = snVal;
  return activate(snToken);
}

async function activate(snToken) {
  var r = await portalCall(
    'v8/active',
    {
      snToken: snToken || '',
      authVersion: '',
      authCode: '',
      preCode: '',
      macAddr: CFG.fixedMac,
      reserve1: '',
      openNum: 4,
      channel: 'default',
      matadata: '',
      signdata: '',
    },
    { baseFields: false }
  );
  if (!r.ok) return r;
  var ut = String((r.data && r.data.userToken) || '').trim();
  if (!ut) {
    return { ok: false, code: 'active_sin_token', message: 'sin userToken' };
  }
  STATE.userId = String((r.data && r.data.userId) || '');
  STATE.userToken = ut;
  STATE.jwtToken = String((r.data && r.data.jwtToken) || '');
  if (r.data && r.data.sn) STATE.sn = String(r.data.sn);
  return { ok: true };
}

async function login(email, password) {
  email = String(email || '').trim();
  password = String(password || '');
  if (!email || !password) {
    return { ok: false, code: 'auth', message: 'email y password requeridos' };
  }
  // Asegurar dispositivo anónimo primero (como Kino)
  var anon = await ensureAnonymous();
  if (!anon.ok && !STATE.sn) {
    // seguir igual; algunos builds aceptan login sin sn
  }
  var passHash = md5Hex(password + CFG.passwordSalt);
  var r = await portalCall('v8/login', {
    email: email,
    password: passHash,
    loginType: '1',
  });
  if (!r.ok) return r;
  var ut = String((r.data && r.data.userToken) || '').trim();
  if (!ut) {
    return { ok: false, code: 'login_sin_token', message: 'login sin userToken' };
  }
  STATE.userId = String((r.data && r.data.userId) || STATE.userId);
  STATE.userToken = ut;
  STATE.jwtToken = String((r.data && r.data.jwtToken) || STATE.jwtToken);
  STATE.email = email;
  STATE.password = password;
  return { ok: true };
}

async function ensureSession() {
  if (STATE.userToken) return { ok: true };
  if (STATE.email && STATE.password) {
    var lr = await login(STATE.email, STATE.password);
    if (lr.ok) return lr;
  }
  return ensureAnonymous();
}

// ─── Catálogo ──────────────────────────────────────────────────────────────
function categoryName(raw) {
  var s = String(raw || '').trim();
  if (!s) return 'Sin nombre';
  return s;
}

function isAdult(name) {
  var n = String(name || '').toLowerCase();
  return (
    n.indexOf('adult') >= 0 ||
    n.indexOf('+18') >= 0 ||
    n.indexOf('xxx') >= 0 ||
    n.indexOf('erotic') >= 0
  );
}

async function fetchCategories(force) {
  if (!force && STATE.categoriesCache) return { ok: true, data: STATE.categoriesCache };
  var s = await ensureSession();
  if (!s.ok) return s;

  var r = await portalCall('v6/nextColumns', {
    columnCode: CFG.liveRoot,
    pageNum: 1,
    pageSize: 200,
  });
  var out = [];
  if (r.ok && r.data) {
    var list = r.data.recommendList || r.data.columnList || r.data.list || [];
    if (Array.isArray(list)) {
      for (var i = 0; i < list.length; i++) {
        var c = list[i];
        if (!c || typeof c !== 'object') continue;
        var id = parseInt(c.columnId != null ? c.columnId : c.id, 10);
        if (isNaN(id)) continue;
        var name = categoryName(c.name);
        out.push({ id: id, name: name, adult: isAdult(name) });
      }
    }
  }
  var hasAll = out.some(function (c) {
    return c.id === CFG.allCategoryId;
  });
  if (!hasAll) {
    out.unshift({ id: CFG.allCategoryId, name: 'Todos', adult: false });
  }
  if (!out.length) {
    out.push({ id: CFG.allCategoryId, name: 'Todos', adult: false });
  }
  STATE.categoriesCache = out;
  return { ok: true, data: out };
}

async function fetchChannels(columnId, force) {
  columnId = columnId || CFG.allCategoryId;
  if (!force && STATE.channelsCache[columnId]) {
    return { ok: true, data: STATE.channelsCache[columnId] };
  }
  var s = await ensureSession();
  if (!s.ok) return s;

  var all = [];
  var page = 1;
  var maxPages = 6;
  var pageSize = 500;
  while (page <= maxPages) {
    var r = await portalCall('v6/getLiveData', {
      columnId: columnId,
      pageNum: page,
      pageSize: pageSize,
      type: '1',
    });
    if (!r.ok) {
      if (page === 1) return r;
      break;
    }
    var list =
      (r.data && (r.data.liveList || r.data.list || r.data.channelList)) || [];
    if (!Array.isArray(list) || !list.length) break;
    for (var i = 0; i < list.length; i++) {
      var ch = list[i];
      if (!ch || typeof ch !== 'object') continue;
      var code = String(ch.channelCode || ch.code || ch.liveCode || '').trim();
      if (!code) continue;
      var name = String(ch.name || ch.channelName || code).trim();
      var number = parseInt(ch.channelNumber || ch.number || 0, 10) || 0;
      var logo = ch.logo || ch.posterUrl || ch.icon || null;
      all.push({
        code: code,
        name: name,
        number: number,
        logo: logo,
        adult: isAdult(name) || ch.adult === true,
        provider: 'xuper',
      });
    }
    if (list.length < pageSize) break;
    page++;
  }
  // dedupe by code
  var seen = {};
  var uniq = [];
  for (var j = 0; j < all.length; j++) {
    if (seen[all[j].code]) continue;
    seen[all[j].code] = true;
    uniq.push(all[j]);
  }
  STATE.channelsCache[columnId] = uniq;
  return { ok: true, data: uniq };
}

// ─── Resolve stream ────────────────────────────────────────────────────────
function extractTokenFromAuthBase(authBase) {
  if (!authBase) return '';
  var m = String(authBase).match(/[?&]token=([0-9a-fA-F]{32})/);
  return m ? m[1] : '';
}

async function resolveChannel(channelCode) {
  var s = await ensureSession();
  if (!s.ok) return s;
  if (!STATE.email) {
    // Live suele exigir cuenta
    log('sin cuenta: intentando igual (puede fallar)');
  }

  var play = await portalCall('v4/startPlayLive', {
    channelCode: channelCode,
    columnId: 0,
    type: '1',
  });
  if (!play.ok) return play;

  var data = play.data || {};
  var liveAddressList = data.liveAddressList || data.addressList || [];
  var license = '';
  var playCode = channelCode;
  if (Array.isArray(liveAddressList) && liveAddressList.length) {
    var first = liveAddressList[0];
    if (typeof first === 'object') {
      license = String(first.license || first.licence || first.key || '');
      playCode = String(first.playCode || first.code || channelCode);
    }
  }
  if (!license && data.license) license = String(data.license);
  if (!license) {
    return {
      ok: false,
      code: 'live_no_license',
      message: 'Sin licencia para ' + channelCode,
    };
  }

  var slb = await portalCall('v14/getSlbInfo', {
    hasPay: '0',
    userIdentity: '1',
    type: 'merge',
    appVer: CFG.apkVersion,
    lang: 'es',
    encMediaSupported: 1,
    liveCodeList: [channelCode],
    appParams: '',
    reserve1: CFG.fixedMac,
  });
  if (!slb.ok) return slb;

  var cdns = [];
  var slbData = slb.data || {};
  var cflList =
    slbData.cflList ||
    slbData.cdnList ||
    slbData.liveCdnList ||
    slbData.list ||
    [];
  if (!Array.isArray(cflList) && typeof cflList === 'object') {
    cflList = Object.keys(cflList).map(function (k) {
      return cflList[k];
    });
  }
  if (Array.isArray(cflList)) {
    for (var i = 0; i < cflList.length; i++) {
      var item = cflList[i];
      if (!item || typeof item !== 'object') continue;
      var tag = String(item.tag || item.type || '').toLowerCase();
      if (tag && tag !== 'live' && tag !== 'cfl') continue;
      var host = String(item.cflHost || item.host || item.domain || '').trim();
      var auth = String(item.authBase || item.auth || item.url || '').trim();
      if (host && auth) cdns.push({ cflHost: host, authBase: auth });
    }
  }
  // fallback: campos planos
  if (!cdns.length && slbData.cflHost && slbData.authBase) {
    cdns.push({
      cflHost: String(slbData.cflHost),
      authBase: String(slbData.authBase),
    });
  }
  if (!cdns.length) {
    return {
      ok: false,
      code: 'live_no_cfl_cdn',
      message: 'No hay CDN cfl para ' + channelCode,
    };
  }

  var cdn = cdns[0];
  var token = extractTokenFromAuthBase(cdn.authBase);
  if (!token) {
    return {
      ok: false,
      code: 'live_no_cfl_token',
      message: 'authBase sin token= para ' + channelCode,
    };
  }

  var moment = Date.now();
  var sign = signO3(token, moment);
  // Headers típicos Magis HLS
  var headers = {
    'Content-Auth':
      'token=' + token + ';sign=' + sign + ';start_moment=' + moment,
    'Content-License': license,
    'User-Agent': 'okhttp/3.12.12',
  };

  var playlistUrl =
    'http://' + cdn.cflHost + '/live/' + playCode + '.m3u8?token=' + token;

  return {
    ok: true,
    data: {
      url: playlistUrl,
      playCode: playCode,
      license: license,
      token: token,
      cflHost: cdn.cflHost,
      authBase: cdn.authBase,
      headers: headers,
      // el player debe regenerar Content-Auth por segmento con sign_o3
      // si no, la reproducción se corta; para eso existe LiveHlsProxy en Dart
    },
  };
}

// ─── API del addon (Nuvio / lolplus) ────────────────────────────────────────

/**
 * La app NO llama a setConfig del plugin.
 * Guarda la config del usuario en:
 *   globalThis.__nuvioConfig.current
 *   globalThis.__nuvioConfig['magis-live']
 * Solo leemos email y password. Hosts/clave fijos.
 */
function applyNuvioConfig() {
  var cfg = null;
  try {
    var root = globalThis.__nuvioConfig || (typeof __nuvioConfig !== 'undefined' ? __nuvioConfig : null);
    if (root) {
      cfg = root.current || root['magis-live'] || root['magis_live'] || null;
      // a veces es un mapa por id; tomar el primer objeto con email
      if (!cfg || typeof cfg !== 'object') {
        for (var k in root) {
          if (!Object.prototype.hasOwnProperty.call(root, k)) continue;
          var v = root[k];
          if (v && typeof v === 'object' && (v.email || v.password)) {
            cfg = v;
            break;
          }
        }
      }
    }
  } catch (_) {}

  if (!cfg || typeof cfg !== 'object') return false;

  var email = String(cfg.email || cfg.user || cfg.usuario || cfg.correo || '').trim();
  var password = String(cfg.password || cfg.pass || cfg.contraseña || cfg.contrasena || '');

  var changed = false;
  if (email && email !== STATE.email) {
    STATE.email = email;
    changed = true;
  }
  if (password && password !== STATE.password) {
    STATE.password = password;
    changed = true;
  }
  if (changed) {
    STATE.userToken = '';
    STATE.userId = '';
    STATE.categoriesCache = null;
    STATE.channelsCache = {};
    log('config leída de __nuvioConfig, email=', STATE.email ? 'sí' : 'no');
  }
  return !!(STATE.email && STATE.password);
}

/** Compat: si algún runtime llama setConfig del export */
function setConfig(config) {
  if (!config || typeof config !== 'object') return;
  if (config.email) STATE.email = String(config.email).trim();
  if (config.password) STATE.password = String(config.password);
  STATE.userToken = '';
  STATE.userId = '';
  STATE.categoriesCache = null;
  STATE.channelsCache = {};
  log('setConfig export, email=', STATE.email ? 'sí' : 'no');
}

async function getHome() {
  try {
    applyNuvioConfig();
    if (!STATE.email || !STATE.password) {
      return [
        {
          title: 'Configura tu cuenta',
          items: [
            {
              id: 'magis:config',
              type: 'channel',
              name: 'Abre Configuración del repo, escribe email y contraseña, pulsa Guardar y vuelve a Home',
              poster: null,
            },
          ],
        },
      ];
    }
    var lr = await login(STATE.email, STATE.password);
    if (!lr.ok) {
      return [
        {
          title: 'Error de login',
          items: [
            {
              id: 'magis:error',
              type: 'channel',
              name: (lr.code || '') + ': ' + (lr.message || 'login falló'),
              poster: null,
            },
          ],
        },
      ];
    }
    var cats = await fetchCategories(true);
    if (!cats.ok) {
      return [
        {
          title: 'Error catálogo',
          items: [
            {
              id: 'magis:error',
              type: 'channel',
              name: (cats.code || '') + ': ' + (cats.message || ''),
              poster: null,
            },
          ],
        },
      ];
    }
    var rows = [];
    // "Todos" primero (limitado)
    var allCh = await fetchChannels(CFG.allCategoryId, true);
    if (allCh.ok && allCh.data && allCh.data.length) {
      rows.push({
        title: 'Todos los canales',
        items: allCh.data.slice(0, 80).map(channelToItem),
      });
    }
    for (var i = 0; i < cats.data.length; i++) {
      var cat = cats.data[i];
      if (cat.id === CFG.allCategoryId) continue;
      var ch = await fetchChannels(cat.id, false);
      if (!ch.ok || !ch.data || !ch.data.length) continue;
      rows.push({
        title: cat.name,
        items: ch.data.slice(0, 40).map(channelToItem),
      });
      if (rows.length >= 12) break;
    }
    return rows;
  } catch (e) {
    log('getHome error', e);
    return [
      {
        title: 'Error',
        items: [
          {
            id: 'magis:error',
            type: 'channel',
            name: String(e && e.message ? e.message : e),
            poster: null,
          },
        ],
      },
    ];
  }
}

function channelToItem(ch) {
  return {
    id: 'magis:' + ch.code,
    type: 'channel',
    name: ch.name,
    poster: ch.logo || null,
    logo: ch.logo || null,
    description: 'Canal #' + (ch.number || '') + ' · ' + ch.code,
    genres: ch.adult ? ['Adultos'] : ['Live'],
  };
}

async function search(query) {
  applyNuvioConfig();
  query = String(query || '')
    .trim()
    .toLowerCase();
  if (!query) return [];
  try {
    if (STATE.email && STATE.password && !STATE.userToken) {
      await login(STATE.email, STATE.password);
    }
    var all = await fetchChannels(CFG.allCategoryId, false);
    if (!all.ok) return [];
    return all.data
      .filter(function (ch) {
        return (
          ch.name.toLowerCase().indexOf(query) >= 0 ||
          ch.code.toLowerCase().indexOf(query) >= 0
        );
      })
      .slice(0, 50)
      .map(channelToItem);
  } catch (e) {
    log('search', e);
    return [];
  }
}

async function getMeta(id) {
  applyNuvioConfig();
  id = String(id || '').replace(/^magis:/, '');
  if (!id || id === 'config' || id === 'error') {
    return {
      id: 'magis:' + id,
      type: 'channel',
      name: id,
      description: 'Configura email/password en el repo.',
    };
  }
  try {
    var all = await fetchChannels(CFG.allCategoryId, false);
    var ch = null;
    if (all.ok) {
      for (var i = 0; i < all.data.length; i++) {
        if (all.data[i].code === id) {
          ch = all.data[i];
          break;
        }
      }
    }
    if (!ch) {
      return {
        id: 'magis:' + id,
        type: 'channel',
        name: id,
        description: 'Canal live Magis',
      };
    }
    return {
      id: 'magis:' + ch.code,
      type: 'channel',
      name: ch.name,
      poster: ch.logo,
      logo: ch.logo,
      description: 'En vivo · código ' + ch.code,
      genres: ['Live', 'TV'],
    };
  } catch (e) {
    return { id: 'magis:' + id, type: 'channel', name: id };
  }
}

async function getStreams(id, type, season, episode) {
  applyNuvioConfig();
  id = String(id || '').replace(/^magis:/, '');
  if (!id || id === 'config' || id === 'error') return [];
  try {
    if (STATE.email && STATE.password) {
      var lr = await login(STATE.email, STATE.password);
      if (!lr.ok) {
        log('login en getStreams falló', lr);
      }
    }
    var r = await resolveChannel(id);
    if (!r.ok) {
      log('resolve fail', r);
      return [];
    }
    var d = r.data;
    return [
      {
        url: d.url,
        name: 'Magis Live · ' + id,
        quality: 'HD',
        language: 'es',
        provider: 'magis',
        isHls: true,
        headers: d.headers,
        // behaviorHints estilo Stremio por si el player los usa
        behaviorHints: {
          notWebReady: true,
          proxyHeaders: {
            request: d.headers,
          },
        },
      },
    ];
  } catch (e) {
    log('getStreams', e);
    return [];
  }
}

async function getDiscover() {
  return getHome();
}

async function getNews() {
  return [];
}

// Export CommonJS (lo que espera el runtime de la app)
module.exports = {
  setConfig: setConfig,
  getHome: getHome,
  getDiscover: getDiscover,
  search: search,
  getMeta: getMeta,
  getStreams: getStreams,
  getNews: getNews,
};
