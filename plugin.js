/**
 * IPTV M3U Live — plugin para Lol+
 * - getHome: filas por group-title, items type=channel
 * - getStreams: URL del canal + headers
 * - search / getMeta
 *
 * Config (userConfig / lol.json config):
 *   m3u_url, user_agent, cache_minutes, referer
 */

var __m3uCache = { url: '', at: 0, channels: [] };

function _cfg(ctx) {
  var c = (ctx && (ctx.config || ctx.userConfig || ctx.settings)) || {};
  if (typeof c === 'string') {
    try { c = JSON.parse(c); } catch (_) { c = {}; }
  }
  return c || {};
}

function _str(v, d) {
  if (v == null || v === '') return d == null ? '' : String(d);
  return String(v);
}

function _num(v, d) {
  var n = parseInt(v, 10);
  return isNaN(n) ? d : n;
}

function _headers(cfg) {
  var h = {
    'User-Agent': _str(cfg.user_agent, 'VLC/3.0.16 LibVLC/3.0.16'),
    'Accept': '*/*',
    'Connection': 'keep-alive'
  };
  var ref = _str(cfg.referer, '').trim();
  if (ref) h['Referer'] = ref;
  return h;
}

function _slug(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9áéíóúñü]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'ch';
}

function _attr(line, name) {
  // tvg-logo="..." o group-title="..."
  var re = new RegExp(name + '="([^"]*)"', 'i');
  var m = line.match(re);
  if (m) return m[1];
  re = new RegExp(name + "=([^,\\s]+)", 'i');
  m = line.match(re);
  return m ? m[1] : '';
}

function _titleFromExtinf(line) {
  // Tras la última coma
  var i = line.lastIndexOf(',');
  if (i < 0) return 'Canal';
  var t = line.slice(i + 1).trim();
  return t || 'Canal';
}

function _isUrl(line) {
  var s = String(line || '').trim();
  if (!s || s[0] === '#') return false;
  return /^(https?:)?\/\//i.test(s) || /^rtmp:\/\//i.test(s) || /^udp:\/\//i.test(s);
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
    var u = url.trim();
    // Completar URLs relativas rotas (línea partida)
    if (urlBuf) {
      u = (urlBuf + u).replace(/\s+/g, '');
      urlBuf = '';
    }
    if (!_isUrl(u) && !/^https?:/i.test(u)) {
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

    if (line[0] === '#') continue;

    // URL (puede venir partida en 2 líneas en listas mal formadas)
    if (pending) {
      if (_isUrl(line) || /^[a-z0-9]/./?&=%+~-]+$/i.test(line)) {
        // Si parece URL incompleta sin protocolo y no hay pending url aún
        if (!_isUrl(line) && line.indexOf('http') !== 0) {
          // ¿continuación de URL anterior?
          if (urlBuf) {
            flushUrl(urlBuf + line);
          } else if (line.indexOf('/') >= 0 || line.indexOf('.m3u') >= 0) {
            // a veces la URL empieza en la línea anterior cortada; ignorar basura
            urlBuf = line;
          }
        } else {
          flushUrl(line);
        }
      }
    }
  }
  if (pending && urlBuf) flushUrl(urlBuf);

  return channels;
}

async function _loadChannels(ctx) {
  var cfg = _cfg(ctx);
  var url = _str(cfg.m3u_url, '').trim();
  if (!url) {
    throw new Error('Configura m3u_url en Ajustes del repo');
  }
  var cacheMin = _num(cfg.cache_minutes, 5);
  var now = Date.now();
  if (__m3uCache.url === url && __m3uCache.channels.length &&
      (now - __m3uCache.at) < cacheMin * 60 * 1000) {
    return __m3uCache.channels;
  }

  var res = await fetch(url, {
    method: 'GET',
    headers: _headers(cfg)
  });
  if (!res.ok) {
    throw new Error('HTTP ' + res.status + ' al descargar M3U');
  }
  var text = await res.text();
  if (!text || text.indexOf('#EXT') < 0) {
    // Algunas listas no traen cabecera pero sí EXTINF
    if (!text || text.indexOf('#EXTINF') < 0) {
      throw new Error('La URL no parece una lista M3U válida');
    }
  }
  var channels = _parseM3U(text);
  if (!channels.length) {
    throw new Error('No se encontraron canales en la lista');
  }
  __m3uCache = { url: url, at: now, channels: channels };
  return channels;
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
  for (var i = 0; i < channels.length; i++) {
    var g = channels[i].group || 'Otros';
    if (!map[g]) {
      map[g] = [];
      order.push(g);
    }
    map[g].push(_item(channels[i]));
  }
  var rows = [];
  // Fila destacada con los primeros
  var heroItems = channels.slice(0, Math.min(12, channels.length)).map(_item);
  if (heroItems.length) {
    rows.push({
      id: 'hero_live',
      title: 'En vivo',
      type: 'hero',
      items: heroItems
    });
  }
  for (var j = 0; j < order.length; j++) {
    var name = order[j];
    rows.push({
      id: 'grp_' + _slug(name),
      title: name,
      type: 'row',
      items: map[name]
    });
  }
  return rows;
}

async function getHome(ctx) {
  var channels = await _loadChannels(ctx || {});
  return { rows: _groupRows(channels) };
}

async function search(ctx, query) {
  var q = _str(query, '').trim().toLowerCase();
  if (!q) return { items: [] };
  var channels = await _loadChannels(ctx || {});
  var items = [];
  for (var i = 0; i < channels.length; i++) {
    var ch = channels[i];
    var hay = (ch.title + ' ' + ch.group + ' ' + (ch.tvgId || '')).toLowerCase();
    if (hay.indexOf(q) >= 0) items.push(_item(ch));
  }
  return { items: items };
}

async function getMeta(ctx, id) {
  var channels = await _loadChannels(ctx || {});
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
          overview: 'Canal en vivo · ' + (ch.group || ''),
          extra: { group: ch.group, streamUrl: ch.url }
        }
      };
    }
  }
  return { item: { id: id, title: id, type: 'channel' } };
}

async function getStreams(id, type, season, episode, ctx) {
  // Firma flexible: getStreams(id) | getStreams(id,type,...) | getStreams({id})
  var ctxObj = ctx;
  var channelId = id;
  if (id && typeof id === 'object') {
    ctxObj = id;
    channelId = id.id || id.contentId || id.channelId;
  }
  if (type && typeof type === 'object' && !ctxObj) ctxObj = type;

  var channels = await _loadChannels(ctxObj || {});
  var ch = null;
  for (var i = 0; i < channels.length; i++) {
    if (channels[i].id === channelId) {
      ch = channels[i];
      break;
    }
  }
  // Fallback: id puede ser la propia URL
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
        name: ch.group ? (ch.group + ' · Principal') : 'Principal',
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
}

// Export CommonJS (flutter_js)
module.exports = {
  getHome: getHome,
  search: search,
  getMeta: getMeta,
  getStreams: getStreams
};
