import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import bytes from 'bytes';
import sanitize from 'sanitize-filename';
import { sync as writeFileAtomicSync } from 'write-file-atomic';
import { parse } from '../../../src/character-card-parser.js';
import { PUBLIC_DIRECTORIES, SETTINGS_FILE } from '../../../src/constants.js';
import { generateTimestamp, getVersion, removeOldBackups } from '../../../src/util.js';
import { PLUGIN_ID } from './constants.js';
import {
    getTiktokenTokenizer,
    getTokenizerModel,
    countWebTokenizerTokens,
    getSentencepiceTokenizer,
    getWebTokenizer,
} from '../../../src/endpoints/tokenizers.js';
import {
    closeSaveGenerateJobs,
    registerSaveGenerateEndpoints,
} from './save-generate.js';
import { setSafeHeader } from './header-utils.js';

const FAST_CHARACTER_CACHE_DATABASE = 'baibaoku.internal';
const FAST_CHARACTER_CACHE_STORE = 'character-fast-all';
const FAST_CHARACTER_CACHE_VERSION = 1;
const FAST_CHARACTER_CACHE_PAGE_SIZE = 1000;
const SETTINGS_FAST_CONFIG_DATABASE = 'baibaoku.internal';
const SETTINGS_FAST_CONFIG_STORE = 'fast-config';
const SETTINGS_FAST_CONFIG_KEY = 'global';
const DEFAULT_SETTINGS_ACCELERATION_ENABLED = true;
const DEFAULT_LAZY_THEME_LOADING_ENABLED = true;
const DEFAULT_CHARACTER_LIST_ACCELERATION_ENABLED = true;
const DEFAULT_RECENT_CHAT_LIST_ACCELERATION_ENABLED = true;
const DEFAULT_PROGRESSIVE_CHAT_LOADING_ENABLED = false;
const DEFAULT_TOKENIZER_BULK_COUNT_ENABLED = true;
const DEFAULT_EXTENSION_MANIFEST_BUNDLE_ENABLED = true;
const DEFAULT_VERSION_ACCELERATION_ENABLED = true;
const DEFAULT_CHAT_KEYBOARD_SCAN_REDUCTION_ENABLED = true;
const SETTINGS_AUTOSAVE_INTERVAL = 10 * 60 * 1000;
const FAST_RECENT_CHAT_READ_BUFFER_SIZE = 1024 * 1024;
const FAST_SEARCH_FILE_CONCURRENCY = 4;
const FAST_SEARCH_PREVIEW_LENGTH = 400;
const FAST_SEARCH_FORBIDDEN_REGEXP = path.sep === '/' ? /[/\x00]/ : /[/\x00\\]/;
// Reuse the same internal database/version as fast-all (independent store).
const FAST_SEARCH_CACHE_DATABASE = FAST_CHARACTER_CACHE_DATABASE;
const FAST_SEARCH_CACHE_VERSION = FAST_CHARACTER_CACHE_VERSION;
const FAST_SEARCH_CACHE_STORE = 'chats-fast-search';
const FAST_SEARCH_CACHE_PAGE_SIZE = FAST_CHARACTER_CACHE_PAGE_SIZE;
// Bump when the cached result object shape changes, to invalidate stale entries.
const FAST_SEARCH_CACHE_SCHEMA = 1;
const CHAT_BACKUP_CACHE_DATABASE = FAST_CHARACTER_CACHE_DATABASE;
const CHAT_BACKUP_CACHE_VERSION = FAST_CHARACTER_CACHE_VERSION;
const CHAT_BACKUP_CACHE_STORE = 'chat-backups-fast-list';
const CHAT_BACKUP_CACHE_PAGE_SIZE = FAST_CHARACTER_CACHE_PAGE_SIZE;
const CHAT_BACKUP_CACHE_SCHEMA = 1;
const CHAT_BACKUP_FILE_CONCURRENCY = 16;
const CHAT_BACKUP_FILE_PREFIX = 'chat_';
const CHAT_BACKUP_FILE_EXTENSION = '.jsonl';
const FAST_CHAT_GET_DEFAULT_THRESHOLD_BYTES = 2 * 1024 * 1024;
const FAST_CHAT_GET_DEFAULT_INITIAL_MESSAGES = 5;
const SETTINGS_TEXT_PERSIST_VERSION = 1;
const SETTINGS_TEXT_PERSIST_FILE = 'settings-text-v1.json';
const SETTINGS_PAYLOAD_PERSIST_VERSION = 2;
const SETTINGS_PAYLOAD_PERSIST_FILE = 'settings-payload-v1.json';
const SETTINGS_RESPONSE_PERSIST_VERSION = 1;
const SETTINGS_RESPONSE_META_FILE = 'settings-response-v1.json';
const SETTINGS_RESPONSE_BODY_FILE = 'settings-response-v1.body';
const SETTINGS_THEME_MODE_FULL = 'full';
const SETTINGS_THEME_MODE_LAZY = 'lazy';
const SETTINGS_LAZY_THEME_MARKER = '__baibaokuLazyTheme';
const SETTINGS_THEME_INDEX_CACHE_VERSION = 1;
// Orphaned atomic-write temp files (`*.tmp`) can leak in the cache directory when
// a rename is interrupted (process kill, AV/sync locking the file on Windows).
// They are never read back, so any temp file older than this is safe to delete.
const CACHE_TMP_ORPHAN_MAX_AGE_MS = 60 * 1000;
// Throttle the opportunistic sweep so frequent writes don't each scan the dir.
const CACHE_TMP_SWEEP_MIN_INTERVAL_MS = 5 * 60 * 1000;
// Map<cacheDirectory, lastSweepAtMs> to throttle sweeps per directory.
const cacheTmpSweepTimestamps = new Map();

// Cache structure: Map<userHandle, Map<filename, { mtime: number, size: number, data: Object }>>
const userCaches = new Map();
// Fast-search per-file result cache, persisted per user (like fast-all).
// Cache structure: Map<userHandle, Map<filePath, { mtime, size, result }>>
const fastSearchUserCaches = new Map();
// Lock structure: Map<userHandle, Promise<Map>> to dedupe concurrent loads.
const fastSearchLoadLocks = new Map();
// Cache structure: Map<userHandle, Map<filename, { mtime, size, chatItems }>>
const chatBackupUserCaches = new Map();
// Lock structure: Map<userHandle, Promise<Map>>
const chatBackupLoadLocks = new Map();
// Lock structure: Map<userHandle, Promise<{ data, metrics }>>
const chatBackupUpdateLocks = new Map();
// Lock structure: Map<userHandle, Promise<void>>
const updateLocks = new Map();
// Cache structure: Map<userHandle, { sections: Map<string, Map<filename, CachedFile>> }>
const settingsUserCaches = new Map();
// Lock structure: Map<userHandle, Promise<Object>>
const settingsUpdateLocks = new Map();
// Cache structure: Map<userHandle, { path: string, text: string, mtime: number, size: number, contentHash: string, updatedAt: number }>
const settingsFileCaches = new Map();
// Lock structure: Map<userHandle, Promise<Object>>
const settingsSaveLocks = new Map();
// Cache structure: Map<userHandle, { key: string, text: string }>
const settingsResponseCaches = new Map();
// Scheduler structure: Map<userHandle, { lastBackupAt: number, timer: Timeout|null, pendingPayload: Object|null }>
const settingsBackupSchedulers = new Map();
// Cache structure: Map<userHandle, string> (content hash of the last backed-up settings)
const lastBackupHashes = new Map();
const tokenizerLoadPromises = new WeakMap();
let staticSettingsPayload = null;
const EARLY_BRIDGE_VERSION = '1.0';
let fastVersionCache = null;
let fastVersionPromise = null;

/**
 * Gets a humanized date time string for default chat names.
 * Mirrors newer SillyTavern's util format without requiring that export.
 */
function humanizedDateTime(timestamp = Date.now()) {
    const date = new Date(timestamp);
    const dt = {
        year: date.getFullYear(),
        month: date.getMonth() + 1,
        day: date.getDate(),
        hour: date.getHours(),
        minute: date.getMinutes(),
        second: date.getSeconds(),
        millisecond: date.getMilliseconds(),
    };

    for (const key in dt) {
        const padLength = key === 'millisecond' ? 3 : 2;
        dt[key] = String(dt[key]).padStart(padLength, '0');
    }

    return `${dt.year}-${dt.month}-${dt.day}@${dt.hour}h${dt.minute}m${dt.second}s${dt.millisecond}ms`;
}

/**
 * Normalizes tags from V1/V2 char data structure.
 */
function extractTags(data) {
    let rawTags = data?.data?.tags || data?.tags || [];
    if (typeof rawTags === 'string') {
        rawTags = rawTags.split(',').map(x => x.trim()).filter(x => x);
    }
    return Array.isArray(rawTags) ? rawTags : [];
}

/**
 * Calculate chat statistics for a character
 */
async function calculateCharacterChatStats(chatsDir, filename, cachedStats) {
    const charDirName = filename.replace('.png', '');
    const charChatDir = path.join(chatsDir, charDirName);

    let chatSize = 0;
    let dateLastChat = 0;
    let chatDirStat = null;

    // Try to get chat directory stats
    try {
        chatDirStat = await fs.promises.stat(charChatDir);
    } catch (e) {
        if (e.code === 'ENOENT') {
            // No chat directory exists for this character
            return {
                chatSize: 0,
                dateLastChat: 0,
                chatDirMtime: 0,
                files: {},
            };
        }
        throw e;
    }

    // Fast path: if directory mtime hasn't changed, use cached stats
    if (cachedStats?.chatDirMtime === chatDirStat.mtimeMs && cachedStats.files) {
        return cachedStats;
    }

    // Directory changed, need to check files
    const files = await fs.promises.readdir(charChatDir);
    const jsonlFiles = files.filter(f => f.endsWith('.jsonl'));
    const fileStats = {};
    const cachedFiles = cachedStats?.files || {};

    // Check each file
    for (const file of jsonlFiles) {
        const filePath = path.join(charChatDir, file);
        const stat = await fs.promises.stat(filePath);
        const cached = cachedFiles[file];

        // Use cached data if file hasn't changed
        if (cached && cached.mtime === stat.mtimeMs && cached.size === stat.size) {
            fileStats[file] = cached;
            chatSize += cached.size;
            dateLastChat = Math.max(dateLastChat, cached.mtime);
        } else {
            // File is new or changed
            fileStats[file] = {
                size: stat.size,
                mtime: stat.mtimeMs,
            };
            chatSize += stat.size;
            dateLastChat = Math.max(dateLastChat, stat.mtimeMs);
        }
    }

    return {
        chatSize,
        dateLastChat,
        chatDirMtime: chatDirStat.mtimeMs,
        files: fileStats,
    };
}

/**
 * Formats a character exactly like ST's `toShallow`, with real chat stats
 */
async function formatShallowCharacter(filename, stat, rawDataStr, chatsDir, cachedChatStats) {
    let charData = {};
    try {
        charData = JSON.parse(rawDataStr);
    } catch (e) {
        console.warn(`[baibaoku] Failed to parse JSON for character card: ${filename}`);
    }

    let name = charData?.data?.name || charData?.name || filename.replace('.png', '');

    if (filename.startsWith('default_')) {
        const filenameBase = filename.replace('.png', '');
        if (name === filenameBase || name.startsWith('default_')) {
            name = name.replace(/^default_/, '');
        }
    }

    // Get real chat statistics
    const chatStats = await calculateCharacterChatStats(chatsDir, filename, cachedChatStats);

    // Use chat field from character data, or generate default
    const chatField = charData?.chat || `${name} - ${humanizedDateTime()}`;

    return {
        shallow: true,
        name: name,
        avatar: filename,
        chat: chatField,
        fav: charData?.data?.extensions?.fav || charData?.fav || false,
        date_added: stat.ctimeMs,
        create_date: charData?.create_date || new Date(Math.round(stat.ctimeMs)).toISOString(),
        date_last_chat: chatStats.dateLastChat,
        chat_size: chatStats.chatSize,
        data_size: rawDataStr.length,
        tags: extractTags(charData),
        data: {
            name: name,
            character_version: charData?.data?.character_version || '',
            creator: charData?.data?.creator || charData?.creator || '',
            creator_notes: charData?.data?.creator_notes || charData?.creatorcomment || '',
            tags: extractTags(charData),
            extensions: {
                fav: charData?.data?.extensions?.fav || charData?.fav || false,
                world: charData?.data?.extensions?.world || '',
            },
        },
        // Internal: store chat stats for future incremental updates
        _chatStats: chatStats,
    };
}

async function updateCacheForUser(req, manager, userHandle, charactersDir) {
    // 1. Get or create the cache for this user
    if (!userCaches.has(userHandle)) {
        userCaches.set(userHandle, await loadPersistentCache(req, manager));
    }
    const cache = userCaches.get(userHandle);
    const chatsDir = req.user?.directories?.chats;

    // 2. Fast path: check if directories have changed via mtime
    let charactersDirStat = null;
    let chatsDirStat = null;

    try {
        charactersDirStat = await fs.promises.stat(charactersDir);
    } catch (e) {
        if (e.code === 'ENOENT') return cache;
        throw e;
    }

    if (chatsDir) {
        try {
            chatsDirStat = await fs.promises.stat(chatsDir);
        } catch (e) {
            // chats directory doesn't exist, treat as mtime 0
            chatsDirStat = { mtimeMs: 0 };
        }
    }

    const charactersChanged = cache.charactersDirMtime !== charactersDirStat.mtimeMs;
    const chatsChanged = chatsDir && cache.chatsDirMtime !== (chatsDirStat?.mtimeMs || 0);

    // If both directories haven't changed, return cached data immediately
    if (!charactersChanged && !chatsChanged) {
        return cache;
    }

    const updatedItems = [];
    const deletedFilenames = [];

    // 3. Handle characters directory changes
    if (charactersChanged) {
        let files = [];
        try {
            files = await fs.promises.readdir(charactersDir);
        } catch (e) {
            if (e.code === 'ENOENT') return cache;
            throw e;
        }
        const pngFiles = files.filter(f => f.endsWith('.png'));

        // Batch stat all png files to get mtime
        const statPromises = pngFiles.map(async (filename) => {
            try {
                const stat = await fs.promises.stat(path.join(charactersDir, filename));
                return { filename, stat };
            } catch (e) {
                return { filename, error: e };
            }
        });
        const statResults = await Promise.all(statPromises);

        // Garbage Collection: Remove deleted files from cache
        const currentFileSet = new Set(pngFiles);
        for (const cachedFilename of cache.keys()) {
            if (!currentFileSet.has(cachedFilename)) {
                cache.delete(cachedFilename);
                deletedFilenames.push(cachedFilename);
            }
        }

        // Parse changed/new files
        const parsePromises = [];
        for (const result of statResults) {
            if (result.error) continue;

            const { filename, stat } = result;
            const cachedItem = cache.get(filename);

            // If not in cache, or file metadata differs
            if (!cachedItem || stat.mtimeMs !== cachedItem.mtime || stat.size !== cachedItem.size) {
                const filePath = path.join(charactersDir, filename);
                const parseTask = async () => {
                    try {
                        const rawDataStr = await parse(filePath, 'png');
                        if (rawDataStr) {
                            const shallowData = await formatShallowCharacter(filename, stat, rawDataStr, chatsDir, cachedItem?.data?._chatStats);
                            const item = {
                                mtime: stat.mtimeMs,
                                size: stat.size,
                                data: shallowData,
                            };
                            cache.set(filename, item);
                            updatedItems.push({ filename, item });
                        }
                    } catch (e) {
                        console.warn(`[baibaoku] Failed to parse character ${filename}:`, e.message);
                    }
                };
                parsePromises.push(parseTask());
            }
        }

        await Promise.all(parsePromises);
    }

    // 4. Handle chats directory changes (independent of characters)
    if (chatsChanged) {
        let chatSubDirs = [];
        try {
            chatSubDirs = await fs.promises.readdir(chatsDir, { withFileTypes: true });
        } catch (e) {
            if (e.code !== 'ENOENT') {
                console.warn(`[baibaoku] Failed to read chats directory:`, e.message);
            }
        }

        // Find which character chats have changed
        const chatUpdatePromises = [];
        for (const dirent of chatSubDirs.filter(d => d.isDirectory())) {
            const charName = dirent.name;
            const avatarFilename = `${charName}.png`;
            const cachedItem = cache.get(avatarFilename);

            if (!cachedItem) continue; // No such character

            const chatSubDir = path.join(chatsDir, charName);
            const updateTask = async () => {
                try {
                    const chatDirStat = await fs.promises.stat(chatSubDir);
                    const cachedChatStats = cachedItem.data?._chatStats;

                    // Only update if this character's chat directory changed
                    if (cachedChatStats?.chatDirMtime !== chatDirStat.mtimeMs) {
                        const newChatStats = await calculateCharacterChatStats(chatsDir, avatarFilename, cachedChatStats);
                        cachedItem.data.date_last_chat = newChatStats.dateLastChat;
                        cachedItem.data.chat_size = newChatStats.chatSize;
                        cachedItem.data._chatStats = newChatStats;
                        updatedItems.push({ filename: avatarFilename, item: cachedItem });
                    }
                } catch (e) {
                    if (e.code !== 'ENOENT') {
                        console.warn(`[baibaoku] Failed to update chat stats for ${avatarFilename}:`, e.message);
                    }
                }
            };
            chatUpdatePromises.push(updateTask());
        }

        await Promise.all(chatUpdatePromises);
    }

    // 5. Persist changes
    await persistCacheChanges(req, manager, updatedItems, deletedFilenames);

    // 6. Update directory mtimes in cache
    cache.charactersDirMtime = charactersDirStat.mtimeMs;
    cache.chatsDirMtime = chatsDirStat?.mtimeMs || 0;

    return cache;
}

async function loadPersistentCache(req, manager) {
    const cache = new Map();
    if (!manager) {
        return cache;
    }

    try {
        await manager.openForRequest(req, FAST_CHARACTER_CACHE_DATABASE, {
            displayName: '柏宝库内部缓存',
            version: FAST_CHARACTER_CACHE_VERSION,
        });

        let offset = 0;
        while (true) {
            const result = await manager.entries(req, FAST_CHARACTER_CACHE_DATABASE, FAST_CHARACTER_CACHE_STORE, {
                prefix: '',
                limit: FAST_CHARACTER_CACHE_PAGE_SIZE,
                offset,
            });

            const entries = result.entries || [];
            for (const entry of entries) {
                const item = normalizePersistentCacheItem(entry.value);
                if (item) {
                    cache.set(entry.key, item);
                }
            }

            if (entries.length < FAST_CHARACTER_CACHE_PAGE_SIZE) {
                break;
            }
            offset += FAST_CHARACTER_CACHE_PAGE_SIZE;
        }
    } catch (error) {
        console.warn('[baibaoku] Failed to load persistent character cache:', error.message);
    }

    return cache;
}

async function persistCacheChanges(req, manager, updatedItems, deletedFilenames) {
    if (!manager) {
        return;
    }

    try {
        for (let index = 0; index < updatedItems.length; index += FAST_CHARACTER_CACHE_PAGE_SIZE) {
            const batch = updatedItems.slice(index, index + FAST_CHARACTER_CACHE_PAGE_SIZE);
            if (batch.length) {
                await manager.setMany(req, FAST_CHARACTER_CACHE_DATABASE, FAST_CHARACTER_CACHE_STORE, batch.map(({ filename, item }) => ({
                    key: filename,
                    value: item,
                })));
            }
        }

        for (let index = 0; index < deletedFilenames.length; index += FAST_CHARACTER_CACHE_PAGE_SIZE) {
            const batch = deletedFilenames.slice(index, index + FAST_CHARACTER_CACHE_PAGE_SIZE);
            if (batch.length) {
                await manager.deleteMany(req, FAST_CHARACTER_CACHE_DATABASE, FAST_CHARACTER_CACHE_STORE, batch);
            }
        }
    } catch (error) {
        console.warn('[baibaoku] Failed to persist character cache changes:', error.message);
    }
}

function normalizePersistentCacheItem(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return null;
    }

    if (!Number.isFinite(value.mtime) || !value.data || typeof value.data !== 'object') {
        return null;
    }

    return {
        mtime: value.mtime,
        size: Number.isFinite(value.size) ? value.size : undefined,
        data: value.data,
    };
}

async function getFastRecentChats(req) {
    const userHandle = req.user?.profile?.handle;
    if (!userHandle) {
        const error = new Error('Unauthorized');
        error.status = 401;
        throw error;
    }

    const startedAt = Date.now();
    const pinnedChats = Array.isArray(req.body?.pinned) ? req.body.pinned : [];
    const max = normalizeRecentMax(req.body?.max) + pinnedChats.length;
    const withMetadata = Boolean(req.body?.metadata);
    const allChatFiles = [];
    const metrics = {
        characterFiles: 0,
        groupFiles: 0,
        rootFiles: 0,
        invalidFiles: 0,
        selectedFiles: 0,
        totalMs: 0,
    };

    await Promise.allSettled([
        collectFastRecentCharacterChatFiles(req, allChatFiles, metrics),
        collectFastRecentGroupChatFiles(req, allChatFiles, metrics),
        collectFastRecentRootChatFiles(req, allChatFiles, metrics),
    ]);

    const recentChats = allChatFiles.sort((a, b) => {
        const isAPinned = isPinnedRecentChat(a, pinnedChats);
        const isBPinned = isPinnedRecentChat(b, pinnedChats);

        if (isAPinned && !isBPinned) return -1;
        if (!isAPinned && isBPinned) return 1;

        return b.mtime - a.mtime;
    }).slice(0, max);
    metrics.selectedFiles = recentChats.length;

    const chatData = await Promise.allSettled(recentChats.map(file => getFastRecentChatInfo(file, withMetadata)));
    const validFiles = [];
    for (const result of chatData) {
        if (result.status === 'fulfilled' && result.value?.file_name) {
            validFiles.push(result.value);
        } else if (result.status === 'rejected') {
            metrics.invalidFiles += 1;
        }
    }

    metrics.totalMs = Date.now() - startedAt;
    return { data: validFiles, metrics };
}

function normalizeRecentMax(value) {
    const max = parseInt(value ?? Number.MAX_SAFE_INTEGER);
    return Number.isFinite(max) && max > 0 ? max : Number.MAX_SAFE_INTEGER;
}

async function collectFastRecentCharacterChatFiles(req, allChatFiles, metrics) {
    const directories = req.user?.directories || {};
    const charactersDir = directories.characters;
    const chatsDir = directories.chats;

    if (!charactersDir || !chatsDir) {
        return;
    }

    const characterDirents = await fs.promises.readdir(charactersDir, { withFileTypes: true });
    const avatarSet = new Set(characterDirents
        .filter(dirent => dirent.isFile() && path.extname(dirent.name) === '.png')
        .map(dirent => dirent.name));
    const chatDirents = await fs.promises.readdir(chatsDir, { withFileTypes: true });

    for (const dirent of chatDirents) {
        if (!dirent.isDirectory()) {
            continue;
        }

        const pngFile = `${dirent.name}.png`;
        if (!avatarSet.has(pngFile)) {
            continue;
        }

        const pathToChats = path.join(chatsDir, dirent.name);
        const chatFiles = await fs.promises.readdir(pathToChats, { withFileTypes: true });
        const jsonlFiles = chatFiles.filter(file => file.isFile() && path.extname(file.name) === '.jsonl');

        for (const file of jsonlFiles) {
            const filePath = path.join(pathToChats, file.name);
            const stats = await fs.promises.stat(filePath);
            allChatFiles.push({ pngFile, filePath, mtime: stats.mtimeMs });
            metrics.characterFiles += 1;
        }
    }
}

