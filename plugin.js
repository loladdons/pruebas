const YT_API_BASE = "https://www.googleapis.com/youtube/v3";
const YT_INNERTUBE_BASE = "https://www.youtube.com/youtubei/v1";
const OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";

/**
 * Plan B - Instancias de respaldo automático de Invidious y Piped
 * en caso de limitaciones o fallos de YouTube directo.
 */
const INVIDIOUS_MIRRORS = [
  "https://invidious.nerdvpn.de",
  "https://inv.nadeko.net",
  "https://invidious.tiekoetter.com"
];

const PIPED_INSTANCES = [
  "https://cf.piped.video",
  "https://pipedapi.ducks.party",
  "https://piped.ducks.party",
  "https://pipedapi.kavin.rocks",
  "https://piped.kavin.rocks",
  "https://pipedapi.wireway.ch",
  "https://piped.wireway.ch"
];

const HOME_CATEGORIES = [
  { id: "trending", title: "Tendencias en YouTube", ref: "cat:trending", query: "tendencias tecnologia musica cine", genre: "entretenimiento" },
  { id: "music", title: "Música y Conciertos", ref: "cat:music", query: "official music video live concert", videoCategoryId: "10", genre: "musica" },
  { id: "documentaries", title: "Documentales y Ciencia", ref: "cat:documentaries", query: "documental completo espanol ciencia historia", genre: "documentales" },
  { id: "movies", title: "Películas y Cortometrajes", ref: "cat:movies", query: "pelicula completa dominio publico cortometraje", genre: "peliculas" },
  { id: "playlists", title: "Listas de Reproducción Destacadas", ref: "cat:playlists", query: "curso completo documental serie playlist", searchType: "playlist", genre: "series" },
  { id: "channels", title: "Canales Destacados", ref: "cat:channels", query: "canal oficial ciencia historia musica", searchType: "channel", genre: "otros" }
];

function __readCfg(key, def) {
  try {
    if (typeof config !== "undefined" && config && config[key] != null) return config[key];
    if (typeof userConfig !== "undefined" && userConfig && userConfig[key] != null) return userConfig[key];
    if (typeof kino !== "undefined" && kino && kino.config && kino.config[key] != null) return kino.config[key];
  } catch (e) {}
  return def;
}

function getRegionCode() {
  const raw = String(__readCfg("region_code", "") || "").trim().toUpperCase();
  return /^[A-Z]{2}$/.test(raw) ? raw : "MX";
}

function getPreferredLang() {
  const raw = String(__readCfg("preferred_lang", "") || "").trim().toLowerCase();
  return /^[a-z]{2}(-[a-z0-9]+)?$/i.test(raw) ? raw : "es";
}

async function getAuthCredentials() {
  const userApiKey = String(__readCfg("api_key", "") || "").trim();
  // En Nuvio no hay kino.secret / kino.storage; solo API key del usuario en ajustes del repo
  return {
    apiKey: userApiKey,
    sealedKey: "",
    clientId: "",
    clientSecret: "",
    accessToken: ""
  };
}

async function refreshOAuthToken(refreshToken, clientId, clientSecret) {
  try {
    const body = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token"
    }).toString();

    const res = await fetch(OAUTH_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body
    });
    if (!res.ok) return "";
    const data = await res.json();
    if (data && data.access_token) {
      const ttlMs = (Number(data.expires_in) || 3600) * 1000;
      await (async()=>{})("yt_access_token", data.access_token);
      await (async()=>{})("yt_token_expires_at", String(Date.now() + ttlMs));
      return String(data.access_token);
    }
  } catch (err) {
    console.log("Error renovando token OAuth:", String(err));
  }
  return "";
}

async function ytDataApiFetch(endpoint, params = {}) {
  const creds = await getAuthCredentials();
  const keyToTry = creds.apiKey || creds.sealedKey;
  if (!keyToTry && !creds.accessToken) return null;

  const query = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") {
      query.set(k, String(v));
    }
  }
  const headers = { "Accept": "application/json" };
  if (creds.accessToken) {
    headers["Authorization"] = `Bearer ${creds.accessToken}`;
  } else if (keyToTry) {
    query.set("key", keyToTry);
  }

  const url = `${YT_API_BASE}/${endpoint}?${query.toString()}`;
  try {
    const res = await fetch(url, { headers });
    if (!res.ok) return null;
    const data = await res.json();
    if (data && !data.error) return data;
  } catch (err) {
    console.log("Aviso en consulta Data API v3:", String(err));
  }
  return null;
}

async function ytInnertubeFetch(endpoint, payload) {
  const region = getRegionCode();
  const prefLang = getPreferredLang();
  const body = {
    context: {
      client: {
        clientName: "WEB",
        clientVersion: "2.20250101.00.00",
        hl: prefLang,
        gl: region
      }
    },
    ...payload
  };
  const res = await fetch(`${YT_INNERTUBE_BASE}/${endpoint}?prettyPrint=false`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json",
      "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
    },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    throw new Error(`Error HTTP ${res.status} al consultar YouTube`);
  }
  return await res.json();
}

