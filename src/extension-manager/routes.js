import { toHttpError } from '../errors.js';
import { ExtensionOpError } from './errors.js';
import {
    checkExtensionVersion,
    cleanResiduals,
    deleteExtension,
    getJobForRequest,
    getJobsForRequest,
    getManagerConfig,
    getManagerStatus,
    getOpForRequest,
    installExtension,
    listOpsForRequest,
    listResiduals,
    testRoutes,
    updateExtension,
    updateManagerConfig,
} from './service.js';

const JOB_HEADER = 'x-baibaoku-job';

function route(handler) {
    return async (req, res) => {
        try {
            await handler(req, res);
        } catch (error) {
            const httpError = toHttpError(error);
            if (res.headersSent) {
                res.end();
                return;
            }
            res.status(httpError.status).json({
                ok: false,
                error: {
                    code: httpError.code,
                    message: httpError.message,
                    hint: error instanceof ExtensionOpError ? error.hint : null,
                    stage: error instanceof ExtensionOpError ? error.stage : null,
                    opId: error?.opId ?? null,
                    details: httpError.details,
                },
            });
        }
    };
}

function sendOk(res, data) {
    res.json({ ok: true, data });
}

function operationOptions(req) {
    const header = req.get(JOB_HEADER);
    return { clientId: typeof header === 'string' ? header : null, source: 'panel' };
}

/**
 * 柏宝箱用的接口:「插件安装优化」开关、任务进度、失败详情;线路测试、残留目录、操作记录没有界面,留着排查问题用。
 * 安装/更新/删除和接管后的酒馆原生接口走同一套逻辑、同一个任务队列。
 */
export function registerExtensionManagerRoutes(router) {
    router.get('/v1/extensions/manager/status', route(async (req, res) => {
        sendOk(res, await getManagerStatus(req));
    }));

    router.get('/v1/extensions/manager/config', route(async (req, res) => {
        sendOk(res, getManagerConfig(req));
    }));

    router.post('/v1/extensions/manager/config', route(async (req, res) => {
        sendOk(res, await updateManagerConfig(req, req.body));
    }));

    router.post('/v1/extensions/install', route(async (req, res) => {
        const outcome = await installExtension(req, req.body, operationOptions(req));
        sendOk(res, { ...outcome.response, opId: outcome.opId });
    }));

    router.post('/v1/extensions/update', route(async (req, res) => {
        const outcome = await updateExtension(req, req.body, operationOptions(req));
        sendOk(res, { ...outcome.response, opId: outcome.opId });
    }));

    router.post('/v1/extensions/delete', route(async (req, res) => {
        const outcome = await deleteExtension(req, req.body, operationOptions(req));
        sendOk(res, outcome.response);
    }));

    router.post('/v1/extensions/version', route(async (req, res) => {
        const controller = new AbortController();
        const onClose = () => {
            if (!res.writableFinished) controller.abort();
        };
        res.once('close', onClose);
        try {
            const result = await checkExtensionVersion(req, req.body, {
                includeRemoteManifest: Boolean(req.body?.includeRemoteManifest),
                signal: controller.signal,
            });
            sendOk(res, result);
        } finally {
            res.off('close', onClose);
        }
    }));

    router.get('/v1/extensions/jobs', route(async (req, res) => {
        sendOk(res, getJobsForRequest(req, req.query.ids));
    }));

    router.get('/v1/extensions/jobs/:id', route(async (req, res) => {
        sendOk(res, getJobForRequest(req, req.params.id));
    }));

    router.post('/v1/extensions/routes/test', route(async (req, res) => {
        sendOk(res, await testRoutes(req, req.body));
    }));

    router.get('/v1/extensions/residuals', route(async (req, res) => {
        sendOk(res, await listResiduals(req));
    }));

    router.post('/v1/extensions/residuals/clean', route(async (req, res) => {
        sendOk(res, await cleanResiduals(req, req.body));
    }));

    router.get('/v1/extensions/ops', route(async (req, res) => {
        sendOk(res, listOpsForRequest(req, req.query));
    }));

    router.get('/v1/extensions/ops/:id', route(async (req, res) => {
        sendOk(res, getOpForRequest(req, req.params.id));
    }));
}
