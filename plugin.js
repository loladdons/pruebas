var DEFAULT_M3U_URL = 'https://raw.githubusercontent.com/nicor1029/Argentina/refs/heads/main/arglo.m3u';
var DEFAULT_UA = 'VLC/3.0.16 LibVLC/3.0.16';
var DEFAULT_CACHE_MIN = 5;

var __m3uCache = { url: '', at: 0, channels: [] };

function _cfg(ctx) {
  var c = {};
  if (ctx) {
    if (ctx.config) c = ctx.config;
    else if (ctx.userConfig) c = ctx.userConfig;
    else if (ctx.settings) c = ctx.settings;
  }
  if (typeof c === 'string') {
    try { c = JSON.parse(c); } catch (e) { c = {}; }
  }
  if (!c || typeof c !== 'object') c = {};
  return c;
}

function _str(v, d) {
  if (v === null || v === undefined || v === '') return d;
  return String(v);
}

function _num(v, d) {
  var n = parseInt(v, 10);
  if (isNaN(n)) return d;
  return n;
}

function _headers(cfg) {
  return {
    'User-Agent': _str(cfg.user_agent, DEFAULT_UA),
    'Accept': '*/*',
    'Connection': 'keep-alive'
  };
}

function _slug(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .substring(0, 80) || 'ch';
}

function _attr(line, name) {
  var re = new RegExp(name + '="([^"]*)"', 'i');
  var m = line.match(re);
  if (m) return m[1];
  re = new RegExp(name + '=([^,\\s]+)', 'i');
  m = line.match(re);
  if (m) return m[1];
  return '';
}

function _titleFromExtinf(line) {
  var i = line.lastIndexOf(',');
  if (i < 0) return 'Canal';
  var t = line.substring(i + 1).trim();
  return t || 'Canal';
}