function selectThumbnail(thumbnails, videoId = "") {
  if (thumbnails && typeof thumbnails === "object") {
    if (Array.isArray(thumbnails)) {
      const sorted = [...thumbnails].filter(t => t && t.url);
      if (sorted.length > 0) {
        let rawUrl = sorted[sorted.length - 1].url;
        if (rawUrl.startsWith("//")) rawUrl = "https:" + rawUrl;
        return rawUrl;
      }
    } else {
      const order = ["maxres", "standard", "high", "medium", "default"];
      for (const k of order) {
        if (thumbnails[k] && thumbnails[k].url) {
          let rawUrl = thumbnails[k].url;
          if (rawUrl.startsWith("//")) rawUrl = "https:" + rawUrl;
          return rawUrl;
        }
      }
    }
  }
  if (videoId) {
    return `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
  }
  return "https://www.youtube.com/img/desktop/yt_1200.png";
}

function mapDataApiItem(raw) {
  if (!raw) return null;
  const snippet = raw.snippet || {};
  const rawKind = typeof raw.id === "string" ? (raw.kind || "") : (raw.id && raw.id.kind ? raw.id.kind : "");

  if (rawKind.includes("playlist") || (raw.id && raw.id.playlistId)) {
    const playlistId = typeof raw.id === "string" ? raw.id : raw.id.playlistId;
    if (!playlistId) return null;
    const poster = selectThumbnail(snippet.thumbnails);
    return {
      id: `yt-pl-${playlistId}`,
      ref: `playlist:${playlistId}`,
      title: snippet.title || "Lista de reproducción",
      kind: "series",
      poster,
      backdrop: poster,
      overview: snippet.description || (snippet.channelTitle ? `Canal: ${snippet.channelTitle}` : "Lista de reproducción de YouTube")
    };
  }

  if (rawKind.includes("channel") || (raw.id && raw.id.channelId)) {
    const channelId = typeof raw.id === "string" ? raw.id : raw.id.channelId;
    if (!channelId) return null;
    const poster = selectThumbnail(snippet.thumbnails);
    return {
      id: `yt-ch-${channelId}`,
      ref: `channel:${channelId}`,
      title: snippet.title || snippet.channelTitle || "Canal de YouTube",
      kind: "series",
      poster,
      backdrop: poster,
      overview: snippet.description || "Canal público de YouTube"
    };
  }

  const videoId = typeof raw.id === "string"
    ? raw.id
    : (raw.id && raw.id.videoId) || (snippet.resourceId && snippet.resourceId.videoId) || "";
  if (!videoId) return null;

  const isLive = snippet.liveBroadcastContent === "live";
  const poster = `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
  const backdrop = `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`;
  const year = snippet.publishedAt ? String(snippet.publishedAt).slice(0, 4) : undefined;

  return {
    id: `yt-v-${videoId}`,
    ref: `video:${videoId}`,
    title: snippet.title || `Video ${videoId}`,
    kind: isLive ? "live" : "movie",
    year: year && /^\d{4}$/.test(year) ? year : undefined,
    poster,
    backdrop,
    overview: snippet.description || (snippet.channelTitle ? `Canal: ${snippet.channelTitle}` : "")
  };
}

function extractText(node) {
  if (!node) return "";
  if (typeof node === "string") return node;
  if (typeof node.simpleText === "string") return node.simpleText;
  if (Array.isArray(node.runs)) return node.runs.map(r => r.text || "").join("");
  return "";
}

function collectInnertubeRenderers(root, out = [], depth = 0) {
  if (!root || typeof root !== "object" || depth > 40 || out.length >= 45) return out;
  if (root.videoRenderer && root.videoRenderer.videoId) {
    out.push({ type: "video", data: root.videoRenderer });
    return out;
  }
  if (root.playlistvideoRenderer && root.playlistvideoRenderer.videoId) {
    out.push({ type: "video", data: root.playlistvideoRenderer });
    return out;
  }
  if (root.playlistVideoRenderer && root.playlistVideoRenderer.videoId) {
    out.push({ type: "video", data: root.playlistVideoRenderer });
    return out;
  }
  if (root.gridVideoRenderer && root.gridVideoRenderer.videoId) {
    out.push({ type: "video", data: root.gridVideoRenderer });
    return out;
  }
  if (root.reelItemRenderer && root.reelItemRenderer.videoId) {
    out.push({ type: "video", data: root.reelItemRenderer });
    return out;
  }
  if (root.playlistRenderer && root.playlistRenderer.playlistId) {
    out.push({ type: "playlist", data: root.playlistRenderer });
    return out;
  }
  if (root.lockupViewModel && root.lockupViewModel.contentId) {
    out.push({ type: "lockup", data: root.lockupViewModel });
    return out;
  }
  if (root.channelRenderer && root.channelRenderer.channelId) {
    out.push({ type: "channel", data: root.channelRenderer });
    return out;
  }
  if (Array.isArray(root)) {
    for (const child of root) {
      collectInnertubeRenderers(child, out, depth + 1);
      if (out.length >= 45) break;
    }
  } else {
    for (const val of Object.values(root)) {
      if (val && typeof val === "object") {
        collectInnertubeRenderers(val, out, depth + 1);
        if (out.length >= 45) break;
      }
    }
  }
  return out;
}

function mapInnertubeEntry(entry) {
  const { type, data } = entry;
  if (type === "video") {
    const videoId = data.videoId;
    const title = extractText(data.title || data.headline) || `Video ${videoId}`;
    const channelName = extractText(data.ownerText || data.longBylineText || data.shortBylineText);
    const desc = extractText(data.descriptionSnippet) || (channelName ? `Canal: ${channelName}` : "");
    const lengthText = extractText(data.lengthText);
    const duration = normalizeDurationSeconds(parseClockDuration(lengthText));
    return {
      id: `yt-v-${videoId}`,
      ref: `video:${videoId}`,
      title,
      kind: "movie",
      poster: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
      backdrop: `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`,
      overview: desc,
      channel: channelName || "",
      duration: duration || 0,
      durationText: lengthText || formatDurationText(duration)
    };
  }
  if (type === "playlist") {
    const playlistId = data.playlistId;
    const title = extractText(data.title) || `Lista ${playlistId}`;
    const thumbs = (data.thumbnails && data.thumbnails[0] && data.thumbnails[0].thumbnails) || (data.thumbnail && data.thumbnail.thumbnails) || [];
    const poster = selectThumbnail(thumbs);
    const channelName = extractText(data.shortBylineText || data.longBylineText);
    return {
      id: `yt-pl-${playlistId}`,
      ref: `playlist:${playlistId}`,
      title,
      kind: "series",
      poster,
      backdrop: poster,
      overview: channelName ? `Lista de reproducción · ${channelName}` : "Lista de reproducción de YouTube"
    };
  }
  if (type === "lockup") {
    const contentId = String(data.contentId || "");
    const title = (data.metadata && data.metadata.lockupMetadataViewModel && data.metadata.lockupMetadataViewModel.title && data.metadata.lockupMetadataViewModel.title.content) || `Contenido ${contentId}`;
    if (contentId.startsWith("PL") || contentId.startsWith("OL") || contentId.startsWith("UU")) {
      return {
        id: `yt-pl-${contentId}`,
        ref: `playlist:${contentId}`,
        title,
        kind: "series",
        poster: "https://www.youtube.com/img/desktop/yt_1200.png",
        backdrop: "https://www.youtube.com/img/desktop/yt_1200.png",
        overview: "Lista de reproducción de YouTube"
      };
    }
    if (contentId.length === 11) {
      return {
        id: `yt-v-${contentId}`,
        ref: `video:${contentId}`,
        title,
        kind: "movie",
        poster: `https://i.ytimg.com/vi/${contentId}/hqdefault.jpg`,
        backdrop: `https://i.ytimg.com/vi/${contentId}/maxresdefault.jpg`,
        overview: "Video de YouTube"
      };
    }
  }
  if (type === "channel") {
    const channelId = data.channelId;
    const title = extractText(data.title) || `Canal ${channelId}`;
    const thumbs = (data.thumbnail && data.thumbnail.thumbnails) || [];
    const poster = selectThumbnail(thumbs);
    const desc = extractText(data.descriptionSnippet) || "Canal público de YouTube";
    return {
      id: `yt-ch-${channelId}`,
      ref: `channel:${channelId}`,
      title,
      kind: "series",
      poster,
      backdrop: poster,
      overview: desc
    };
  }
  return null;
}

function mapInvidiousSearchItem(v) {
  if (!v || typeof v !== "object") return null;
  const itemType = String(v.type || "video").toLowerCase();

  if (itemType === "playlist" || v.playlistId) {
    const playlistId = v.playlistId;
    if (!playlistId) return null;
    const poster = v.playlistThumbnail || selectThumbnail(v.videos && v.videos[0] && v.videos[0].videoThumbnails);
    return {
      id: `yt-pl-${playlistId}`,
      ref: `playlist:${playlistId}`,
      title: v.title || `Lista ${playlistId}`,
      kind: "series",
      poster,
      backdrop: poster,
      overview: v.author ? `Lista de reproducción · ${v.author}` : "Lista de reproducción de YouTube"
    };
  }

  if (itemType === "channel" || (v.authorId && !v.videoId)) {
    const channelId = v.authorId;
    if (!channelId) return null;
    const poster = selectThumbnail(v.authorThumbnails);
    return {
      id: `yt-ch-${channelId}`,
      ref: `channel:${channelId}`,
      title: v.author || v.title || `Canal ${channelId}`,
      kind: "series",
      poster,
      backdrop: poster,
      overview: v.description || "Canal público de YouTube"
    };
  }

  const videoId = v.videoId;
  if (!videoId) return null;
  const isLive = Boolean(v.liveNow);
  return {
    id: `yt-v-${videoId}`,
    ref: `video:${videoId}`,
    title: v.title || `Video ${videoId}`,
    kind: isLive ? "live" : "movie",
    poster: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
    backdrop: `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`,
    overview: v.description || (v.author ? `Canal: ${v.author}` : "")
  };
}

async function searchViaInvidious(queryText, searchType = "video", region = "AR") {
  const encoded = encodeURIComponent(queryText.trim());
  let invType = "all";
  if (searchType === "video") invType = "video";
  else if (searchType === "playlist") invType = "playlist";
  else if (searchType === "channel") invType = "channel";

  for (const inv of INVIDIOUS_MIRRORS) {
    try {
      const res = await fetch(
        `${inv}/api/v1/search?q=${encoded}&type=${invType}&region=${region}`,
        {
          headers: {
            "Accept": "application/json",
            "User-Agent": "Mozilla/5.0 KinoPlugin"
          }
        }
      );
      if (!res.ok) continue;
      const data = await res.json();
      if (!Array.isArray(data) || data.length === 0) continue;

      const items = [];
      const seen = new Set();
      for (const entry of data) {
        const mapped = mapInvidiousSearchItem(entry);
        if (mapped && !seen.has(mapped.id)) {
          seen.add(mapped.id);
          items.push(mapped);
        }
      }
      if (items.length > 0) return items;
    } catch (err) {
      console.log(`Aviso en búsqueda Invidious (${inv}):`, String(err));
    }
  }
  return [];
}

function mapPipedSearchItem(st) {
  if (!st || typeof st !== "object") return null;
  const url = String(st.url || "");
  const itemType = String(st.type || "").toLowerCase();

  if (itemType === "playlist" || url.includes("list=")) {
    const plMatch = url.match(/[?&]list=([A-Za-z0-9_-]+)/);
    const playlistId = plMatch ? plMatch[1] : "";
    if (!playlistId) return null;
    const poster = st.thumbnail || "https://www.youtube.com/img/desktop/yt_1200.png";
    return {
      id: `yt-pl-${playlistId}`,
      ref: `playlist:${playlistId}`,
      title: st.name || st.title || `Lista ${playlistId}`,
      kind: "series",
      poster,
      backdrop: poster,
      overview: st.uploaderName ? `Lista de reproducción · ${st.uploaderName}` : "Lista de reproducción de YouTube"
    };
  }

  if (itemType === "channel" || url.startsWith("/channel/")) {
    const chMatch = url.match(/\/channel\/(UC[A-Za-z0-9_-]{22})/);
    const channelId = chMatch ? chMatch[1] : "";
    if (!channelId) return null;
    const poster = st.thumbnail || "https://www.youtube.com/img/desktop/yt_1200.png";
    return {
      id: `yt-ch-${channelId}`,
      ref: `channel:${channelId}`,
      title: st.name || st.title || `Canal ${channelId}`,
      kind: "series",
      poster,
      backdrop: poster,
      overview: st.description || "Canal público de YouTube"
    };
  }

  const vidMatch = url.match(/(?:v=|\/watch\?v=|youtu\.be\/)([A-Za-z0-9_-]{11})/);
  const videoId = vidMatch ? vidMatch[1] : "";
  if (!videoId) return null;
  return {
    id: `yt-v-${videoId}`,
    ref: `video:${videoId}`,
    title: st.title || st.name || `Video ${videoId}`,
    kind: st.isShort ? "movie" : "movie",
    poster: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
    backdrop: `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`,
    overview: st.shortDescription || (st.uploaderName ? `Canal: ${st.uploaderName}` : "")
  };
}

async function searchViaPiped(queryText, searchType = "video") {
  const encoded = encodeURIComponent(queryText.trim());
  let filter = "all";
  if (searchType === "video") filter = "videos";
  else if (searchType === "playlist") filter = "playlists";
  else if (searchType === "channel") filter = "channels";

  for (const piped of PIPED_INSTANCES) {
    try {
      const endpoints = [
        `${piped}/search?q=${encoded}&filter=${filter}`,
        `${piped}/results?search_query=${encoded}`
      ];
      for (const endpoint of endpoints) {
        try {
          const res = await fetch(endpoint, {
            headers: {
              "Accept": "application/json",
              "User-Agent": "Mozilla/5.0 KinoPlugin"
            }
          });
          if (!res.ok) continue;
          const data = await res.json();
          const rawItems = Array.isArray(data) ? data : (data && Array.isArray(data.items) ? data.items : []);
          if (rawItems.length === 0) continue;

          const items = [];
          const seen = new Set();
          for (const st of rawItems) {
            const mapped = mapPipedSearchItem(st);
            if (mapped && !seen.has(mapped.id)) {
              seen.add(mapped.id);
              items.push(mapped);
            }
          }
          if (items.length > 0) return items;
        } catch (_) {}
      }
    } catch (err) {
      console.log(`Aviso en búsqueda Piped (${piped}):`, String(err));
    }
  }
  return [];
}

async function fetchTrendingFallback(region = "AR") {
  for (const inv of INVIDIOUS_MIRRORS) {
    try {
      const res = await fetch(`${inv}/api/v1/trending?region=${region}`, {
        headers: {
          "Accept": "application/json",
          "User-Agent": "Mozilla/5.0 KinoPlugin"
        }
      });
      if (!res.ok) continue;
      const data = await res.json();
      if (Array.isArray(data) && data.length > 0) {
        const items = data.map(mapInvidiousSearchItem).filter(Boolean);
        if (items.length > 0) return items;
      }
    } catch (_) {}
  }

  for (const piped of PIPED_INSTANCES) {
    try {
      const res = await fetch(`${piped}/trending?region=${region}`, {
        headers: {
          "Accept": "application/json",
          "User-Agent": "Mozilla/5.0 KinoPlugin"
        }
      });
      if (!res.ok) continue;
      const data = await res.json();
      if (Array.isArray(data) && data.length > 0) {
        const items = data.map(mapPipedSearchItem).filter(Boolean);
        if (items.length > 0) return items;
      }
    } catch (_) {}
  }

  return [];
}

async function fetchItemsByQuery(queryText, options = {}) {
  const { searchType = "video,playlist,channel", pageToken = "", maxResults = 18, videoCategoryId = "" } = options;
  const region = getRegionCode();

  // Plan A.1: YouTube Data API v3
  const apiParams = {
    part: "snippet",
    q: queryText,
    type: searchType,
    maxResults: String(maxResults),
    regionCode: region
  };
  if (pageToken) apiParams.pageToken = pageToken;
  if (videoCategoryId && searchType === "video") apiParams.videoCategoryId = videoCategoryId;

  const apiData = await ytDataApiFetch("search", apiParams);
  if (apiData && Array.isArray(apiData.items) && apiData.items.length > 0) {
    const items = apiData.items.map(mapDataApiItem).filter(Boolean);
    if (items.length > 0) {
      return {
        items,
        next: apiData.nextPageToken || undefined
      };
    }
  }

  // Plan A.2: YouTube Innertube directo
  try {
    const innertubePayload = { query: queryText };
    if (searchType === "playlist") {
      innertubePayload.params = "EgIQAw%3D%3D";
    } else if (searchType === "channel") {
      innertubePayload.params = "EgIQAg%3D%3D";
    }

    const raw = await ytInnertubeFetch("search", innertubePayload);
    const renderers = collectInnertubeRenderers(raw);
    const seen = new Set();
    const items = [];
    for (const r of renderers) {
      const mapped = mapInnertubeEntry(r);
      if (mapped && !seen.has(mapped.id)) {
        seen.add(mapped.id);
        items.push(mapped);
      }
    }
    if (items.length > 0) {
      return { items };
    }
  } catch (err) {
    console.log("Aviso en búsqueda Innertube:", String(err));
  }

  // Plan B.1: Invidious (invidious.nerdvpn.de, inv.nadeko.net, invidious.tiekoetter.com)
  const invItems = await searchViaInvidious(queryText, searchType, region);
  if (invItems.length > 0) {
    return { items: invItems.slice(0, maxResults) };
  }

  // Plan B.2: Piped (cf.piped.video, piped.ducks.party, piped.kavin.rocks, piped.wireway.ch)
  const pipedItems = await searchViaPiped(queryText, searchType);
  if (pipedItems.length > 0) {
    return { items: pipedItems.slice(0, maxResults) };
  }

  return { items: [] };
}

async function home() {
  const rows = [];
  const region = getRegionCode();

  let trendingItems = [];
  const popularData = await ytDataApiFetch("videos", {
    part: "snippet",
    chart: "mostPopular",
    regionCode: region,
    maxResults: "15"
  });

  if (popularData && Array.isArray(popularData.items) && popularData.items.length > 0) {
    trendingItems = popularData.items.map(mapDataApiItem).filter(Boolean);
  } else {
    trendingItems = (await fetchTrendingFallback(region)).slice(0, 15);
  }

  if (trendingItems.length > 0) {
    rows.push({
      id: "trending",
      title: "Tendencias en YouTube",
      ref: "cat:trending",
      genre: "entretenimiento",
      items: trendingItems
    });
  }

  const categoriesToLoad = rows.length > 0 ? HOME_CATEGORIES.slice(1, 5) : HOME_CATEGORIES.slice(0, 4);
  for (const cat of categoriesToLoad) {
    try {
      const page = await fetchItemsByQuery(cat.query, {
        searchType: cat.searchType || "video",
        videoCategoryId: cat.videoCategoryId || "",
        maxResults: 12
      });
      if (page.items && page.items.length > 0) {
        rows.push({
          id: cat.id,
          title: cat.title,
          ref: cat.ref,
          genre: cat.genre,
          items: page.items
        });
      }
    } catch (err) {
      console.log(`Aviso cargando fila ${cat.id}:`, String(err));
    }
  }

  return rows;
}

async function browse(ref, cursor) {
  const cleanRef = String(ref || "cat:trending").trim();

  if (cleanRef.startsWith("playlist:") || cleanRef.startsWith("channel:")) {
    const epData = await episodes(cleanRef);
    const items = (epData.episodes || []).map(ep => ({
      id: `yt-v-${ep.ref.replace(/^video:/, "")}`,
      ref: ep.ref,
      title: ep.title,
      kind: "movie",
      poster: ep.still || "https://www.youtube.com/img/desktop/yt_1200.png",
      backdrop: ep.still || "https://www.youtube.com/img/desktop/yt_1200.png",
      overview: ep.overview || ""
    }));
    return { items };
  }

  const catId = cleanRef.replace(/^cat:/, "");
  const foundCat = HOME_CATEGORIES.find(c => c.id === catId || c.ref === cleanRef) || HOME_CATEGORIES[0];

  if (foundCat.id === "trending" && !cursor) {
    const region = getRegionCode();
    const popularData = await ytDataApiFetch("videos", {
      part: "snippet",
      chart: "mostPopular",
      regionCode: region,
      maxResults: "20"
    });
    if (popularData && Array.isArray(popularData.items) && popularData.items.length > 0) {
      return {
        items: popularData.items.map(mapDataApiItem).filter(Boolean),
        next: popularData.nextPageToken || undefined
      };
    }
    const fallbackTrending = await fetchTrendingFallback(region);
    if (fallbackTrending.length > 0) {
      return { items: fallbackTrending.slice(0, 20) };
    }
  }

  return await fetchItemsByQuery(foundCat.query, {
    searchType: foundCat.searchType || "video",
    pageToken: cursor || "",
    maxResults: 20
  });
}

async function __kino_search(query) {
  const qText = typeof query === "string"
    ? query.trim()
    : (query && typeof query.q === "string" ? query.q.trim() : "");

  if (!qText) {
    return { items: [] };
  }

  const cursor = (query && typeof query === "object" && query.cursor) ? String(query.cursor) : "";
  let searchType = "video,playlist,channel";
  if (query && typeof query === "object") {
    if (query.type === "movie") searchType = "video";
    else if (query.type === "series") searchType = "playlist,channel";
  }

  return await fetchItemsByQuery(qText, {
    searchType,
    pageToken: cursor,
    maxResults: 20
  });
}

function extractEpisodesFromBrowseRoot(raw, fallbackOverview = "") {
  const renderers = collectInnertubeRenderers(raw);
  const epList = [];
  const seen = new Set();
  for (const r of renderers) {
    let vid = "";
    let title = "";
    let overview = "";
    if (r.type === "video" && r.data && r.data.videoId) {
      vid = r.data.videoId;
      title = extractText(r.data.title || r.data.headline);
      overview = extractText(r.data.descriptionSnippet || r.data.shortBylineText || r.data.publishedTimeText) || fallbackOverview;
    } else if (r.type === "lockup" && r.data && String(r.data.contentId || "").length === 11) {
      vid = String(r.data.contentId);
      title = (r.data.metadata && r.data.metadata.lockupMetadataViewModel && r.data.metadata.lockupMetadataViewModel.title && r.data.metadata.lockupMetadataViewModel.title.content) || "";
      overview = fallbackOverview;
    }
    if (vid && !seen.has(vid)) {
      seen.add(vid);
      epList.push({
        season: 1,
        number: epList.length + 1,
        ref: `video:${vid}`,
        title: title || `Episodio ${epList.length + 1}`,
        still: `https://i.ytimg.com/vi/${vid}/hqdefault.jpg`,
        overview
      });
    }
  }
  return epList;
}

async function fetchPlaylistEpisodesFallback(playlistId) {
  for (const inv of INVIDIOUS_MIRRORS) {
    try {
      const res = await fetch(`${inv}/api/v1/playlists/${playlistId}`, {
        headers: {
          "Accept": "application/json",
          "User-Agent": "Mozilla/5.0 KinoPlugin"
        }
      });
      if (!res.ok) continue;
      const data = await res.json();
      const videos = data && Array.isArray(data.videos) ? data.videos : [];
      if (videos.length === 0) continue;

      const epList = [];
      const seen = new Set();
      for (const v of videos) {
        if (!v || !v.videoId || seen.has(v.videoId)) continue;
        seen.add(v.videoId);
        epList.push({
          season: 1,
          number: epList.length + 1,
          ref: `video:${v.videoId}`,
          title: v.title || `Episodio ${epList.length + 1}`,
          still: `https://i.ytimg.com/vi/${v.videoId}/hqdefault.jpg`,
          overview: v.author ? `Canal: ${v.author}` : ""
        });
      }
      if (epList.length > 0) {
        return {
          series: { title: data.title || "Lista de reproducción de YouTube" },
          episodes: epList
        };
      }
    } catch (_) {}
  }

  for (const piped of PIPED_INSTANCES) {
    try {
      const res = await fetch(`${piped}/playlists/${playlistId}`, {
        headers: {
          "Accept": "application/json",
          "User-Agent": "Mozilla/5.0 KinoPlugin"
        }
      });
      if (!res.ok) continue;
      const data = await res.json();
      const streams = data && Array.isArray(data.relatedStreams) ? data.relatedStreams : [];
      if (streams.length === 0) continue;

      const epList = [];
      const seen = new Set();
      for (const st of streams) {
        if (!st) continue;
        const vid = extractVideoId(st.url || "");
        if (!vid || vid.length !== 11 || seen.has(vid)) continue;
        seen.add(vid);
        epList.push({
          season: 1,
          number: epList.length + 1,
          ref: `video:${vid}`,
          title: st.title || `Episodio ${epList.length + 1}`,
          still: `https://i.ytimg.com/vi/${vid}/hqdefault.jpg`,
          overview: st.shortDescription || (st.uploaderName ? `Canal: ${st.uploaderName}` : "")
        });
      }
      if (epList.length > 0) {
        return {
          series: { title: data.name || "Lista de reproducción de YouTube" },
          episodes: epList
        };
      }
    } catch (_) {}
  }

  return null;
}

async function fetchChannelEpisodesFallback(channelId) {
  for (const inv of INVIDIOUS_MIRRORS) {
    try {
      const res = await fetch(`${inv}/api/v1/channels/${channelId}/videos`, {
        headers: {
          "Accept": "application/json",
          "User-Agent": "Mozilla/5.0 KinoPlugin"
        }
      });
      if (!res.ok) continue;
      const data = await res.json();
      const rawVideos = Array.isArray(data) ? data : (data && Array.isArray(data.videos) ? data.videos : []);
      if (rawVideos.length === 0) continue;

      const epList = [];
      const seen = new Set();
      for (const v of rawVideos) {
        if (!v || !v.videoId || seen.has(v.videoId)) continue;
        seen.add(v.videoId);
        epList.push({
          season: 1,
          number: epList.length + 1,
          ref: `video:${v.videoId}`,
          title: v.title || `Episodio ${epList.length + 1}`,
          still: `https://i.ytimg.com/vi/${v.videoId}/hqdefault.jpg`,
          overview: v.description || (v.author ? `Canal: ${v.author}` : "")
        });
      }
      if (epList.length > 0) {
        return {
          series: { title: (rawVideos[0] && rawVideos[0].author) || "Videos del canal" },
          episodes: epList
        };
      }
    } catch (_) {}
  }

  for (const piped of PIPED_INSTANCES) {
    try {
      const res = await fetch(`${piped}/channel/${channelId}`, {
        headers: {
          "Accept": "application/json",
          "User-Agent": "Mozilla/5.0 KinoPlugin"
        }
      });
      if (!res.ok) continue;
      const data = await res.json();
      const streams = data && Array.isArray(data.relatedStreams) ? data.relatedStreams : [];
      if (streams.length === 0) continue;

      const epList = [];
      const seen = new Set();
      for (const st of streams) {
        if (!st) continue;
        const vid = extractVideoId(st.url || "");
        if (!vid || vid.length !== 11 || seen.has(vid)) continue;
        seen.add(vid);
        epList.push({
          season: 1,
          number: epList.length + 1,
          ref: `video:${vid}`,
          title: st.title || `Episodio ${epList.length + 1}`,
          still: `https://i.ytimg.com/vi/${vid}/hqdefault.jpg`,
          overview: st.shortDescription || (data.name ? `Canal: ${data.name}` : "")
        });
      }
      if (epList.length > 0) {
        return {
          series: { title: data.name || "Videos del canal" },
          episodes: epList
        };
      }
    } catch (_) {}
  }

  return null;
}

async function episodes(ref) {
  const rawRef = String(ref || "").trim();

  if (rawRef.startsWith("playlist:")) {
    const playlistId = rawRef.slice("playlist:".length);
    const apiData = await ytDataApiFetch("playlistItems", {
      part: "snippet",
      playlistId,
      maxResults: "50"
    });

    if (apiData && Array.isArray(apiData.items) && apiData.items.length > 0) {
      const epList = [];
      for (let i = 0; i < apiData.items.length; i++) {
        const snippet = apiData.items[i].snippet || {};
        const vid = snippet.resourceId && snippet.resourceId.videoId;
        if (!vid) continue;
        epList.push({
          season: 1,
          number: epList.length + 1,
          ref: `video:${vid}`,
          title: snippet.title || `Episodio ${epList.length + 1}`,
          still: `https://i.ytimg.com/vi/${vid}/hqdefault.jpg`,
          overview: snippet.description || ""
        });
      }
      if (epList.length > 0) {
        return {
          series: { title: "Lista de reproducción de YouTube" },
          episodes: epList
        };
      }
    }

    const browseId = playlistId.startsWith("VL") ? playlistId : `VL${playlistId}`;
    try {
      const raw = await ytInnertubeFetch("browse", { browseId });
      const epList = extractEpisodesFromBrowseRoot(raw);
      if (epList.length > 0) {
        return {
          series: { title: "Lista de reproducción de YouTube" },
          episodes: epList
        };
      }
    } catch (err) {
      console.log("Aviso en browse de playlist:", String(err));
    }

    const fallbackPl = await fetchPlaylistEpisodesFallback(playlistId);
    if (fallbackPl) return fallbackPl;

    return {
      series: { title: "Lista de reproducción de YouTube" },
      episodes: []
    };
  }

  if (rawRef.startsWith("channel:")) {
    const channelId = rawRef.slice("channel:".length);
    const channelData = await ytDataApiFetch("channels", {
      part: "contentDetails,snippet",
      id: channelId
    });
    const uploadsPlaylistId = channelData
      && channelData.items
      && channelData.items[0]
      && channelData.items[0].contentDetails
      && channelData.items[0].contentDetails.relatedPlaylists
      && channelData.items[0].contentDetails.relatedPlaylists.uploads;

    if (uploadsPlaylistId) {
      const fromApi = await episodes(`playlist:${uploadsPlaylistId}`);
      if (fromApi.episodes && fromApi.episodes.length > 0) {
        return fromApi;
      }
    }

    try {
      const rawVideosTab = await ytInnertubeFetch("browse", {
        browseId: channelId,
        params: "EgZ2aWRlb3PyBgQKAjoA"
      });
      const channelTitle = (rawVideosTab && rawVideosTab.metadata && rawVideosTab.metadata.channelMetadataRenderer && rawVideosTab.metadata.channelMetadataRenderer.title) || "Videos del canal";
      const epList = extractEpisodesFromBrowseRoot(rawVideosTab, `Canal: ${channelTitle}`);
      if (epList.length > 0) {
        return {
          series: { title: channelTitle },
          episodes: epList
        };
      }
    } catch (err) {
      console.log("Aviso en pestaña videos del canal:", String(err));
    }

    if (channelId.startsWith("UC") && channelId.length > 4) {
      const uuPlaylist = "UU" + channelId.slice(2);
      const fromUploads = await episodes(`playlist:${uuPlaylist}`);
      if (fromUploads.episodes && fromUploads.episodes.length > 0) {
        return fromUploads;
      }
    }

    const fallbackCh = await fetchChannelEpisodesFallback(channelId);
    if (fallbackCh) return fallbackCh;

    return {
      series: { title: "Videos del canal" },
      episodes: []
    };
  }

  const vid = extractVideoId(rawRef);
  return {
    series: { title: "Video de YouTube" },
    episodes: [
      {
        season: 1,
        number: 1,
        ref: `video:${vid}`,
        title: "Reproducir video",
        still: `https://i.ytimg.com/vi/${vid}/hqdefault.jpg`
      }
    ]
  };
}

function extractVideoId(ref) {
  const clean = String(ref || "").trim();
  if (clean.startsWith("video:")) return clean.slice("video:".length).trim();
  const match = clean.match(/(?:v=|youtu\.be\/|\/vi\/|\/embed\/)([A-Za-z0-9_-]{11})/);
  if (match) return match[1];
  return clean;
}

function extractSubtitles(data, prefLang) {
  const subList = [];
  const captionTracks = data
    && data.captions
    && data.captions.playerCaptionsTracklistRenderer
    && data.captions.playerCaptionsTracklistRenderer.captionTracks;

  let hasPrefSub = false;
  let translatableTrack = null;

  if (Array.isArray(captionTracks)) {
    for (const track of captionTracks) {
      if (!track || !track.baseUrl) continue;
      const langCode = String(track.languageCode || "es");
      if (langCode === prefLang || langCode.startsWith(prefLang + "-")) {
        hasPrefSub = true;
      }
      if (track.isTranslatable && (langCode.startsWith("en") || !translatableTrack)) {
        translatableTrack = track;
      }
      const vttUrl = track.baseUrl.includes("fmt=")
        ? track.baseUrl.replace(/fmt=[^&]+/, "fmt=vtt")
        : track.baseUrl + "&fmt=vtt";
      subList.push({
        lang: langCode,
        url: vttUrl,
        format: "vtt",
        label: extractText(track.name) || langCode,
        translated: false
      });
    }

    if (!hasPrefSub && translatableTrack && translatableTrack.baseUrl) {
      const baseVtt = translatableTrack.baseUrl.includes("fmt=")
        ? translatableTrack.baseUrl.replace(/fmt=[^&]+/, "fmt=vtt")
        : translatableTrack.baseUrl + "&fmt=vtt";
      subList.push({
        lang: prefLang,
        url: baseVtt + "&tlang=" + encodeURIComponent(prefLang),
        format: "vtt",
        label: prefLang.toUpperCase() + " (Traducción automática)",
        translated: true
      });
    }

    subList.sort((a, b) => {
      const aMatch = (a.lang === prefLang || a.lang.startsWith(prefLang + "-")) ? 0 : 1;
      const bMatch = (b.lang === prefLang || b.lang.startsWith(prefLang + "-")) ? 0 : 1;
      return aMatch - bMatch;
    });
  }

  return subList;
}

/**
 * Plan B.1 de reproducción: Invidious (invidious.nerdvpn.de, inv.nadeko.net, invidious.tiekoetter.com).
 */
async function resolveViaInvidious(videoId) {
  for (const inv of INVIDIOUS_MIRRORS) {
    try {
      const res = await fetch(`${inv}/api/v1/videos/${videoId}`, {
        headers: {
          "Accept": "application/json",
          "User-Agent": "Mozilla/5.0 KinoPlugin"
        }
      });

      if (!res.ok) continue;
      const data = await res.json();
      if (!data || typeof data !== "object") continue;

      const subList = [];
      if (Array.isArray(data.captions)) {
        for (const cap of data.captions) {
          if (cap && typeof cap.url === "string") {
            const subUrl = cap.url.startsWith("http") ? cap.url : `${inv}${cap.url}`;
            subList.push({
              lang: cap.language_code || cap.languageCode || "es",
              label: cap.label || "Subtítulo",
              url: subUrl,
              format: "vtt"
            });
          }
        }
      }

      const candidates = [];

      if (typeof data.hlsUrl === "string" && data.hlsUrl.startsWith("http")) {
        candidates.push({
          url: data.hlsUrl.startsWith("https://") ? data.hlsUrl : `${inv}${data.hlsUrl}`,
          mime: "application/x-mpegURL",
          headers: { "User-Agent": "Mozilla/5.0" },
          label: "HLS (Invidious)"
        });
      }

      if (Array.isArray(data.formatStreams)) {
        const sorted = [...data.formatStreams]
          .filter(f => f && typeof f.url === "string")
          .sort((a, b) => (parseInt(String(b.resolution || "0"), 10) || 0) - (parseInt(String(a.resolution || "0"), 10) || 0));

        for (const fmt of sorted) {
          const streamUrl = fmt.url.startsWith("http") ? fmt.url : `${inv}${fmt.url}`;
          const mime = String(fmt.type || "video/mp4").split(";")[0].trim() || "video/mp4";
          candidates.push({
            url: streamUrl,
            mime,
            headers: { "User-Agent": "Mozilla/5.0" },
            label: `${fmt.qualityLabel || fmt.resolution || "MP4"} (Invidious)`
          });
        }
      }

      candidates.push({
        url: `${inv}/latest_version?id=${videoId}&itag=18`,
        mime: "video/mp4",
        headers: { "User-Agent": "Mozilla/5.0" },
        label: "360p Directo (Invidious)"
      });

      if (candidates.length > 0) {
        const primary = candidates[0];
        const alternatives = candidates.slice(1, 9);
        return {
          url: primary.url,
          mime: primary.mime,
          headers: primary.headers,
          subtitles: subList.length > 0 ? subList.slice(0, 30) : undefined,
          alternatives: alternatives.length > 0 ? alternatives : undefined,
          expiresInSeconds: 10800
        };
      }
    } catch (_) {
      // Probar siguiente espejo de Invidious
    }
  }

  return null;
}

/**
 * Plan B.2 de reproducción: Piped (cf.piped.video, piped.ducks.party, piped.kavin.rocks, piped.wireway.ch).
 */
async function resolveViaPiped(videoId) {
  for (const piped of PIPED_INSTANCES) {
    try {
      const res = await fetch(`${piped}/streams/${videoId}`, {
        headers: {
          "Accept": "application/json",
          "User-Agent": "Mozilla/5.0 KinoPlugin"
        }
      });

      if (!res.ok) continue;
      const data = await res.json();
      if (!data || typeof data !== "object") continue;

      const subList = [];
      if (Array.isArray(data.subtitles)) {
        for (const sub of data.subtitles) {
          if (sub && typeof sub.url === "string" && sub.url.startsWith("https://")) {
            subList.push({
              lang: sub.code || "es",
              label: sub.name || sub.code || "Subtítulo",
              url: sub.url,
              format: (sub.mimeType && sub.mimeType.includes("ttml")) ? "ttml" : "vtt"
            });
          }
        }
      }

      const candidates = [];

      if (typeof data.hls === "string" && data.hls.startsWith("https://")) {
        candidates.push({
          url: data.hls,
          mime: "application/x-mpegURL",
          headers: { "User-Agent": "Mozilla/5.0" },
          label: "HLS (Piped)"
        });
      }

      if (Array.isArray(data.videoStreams)) {
        const withAudio = data.videoStreams
          .filter(v => v && typeof v.url === "string" && v.url.startsWith("https://") && v.videoOnly === false)
          .sort((a, b) => (Number(b.height) || 0) - (Number(a.height) || 0));

        const anyVideo = data.videoStreams
          .filter(v => v && typeof v.url === "string" && v.url.startsWith("https://") && v.videoOnly !== false)
          .sort((a, b) => (Number(b.height) || 0) - (Number(a.height) || 0));

        for (const v of [...withAudio, ...anyVideo]) {
          const mime = String(v.mimeType || "video/mp4").split(";")[0].trim() || "video/mp4";
          candidates.push({
            url: v.url,
            mime,
            headers: { "User-Agent": "Mozilla/5.0" },
            label: `${v.quality || (v.height ? v.height + "p" : "MP4")} (Piped)`
          });
        }
      }

      if (candidates.length > 0) {
        const primary = candidates[0];
        const alternatives = candidates.slice(1, 9);
        return {
          url: primary.url,
          mime: primary.mime,
          headers: primary.headers,
          subtitles: subList.length > 0 ? subList.slice(0, 30) : undefined,
          alternatives: alternatives.length > 0 ? alternatives : undefined,
          expiresInSeconds: 10800
        };
      }
    } catch (_) {
      // Probar siguiente instancia de Piped
    }
  }

  return null;
}

async function resolve(ref) {
  const videoId = extractVideoId(ref);
  if (!videoId) {
    throw new Error("Identificador de video de YouTube inválido");
  }

  await ytDataApiFetch("videos", {
    part: "snippet,contentDetails",
    id: videoId
  });

  const prefLang = getPreferredLang();
  const region = getRegionCode();

  const clients = [
    {
      clientName: "IOS",
      clientVersion: "20.10.4",
      deviceMake: "Apple",
      deviceModel: "iPhone16,2",
      osName: "iPhone",
      osVersion: "18.3.2.22D82",
      userAgent: "com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X;)"
    },
    {
      clientName: "ANDROID_VR",
      clientVersion: "1.61.48",
      deviceMake: "Oculus",
      deviceModel: "Quest 3",
      osName: "Android",
      osVersion: "12L",
      androidSdkVersion: 32,
      userAgent: "com.google.android.apps.youtube.vr.oculus/1.61.48 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip"
    },
    {
      clientName: "ANDROID",
      clientVersion: "20.10.38",
      deviceMake: "Google",
      deviceModel: "Pixel 8",
      osName: "Android",
      osVersion: "14",
      androidSdkVersion: 34,
      userAgent: "com.google.android.youtube/20.10.38 (Linux; U; Android 14) gzip"
    }
  ];

  let hlsCandidate = null;
  const progressiveCandidates = [];
  let collectedSubtitles = [];
  let minExpires = 21600;

  // Plan A: YouTube Innertube directo
  for (const client of clients) {
    try {
      const payload = {
        videoId,
        context: {
          client: {
            clientName: client.clientName,
            clientVersion: client.clientVersion,
            deviceMake: client.deviceMake,
            deviceModel: client.deviceModel,
            osName: client.osName,
            osVersion: client.osVersion,
            androidSdkVersion: client.androidSdkVersion,
            hl: prefLang,
            gl: region
          }
        },
        contentCheckOk: true,
        racyCheckOk: true
      };

      const res = await fetch(`${YT_INNERTUBE_BASE}/player?prettyPrint=false`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json",
          "User-Agent": client.userAgent
        },
        body: JSON.stringify(payload)
      });

      if (!res.ok) continue;
      const data = await res.json();
      const streamingData = data && data.streamingData;
      if (!streamingData) continue;

      if (Number(streamingData.expiresInSeconds) > 0) {
        minExpires = Math.min(minExpires, Number(streamingData.expiresInSeconds));
      }

      if (collectedSubtitles.length === 0) {
        collectedSubtitles = extractSubtitles(data, prefLang);
      }

      if (!hlsCandidate && typeof streamingData.hlsManifestUrl === "string" && streamingData.hlsManifestUrl.startsWith("https://")) {
        hlsCandidate = {
          url: streamingData.hlsManifestUrl,
          mime: "application/x-mpegURL",
          headers: { "User-Agent": client.userAgent },
          label: "HLS Adaptativo (Full HD / Multi-audio)"
        };
      }

      const progFormats = (Array.isArray(streamingData.formats) ? streamingData.formats : [])
        .filter(f => f && typeof f.url === "string" && f.url.startsWith("https://"))
        .sort((a, b) => (Number(b.height) || 0) - (Number(a.height) || 0));

      for (const fmt of progFormats) {
        const mimeType = String(fmt.mimeType || "").split(";")[0].trim() || "video/mp4";
        const quality = fmt.qualityLabel || `${fmt.height || 360}p`;
        const label = `${quality} MP4 (${client.clientName})`;
        if (!progressiveCandidates.some(p => p.url === fmt.url)) {
          progressiveCandidates.push({
            url: fmt.url,
            mime: mimeType,
            headers: { "User-Agent": client.userAgent },
            label
          });
        }
      }

      if (hlsCandidate && progressiveCandidates.length > 0) {
        break;
      }
    } catch (err) {
      console.log(`Aviso en cliente ${client.clientName}:`, String(err));
    }
  }

  const allStreams = [];
  if (hlsCandidate) {
    allStreams.push(hlsCandidate);
  }
  for (const prog of progressiveCandidates) {
    allStreams.push(prog);
  }

  if (allStreams.length > 0) {
    const primary = allStreams[0];
    const mirrorFallbacks = INVIDIOUS_MIRRORS.map(inv => ({
      url: `${inv}/latest_version?id=${videoId}&itag=18`,
      mime: "video/mp4",
      headers: { "User-Agent": "Mozilla/5.0" },
      label: `Respaldo Invidious (${inv.replace(/^https:\/\//, "")})`
    }));
    const alternatives = [...allStreams.slice(1), ...mirrorFallbacks].slice(0, 9).map(s => ({
      url: s.url,
      mime: s.mime,
      headers: s.headers,
      label: s.label
    }));

    return {
      url: primary.url,
      mime: primary.mime,
      headers: primary.headers,
      subtitles: collectedSubtitles.length > 0 ? collectedSubtitles : undefined,
      alternatives: alternatives.length > 0 ? alternatives : undefined,
      expiresInSeconds: minExpires
    };
  }

  // Plan B.1: Invidious API + streams
  const invStream = await resolveViaInvidious(videoId);
  if (invStream) {
    return invStream;
  }

  // Plan B.2: Piped API
  const pipedStream = await resolveViaPiped(videoId);
  if (pipedStream) {
    return pipedStream;
  }

  // Plan B.3: Último recurso directo a través de los mirrors de Invidious (latest_version)
  const fallbackUrls = INVIDIOUS_MIRRORS.map(inv => ({
    url: `${inv}/latest_version?id=${videoId}&itag=18`,
    mime: "video/mp4",
    headers: { "User-Agent": "Mozilla/5.0" },
    label: `Invidious (${inv.replace(/^https:\/\//, "")})`
  }));

  return {
    url: fallbackUrls[0].url,
    mime: fallbackUrls[0].mime,
    headers: fallbackUrls[0].headers,
    alternatives: fallbackUrls.slice(1)
  };
}



