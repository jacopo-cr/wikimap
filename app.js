import { initMap } from './map.js';

const STREAM_URL = 'https://stream.wikimedia.org/v2/stream/recentchange';
const USER_AGENT = 'WikipediaLive/1.0 (https://www.mediawiki.org/wiki/API:Etiquette)';

const FEED_HOLD_MS = 8400;
const FEED_EXIT_MS = 450;

const LANGUAGE_COLORS = {
    en: '#C96F62',
    de: '#648C9E',
    fr: '#C5A34F',
    es: '#78977A',
    ru: '#C88755',
    ja: '#957FA7',
    it: '#63958D',
    pt: '#B77F91',
};
const DEFAULT_LANGUAGE_COLOR = '#9B978B';

function getLanguageColor(lang) {
    return LANGUAGE_COLORS[lang?.toLowerCase()] || DEFAULT_LANGUAGE_COLOR;
}

const canvasEl = document.getElementById('map-canvas');
const feedListEl = document.getElementById('feed-list');
const infoWidgetEl = document.getElementById('info-widget');
const infoBtnEl = document.getElementById('info-btn');

// Info button click / outside click / Escape handling
if (infoWidgetEl && infoBtnEl) {
    infoBtnEl.addEventListener('click', (e) => {
        e.stopPropagation();
        const isOpen = infoWidgetEl.classList.toggle('is-open');
        infoBtnEl.setAttribute('aria-expanded', String(isOpen));
    });

    document.addEventListener('click', (e) => {
        if (!infoWidgetEl.contains(e.target)) {
            infoWidgetEl.classList.remove('is-open');
            infoBtnEl.setAttribute('aria-expanded', 'false');
        }
    });

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            infoWidgetEl.classList.remove('is-open');
            infoBtnEl.setAttribute('aria-expanded', 'false');
            infoBtnEl.blur();
        }
    });
}

const map = initMap(canvasEl);

// --- Live feed UI ---

function getMaxFeedSlots() {
    const w = window.innerWidth || 1024;
    if (w <= 540) return 3;
    if (w <= 860) return 4;
    return 5;
}

function exitFeedRow(row) {
    if (!row.isConnected || row.classList.contains('feed-row--exiting')) return;
    if (row._holdTimer) clearTimeout(row._holdTimer);

    row.classList.remove('feed-row--entering');
    void row.offsetWidth; // trigger CSS transition
    row.classList.add('feed-row--exiting');

    row._exitTimer = setTimeout(() => {
        if (row.isConnected) row.remove();
    }, FEED_EXIT_MS);
}

function trimActiveFeedRows() {
    const maxSlots = getMaxFeedSlots();
    const activeRows = Array.from(feedListEl.children).filter(
        (el) => !el.classList.contains('feed-row--exiting')
    );
    while (activeRows.length > maxSlots) {
        exitFeedRow(activeRows.shift());
    }
}

window.addEventListener('resize', trimActiveFeedRows);

function addFeedRow(edit, useFallbackTimer = true) {
    const row = document.createElement('li');
    row.className = 'feed-row feed-row--entering';

    const clip = document.createElement('div');
    clip.className = 'feed-row-clip';

    const content = document.createElement('div');
    content.className = 'feed-row-content';

    const langSpan = document.createElement('span');
    langSpan.className = 'feed-lang';
    langSpan.textContent = edit.lang.toUpperCase();
    langSpan.style.backgroundColor = getLanguageColor(edit.lang);

    const link = document.createElement('a');
    link.className = 'feed-title';
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.href = edit.articleUrl;
    link.textContent = edit.title;

    content.append(langSpan, link);
    clip.append(content);
    row.append(clip);

    // Append on the right so items slide across right-to-left
    feedListEl.append(row);
    trimActiveFeedRows();

    // Safety cap in case many rows are exiting at once
    while (feedListEl.children.length > 11) {
        const oldest = feedListEl.firstElementChild;
        if (oldest._holdTimer) clearTimeout(oldest._holdTimer);
        if (oldest._exitTimer) clearTimeout(oldest._exitTimer);
        oldest.remove();
    }

    void row.offsetWidth; // force reflow so entering transition animates
    row.classList.remove('feed-row--entering');

    if (useFallbackTimer) {
        row._holdTimer = setTimeout(() => exitFeedRow(row), FEED_HOLD_MS);
    }

    return row;
}

// --- Burst staggering so batched edits drip in smoothly ---

const emitQueue = [];
let emitTimer = null;

