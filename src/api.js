import {
    API_VERSION,
    PLUGIN_ID,
    PLUGIN_NAME,
    PLUGIN_VERSION,
} from './constants.js';
import { CLIENT_SCRIPT } from './client-script.js';
import { errorPayload, toHttpError } from './errors.js';
import {
    normalizeDatabaseName,
    normalizeStoreName,
    normalizeKey,
    normalizeKeys,
    normalizePrefix,
    normalizeLimit,
    normalizeOffset,
    normalizeOpenOptions,
    normalizeTtl,
    normalizeValueType,
    normalizeSetManyEntries,
} from './validate.js';
import { registerStEndpoints } from './st-endpoints.js';
import { registerVectorRoutes } from './vector-routes.js';
import {
    deletePresetBackup,
    downloadPresetBackup,
    listPresetBackups,
    renamePresetBackup,
    savePresetBackup,
    updatePresetBackupNote,
} from './preset-backups.js';

export function registerApi(router, manager, vectorStore) {
    registerStEndpoints(router, manager);
    if (vectorStore) registerVectorRoutes(router, vectorStore);

    router.get('/health', route(async (req, res) => {
        sendOk(res, await getStatusPayload(req, manager));
    }));

    router.get('/v1/status', route(async (req, res) => {
        sendOk(res, await getStatusPayload(req, manager));
    }));

    router.get('/v1/client.js', route(async (req, res) => {
        res.type('application/javascript; charset=utf-8');
        res.send(CLIENT_SCRIPT);
    }));

    router.post('/v1/preset-backups/save', route(async (req, res) => {
        sendOk(res, await savePresetBackup(req));
    }));

    router.post('/v1/preset-backups/save/list', route(async (req, res) => {
        sendOk(res, await listPresetBackups(req));
    }));

    router.post('/v1/preset-backups/save/rename', route(async (req, res) => {
        sendOk(res, await renamePresetBackup(req));
    }));

    router.post('/v1/preset-backups/save/note', route(async (req, res) => {
        sendOk(res, await updatePresetBackupNote(req));
    }));

    router.post('/v1/preset-backups/save/delete', route(async (req, res) => {
        sendOk(res, await deletePresetBackup(req));
    }));

    router.post('/v1/preset-backups/download', route(async (req, res) => {
        sendOk(res, await downloadPresetBackup(req));
    }));

    router.post('/v1/open', route(async (req, res) => {
        const database = normalizeDatabaseName(req.body?.database);
        const options = normalizeOpenOptions(req.body ?? {});
        const result = await manager.openForRequest(req, database, options);

        sendOk(res, result);
    }));

    router.post('/v1/info', route(async (req, res) => {
        const database = normalizeDatabaseName(req.body?.database);
        const result = await manager.info(req, database);

        sendOk(res, result);
    }));

    router.post('/v1/set', route(async (req, res) => {
        const database = normalizeDatabaseName(req.body?.database);
        const store = normalizeStoreName(req.body?.store);
        const key = normalizeKey(req.body?.key);
        const ttl = normalizeTtl(req.body?.ttl);
        const type = normalizeValueType(req.body?.type ?? req.body?.valueType);
        const result = await manager.set(req, database, store, key, req.body?.value, { ttl, type });

        sendOk(res, result);
    }));

    router.post('/v1/set-many', route(async (req, res) => {
        const database = normalizeDatabaseName(req.body?.database);
        const store = normalizeStoreName(req.body?.store);
        const entries = normalizeSetManyEntries(req.body?.entries, {
            ttl: req.body?.ttl,
            type: req.body?.type ?? req.body?.valueType,
        });
        const result = await manager.setMany(req, database, store, entries);

        sendOk(res, result);
    }));

    router.post('/v1/get', route(async (req, res) => {
        const database = normalizeDatabaseName(req.body?.database);
        const store = normalizeStoreName(req.body?.store);
        const key = normalizeKey(req.body?.key);
        const result = await manager.get(req, database, store, key);

        sendOk(res, result);
    }));

    router.post('/v1/get-many', route(async (req, res) => {
        const database = normalizeDatabaseName(req.body?.database);
        const store = normalizeStoreName(req.body?.store);
        const keys = normalizeKeys(req.body?.keys);
        const result = await manager.getMany(req, database, store, keys);

        sendOk(res, result);
    }));

    router.post('/v1/has', route(async (req, res) => {
        const database = normalizeDatabaseName(req.body?.database);
        const store = normalizeStoreName(req.body?.store);
        const key = normalizeKey(req.body?.key);
        const result = await manager.has(req, database, store, key);

        sendOk(res, result);
    }));

    router.post('/v1/delete', route(async (req, res) => {
        const database = normalizeDatabaseName(req.body?.database);
        const store = normalizeStoreName(req.body?.store);
        const key = normalizeKey(req.body?.key);
        const result = await manager.delete(req, database, store, key);

        sendOk(res, result);
    }));

    router.post('/v1/delete-many', route(async (req, res) => {
        const database = normalizeDatabaseName(req.body?.database);
        const store = normalizeStoreName(req.body?.store);
        const keys = normalizeKeys(req.body?.keys);
        const result = await manager.deleteMany(req, database, store, keys);

        sendOk(res, result);
    }));

    router.post('/v1/keys', route(async (req, res) => {
        const database = normalizeDatabaseName(req.body?.database);
        const store = normalizeStoreName(req.body?.store);
        const prefix = normalizePrefix(req.body?.prefix);
        const limit = normalizeLimit(req.body?.limit);
        const offset = normalizeOffset(req.body?.offset);
        const result = await manager.keys(req, database, store, { prefix, limit, offset });

        sendOk(res, result);
    }));

    router.post('/v1/entries', route(async (req, res) => {
        const database = normalizeDatabaseName(req.body?.database);
        const store = normalizeStoreName(req.body?.store);
        const prefix = normalizePrefix(req.body?.prefix);
        const limit = normalizeLimit(req.body?.limit);
        const offset = normalizeOffset(req.body?.offset);
        const result = await manager.entries(req, database, store, { prefix, limit, offset });

        sendOk(res, result);
    }));

    router.post('/v1/clear', route(async (req, res) => {
        const database = normalizeDatabaseName(req.body?.database);
        const store = normalizeStoreName(req.body?.store);
        const prefix = normalizePrefix(req.body?.prefix);
        const result = await manager.clear(req, database, store, { prefix });

        sendOk(res, result);
    }));
}

function route(handler) {
    return async (req, res) => {
        try {
            await handler(req, res);
        } catch (error) {
            const httpError = toHttpError(error);
            res.status(httpError.status).json(errorPayload(httpError));
        }
    };
}

function sendOk(res, data) {
    res.json({ ok: true, data });
}

async function getStatusPayload(req, manager) {
    const driver = await manager.getDriverStatus();

    return {
        installed: true,
        id: PLUGIN_ID,
        name: PLUGIN_NAME,
        version: PLUGIN_VERSION,
        capabilities: { saveGenerateCompleteResponseTool: true, regexBridge: true, extensionManager: true },
        apiVersion: API_VERSION,
        storage: 'per-user',
        user: req.user?.profile?.handle ?? null,
        driver,
    };
}