// ═══════════════════════════════════════════════════════════════════════════
// Adaptador Nuvio / lolplus — solo Buscar + Biblioteca + Ajustes
// (sin Home ni Descubrir)
// ═══════════════════════════════════════════════════════════════════════════

function getConfig(key, def) {
  try {
    if (typeof config !== "undefined" && config && config[key] != null) return config[key];
    if (typeof userConfig !== "undefined" && userConfig && userConfig[key] != null) return userConfig[key];
  } catch (e) {}
  return def;
}

// Override region/lang from Nuvio repo config
/* region/lang ya definidos arriba con __readCfg */

// Map Kino search item → Nuvio ContentItem
function mapToNuvioItem(item) {
  if (!item) return null;
  const ref = String(item.ref || item.id || "");
  let type = "movie";
  let id = ref;

  // Título exactamente el de la búsqueda (no genéricos)
  const title = String(item.title || item.name || "").trim() || "YouTube";

  if (ref.startsWith("video:") || ref.startsWith("yt-v-") || (item.id && String(item.id).startsWith("yt-v-"))) {
    const vid = ref.replace(/^video:/, "").replace(/^yt-v-/, "") || String(item.id || "").replace(/^yt-v-/, "");
    id = "yt:video:" + vid;
    type = item.kind === "live" ? "channel" : "movie";
  } else if (ref.startsWith("playlist:") || (item.kind === "series" && String(ref).indexOf("playlist") !== -1) || (item.id && String(item.id).startsWith("yt-pl-"))) {
    const pid = ref.replace(/^playlist:/, "") || String(item.id || "").replace(/^yt-pl-/, "");
    id = "yt:playlist:" + pid;
    type = "tv";
  } else if (ref.startsWith("channel:") || (item.id && String(item.id).startsWith("yt-ch-"))) {
    const cid = ref.replace(/^channel:/, "") || String(item.id || "").replace(/^yt-ch-/, "");
    id = "yt:channel:" + cid;
    type = "tv";
  } else if (item.kind === "series") {
    id = "yt:" + ref;
    type = "tv";
  } else if (item.kind === "live") {
    id = "yt:" + (ref || item.id || Math.random().toString(36).slice(2));
    type = "channel";
  } else {
    id = "yt:" + (ref || item.id || Math.random().toString(36).slice(2));
    type = "movie";
  }

  // Extraer canal del overview tipo "Canal: X" si no viene aparte
  var channelName = "";
  var ov = String(item.overview || item.description || "");
  var cm = ov.match(/^Canal:\s*(.+)$/i);
  if (cm) channelName = cm[1].trim();
  if (item.channel) channelName = item.channel;
  if (item.extra && item.extra.channel) channelName = item.extra.channel;

  var dur = normalizeDurationSeconds(item.duration || item.lengthSeconds || 0);
  if (!dur && item.durationText) dur = normalizeDurationSeconds(parseClockDuration(item.durationText));

  return {
    id: id,
    title: title,
    name: title,
    poster: item.poster || item.still || null,
    backdrop: item.backdrop || item.poster || item.still || null,
    overview: item.overview || item.description || "",
    description: item.overview || item.description || "",
    type: type,
    media_type: type,
    year: item.year || null,
    rating: item.rating || null,
    duration: dur || null,
    durationText: dur ? formatDurationText(dur) : null,
    studio: channelName || null,
    creator: channelName || null,
    author: channelName || null,
    channel: channelName || null,
    // Guardamos el título de búsqueda para que ficha/player lo reutilicen
    extra: {
      ref: ref,
      youtube: true,
      kind: item.kind || type,
      searchTitle: title,
      originalTitle: title,
      channel: channelName || "",
      creator: channelName || "",
      duration: dur || 0
    }
  };
}

