import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { patchRegexEngineJs } from '../src/regex-bridge-installer.js';

const engineUrl = new URL('../../../public/scripts/extensions/regex/engine.js', import.meta.url);
const blockPattern = /[ \t]*\/\/ baibaoku regex bridge:start[\s\S]*?\/\/ baibaoku regex bridge:end[ \t]*\r?\n/;
const countBlocks = source => source.split('// baibaoku regex bridge:start').length - 1;

// Same shape as getRegexedString in SillyTavern 1.12–1.19, trimmed to what the patch relies on.
const fixture = (newline = '\n') => [
    "import { extension_settings } from '../../extensions.js';",
    '',
    'export function getRegexedString(rawString, placement, { characterOverride, isMarkdown, isPrompt, isEdit, depth } = {}) {',
    '    let finalString = rawString;',
    '    const allRegex = getRegexScripts();',
    '    allRegex.forEach((script) => {',
    '        if ((script.markdownOnly && isMarkdown) || (!script.markdownOnly && !isMarkdown)) {',
    '            if (script.placement.includes(placement)) {',
    '                finalString = runRegexScript(script, finalString, { characterOverride });',
    '            }',
    '        }',
    '    });',
    '',
    '    return finalString;',
    '}',
    '',
].join(newline);

function compile(source, scripts, ran) {
    const body = source.replace(/^import .*$/m, '').replace('export function', 'function');
    const runRegexScript = (script, text) => {
        ran.push(script.id);
        return `${text}+${script.id}`;
    };
    return new Function('getRegexScripts', 'runRegexScript', `${body}\nreturn getRegexedString;`)(() => scripts, runRegexScript);
}

test('inserts one bridge block before the script run, keeping indentation and line endings', () => {
    for (const newline of ['\n', '\r\n']) {
        const source = fixture(newline);
        const patched = patchRegexEngineJs(source);
        assert.equal(countBlocks(patched), 1);
        assert.match(patched, /\n {16}\/\/ baibaoku regex bridge:start\r?\n {16}let baibaokuRegexResult;/);
        assert.match(patched, /\/\/ baibaoku regex bridge:end\r?\n {16}finalString = runRegexScript\(/);
        assert.equal(newline === '\n' ? patched.includes('\r') : /(?<!\r)\n/.test(patched), false);
        assert.equal(patchRegexEngineJs(patched), patched);
        assert.equal(patched.replace(blockPattern, ''), source);
    }
});

test('skips a script only when beforeScript returns a string', () => {
    const scripts = [{ id: 'a', placement: [2], markdownOnly: true }, { id: 'b', placement: [2], markdownOnly: true }];
    const ran = [];
    const contexts = [];
    const getRegexedString = compile(patchRegexEngineJs(fixture()), scripts, ran);
    const debug = console.debug;
    console.debug = () => {};
    try {
        globalThis.__baibaokuRegexBridge = {
            beforeScript(script, text, context) {
                contexts.push(context);
                return script.id === 'a' ? text : undefined;
            },
        };
        assert.equal(getRegexedString('x', 2, { characterOverride: 'Alice', isMarkdown: true, depth: 0 }), 'x+b');
        assert.deepEqual(ran, ['b']);
        assert.deepEqual(contexts[0], { version: 1, placement: 2, isMarkdown: true, isPrompt: undefined, depth: 0, characterOverride: 'Alice' });

        globalThis.__baibaokuRegexBridge.beforeScript = () => {
            throw new Error('frontend failure');
        };
        assert.equal(getRegexedString('x', 2, { isMarkdown: true }), 'x+a+b');

        delete globalThis.__baibaokuRegexBridge;
        assert.equal(getRegexedString('x', 2, { isMarkdown: true }), 'x+a+b');
    } finally {
        console.debug = debug;
        delete globalThis.__baibaokuRegexBridge;
    }
});

test('leaves unknown sources alone and drops stale bridges', () => {
    // The injected `return` is only safe inside the per-script callback.
    const forLoop = fixture().replace('allRegex.forEach((script) => {', 'for (const script of allRegex) {').replace('    });', '    }');
    assert.equal(patchRegexEngineJs(forLoop), forLoop);

    const changedAnchor = fixture().replace('{ characterOverride });', '{ characterOverride, isMarkdown });');
    assert.equal(patchRegexEngineJs(changedAnchor), changedAnchor);

    const stale = patchRegexEngineJs(fixture()).replace('{ characterOverride });', '{ characterOverride, isMarkdown });');
    assert.equal(countBlocks(stale), 1);
    assert.equal(patchRegexEngineJs(stale), changedAnchor);
});

test('patches the installed SillyTavern regex engine', { skip: !existsSync(engineUrl) && 'public/scripts/extensions/regex/engine.js not found' }, () => {
    const source = readFileSync(engineUrl, 'utf8');
    const patched = patchRegexEngineJs(source);
    assert.equal(countBlocks(patched), 1);
    assert.equal(patchRegexEngineJs(patched), patched);
    assert.doesNotThrow(() => new vm.SourceTextModule(patched));
});
