import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sync as writeFileAtomicSync } from 'write-file-atomic';

const BEGIN_MARKER = '// baibaoku regex bridge:start';
const END_MARKER = '// baibaoku regex bridge:end';
const BRIDGE_BLOCK_PATTERN = new RegExp(
    String.raw`[ \t]*${escapeRegExp(BEGIN_MARKER)}[\s\S]*?${escapeRegExp(END_MARKER)}[ \t]*(?:\r?\n)?`,
    'g',
);
const FUNCTION_ANCHOR = 'function getRegexedString(';
const SCRIPT_LOOP_ANCHOR = '.forEach((script) => {';
const SCRIPT_RUN_PATTERN = /^([ \t]*)finalString = runRegexScript\(script, finalString, \{ characterOverride \}\);/m;

export function installRegexBridge() {
    const enginePath = getRegexEnginePath();

    try {
        const originalSource = fs.readFileSync(enginePath, 'utf8');
        const patchedSource = patchRegexEngineJs(originalSource);

        if (patchedSource === originalSource) {
            if (hasRegexBridge(originalSource)) {
                console.log('[baibaoku] Regex bridge is already installed in public/scripts/extensions/regex/engine.js.');
            } else {
                console.warn('[baibaoku] Regex bridge was not installed: public/scripts/extensions/regex/engine.js did not match known anchors.');
            }
            return { changed: false, path: enginePath };
        }

        writeFileAtomicSync(enginePath, patchedSource, 'utf8');
        if (hasRegexBridge(patchedSource)) {
            console.log('[baibaoku] Installed regex bridge into public/scripts/extensions/regex/engine.js.');
        } else {
            console.warn('[baibaoku] Removed stale regex bridge: public/scripts/extensions/regex/engine.js did not match known anchors.');
        }

        return { changed: true, path: enginePath };
    } catch (error) {
        console.warn('[baibaoku] Failed to install regex bridge into public/scripts/extensions/regex/engine.js:', error.message);
        return { changed: false, path: enginePath, error };
    }
}

/**
 * Lets the frontend decide per script before getRegexedString runs it.
 * A string returned by globalThis.__baibaokuRegexBridge.beforeScript() becomes the result for that script
 * (returning the input unchanged skips it); anything else runs the script as usual.
 * The injected `return` ends the per-script forEach callback, so the bridge is only installed when the
 * anchor sits inside that callback.
 */
export function patchRegexEngineJs(source) {
    const newline = source.includes('\r\n') ? '\r\n' : '\n';
    const cleanedSource = source.replace(BRIDGE_BLOCK_PATTERN, '');
    const functionStart = cleanedSource.indexOf(FUNCTION_ANCHOR);

    if (functionStart === -1) {
        return cleanedSource;
    }

    const functionSource = cleanedSource.slice(functionStart);
    const functionEnd = functionSource.indexOf(`${newline}}`);
    const match = SCRIPT_RUN_PATTERN.exec(functionSource);

    if (!match
        || functionEnd === -1
        || match.index > functionEnd
        || !functionSource.slice(0, match.index).includes(SCRIPT_LOOP_ANCHOR)) {
        return cleanedSource;
    }

    const indent = match[1];
    const bridgeBlock = [
        `${indent}${BEGIN_MARKER}`,
        `${indent}let baibaokuRegexResult;`,
        `${indent}try {`,
        `${indent}    baibaokuRegexResult = globalThis.__baibaokuRegexBridge?.beforeScript?.(script, finalString, { version: 1, placement, isMarkdown, isPrompt, depth, characterOverride });`,
        `${indent}} catch (error) {`,
        `${indent}    console.debug('[baibaoku] regex bridge failed', error);`,
        `${indent}}`,
        `${indent}if (typeof baibaokuRegexResult === 'string') {`,
        `${indent}    finalString = baibaokuRegexResult;`,
        `${indent}    return;`,
        `${indent}}`,
        `${indent}${END_MARKER}`,
    ].join(newline) + newline;
    const insertAt = functionStart + match.index;

    return cleanedSource.slice(0, insertAt) + bridgeBlock + cleanedSource.slice(insertAt);
}

function getRegexEnginePath() {
    const pluginDir = path.dirname(fileURLToPath(import.meta.url));
    const sillyTavernRoot = path.resolve(pluginDir, '..', '..', '..');

    return path.join(sillyTavernRoot, 'public', 'scripts', 'extensions', 'regex', 'engine.js');
}

function hasRegexBridge(source) {
    return source.includes(BEGIN_MARKER) && source.includes(END_MARKER);
}

function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