/** Solo búsqueda — sin home ni discover */
async function search(query, opts) {
  opts = opts || {};
  let qText = "";
  if (typeof query === "string") qText = query.trim();
  else if (query && typeof query === "object") {
    qText = String(query.q || query.query || query.text || "").trim();
  }
  if (!qText) return { items: [], metas: [], results: [] };

  const cursor = (query && typeof query === "object" && query.cursor) ? String(query.cursor) : (opts.cursor || "");
  let searchType = "video,playlist,channel";
  if (query && typeof query === "object") {
    if (query.type === "movie" || query.type === "video") searchType = "video";
    else if (query.type === "tv" || query.type === "series") searchType = "playlist,channel";
  }

  try {
    const page = await fetchItemsByQuery(qText, {
      searchType: searchType,
      pageToken: cursor,
      maxResults: 20
    });
    const rawItems = (page && page.items) ? page.items : (Array.isArray(page) ? page : []);
    const items = rawItems.map(mapToNuvioItem).filter(Boolean);
    for (var ci = 0; ci < items.length; ci++) cacheSearchItem(items[ci]);
    return {
      items: items,
      metas: items,
      results: items,
      cursor: (page && page.cursor) || null,
      hasMore: !!(page && page.cursor)
    };
  } catch (e) {
    console.log("[YouTube] search error:", String(e));
    return { items: [], metas: [], results: [], error: String(e) };
  }
}


