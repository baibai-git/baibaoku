// 入口薄壳:先限时检查并更新柏宝库自己(self-update.js),再加载 src/plugin.js 里的主代码。
// 这个文件和 self-update.js 只能 import Node 内置模块和酒馆自己的模块,不能 import src/ 下的任何文件:
// 否则更新前旧版模块就进了 ESM 缓存,更新后会和新代码混着跑。
// 这两个文件自己的改动要再重启一次才生效,所以文件位置和 info/init/exit 的约定保持不变。
import { runSelfUpdate } from './self-update.js';

export const info = {
    id: 'baibaoku',
    name: '柏宝库',
    description: 'A universal per-user KV storage server plugin for SillyTavern extensions.',
};

let plugin = null;

export async function init(router) {
    await runSelfUpdate();
    plugin = await import('./src/plugin.js');
    await plugin.init(router);
}

export async function exit() {
    await plugin?.exit();
}
