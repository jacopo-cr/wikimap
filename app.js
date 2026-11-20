const STREAM_URL = 'https://stream.wikimedia.org/v2/stream/recentchange';

// Keep track of recent event IDs so we don't process duplicates on reconnect
const seenIds = new Set();

function handleStreamEvent(rawData) {
    let data;
    try {
        data = JSON.parse(rawData);
    } catch {
        return;
    }

    // Only care about actual article edits/creations by humans on *.wikipedia.org
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

    console.log(`[${lang.toUpperCase()}] ${title}`, articleUrl);
}

function connectStream() {
    const es = new EventSource(STREAM_URL);
    es.onmessage = (event) => {
        if (event.data) handleStreamEvent(event.data);
    };
    es.onerror = () => {
        // EventSource reconnects automatically unless closed
        console.warn('Stream hiccup, waiting to reconnect...');
    };
}

connectStream();