async function parseYoutubeVideoId(rawId) {
  const s = String(rawId || "").trim();
  if (!s) return "";
  // yt:video:ID | video:ID | yt-v-ID
  let m = s.match(/(?:yt:video:|video:|yt-v-)([A-Za-z0-9_-]{11})/);
  if (m) return m[1];
  // bare 11-char id
  if (/^[A-Za-z0-9_-]{11}$/.test(s)) return s;
  // full URL
  m = s.match(/(?:v=|youtu\.be\/|\/embed\/|\/shorts\/|\/vi\/)([A-Za-z0-9_-]{11})/);
  if (m) return m[1];
  // yt: something else that ends with 11 chars
  m = s.match(/([A-Za-z0-9_-]{11})$/);
  if (m && !s.includes("playlist") && !s.includes("channel")) return m[1];
  return "";
}

/** Caché título/poster desde búsqueda → detalle y player */
var __ytSearchCache = Object.create(null);

function cacheSearchItem(item) {
  if (!item || !item.id) return;
  var m = String(item.id).match(/(?:yt:video:|yt-v-|video:)([A-Za-z0-9_-]{11})/);
  var vid = m ? m[1] : (/^[A-Za-z0-9_-]{11}$/.test(String(item.id)) ? String(item.id) : "");
  if (!vid) return;
  __ytSearchCache[vid] = {
    title: item.title || item.name || "",
    poster: item.poster || "",
    backdrop: item.backdrop || item.poster || "",
    overview: item.overview || item.description || "",
    channel: (item.extra && item.extra.channel) || ""
  };
}