async function collectFastRecentGroupChatFiles(req, allChatFiles, metrics) {
    const directories = req.user?.directories || {};
    const groupsDir = directories.groups;
    const groupChatsDir = directories.groupChats;

    if (!groupsDir || !groupChatsDir) {
        return;
    }

    const groupDirents = await fs.promises.readdir(groupsDir, { withFileTypes: true });
    const groups = groupDirents.filter(dirent => dirent.isFile() && path.extname(dirent.name) === '.json');

    for (const group of groups) {
        try {
            const groupPath = path.join(groupsDir, group.name);
            const groupData = JSON.parse(await fs.promises.readFile(groupPath, 'utf8'));

            if (!Array.isArray(groupData.chats)) {
                continue;
            }

            for (const chat of groupData.chats) {
                const filePath = path.join(groupChatsDir, `${chat}.jsonl`);
                if (!fs.existsSync(filePath)) {
                    continue;
                }

                const stats = await fs.promises.stat(filePath);
                allChatFiles.push({ groupId: groupData.id, filePath, mtime: stats.mtimeMs });
                metrics.groupFiles += 1;
            }
        } catch {
            continue;
        }
    }
}

async function collectFastRecentRootChatFiles(req, allChatFiles, metrics) {
    const chatsDir = req.user?.directories?.chats;
    if (!chatsDir) {
        return;
    }

    const dirents = await fs.promises.readdir(chatsDir, { withFileTypes: true });
    const chatFiles = dirents.filter(dirent => dirent.isFile() && path.extname(dirent.name) === '.jsonl');

    for (const file of chatFiles) {
        const filePath = path.join(chatsDir, file.name);
        const stats = await fs.promises.stat(filePath);
        allChatFiles.push({ filePath, mtime: stats.mtimeMs });
        metrics.rootFiles += 1;
    }
}

function isPinnedRecentChat(chatFile, pinnedChats) {
    return pinnedChats.some(pinned => {
        return pinned?.file_name === path.basename(chatFile.filePath)
            && (pinned.avatar === chatFile.pngFile || pinned.group === chatFile.groupId);
    });
}

async function getFastRecentChatInfo(chatFile, withMetadata = false) {
    const parsedPath = path.parse(chatFile.filePath);
    const stats = await fs.promises.stat(chatFile.filePath);
    const chatData = {
        file_id: parsedPath.name,
        file_name: parsedPath.base,
        file_size: bytes.format(stats.size) ?? '',
        chat_items: 0,
        mes: '[The chat is empty]',
        last_mes: stats.mtimeMs,
    };

    if (chatFile.groupId) {
        chatData.group = chatFile.groupId;
    } else if (chatFile.pngFile) {
        chatData.avatar = chatFile.pngFile;
    }

    if (stats.size === 0) {
        return chatData;
    }

    const fileHandle = await fs.promises.open(chatFile.filePath, 'r');

    try {
        const scan = await scanJsonlLineInfo(fileHandle, stats.size);
        chatData.chat_items = Math.max(0, scan.lineCounter - 1);

        if (withMetadata && scan.firstLineLength > 0) {
            const firstLine = await readFileRangeAsUtf8(fileHandle, scan.firstLineStart, scan.firstLineLength);
            const firstJson = parseJsonLine(firstLine);
            if (firstJson?.chat_metadata && typeof firstJson.chat_metadata === 'object') {
                chatData.chat_metadata = firstJson.chat_metadata;
            }
        }

        if (scan.lastLineLength <= 0) {
            return chatData;
        }

        const lastLine = await readFileRangeAsUtf8(fileHandle, scan.lastLineStart, scan.lastLineLength);
        const jsonData = parseJsonLine(lastLine);
        if (jsonData && (jsonData.name || jsonData.character_name || jsonData.chat_metadata)) {
            chatData.mes = jsonData.mes || '[The message is empty]';
            chatData.last_mes = jsonData.send_date || new Date(Math.round(stats.mtimeMs)).toISOString();
            return chatData;
        }

        console.warn('Found an invalid or corrupted chat file:', chatFile.filePath);
        return null;
    } finally {
        await fileHandle.close();
    }
}

async function scanJsonlLineInfo(fileHandle, fileSize) {
    const buffer = Buffer.allocUnsafe(FAST_RECENT_CHAT_READ_BUFFER_SIZE);
    let lineCounter = 0;
    let position = 0;
    let previousLineStart = 0;
    let lastLineStart = 0;
    let firstLineEnd = -1;
    let lastByte = null;

    while (position < fileSize) {
        const { bytesRead } = await fileHandle.read(buffer, 0, buffer.length, position);
        if (bytesRead === 0) {
            break;
        }

        const chunk = buffer.subarray(0, bytesRead);
        let searchOffset = 0;
        let newlineOffset;

        while ((newlineOffset = chunk.indexOf(10, searchOffset)) !== -1) {
            const absoluteOffset = position + newlineOffset;
            if (firstLineEnd === -1) {
                firstLineEnd = absoluteOffset;
            }
            lineCounter += 1;
            previousLineStart = lastLineStart;
            lastLineStart = absoluteOffset + 1;
            searchOffset = newlineOffset + 1;
        }

        lastByte = chunk[bytesRead - 1];
        position += bytesRead;
    }

    if (lastByte !== 10) {
        lineCounter += 1;
    }

    const firstLineLength = firstLineEnd === -1 ? fileSize : firstLineEnd;
    const lastLineStartOffset = lastByte === 10 ? previousLineStart : lastLineStart;
    const lastLineEndOffset = lastByte === 10 ? Math.max(0, position - 1) : position;

    return {
        lineCounter,
        firstLineStart: 0,
        firstLineLength,
        lastLineStart: lastLineStartOffset,
        lastLineLength: Math.max(0, lastLineEndOffset - lastLineStartOffset),
    };
}

async function readFileRangeAsUtf8(fileHandle, start, length) {
    const buffer = Buffer.allocUnsafe(length);
    const { bytesRead } = await fileHandle.read(buffer, 0, length, start);
    return buffer.subarray(0, bytesRead).toString('utf8');
}

function parseJsonLine(line) {
    try {
        return JSON.parse(String(line ?? '').replace(/\r$/, ''));
    } catch {
        return null;
    }
}

function getFastSearchPreviewMessage(lastMessage) {
    if (!lastMessage) {
        return '';
    }

    return lastMessage.length > FAST_SEARCH_PREVIEW_LENGTH
        ? '...' + lastMessage.substring(lastMessage.length - FAST_SEARCH_PREVIEW_LENGTH)
        : lastMessage;
}

function getFastSearchFragments(query) {
    return String(query ?? '').trim().toLowerCase().split(/\s+/).filter(Boolean);
}

async function mapFastSearchLimited(items, limit, mapper) {
    if (items.length === 0) {
        return [];
    }

    const results = new Array(items.length);
    const workerCount = Math.max(1, Math.min(Math.floor(limit), items.length));
    let nextIndex = 0;

    async function worker() {
        while (nextIndex < items.length) {
            const index = nextIndex++;
            try {
                results[index] = { status: 'fulfilled', value: await mapper(items[index], index) };
            } catch (reason) {
                results[index] = { status: 'rejected', reason };
            }
        }
    }

    await Promise.all(Array.from({ length: workerCount }, worker));
    return results;
}

/**
 * Scans a chat file and returns search metadata, mirroring ST's getChatSearchResult.
 * Returns null for corrupted/invalid chat files so the caller can skip them.
 */
async function computeFastSearchResult(chatFilePath, stats) {
    const parsedPath = path.parse(chatFilePath);
    const result = {
        file_name: parsedPath.name,
        file_size: bytes.format(stats.size) ?? '',
        message_count: 0,
        last_mes: stats.mtimeMs,
        preview_message: '[The chat is empty]',
    };

    if (stats.size === 0) {
        return result;
    }

    const fileHandle = await fs.promises.open(chatFilePath, 'r');

    try {
        const scan = await scanJsonlLineInfo(fileHandle, stats.size);
        result.message_count = Math.max(0, scan.lineCounter - 1);

        if (scan.lastLineLength <= 0) {
            return result;
        }

        const lastLine = await readFileRangeAsUtf8(fileHandle, scan.lastLineStart, scan.lastLineLength);
        const jsonData = parseJsonLine(lastLine);
        if (jsonData && (jsonData.name || jsonData.character_name || jsonData.chat_metadata)) {
            result.preview_message = getFastSearchPreviewMessage(jsonData.mes || '[The message is empty]');
            result.last_mes = jsonData.send_date || new Date(Math.round(stats.mtimeMs)).toISOString();
            return result;
        }

        console.warn('[baibaoku] Found an invalid or corrupted chat file:', chatFilePath);
        return null;
    } finally {
        await fileHandle.close();
    }
}

function normalizeFastSearchCacheEntry(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return null;
    }

    if (value.schema !== FAST_SEARCH_CACHE_SCHEMA) {
        return null;
    }

    if (!Number.isFinite(value.mtime) || !Number.isFinite(value.size)) {
        return null;
    }

    // result may legitimately be null (cached marker for a corrupted file).
    if (value.result !== null && (typeof value.result !== 'object' || Array.isArray(value.result))) {
        return null;
    }

    return { mtime: value.mtime, size: value.size, result: value.result };
}

async function loadFastSearchCache(req, manager) {
    const cache = new Map();
    if (!manager) {
        return cache;
    }

    try {
        await manager.openForRequest(req, FAST_SEARCH_CACHE_DATABASE, {
            displayName: '柏宝库内部缓存',
            version: FAST_SEARCH_CACHE_VERSION,
        });

        let offset = 0;
        while (true) {
            const result = await manager.entries(req, FAST_SEARCH_CACHE_DATABASE, FAST_SEARCH_CACHE_STORE, {
                prefix: '',
                limit: FAST_SEARCH_CACHE_PAGE_SIZE,
                offset,
            });

            const entries = result.entries || [];
            for (const entry of entries) {
                const item = normalizeFastSearchCacheEntry(entry.value);
                if (item) {
                    cache.set(entry.key, item);
                }
            }

            if (entries.length < FAST_SEARCH_CACHE_PAGE_SIZE) {
                break;
            }
            offset += FAST_SEARCH_CACHE_PAGE_SIZE;
        }
    } catch (error) {
        console.warn('[baibaoku] Failed to load persistent fast-search cache:', error.message);
    }

    return cache;
}

async function getFastSearchUserCache(req, manager, userHandle) {
    if (fastSearchUserCaches.has(userHandle)) {
        return fastSearchUserCaches.get(userHandle);
    }

    // Dedupe concurrent first-loads for the same user.
    if (!fastSearchLoadLocks.has(userHandle)) {
        const loadPromise = loadFastSearchCache(req, manager)
            .then((cache) => {
                fastSearchUserCaches.set(userHandle, cache);
                return cache;
            })
            .finally(() => fastSearchLoadLocks.delete(userHandle));
        fastSearchLoadLocks.set(userHandle, loadPromise);
    }

    return fastSearchLoadLocks.get(userHandle);
}

async function persistFastSearchChanges(req, manager, updatedEntries, deletedKeys) {
    if (!manager) {
        return;
    }

    try {
        for (let index = 0; index < updatedEntries.length; index += FAST_SEARCH_CACHE_PAGE_SIZE) {
            const batch = updatedEntries.slice(index, index + FAST_SEARCH_CACHE_PAGE_SIZE);
            if (batch.length) {
                await manager.setMany(req, FAST_SEARCH_CACHE_DATABASE, FAST_SEARCH_CACHE_STORE, batch.map(({ key, item }) => ({
                    key,
                    value: { schema: FAST_SEARCH_CACHE_SCHEMA, ...item },
                })));
            }
        }

        for (let index = 0; index < deletedKeys.length; index += FAST_SEARCH_CACHE_PAGE_SIZE) {
            const batch = deletedKeys.slice(index, index + FAST_SEARCH_CACHE_PAGE_SIZE);
            if (batch.length) {
                await manager.deleteMany(req, FAST_SEARCH_CACHE_DATABASE, FAST_SEARCH_CACHE_STORE, batch);
            }
        }
    } catch (error) {
        console.warn('[baibaoku] Failed to persist fast-search cache changes:', error.message);
    }
}

function normalizeChatBackupCacheEntry(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return null;
    }

    if (value.schema !== CHAT_BACKUP_CACHE_SCHEMA) {
        return null;
    }

    if (!Number.isFinite(value.mtime) || !Number.isFinite(value.size)) {
        return null;
    }

    if (!Number.isInteger(value.chatItems) || value.chatItems < 0) {
        return null;
    }

    return {
        mtime: value.mtime,
        size: value.size,
        chatItems: value.chatItems,
    };
}

async function loadChatBackupCache(req, manager) {
    const cache = new Map();
    if (!manager) {
        return cache;
    }

    try {
        await manager.openForRequest(req, CHAT_BACKUP_CACHE_DATABASE, {
            displayName: 'BaiBaoKu internal cache',
            version: CHAT_BACKUP_CACHE_VERSION,
        });

        let offset = 0;
        while (true) {
            const result = await manager.entries(req, CHAT_BACKUP_CACHE_DATABASE, CHAT_BACKUP_CACHE_STORE, {
                prefix: '',
                limit: CHAT_BACKUP_CACHE_PAGE_SIZE,
                offset,
            });
            const entries = result.entries || [];

            for (const entry of entries) {
                const item = normalizeChatBackupCacheEntry(entry.value);
                if (item) {
                    cache.set(entry.key, item);
                }
            }

            if (entries.length < CHAT_BACKUP_CACHE_PAGE_SIZE) {
                break;
            }
            offset += CHAT_BACKUP_CACHE_PAGE_SIZE;
        }
    } catch (error) {
        console.warn('[baibaoku] Failed to load persistent chat backup cache:', error.message);
    }

    return cache;
}

async function getChatBackupUserCache(req, manager, userHandle) {
    if (chatBackupUserCaches.has(userHandle)) {
        return chatBackupUserCaches.get(userHandle);
    }

    if (!chatBackupLoadLocks.has(userHandle)) {
        const loadPromise = loadChatBackupCache(req, manager)
            .then((cache) => {
                chatBackupUserCaches.set(userHandle, cache);
                return cache;
            })
            .finally(() => chatBackupLoadLocks.delete(userHandle));
        chatBackupLoadLocks.set(userHandle, loadPromise);
    }

    return chatBackupLoadLocks.get(userHandle);
}

async function persistChatBackupChanges(req, manager, updatedEntries, deletedKeys) {
    if (!manager) {
        return;
    }

    try {
        for (let index = 0; index < updatedEntries.length; index += CHAT_BACKUP_CACHE_PAGE_SIZE) {
            const batch = updatedEntries.slice(index, index + CHAT_BACKUP_CACHE_PAGE_SIZE);
            if (batch.length) {
                await manager.setMany(req, CHAT_BACKUP_CACHE_DATABASE, CHAT_BACKUP_CACHE_STORE, batch.map(({ key, item }) => ({
                    key,
                    value: { schema: CHAT_BACKUP_CACHE_SCHEMA, ...item },
                })));
            }
        }

        for (let index = 0; index < deletedKeys.length; index += CHAT_BACKUP_CACHE_PAGE_SIZE) {
            const batch = deletedKeys.slice(index, index + CHAT_BACKUP_CACHE_PAGE_SIZE);
            if (batch.length) {
                await manager.deleteMany(req, CHAT_BACKUP_CACHE_DATABASE, CHAT_BACKUP_CACHE_STORE, batch);
            }
        }
    } catch (error) {
        console.warn('[baibaoku] Failed to persist chat backup cache changes:', error.message);
    }
}

async function countChatBackupItems(filePath, fileSize) {
    if (fileSize <= 0) {
        return 0;
    }

    const fileHandle = await fs.promises.open(filePath, 'r');
    try {
        const scan = await scanJsonlLineInfo(fileHandle, fileSize);
        return Math.max(0, scan.lineCounter - 1);
    } finally {
        await fileHandle.close();
    }
}

async function getFastChatBackupList(req, manager) {
    const userHandle = req.user?.profile?.handle;
    const backupDirectory = req.user?.directories?.backups;
    if (!userHandle || !backupDirectory) {
        const error = new Error('Unauthorized');
        error.status = 401;
        throw error;
    }

    const startedAt = Date.now();
    const dirents = await fs.promises.readdir(backupDirectory, { withFileTypes: true });
    const backupFiles = dirents
        .filter(dirent => dirent.isFile()
            && dirent.name.startsWith(CHAT_BACKUP_FILE_PREFIX)
            && path.extname(dirent.name) === CHAT_BACKUP_FILE_EXTENSION)
        .map(dirent => dirent.name);
    const currentFiles = new Set(backupFiles);
    const cache = await getChatBackupUserCache(req, manager, userHandle);
    const updatedEntries = [];
    let cacheHits = 0;
    let cacheMisses = 0;

    const settled = await mapFastSearchLimited(
        backupFiles,
        CHAT_BACKUP_FILE_CONCURRENCY,
        async (fileName) => {
            const filePath = path.join(backupDirectory, fileName);
            const stats = await fs.promises.stat(filePath);
            const cached = cache.get(fileName);
            let chatItems;

            if (cached && cached.mtime === stats.mtimeMs && cached.size === stats.size) {
                cacheHits += 1;
                chatItems = cached.chatItems;
            } else {
                cacheMisses += 1;
                chatItems = await countChatBackupItems(filePath, stats.size);
                const item = {
                    mtime: stats.mtimeMs,
                    size: stats.size,
                    chatItems,
                };
                cache.set(fileName, item);
                updatedEntries.push({ key: fileName, item });
            }

            return {
                file_name: fileName,
                file_size: bytes.format(stats.size) ?? '',
                chat_items: chatItems,
                last_mes: stats.mtimeMs,
            };
        },
    );

    const data = [];
    let invalidFiles = 0;
    for (const item of settled) {
        if (item.status === 'fulfilled') {
            data.push(item.value);
        } else {
            invalidFiles += 1;
            console.warn('[baibaoku] Failed to read chat backup metadata:', item.reason);
        }
    }

    const deletedKeys = [];
    for (const key of cache.keys()) {
        if (!currentFiles.has(key)) {
            cache.delete(key);
            deletedKeys.push(key);
        }
    }

    await persistChatBackupChanges(req, manager, updatedEntries, deletedKeys);

    return {
        data,
        metrics: {
            totalMs: Date.now() - startedAt,
            totalFiles: backupFiles.length,
            validFiles: data.length,
            invalidFiles,
            cacheHits,
            cacheMisses,
            cacheGc: deletedKeys.length,
        },
    };
}

/**
 * Returns fast-search metadata for a chat file, reusing a cached result when the
 * file's mtime and size are unchanged so the full file scan can be skipped.
 * The stat() call is still required to detect changes (it is cheap relative to
 * scanning the whole file). On a miss, the recomputed entry is pushed to
 * `updatedEntries` so the caller can persist it.
 */
async function getFastSearchResult(chatFilePath, cache, updatedEntries) {
    const stats = await fs.promises.stat(chatFilePath);
    const cached = cache.get(chatFilePath);

    if (cached && cached.mtime === stats.mtimeMs && cached.size === stats.size) {
        return cached.result;
    }

    const result = await computeFastSearchResult(chatFilePath, stats);
    const item = { mtime: stats.mtimeMs, size: stats.size, result };
    cache.set(chatFilePath, item);
    updatedEntries.push({ key: chatFilePath, item });
    return result;
}

async function collectFastSearchCharacterFiles(req, avatarUrl) {
    const chatsDir = req.user?.directories?.chats;
    if (!chatsDir) {
        return [];
    }

    const characterName = String(avatarUrl).replace('.png', '');
    const directoryPath = path.join(chatsDir, characterName);

    if (!fs.existsSync(directoryPath)) {
        return [];
    }

    const dirents = await fs.promises.readdir(directoryPath, { withFileTypes: true });
    return dirents
        .filter(dirent => dirent.isFile() && path.extname(dirent.name) === '.jsonl')
        .map(dirent => path.join(directoryPath, dirent.name));
}

function getFastSearchCharacterDirPrefix(req, avatarUrl) {
    const chatsDir = req.user?.directories?.chats;
    if (!chatsDir || typeof avatarUrl !== 'string') {
        return null;
    }

    const characterName = avatarUrl.replace('.png', '');
    // Mirror the join used in collectFastSearchCharacterFiles so cache keys match.
    return path.join(chatsDir, characterName) + path.sep;
}

async function collectFastSearchGroupFiles(req, groupId) {
    const groupsDir = req.user?.directories?.groups;
    const groupChatsDir = req.user?.directories?.groupChats;
    if (!groupsDir || !groupChatsDir) {
        return [];
    }

    const groupDirents = await fs.promises.readdir(groupsDir, { withFileTypes: true });
    const groupFiles = groupDirents.filter(dirent => dirent.isFile() && path.extname(dirent.name) === '.json');

    let targetGroup = null;
    for (const groupFile of groupFiles) {
        try {
            const groupData = JSON.parse(await fs.promises.readFile(path.join(groupsDir, groupFile.name), 'utf8'));
            if (groupData.id === groupId) {
                targetGroup = groupData;
                break;
            }
        } catch (error) {
            console.warn('[baibaoku] Group file is corrupted:', groupFile.name, error.message);
        }
    }

    if (!Array.isArray(targetGroup?.chats)) {
        return [];
    }

    return targetGroup.chats
        .map(chatId => path.join(groupChatsDir, `${chatId}.jsonl`))
        .filter(filePath => fs.existsSync(filePath));
}

