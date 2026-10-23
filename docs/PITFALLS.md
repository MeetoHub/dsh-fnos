# 开发踩坑记录

这些都是实际调试中撞出来的。改代码前建议先读一遍 —— 有几条是**会导致崩溃或数据丢失**的。

---

## 1. Loader 行的 `name` 必须等于包名

`dsh-client-modules` 只把浏览器半边挂在「说明符恰为包名」的那一行上。

用别名 → **宿主正常、界面静默消失**，且没有任何报错。极难排查。

## 2. 行 `id` 不能与官方插件冲突

官方已有 `@tnnevol/dsh-fnos`，如果 `id` 撞了，你的行**根本不会创建**，表现为所有路由 404。

本项目用 `dsh-fnos-remote` 规避。

## 3. `ctx.setInterval` 不可用

`timer` 不在插件的 `inject` 列表里，调用会抛：

```
cannot get property "timer" without inject
```

替代方案：用全局 `setTimeout` / `setInterval` + `ctx.effect` 做清理。

## 4. 普通 `spawn` 拿不到 `trim-cli` 的 stdout

Windows 实测：`subprocess.spawn` 下 stdout 为空。`trim-cli` 按终端行为输出，**只有拿到 TTY 才会写结果**。

必须用 `ctx.subprocess.spawnTerminal` 分配真终端。授权（login）同理。

## 5. `insertReference` 支持零宽 span

不需要先打一个 `/` 做锚点。官方自己的 `insertFileReferences` 就是 `{ start: at, end: at }`。

会拒绝零宽的是 `consumeToken`，不是 `insertReference`。

## 6. 组件不能直接引用 `apply` 的 `ctx`

组件在模块作用域，`apply` 的 `ctx` 在那个作用域里不可见。

正确做法：

```js
ctx.slots.register({ inject: (sessionId) => ({ ctx, sessionId }) }, Component)
```

## 7. `handle.done` 不能用来判断登录成败

`trim-cli` 授权成功后**不打印成功文案**，直接静默退出（exit=0）；失败也可能 exit=0。

唯一可信的判据是 `system info` 能否取到设备数据 —— 见 `lib/auth.js` 的 `submit()`。

## 8. PTY 会把授权 URL 按终端宽度折行

匹配前必须先去换行（`\r\n|\r|\n`），否则只能拿到第一段（约 140 字符），导致授权页报「参数异常」。

## 9. `spawnTerminal` 的代价被严重低估 ★最严重的一次事故

两个独立问题叠加，实测主进程涨到 **5900+ 句柄 / 377 线程 / 2.6 GB** 并反复崩溃。

### (a) 调度重叠（放大器）

`setInterval` 驱动 async tick，无法 await。单轮刷 10 条 × 单次 1–3 秒 = 10–30 秒，
超过 20 秒间隔后轮次重叠，每轮新增 10 个 PTY 且旧的未回收。

**修法**：自调度（上一轮结束才排下一轮）+ 每轮只做 1 条。
实测：句柄增速 `+329/60s` → `+38/60s`。

### (b) 每次调用固定残留约 11 句柄（真凶）

即使串行调用、`terminate()` 已 await、监听已解除、`done` 已落定，**单次 `spawnTerminal` 仍会留下句柄和线程**。

所以只要还在频繁 spawn，泄漏就还在 —— 只修调度只能减缓约 9 倍。

**修法**：减少 spawn 本身。后台刷新默认关闭（`FNO_BACKGROUND_REFRESH=1` 才开），
预热跳过已缓存目录（装载时 spawn 从 44 次降到 0，耗时 156s → 3.5s）。

实测：150 秒净增 **+13 句柄 / −2 线程 / −97 MB**（噪音级，GC 正常回收）。

### 附带教训

- `Promise.race` + 裸 `setTimeout` 会留下悬挂定时器（闭包还拖住终端句柄）→ 用可清除的 `settlesWithin()`
- `terminate()` 之后还要解监听、等 `done` 落定

## 10. 后台刷新要先判授权

未授权时每轮都会 spawn 一个注定失败的终端，纯浪费。

授权结果记忆 60 秒即可，不必每轮校验。

---

## 排查工具

| 想查什么 | 怎么做 |
|---|---|
| 宿主侧日志 | `%TEMP%\dsh-fnos-trace.log` 或 `<包>/.probe/trace.log` |
| 服务可用性 | `GET /fnos/probe` |
| 句柄/线程泄漏 | `Get-Process 'DeepSeek Harness' \| Sort-Object Handles -Descending \| Select -First 1` |
| 重新装载 | 插件管理器里关一次再开（`lib/entry.js` 会带时间戳重新 import，击穿 ESM 缓存） |