function getCachedMeta(videoId) {
  return __ytSearchCache[videoId] || null;
}

/** oEmbed de YouTube: muy fiable para el título real sin API key */
async function fetchTitleOEmbed(videoId) {
  try {
    const url = "https://www.youtube.com/oembed?url=" +
      encodeURIComponent("https://www.youtube.com/watch?v=" + videoId) +
      "&format=json";
    const res = await fetch(url, {
      headers: { "Accept": "application/json", "User-Agent": "Mozilla/5.0" }
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (data && data.title) {
      return {
        title: String(data.title).trim(),
        channel: String(data.author_name || "").trim(),
        overview: "",
        poster: data.thumbnail_url || ("https://i.ytimg.com/vi/" + videoId + "/hqdefault.jpg")
      };
    }
  } catch (e) {
    console.log("[YouTube] oembed:", String(e));
  }
  return null;
}

/** Último recurso: og:title / og:image de la página watch */
async function fetchMetaFromWatchPage(videoId) {
  try {
    const res = await fetch("https://www.youtube.com/watch?v=" + videoId, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        "Accept-Language": "es-ES,es;q=0.9"
      }
    });
    if (!res.ok) return null;
    const html = await res.text();
    const ogTitle = (html.match(/property="og:title"\s+content="([^"]+)"/) || [])[1]
      || (html.match(/name="title"\s+content="([^"]+)"/) || [])[1]
      || "";
    const ogImage = (html.match(/property="og:image"\s+content="([^"]+)"/) || [])[1] || "";
    const ogDesc = (html.match(/property="og:description"\s+content="([^"]+)"/) || [])[1] || "";
    if (!ogTitle) return null;
    return {
      title: ogTitle.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&").trim(),
      overview: ogDesc.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&").trim(),
      channel: "",
      poster: ogImage || ("https://i.ytimg.com/vi/" + videoId + "/hqdefault.jpg")
    };
  } catch (e) {
    console.log("[YouTube] watch page scrape:", String(e));
  }
  return null;
}

async function fetchVideoTitleInnertube(videoId) {
  try {
    const raw = await ytInnertubeFetch("player", {
      videoId: videoId,
      contentCheckOk: true,
      racyCheckOk: true
    });
    const details = raw && raw.videoDetails;
    if (details && details.title) {
      return {
        title: String(details.title).trim(),
        overview: String(details.shortDescription || ""),
        channel: String(details.author || ""),
        duration: normalizeDurationSeconds(details.lengthSeconds)
      };
    }
  } catch (e) {
    console.log("[YouTube] innertube title:", String(e));
  }
  try {
    const raw = await ytInnertubeFetch("next", { videoId: videoId });
    const primary = raw && raw.contents && raw.contents.twoColumnWatchNextResults
      && raw.contents.twoColumnWatchNextResults.results
      && raw.contents.twoColumnWatchNextResults.results.results
      && raw.contents.twoColumnWatchNextResults.results.results.contents;
    if (Array.isArray(primary)) {
      for (const c of primary) {
        const vr = c && c.videoPrimaryInfoRenderer;
        if (vr && vr.title) {
          const t = extractText(vr.title);
          if (t) {
            let channel = "";
            const sec = primary.find(x => x && x.videoSecondaryInfoRenderer);
            if (sec && sec.videoSecondaryInfoRenderer && sec.videoSecondaryInfoRenderer.owner) {
              const owner = sec.videoSecondaryInfoRenderer.owner.videoOwnerRenderer;
              channel = extractText(owner && owner.title) || "";
            }
            return { title: t, overview: "", channel: channel };
          }
        }
      }
    }
  } catch (e) {
    console.log("[YouTube] innertube next title:", String(e));
  }
  return null;
}


/** YouTube duration helpers — siempre en segundos enteros */
function parseIso8601Duration(iso) {
  var m = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/i.exec(String(iso || "").trim());
  if (!m) return 0;
  return (parseInt(m[1] || "0", 10) * 3600) + (parseInt(m[2] || "0", 10) * 60) + parseInt(m[3] || "0", 10);
}

function parseClockDuration(text) {
  // "1:02:15" | "15:33" | "0:45"
  var s = String(text || "").trim();
  var parts = s.split(":").map(function (p) { return parseInt(p, 10); });
  if (parts.some(function (n) { return isNaN(n); })) return 0;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 1) return parts[0];
  return 0;
}

function normalizeDurationSeconds(value) {
  var n = Number(value);
  if (!isFinite(n) || n <= 0) return 0;
  // Si viene en ms por error (> 24h en "segundos"), convertir
  if (n > 86400 && n < 86400000) n = Math.round(n / 1000);
  // Descartar valores absurdos (> 24h típico de video YT, salvo rarezas)
  if (n > 172800) return 0; // > 48h
  return Math.floor(n);
}

function formatDurationClock(seconds) {
  seconds = normalizeDurationSeconds(seconds);
  if (!seconds) return "";
  var h = Math.floor(seconds / 3600);
  var m = Math.floor((seconds % 3600) / 60);
  var s = seconds % 60;
  function pad(x) { return (x < 10 ? "0" : "") + x; }
  if (h > 0) return h + ":" + pad(m) + ":" + pad(s);
  return m + ":" + pad(s);
}

function formatCount(n) {
  n = Number(n) || 0;
  if (n >= 1000000) return (Math.round(n / 100000) / 10) + " M";
  if (n >= 1000) return (Math.round(n / 100) / 10) + " K";
  return String(Math.floor(n));
}

function formatPublishedDate(iso) {
  if (!iso) return "";
  var d = new Date(iso);
  if (isNaN(d.getTime())) {
    // already a relative string like "hace 2 días"
    return String(iso);
  }
  var day = d.getDate();
  var month = d.getMonth() + 1;
  var year = d.getFullYear();
  function pad(x) { return (x < 10 ? "0" : "") + x; }
  return pad(day) + "/" + pad(month) + "/" + year;
}