function _isUrl(line) {
  var s = String(line || '').trim();
  if (!s || s.charAt(0) === '#') return false;
  if (/^https?:\/\//i.test(s)) return true;
  if (/^rtmp:\/\//i.test(s)) return true;
  if (/^udp:\/\//i.test(s)) return true;
  return false;
}

function _parseM3U(text) {
  var lines = String(text || '').replace(/\r/g, '\n').split('\n');
  var channels = [];
  var pending = null;
  var urlBuf = '';

  function flushUrl(url) {
    if (!pending || !url) {
      pending = null;
      urlBuf = '';
      return;
    }
    var u = String(url).trim();
    if (urlBuf) {
      u = (urlBuf + u).replace(/\s+/g, '');
      urlBuf = '';
    }
    if (!_isUrl(u)) {
      pending = null;
      return;
    }
    channels.push({
      id: pending.id,
      title: pending.title,
      poster: pending.logo || '',
      logo: pending.logo || '',
      group: pending.group || 'Otros',
      url: u,
      tvgId: pending.tvgId || '',
      type: 'channel'
    });
    pending = null;
  }

  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].trim();
    if (!line) continue;

    if (line.indexOf('#EXTINF') === 0) {
      var logo = _attr(line, 'tvg-logo') || _attr(line, 'logo');
      var group = _attr(line, 'group-title') || _attr(line, 'group') || 'Otros';
      var tvgId = _attr(line, 'tvg-id') || _attr(line, 'tvg-name');
      var title = _titleFromExtinf(line);
      pending = {
        id: 'ch_' + _slug(group) + '_' + _slug(title) + '_' + channels.length,
        title: title,
        logo: logo,
        group: group,
        tvgId: tvgId
      };
      urlBuf = '';
      continue;
    }

    if (line.charAt(0) === '#') continue;

    if (pending) {
      if (_isUrl(line)) {
        flushUrl(line);
      } else if (urlBuf) {
        flushUrl(urlBuf + line);
      } else if (line.indexOf('/') >= 0 || line.indexOf('.m3u') >= 0) {
        urlBuf = line;
      }
    }
  }
  if (pending && urlBuf) flushUrl(urlBuf);
  return channels;
}

function _loadChannels(ctx) {
  var cfg = _cfg(ctx);
  var url = _str(cfg.m3u_url, DEFAULT_M3U_URL).trim();
  if (!url) url = DEFAULT_M3U_URL;

  var cacheMin = _num(cfg.cache_minutes, DEFAULT_CACHE_MIN);
  var now = Date.now();
  if (__m3uCache.url === url && __m3uCache.channels.length > 0 &&
      (now - __m3uCache.at) < cacheMin * 60 * 1000) {
    return Promise.resolve(__m3uCache.channels);
  }

  return fetch(url, {
    method: 'GET',
    headers: _headers(cfg)
  }).then(function (res) {
    if (!res.ok) {
      throw new Error('HTTP ' + res.status + ' al descargar M3U');
    }
    return res.text();
  }).then(function (text) {
    if (!text || (text.indexOf('#EXTINF') < 0 && text.indexOf('#EXT') < 0)) {
      throw new Error('La URL no parece una lista M3U valida');
    }
    var channels = _parseM3U(text);
    if (!channels.length) {
      throw new Error('No se encontraron canales en la lista');
    }
    __m3uCache = { url: url, at: Date.now(), channels: channels };
    return channels;
  });
}

function _item(ch) {
  return {
    id: ch.id,
    title: ch.title,
    poster: ch.poster || ch.logo || null,
    logo: ch.logo || ch.poster || null,
    backdrop: ch.logo || ch.poster || null,
    type: 'channel',
    overview: ch.group ? ('Grupo: ' + ch.group) : '',
    extra: {
      group: ch.group,
      streamUrl: ch.url,
      tvgId: ch.tvgId || ''
    }
  };
}

function _groupRows(channels) {
  var map = {};
  var order = [];
  var i, g, name, j;
  for (i = 0; i < channels.length; i++) {
    g = channels[i].group || 'Otros';
    if (!map[g]) {
      map[g] = [];
      order.push(g);
    }
    map[g].push(_item(channels[i]));
  }
  var rows = [];
  var heroItems = [];
  var limit = channels.length < 12 ? channels.length : 12;
  for (i = 0; i < limit; i++) {
    heroItems.push(_item(channels[i]));
  }
  if (heroItems.length) {
    rows.push({
      id: 'hero_live',
      title: 'En vivo',
      type: 'hero',
      items: heroItems
    });
  }
  for (j = 0; j < order.length; j++) {
    name = order[j];
    rows.push({
      id: 'grp_' + _slug(name),
      title: name,
      type: 'row',
      items: map[name]
    });
  }
  return rows;
}

function getHome(ctx) {
  return _loadChannels(ctx || {}).then(function (channels) {
    return { rows: _groupRows(channels) };
  });
}

function search(ctx, query) {
  var q = _str(query, '').trim().toLowerCase();
  if (!q) return Promise.resolve({ items: [] });
  return _loadChannels(ctx || {}).then(function (channels) {
    var items = [];
    for (var i = 0; i < channels.length; i++) {
      var ch = channels[i];
      var hay = (ch.title + ' ' + ch.group + ' ' + (ch.tvgId || '')).toLowerCase();
      if (hay.indexOf(q) >= 0) items.push(_item(ch));
    }
    return { items: items };
  });
}

function getMeta(ctx, id) {
  return _loadChannels(ctx || {}).then(function (channels) {
    for (var i = 0; i < channels.length; i++) {
      if (channels[i].id === id) {
        var ch = channels[i];
        return {
          item: {
            id: ch.id,
            title: ch.title,
            poster: ch.poster || ch.logo,
            logo: ch.logo || ch.poster,
            type: 'channel',
            overview: 'Canal en vivo - ' + (ch.group || ''),
            extra: { group: ch.group, streamUrl: ch.url }
          }
        };
      }
    }
    return { item: { id: id, title: id, type: 'channel' } };
  });
}

function getStreams(id, type, season, episode, ctx) {
  var ctxObj = ctx;
  var channelId = id;
  if (id && typeof id === 'object') {
    ctxObj = id;
    channelId = id.id || id.contentId || id.channelId;
  }
  if (type && typeof type === 'object' && !ctxObj) ctxObj = type;

  return _loadChannels(ctxObj || {}).then(function (channels) {
    var ch = null;
    var i;
    for (i = 0; i < channels.length; i++) {
      if (channels[i].id === channelId) {
        ch = channels[i];
        break;
      }
    }
    if (!ch && channelId && /^https?:/i.test(String(channelId))) {
      ch = { title: 'Directo', url: channelId, group: 'Live' };
    }
    if (!ch) return { streams: [] };

    var cfg = _cfg(ctxObj || {});
    var headers = _headers(cfg);
    var url = ch.url;
    var isHls = /\.m3u8(\?|$)/i.test(url) || /mpegurl/i.test(url);

    return {
      streams: [
        {
          name: ch.group ? (ch.group + ' - Principal') : 'Principal',
          title: ch.title || 'Live',
          url: url,
          quality: isHls ? 'HLS' : 'Live',
          language: 'Live',
          provider: 'M3U',
          isHls: isHls,
          headers: headers
        }
      ]
    };
  });
}

module.exports = {
  getHome: getHome,
  search: search,
  getMeta: getMeta,
  getStreams: getStreams
};
