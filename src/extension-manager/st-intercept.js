import { loadConfig } from './config.js';
import { ExtensionOpError } from './errors.js';
import { checkExtensionVersion, deleteExtension, installExtension, updateExtension } from './service.js';

const ORIGINAL = Symbol.for('baibaoku.extensionRoute.original');
// 前端靠这两个头认出"这是柏宝库处理的结果",不再套用原生 git 报错的诊断
export const OP_HEADER = 'X-Baibaoku-Extension-Op';
export const ERROR_CODE_HEADER = 'X-Baibaoku-Error-Code';
const JOB_HEADER = 'x-baibaoku-job';

function isEnabled() {
    try {
        return loadConfig().interceptEnabled;
    } catch {
        return false;
    }
}

function clientJobId(req) {
    const value = typeof req.get === 'function' ? req.get(JOB_HEADER) : req.headers?.[JOB_HEADER];
    return typeof value === 'string' ? value : null;
}

// 酒馆前端把失败响应的文本直接放进提示框(会转义、不换行),所以压成一行:原因 + 建议
export function formatPlainError(error) {
    const message = String(error?.message ?? error ?? '未知错误').replace(/\s+/g, ' ').trim();
    const hint = error?.hint ? String(error.hint).replace(/\s+/g, ' ').trim() : '';
    if (!hint) return message;
    return /[。!?.!?]$/.test(message) ? `${message}${hint}` : `${message}。${hint}`;
}

function sendError(res, error) {
    if (res.headersSent) {
        res.end();
        return;
    }
    const status = Number.isInteger(error?.status) && error.status >= 400 ? error.status : 500;
    res.set(OP_HEADER, error?.opId ?? 'error');
    if (error?.code) {
        res.set(ERROR_CODE_HEADER, String(error.code));
    }
    if (!(error instanceof ExtensionOpError)) {
        console.error('[BaiBaoKu] 扩展操作出错:', error);
    }
    res.status(status).type('text/plain; charset=utf-8').send(formatPlainError(error));
}

// 安装、更新、删除:出错也不退回原生逻辑,半路换实现可能把目录弄得更乱
function jobHandler(run, send) {
    return original => async function baibaokuExtensionHandler(req, res, next) {
        if (!isEnabled()) {
            return original(req, res, next);
        }
        try {
            const outcome = await run(req, req.body, { clientId: clientJobId(req), source: 'st' });
            res.set(OP_HEADER, outcome.opId);
            send(res, outcome);
        } catch (error) {
            sendError(res, error);
        }
    };
}

function versionHandler(original) {
    return async function baibaokuExtensionVersion(req, res, next) {
        if (!isEnabled()) {
            return original(req, res, next);
        }
        // 前端切走或超时就停止探测,省得版本检查在后台占着线路
        const controller = new AbortController();
        const onClose = () => {
            if (!res.writableFinished) controller.abort();
        };
        res.once('close', onClose);
        try {
            const result = await checkExtensionVersion(req, req.body, { signal: controller.signal });
            res.set(OP_HEADER, result.baibaoku?.opId ?? 'version');
            res.send(result);
        } catch (error) {
            if (error instanceof ExtensionOpError) {
                sendError(res, error);
                return;
            }
            // 版本检查只读不写,意外出错时交还给原生逻辑,至少不比原来差
            console.warn('[BaiBaoKu] 检查扩展版本出错,改用酒馆原生逻辑:', error);
            if (!res.headersSent && !controller.signal.aborted) {
                return original(req, res, next);
            }
        } finally {
            res.off('close', onClose);
        }
    };
}

const HANDLERS = {
    '/install': jobHandler(installExtension, (res, outcome) => res.send(outcome.response)),
    '/update': jobHandler(updateExtension, (res, outcome) => res.send(outcome.response)),
    '/delete': jobHandler(deleteExtension, (res, outcome) => res.send(outcome.text)),
    '/version': versionHandler,
};

/**
 * 接管酒馆原生的扩展安装/更新/删除/检查版本接口:替换路由里的处理函数,酒馆前端不用改。
 * 返回恢复函数(插件卸载时调用)。
 */
export function interceptExtensionRoutes(router) {
    const restorers = [];
    for (const [routePath, createHandler] of Object.entries(HANDLERS)) {
        const routeLayer = router?.stack?.find(layer => layer.route?.path === routePath && layer.route.methods?.post);
        const handlerLayer = routeLayer?.route?.stack?.at(-1);
        if (typeof handlerLayer?.handle !== 'function') {
            console.warn(`[BaiBaoKu] 没找到酒馆的扩展 ${routePath} 接口,这个操作继续用原生逻辑。`);
            continue;
        }
        // 插件热重载时拿到的可能已经是上一次包过的函数
        const original = handlerLayer.handle[ORIGINAL] ?? handlerLayer.handle;
        const wrapped = createHandler(original);
        wrapped[ORIGINAL] = original;
        handlerLayer.handle = wrapped;
        restorers.push(() => {
            if (handlerLayer.handle === wrapped) {
                handlerLayer.handle = original;
            }
        });
    }
    return () => {
        for (const restore of restorers) restore();
    };
}
