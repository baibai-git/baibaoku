export const CLIENT_SCRIPT = String.raw`
(() => {
    const BRIDGE_VERSION = '0.7.0';
    const API_VERSION = 'v1';
    const BASE_URL = '/api/plugins/baibaoku/v1';
    const STATUS_CACHE_MS = 60 * 1000;

    const existing = window.BaiBaoKu;
    if (existing?.bridgeVersion === BRIDGE_VERSION) {
        window.dispatchEvent(new CustomEvent('baibaoku:ready', { detail: existing }));
        return;
    }

    let statusCache = null;
    let statusCacheAt = 0;
    let statusPromise = null;

    async function getRequestHeadersSafe() {
        try {
            const mod = await import('/script.js');
            if (typeof mod.getRequestHeaders === 'function') {
                return mod.getRequestHeaders();
            }
        } catch {
            // Fall back to JSON-only headers for environments without SillyTavern helpers.
        }

        return { 'Content-Type': 'application/json' };
    }

    async function status(options = {}) {
        const force = options.force === true;
        const cacheMs = Number.isFinite(options.cacheMs) ? Math.max(0, options.cacheMs) : STATUS_CACHE_MS;
        const now = Date.now();

        if (!force && statusCache && now - statusCacheAt < cacheMs) {
            return statusCache;
        }

        if (!force && statusPromise) {
            return statusPromise;
        }

        statusPromise = (async () => {
            const response = await fetch(BASE_URL + '/status', { method: 'GET' });
            const payload = await response.json().catch(() => null);
            if (!response.ok || !payload?.ok) {
                const error = new Error(payload?.error?.message || 'BaiBaoKu status request failed.');
                error.code = payload?.error?.code;
                error.details = payload?.error?.details;
                throw error;
            }

            statusCache = {
                ...payload.data,
                frontendLoaded: true,
                bridgeVersion: BRIDGE_VERSION,
            };
            statusCacheAt = Date.now();
            return statusCache;
        })();

        try {
            return await statusPromise;
        } finally {
            statusPromise = null;
        }
    }

    async function isAvailable(options = {}) {
        try {
            const info = await status(options);
            return Boolean(info?.driver?.available);
        } catch {
            return false;
        }
    }

    async function request(action, body = {}) {
        const headers = await getRequestHeadersSafe();
        const response = await fetch(BASE_URL + '/' + action, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
        });

        const payload = await response.json().catch(() => null);
        if (!response.ok || !payload?.ok) {
            const error = new Error(payload?.error?.message || ('BaiBaoKu request failed: ' + action));
            error.code = payload?.error?.code;
            error.details = payload?.error?.details;
            throw error;
        }

        return payload.data;
    }

    function database(databaseName) {
        return {
            database: databaseName,
            open: (options = {}) => request('open', { database: databaseName, ...options }),
            info: () => request('info', { database: databaseName }),
            set: (store, key, value, options = {}) => request('set', {
                database: databaseName,
                store,
                key,
                value,
                ttl: options.ttl,
                type: options.type ?? options.valueType,
            }),
            setMany: (store, entries, options = {}) => request('set-many', {
                database: databaseName,
                store,
                entries,
                ttl: options.ttl,
                type: options.type ?? options.valueType,
            }),
            get: (store, key) => request('get', { database: databaseName, store, key }),
            getMany: (store, keys) => request('get-many', { database: databaseName, store, keys }),
            has: (store, key) => request('has', { database: databaseName, store, key }),
            delete: (store, key) => request('delete', { database: databaseName, store, key }),
            deleteMany: (store, keys) => request('delete-many', { database: databaseName, store, keys }),
            keys: (store, prefix = '', options = {}) => request('keys', {
                database: databaseName,
                store,
                prefix,
                limit: options.limit,
                offset: options.offset,
            }),
            entries: (store, prefix = '', options = {}) => request('entries', {
                database: databaseName,
                store,
                prefix,
                limit: options.limit,
                offset: options.offset,
            }),
            clear: (store, prefix = '') => request('clear', { database: databaseName, store, prefix }),
        };
    }

    const bridge = Object.freeze({
        id: 'baibaoku',
        name: '柏宝库',
        version: BRIDGE_VERSION,
        bridgeVersion: BRIDGE_VERSION,
        apiVersion: API_VERSION,
        baseUrl: BASE_URL,
        frontendLoaded: true,
        status,
        isAvailable,
        request,
        database,
    });

    window.BaiBaoKu = bridge;
    window.dispatchEvent(new CustomEvent('baibaoku:ready', { detail: bridge }));
})();
`;
