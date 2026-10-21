// 主代码,由根目录 index.js 在自更新之后加载;插件信息 info 在 index.js 里。
import { registerApi } from './api.js';
import { DatabaseManager } from './database.js';
import { VectorStore } from './vector-store.js';
import { installEarlyBridge } from './early-bridge-installer.js';
import { closeExtensionManager, initExtensionManager } from './extension-manager/index.js';
import { installOpenAITokenizerBridge } from './openai-tokenizer-bridge-installer.js';
import { installRegexBridge } from './regex-bridge-installer.js';
import { installThemeBridge } from './theme-bridge-installer.js';
import { installWorldInfoTokenizerBridge } from './world-info-tokenizer-bridge-installer.js';
import { closeStEndpointCaches } from './st-endpoints.js';

const manager = new DatabaseManager();
const vectorStore = new VectorStore(manager);

export async function init(router) {
    registerApi(router, manager, vectorStore);
    await initExtensionManager(router);
    installEarlyBridge();
    installOpenAITokenizerBridge();
    installWorldInfoTokenizerBridge();
    installThemeBridge();
    installRegexBridge();
}

export async function exit() {
    try {
        await closeExtensionManager();
    } catch (error) {
        console.warn('[BaiBaoKu] 关闭扩展管理失败:', error?.message ?? error);
    }
    closeStEndpointCaches();
    manager.closeAll();
}
