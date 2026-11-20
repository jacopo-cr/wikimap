import { initMap } from './map.js';
const map = initMap(document.getElementById('map-canvas'));

const STREAM_URL = 'https://stream.wikimedia.org/v2/stream/recentchange';
const USER_AGENT = 'WikipediaLive/1.0 (https://www.mediawiki.org/wiki/API:Etiquette)';

const seenIds = new Set();
const coordCache = new Map(); // key: "en.wikipedia.org|Paris" -> { lat, lon } or null
const wikiQueues = new Map(); // per-wiki pending titles & callbacks

function cacheSet(key, value) {
    if (coordCache.size > 20000) {
        // Drop the oldest entry to keep memory bounded
        const oldest = coordCache.keys().next().value;
        coordCache.delete(oldest);
    }
    coordCache.set(key, value);
}

function getQueue(serverName) {
    let q = wikiQueues.get(serverName);
    if (!q) {
        q = {
            serverName,
            titles: [],
            waiters: new Map(), // title -> array of edit objects waiting for coords
            timer: null,
        };
        wikiQueues.set(serverName, q);
    }
    return q;
}

async function flushQueue(q) {
    q.timer = null;
    if (q.titles.length === 0) return;

    // MediaWiki lets us query up to 50 titles per API call
    const batch = q.titles.splice(0, 50);
    if (q.titles.length > 0) {
        q.timer = setTimeout(() => flushQueue(q), 250);
    }

    const encodedTitles = batch.map((t) => encodeURIComponent(t)).join('|');
    const url = `https://${q.serverName}/w/api.php?action=query&prop=coordinates&coprimary=primary&colimit=max&format=json&origin=*&titles=${encodedTitles}`;

    try {
        const res = await fetch(url, {
            headers: { 'Api-User-Agent': USER_AGENT },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();

        // MediaWiki normalizes underscores/casing, so map original -> normalized title
        const normalized = new Map();
        for (const item of json.query?.normalized || []) {
            normalized.set(item.from, item.to);
        }

        const coordsByTitle = new Map();
        const pages = Object.values(json.query?.pages || {});
        for (const page of pages) {
            if (!page.title || !Array.isArray(page.coordinates)) continue;
            const coord = page.coordinates.find(
                (c) =>
                    Number.isFinite(Number(c.lat)) &&
                    Number.isFinite(Number(c.lon)) &&
                    (!c.globe || c.globe === 'earth')
            );
            if (coord) {
                coordsByTitle.set(page.title, {
                    lat: Number(coord.lat),
                    lon: Number(coord.lon),
                });
            }
        }

        for (const title of batch) {
            const normTitle = normalized.get(title) || title;
            const coord = coordsByTitle.get(normTitle) || coordsByTitle.get(title) || null;
            cacheSet(`${q.serverName}|${title}`, coord);

            const waitingEdits = q.waiters.get(title) || [];
            q.waiters.delete(title);

            if (coord) {
                for (const edit of waitingEdits) {
                    onGeotaggedEdit({ ...edit, lat: coord.lat, lon: coord.lon });
                }
            }
        }
    } catch (err) {
        // Clean up waiters on error so we don't leak memory
        for (const title of batch) {
            q.waiters.delete(title);
        }
        console.warn(`Coord fetch failed for ${q.serverName}:`, err.message);
    }
}

function lookupCoordinates(edit) {
    const key = `${edit.serverName}|${edit.title}`;
    if (coordCache.has(key)) {
        const cached = coordCache.get(key);
        if (cached) onGeotaggedEdit({ ...edit, lat: cached.lat, lon: cached.lon });
        return;
    }

    const q = getQueue(edit.serverName);
    if (q.waiters.has(edit.title)) {
        q.waiters.get(edit.title).push(edit);
    } else {
        q.waiters.set(edit.title, [edit]);
        q.titles.push(edit.title);
    }

    if (q.titles.length >= 50) {
        if (q.timer) clearTimeout(q.timer);
        flushQueue(q);
    } else if (!q.timer) {
        q.timer = setTimeout(() => flushQueue(q), 1000);
    }
}

function onGeotaggedEdit(edit) {
    map.addStation(edit.lon, edit.lat);
    console.log(`📍 [${edit.lang.toUpperCase()}] ${edit.title} -> (${edit.lat.toFixed(2)}, ${edit.lon.toFixed(2)})`);
}

function handleStreamEvent(rawData) {
    let data;
    try {
        data = JSON.parse(rawData);
    } catch {
        return;
    }

    if (data.type !== 'edit' && data.type !== 'new') return;
    if (data.namespace !== 0 || data.bot !== false) return;
    if (typeof data.server_name !== 'string') return;

    const serverName = data.server_name.trim().toLowerCase();
    if (!serverName.endsWith('.wikipedia.org')) return;

    const lang = serverName.replace('.wikipedia.org', '');
    if (!lang || lang === 'www' || !/^[a-z0-9-]+$/i.test(lang)) return;

    const title = typeof data.title === 'string' ? data.title.trim() : '';
    if (!title) return;

    const id = data.meta?.id || `${serverName}:${data.id ?? ''}:${title}:${data.timestamp ?? Date.now()}`;
    if (seenIds.has(id)) return;
    seenIds.add(id);
    if (seenIds.size > 1500) seenIds.clear();

    const articleUrl =
        data.title_url ||
        `https://${serverName}/wiki/${encodeURIComponent(title.replace(/ /g, '_')).replace(/%2F/g, '/')}`;

    lookupCoordinates({ id, serverName, lang, title, articleUrl });
}

function connectStream() {
    const es = new EventSource(STREAM_URL);
    es.onmessage = (event) => {
        if (event.data) handleStreamEvent(event.data);
    };
}

connectStream();