async function getFastSearch(req, manager) {
    const userHandle = req.user?.profile?.handle;
    if (!userHandle) {
        const error = new Error('Unauthorized');
        error.status = 401;
        throw error;
    }

    const startedAt = Date.now();
    const query = req.body?.query;
    const avatarUrl = req.body?.avatar_url;
    const groupId = req.body?.group_id;

    // This fast path only handles the empty-query listing. Text queries fall back
    // to ST's original /api/chats/search on the frontend.
    if (getFastSearchFragments(query).length !== 0) {
        const error = new Error('fast-search only supports empty queries');
        error.status = 409;
        throw error;
    }

    // Manual path-traversal guard (the plugin router has no validateAvatarUrlMiddleware).
    if (typeof avatarUrl === 'string' && FAST_SEARCH_FORBIDDEN_REGEXP.test(avatarUrl)) {
        const error = new Error('Invalid avatar_url');
        error.status = 400;
        throw error;
    }

    const chatFiles = groupId
        ? await collectFastSearchGroupFiles(req, groupId)
        : await collectFastSearchCharacterFiles(req, avatarUrl);

    const cache = await getFastSearchUserCache(req, manager, userHandle);
    const updatedEntries = [];

    const settled = await mapFastSearchLimited(
        chatFiles,
        FAST_SEARCH_FILE_CONCURRENCY,
        chatFile => getFastSearchResult(chatFile, cache, updatedEntries),
    );
    const data = [];
    let invalidFiles = 0;
    for (const item of settled) {
        if (item.status === 'rejected') {
            invalidFiles += 1;
            console.warn('[baibaoku] Failed to read fast-search metadata:', item.reason);
            continue;
        }
        if (item.value) {
            data.push(item.value);
        }
    }

    // Garbage-collect cache entries for chats that no longer exist. Only safe for
    // the character branch, where chatFiles is the authoritative list for a single
    // directory; group chats share a flat directory, so prefix-based GC would be
    // unsafe and is skipped (those entries are bounded and simply linger).
    const deletedKeys = [];
    if (!groupId) {
        const presentKeys = new Set(chatFiles);
        const dirPrefix = getFastSearchCharacterDirPrefix(req, avatarUrl);
        if (dirPrefix) {
            for (const key of cache.keys()) {
                if (key.startsWith(dirPrefix) && !presentKeys.has(key)) {
                    cache.delete(key);
                    deletedKeys.push(key);
                }
            }
        }
    }

    if (updatedEntries.length || deletedKeys.length) {
        await persistFastSearchChanges(req, manager, updatedEntries, deletedKeys);
    }

    return {
        data,
        metrics: {
            totalMs: Date.now() - startedAt,
            totalFiles: chatFiles.length,
            validFiles: data.length,
            invalidFiles,
            cacheMisses: updatedEntries.length,
            cacheGc: deletedKeys.length,
        },
    };
}

async function getFastChatGet(req) {
    const userHandle = req.user?.profile?.handle;
    if (!userHandle) {
        const error = new Error('Unauthorized');
        error.status = 401;
        throw error;
    }

    const source = String(req.body?.source || '');
    const mode = req.body?.mode === 'full' ? 'full' : 'initial';
    const originalRequest = req.body?.originalRequest && typeof req.body.originalRequest === 'object'
        ? req.body.originalRequest
        : {};
    const thresholdBytes = normalizeFastChatThresholdBytes(req.body?.thresholdBytes);
    const initialMessages = normalizeFastChatInitialMessages(req.body?.initialMessages);
    const chatFile = resolveFastChatFile(req, source, originalRequest);
    const startedAt = Date.now();

    if (!chatFile?.filePath) {
        const error = new Error('Unsupported chat source');
        error.status = 400;
        throw error;
    }

    let stats = null;
    try {
        stats = await fs.promises.stat(chatFile.filePath);
    } catch {
        return buildFastChatResponse({
            kind: 'complete',
            chat: [],
            source,
            chatKey: chatFile.chatKey,
            stats: { size: 0, mtimeMs: 0 },
            totalMessages: 0,
            returnedMessages: 0,
            messageStartIndex: 0,
            elapsedMs: Date.now() - startedAt,
        });
    }

    if (stats.size <= 0) {
        return buildFastChatResponse({
            kind: 'complete',
            chat: [],
            source,
            chatKey: chatFile.chatKey,
            stats,
            totalMessages: 0,
            returnedMessages: 0,
            messageStartIndex: 0,
            elapsedMs: Date.now() - startedAt,
        });
    }

    if (mode === 'full' || stats.size <= thresholdBytes) {
        const chat = await readFullJsonlChat(chatFile.filePath);
        const totalMessages = countChatMessages(chat);
        return buildFastChatResponse({
            kind: mode === 'full' ? 'full' : 'complete',
            chat,
            source,
            chatKey: chatFile.chatKey,
            stats,
            totalMessages,
            returnedMessages: totalMessages,
            messageStartIndex: 0,
            elapsedMs: Date.now() - startedAt,
        });
    }

    const partial = await readPartialJsonlChat(chatFile.filePath, stats.size, initialMessages);
    return buildFastChatResponse({
        kind: 'partial',
        chat: partial.chat,
        source,
        chatKey: chatFile.chatKey,
        stats,
        totalMessages: partial.totalMessages,
        returnedMessages: partial.returnedMessages,
        messageStartIndex: partial.messageStartIndex,
        elapsedMs: Date.now() - startedAt,
    });
}

function normalizeFastChatThresholdBytes(value) {
    const threshold = Number(value);
    return Number.isFinite(threshold) && threshold > 0
        ? Math.floor(threshold)
        : FAST_CHAT_GET_DEFAULT_THRESHOLD_BYTES;
}

function normalizeFastChatInitialMessages(value) {
    const count = Number(value);
    return Number.isInteger(count) && count > 0
        ? Math.min(count, 500)
        : FAST_CHAT_GET_DEFAULT_INITIAL_MESSAGES;
}

function resolveFastChatFile(req, source, originalRequest) {
    const directories = req.user?.directories || {};

    if (source === '/api/chats/get') {
        const chatsDir = directories.chats;
        const avatarUrl = String(originalRequest.avatar_url || '');
        const fileName = String(originalRequest.file_name || '');
        if (!chatsDir || !avatarUrl || !fileName) {
            return null;
        }

        const characterDir = sanitizeFastChatPathSegment(avatarUrl.replace('.png', ''));
        const chatFileName = sanitizeFastChatPathSegment(`${fileName}.jsonl`);
        const filePath = path.join(chatsDir, characterDir, chatFileName);
        if (!isFastChatPathUnderParent(chatsDir, filePath)) {
            return null;
        }

        return {
            filePath,
            chatKey: getFastChatKey(req, filePath),
        };
    }

    if (source === '/api/chats/group/get') {
        const groupChatsDir = directories.groupChats;
        const id = String(originalRequest.id || '');
        if (!groupChatsDir || !id) {
            return null;
        }

        const filePath = path.join(groupChatsDir, sanitizeFastChatPathSegment(`${id}.jsonl`));
        if (!isFastChatPathUnderParent(groupChatsDir, filePath)) {
            return null;
        }

        return {
            filePath,
            chatKey: getFastChatKey(req, filePath),
        };
    }

    return null;
}

