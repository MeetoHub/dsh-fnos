/**
 * dsh-fnos 宿主半边入口（稳定 shim）
 *
 * 真正的实现在 lib/impl.js。这里在 **每次 apply() 时** 用带时间戳的 URL 动态
 * import，用来击穿 Node 的 ESM 模块缓存：改了 impl.js / auth.js 之后，只需在插件
 * 管理器里把本行关一次再开
 *   plugin_manager set_plugin(include:dsh-fnos, enabled:false → true)
 * 就能装载新代码，**不必重启 DSH**。
 *
 * 为什么击穿必须放在 apply() 里（踩过的坑）：
 *   放在模块顶层没用 —— 本文件自身 `file:///G:/fnos/lib/index.js` 会被 ESM 缓存，
 *   而插件开/关只是重新调用 apply()，不会重新执行本文件的顶层代码。
 *   实测：顶层式击穿后 toggle，宿主跑的仍是旧 impl。
 *
 * 代价：apply() 变成 async。cordis 会 await 它；apply 内部在 await 之后注册的
 * ctx.effect / ctx.inject 仍然挂在当前 fiber 上。
 *
 * 探针阶段结束后可把 impl.js 内联回本文件，去掉这一跳与 async。
 */
const SELF_URL = import.meta.url

export const name = 'dsh-fnos'
export const inject = []

export function apply(ctx, config) {
  const implUrl = new URL(`./impl.js?t=${Date.now()}`, SELF_URL).href
  return import(implUrl).then((impl) => impl.apply(ctx, config))
}