function showEdit(edit, drawOnMap) {
    if (drawOnMap) {
        const row = addFeedRow(edit, false);
        const added = map.addStation(edit.lon, edit.lat, getLanguageColor(edit.lang), () => {
            exitFeedRow(row);
        });
        if (!added) {
            row._holdTimer = setTimeout(() => exitFeedRow(row), FEED_HOLD_MS);
        }
    } else {
        addFeedRow(edit, true);
    }
}

function processEmitQueue() {
    emitTimer = null;
    if (emitQueue.length === 0) return;

    const nextEdit = emitQueue.shift();
    showEdit(nextEdit, !document.hidden);

    if (emitQueue.length > 0) {
        // Speed up slightly when the queue backs up
        const delay = Math.max(45, Math.min(180, Math.floor(850 / emitQueue.length)));
        emitTimer = setTimeout(processEmitQueue, delay);
    } else {
        emitTimer = setTimeout(processEmitQueue, 180);
    }
}

function enqueueGeotaggedEdit(edit) {
    if (document.hidden) {
        showEdit(edit, false);
        return;
    }

    if (emitTimer === null && emitQueue.length === 0) {
        showEdit(edit, true);
        emitTimer = setTimeout(processEmitQueue, 180);
        return;
    }

    emitQueue.push(edit);
    if (emitQueue.length > 60) {
        emitQueue.splice(0, emitQueue.length - 60);
    }

    if (emitTimer === null) {
        const delay = Math.max(45, Math.min(180, Math.floor(850 / emitQueue.length)));
        emitTimer = setTimeout(processEmitQueue, delay);
    }
}

document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
        clearTimeout(emitTimer);
        emitTimer = null;
        emitQueue.length = 0;
    }
});

// --- MediaWiki coordinate batching & cache ---

const coordCache = new Map();
const wikiQueues = new Map();

function cacheSet(key, value) {
    if (coordCache.size > 20000) {
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
            waiters: new Map(),
            timer: null,
        };
        wikiQueues.set(serverName, q);
    }
    return q;
}

async function flushQueue(q) {
    q.timer = null;
    if (q.titles.length === 0) return;

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

        const canCacheNegative = json.batchcomplete !== undefined || json.continue === undefined;

        for (const title of batch) {
            const normTitle = normalized.get(title) || title;
            const coord = coordsByTitle.get(normTitle) || coordsByTitle.get(title) || null;

            if (coord) {
                cacheSet(`${q.serverName}|${title}`, coord);
            } else if (canCacheNegative) {
                cacheSet(`${q.serverName}|${title}`, null);
            }

            const waitingEdits = q.waiters.get(title) || [];
            q.waiters.delete(title);

            if (coord) {
                for (const edit of waitingEdits) {
                    enqueueGeotaggedEdit({ ...edit, lat: coord.lat, lon: coord.lon });
                }
            }
        }
    } catch {
        for (const title of batch) {
            q.waiters.delete(title);
        }
    }
}

function lookupCoordinates(edit) {
    const key = `${edit.serverName}|${edit.title}`;
    if (coordCache.has(key)) {
        const cached = coordCache.get(key);
        if (cached) enqueueGeotaggedEdit({ ...edit, lat: cached.lat, lon: cached.lon });
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
        clearTimeout(q.timer);
        flushQueue(q);
    } else if (!q.timer) {
        q.timer = setTimeout(() => flushQueue(q), 1000);
    }
}

// --- Wikimedia SSE stream & watchdog ---

const seenIds = new Set();
let eventSource = null;
let lastActivityAt = Date.now();

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
        typeof data.title_url === 'string' && data.title_url.startsWith(`https://${serverName}/`)
            ? data.title_url
            : `https://${serverName}/wiki/${encodeURIComponent(title.replace(/ /g, '_')).replace(/%2F/g, '/')}`;

    lookupCoordinates({ id, serverName, lang, title, articleUrl });
}

function connectStream() {
    if (eventSource) {
        eventSource.close();
        eventSource = null;
    }

    lastActivityAt = Date.now();
    const es = new EventSource(STREAM_URL);
    eventSource = es;

    es.onopen = () => {
        lastActivityAt = Date.now();
    };

    es.onmessage = (event) => {
        lastActivityAt = Date.now();
        if (event?.data) handleStreamEvent(event.data);
    };

    es.onerror = () => {
        if (es.readyState === EventSource.CLOSED) {
            setTimeout(connectStream, 1000);
        }
    };
}

// Reconnect if the stream goes silent for > 45s while online
setInterval(() => {
    if (navigator.onLine !== false && Date.now() - lastActivityAt > 45000) {
        connectStream();
    }
}, 15000);

window.addEventListener('online', () => {
    if (!eventSource || eventSource.readyState === EventSource.CLOSED) {
        connectStream();
    }
});

connectStream();