function sanitizeFastChatPathSegment(value) {
    return path.basename(String(value || ''))
        .replace(/[<>:"/\\|?*\x00-\x1F]/g, '')
        .trim();
}

function isFastChatPathUnderParent(parent, target) {
    const relative = path.relative(path.resolve(parent), path.resolve(target));
    return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function getFastChatKey(req, filePath) {
    const root = req.user?.directories?.root;
    const relative = root
        ? path.relative(root, filePath)
        : filePath;
    return relative.replaceAll(path.sep, '/');
}

async function readFullJsonlChat(filePath) {
    const text = await fs.promises.readFile(filePath, 'utf8');
    if (!text) {
        return [];
    }

    return text
        .split('\n')
        .map(line => parseJsonLine(line))
        .filter(Boolean);
}

async function readPartialJsonlChat(filePath, fileSize, initialMessages) {
    const fileHandle = await fs.promises.open(filePath, 'r');

    try {
        const scan = await scanJsonlTailRanges(fileHandle, fileSize, initialMessages);
        const firstLineText = scan.firstLineRange
            ? await readFileRangeAsUtf8(fileHandle, scan.firstLineRange.start, scan.firstLineRange.length)
            : '';
        const firstJson = parseJsonLine(firstLineText);
        const hasHeader = Boolean(firstJson?.chat_metadata && typeof firstJson.chat_metadata === 'object');
        const tailRanges = hasHeader ? scan.tailMessageRanges : scan.tailAllRanges;
        const totalMessages = hasHeader
            ? Math.max(0, scan.lineCounter - 1)
            : scan.lineCounter;
        const messageStartIndex = Math.max(0, totalMessages - tailRanges.length);
        const chat = [];

        if (hasHeader) {
            chat.push(firstJson);
        }

        for (const range of tailRanges) {
            const text = await readFileRangeAsUtf8(fileHandle, range.start, range.length);
            const json = parseJsonLine(text);
            if (json) {
                chat.push(json);
            }
        }

        return {
            chat,
            totalMessages,
            returnedMessages: tailRanges.length,
            messageStartIndex,
        };
    } finally {
        await fileHandle.close();
    }
}

async function scanJsonlTailRanges(fileHandle, fileSize, tailLimit) {
    const buffer = Buffer.allocUnsafe(FAST_RECENT_CHAT_READ_BUFFER_SIZE);
    let lineCounter = 0;
    let position = 0;
    let lineStart = 0;
    let firstLineRange = null;
    let lastByte = null;
    const tailAllRanges = [];
    const tailMessageRanges = [];

    const pushTail = (queue, range) => {
        queue.push(range);
        while (queue.length > tailLimit) {
            queue.shift();
        }
    };

    const finishLine = (end) => {
        const range = {
            start: lineStart,
            length: Math.max(0, end - lineStart),
        };

        if (!firstLineRange) {
            firstLineRange = range;
        }

        if (range.length > 0) {
            pushTail(tailAllRanges, range);
            if (lineCounter > 0) {
                pushTail(tailMessageRanges, range);
            }
        }

        lineCounter += 1;
        lineStart = end + 1;
    };

    while (position < fileSize) {
        const { bytesRead } = await fileHandle.read(buffer, 0, buffer.length, position);
        if (bytesRead === 0) {
            break;
        }

        const chunk = buffer.subarray(0, bytesRead);
        let searchOffset = 0;
        let newlineOffset;

        while ((newlineOffset = chunk.indexOf(10, searchOffset)) !== -1) {
            finishLine(position + newlineOffset);
            searchOffset = newlineOffset + 1;
        }

        lastByte = chunk[bytesRead - 1];
        position += bytesRead;
    }

    if (lastByte !== 10 && lineStart < fileSize) {
        finishLine(fileSize);
    }

    return {
        lineCounter,
        firstLineRange,
        tailAllRanges,
        tailMessageRanges,
    };
}

function countChatMessages(chat) {
    if (!Array.isArray(chat) || chat.length === 0) {
        return 0;
    }

    return chat[0]?.chat_metadata ? Math.max(0, chat.length - 1) : chat.length;
}

function buildFastChatResponse({ kind, chat, source, chatKey, stats, totalMessages, returnedMessages, messageStartIndex, elapsedMs }) {
    const fileSize = Number(stats?.size || 0);
    const mtimeMs = Number(stats?.mtimeMs || 0);
    const startIndex = Math.max(0, Number(messageStartIndex || 0));
    const returned = Math.max(0, Number(returnedMessages || 0));

    return {
        ok: true,
        kind,
        chat,
        meta: {
            partial: kind === 'partial',
            chatKey,
            source,
            fileSize,
            mtimeMs,
            version: `${fileSize}:${mtimeMs}`,
            totalMessages: Math.max(0, Number(totalMessages || 0)),
            returnedMessages: returned,
            messageStartIndex: startIndex,
            messageEndIndexExclusive: startIndex + returned,
            elapsedMs,
        },
    };
}

function getSettingsPath(req) {
    return path.join(req.user.directories.root, SETTINGS_FILE);
}

function shouldUseLazyThemeSettingsPayload(req) {
    return String(req.get('x-baibaoku-lazy-themes') || '') === '1';
}

function getCurrentThemeNameFromSettingsText(text) {
    try {
        const settings = JSON.parse(text || '{}');
        return typeof settings?.power_user?.theme === 'string' ? settings.power_user.theme : '';
    } catch {
        return '';
    }
}

function getSettingsUpdateLockKey(userHandle, payloadOptions) {
    const options = getSettingsPayloadOptions(payloadOptions);
    return [
        userHandle,
        options.themeMode,
        options.currentThemeName,
    ].join('\0');
}

function getBaibaokuCacheDirectory(req) {
    return path.join(req.user.directories.root, 'baibaoku', 'cache');
}

function getSettingsTextPersistPath(req) {
    return path.join(getBaibaokuCacheDirectory(req), SETTINGS_TEXT_PERSIST_FILE);
}

function getSettingsPayloadPersistPath(req) {
    return path.join(getBaibaokuCacheDirectory(req), SETTINGS_PAYLOAD_PERSIST_FILE);
}

function getSettingsResponseMetaPath(req) {
    return path.join(getBaibaokuCacheDirectory(req), SETTINGS_RESPONSE_META_FILE);
}

function getSettingsResponseBodyPath(req) {
    return path.join(getBaibaokuCacheDirectory(req), SETTINGS_RESPONSE_BODY_FILE);
}

function cacheSettingsText(userHandle, settingsPath, text, stat) {
    settingsFileCaches.set(userHandle, {
        path: settingsPath,
        text,
        mtime: stat.mtimeMs,
        size: stat.size,
        contentHash: hashSettingsFileContent(text),
        updatedAt: Date.now(),
    });
    settingsResponseCaches.delete(userHandle);
}

function schedulePersistSettingsText(req, userHandle) {
    setTimeout(() => {
        void persistSettingsTextToDisk(req, userHandle)
            .catch((error) => {
                console.warn('[baibaoku] Failed to persist settings text cache:', error.message);
            });
    }, 0);
}

async function persistSettingsTextToDisk(req, userHandle) {
    const cached = settingsFileCaches.get(userHandle);
    if (!cached) {
        return false;
    }

    const payload = {
        version: SETTINGS_TEXT_PERSIST_VERSION,
        savedAt: Date.now(),
        path: cached.path,
        mtime: cached.mtime,
        size: cached.size,
        contentHash: cached.contentHash,
        updatedAt: cached.updatedAt,
        text: cached.text,
    };

    await writeFileAtomicAsync(getSettingsTextPersistPath(req), JSON.stringify(payload));
    return true;
}

async function restoreSettingsTextFromDisk(req, userHandle, settingsPath, stat) {
    let persisted;

    try {
        persisted = JSON.parse(await fs.promises.readFile(getSettingsTextPersistPath(req), 'utf8'));
    } catch {
        return null;
    }

    if (
        persisted?.version !== SETTINGS_TEXT_PERSIST_VERSION
        || persisted.path !== settingsPath
        || persisted.mtime !== stat.mtimeMs
        || persisted.size !== stat.size
        || typeof persisted.contentHash !== 'string'
        || typeof persisted.text !== 'string'
    ) {
        return null;
    }

    const currentText = await fs.promises.readFile(settingsPath, 'utf8');
    const currentHash = hashSettingsFileContent(currentText);
    if (currentHash !== persisted.contentHash) {
        return null;
    }

    settingsFileCaches.set(userHandle, {
        path: settingsPath,
        text: currentText,
        mtime: stat.mtimeMs,
        size: stat.size,
        contentHash: currentHash,
        updatedAt: Number(persisted.updatedAt) || Date.now(),
    });

    return {
        ...settingsFileCaches.get(userHandle),
        cacheHit: true,
        cacheStatus: 'persistent-hit',
    };
}

function getFreshSettingsTextCache(userHandle, settingsPath, stat) {
    const cached = settingsFileCaches.get(userHandle);

    if (
        !cached
        || cached.path !== settingsPath
        || cached.mtime !== stat.mtimeMs
        || cached.size !== stat.size
        || typeof cached.contentHash !== 'string'
    ) {
        return null;
    }

    return cached;
}

async function readSettingsTextWithCache(req, userHandle) {
    const settingsPath = getSettingsPath(req);
    const stat = await fs.promises.stat(settingsPath);

    const cached = getFreshSettingsTextCache(userHandle, settingsPath, stat);
    if (cached) {
        return {
            ...cached,
            cacheHit: true,
            cacheStatus: 'hit',
        };
    }

    const persisted = await restoreSettingsTextFromDisk(req, userHandle, settingsPath, stat);
    if (persisted) {
        return persisted;
    }

    const text = await fs.promises.readFile(settingsPath, 'utf8');
    cacheSettingsText(userHandle, settingsPath, text, stat);
    schedulePersistSettingsText(req, userHandle);

    return {
        ...settingsFileCaches.get(userHandle),
        cacheHit: false,
        cacheStatus: 'miss',
    };
}

function queueSettingsSave(userHandle, task) {
    const previous = settingsSaveLocks.get(userHandle) || Promise.resolve();
    const run = previous.catch(() => {}).then(task);
    const tracked = run.finally(() => {
        if (settingsSaveLocks.get(userHandle) === tracked) {
            settingsSaveLocks.delete(userHandle);
        }
    });

    settingsSaveLocks.set(userHandle, tracked);
    return tracked;
}

async function waitForPendingSettingsSave(userHandle) {
    const pendingSave = settingsSaveLocks.get(userHandle);

    if (pendingSave) {
        await pendingSave.catch(() => {});
    }
}

async function saveSettingsWithCache(req, userHandle) {
    const settingsPath = getSettingsPath(req);
    const text = JSON.stringify(req.body ?? {}, null, 4);
    let currentStat = null;

    try {
        currentStat = await fs.promises.stat(settingsPath);
    } catch (error) {
        if (error?.code !== 'ENOENT') {
            throw error;
        }
    }

    if (currentStat) {
        const cached = getFreshSettingsTextCache(userHandle, settingsPath, currentStat);
        const currentText = cached ? cached.text : await fs.promises.readFile(settingsPath, 'utf8');

        if (currentText === text) {
            return { result: 'ok', skipped: true };
        }
    }

    writeFileAtomicSync(settingsPath, text, 'utf8');

    const stat = await fs.promises.stat(settingsPath);
    cacheSettingsText(userHandle, settingsPath, text, stat);
    schedulePersistSettingsText(req, userHandle);

    return { result: 'ok' };
}

function getSettingsBackupFilePrefix(userHandle) {
    return `settings_${userHandle}_`;
}

function getSettingsBackupPayload(req, userHandle) {
    const directories = req.user?.directories;
    if (!directories?.backups || !directories?.root) {
        return null;
    }

    return {
        userHandle,
        backupDir: directories.backups,
        settingsPath: path.join(directories.root, SETTINGS_FILE),
    };
}

function getSettingsBackupScheduler(userHandle) {
    if (!settingsBackupSchedulers.has(userHandle)) {
        settingsBackupSchedulers.set(userHandle, {
            lastBackupAt: 0,
            timer: null,
            pendingPayload: null,
        });
    }

    return settingsBackupSchedulers.get(userHandle);
}

function scheduleSettingsAutoBackup(req, userHandle) {
    const payload = getSettingsBackupPayload(req, userHandle);
    if (!payload) {
        return;
    }

    const scheduler = getSettingsBackupScheduler(userHandle);
    const now = Date.now();
    const elapsed = now - scheduler.lastBackupAt;

    if (!scheduler.timer && elapsed >= SETTINGS_AUTOSAVE_INTERVAL) {
        scheduler.lastBackupAt = now;
        scheduler.timer = setTimeout(() => runScheduledSettingsBackup(userHandle, payload), 0);
        return;
    }

    scheduler.pendingPayload = payload;

    if (!scheduler.timer) {
        const delay = Math.max(0, SETTINGS_AUTOSAVE_INTERVAL - elapsed);
        scheduler.timer = setTimeout(() => runScheduledSettingsBackup(userHandle), delay);
    }
}

async function runScheduledSettingsBackup(userHandle, immediatePayload = null) {
    const scheduler = settingsBackupSchedulers.get(userHandle);
    if (!scheduler) {
        return;
    }

    scheduler.timer = null;

    const payload = immediatePayload || scheduler.pendingPayload;
    if (!immediatePayload) {
        scheduler.pendingPayload = null;
    }

    if (!payload) {
        return;
    }

    scheduler.lastBackupAt = Date.now();

    try {
        await backupSettingsIfChanged(payload);
    } catch (error) {
        console.warn('[baibaoku] Settings backup failed:', error.message);
    } finally {
        if (scheduler.pendingPayload && !scheduler.timer) {
            scheduler.timer = setTimeout(() => runScheduledSettingsBackup(userHandle), SETTINGS_AUTOSAVE_INTERVAL);
        }
    }
}

async function backupSettingsIfChanged(payload) {
    const { backupDir, settingsPath, userHandle } = payload;
    const cached = settingsFileCaches.get(userHandle);
    if (cached?.path !== settingsPath || typeof cached.text !== 'string') {
        return;
    }

    // Compare by content hash instead of the full text so we don't keep a second
    // copy of (potentially very large) settings resident in memory just to detect
    // changes. The hash is already computed when the settings text is cached.
    const contentHash = typeof cached.contentHash === 'string'
        ? cached.contentHash
        : hashSettingsFileContent(cached.text);
    if (lastBackupHashes.get(userHandle) === contentHash) {
        return;
    }

    await fs.promises.mkdir(backupDir, { recursive: true });

    const backupFile = path.join(backupDir, `${getSettingsBackupFilePrefix(userHandle)}${generateTimestamp()}.json`);
    await fs.promises.copyFile(settingsPath, backupFile);
    removeOldBackups(backupDir, `settings_${userHandle}`);
    lastBackupHashes.set(userHandle, contentHash);
}

function getSettingsUserCache(userHandle) {
    if (!settingsUserCaches.has(userHandle)) {
        settingsUserCaches.set(userHandle, {
            userHandle,
            sections: new Map(),
            payload: null,
            payloadDirty: true,
            payloadDirtyReason: 'initial',
            payloadDirtyAt: Date.now(),
            payloadBuiltAt: 0,
            payloadCacheKey: '',
            payloadThemeMode: SETTINGS_THEME_MODE_FULL,
            payloadThemeCurrentName: '',
            payloadPersistedBuiltAt: 0,
            payloadPersistPromise: null,
            payloadWatchers: new Map(),
            payloadWatchAttempted: false,
        });
    }

    return settingsUserCaches.get(userHandle);
}

function getSettingsPayloadWatchTargets(directories) {
    return [
        { directoryPath: directories.koboldAI_Settings, sectionName: 'koboldai_settings' },
        { directoryPath: directories.novelAI_Settings, sectionName: 'novelai_settings' },
        { directoryPath: directories.openAI_Settings, sectionName: 'openai_settings' },
        { directoryPath: directories.textGen_Settings, sectionName: 'textgenerationwebui_presets' },
        { directoryPath: directories.worlds, sectionName: null },
        { directoryPath: directories.themes, sectionName: 'themes' },
        { directoryPath: directories.movingUI, sectionName: 'movingUIPresets' },
        { directoryPath: directories.quickreplies, sectionName: 'quickReplyPresets' },
        { directoryPath: directories.instruct, sectionName: 'instruct' },
        { directoryPath: directories.context, sectionName: 'context' },
        { directoryPath: directories.sysprompt, sectionName: 'sysprompt' },
        { directoryPath: directories.reasoning, sectionName: 'reasoning' },
    ].filter(target => target.directoryPath);
}

function markSettingsPayloadDirty(userCache, reason = 'unknown') {
    userCache.payloadDirty = true;
    userCache.payloadDirtyReason = reason;
    userCache.payloadDirtyAt = Date.now();
    settingsResponseCaches.delete(userCache.userHandle);
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function formatSettingsWatchReason(target, eventType, filenameText) {
    return `watch:${eventType}:${target.directoryPath}${filenameText ? `/${filenameText}` : ''}`;
}

async function handleSettingsPayloadWatchEvent(userCache, target, eventType, filename) {
    const filenameText = filename ? String(filename) : '';
    const reason = formatSettingsWatchReason(target, eventType, filenameText);

    if (!filenameText) {
        markSettingsPayloadDirty(userCache, `${reason}:unknown-file`);
        return;
    }

    if (path.extname(filenameText).toLowerCase() !== '.json') {
        return;
    }

    if (!target.sectionName) {
        markSettingsPayloadDirty(userCache, reason);
        return;
    }

    await delay(75);

    const sectionCache = getSettingsSectionCache(userCache, target.sectionName);
    const cached = sectionCache.get(filenameText);
    const filePath = path.join(target.directoryPath, filenameText);
    let stat;
    let file;

    try {
        stat = await fs.promises.stat(filePath);
        file = await fs.promises.readFile(filePath, 'utf8');
    } catch {
        if (cached) {
            markSettingsPayloadDirty(userCache, `${reason}:missing`);
        }
        return;
    }

    const contentHash = hashSettingsFileContent(file);
    if (cached?.contentHash === contentHash) {
        cached.mtime = stat.mtimeMs;
        cached.size = stat.size;
        cached.contentHash = contentHash;
        return;
    }

    markSettingsPayloadDirty(userCache, reason);
}

function ensureSettingsPayloadWatchers(userCache, directories) {
    if (userCache.payloadWatchAttempted) {
        return;
    }

    userCache.payloadWatchAttempted = true;
    const targets = Array.from(new Map(
        getSettingsPayloadWatchTargets(directories).map(target => [target.directoryPath, target]),
    ).values());

    for (const target of targets) {
        try {
            const watcher = fs.watch(target.directoryPath, { persistent: false }, (eventType, filename) => {
                void handleSettingsPayloadWatchEvent(userCache, target, eventType, filename)
                    .catch((error) => {
                        const filenameText = filename ? String(filename) : '';
                        markSettingsPayloadDirty(userCache, `${formatSettingsWatchReason(target, eventType, filenameText)}:validate-error:${error.message}`);
                    });
            });

            watcher.on('error', (error) => {
                markSettingsPayloadDirty(userCache, `watch-error:${target.directoryPath}:${error.message}`);
                console.warn(`[baibaoku] Settings payload watcher failed for ${target.directoryPath}:`, error.message);
            });

            userCache.payloadWatchers.set(target.directoryPath, watcher);
        } catch (error) {
            markSettingsPayloadDirty(userCache, `watch-unavailable:${target.directoryPath}:${error.message}`);
            console.warn(`[baibaoku] Settings payload watcher unavailable for ${target.directoryPath}:`, error.message);
        }
    }
}

function normalizeSettingsThemeMode(mode) {
    return mode === SETTINGS_THEME_MODE_LAZY ? SETTINGS_THEME_MODE_LAZY : SETTINGS_THEME_MODE_FULL;
}

function getSettingsPayloadOptions(options = {}) {
    const themeMode = normalizeSettingsThemeMode(options.themeMode);
    return {
        themeMode,
        currentThemeName: themeMode === SETTINGS_THEME_MODE_LAZY ? String(options.currentThemeName || '') : '',
    };
}

function getCurrentSettingsPayloadOptions(userCache) {
    return getSettingsPayloadOptions({
        themeMode: userCache.payloadThemeMode,
        currentThemeName: userCache.payloadThemeCurrentName,
    });
}

function canUseCachedSettingsPayload(userCache, options = {}) {
    const payloadOptions = getSettingsPayloadOptions(options);

    return Boolean(
        userCache.payload
        && !userCache.payloadDirty
        && userCache.payloadThemeMode === payloadOptions.themeMode
        && userCache.payloadThemeCurrentName === payloadOptions.currentThemeName,
    );
}

function getSettingsSectionCache(userCache, sectionName) {
    if (!userCache.sections.has(sectionName)) {
        userCache.sections.set(sectionName, new Map());
    }

    return userCache.sections.get(sectionName);
}

async function readCachedPresetDirectory(userCache, sectionName, directoryPath) {
    const sectionCache = getSettingsSectionCache(userCache, sectionName);
    const entries = await updateCachedJsonDirectory(sectionCache, directoryPath, {
        sortMode: 'locale',
        valueMode: 'raw-json',
        removeFileExtension: true,
        warnInvalid: true,
    });

    return {
        fileContents: entries.map(entry => entry.value),
        fileNames: entries.map(entry => entry.name),
    };
}

async function readCachedParsedDirectory(userCache, sectionName, directoryPath) {
    const sectionCache = getSettingsSectionCache(userCache, sectionName);
    const entries = await updateCachedJsonDirectory(sectionCache, directoryPath, {
        sortMode: 'default',
        valueMode: 'parsed-json',
        removeFileExtension: false,
        warnInvalid: false,
    });

    return entries.map(entry => entry.value);
}

function hashSettingsFileContent(text) {
    return crypto.createHash('sha1').update(text).digest('hex');
}

function hashSettingsJson(value) {
    return crypto.createHash('sha1').update(JSON.stringify(value)).digest('hex');
}

function computeSettingsPayloadCacheKey(userCache, payload) {
    const sections = {};

    for (const [sectionName, sectionCache] of Array.from(userCache.sections.entries()).sort(([a], [b]) => a.localeCompare(b))) {
        sections[sectionName] = Array.from(sectionCache.entries())
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([filename, entry]) => ({
                filename,
                name: entry.name,
                contentHash: entry.contentHash || null,
                size: entry.size,
                themeIndexVersion: entry.themeIndexVersion || null,
            }));
    }

    return hashSettingsJson({
        version: SETTINGS_PAYLOAD_PERSIST_VERSION,
        themeMode: userCache.payloadThemeMode || SETTINGS_THEME_MODE_FULL,
        themeCurrentName: userCache.payloadThemeCurrentName || '',
        sections,
        world_names: Array.isArray(payload?.world_names) ? payload.world_names : [],
    });
}

async function updateCachedJsonDirectory(sectionCache, directoryPath, options) {
    const {
        sortMode,
        valueMode,
        removeFileExtension,
        warnInvalid,
    } = options;

    const files = (await fs.promises.readdir(directoryPath))
        .filter(file => path.parse(file).ext === '.json')
        .sort(sortMode === 'locale' ? (a, b) => a.localeCompare(b) : undefined);
    const currentFiles = new Set(files);

    for (const cachedFile of sectionCache.keys()) {
        if (!currentFiles.has(cachedFile)) {
            sectionCache.delete(cachedFile);
        }
    }

    await Promise.all(files.map(async (filename) => {
        const filePath = path.join(directoryPath, filename);
        let stat;

        try {
            stat = await fs.promises.stat(filePath);
        } catch {
            sectionCache.delete(filename);
            return;
        }

        const cached = sectionCache.get(filename);
        const cachedHasValue = valueMode === 'raw-json'
            ? typeof cached?.value === 'string'
            : cached?.value !== undefined;
        if (cached && cachedHasValue && cached.mtime === stat.mtimeMs && cached.size === stat.size) {
            return;
        }

        try {
            const file = await fs.promises.readFile(filePath, 'utf8');
            const parsed = JSON.parse(file);
            sectionCache.set(filename, {
                mtime: stat.mtimeMs,
                size: stat.size,
                contentHash: hashSettingsFileContent(file),
                name: removeFileExtension ? filename.replace(/\.[^/.]+$/, '') : filename,
                value: valueMode === 'raw-json' ? file : parsed,
            });
        } catch {
            sectionCache.delete(filename);
            if (warnInvalid) {
                console.warn(`${filename} is not a valid JSON`);
            }
        }
    }));

    return files
        .map(filename => sectionCache.get(filename))
        .filter(Boolean);
}

function getThemeFallbackName(filename) {
    return path.parse(filename).name;
}

function getThemeNameFromParsedFile(parsed, filename) {
    const name = typeof parsed?.name === 'string' && parsed.name.trim()
        ? parsed.name
        : getThemeFallbackName(filename);
    return name;
}

function makeLazyThemeStub(name) {
    return {
        name,
        [SETTINGS_LAZY_THEME_MARKER]: true,
    };
}

async function updateCachedThemeIndexDirectory(sectionCache, directoryPath) {
    const files = (await fs.promises.readdir(directoryPath))
        .filter(file => path.parse(file).ext === '.json')
        .sort();
    const currentFiles = new Set(files);

    for (const cachedFile of sectionCache.keys()) {
        if (!currentFiles.has(cachedFile)) {
            sectionCache.delete(cachedFile);
        }
    }

    await Promise.all(files.map(async (filename) => {
        const filePath = path.join(directoryPath, filename);
        let stat;

        try {
            stat = await fs.promises.stat(filePath);
        } catch {
            sectionCache.delete(filename);
            return;
        }

        const cached = sectionCache.get(filename);
        if (
            cached
            && cached.mtime === stat.mtimeMs
            && cached.size === stat.size
            && typeof cached.name === 'string'
            && typeof cached.contentHash === 'string'
            && cached.themeIndexVersion === SETTINGS_THEME_INDEX_CACHE_VERSION
        ) {
            delete cached.value;
            return;
        }

        try {
            const file = await fs.promises.readFile(filePath, 'utf8');
            const parsed = JSON.parse(file);
            const next = {
                ...(cached || {}),
                mtime: stat.mtimeMs,
                size: stat.size,
                contentHash: hashSettingsFileContent(file),
                name: getThemeNameFromParsedFile(parsed, filename),
                themeIndexVersion: SETTINGS_THEME_INDEX_CACHE_VERSION,
            };
            delete next.value;
            sectionCache.set(filename, next);
        } catch {
            sectionCache.delete(filename);
        }
    }));

    const entries = files
        .map(filename => {
            const entry = sectionCache.get(filename);
            return entry ? { filename, ...entry } : null;
        })
        .filter(Boolean);
    const nameToFilename = new Map();

    for (const entry of entries) {
        if (!nameToFilename.has(entry.name)) {
            nameToFilename.set(entry.name, entry.filename);
        }
    }

    return { entries, nameToFilename };
}

async function readCachedThemeFile(sectionCache, directoryPath, filename) {
    const filePath = path.join(directoryPath, filename);
    const stat = await fs.promises.stat(filePath);
    const cached = sectionCache.get(filename);

    if (cached?.value && cached.mtime === stat.mtimeMs && cached.size === stat.size) {
        return cached.value;
    }

    const file = await fs.promises.readFile(filePath, 'utf8');
    const parsed = JSON.parse(file);
    parsed.name = getThemeNameFromParsedFile(parsed, filename);
    sectionCache.set(filename, {
        ...(cached || {}),
        mtime: stat.mtimeMs,
        size: stat.size,
        contentHash: hashSettingsFileContent(file),
        name: parsed.name,
        themeIndexVersion: SETTINGS_THEME_INDEX_CACHE_VERSION,
        value: parsed,
    });
    return parsed;
}

async function readLazyThemeDirectory(userCache, directoryPath, currentThemeName) {
    const sectionCache = getSettingsSectionCache(userCache, 'themes');
    const { entries, nameToFilename } = await updateCachedThemeIndexDirectory(sectionCache, directoryPath);
    const namesToLoad = new Set();
    const firstThemeName = entries[0]?.name || '';

    if (firstThemeName) {
        namesToLoad.add(firstThemeName);
    }
    if (currentThemeName && nameToFilename.has(currentThemeName)) {
        namesToLoad.add(currentThemeName);
    }

    const fullThemesByName = new Map();
    await Promise.all(Array.from(namesToLoad).map(async (name) => {
        const filename = nameToFilename.get(name);
        if (!filename) {
            return;
        }
        fullThemesByName.set(name, await readCachedThemeFile(sectionCache, directoryPath, filename));
    }));

    return entries.map(entry => fullThemesByName.get(entry.name) || makeLazyThemeStub(entry.name));
}

async function readThemeByName(userCache, directoryPath, themeName) {
    const sectionCache = getSettingsSectionCache(userCache, 'themes');
    const { nameToFilename } = await updateCachedThemeIndexDirectory(sectionCache, directoryPath);
    let filename = nameToFilename.get(themeName);

    if (!filename) {
        const fallbackFilename = `${sanitize(themeName)}.json`;
        if (fallbackFilename && sectionCache.has(fallbackFilename)) {
            filename = fallbackFilename;
        }
    }

    if (!filename) {
        return null;
    }

    return {
        filename,
        theme: await readCachedThemeFile(sectionCache, directoryPath, filename),
    };
}

async function invalidateCachedSettingsPayloadIfThemeDirectoryChanged(userCache, directoryPath) {
    if (!userCache.payload || userCache.payloadDirty || !directoryPath) {
        return false;
    }

    const sectionCache = userCache.sections.get('themes');
    if (!sectionCache) {
        markSettingsPayloadDirty(userCache, 'theme-directory-signature-missing');
        return true;
    }

    const signature = await getJsonDirectorySignature(directoryPath);
    const currentFiles = Object.keys(signature).sort((a, b) => a.localeCompare(b));
    const cachedFiles = Array.from(sectionCache.keys()).sort((a, b) => a.localeCompare(b));
    const changed = currentFiles.length !== cachedFiles.length || currentFiles.some((filename, index) => {
        if (filename !== cachedFiles[index]) {
            return true;
        }

        const current = signature[filename];
        const cached = sectionCache.get(filename);
        return cached?.mtime !== current?.mtime || cached?.size !== current?.size;
    });

    if (changed) {
        markSettingsPayloadDirty(userCache, 'theme-directory-signature-changed');
    }

    return changed;
}

async function readWorldNames(directoryPath) {
    const worldFiles = (await fs.promises.readdir(directoryPath))
        .filter(file => path.extname(file).toLowerCase() === '.json')
        .sort((a, b) => a.localeCompare(b));

    return worldFiles.map(item => path.parse(item).name);
}

async function getJsonDirectorySignature(directoryPath, options = {}) {
    const caseInsensitiveExtension = options.caseInsensitiveExtension === true;
    const files = (await fs.promises.readdir(directoryPath))
        .filter((file) => {
            const extension = path.extname(file);
            return caseInsensitiveExtension ? extension.toLowerCase() === '.json' : extension === '.json';
        })
        .sort((a, b) => a.localeCompare(b));
    const signature = {};

    await Promise.all(files.map(async (filename) => {
        const stat = await fs.promises.stat(path.join(directoryPath, filename));
        signature[filename] = {
            mtime: stat.mtimeMs,
            size: stat.size,
        };
    }));

    return signature;
}

function sameDirectorySignature(left = {}, right = {}) {
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();

    if (leftKeys.length !== rightKeys.length) {
        return false;
    }

    return leftKeys.every((filename, index) => {
        const otherFilename = rightKeys[index];
        const leftFile = left[filename];
        const rightFile = right[otherFilename];

        return filename === otherFilename
            && leftFile?.mtime === rightFile?.mtime
            && leftFile?.size === rightFile?.size;
    });
}

function sameDirectoryFileNames(left = {}, right = {}) {
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();

    return leftKeys.length === rightKeys.length
        && leftKeys.every((filename, index) => filename === rightKeys[index]);
}

async function reconcilePersistedSectionSignature(directoryPath, persistedSection, state = {}) {
    const currentSignature = await getJsonDirectorySignature(directoryPath);
    const persistedSignature = persistedSection?.signature || {};
    const persistedFiles = persistedSection?.files || {};

    if (sameDirectorySignature(currentSignature, persistedSignature)) {
        return true;
    }

    if (!sameDirectoryFileNames(currentSignature, persistedSignature)) {
        return false;
    }

    for (const [filename, currentFile] of Object.entries(currentSignature)) {
        const persistedFile = persistedSignature[filename];
        if (persistedFile?.mtime === currentFile.mtime && persistedFile?.size === currentFile.size) {
            continue;
        }

        const persistedCacheEntry = persistedFiles[filename];
        if (!persistedCacheEntry?.contentHash) {
            return false;
        }

        const file = await fs.promises.readFile(path.join(directoryPath, filename), 'utf8');
        const contentHash = hashSettingsFileContent(file);
        if (contentHash !== persistedCacheEntry.contentHash) {
            return false;
        }

        state.reconciled = true;
        persistedSignature[filename] = currentFile;
        persistedCacheEntry.mtime = currentFile.mtime;
        persistedCacheEntry.size = currentFile.size;
        persistedCacheEntry.contentHash = contentHash;
    }

    return true;
}

async function writeFileAtomicAsync(filePath, data, options = 'utf8') {
    const directory = path.dirname(filePath);
    await fs.promises.mkdir(directory, { recursive: true });
    const tempPath = `${filePath}.${Date.now()}.${crypto.randomBytes(6).toString('hex')}.tmp`;

    try {
        await fs.promises.writeFile(tempPath, data, options);
        await fs.promises.rename(tempPath, filePath);
    } catch (error) {
        await fs.promises.unlink(tempPath).catch(() => {});
        throw error;
    }

    // Opportunistically clean up orphaned temp files left behind by interrupted
    // renames. Throttled, non-blocking, and best-effort — failures are ignored.
    scheduleOrphanedCacheTmpSweep(directory);
}

function scheduleOrphanedCacheTmpSweep(directory) {
    const now = Date.now();
    const lastSweepAt = cacheTmpSweepTimestamps.get(directory) || 0;
    if (now - lastSweepAt < CACHE_TMP_SWEEP_MIN_INTERVAL_MS) {
        return;
    }
    cacheTmpSweepTimestamps.set(directory, now);

    setTimeout(() => {
        void sweepOrphanedCacheTmpFiles(directory).catch((error) => {
            console.warn('[baibaoku] Failed to sweep orphaned cache temp files:', error.message);
        });
    }, 0);
}

async function sweepOrphanedCacheTmpFiles(directory) {
    let entries;
    try {
        entries = await fs.promises.readdir(directory, { withFileTypes: true });
    } catch (error) {
        if (error?.code === 'ENOENT') {
            return;
        }
        throw error;
    }

    const now = Date.now();
    await Promise.all(entries.map(async (entry) => {
        if (!entry.isFile() || !entry.name.endsWith('.tmp')) {
            return;
        }

        const tmpPath = path.join(directory, entry.name);
        try {
            const stat = await fs.promises.stat(tmpPath);
            if (now - stat.mtimeMs < CACHE_TMP_ORPHAN_MAX_AGE_MS) {
                return; // Possibly an in-flight write from a concurrent atomic save.
            }
            await fs.promises.unlink(tmpPath);
        } catch (error) {
            if (error?.code !== 'ENOENT') {
                console.warn(`[baibaoku] Failed to remove orphaned temp file ${entry.name}:`, error.message);
            }
        }
    }));
}

function restorePersistedSectionCache(userCache, sectionName, persistedSection) {
    if (!persistedSection?.files || typeof persistedSection.files !== 'object') {
        return false;
    }

    const sectionCache = new Map();
    for (const [filename, entry] of Object.entries(persistedSection.files)) {
        sectionCache.set(filename, entry);
    }
    userCache.sections.set(sectionName, sectionCache);
    return true;
}

async function restoreSettingsPayloadFromDisk(req, userHandle, directories, options = {}) {
    const payloadOptions = getSettingsPayloadOptions(options);
    const persistPath = getSettingsPayloadPersistPath(req);
    let persisted;

    try {
        persisted = JSON.parse(await fs.promises.readFile(persistPath, 'utf8'));
    } catch {
        return false;
    }

    if (persisted?.version !== SETTINGS_PAYLOAD_PERSIST_VERSION || !persisted.payload || !persisted.sections) {
        return false;
    }

    const persistedThemeMode = normalizeSettingsThemeMode(persisted.themeMode);
    const persistedThemeCurrentName = persistedThemeMode === SETTINGS_THEME_MODE_LAZY
        ? String(persisted.themeCurrentName || '')
        : '';

    if (
        persistedThemeMode !== payloadOptions.themeMode
        || persistedThemeCurrentName !== payloadOptions.currentThemeName
    ) {
        if (payloadOptions.themeMode === SETTINGS_THEME_MODE_LAZY && persisted.sections?.themes) {
            restorePersistedSectionCache(getSettingsUserCache(userHandle), 'themes', persisted.sections.themes);
        }
        return false;
    }

    const targets = getSettingsPayloadWatchTargets(directories);
    const restoreState = { reconciled: false };

    for (const target of targets) {
        if (target.sectionName) {
            const persistedSection = persisted.sections[target.sectionName];
            if (!persistedSection || !await reconcilePersistedSectionSignature(target.directoryPath, persistedSection, restoreState)) {
                return false;
            }
            continue;
        }

        const currentSignature = await getJsonDirectorySignature(target.directoryPath, {
            caseInsensitiveExtension: true,
        });
        if (!sameDirectorySignature(currentSignature, persisted.worlds?.signature)) {
            return false;
        }
    }

    const userCache = getSettingsUserCache(userHandle);
    userCache.sections.clear();

    for (const [sectionName, persistedSection] of Object.entries(persisted.sections)) {
        restorePersistedSectionCache(userCache, sectionName, persistedSection);
    }

    userCache.payload = persisted.payload;
    userCache.payloadDirty = false;
    userCache.payloadDirtyReason = '';
    userCache.payloadDirtyAt = 0;
    userCache.payloadThemeMode = payloadOptions.themeMode;
    userCache.payloadThemeCurrentName = payloadOptions.currentThemeName;
    userCache.payloadBuiltAt = Number(persisted.payloadBuiltAt) || Date.now();
    userCache.payloadCacheKey = persisted.payloadCacheKey || computeSettingsPayloadCacheKey(userCache, persisted.payload);
    userCache.payloadPersistedBuiltAt = restoreState.reconciled ? 0 : userCache.payloadBuiltAt;
    return true;
}

function ensureSettingsPayloadPersisted(req, userHandle) {
    const userCache = getSettingsUserCache(userHandle);
    const payloadOptions = getCurrentSettingsPayloadOptions(userCache);

    if (!canUseCachedSettingsPayload(userCache, payloadOptions)) {
        return null;
    }

    if (userCache.payloadPersistedBuiltAt === userCache.payloadBuiltAt) {
        return userCache.payloadPersistPromise;
    }

    if (userCache.payloadPersistPromise) {
        return userCache.payloadPersistPromise;
    }

    userCache.payloadPersistPromise = new Promise(resolve => setTimeout(resolve, 0))
        .then(() => persistSettingsPayloadToDisk(req, userHandle))
        .catch((error) => {
            console.warn('[baibaoku] Failed to persist settings payload cache:', error.message);
            return false;
        })
        .finally(() => {
            userCache.payloadPersistPromise = null;
        });

    return userCache.payloadPersistPromise;
}

async function persistSettingsPayloadToDisk(req, userHandle) {
    const userCache = getSettingsUserCache(userHandle);
    const payloadOptions = getCurrentSettingsPayloadOptions(userCache);

    if (!canUseCachedSettingsPayload(userCache, payloadOptions)) {
        return false;
    }

    const cachedPayload = userCache.payload;
    const payloadBuiltAt = userCache.payloadBuiltAt;
    const directories = req.user.directories;
    const sections = {};

    for (const target of getSettingsPayloadWatchTargets(directories)) {
        const signature = await getJsonDirectorySignature(target.directoryPath, {
            caseInsensitiveExtension: !target.sectionName,
        });

        if (!target.sectionName) {
            sections.__worlds__ = { signature };
            continue;
        }

        const sectionCache = getSettingsSectionCache(userCache, target.sectionName);
        sections[target.sectionName] = {
            signature,
            files: Object.fromEntries(sectionCache.entries()),
        };
    }

    const persistPayload = {
        version: SETTINGS_PAYLOAD_PERSIST_VERSION,
        savedAt: Date.now(),
        payloadBuiltAt,
        themeMode: payloadOptions.themeMode,
        themeCurrentName: payloadOptions.currentThemeName,
        payloadCacheKey: userCache.payloadCacheKey || computeSettingsPayloadCacheKey(userCache, cachedPayload),
        sections: Object.fromEntries(Object.entries(sections).filter(([sectionName]) => sectionName !== '__worlds__')),
        worlds: sections.__worlds__ || { signature: {} },
        payload: cachedPayload,
    };

    if (!canUseCachedSettingsPayload(userCache, payloadOptions) || userCache.payload !== cachedPayload || userCache.payloadBuiltAt !== payloadBuiltAt) {
        return false;
    }

    await writeFileAtomicAsync(getSettingsPayloadPersistPath(req), JSON.stringify(persistPayload));
    userCache.payloadPersistedBuiltAt = payloadBuiltAt;
    return true;
}

async function getFastSettingsPayload(req, userHandle, metrics = {}, options = {}) {
    const userCache = getSettingsUserCache(userHandle);
    const directories = req.user.directories;
    const payloadOptions = getSettingsPayloadOptions(options);

    ensureSettingsPayloadWatchers(userCache, directories);

    if (payloadOptions.themeMode === SETTINGS_THEME_MODE_LAZY) {
        await invalidateCachedSettingsPayloadIfThemeDirectoryChanged(userCache, directories.themes);
    }

    if (canUseCachedSettingsPayload(userCache, payloadOptions)) {
        metrics.payloadCache = 'hit';
        metrics.payloadThemeMode = payloadOptions.themeMode;
        return userCache.payload;
    }

    if (
        !userCache.payload
        || userCache.payloadThemeMode !== payloadOptions.themeMode
        || userCache.payloadThemeCurrentName !== payloadOptions.currentThemeName
    ) {
        try {
            if (await restoreSettingsPayloadFromDisk(req, userHandle, directories, payloadOptions)) {
                metrics.payloadCache = 'persistent-hit';
                metrics.payloadThemeMode = payloadOptions.themeMode;
                return userCache.payload;
            }
        } catch (error) {
            console.warn('[baibaoku] Failed to restore settings payload cache from disk:', error.message);
        }
    }

    metrics.payloadCache = userCache.payload ? 'stale' : 'miss';
    metrics.payloadThemeMode = payloadOptions.themeMode;
    metrics.payloadDirtyReason = userCache.payloadDirtyReason || '';
    metrics.payloadDirtyAgeMs = userCache.payloadDirtyAt ? Date.now() - userCache.payloadDirtyAt : 0;

    return buildFastSettingsPayload(req, userHandle, payloadOptions);
}

async function buildFastSettingsPayload(req, userHandle, options = {}) {
    const userCache = getSettingsUserCache(userHandle);
    const directories = req.user.directories;
    const payloadOptions = getSettingsPayloadOptions(options);
    const themesPromise = payloadOptions.themeMode === SETTINGS_THEME_MODE_LAZY
        ? readLazyThemeDirectory(userCache, directories.themes, payloadOptions.currentThemeName)
        : readCachedParsedDirectory(userCache, 'themes', directories.themes);

    const [
        kobold,
        novelai,
        openai,
        textgenerationwebui,
        worldNames,
        themes,
        movingUIPresets,
        quickReplyPresets,
        instruct,
        context,
        sysprompt,
        reasoning,
    ] = await Promise.all([
        readCachedPresetDirectory(userCache, 'koboldai_settings', directories.koboldAI_Settings),
        readCachedPresetDirectory(userCache, 'novelai_settings', directories.novelAI_Settings),
        readCachedPresetDirectory(userCache, 'openai_settings', directories.openAI_Settings),
        readCachedPresetDirectory(userCache, 'textgenerationwebui_presets', directories.textGen_Settings),
        readWorldNames(directories.worlds),
        themesPromise,
        readCachedParsedDirectory(userCache, 'movingUIPresets', directories.movingUI),
        readCachedParsedDirectory(userCache, 'quickReplyPresets', directories.quickreplies),
        readCachedParsedDirectory(userCache, 'instruct', directories.instruct),
        readCachedParsedDirectory(userCache, 'context', directories.context),
        readCachedParsedDirectory(userCache, 'sysprompt', directories.sysprompt),
        readCachedParsedDirectory(userCache, 'reasoning', directories.reasoning),
    ]);

    const payload = {
        koboldai_settings: kobold.fileContents,
        koboldai_setting_names: kobold.fileNames,
        world_names: worldNames,
        novelai_settings: novelai.fileContents,
        novelai_setting_names: novelai.fileNames,
        openai_settings: openai.fileContents,
        openai_setting_names: openai.fileNames,
        textgenerationwebui_presets: textgenerationwebui.fileContents,
        textgenerationwebui_preset_names: textgenerationwebui.fileNames,
        themes,
        movingUIPresets,
        quickReplyPresets,
        instruct,
        context,
        sysprompt,
        reasoning,
    };

    userCache.payload = payload;
    userCache.payloadDirty = false;
    userCache.payloadDirtyReason = '';
    userCache.payloadDirtyAt = 0;
    userCache.payloadThemeMode = payloadOptions.themeMode;
    userCache.payloadThemeCurrentName = payloadOptions.currentThemeName;
    userCache.payloadBuiltAt = Date.now();
    userCache.payloadCacheKey = computeSettingsPayloadCacheKey(userCache, payload);
    ensureSettingsPayloadPersisted(req, userHandle);

    return payload;
}

async function getStaticSettingsPayload() {
    if (staticSettingsPayload) {
        return staticSettingsPayload;
    }

    const { getConfigValue } = await import('../../../src/util.js');
    const enableRequestCompression = !!getConfigValue('performance.requestCompression.enabled', false, 'boolean');

    staticSettingsPayload = {
        enable_extensions: !!getConfigValue('extensions.enabled', true, 'boolean'),
        enable_extensions_auto_update: !!getConfigValue('extensions.autoUpdate', true, 'boolean'),
        enable_accounts: !!getConfigValue('enableUserAccounts', false, 'boolean'),
        request_compression: {
            enabled: enableRequestCompression,
            minPayloadSize: bytes.parse(getConfigValue('performance.requestCompression.minPayloadSize', '256kb')) || 0,
            maxPayloadSize: bytes.parse(getConfigValue('performance.requestCompression.maxPayloadSize', '8mb')) || 0,
            timeout: Number(getConfigValue('performance.requestCompression.timeout', 3000, 'number')) || 0,
        },
    };

    return staticSettingsPayload;
}

function buildExtensionManifestBundle(req) {
    const userExtensionsDirectory = req.user?.directories?.extensions;

    if (!userExtensionsDirectory) {
        throw new Error('Current SillyTavern user extensions directory was not found.');
    }

    const builtInExtensions = readExtensionFolders(PUBLIC_DIRECTORIES.extensions)
        .filter(folder => folder !== 'third-party')
        .filter(folder => hasExtensionManifest(PUBLIC_DIRECTORIES.extensions, folder))
        .map(folder => ({ type: 'system', name: folder }));

    // 和酒馆原生 /discover 一致:没有 manifest.json 的目录(装到一半的残留)不算扩展,也不能挡住同名的全局扩展
    const userExtensions = readExtensionFolders(userExtensionsDirectory)
        .filter(folder => hasExtensionManifest(userExtensionsDirectory, folder))
        .map(folder => ({ type: 'local', name: `third-party/${folder}` }));

    const globalExtensions = readExtensionFolders(PUBLIC_DIRECTORIES.globalExtensions)
        .filter(folder => hasExtensionManifest(PUBLIC_DIRECTORIES.globalExtensions, folder))
        .map(folder => ({ type: 'global', name: `third-party/${folder}` }))
        .filter(extension => !userExtensions.some(userExtension => userExtension.name === extension.name));

    const extensions = [...builtInExtensions, ...userExtensions, ...globalExtensions];
    const manifests = {};
    const missing = {};
    const invalid = {};

    for (const extension of extensions) {
        const manifestPath = getExtensionManifestPath(req, extension);

        try {
            const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
            if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
                throw new Error('Manifest is not a valid JSON object.');
            }
            manifests[extension.name] = manifest;
        } catch (error) {
            const bucket = error?.code === 'ENOENT' ? missing : invalid;
            bucket[extension.name] = {
                path: manifestPath,
                message: error?.message || String(error),
            };
        }
    }

    return {
        extensions,
        manifests,
        missing,
        invalid,
        generatedAt: Date.now(),
    };
}

function readExtensionFolders(directory) {
    if (!fs.existsSync(directory)) {
        fs.mkdirSync(directory, { recursive: true });
    }

    return fs.readdirSync(directory)
        // 扩展管理安装时用的临时目录
        .filter(folder => !folder.startsWith('.baibaoku-'))
        .filter(folder => {
            try {
                return fs.statSync(path.join(directory, folder)).isDirectory();
            } catch {
                return false;
            }
        });
}

function hasExtensionManifest(directory, folder) {
    return fs.existsSync(path.join(directory, folder, 'manifest.json'));
}

function getExtensionManifestPath(req, extension) {
    switch (extension.type) {
        case 'system':
            return path.join(PUBLIC_DIRECTORIES.extensions, extension.name, 'manifest.json');
        case 'local':
            return path.join(req.user.directories.extensions, getThirdPartyExtensionFolder(extension.name), 'manifest.json');
        case 'global':
            return path.join(PUBLIC_DIRECTORIES.globalExtensions, getThirdPartyExtensionFolder(extension.name), 'manifest.json');
        default:
            throw new Error(`Unknown extension type: ${extension.type}`);
    }
}

function getThirdPartyExtensionFolder(name) {
    return String(name || '').replace(/^third-party[\\/]/, '');
}

async function getFastSettingsResponse(req, userHandle, settingsInfo, cachedPayload, staticPayload) {
    const key = getFastSettingsResponseKey(userHandle, settingsInfo, staticPayload);
    const cached = settingsResponseCaches.get(userHandle);

    if (cached?.key === key && typeof cached.text === 'string') {
        return {
            cacheHit: true,
            cacheStatus: 'hit',
            encoding: 'identity',
            body: cached.text,
        };
    }

    return restoreOrBuildFastSettingsResponseCache(req, userHandle, key, settingsInfo, cachedPayload, staticPayload);
}

async function restoreOrBuildFastSettingsResponseCache(req, userHandle, key, settingsInfo, cachedPayload, staticPayload) {
    const restored = await restoreFastSettingsResponseCache(req, userHandle, key);
    if (restored) {
        return {
            cacheHit: true,
            cacheStatus: 'persistent-hit',
            encoding: 'identity',
            body: restored.text,
        };
    }

    const nextCache = buildFastSettingsResponseCache(key, settingsInfo, cachedPayload, staticPayload);
    settingsResponseCaches.set(userHandle, nextCache);
    schedulePersistFastSettingsResponse(req, userHandle, nextCache);

    return {
        cacheHit: false,
        cacheStatus: 'miss',
        encoding: 'identity',
        body: nextCache.text,
    };
}

function getFastSettingsResponseKey(userHandle, settingsInfo, staticPayload) {
    const userCache = getSettingsUserCache(userHandle);

    return [
        settingsInfo.path,
        settingsInfo.mtime,
        settingsInfo.size,
        settingsInfo.contentHash || '',
        userCache.payloadCacheKey || userCache.payloadBuiltAt,
        hashSettingsJson(staticPayload),
    ].join('\0');
}

function buildFastSettingsResponseCache(key, settingsInfo, cachedPayload, staticPayload) {
    const text = JSON.stringify({
        settings: settingsInfo.text,
        ...cachedPayload,
        ...staticPayload,
    });

    return { key, text };
}

async function restoreFastSettingsResponseCache(req, userHandle, key) {
    let meta;

    try {
        meta = JSON.parse(await fs.promises.readFile(getSettingsResponseMetaPath(req), 'utf8'));
    } catch {
        return null;
    }

    if (meta?.version !== SETTINGS_RESPONSE_PERSIST_VERSION || meta.key !== key) {
        return null;
    }

    try {
        const text = await fs.promises.readFile(getSettingsResponseBodyPath(req), 'utf8');
        const cache = { key, text };
        settingsResponseCaches.set(userHandle, cache);
        return cache;
    } catch {
        return null;
    }
}

function schedulePersistFastSettingsResponse(req, userHandle, responseCache) {
    setTimeout(() => {
        void persistFastSettingsResponseToDisk(req, userHandle, responseCache)
            .catch((error) => {
                console.warn('[baibaoku] Failed to persist settings response cache:', error.message);
            });
    }, 0);
}

async function persistFastSettingsResponseToDisk(req, userHandle, responseCache) {
    if (!responseCache?.key || typeof responseCache.text !== 'string') {
        return false;
    }

    if (settingsResponseCaches.get(userHandle)?.key !== responseCache.key) {
        return false;
    }

    await writeFileAtomicAsync(getSettingsResponseBodyPath(req), responseCache.text);
    await writeFileAtomicAsync(getSettingsResponseMetaPath(req), JSON.stringify({
        version: SETTINGS_RESPONSE_PERSIST_VERSION,
        savedAt: Date.now(),
        key: responseCache.key,
        hasBody: true,
        bodyFile: SETTINGS_RESPONSE_BODY_FILE,
    }));

    return true;
}

function sameSettingsInfo(left, right) {
    return Boolean(
        left
        && right
        && left.path === right.path
        && left.mtime === right.mtime
        && left.size === right.size
        && left.contentHash === right.contentHash
        && left.updatedAt === right.updatedAt,
    );
}

function scheduleSettingsResponseWarmup(req, userHandle, reason = 'unknown') {
    setTimeout(() => {
        void warmSettingsResponseCache(req, userHandle, reason)
            .catch((error) => {
                console.warn(`[baibaoku] Failed to warm settings response cache after ${reason}:`, error.message);
            });
    }, 0);
}

async function warmSettingsResponseCache(req, userHandle) {
    const userCache = getSettingsUserCache(userHandle);
    const payloadOptions = getCurrentSettingsPayloadOptions(userCache);

    if (payloadOptions.themeMode !== SETTINGS_THEME_MODE_FULL || !canUseCachedSettingsPayload(userCache, payloadOptions)) {
        return false;
    }

    const cachedPayload = userCache.payload;
    const payloadBuiltAt = userCache.payloadBuiltAt;
    const settingsInfo = await readSettingsTextWithCache(req, userHandle);

    if (!canUseCachedSettingsPayload(userCache, payloadOptions) || userCache.payload !== cachedPayload || userCache.payloadBuiltAt !== payloadBuiltAt) {
        return false;
    }

    const staticPayload = await getStaticSettingsPayload();
    const currentSettingsInfo = settingsFileCaches.get(userHandle);

    if (!sameSettingsInfo(settingsInfo, currentSettingsInfo)) {
        return false;
    }

    const key = getFastSettingsResponseKey(userHandle, settingsInfo, staticPayload);
    const nextCache = buildFastSettingsResponseCache(key, settingsInfo, cachedPayload, staticPayload);

    if (
        !canUseCachedSettingsPayload(userCache, payloadOptions)
        || userCache.payload !== cachedPayload
        || userCache.payloadBuiltAt !== payloadBuiltAt
        || !sameSettingsInfo(settingsInfo, settingsFileCaches.get(userHandle))
    ) {
        return false;
    }

    settingsResponseCaches.set(userHandle, nextCache);
    schedulePersistFastSettingsResponse(req, userHandle, nextCache);
    return true;
}

async function getSettingsFastConfig(req, manager) {
    const result = await manager.get(
        req,
        SETTINGS_FAST_CONFIG_DATABASE,
        SETTINGS_FAST_CONFIG_STORE,
        SETTINGS_FAST_CONFIG_KEY,
    );
    let value = result.exists && result.value && typeof result.value === 'object'
        ? result.value
        : null;

    if (!value) {
        const legacyResult = await manager.get(
            req,
            SETTINGS_FAST_CONFIG_DATABASE,
            'settings-fast-config',
            'settings',
        );
        value = legacyResult.exists && legacyResult.value && typeof legacyResult.value === 'object'
            ? legacyResult.value
            : {};
    }

    const settingsAccelerationEnabled = value.settingsAccelerationEnabled !== false;
    const lazyThemeLoadingEnabled = settingsAccelerationEnabled && value.lazyThemeLoadingEnabled !== false;

    return {
        settingsAccelerationEnabled,
        lazyThemeLoadingEnabled,
        characterListAccelerationEnabled: value.characterListAccelerationEnabled !== false,
        recentChatListAccelerationEnabled: value.recentChatListAccelerationEnabled !== false,
        progressiveChatLoadingEnabled: false,
        tokenizerBulkCountEnabled: value.tokenizerBulkCountEnabled !== false,
        extensionManifestBundleEnabled: value.extensionManifestBundleEnabled !== false,
        versionAccelerationEnabled: value.versionAccelerationEnabled !== false,
        chatKeyboardScanReductionEnabled: value.chatKeyboardScanReductionEnabled !== false,
    };
}

async function setSettingsFastConfig(req, manager) {
    const current = await getSettingsFastConfig(req, manager);
    const requestedLazyThemeLoadingEnabled = req.body?.lazyThemeLoadingEnabled === undefined
        ? current.lazyThemeLoadingEnabled !== false
        : req.body.lazyThemeLoadingEnabled !== false;
    const requestedSettingsAccelerationEnabled = req.body?.settingsAccelerationEnabled === undefined
        ? current.settingsAccelerationEnabled !== false
        : req.body.settingsAccelerationEnabled !== false;
    const settingsAccelerationEnabled = requestedLazyThemeLoadingEnabled
        ? true
        : requestedSettingsAccelerationEnabled;

    const next = {
        ...current,
        settingsAccelerationEnabled,
        lazyThemeLoadingEnabled: settingsAccelerationEnabled && requestedLazyThemeLoadingEnabled,
        characterListAccelerationEnabled: req.body?.characterListAccelerationEnabled === undefined
            ? current.characterListAccelerationEnabled !== false
            : req.body.characterListAccelerationEnabled !== false,
        recentChatListAccelerationEnabled: req.body?.recentChatListAccelerationEnabled === undefined
            ? current.recentChatListAccelerationEnabled !== false
            : req.body.recentChatListAccelerationEnabled !== false,
        progressiveChatLoadingEnabled: false,
        tokenizerBulkCountEnabled: req.body?.tokenizerBulkCountEnabled === undefined
            ? current.tokenizerBulkCountEnabled !== false
            : req.body.tokenizerBulkCountEnabled !== false,
        extensionManifestBundleEnabled: req.body?.extensionManifestBundleEnabled === undefined
            ? current.extensionManifestBundleEnabled !== false
            : req.body.extensionManifestBundleEnabled !== false,
        versionAccelerationEnabled: req.body?.versionAccelerationEnabled === undefined
            ? current.versionAccelerationEnabled !== false
            : req.body.versionAccelerationEnabled !== false,
        chatKeyboardScanReductionEnabled: req.body?.chatKeyboardScanReductionEnabled === undefined
            ? current.chatKeyboardScanReductionEnabled !== false
            : req.body.chatKeyboardScanReductionEnabled !== false,
    };

    await manager.set(
        req,
        SETTINGS_FAST_CONFIG_DATABASE,
        SETTINGS_FAST_CONFIG_STORE,
        SETTINGS_FAST_CONFIG_KEY,
        next,
        { type: 'json' },
    );

    return next;
}

async function getSettingsFastConfigSafe(req, manager) {
    try {
        return await getSettingsFastConfig(req, manager);
    } catch (error) {
        console.warn('[baibaoku] Failed to read settings fast config; using defaults:', error.message);
        return {
            settingsAccelerationEnabled: DEFAULT_SETTINGS_ACCELERATION_ENABLED,
            lazyThemeLoadingEnabled: DEFAULT_LAZY_THEME_LOADING_ENABLED,
            characterListAccelerationEnabled: DEFAULT_CHARACTER_LIST_ACCELERATION_ENABLED,
            recentChatListAccelerationEnabled: DEFAULT_RECENT_CHAT_LIST_ACCELERATION_ENABLED,
            progressiveChatLoadingEnabled: DEFAULT_PROGRESSIVE_CHAT_LOADING_ENABLED,
            tokenizerBulkCountEnabled: DEFAULT_TOKENIZER_BULK_COUNT_ENABLED,
            extensionManifestBundleEnabled: DEFAULT_EXTENSION_MANIFEST_BUNDLE_ENABLED,
            versionAccelerationEnabled: DEFAULT_VERSION_ACCELERATION_ENABLED,
            chatKeyboardScanReductionEnabled: DEFAULT_CHAT_KEYBOARD_SCAN_REDUCTION_ENABLED,
        };
    }
}

async function getFastVersionPayload() {
    if (fastVersionCache) {
        return {
            payload: fastVersionCache.payload,
            source: 'hit',
            cacheAgeMs: Date.now() - fastVersionCache.cachedAt,
            sourceElapsedMs: fastVersionCache.sourceElapsedMs,
        };
    }

    const source = fastVersionPromise ? 'pending' : 'miss';

    if (!fastVersionPromise) {
        const startedAt = Date.now();
        fastVersionPromise = Promise.resolve()
            .then(() => getVersion())
            .then((payload) => {
                if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
                    throw new Error('SillyTavern version payload is invalid.');
                }

                fastVersionCache = {
                    payload,
                    cachedAt: Date.now(),
                    sourceElapsedMs: Date.now() - startedAt,
                };
                return fastVersionCache;
            })
            .finally(() => {
                fastVersionPromise = null;
            });
    }

    const cache = await fastVersionPromise;
    return {
        payload: cache.payload,
        source,
        cacheAgeMs: Date.now() - cache.cachedAt,
        sourceElapsedMs: cache.sourceElapsedMs,
    };
}

function warmFastVersionCache() {
    getFastVersionPayload().catch((error) => {
        console.warn('[baibaoku] Failed to prewarm fast-version cache:', error.message);
    });
}

function makeEarlyBridgeScript(options = {}) {
    const apiPrefix = `/api/plugins/${PLUGIN_ID}`;
    const fastVersionPath = `${apiPrefix}/v1/fast-version`;
    const fastSettingsGetPath = `${apiPrefix}/v1/settings/fast-get`;
    const fastSettingsSavePath = `${apiPrefix}/v1/settings/fast-save`;
    const fastThemeGetPath = `${apiPrefix}/v1/themes/get`;
    const fastCharacterListPath = `${apiPrefix}/v1/characters/fast-all`;
    const fastRecentChatListPath = `${apiPrefix}/v1/chats/fast-recent`;
    const extensionManifestBundlePath = `${apiPrefix}/v1/extensions/manifest-bundle`;
    const settingsAccelerationEnabled = options.settingsAccelerationEnabled !== false;
    const lazyThemeLoadingEnabled = settingsAccelerationEnabled && options.lazyThemeLoadingEnabled !== false;
    const characterListAccelerationEnabled = options.characterListAccelerationEnabled !== false;
    const recentChatListAccelerationEnabled = options.recentChatListAccelerationEnabled !== false;
    const tokenizerBulkCountEnabled = options.tokenizerBulkCountEnabled !== false;
    const extensionManifestBundleEnabled = options.extensionManifestBundleEnabled !== false;
    const versionAccelerationEnabled = options.versionAccelerationEnabled !== false;
    const chatKeyboardScanReductionEnabled = options.chatKeyboardScanReductionEnabled !== false;

    return `/* baibaoku early bridge v${EARLY_BRIDGE_VERSION} */
(function () {
  'use strict';

  var FLAG = '__baibaokuEarlyBridge';
  var VERSION = ${JSON.stringify(String(EARLY_BRIDGE_VERSION))};
  var FAST_VERSION = ${JSON.stringify(fastVersionPath)};
  var FAST_SETTINGS_GET = ${JSON.stringify(fastSettingsGetPath)};
  var FAST_SETTINGS_SAVE = ${JSON.stringify(fastSettingsSavePath)};
  var FAST_THEME_GET = ${JSON.stringify(fastThemeGetPath)};
  var FAST_CHARACTER_LIST = ${JSON.stringify(fastCharacterListPath)};
  var FAST_RECENT_CHAT_LIST = ${JSON.stringify(fastRecentChatListPath)};
  var EXTENSION_MANIFEST_BUNDLE = ${JSON.stringify(extensionManifestBundlePath)};
  var LAZY_THEME_MARKER = ${JSON.stringify(SETTINGS_LAZY_THEME_MARKER)};
  var SETTINGS_ACCELERATION_ENABLED = ${JSON.stringify(settingsAccelerationEnabled)};
  var LAZY_THEME_LOADING_ENABLED = ${JSON.stringify(lazyThemeLoadingEnabled)};
  var CHARACTER_LIST_ACCELERATION_ENABLED = ${JSON.stringify(characterListAccelerationEnabled)};
  var RECENT_CHAT_LIST_ACCELERATION_ENABLED = ${JSON.stringify(recentChatListAccelerationEnabled)};
  var TOKENIZER_BULK_COUNT_ENABLED = ${JSON.stringify(tokenizerBulkCountEnabled)};
  var EXTENSION_MANIFEST_BUNDLE_ENABLED = ${JSON.stringify(extensionManifestBundleEnabled)};
  var VERSION_ACCELERATION_ENABLED = ${JSON.stringify(versionAccelerationEnabled)};
  var CHAT_KEYBOARD_SCAN_REDUCTION_ENABLED = ${JSON.stringify(chatKeyboardScanReductionEnabled)};

  if (window[FLAG] && window[FLAG].installed) {
    return;
  }

  var state = window[FLAG] = window[FLAG] || {};
  var rawFetch = window.fetch && window.fetch.bind(window);

  if (typeof rawFetch !== 'function') {
    state.installed = false;
    state.error = 'window.fetch is unavailable';
    return;
  }

  state.installed = true;
  state.version = VERSION;
  state.installedAt = Date.now();
  state.fastVersionPath = FAST_VERSION;
  state.fastGetPath = FAST_SETTINGS_GET;
  state.fastSavePath = FAST_SETTINGS_SAVE;
  state.fastThemeGetPath = FAST_THEME_GET;
  state.fastCharacterListPath = FAST_CHARACTER_LIST;
  state.fastRecentChatListPath = FAST_RECENT_CHAT_LIST;
  state.extensionManifestBundlePath = EXTENSION_MANIFEST_BUNDLE;
  state.requests = state.requests || { version: 0, get: 0, save: 0, themeGet: 0, characters: 0, recentChats: 0, extensionBundle: 0, extensionManifest: 0, extensionManifestRefresh: 0, settingsPrefetch: 0, fallback: 0, errors: 0, frontendCache: 0, invalidations: 0, saveFrontendCache: 0 };
  if (typeof state.requests.version !== 'number') state.requests.version = 0;
  if (typeof state.requests.saveFrontendCache !== 'number') state.requests.saveFrontendCache = 0;
  if (typeof state.requests.themeGet !== 'number') state.requests.themeGet = 0;
  if (typeof state.requests.recentChats !== 'number') state.requests.recentChats = 0;
  if (typeof state.requests.extensionBundle !== 'number') state.requests.extensionBundle = 0;
  if (typeof state.requests.extensionManifest !== 'number') state.requests.extensionManifest = 0;
  if (typeof state.requests.extensionManifestRefresh !== 'number') state.requests.extensionManifestRefresh = 0;
  if (typeof state.requests.settingsPrefetch !== 'number') state.requests.settingsPrefetch = 0;
  state.rawFetch = rawFetch;
  state.settingsGetCache = state.settingsGetCache || null;
  state.settingsGetPending = null;
  state.settingsGetCacheVersion = typeof state.settingsGetCacheVersion === 'number' ? state.settingsGetCacheVersion : 0;
  state.settingsSaveCache = state.settingsSaveCache || null;
  state.settingsSavePending = null;
  state.settingsRequestHeaders = state.settingsRequestHeaders || null;
  state.lazyThemesArray = state.lazyThemesArray || null;
  if (!state.lazyThemeFetchPending || typeof state.lazyThemeFetchPending !== 'object') {
    state.lazyThemeFetchPending = Object.create(null);
  }
  state.lazyThemeCurrentName = state.lazyThemeCurrentName || '';
  state.extensionManifestBundleCache = state.extensionManifestBundleCache || null;
  state.extensionManifestBundlePending = null;

  // ---------------------------------------------------------------------------
  // 聊天键盘扫描合并 (Chat keyboard scan reduction)
  //
  // SillyTavern 原生 scripts/keyboard.js 在 document.body 上挂了一个
  // MutationObserver(subtree + class 属性),任何元素的 class 变化都会让它对
  // 该节点子树重新扫描全部可交互控件(28 个 querySelectorAll + matches),用于设
  // 置 Tab 焦点顺序。进入角色卡时大量消息会批量切换 class,导致这个 observer 被
  // 逐条同步唤醒,造成明显卡顿(实测进卡阶段约 170ms)。
  //
  // 这里在 ST 主脚本求值之前包装全局 MutationObserver 构造函数,做两件事:
  //   Layer 2 (始终开启): 把命中的那个 observer 的回调合并到下一帧,一帧内的多
  //           次变化只触发一次扫描。功能完全不变(tabindex 只服务 Tab/Enter,本
  //           就是异步交互),只是把“逐条同步全扫”变成“成批扫一次”。
  //   Layer 3 (开关控制): 直接丢弃发生在 #chat 内部的纯 class 变化。这是开销的
  //           绝对大头。代价仅是聊天区内联按钮的 Tab 键可达性会退化——点击/触摸
  //           完全不受影响。开关关闭时退回到只有 Layer 2 的安全行为。
  //
  // 只精准命中 keyboard.js 那一个 observer(body + subtree + class 属性过滤),
  // 其它所有 MutationObserver 原样放行,零误伤。任何异常都会静默降级为原生行为。
  // ---------------------------------------------------------------------------
  state.chatKeyboardScanReductionEnabled = CHAT_KEYBOARD_SCAN_REDUCTION_ENABLED;
  state.isChatKeyboardScanReductionEnabled = function () {
    return state.chatKeyboardScanReductionEnabled !== false;
  };
  state.setChatKeyboardScanReductionEnabled = function (enabled) {
    state.chatKeyboardScanReductionEnabled = Boolean(enabled);
    return state.chatKeyboardScanReductionEnabled;
  };

  (function installKeyboardObserverCoalescing() {
    try {
      var NativeMutationObserver = window.MutationObserver;
      if (typeof NativeMutationObserver !== 'function' || NativeMutationObserver.__baibaokuWrapped) {
        return;
      }

      var schedule = (typeof window.requestAnimationFrame === 'function')
        ? function (cb) { return window.requestAnimationFrame(cb); }
        : function (cb) { return setTimeout(cb, 16); };

      // 判断一个 observe() 调用是否就是 keyboard.js 那个全局 observer。
      function isKeyboardObserverTarget(target, options) {
        if (target !== document.body || !options || !options.subtree) {
          return false;
        }
        if (!options.attributes && !options.attributeFilter) {
          return false;
        }
        var filter = options.attributeFilter;
        if (Array.isArray(filter)) {
          return filter.indexOf('class') !== -1;
        }
        // attributes:true 且未限定 filter,也会收到 class 变化。
        return options.attributes === true;
      }

      function isInsideChat(node) {
        var el = (node && node.nodeType === 1) ? node : (node ? node.parentElement : null);
        // closest 在元素上一定存在;#chat 是聊天消息容器。
        return !!(el && typeof el.closest === 'function' && el.closest('#chat'));
      }

      // 过滤一批 mutation:丢弃 #chat 内部的纯 class 变化(Layer 3)。
      // 返回需要转发给原始回调的 mutation 数组。
      function filterChatClassMutations(mutations) {
        var kept = [];
        for (var i = 0; i < mutations.length; i++) {
          var m = mutations[i];
          var isClassAttr = m.type === 'attributes' && m.attributeName === 'class';
          if (isClassAttr && isInsideChat(m.target)) {
            continue;
          }
          kept.push(m);
        }
        return kept;
      }

      function WrappedMutationObserver(callback) {
        if (typeof callback !== 'function') {
          return new NativeMutationObserver(callback);
        }

        var self = this;
        var isKeyboardObserver = false;
        var pendingFlush = 0;
        var queued = [];

        // 一帧内积压的独立扫描根(attribute 目标 + childList 新增节点)超过该值时,
        // 逐节点扫描的总成本必然超过对 document.body 的一次全量扫描,直接降级整扫。
        var FULL_SCAN_THRESHOLD = 40;

        // keyboard.js 的 initializeScrollResetBehaviors 对 .scroll-reset-container
        // 不去重地重复 addEventListener('focusout')。整扫会以 body 为根命中全部
        // 容器,每次降级都累积一份重复监听。整扫期间把“已见过”的容器类名临时
        // 摘掉(该函数靠 querySelectorAll 按类名找目标),结束后恢复;首次见到
        // 的容器不隐藏(可能尚未初始化,漏挂比重复挂更糟),记入 seen。
        var scrollResetSeen = (typeof WeakSet === 'function') ? new WeakSet() : null;

        function hideSeenScrollResetContainers() {
          if (!scrollResetSeen || !document.body || typeof document.body.querySelectorAll !== 'function') {
            return [];
          }
          var hidden = [];
          var containers = document.body.querySelectorAll('.scroll-reset-container');
          for (var i = 0; i < containers.length; i++) {
            var container = containers[i];
            if (scrollResetSeen.has(container)) {
              container.classList.remove('scroll-reset-container');
              hidden.push(container);
            } else {
              scrollResetSeen.add(container);
            }
          }
          return hidden;
        }

        function flush() {
          pendingFlush = 0;
          var batch = queued;
          queued = [];
          if (!batch.length) {
            return;
          }

          // 去重:同一 target 在一帧内的多次 class 变化只需扫一次;childList 原样保留。
          var deduped = [];
          var seenAttrTargets = (typeof Set === 'function') ? new Set() : null;
          var rootCount = 0;
          for (var i = 0; i < batch.length; i++) {
            var m = batch[i];
            if (m.type === 'attributes') {
              if (seenAttrTargets) {
                if (seenAttrTargets.has(m.target)) {
                  continue;
                }
                seenAttrTargets.add(m.target);
              }
              deduped.push(m);
              rootCount += 1;
            } else {
              deduped.push(m);
              rootCount += (m.addedNodes && m.addedNodes.length) || 0;
            }
          }

          // 大批量降级:mutation 风暴(主题切换、批量渲染)下,keyboard.js 会对每个
          // 变动节点各跑一遍全部选择器(N 次 querySelectorAll + matches)。改为转发一条
          // 合成 childList 记录,让它对 document.body 整体扫一次——覆盖范围是原批次的
          // 超集,成本从 N 次子树扫描降为 1 次全文档扫描。
          var hiddenContainers = [];
          if (rootCount > FULL_SCAN_THRESHOLD && document.body) {
            deduped = [{
              type: 'childList',
              target: document.body,
              addedNodes: [document.body],
              removedNodes: [],
              attributeName: null,
            }];
            hiddenContainers = hideSeenScrollResetContainers();
          }

          try {
            callback.call(self, deduped, self);
          } catch (_) {
            // 原始回调内部错误不应影响包装层。
          } finally {
            if (hiddenContainers.length) {
              for (var j = 0; j < hiddenContainers.length; j++) {
                hiddenContainers[j].classList.add('scroll-reset-container');
              }
              // 排掉本次隐藏/恢复以及回调自身 DOM 写入产生的 class 变动回声,
              // 避免下一帧对已处理元素再跑一轮空扫。同步 JS 期间不会有其它来源
              // 的 mutation 混入,丢弃是安全的。
              observer.takeRecords();
            }
          }
        }

        var observer = new NativeMutationObserver(function (mutations, obs) {
          // 非目标 observer:行为完全透传,不做任何处理。
          if (!isKeyboardObserver) {
            callback.call(self, mutations, obs);
            return;
          }

          // Layer 3(开关控制):丢弃 #chat 内部的纯 class 变化(开销大头)。
          // 开关关闭时不丢弃,仅保留 Layer 2 合并。
          var forwarded = state.isChatKeyboardScanReductionEnabled()
            ? filterChatClassMutations(mutations)
            : mutations;
          if (!forwarded.length) {
            return;
          }

          // Layer 2(始终开启):合并到下一帧,一帧内只触发一次扫描。
          for (var i = 0; i < forwarded.length; i++) {
            queued.push(forwarded[i]);
          }
          if (!pendingFlush) {
            pendingFlush = schedule(flush);
          }
        });

        // 暴露与原生一致的接口,并在 observe 时识别目标。
        this.observe = function (target, options) {
          if (isKeyboardObserverTarget(target, options)) {
            isKeyboardObserver = true;
          }
          return observer.observe(target, options);
        };
        this.disconnect = function () {
          queued = [];
          if (pendingFlush) {
            // rAF/timeout 句柄无法可靠区分;flush 会因 queued 为空而早退。
            pendingFlush = 0;
          }
          return observer.disconnect();
        };
        this.takeRecords = function () {
          var pending = queued;
          queued = [];
          return observer.takeRecords().concat(pending);
        };
      }

      WrappedMutationObserver.prototype = NativeMutationObserver.prototype;
      WrappedMutationObserver.__baibaokuWrapped = true;
      window.MutationObserver = WrappedMutationObserver;
      state.keyboardObserverCoalescingInstalled = true;
    } catch (error) {
      state.keyboardObserverCoalescingError = (error && error.message) ? error.message : String(error);
    }
  })();

  function clearExtensionManifestBundleCache(reason) {
    state.extensionManifestBundleCache = null;
    state.extensionManifestBundlePending = null;
    state.lastExtensionManifestBundleInvalidationReason = reason || 'unknown';
    state.lastExtensionManifestBundleInvalidatedAt = Date.now();
  }

  function writeSettingsAccelerationEnabled(enabled) {
    var next = Boolean(enabled);
    state.settingsAccelerationEnabled = next;
    if (!next) {
      state.lazyThemeLoadingEnabled = false;
      clearSettingsGetCache('settings-acceleration-disabled');
    }
    return next;
  }

  state.isSettingsAccelerationEnabled = function () {
    return state.settingsAccelerationEnabled !== false;
  };
  state.setSettingsAccelerationEnabled = writeSettingsAccelerationEnabled;
  state.settingsAccelerationEnabled = SETTINGS_ACCELERATION_ENABLED;

  function writeLazyThemeLoadingEnabled(enabled) {
    var next = Boolean(enabled);
    state.lazyThemeLoadingEnabled = next;
    if (next) {
      writeSettingsAccelerationEnabled(true);
    } else {
      clearSettingsGetCache('lazy-theme-loading-disabled');
    }
    return next;
  }

  state.isLazyThemeLoadingEnabled = function () {
    return state.settingsAccelerationEnabled !== false && state.lazyThemeLoadingEnabled !== false;
  };
  state.setLazyThemeLoadingEnabled = writeLazyThemeLoadingEnabled;
  state.lazyThemeLoadingEnabled = LAZY_THEME_LOADING_ENABLED;

  function writeCharacterListAccelerationEnabled(enabled) {
    state.characterListAccelerationEnabled = Boolean(enabled);
    return state.characterListAccelerationEnabled;
  }

  state.isCharacterListAccelerationEnabled = function () {
    return state.characterListAccelerationEnabled !== false;
  };
  state.setCharacterListAccelerationEnabled = writeCharacterListAccelerationEnabled;
  state.characterListAccelerationEnabled = CHARACTER_LIST_ACCELERATION_ENABLED;

  function writeRecentChatListAccelerationEnabled(enabled) {
    state.recentChatListAccelerationEnabled = Boolean(enabled);
    return state.recentChatListAccelerationEnabled;
  }

  state.isRecentChatListAccelerationEnabled = function () {
    return state.recentChatListAccelerationEnabled !== false;
  };
  state.setRecentChatListAccelerationEnabled = writeRecentChatListAccelerationEnabled;
  state.recentChatListAccelerationEnabled = RECENT_CHAT_LIST_ACCELERATION_ENABLED;

  function writeTokenizerBulkCountEnabled(enabled) {
    state.tokenizerBulkCountEnabled = Boolean(enabled);
    return state.tokenizerBulkCountEnabled;
  }

  state.isTokenizerBulkCountEnabled = function () {
    return state.tokenizerBulkCountEnabled !== false;
  };
  state.setTokenizerBulkCountEnabled = writeTokenizerBulkCountEnabled;
  state.tokenizerBulkCountEnabled = TOKENIZER_BULK_COUNT_ENABLED;

  function writeExtensionManifestBundleEnabled(enabled) {
    state.extensionManifestBundleEnabled = Boolean(enabled);
    if (state.extensionManifestBundleEnabled === false) {
      clearExtensionManifestBundleCache('extension-manifest-bundle-disabled');
    }
    return state.extensionManifestBundleEnabled;
  }

  state.isExtensionManifestBundleEnabled = function () {
    return state.extensionManifestBundleEnabled !== false;
  };
  state.setExtensionManifestBundleEnabled = writeExtensionManifestBundleEnabled;
  state.extensionManifestBundleEnabled = EXTENSION_MANIFEST_BUNDLE_ENABLED;

  function writeVersionAccelerationEnabled(enabled) {
    state.versionAccelerationEnabled = Boolean(enabled);
    return state.versionAccelerationEnabled;
  }

  state.isVersionAccelerationEnabled = function () {
    return state.versionAccelerationEnabled !== false;
  };
  state.setVersionAccelerationEnabled = writeVersionAccelerationEnabled;
  state.versionAccelerationEnabled = VERSION_ACCELERATION_ENABLED;

  function toUrl(input) {
    try {
      if (typeof input === 'string') return new URL(input, location.href);
      if (input instanceof URL) return new URL(input.href, location.href);
      if (input && typeof input.url === 'string') return new URL(input.url, location.href);
    } catch (_) {}
    return null;
  }

  function getMethod(input, init) {
    return String((init && init.method) || (input && input.method) || 'GET').toUpperCase();
  }

  function isLocalOrPrivateHost(hostname) {
    var host = normalizeHostname(hostname);

    if (!host) return false;
    if (host === 'localhost' || host.endsWith('.localhost')) return true;

    var ipv4Parts = parseIpv4Address(host);
    if (ipv4Parts) return isLocalOrPrivateIpv4(ipv4Parts);

    return isLocalOrPrivateIpv6(host);
  }

  function normalizeHostname(hostname) {
    return String(hostname || '')
      .trim()
      .toLowerCase()
      .replace(/^\\[|\\]$/g, '')
      .replace(/\\.+$/g, '');
  }

  function parseIpv4Address(host) {
    var parts = host.split('.');

    if (parts.length !== 4) return null;

    var octets = [];
    for (var i = 0; i < parts.length; i += 1) {
      if (!/^\\d{1,3}$/.test(parts[i])) return null;

      var value = Number(parts[i]);
      if (!Number.isInteger(value) || value < 0 || value > 255) return null;

      octets.push(value);
    }

    return octets;
  }

  function isLocalOrPrivateIpv4(parts) {
    var first = parts[0];
    var second = parts[1];
    return first === 0
      || first === 10
      || first === 127
      || (first === 169 && second === 254)
      || (first === 172 && second >= 16 && second <= 31)
      || (first === 192 && second === 168);
  }

  function isLocalOrPrivateIpv6(host) {
    if (!host.includes(':')) return false;
    if (host === '::1' || host === '0:0:0:0:0:0:0:1') return true;

    if (host.startsWith('::ffff:')) {
      var ipv4Parts = parseIpv4Address(host.slice(7));
      return ipv4Parts ? isLocalOrPrivateIpv4(ipv4Parts) : false;
    }

    var firstGroup = host.split(':')[0];
    if (!/^[0-9a-f]{1,4}$/.test(firstGroup)) return false;

    var firstValue = parseInt(firstGroup, 16);
    return (firstValue & 0xfe00) === 0xfc00
      || (firstValue & 0xffc0) === 0xfe80;
  }

  function shouldIntercept(url, method) {
    if (!url || url.origin !== location.origin) return null;
    if (method === 'GET') {
      if (url.pathname === '/version') return { kind: 'version', fastPath: FAST_VERSION };
      if (url.pathname === '/api/extensions/discover') return { kind: 'extensionDiscover', fastPath: EXTENSION_MANIFEST_BUNDLE };
      var manifestName = getManifestRequestName(url);
      if (manifestName) return { kind: 'extensionManifest', name: manifestName };
      return null;
    }
    if (method !== 'POST') return null;
    if (url.pathname === '/api/settings/get') return { kind: 'get', fastPath: FAST_SETTINGS_GET };
    if (url.pathname === '/api/settings/save') return { kind: 'save', fastPath: FAST_SETTINGS_SAVE };
    if (url.pathname === '/api/characters/all') return { kind: 'characters', fastPath: FAST_CHARACTER_LIST };
    if (url.pathname === '/api/chats/recent') return { kind: 'recentChats', fastPath: FAST_RECENT_CHAT_LIST };
    return null;
  }

  function getManifestRequestName(url) {
    var match = /^\\/scripts\\/extensions\\/(.+)\\/manifest\\.json$/i.exec(url.pathname || '');
    if (!match) return null;
    try {
      return decodeURIComponent(match[1]);
    } catch (_) {
      return match[1];
    }
  }

  function shouldInvalidateSettingsGetCache(url, method) {
    if (!url || url.origin !== location.origin || method !== 'POST') return false;
    if (url.pathname === '/api/settings/save') return true;
    return [
      '/api/worldinfo/',
      '/api/presets/',
      '/api/themes/',
      '/api/quick-replies/',
      '/api/moving-ui/',
    ].some(function (prefix) {
      return url.pathname.startsWith(prefix);
    });
  }

  function clearSettingsGetCache(reason) {
    if (state.settingsGetCache || state.settingsGetPending) {
      state.requests.invalidations += 1;
    }
    state.settingsGetCacheVersion += 1;
    state.settingsGetCache = null;
    state.settingsGetPending = null;
    state.lazyThemesArray = null;
    state.lastInvalidationReason = reason || 'unknown';
    state.lastInvalidatedAt = Date.now();
  }

  state.clearSettingsGetCache = clearSettingsGetCache;

  function clearSettingsSaveCache(reason) {
    state.settingsSaveCache = null;
    state.settingsSavePending = null;
    state.lastSaveInvalidationReason = reason || 'unknown';
    state.lastSaveInvalidatedAt = Date.now();
  }

  function makeCachedSettingsGetResponse(cache, source) {
    var headers = new Headers(cache.headers || undefined);
    headers.set('content-type', 'application/json; charset=utf-8');
    headers.set('x-baibaoku-frontend-cache', source || 'hit');
    headers.set('x-baibaoku-frontend-cache-age-ms', String(Date.now() - cache.savedAt));
    return decorateSettingsGetResponse(new Response(cache.text, {
      status: cache.status || 200,
      statusText: cache.statusText || 'OK',
      headers: headers,
    }), cache.text);
  }

  function rememberSettingsRequestHeaders(headers) {
    var next = {};
    try {
      new Headers(headers || undefined).forEach(function (value, key) {
        if (!/^content-length$/i.test(key)) {
          next[key] = value;
        }
      });
      state.settingsRequestHeaders = next;
    } catch (_) {}
  }

  function getPluginJsonHeaders() {
    var headers = new Headers();
    try {
      var remembered = new Headers(state.settingsRequestHeaders || undefined);
      var csrf = remembered.get('x-csrf-token');
      if (csrf) {
        headers.set('x-csrf-token', csrf);
      }
    } catch (_) {}
    headers.set('content-type', 'application/json');
    return headers;
  }

  function startSettingsGetPrefetch(reason) {
    if (state.settingsAccelerationEnabled === false) return null;
    if (state.settingsGetCache || state.settingsGetPending) return state.settingsGetPending;

    var headers = getPluginJsonHeaders();
    if (!headers.get('x-csrf-token')) return null;

    if (state.lazyThemeLoadingEnabled !== false) {
      headers.set('x-baibaoku-lazy-themes', '1');
    }
    var cacheVersion = state.settingsGetCacheVersion;
    state.requests.settingsPrefetch += 1;
    state.lastSettingsGetPrefetchReason = reason || 'unknown';
    state.lastSettingsGetPrefetchStartedAt = Date.now();

    var pending = rawFetch(FAST_SETTINGS_GET, {
      method: 'POST',
      cache: 'no-store',
      headers: headers,
      body: '{}',
    }).then(function (response) {
      if (!response || !response.ok) {
        throw new Error('Settings prefetch failed: ' + (response ? response.status : 'no response'));
      }
      return cacheSettingsGetResponse(response, cacheVersion);
    }).then(function (cache) {
      if (cache) {
        state.lastSettingsGetPrefetchFinishedAt = Date.now();
      }
      return cache;
    }).catch(function (error) {
      state.requests.errors += 1;
      state.lastSettingsGetPrefetchError = error && error.message ? error.message : String(error);
      return null;
    }).finally(function () {
      if (state.settingsGetPending === pending) {
        state.settingsGetPending = null;
      }
    });

    state.settingsGetPending = pending;
    return pending;
  }

  state.prefetchSettingsGet = startSettingsGetPrefetch;

  async function handleCsrfTokenResponse(response) {
    var payload = await response.json().catch(function () { return null; });
    var token = payload && typeof payload.token === 'string' ? payload.token : '';
    if (!token) return null;

    rememberSettingsRequestHeaders({
      'content-type': 'application/json',
      'x-csrf-token': token,
    });
    return startSettingsGetPrefetch('csrf-token');
  }

  function getSettingsThemeNameFromPayload(data) {
    if (!data || typeof data.settings !== 'string') return '';
    var parsed = parseJsonOrNull(data.settings);
    return typeof (parsed && parsed.power_user && parsed.power_user.theme) === 'string'
      ? parsed.power_user.theme
      : '';
  }

  function captureSettingsGetPayload(data) {
    if (!data || typeof data !== 'object') return data;
    if (Array.isArray(data.themes)) {
      state.lazyThemesArray = data.themes;
      state.lazyThemeCurrentName = getSettingsThemeNameFromPayload(data) || state.lazyThemeCurrentName || '';
    }
    return data;
  }

  function decorateSettingsGetResponse(response, text) {
    if (!response || typeof text !== 'string') return response;
    var parsedPromise = null;
    response.json = function () {
      if (!parsedPromise) {
        parsedPromise = Promise.resolve().then(function () {
          var parsed = JSON.parse(text);
          return captureSettingsGetPayload(parsed);
        });
      }
      return parsedPromise;
    };
    return response;
  }

  function isLazyThemeObject(theme) {
    return Boolean(theme && typeof theme === 'object' && theme[LAZY_THEME_MARKER] === true);
  }

  function findThemeSlot(name) {
    var themes = Array.isArray(state.lazyThemesArray) ? state.lazyThemesArray : [];
    for (var i = 0; i < themes.length; i += 1) {
      var theme = themes[i];
      if (theme && theme.name === name) {
        return { theme: theme, index: i };
      }
    }
    return null;
  }

  function isThemeLoaded(name) {
    var slot = findThemeSlot(name);
    return Boolean(slot && !isLazyThemeObject(slot.theme));
  }

  function isThemeLazy(name) {
    var slot = findThemeSlot(name);
    return Boolean(slot && isLazyThemeObject(slot.theme));
  }

  async function ensureThemeLoaded(name) {
    name = String(name || '');
    if (!name) return null;

    var slot = findThemeSlot(name);
    if (!slot) return null;
    if (!isLazyThemeObject(slot.theme)) return slot.theme;

    if (state.lazyThemeFetchPending[name]) {
      return state.lazyThemeFetchPending[name];
    }

    state.requests.themeGet += 1;
    state.lazyThemeFetchPending[name] = rawFetch(FAST_THEME_GET, {
      method: 'POST',
      cache: 'no-store',
      headers: getPluginJsonHeaders(),
      body: JSON.stringify({ name: name }),
    }).then(async function (response) {
      if (!response || !response.ok) {
        throw new Error('Theme request failed: ' + (response ? response.status : 'no response'));
      }

      var payload = await response.json();
      var theme = payload && payload.data;
      if (!theme || typeof theme !== 'object' || Array.isArray(theme)) {
        throw new Error('Theme response payload is invalid');
      }

      if (typeof theme.name !== 'string' || !theme.name) {
        theme.name = name;
      }

      var currentSlot = findThemeSlot(name) || slot;
      Object.keys(currentSlot.theme).forEach(function (key) {
        delete currentSlot.theme[key];
      });
      Object.assign(currentSlot.theme, theme);
      delete currentSlot.theme[LAZY_THEME_MARKER];
      state.lazyThemeCurrentName = name;
      return currentSlot.theme;
    }).finally(function () {
      delete state.lazyThemeFetchPending[name];
    });

    return state.lazyThemeFetchPending[name];
  }

  state.ensureThemeLoaded = ensureThemeLoaded;
  state.isThemeLoaded = isThemeLoaded;
  state.isThemeLazy = isThemeLazy;

  function makeCachedSettingsSaveResponse(cache, source) {
    var headers = new Headers(cache.headers || undefined);
    headers.set('content-type', 'application/json; charset=utf-8');
    headers.set('x-baibaoku-frontend-save-cache', source || 'hit');
    headers.set('x-baibaoku-frontend-save-cache-age-ms', String(Date.now() - cache.savedAt));
    return new Response(cache.text, {
      status: cache.status || 200,
      statusText: cache.statusText || 'OK',
      headers: headers,
    });
  }

  function makeJsonResponse(data, headers, status) {
    var responseHeaders = new Headers(headers || undefined);
    responseHeaders.set('content-type', 'application/json; charset=utf-8');
    return new Response(JSON.stringify(data), {
      status: status || 200,
      statusText: status && status >= 400 ? 'Error' : 'OK',
      headers: responseHeaders,
    });
  }

  function makeTextResponse(text, status, headers) {
    var responseHeaders = new Headers(headers || undefined);
    responseHeaders.set('content-type', 'text/plain; charset=utf-8');
    return new Response(text || '', {
      status: status || 200,
      statusText: status && status >= 400 ? 'Error' : 'OK',
      headers: responseHeaders,
    });
  }

  function hasOwn(object, key) {
    return Object.prototype.hasOwnProperty.call(object || {}, key);
  }

  function normalizeExtensionManifestBundle(bundle) {
    if (!bundle || !Array.isArray(bundle.extensions) || !bundle.manifests || typeof bundle.manifests !== 'object') {
      throw new Error('Extension manifest bundle payload is invalid');
    }

    bundle.missing = bundle.missing && typeof bundle.missing === 'object' ? bundle.missing : {};
    bundle.invalid = bundle.invalid && typeof bundle.invalid === 'object' ? bundle.invalid : {};
    return bundle;
  }

  async function fetchExtensionManifestBundle(force) {
    if (!force && state.extensionManifestBundleCache) {
      return state.extensionManifestBundleCache;
    }
    if (!force && state.extensionManifestBundlePending) {
      return state.extensionManifestBundlePending;
    }

    state.requests.extensionBundle += 1;
    state.extensionManifestBundlePending = rawFetch(EXTENSION_MANIFEST_BUNDLE, {
      method: 'GET',
      cache: 'no-store',
    }).then(async function (response) {
      if (!response || !response.ok) {
        throw new Error('Extension manifest bundle request failed: ' + (response ? response.status : 'no response'));
      }

      var bundle = normalizeExtensionManifestBundle(await response.json());
      state.extensionManifestBundleCache = bundle;
      state.lastExtensionManifestBundleAt = Date.now();
      return bundle;
    }).finally(function () {
      state.extensionManifestBundlePending = null;
    });

    return state.extensionManifestBundlePending;
  }

  async function makeExtensionDiscoverResponse() {
    var bundle = await fetchExtensionManifestBundle(false);
    return makeJsonResponse(bundle.extensions, {
      'x-baibaoku-extension-manifest-bundle': 'discover',
    });
  }

  async function makeExtensionManifestResponse(route) {
    var bundle = await fetchExtensionManifestBundle(false);
    var name = route && route.name;

    state.requests.extensionManifest += 1;
    if (hasOwn(bundle.manifests, name)) {
      return makeJsonResponse(bundle.manifests[name], {
        'x-baibaoku-extension-manifest-cache': 'hit',
        'x-baibaoku-extension-name': name,
      });
    }

    if (hasOwn(bundle.invalid, name)) {
      return makeTextResponse('Invalid manifest.json for ' + name, 500, {
        'x-baibaoku-extension-manifest-cache': 'invalid',
        'x-baibaoku-extension-name': name,
      });
    }

    return makeTextResponse('Manifest not found for ' + name, 404, {
      'x-baibaoku-extension-manifest-cache': 'missing',
      'x-baibaoku-extension-name': name,
    });
  }

  function normalizeThirdPartyExtensionName(value) {
    var name = String(value || '').replace(/\\\\/g, '/').trim();
    if (!name) return null;
    name = name.replace(/^\\/+/, '');
    if (name.indexOf('third-party/') === 0) return name;
    if (name === 'third-party') return null;
    if (name.indexOf('third-party') === 0) {
      name = name.slice('third-party'.length).replace(/^\\/+/, '');
    }
    return name ? 'third-party/' + name : null;
  }

  function encodeExtensionManifestPath(name) {
    return String(name || '')
      .split('/')
      .map(function (part) { return encodeURIComponent(part); })
      .join('/');
  }

  function addOrUpdateExtensionEntry(bundle, name, type) {
    if (!bundle || !name) return;
    var extensionType = type || 'local';
    var existing = bundle.extensions.find(function (extension) { return extension && extension.name === name; });
    if (existing) {
      existing.type = extensionType || existing.type;
      return;
    }
    bundle.extensions.push({ type: extensionType, name: name });
  }

  function removeExtensionEntry(bundle, name) {
    if (!bundle || !name) return;
    bundle.extensions = bundle.extensions.filter(function (extension) { return !extension || extension.name !== name; });
    delete bundle.manifests[name];
    delete bundle.invalid[name];
    bundle.missing[name] = {
      message: 'Extension was removed during this page session.',
      removedAt: Date.now(),
    };
  }

  async function refreshCachedExtensionManifest(name) {
    var bundle = state.extensionManifestBundleCache;
    if (!bundle || !name) return;

    state.requests.extensionManifestRefresh += 1;
    var url = '/scripts/extensions/' + encodeExtensionManifestPath(name) + '/manifest.json?baibaoku_refresh=' + Date.now();

    try {
      var response = await rawFetch(url, { method: 'GET', cache: 'no-store' });
      await updateCachedExtensionManifestFromResponse(bundle, name, response);
    } catch (error) {
      delete bundle.manifests[name];
      delete bundle.missing[name];
      bundle.invalid[name] = {
        message: error && error.message ? error.message : String(error),
        refreshedAt: Date.now(),
      };
    }
  }

  async function updateCachedExtensionManifestFromResponse(bundle, name, response) {
    delete bundle.manifests[name];
    delete bundle.missing[name];
    delete bundle.invalid[name];

    if (!response || !response.ok) {
      bundle.missing[name] = {
        status: response ? response.status : 0,
        statusText: response ? response.statusText : '',
        refreshedAt: Date.now(),
      };
      return;
    }

    try {
      var manifest = await response.json();
      if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
        throw new Error('Manifest is not a valid JSON object.');
      }
      bundle.manifests[name] = manifest;
    } catch (error) {
      bundle.invalid[name] = {
        message: error && error.message ? error.message : String(error),
        refreshedAt: Date.now(),
      };
    }
  }

  async function refreshExtensionManifestCacheAfterMutation(url, input, init, response) {
    if (!state.extensionManifestBundleCache || !response || !response.ok || !url || url.origin !== location.origin || getMethod(input, init) !== 'POST') {
      return;
    }

    var path = url.pathname;
    if (path !== '/api/extensions/install'
      && path !== '/api/extensions/delete'
      && path !== '/api/extensions/update'
      && path !== '/api/extensions/move'
      && path !== '/api/extensions/switch') {
      return;
    }

    var body = await readJsonBody(input, init) || {};
    var bundle = state.extensionManifestBundleCache;
    var name = normalizeThirdPartyExtensionName(body.extensionName);

    if (path === '/api/extensions/install') {
      var installPayload = await response.clone().json().catch(function () { return null; });
      name = normalizeThirdPartyExtensionName(installPayload && installPayload.folderName);
      if (name) {
        addOrUpdateExtensionEntry(bundle, name, body.global ? 'global' : 'local');
        await refreshCachedExtensionManifest(name);
      }
      return;
    }

    if (!name) return;

    if (path === '/api/extensions/delete') {
      removeExtensionEntry(bundle, name);
      return;
    }

    if (path === '/api/extensions/move') {
      addOrUpdateExtensionEntry(bundle, name, body.destination === 'global' ? 'global' : 'local');
      await refreshCachedExtensionManifest(name);
      return;
    }

    await refreshCachedExtensionManifest(name);
  }

  async function cacheSettingsGetResponse(response, cacheVersion) {
    var text = await response.clone().text();
    var headers = {};
    response.headers.forEach(function (value, key) {
      if (!/^content-encoding$/i.test(key) && !/^content-length$/i.test(key)) {
        headers[key] = value;
      }
    });
    var cache = {
      text: text,
      headers: headers,
      status: response.status,
      statusText: response.statusText,
      savedAt: Date.now(),
    };

    if (typeof cacheVersion === 'number' && cacheVersion !== state.settingsGetCacheVersion) {
      state.lastStaleSettingsGetCacheAt = Date.now();
      state.lastStaleSettingsGetCacheVersion = cacheVersion;
      state.lastStaleSettingsGetCurrentVersion = state.settingsGetCacheVersion;
      return null;
    }

    state.settingsGetCache = cache;
    return state.settingsGetCache;
  }

  async function cacheSettingsSaveResponse(response, saveKey) {
    var text = await response.clone().text();
    var headers = {};
    response.headers.forEach(function (value, key) {
      if (!/^content-encoding$/i.test(key) && !/^content-length$/i.test(key)) {
        headers[key] = value;
      }
    });
    var cache = {
      key: saveKey,
      text: text,
      headers: headers,
      status: response.status,
      statusText: response.statusText,
      ok: response.ok,
      skipped: response.headers.get('x-baibaoku-save-skipped') === 'true',
      savedAt: Date.now(),
    };
    if (response.ok) {
      state.settingsSaveCache = cache;
    }
    return cache;
  }

  async function getReplayBody(input, init, method) {
    if (method === 'GET' || method === 'HEAD') return undefined;
    if (init && Object.prototype.hasOwnProperty.call(init, 'body')) return init.body;
    try {
      if (input instanceof Request) return await input.clone().arrayBuffer();
    } catch (_) {}
    return undefined;
  }

  function parseJsonOrNull(text) {
    try {
      return JSON.parse(text);
    } catch (_) {
      return null;
    }
  }

  async function bodyToText(body) {
    if (body === undefined || body === null) return '';
    if (typeof body === 'string') return body;
    if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) return body.toString();
    if (typeof Blob !== 'undefined' && body instanceof Blob) return await body.text();
    if (body instanceof ArrayBuffer) return new TextDecoder().decode(body);
    if (ArrayBuffer.isView(body)) return new TextDecoder().decode(body);
    return null;
  }

  function hashStringForSaveKey(text) {
    var hash = 2166136261;
    for (var i = 0; i < text.length; i += 1) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
  }

  async function getSettingsSaveKey(body) {
    var text = await bodyToText(body);
    if (text === null) return null;
    return String(text.length) + ':' + hashStringForSaveKey(text);
  }

  async function gzipFastSaveInit(init) {
    var headers = new Headers(init.headers || undefined);
    if (isLocalOrPrivateHost(location.hostname)) return init;
    if (headers.has('content-encoding')) return init;
    if (typeof CompressionStream !== 'function') return init;

    var text = await bodyToText(init.body);
    if (text === null || !text) return init;

    try {
      var encoded = new TextEncoder().encode(text);
      var compressed = await new Response(
        new Blob([encoded]).stream().pipeThrough(new CompressionStream('gzip'))
      ).arrayBuffer();

      if (!compressed || compressed.byteLength >= encoded.byteLength) {
        return init;
      }

      headers.set('content-encoding', 'gzip');
      headers.delete('content-length');
      state.lastFastSaveCompression = {
        encoding: 'gzip',
        originalBytes: encoded.byteLength,
        compressedBytes: compressed.byteLength,
        compressedAt: Date.now(),
      };

      return {
        ...init,
        headers: headers,
        body: compressed,
      };
    } catch (error) {
      state.lastFastSaveCompressionError = error && error.message ? error.message : String(error);
      return init;
    }
  }

  function isPlainEmptyObject(value) {
    return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0;
  }

  async function readJsonBody(input, init) {
    if (init && Object.prototype.hasOwnProperty.call(init, 'body')) {
      var body = init.body;
      if (typeof body === 'string') return parseJsonOrNull(body);
      if (body && typeof body.text === 'function') return parseJsonOrNull(await body.text());
      return null;
    }

    try {
      if (input instanceof Request && !input.bodyUsed && input.body) {
        return await input.clone().json().catch(function () { return null; });
      }
    } catch (_) {}
    return null;
  }

  async function shouldUseFastRoute(route, input, init) {
    if (!route) return false;
    if (route.kind === 'extensionDiscover' || route.kind === 'extensionManifest') {
      return state.extensionManifestBundleEnabled !== false;
    }
    if (route.kind === 'version') {
      return state.versionAccelerationEnabled !== false;
    }
    if (route.kind === 'characters') {
      if (state.characterListAccelerationEnabled === false) return false;
      return isPlainEmptyObject(await readJsonBody(input, init));
    }
    if (route.kind === 'recentChats') {
      return state.recentChatListAccelerationEnabled !== false;
    }
    return state.settingsAccelerationEnabled !== false;
  }

  async function makeFastInit(input, init, method) {
    var next = {};
    if (input instanceof Request) {
      next.credentials = input.credentials;
      next.cache = input.cache;
      next.redirect = input.redirect;
      next.referrer = input.referrer;
      next.referrerPolicy = input.referrerPolicy;
      next.integrity = input.integrity;
      next.keepalive = input.keepalive;
      next.mode = input.mode;
      next.signal = input.signal;
      next.headers = new Headers(input.headers);
    }
    if (init && typeof init === 'object') {
      Object.assign(next, init);
      next.headers = new Headers(init.headers || next.headers || undefined);
    }
    next.method = method;
    next.cache = 'no-store';
    next.body = await getReplayBody(input, init, method);
    if (!next.headers) next.headers = new Headers();
    if (method !== 'GET' && method !== 'HEAD' && !next.headers.has('content-type')) {
      next.headers.set('content-type', 'application/json');
    }
    return next;
  }

  async function callOriginal(input, init) {
    state.requests.fallback += 1;
    return rawFetch(input, init);
  }

  window.fetch = async function baibaokuEarlyFetch(input, init) {
    var url = toUrl(input);
    var method = getMethod(input, init);
    var route = shouldIntercept(url, method);

    if (!await shouldUseFastRoute(route, input, init)) {
      var originalResponse = await rawFetch(input, init);
      if (originalResponse && originalResponse.ok && url && url.origin === location.origin && method === 'GET' && url.pathname === '/csrf-token') {
        void handleCsrfTokenResponse(originalResponse.clone()).catch(function (error) {
          state.requests.errors += 1;
          state.lastSettingsGetPrefetchError = error && error.message ? error.message : String(error);
        });
      }
      try {
        await refreshExtensionManifestCacheAfterMutation(url, input, init, originalResponse);
      } catch (error) {
        state.requests.errors += 1;
        state.lastExtensionManifestRefreshError = error && error.message ? error.message : String(error);
      }
      if (originalResponse && originalResponse.ok && shouldInvalidateSettingsGetCache(url, method)) {
        clearSettingsGetCache('mutation:' + url.pathname);
        if (url.pathname === '/api/settings/save') {
          clearSettingsSaveCache('mutation:' + url.pathname);
        }
      }
      return originalResponse;
    }

    try {
      if (route.kind === 'extensionDiscover') {
        return await makeExtensionDiscoverResponse();
      }

      if (route.kind === 'extensionManifest') {
        return await makeExtensionManifestResponse(route);
      }

      state.requests[route.kind] += 1;

      if (route.kind === 'get') {
        if (state.settingsGetCache) {
          state.requests.frontendCache += 1;
          return makeCachedSettingsGetResponse(state.settingsGetCache, 'hit');
        }
        if (state.settingsGetPending) {
          state.requests.frontendCache += 1;
          var pendingCache = await state.settingsGetPending;
          if (pendingCache) {
            return makeCachedSettingsGetResponse(pendingCache, 'pending');
          }
        }
      }

      var fastInit = await makeFastInit(input, init, method);

      if (route.kind === 'get') {
        if (state.lazyThemeLoadingEnabled !== false) {
          fastInit.headers.set('x-baibaoku-lazy-themes', '1');
        }
        rememberSettingsRequestHeaders(fastInit.headers);
      }

      if (route.kind === 'save') {
        var saveKey = await getSettingsSaveKey(fastInit.body);
        if (saveKey && state.settingsSavePending && state.settingsSavePending.key === saveKey) {
          state.requests.frontendCache += 1;
          state.requests.saveFrontendCache += 1;
          var pendingSaveCache = await state.settingsSavePending.promise;
          if (pendingSaveCache && pendingSaveCache.ok) {
            return makeCachedSettingsSaveResponse(pendingSaveCache, 'pending');
          }
          return callOriginal(input, init);
        }
        if (saveKey && !state.settingsSavePending && state.settingsSaveCache && state.settingsSaveCache.key === saveKey) {
          state.requests.frontendCache += 1;
          state.requests.saveFrontendCache += 1;
          return makeCachedSettingsSaveResponse(state.settingsSaveCache, 'hit');
        }

        fastInit = await gzipFastSaveInit(fastInit);
        var saveResponsePromise = rawFetch(route.fastPath, fastInit);
        if (saveKey) {
          var saveCachePromise = saveResponsePromise
            .then(function (saveResponse) {
              return cacheSettingsSaveResponse(saveResponse, saveKey);
            })
            .catch(function (error) {
              state.requests.errors += 1;
              state.lastSaveCacheError = error && error.message ? error.message : String(error);
              return null;
            })
            .finally(function () {
              if (state.settingsSavePending && state.settingsSavePending.key === saveKey) {
                state.settingsSavePending = null;
              }
            });
          state.settingsSavePending = { key: saveKey, promise: saveCachePromise };
        }

        var saveResponse = await saveResponsePromise;
        if (saveResponse && saveResponse.ok) {
          if (saveResponse.headers.get('x-baibaoku-save-skipped') !== 'true') {
            clearSettingsGetCache('save');
          }
          return saveResponse;
        }
        return callOriginal(input, init);
      }

      var response = await rawFetch(route.fastPath, fastInit);
      if (response && response.ok) {
        if (route.kind === 'get') {
          var settingsGetCacheVersion = state.settingsGetCacheVersion;
          state.settingsGetPending = cacheSettingsGetResponse(response, settingsGetCacheVersion)
            .catch(function (error) {
              state.requests.errors += 1;
              state.lastCacheError = error && error.message ? error.message : String(error);
              state.settingsGetCache = null;
              throw error;
            })
            .finally(function () {
              state.settingsGetPending = null;
            });
          var settingsGetCache = await state.settingsGetPending;
          if (!settingsGetCache) {
            return callOriginal(input, init);
          }
          return makeCachedSettingsGetResponse(settingsGetCache, 'miss');
        } else if (route.kind === 'characters') {
          var characterData = await response.clone().json().catch(function () { return null; });
          if (!Array.isArray(characterData)) {
            throw new Error('Fast character list returned a non-array payload');
          }
        } else if (route.kind === 'recentChats') {
          var recentChatData = await response.clone().json().catch(function () { return null; });
          if (!Array.isArray(recentChatData)) {
            throw new Error('Fast recent chat list returned a non-array payload');
          }
        }
        return response;
      }
      return callOriginal(input, init);
    } catch (error) {
      state.requests.errors += 1;
      state.lastError = error && error.message ? error.message : String(error);
      return callOriginal(input, init);
    }
  };
})();
`;
}

/**
 * Count tokens for a single message using the appropriate tokenizer.
 * Mimics the per-message behavior of ST's /api/tokenizers/openai/count
 * when called with a single-element array.
 * @param {string} model - Raw query model name
 * @param {string} resolvedModel - Resolved tokenizer model name
 * @param {object} msg - Single message object
 * @returns {Promise<number>} Token count for this message
 */
async function countSingleMessageBulk(model, resolvedModel, msg) {
    // 1. WebTokenizer models (claude, llama3, deepseek, qwen2, command-r/a, nemo)
    const webTokenizer = getWebTokenizer(resolvedModel);
    if (webTokenizer) {
        const instance = await getTokenizerInstanceBulk(webTokenizer);
        if (instance) return countWebTokenizerTokens(instance, [msg]);
        return guesstimateBulk(JSON.stringify([msg]));
    }

    // 2. SentencePiece models (llama, mistral, yi, gemma, jamba, nerdstash)
    const sppTokenizer = getSentencepiceTokenizer(resolvedModel);
    if (sppTokenizer) {
        return await countSentencepieceArrayTokensBulk(sppTokenizer, [msg]);
    }

    // 3. Default: tiktoken models (gpt-3.5, gpt-4, gpt-4o, o1, etc.)
    const tokensPerName = model.includes('gpt-3.5-turbo-0301') ? -1 : 1;
    const tokensPerMessage = model.includes('gpt-3.5-turbo-0301') ? 4 : 3;
    const tokensPadding = 3;
    const tokenizer = getTiktokenTokenizer(resolvedModel);

    let count = tokensPerMessage + tokensPadding;
    for (const [key, value] of Object.entries(msg)) {
        count += tokenizer.encode(String(value ?? '')).length;
        if (key === 'name') count += tokensPerName;
    }
    if (model.includes('gpt-3.5-turbo-0301')) count += 9;
    return count;
}

async function countSentencepieceArrayTokensBulk(tokenizer, array) {
    const jsonBody = array.flatMap(x => Object.values(x)).join('\n\n');
    const result = await countSentencepieceTokensBulk(tokenizer, jsonBody);
    return result.count;
}

async function countSentencepieceTokensBulk(tokenizer, text) {
    const instance = await getTokenizerInstanceBulk(tokenizer);

    if (!instance) {
        return {
            ids: [],
            count: guesstimateBulk(text),
        };
    }

    const ids = instance.encodeIds(text);
    return {
        ids,
        count: ids.length,
    };
}

async function getTokenizerInstanceBulk(tokenizer) {
    if (!tokenizer || typeof tokenizer.get !== 'function') {
        return null;
    }

    let loadPromise = tokenizerLoadPromises.get(tokenizer);
    if (!loadPromise) {
        // ST tokenizer wrappers do not share an in-flight load, so a first-page bulk
        // count can otherwise initialize the same SentencePiece model many times.
        loadPromise = Promise.resolve()
            .then(() => tokenizer.get())
            .finally(() => tokenizerLoadPromises.delete(tokenizer));
        tokenizerLoadPromises.set(tokenizer, loadPromise);
    }

    return loadPromise;
}

function guesstimateBulk(str) {
    const byteLength = Buffer.byteLength(str, 'utf8');
    return Math.ceil(byteLength / 3.35);
}

export function closeStEndpointCaches() {
    closeSaveGenerateJobs();
    fastVersionCache = null;
    fastVersionPromise = null;

    for (const userCache of settingsUserCaches.values()) {
        for (const watcher of userCache.payloadWatchers?.values() || []) {
            watcher.close();
        }
    }

    settingsUserCaches.clear();
    settingsUpdateLocks.clear();
    settingsFileCaches.clear();
    settingsSaveLocks.clear();
    settingsResponseCaches.clear();
    for (const scheduler of settingsBackupSchedulers.values()) {
        if (scheduler.timer) {
            clearTimeout(scheduler.timer);
        }
    }
    settingsBackupSchedulers.clear();
    lastBackupHashes.clear();
    cacheTmpSweepTimestamps.clear();
    fastSearchUserCaches.clear();
    fastSearchLoadLocks.clear();
    chatBackupUserCaches.clear();
    chatBackupLoadLocks.clear();
    chatBackupUpdateLocks.clear();
}

export function registerStEndpoints(router, manager) {
    registerSaveGenerateEndpoints(router);
    warmFastVersionCache();

    router.get('/v1/extensions/manifest-bundle', (req, res) => {
        try {
            res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
            res.json(buildExtensionManifestBundle(req));
        } catch (error) {
            console.error('[baibaoku] Error in extension manifest bundle endpoint:', error);
            res.status(500).json({ error: true, message: error.message });
        }
    });

    router.get('/v1/fast-version', async (req, res) => {
        try {
            const result = await getFastVersionPayload();
            res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
            setSafeHeader(res, 'X-Baibaoku-Version-Cache', result.source);
            setSafeHeader(res, 'X-Baibaoku-Version-Cache-Age-Ms', result.cacheAgeMs);
            setSafeHeader(res, 'X-Baibaoku-Version-Source-Elapsed-Ms', result.sourceElapsedMs);
            res.json(result.payload);
        } catch (error) {
            console.error('[baibaoku] Error in fast-version endpoint:', error);
            res.status(500).json({ error: true, message: error.message });
        }
    });

    router.get('/v1/early/bridge.js', async (req, res) => {
        try {
            const config = await getSettingsFastConfigSafe(req, manager);
            res.type('application/javascript; charset=utf-8');
            res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
            res.send(makeEarlyBridgeScript(config));
        } catch (error) {
            console.error('[baibaoku] Error in early bridge endpoint:', error);
            res.status(500).type('application/javascript; charset=utf-8').send(`console.error(${JSON.stringify(error.message)});`);
        }
    });

    router.post('/v1/characters/fast-all', async (req, res) => {
        try {
            const userHandle = req.user?.profile?.handle;
            if (!userHandle) {
                return res.status(401).json({ error: true, message: 'Unauthorized' });
            }

            const charactersDir = req.user.directories.characters;

            // 1. Concurrency control: if this user is already updating, wait for it
            if (!updateLocks.has(userHandle)) {
                const updatePromise = updateCacheForUser(req, manager, userHandle, charactersDir)
                    .finally(() => updateLocks.delete(userHandle));
                updateLocks.set(userHandle, updatePromise);
            }

            // 2. Await the update lock (whether we created it or someone else did)
            const cache = await updateLocks.get(userHandle);

            // 3. Return the cached data as an array, removing internal fields
            const dataArray = Array.from(cache.values()).map(item => {
                const data = { ...item.data };
                delete data._chatStats; // Remove internal chat stats
                return data;
            });
            res.json(dataArray);

        } catch (error) {
            console.error('[baibaoku] Error in fast-all endpoint:', error);
            res.status(500).json({ error: true, message: error.message });
        }
    });

    router.post('/v1/chat-backups/fast-list', async (req, res) => {
        try {
            const userHandle = req.user?.profile?.handle;
            if (!userHandle) {
                return res.status(401).json({ error: true, message: 'Unauthorized' });
            }

            if (!chatBackupUpdateLocks.has(userHandle)) {
                const updatePromise = getFastChatBackupList(req, manager)
                    .finally(() => chatBackupUpdateLocks.delete(userHandle));
                chatBackupUpdateLocks.set(userHandle, updatePromise);
            }

            const { data, metrics } = await chatBackupUpdateLocks.get(userHandle);
            setSafeHeader(res, 'X-Baibaoku-Elapsed-Ms', metrics.totalMs);
            setSafeHeader(res, 'X-Baibaoku-Backup-Total', metrics.totalFiles);
            setSafeHeader(res, 'X-Baibaoku-Backup-Valid', metrics.validFiles);
            setSafeHeader(res, 'X-Baibaoku-Backup-Invalid', metrics.invalidFiles);
            setSafeHeader(res, 'X-Baibaoku-Cache-Hits', metrics.cacheHits);
            setSafeHeader(res, 'X-Baibaoku-Cache-Misses', metrics.cacheMisses);
            setSafeHeader(res, 'X-Baibaoku-Cache-Gc', metrics.cacheGc);
            res.json(data);
        } catch (error) {
            console.error('[baibaoku] Error in fast chat backup list endpoint:', error);
            res.status(error.status || 500).json({ error: true, message: error.message });
        }
    });

    router.post('/v1/chats/fast-recent', async (req, res) => {
        try {
            const { data, metrics } = await getFastRecentChats(req);

            setSafeHeader(res, 'X-Baibaoku-Elapsed-Ms', metrics.totalMs);
            setSafeHeader(res, 'X-Baibaoku-Recent-Selected-Files', metrics.selectedFiles);
            setSafeHeader(res, 'X-Baibaoku-Recent-Character-Files', metrics.characterFiles);
            setSafeHeader(res, 'X-Baibaoku-Recent-Group-Files', metrics.groupFiles);
            setSafeHeader(res, 'X-Baibaoku-Recent-Root-Files', metrics.rootFiles);
            res.json(data);
        } catch (error) {
            console.error('[baibaoku] Error in fast-recent endpoint:', error);
            res.status(error.status || 500).json({ error: true, message: error.message });
        }
    });

    router.post('/v1/chats/fast-search', async (req, res) => {
        try {
            const { data, metrics } = await getFastSearch(req, manager);

            setSafeHeader(res, 'X-Baibaoku-Elapsed-Ms', metrics.totalMs);
            setSafeHeader(res, 'X-Baibaoku-Search-Total-Files', metrics.totalFiles);
            setSafeHeader(res, 'X-Baibaoku-Search-Valid-Files', metrics.validFiles);
            setSafeHeader(res, 'X-Baibaoku-Search-Invalid-Files', metrics.invalidFiles);
            setSafeHeader(res, 'X-Baibaoku-Search-Cache-Misses', metrics.cacheMisses);
            setSafeHeader(res, 'X-Baibaoku-Search-Cache-Gc', metrics.cacheGc);
            res.json(data);
        } catch (error) {
            if (!error.status || error.status >= 500) {
                console.error('[baibaoku] Error in fast-search endpoint:', error);
            }
            res.status(error.status || 500).json({ error: true, message: error.message });
        }
    });

    router.post('/v1/chats/fast-get', async (req, res) => {
        return res.status(410).json({
            ok: false,
            error: true,
            message: 'Progressive chat loading is disabled',
        });

        try {
            const result = await getFastChatGet(req);

            setSafeHeader(res, 'X-Baibaoku-Elapsed-Ms', result.meta.elapsedMs || 0);
            setSafeHeader(res, 'X-Baibaoku-Chat-Kind', result.kind);
            setSafeHeader(res, 'X-Baibaoku-Chat-Partial', result.meta.partial === true);
            setSafeHeader(res, 'X-Baibaoku-Chat-Total-Messages', result.meta.totalMessages || 0);
            res.json({
                ok: true,
                data: result,
            });
        } catch (error) {
            console.error('[baibaoku] Error in fast-get endpoint:', error);
            res.status(error.status || 500).json({ ok: false, error: true, message: error.message });
        }
    });

    router.get('/v1/fast-config', async (req, res) => {
        try {
            const userHandle = req.user?.profile?.handle;
            if (!userHandle) {
                return res.status(401).json({ error: true, message: 'Unauthorized' });
            }

            res.json({
                ok: true,
                data: await getSettingsFastConfig(req, manager),
            });
        } catch (error) {
            console.error('[baibaoku] Error in fast-config endpoint:', error);
            res.status(500).json({ ok: false, error: true, message: error.message });
        }
    });

    router.post('/v1/fast-config', async (req, res) => {
        try {
            const userHandle = req.user?.profile?.handle;
            if (!userHandle) {
                return res.status(401).json({ error: true, message: 'Unauthorized' });
            }

            res.json({
                ok: true,
                data: await setSettingsFastConfig(req, manager),
            });
        } catch (error) {
            console.error('[baibaoku] Error in fast-config endpoint:', error);
            res.status(500).json({ ok: false, error: true, message: error.message });
        }
    });

    router.get('/v1/settings/fast-config', async (req, res) => {
        try {
            const userHandle = req.user?.profile?.handle;
            if (!userHandle) {
                return res.status(401).json({ error: true, message: 'Unauthorized' });
            }

            res.json({
                ok: true,
                data: await getSettingsFastConfig(req, manager),
            });
        } catch (error) {
            console.error('[baibaoku] Error in settings fast-config endpoint:', error);
            res.status(500).json({ ok: false, error: true, message: error.message });
        }
    });

    router.post('/v1/settings/fast-config', async (req, res) => {
        try {
            const userHandle = req.user?.profile?.handle;
            if (!userHandle) {
                return res.status(401).json({ error: true, message: 'Unauthorized' });
            }

            res.json({
                ok: true,
                data: await setSettingsFastConfig(req, manager),
            });
        } catch (error) {
            console.error('[baibaoku] Error in settings fast-config endpoint:', error);
            res.status(500).json({ ok: false, error: true, message: error.message });
        }
    });

    router.post('/v1/settings/fast-save', async (req, res) => {
        const startedAt = Date.now();

        try {
            const userHandle = req.user?.profile?.handle;
            if (!userHandle) {
                return res.status(401).json({ error: true, message: 'Unauthorized' });
            }

            const result = await queueSettingsSave(userHandle, () => saveSettingsWithCache(req, userHandle));

            setSafeHeader(res, 'X-Baibaoku-Elapsed-Ms', Date.now() - startedAt);
            if (result.skipped) {
                setSafeHeader(res, 'X-Baibaoku-Save-Skipped', true);
            }
            res.json(result);
            scheduleSettingsResponseWarmup(req, userHandle, result.skipped ? 'fast-save-skipped' : 'fast-save');

            // Trigger backup after responding; the backup task is throttled and non-blocking.
            if (!result.skipped) {
                scheduleSettingsAutoBackup(req, userHandle);
            }
        } catch (error) {
            console.error('[baibaoku] Error in settings fast-save endpoint:', error);
            res.status(500).json({ error: true, message: error.message });
        }
    });

    router.post('/v1/themes/get', async (req, res) => {
        const startedAt = Date.now();

        try {
            const userHandle = req.user?.profile?.handle;
            if (!userHandle) {
                return res.status(401).json({ ok: false, error: true, message: 'Unauthorized' });
            }

            const name = String(req.body?.name || '').trim();
            if (!name) {
                return res.status(400).json({ ok: false, error: true, message: 'Theme name is required.' });
            }

            const result = await readThemeByName(
                getSettingsUserCache(userHandle),
                req.user.directories.themes,
                name,
            );

            if (!result) {
                return res.status(404).json({ ok: false, error: true, message: 'Theme not found.' });
            }

            setSafeHeader(res, 'X-Baibaoku-Elapsed-Ms', Date.now() - startedAt);
            setSafeHeader(res, 'X-Baibaoku-Theme-File', result.filename);
            res.json({
                ok: true,
                data: result.theme,
            });
        } catch (error) {
            console.error('[baibaoku] Error in theme get endpoint:', error);
            res.status(500).json({ ok: false, error: true, message: error.message });
        }
    });

    router.post('/v1/settings/fast-get', async (req, res) => {
        const startedAt = Date.now();

        try {
            const metrics = {};
            const userHandle = req.user?.profile?.handle;
            if (!userHandle) {
                return res.status(401).json({ error: true, message: 'Unauthorized' });
            }

            await waitForPendingSettingsSave(userHandle);
            const lazyThemes = shouldUseLazyThemeSettingsPayload(req);
            const settingsStartedAt = Date.now();
            const settingsPromise = readSettingsTextWithCache(req, userHandle)
                .then((settingsInfo) => {
                    metrics.settingsMs = Date.now() - settingsStartedAt;
                    metrics.settingsCache = settingsInfo.cacheStatus || (settingsInfo.cacheHit ? 'hit' : 'miss');
                    return settingsInfo;
                });

            let payloadStartedAt = Date.now();
            let settingsInfo;
            let cachedPayload;

            if (lazyThemes) {
                settingsInfo = await settingsPromise;
                payloadStartedAt = Date.now();
                const payloadOptions = {
                    themeMode: SETTINGS_THEME_MODE_LAZY,
                    currentThemeName: getCurrentThemeNameFromSettingsText(settingsInfo.text),
                };
                const lockKey = getSettingsUpdateLockKey(userHandle, payloadOptions);
                if (!settingsUpdateLocks.has(lockKey)) {
                    const updatePromise = getFastSettingsPayload(req, userHandle, metrics, payloadOptions)
                        .finally(() => settingsUpdateLocks.delete(lockKey));
                    settingsUpdateLocks.set(lockKey, updatePromise);
                } else {
                    metrics.payloadCache = 'shared';
                    metrics.payloadThemeMode = payloadOptions.themeMode;
                }
                cachedPayload = await settingsUpdateLocks.get(lockKey);
            } else {
                const payloadOptions = { themeMode: SETTINGS_THEME_MODE_FULL };
                const lockKey = getSettingsUpdateLockKey(userHandle, payloadOptions);
                if (!settingsUpdateLocks.has(lockKey)) {
                    const updatePromise = getFastSettingsPayload(req, userHandle, metrics, payloadOptions)
                        .finally(() => settingsUpdateLocks.delete(lockKey));
                    settingsUpdateLocks.set(lockKey, updatePromise);
                } else {
                    metrics.payloadCache = 'shared';
                    metrics.payloadThemeMode = payloadOptions.themeMode;
                }

                [settingsInfo, cachedPayload] = await Promise.all([
                    settingsPromise,
                    settingsUpdateLocks.get(lockKey),
                ]);
            }
            metrics.payloadMs = Date.now() - payloadStartedAt;
            ensureSettingsPayloadPersisted(req, userHandle);

            const staticStartedAt = Date.now();
            const staticPayload = await getStaticSettingsPayload();
            metrics.staticMs = Date.now() - staticStartedAt;

            const responseStartedAt = Date.now();
            const response = await getFastSettingsResponse(
                req,
                userHandle,
                settingsInfo,
                cachedPayload,
                staticPayload,
            );
            metrics.responseMs = Date.now() - responseStartedAt;
            metrics.responseCache = response.cacheStatus || (response.cacheHit ? 'hit' : 'miss');
            metrics.totalMs = Date.now() - startedAt;

            res.type('application/json; charset=utf-8');
            res.set('Cache-Control', 'no-cache');
            setSafeHeader(res, 'X-Baibaoku-Elapsed-Ms', metrics.totalMs);
            setSafeHeader(res, 'X-Baibaoku-Settings-Cache', metrics.settingsCache);
            setSafeHeader(res, 'X-Baibaoku-Payload-Cache', metrics.payloadCache);
            setSafeHeader(res, 'X-Baibaoku-Payload-Theme-Mode', metrics.payloadThemeMode || SETTINGS_THEME_MODE_FULL);
            if (metrics.payloadDirtyReason) {
                setSafeHeader(res, 'X-Baibaoku-Payload-Dirty-Reason', metrics.payloadDirtyReason, { maxSourceLength: 512 });
                setSafeHeader(res, 'X-Baibaoku-Payload-Dirty-Age-Ms', metrics.payloadDirtyAgeMs || 0);
            }
            setSafeHeader(res, 'X-Baibaoku-Response-Cache', metrics.responseCache);
            setSafeHeader(res, 'X-Baibaoku-Response-Encoding', response.encoding);
            res.set('Server-Timing', [
                `settings;dur=${metrics.settingsMs}`,
                `payload;dur=${metrics.payloadMs}`,
                `static;dur=${metrics.staticMs}`,
                `response;dur=${metrics.responseMs}`,
                `total;dur=${metrics.totalMs}`,
            ].join(', '));
            res.send(response.body);
        } catch (error) {
            console.error('[baibaoku] Error in settings fast-get endpoint:', error);
            res.status(500).json({ error: true, message: error.message });
        }
    });

    router.post('/v1/tokenizers/bulk-count', async (req, res) => {
        try {
            const model = String(req.body?.model || 'gpt-3.5-turbo');
            const messages = req.body?.messages;
            if (!Array.isArray(messages) || messages.length === 0) {
                return res.status(400).json({ ok: false, error: { message: 'messages must be a non-empty array' } });
            }

            const resolvedModel = getTokenizerModel(model);
            const counts = await Promise.all(messages.map(msg =>
                countSingleMessageBulk(model, resolvedModel, msg)));

            res.json({
                ok: true,
                data: {
                    counts,
                    token_count: counts.reduce((a, b) => a + b, 0),
                },
            });
        } catch (error) {
            console.error('[baibaoku] Error in bulk-count endpoint:', error);
            res.status(500).json({ ok: false, error: { message: error.message } });
        }
    });
}
