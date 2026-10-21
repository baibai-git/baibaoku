// isomorphic-git 只在系统没有 git(或 config.yaml 指定 builtin)时才会用到。
// 单独动态加载:依赖没装时柏宝库仍能正常启动,系统 git 路径不受影响;
// 不要在模块顶层静态 import,否则一个可选依赖缺失就会让整个插件加载失败。
let gitPromise = null;

export function loadIsomorphicGit() {
    gitPromise ??= import('isomorphic-git').then(module => module.default);
    return gitPromise;
}
