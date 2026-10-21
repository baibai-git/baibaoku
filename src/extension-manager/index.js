import { router as stExtensionsRouter } from '../../../../src/endpoints/extensions.js';
import { killAllGitProcesses } from './git-runner.js';
import { abortAllJobs, hasRunningJobs } from './jobs.js';
import { flushOps } from './oplog.js';
import { registerExtensionManagerRoutes } from './routes.js';
import { startExtensionManager } from './service.js';
import { saveRouteStats } from './sources.js';
import { interceptExtensionRoutes } from './st-intercept.js';
import { delay } from './util.js';

const EXIT_GRACE_MS = 3000;

let restoreStRoutes = null;

export async function initExtensionManager(router) {
    registerExtensionManagerRoutes(router);
    try {
        // 酒馆加载完插件才开始接请求,这里清理临时目录不会和安装任务撞上
        await startExtensionManager();
    } catch (error) {
        console.warn('[BaiBaoKu] 扩展管理启动清理失败:', error?.message ?? error);
    }
    restoreStRoutes?.();
    restoreStRoutes = interceptExtensionRoutes(stExtensionsRouter);
}

export async function closeExtensionManager() {
    restoreStRoutes?.();
    restoreStRoutes = null;
    abortAllJobs();
    // 给被中断的任务一点时间收尾(恢复文件、写操作记录)
    for (let waited = 0; hasRunningJobs() && waited < EXIT_GRACE_MS; waited += 100) {
        await delay(100);
    }
    killAllGitProcesses();
    saveRouteStats();
    await flushOps();
}
