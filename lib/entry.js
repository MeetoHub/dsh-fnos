/**
 * dsh-fnos 宿主半边入口（热装载 shim）
 *
 * 真正的实现在 lib/impl.js。这里在 **每次 apply() 时** 用带时间戳的 URL 动态
 * import，用来击穿 Node 的 ESM 模块缓存：改了 impl.js / auth.js 之后，只需在插件
 * 管理器里把本行关一次再开
 *   plugin_manager set_plugin(include:dsh-fnos, enabled:false → true)
 * 就能装载新代码，**不必重启 DSH**。
 *
 * 为什么击穿必须放在 apply() 里：
 *   放在模块顶层没用 —— 本文件自身会被 ESM 缓存，而插件开/关只是重新调用 apply()，
 *   不会重新执行本文件的顶层代码。实测：顶层式击穿后 toggle，宿主跑的仍是旧 impl。
 *
 * 为什么文件名叫 entry.js 而不是 index.js：
 *   宿主进程一旦 import 过某个模块 URL，改文件内容也不会重新加载，只能换一个新 URL。
 *   需要让旧缓存一次性失效时，把 package.json 的入口指到新文件名即可（无需重启，
 *   但 package.json 变更要重新 install_bundle 才会被读到）。
 *
 * 注意：apply() 返回 Promise（cordis 会 await）。await 之后注册的 ctx.effect /
 * ctx.inject 仍然挂在当前 fiber 上 —— 实测工具与路由都能正常注册。
 */
const SELF_URL = import.meta.url

export const name = 'dsh-fnos'
export const inject = []

export function apply(ctx, config) {
  const implUrl = new URL(`./impl.js?t=${Date.now()}`, SELF_URL).href
  return import(implUrl).then((impl) => impl.apply(ctx, config))
}
