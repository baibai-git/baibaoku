import { registerApi } from './src/api.js';
import { PLUGIN_ID, PLUGIN_NAME } from './src/constants.js';
import { DatabaseManager } from './src/database.js';
import { VectorStore } from './src/vector-store.js';
import { installEarlyBridge } from './src/early-bridge-installer.js';
import { installOpenAITokenizerBridge } from './src/openai-tokenizer-bridge-installer.js';
import { installRegexBridge } from './src/regex-bridge-installer.js';
import { installThemeBridge } from './src/theme-bridge-installer.js';
import { installWorldInfoTokenizerBridge } from './src/world-info-tokenizer-bridge-installer.js';
import { closeStEndpointCaches } from './src/st-endpoints.js';

export const info = {
    id: PLUGIN_ID,
    name: PLUGIN_NAME,
    description: 'A universal per-user KV storage server plugin for SillyTavern extensions.',
};

const manager = new DatabaseManager();
const vectorStore = new VectorStore(manager);

export async function init(router) {
    registerApi(router, manager, vectorStore);
    installEarlyBridge();
    installOpenAITokenizerBridge();
    installWorldInfoTokenizerBridge();
    installThemeBridge();
    installRegexBridge();
}

export async function exit() {
    closeStEndpointCaches();
    manager.closeAll();
}