function stripCanalPrefix(text) {
  return String(text || "")
    .replace(/^Canal:\s*.+$/gmi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function buildVideoDescription(stats, originalDesc) {
  var lines = [];
  if (stats) {
    if (stats.publishedText) lines.push("📅 Publicado: " + stats.publishedText);
    if (stats.viewsText) lines.push("👁 Visualizaciones: " + stats.viewsText);
    if (stats.likesText) lines.push("👍 Likes: " + stats.likesText);
  }
  var body = stripCanalPrefix(originalDesc || "");
  // no repetir el canal dentro de la descripción
  if (body) {
    if (lines.length) lines.push("");
    lines.push(body);
  }
  return lines.join("\n").trim();
}

function formatDurationText(seconds) {
  seconds = normalizeDurationSeconds(seconds);
  if (!seconds) return "";
  var h = Math.floor(seconds / 3600);
  var m = Math.floor((seconds % 3600) / 60);
  var s = seconds % 60;
  if (h > 0) return h + "h " + m + "m";
  if (m > 0) return m + "m " + (s ? s + "s" : "");
  return s + "s";
}



/** Stats + descripción desde endpoint /next (más fiable que player) */
async function fetchVideoStatsFromNext(videoId) {
  try {
    const raw = await ytInnertubeFetch("next", { videoId: videoId });
    const out = { title: "", overview: "", channel: "", duration: 0, viewCount: 0, likeCount: 0, publishedAt: "", viewsText: "", likesText: "", publishedText: "" };
    if (!raw) return out;

    // Recorrido superficial de contents
    const primary = raw.contents
      && raw.contents.twoColumnWatchNextResults
      && raw.contents.twoColumnWatchNextResults.results
      && raw.contents.twoColumnWatchNextResults.results.results
      && raw.contents.twoColumnWatchNextResults.results.results.contents;

    if (Array.isArray(primary)) {
      for (const c of primary) {
        const vpi = c && c.videoPrimaryInfoRenderer;
        if (vpi) {
          out.title = extractText(vpi.title) || out.title;
          // vistas
          const vc = vpi.viewCount && vpi.viewCount.videoViewCountRenderer;
          if (vc) {
            out.viewsText = extractText(vc.viewCount) || extractText(vc.shortViewCount) || "";
            const digits = String(out.viewsText).replace(/[^\d]/g, "");
            if (digits) out.viewCount = Number(digits) || 0;
          }
          // fecha
          out.publishedText = extractText(vpi.dateText) || extractText(vpi.relativeDateText) || out.publishedText;
          // factoids: likes etc
          const facts = vpi.factoid || [];
          for (const f of facts) {
            const fr = f && f.factoidRenderer;
            if (!fr) continue;
            const label = extractText(fr.label).toLowerCase();
            const value = extractText(fr.value);
            if (/like|me gusta|pulgar/i.test(label) || /K|M|\d/.test(value) && /like/i.test(label + value)) {
              out.likesText = value;
              // 4,4 K → approx
              var n = value.replace(",", ".").replace(/[^\d.]/g, "");
              var num = parseFloat(n) || 0;
              if (/m/i.test(value)) num *= 1000000;
              else if (/k/i.test(value)) num *= 1000;
              out.likeCount = Math.round(num);
            }
          }
        }
        const vsi = c && c.videoSecondaryInfoRenderer;
        if (vsi) {
          const owner = vsi.owner && vsi.owner.videoOwnerRenderer;
          if (owner) out.channel = extractText(owner.title) || out.channel;
          // descripción
          const desc = vsi.attributedDescription
            || vsi.description
            || (vsi.attributedDescriptionBodyText && { content: vsi.attributedDescriptionBodyText.content });
          if (desc) {
            if (typeof desc.content === "string") out.overview = desc.content;
            else out.overview = extractText(desc) || out.overview;
          }
          if (!out.overview && vsi.attributedDescriptionBodyText && vsi.attributedDescriptionBodyText.content) {
            out.overview = String(vsi.attributedDescriptionBodyText.content);
          }
        }
      }
    }

    // microformat
    const micro = raw.microformat && (raw.microformat.playerMicroformatRenderer || raw.microformat.microformatDataRenderer);
    if (micro) {
      if (!out.publishedAt && micro.publishDate) out.publishedAt = micro.publishDate;
      if (!out.publishedAt && micro.uploadDate) out.publishedAt = micro.uploadDate;
      if (!out.overview && micro.description) out.overview = extractText(micro.description) || String(micro.description.simpleText || "");
    }

    // fallback regex sobre el JSON completo
    if (!out.viewsText || !out.overview) {
      const s = JSON.stringify(raw);
      if (!out.viewsText) {
        const m = s.match(/"viewCount"\s*:\s*\{\s*"simpleText"\s*:\s*"([^"]+)"/);
        if (m) out.viewsText = m[1];
      }
      if (!out.overview) {
        const m2 = s.match(/"attributedDescriptionBodyText"\s*:\s*\{\s*"content"\s*:\s*"((?:\\.|[^"\\])*)"/);
        if (m2) {
          try { out.overview = JSON.parse('"' + m2[1] + '"'); } catch (_) { out.overview = m2[1]; }
        }
      }
      if (!out.publishedText) {
        const m3 = s.match(/"dateText"\s*:\s*\{\s*"simpleText"\s*:\s*"([^"]+)"/);
        if (m3) out.publishedText = m3[1];
      }
      if (!out.likeCount) {
        const m4 = s.match(/"value"\s*:\s*\{\s*"simpleText"\s*:\s*"([^"]+)"\s*\}\s*,\s*"label"\s*:\s*\{\s*"simpleText"\s*:\s*"(?:likes|Me gusta|me gusta)"/i);
        if (m4) {
          out.likesText = m4[1];
          var n2 = m4[1].replace(",", ".").replace(/[^\d.]/g, "");
          var num2 = parseFloat(n2) || 0;
          if (/m/i.test(m4[1])) num2 *= 1e6;
          else if (/k/i.test(m4[1])) num2 *= 1e3;
          out.likeCount = Math.round(num2);
        }
      }
    }

    return out;
  } catch (e) {
    console.log("[YouTube] next stats:", String(e));
    return null;
  }
}

async function resolveVideoMeta(videoId) {
  let title = "";
  let overview = ""; // descripción ORIGINAL del video (sin "Canal:")
  let channel = "";
  let duration = 0; // siempre en segundos internos
  let viewCount = 0;
  let likeCount = 0;
  let publishedAt = "";
  let poster = "https://i.ytimg.com/vi/" + videoId + "/hqdefault.jpg";
  let backdrop = "https://i.ytimg.com/vi/" + videoId + "/maxresdefault.jpg";

  // 0) Reutilizar lo de la búsqueda
  try {
    const cached = getCachedMeta(videoId);
    if (cached) {
      if (cached.title) title = cached.title;
      if (cached.poster) poster = cached.poster;
      if (cached.backdrop) backdrop = cached.backdrop;
      if (cached.overview) overview = cached.overview;
      if (cached.channel) channel = cached.channel;
    }
  } catch (_) {}

  // 1) oEmbed — título real, sin API key
  try {
    const oe = await fetchTitleOEmbed(videoId);
    if (oe && oe.title) {
      title = oe.title;
      channel = oe.channel || channel;
      if (oe.poster) poster = oe.poster;
    }
  } catch (_) {}

  // 1b) /next — descripción, vistas, likes, fecha (más fiable que player)
  try {
    const nx = await fetchVideoStatsFromNext(videoId);
    if (nx) {
      if (!title && nx.title) title = nx.title;
      if (nx.overview) overview = nx.overview;
      if (nx.channel) channel = channel || nx.channel;
      if (nx.viewCount) viewCount = nx.viewCount;
      if (nx.viewsText) { /* keep for build */ }
      if (nx.likeCount) likeCount = nx.likeCount;
      if (nx.publishedText) publishedAt = publishedAt || nx.publishedText;
      if (nx.publishedAt) publishedAt = nx.publishedAt || publishedAt;
      // guardar textos legibles en variables locales vía publishedAt string
      if (nx.viewsText && !viewCount) {
        var d = String(nx.viewsText).replace(/[^\d]/g, "");
        if (d) viewCount = Number(d) || 0;
      }
      // duration a veces no viene en next; se completa abajo
    }
  } catch (_) {}

  // 2) Data API
  if (!title || !overview || !duration || !viewCount) {
    try {
      const data = await ytDataApiFetch("videos", { part: "snippet,contentDetails,statistics", id: videoId });
      const item = data && data.items && data.items[0];
      const sn = item && item.snippet;
      if (sn) {
        if (!title) title = String(sn.title || "").trim();
        overview = overview || sn.description || "";
        channel = channel || sn.channelTitle || "";
        if (!publishedAt && sn.publishedAt) publishedAt = sn.publishedAt;
      }
      if (!duration && item && item.contentDetails && item.contentDetails.duration) {
        duration = normalizeDurationSeconds(parseIso8601Duration(item.contentDetails.duration));
      }
      const st = item && item.statistics;
      if (st) {
        if (!viewCount && st.viewCount) viewCount = Number(st.viewCount) || 0;
        if (!likeCount && st.likeCount) likeCount = Number(st.likeCount) || 0;
      }
    } catch (_) {}
  }

  // 3) Innertube (también pide lengthSeconds)
  if (!title || !overview || !duration) {
    try {
      const it = await fetchVideoTitleInnertube(videoId);
      if (it) {
        if (!title && it.title) title = it.title;
        overview = overview || it.overview || "";
        channel = channel || it.channel || "";
        if (!duration && it.duration) duration = normalizeDurationSeconds(it.duration);
      }
    } catch (_) {}
  }
  // 3b) player directo WEB para lengthSeconds + views
  if (!duration || !title || !viewCount) {
    try {
      const raw = await ytInnertubeFetch("player", {
        videoId: videoId,
        contentCheckOk: true,
        racyCheckOk: true
      });
      const vd = raw && raw.videoDetails;
      if (vd) {
        if (!title && vd.title) title = String(vd.title).trim();
        if (!channel && vd.author) channel = String(vd.author).trim();
        if (!overview && vd.shortDescription) overview = String(vd.shortDescription);
        if (vd.lengthSeconds) duration = normalizeDurationSeconds(vd.lengthSeconds);
        if (!viewCount && vd.viewCount) viewCount = Number(vd.viewCount) || 0;
      }
      const micro = raw && raw.microformat && raw.microformat.playerMicroformatRenderer;
      if (micro) {
        if (!publishedAt && micro.publishDate) publishedAt = micro.publishDate;
        if (!publishedAt && micro.uploadDate) publishedAt = micro.uploadDate;
      }
    } catch (_) {}
  }

  // 4) Invidious
  if (!title || !overview || !duration) {
    for (const inv of INVIDIOUS_MIRRORS) {
      try {
        const res = await fetch(inv + "/api/v1/videos/" + videoId, {
          headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0" }
        });
        if (!res.ok) continue;
        const v = await res.json();
        if (!title) title = String(v.title || "").trim();
        overview = overview || v.description || "";
        channel = channel || v.author || "";
        if (!duration && v.lengthSeconds) duration = normalizeDurationSeconds(v.lengthSeconds);
        if (!viewCount && (v.viewCount || v.views)) viewCount = Number(v.viewCount || v.views) || 0;
        if (!likeCount && v.likeCount) likeCount = Number(v.likeCount) || 0;
        if (!publishedAt && (v.published || v.publishedText)) publishedAt = v.published || v.publishedText;
        if (title && duration) break;
      } catch (_) {}
    }
  }

  // 5) Piped
  if (!title || !overview || !duration) {
    for (const piped of PIPED_INSTANCES) {
      try {
        const res = await fetch(piped + "/streams/" + videoId, {
          headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0" }
        });
        if (!res.ok) continue;
        const v = await res.json();
        if (!title) title = String(v.title || "").trim();
        overview = overview || v.description || "";
        channel = channel || v.uploader || v.uploaderName || "";
        if (!duration && v.duration) duration = normalizeDurationSeconds(v.duration);
        if (!viewCount && (v.views || v.viewCount)) viewCount = Number(v.views || v.viewCount) || 0;
        if (!likeCount && (v.likes || v.likeCount)) likeCount = Number(v.likes || v.likeCount) || 0;
        if (!publishedAt && (v.uploadDate || v.uploadedDate || v.uploaded)) publishedAt = v.uploadDate || v.uploadedDate || String(v.uploaded || "");
        if (title && duration) break;
      } catch (_) {}
    }
  }

  // 6) Scrape watch page
  if (!title) {
    try {
      const wp = await fetchMetaFromWatchPage(videoId);
      if (wp && wp.title) {
        title = wp.title;
        overview = overview || wp.overview || "";
        if (wp.poster) poster = wp.poster;
      }
    } catch (_) {}
  }

  // 7) Duración vía búsqueda por ID (lengthText "11:13") si aún falta
  if (!duration) {
    try {
      const searchRaw = await ytInnertubeFetch("search", { query: videoId });
      const found = [];
      collectInnertubeRenderers(searchRaw, found);
      for (const entry of found) {
        if (entry.type === "video" && entry.data && entry.data.videoId === videoId) {
          const lt = extractText(entry.data.lengthText);
          duration = normalizeDurationSeconds(parseClockDuration(lt));
          break;
        }
      }
      // si no exact match, primer video con length
      if (!duration) {
        for (const entry of found) {
          if (entry.type === "video" && entry.data) {
            const lt = extractText(entry.data.lengthText);
            const sec = normalizeDurationSeconds(parseClockDuration(lt));
            if (sec) { duration = sec; break; }
          }
        }
      }
    } catch (_) {}
  }

  // Descripción limpia: NUNCA meter el canal aquí (va en "dirigido por")
  overview = stripCanalPrefix(overview);

  duration = normalizeDurationSeconds(duration);
  var publishedText = "";
  if (publishedAt && !/^\d{4}-/.test(String(publishedAt)) && !/^\d{9,13}$/.test(String(publishedAt))) {
    // ya es texto legible: "11 nov 2026" / "hace 3 días"
    publishedText = String(publishedAt);
  } else {
    publishedText = formatPublishedDate(publishedAt);
  }
  if (!publishedText && publishedAt && /^\d{9,13}$/.test(String(publishedAt))) {
    var ms = Number(publishedAt);
    if (ms < 1e12) ms *= 1000;
    publishedText = formatPublishedDate(new Date(ms).toISOString());
  }
  var viewsText = viewCount > 0 ? formatCount(viewCount) : "";
  var likesText = likeCount > 0 ? formatCount(likeCount) : "";
  var description = buildVideoDescription(
    { publishedText: publishedText, viewsText: viewsText, likesText: likesText },
    overview
  );

  // Minutos para la ficha (la app trata `duration` como minutos → si le pasamos segundos salen horas)
  var durationMinutes = duration > 0 ? Math.max(1, Math.round(duration / 60)) : 0;

  return {
    title: title || ("YouTube " + videoId),
    overview: description,
    descriptionRaw: overview,
    channel: channel || "",
    poster: poster,
    backdrop: backdrop || poster,
    durationSeconds: duration,
    durationMinutes: durationMinutes,
    duration: durationMinutes, // lo que muestra la ficha: MINUTOS
    durationText: formatDurationText(duration),
    durationClock: formatDurationClock(duration),
    viewCount: viewCount,
    likeCount: likeCount,
    publishedAt: publishedAt || "",
    publishedText: publishedText || "",
    viewsText: viewsText,
    likesText: likesText
  };
}

async function getMeta(id, type) {
  const raw = String(id || "");
  let ref = raw;

  // Normalizar ids que manda la app / el buscador
  if (raw.startsWith("yt:video:")) ref = "video:" + raw.slice("yt:video:".length);
  else if (raw.startsWith("yt-v-")) ref = "video:" + raw.slice("yt-v-".length);
  else if (raw.startsWith("yt:playlist:")) ref = "playlist:" + raw.slice("yt:playlist:".length);
  else if (raw.startsWith("yt-pl-")) ref = "playlist:" + raw.slice("yt-pl-".length);
  else if (raw.startsWith("yt:channel:")) ref = "channel:" + raw.slice("yt:channel:".length);
  else if (raw.startsWith("yt-ch-")) ref = "channel:" + raw.slice("yt-ch-".length);
  else if (raw.startsWith("yt:")) ref = raw.slice(3);

  // Video individual — título real (mismo que en resultados de búsqueda)
  const videoId = await parseYoutubeVideoId(ref) || await parseYoutubeVideoId(raw);
  if (videoId && videoId.length === 11 && !ref.startsWith("playlist:") && !ref.startsWith("channel:")) {
    const meta = await resolveVideoMeta(videoId);
    const title = meta.title || ("YouTube " + videoId);
    // overview ya viene con stats + descripción original (sin repetir canal)
    const overview = meta.overview || "";
    const channel = meta.channel || "";
    const poster = meta.poster || ("https://i.ytimg.com/vi/" + videoId + "/hqdefault.jpg");
    const backdrop = meta.backdrop || ("https://i.ytimg.com/vi/" + videoId + "/maxresdefault.jpg");

    cacheSearchItem({
      id: "yt:video:" + videoId,
      title: title,
      name: title,
      poster: poster,
      backdrop: backdrop,
      overview: overview,
      extra: { channel: channel }
    });

    // duration en MINUTOS (la ficha de la app lo muestra como tiempo de película)
    var durationMin = meta.durationMinutes || (meta.durationSeconds ? Math.max(1, Math.round(meta.durationSeconds / 60)) : 0);
    var durationSec = meta.durationSeconds || 0;
    var durationText = meta.durationText || formatDurationText(durationSec);
    var durationClock = meta.durationClock || formatDurationClock(durationSec);
    var creator = channel || "";

    return {
      id: "yt:video:" + videoId,
      title: title,
      name: title,
      original_title: title,
      originalTitle: title,
      poster: poster,
      posterUrl: poster,
      still: poster,
      image: poster,
      backdrop: backdrop,
      background: backdrop,
      // Descripción: stats + texto original. Canal NO va aquí.
      overview: overview,
      description: overview,
      plot: overview,
      type: "movie",
      media_type: "movie",
      year: meta.publishedText ? String(meta.publishedText).slice(-4) : null,
      // Ficha: minutos (evita el bug de horas enormes)
      duration: durationMin || null,
      runtime: durationMin || null,
      durationSeconds: durationSec || null,
      durationText: durationText || null,
      durationClock: durationClock || null,
      // Creador / canal → solo "dirigido por" / studio (una vez)
      studio: creator || null,
      network: null,
      creator: creator || null,
      author: creator || null,
      channel: creator || null,
      director: creator || null,
      genres: [],
      actors: creator ? [{ name: creator, character: "Canal" }] : [],
      cast: null,
      extra: {
        ref: "video:" + videoId,
        channel: creator,
        creator: creator,
        youtube: true,
        searchTitle: title,
        originalTitle: title,
        videoId: videoId,
        duration: durationMin,
        durationSeconds: durationSec,
        durationText: durationText,
        views: meta.viewCount || 0,
        likes: meta.likeCount || 0,
        published: meta.publishedText || ""
      }
    };
  }

  // Playlist / canal → serie con episodios
  if (ref.startsWith("playlist:") || ref.startsWith("channel:")) {
    try {
      const epData = await episodes(ref);
      const seriesTitle = (epData.series && epData.series.title) || (ref.startsWith("playlist:") ? "Lista de YouTube" : "Canal de YouTube");
      const eps = (epData.episodes || []).map(function (ep, idx) {
        const vid = String(ep.ref || "").replace(/^video:/, "");
        return {
          episode: ep.number || idx + 1,
          number: ep.number || idx + 1,
          id: "yt:video:" + vid,
          title: ep.title || ("Episodio " + (idx + 1)),
          name: ep.title || ("Episodio " + (idx + 1)),
          overview: ep.overview || "",
          still: ep.still || ("https://i.ytimg.com/vi/" + vid + "/hqdefault.jpg"),
          backdrop: ep.still || ("https://i.ytimg.com/vi/" + vid + "/hqdefault.jpg")
        };
      });
      return {
        id: raw.startsWith("yt:") ? raw : ("yt:" + ref.replace(":", ":")),
        title: seriesTitle,
        name: seriesTitle,
        poster: eps[0] ? eps[0].still : null,
        backdrop: eps[0] ? eps[0].still : null,
        overview: "Contenido de YouTube",
        type: "tv",
        media_type: "tv",
        studio: seriesTitle,
        creator: seriesTitle,
        author: seriesTitle,
        channel: seriesTitle,
        network: seriesTitle,
        seasons: [{
          season: 1,
          number: 1,
          title: "Videos",
          name: "Videos",
          episodeCount: eps.length,
          episodes: eps
        }],
        extra: {
          ref: ref,
          youtube: true,
          searchTitle: seriesTitle,
          originalTitle: seriesTitle,
          channel: seriesTitle,
          creator: seriesTitle
        }
      };
    } catch (e) {
      return { id: raw, title: "YouTube", overview: String(e), type: "tv" };
    }
  }

  return { id: raw, title: "YouTube", type: "movie", overview: "" };
}

async function getStreams(id, type, season, episode) {
  let ref = String(id || "");
  if (ref.startsWith("yt:video:")) ref = "video:" + ref.slice("yt:video:".length);
  else if (ref.startsWith("yt:")) ref = ref.slice(3);
  if (!ref.startsWith("video:") && /^[a-zA-Z0-9_-]{11}$/.test(ref)) ref = "video:" + ref;

  // Si es playlist/channel sin video concreto, no hay stream directo
  if (ref.startsWith("playlist:") || ref.startsWith("channel:")) {
    return [];
  }

  try {
    const resolved = await resolve(ref);
    if (!resolved) return [];
    const streams = [];
    if (resolved.url) {
      streams.push({
        name: "YouTube",
        title: resolved.mime && resolved.mime.indexOf("mpegurl") !== -1 ? "HLS" : "YouTube",
        url: resolved.url,
        quality: "HD",
        language: getPreferredLang() || "es",
        server: "YouTube",
        headers: resolved.headers || null,
        isHls: !!(resolved.mime && /mpegurl|m3u8/i.test(resolved.mime)),
        mime: resolved.mime || null
      });
    }
    const alts = resolved.alternatives || [];
    for (let i = 0; i < alts.length; i++) {
      const a = alts[i];
      if (!a || !a.url) continue;
      streams.push({
        name: a.label || ("YouTube Alt " + (i + 1)),
        title: a.label || ("Alt " + (i + 1)),
        url: a.url,
        quality: "HD",
        language: getPreferredLang() || "es",
        server: a.label || "YouTube",
        headers: a.headers || null,
        isHls: !!(a.mime && /mpegurl|m3u8/i.test(a.mime)),
        mime: a.mime || null
      });
    }
    return streams;
  } catch (e) {
    console.log("[YouTube] getStreams error:", String(e));
    return [];
  }
}

// Home activo para el demo de structures (usa home() del plugin)
async function getHome() {
  try {
    if (typeof home === "function") {
      const rows = await home();
      // Formato Nuvio: { rows: [ { id, title, items: [...] } ] }
      if (Array.isArray(rows)) {
        return {
          rows: rows.map(function (r) {
            return {
              id: r.id || r.ref || "row",
              title: r.title || "",
              type: "row",
              items: (r.items || []).map(mapToNuvioItem ? mapToNuvioItem : function (x) { return x; }).filter(Boolean)
            };
          })
        };
      }
      return rows || { rows: [] };
    }
  } catch (e) {
    console.log("[YouTube] getHome:", String(e));
  }
  return { rows: [] };
}
async function getCatalogs() { return { catalogs: [] }; }
async function getCatalog() { return { items: [], metas: [], results: [] }; }
async function getDiscover() { return { items: [], metas: [], results: [] }; }
async function getDiscoverFilters() { return []; }

/** Estructuras de UI (opcional: la app también lee structures/*.json) */
async function getStructures() {
  return null; // null = usar solo archivos JSON del repo
}

var addon = {
  search: search,
  getMeta: getMeta,
  getStreams: getStreams,
  getHome: getHome,
  getStructures: getStructures,
  getCatalogs: getCatalogs,
  getCatalog: getCatalog,
  getDiscover: getDiscover,
  getDiscoverFilters: getDiscoverFilters
};

if (typeof module !== "undefined" && module.exports) {
  module.exports = addon;
}
if (typeof globalThis !== "undefined") {
  globalThis.search = search;
  globalThis.getMeta = getMeta;
  globalThis.getStreams = getStreams;
  globalThis.getHome = getHome;
  globalThis.getStructures = getStructures;
  globalThis.getCatalogs = getCatalogs;
  globalThis.getCatalog = getCatalog;
  globalThis.getDiscover = getDiscover;
  globalThis.getDiscoverFilters = getDiscoverFilters;
}