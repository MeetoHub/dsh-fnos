/**
 * dsh-fnos 宿主半边实现（探针版）
 *
 * 由 lib/index.js 以带时间戳的 URL 动态 import，因此改本文件后只需
 * set_plugin 关/开一次即可重新装载，无需重启 DSH。
 *
 * 本文件是 M0+M1 只读探针：只探测、不改状态。
 *
 * 关键修正（相对初版）：
 *   - ctx.terminals 在插件上下文里不可用；改用 ctx.subprocess.spawnTerminal，
 *     它是宿主唯一的"真终端"原语（SubprocessTerminalHandle: write/inspectForeground/…）。
 *   - apply() 执行时机很早（实测 Object.keys(ctx) === ['fiber']），
 *     因此所有服务都用 ctx.get() 在**请求时**取，而不是在 apply 时取。
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// auth.js 也走带时间戳的动态 import，保证改授权逻辑同样能热装载
const { createAuthManager } = await import(new URL(`./auth.js?t=${Date.now()}`, import.meta.url).href)

export const name = 'dsh-fnos'
export const inject = []

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const PROBE_DIR = join(PACKAGE_ROOT, '.probe')
const TRACE_TMP = join(tmpdir(), 'dsh-fnos-trace.log')
// ⚠️ 不要再挂到 /plugins/dsh-fnos/ 下：
// 声明 dsh.client 之后 clientModules 会占用 /plugins/<id>/* 来分发前端产物，
// 把子路径截走 —— 实测 /plugins/dsh-fnos/auth/status 返回空 404、start 返回 405，
// 而 /plugins/dsh-fnos/auth/ 反而能进到自己的 handler。
// 挪到独立命名空间后恢复正常。
const ROUTE_PATH = '/fnos/probe'
const AUTH_ROUTE_PREFIX = '/fnos/auth/'
const FILES_ROUTE = '/fnos/files'
const SKILL_DIR = PACKAGE_ROOT
const TERM_GRACE_MS = 5_000
// 实测：uid 1000 是你的个人目录；@team 目前为空（还没建团队文件夹）
const MY_FOLDER = '/vol1/1000'
const TEAM_FOLDER = '/vol1/@team'
/** 目录缓存有效期；后台定时刷新间隔。 */
const DIR_CACHE_TTL_MS = 60_000
/**
 * 后台刷新间隔：20 秒（按用户要求）。
 * 前端读取一律走内存，所以刷新频率不影响打开速度。
 */
const DIR_REFRESH_INTERVAL_MS = 20_000
/** 落盘文件：跨 DSH 重启保留，冷启动也能秒开。 */
const CACHE_FILE = join(PACKAGE_ROOT, '.cache', 'dirtree.json')
/** 后台预热：从两个根往下走几层，限制每层目录数，避免把 NAS 打爆。 */
const WARM_DEPTH = 2
const WARM_MAX_DIRS_PER_LEVEL = 30
/** 缓存条目上限（超出按最久未更新淘汰），防止长期运行内存增长。 */
const MAX_ENTRIES = 400

/** 本包自带的 trim-cli。 */
function cliPath() {
  const bin = join(PACKAGE_ROOT, 'bin')
  if (process.platform === 'win32') {
    return join(bin, process.arch === 'arm64' ? 'trim-cli-windows-arm64.exe' : 'trim-cli-windows-x64.exe')
  }
  if (process.platform === 'darwin') {
    return join(bin, process.arch === 'arm64' ? 'trim-cli-darwin-arm64' : 'trim-cli-darwin-x64')
  }
  return join(bin, process.arch === 'arm64' ? 'trim-cli-linux-arm64' : 'trim-cli-linux-x64')
}

/** 清掉 ANSI 转义与终端标题序列，否则 JSON 解析会失败。 */
const ANSI_RE = /\x1B\[[0-9;?]*[ -\/]*[@-~]|\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)|\x1B[@-Z\\-_]/g
function stripAnsi(text) {
  return String(text ?? '').replace(ANSI_RE, '')
}

/**
 * 跑一条 trim-cli 命令并返回 stdout。
 *
 * ⚠️ 必须用 spawnTerminal（真终端），不能用普通 spawn：
 * 实测普通 spawn 下 trim-cli 的 stdout 是空的 —— 它按终端行为输出，
 * 只有拿到 TTY 才会把结果写出来。login 同理。
 */
async function runCli(ctx, args, profile = 'home') {
  const subprocess = ctx.get('subprocess')
  if (!subprocess) throw new Error('subprocess 不可用')
  const handle = await subprocess.spawnTerminal({
    argv: [cliPath(), '--profile', profile, ...args],
    cwd: PACKAGE_ROOT,
    rows: 40,
    cols: 140,
    terminalType: 'xterm-256color',
    graceMs: TERM_GRACE_MS,
  })
  let buf = ''
  try { handle.output?.setEncoding?.('utf8') } catch { /* 忽略 */ }
  handle.output?.on?.('data', (c) => { buf += String(c) })
  await Promise.race([handle.done.catch(() => null), delay(20_000)])
  try { await handle.terminate() } catch { /* 忽略 */ }
  return stripAnsi(buf)
}

/**
 * 后台预热：从两个根出发做**有界** BFS（限制层数与每层目录数）。
 * 目的是让常用路径提前进缓存，而不是递归扫全盘 —— 大 NAS 全量遍历会把设备打爆。
 */
async function warmTree(ctx, cache) {
  const seen = new Set()
  let frontier = [MY_FOLDER, TEAM_FOLDER]
  for (let depth = 0; depth <= WARM_DEPTH && frontier.length > 0; depth += 1) {
    const next = []
    for (const p of frontier) {
      if (seen.has(p)) continue
      seen.add(p)
      try {
        const text = await runCli(ctx, ['file', 'ls', p])
        let items = []
        try { items = JSON.parse(text) } catch { continue }
        if (!Array.isArray(items)) continue
        const dirs = items
          .filter((i) => i && i.dir === 1)
          .map((i) => ({ name: String(i.name), dir: true }))
        const files = items
          .filter((i) => i && i.dir !== 1)
          .map((i) => ({ name: String(i.name), dir: false, size: typeof i.size === 'number' ? i.size : 0 }))
        const idx = p.lastIndexOf('/')
        cache.set(p, { ok: true, path: p, parent: idx > 0 ? p.slice(0, idx) : null, dirs, files })
        if (depth < WARM_DEPTH) {
          for (const d of dirs.slice(0, WARM_MAX_DIRS_PER_LEVEL)) {
            next.push(p.replace(/\/$/, '') + '/' + d.name)
          }
        }
      } catch { /* 单目录失败继续 */ }
    }
    frontier = next
  }
}

/**
 * 目录浏览接口：GET /fnos/files?path=/vol1/1000
 * 返回 { ok, path, parent, dirs, files } —— 供输入框的选择浮层使用。
 */
function makeFilesHandler(ctx, cache) {
  return async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const path = url.searchParams.get('path') || MY_FOLDER
    const fresh = url.searchParams.get('fresh') === '1'

    // 缓存优先（stale-while-revalidate）：
    //   未过期        → 直接返回
    //   过期但有旧值  → **也先返回旧值**（快！标 stale），后台刷新会补上
    //   完全没有      → 才去实时拉
    // 因为后台每 20 秒轮转刷新，旧值最多偏差一两分钟，但打开永远是毫秒级。
    if (!fresh) {
      const hit = cache.get(path)
      if (hit) return json(res, 200, { ...hit, cached: true })
      const stale = cache.peek(path)
      if (stale) return json(res, 200, { ...stale, cached: true, stale: true })
    }

    try {
      const text = await runCli(ctx, ['file', 'ls', path])
      let items = []
      try { items = JSON.parse(text) } catch { /* 非 JSON：当成空 */ }
      if (!Array.isArray(items)) items = []
      const dirs = items
        .filter((i) => i && i.dir === 1)
        .map((i) => ({ name: String(i.name), dir: true }))
      const files = items
        .filter((i) => i && i.dir !== 1)
        .map((i) => ({ name: String(i.name), dir: false, size: typeof i.size === 'number' ? i.size : 0 }))
      // 父目录：去掉最后一段
      const idx = path.lastIndexOf('/')
      const parent = idx > 0 ? path.slice(0, idx) : null
      const payload = { ok: true, path, parent, dirs, files }
      cache.set(path, payload)
      return json(res, 200, { ...payload, cached: false })
    } catch (error) {
      // 出错时兜底：有旧缓存就先用旧的
      const stale = cache.peek(path)
      if (stale) return json(res, 200, { ...stale, cached: true, stale: true })
      return json(res, 500, { ok: false, error: describeError(error), path })
    }
  }
}

/**
 * 目录缓存：内存 Map + TTL + 落盘。
 *
 * 为什么这么存（性能取舍）：
 *   - 读取一律走内存 Map → 前端打开文件树是纯内存查询，毫秒级，不碰 NAS。
 *   - 后台每 20 秒刷新一次，顺带把整张表**整体覆盖写**一个 JSON 文件（不做增量追加，
 *     避免文件碎片和解析成本；几十 KB 全量覆盖比维护索引更划算）。
 *   - 插件启动时先把 JSON 读回内存 → DSH 重启后也能立刻打开，不用等 NAS 预热。
 *
 *   get(path)   未过期才返回
 *   peek(path)  不管过不过期都返回（接口报错时兜底）
 *   tick()      后台刷新：先刷新已缓存路径，再落盘
 *   load()      启动时从磁盘恢复
 */
function createDirCache(ttlMs, refresh) {
  const store = new Map()

  const get = (path) => {
    const e = store.get(path)
    if (!e) return null
    if (Date.now() - e.at > ttlMs) return null
    return e.payload
  }
  const peek = (path) => {
    const e = store.get(path)
    return e ? e.payload : null
  }
  const set = (path, payload) => {
    store.set(path, { at: Date.now(), payload })
    // 容量上限：超了就淘汰最久未更新的条目，避免长期运行后内存无限涨
    if (store.size > MAX_ENTRIES) {
      let oldestKey = null
      let oldestAt = Infinity
      for (const [k, v] of store) {
        if (v.at < oldestAt) { oldestAt = v.at; oldestKey = k }
      }
      if (oldestKey !== null) store.delete(oldestKey)
    }
  }

  /** 整体覆盖写到磁盘。失败静默（缓存不该影响主流程）。 */
  const save = () => {
    try {
      mkdirSync(dirname(CACHE_FILE), { recursive: true })
      const obj = {}
      for (const [k, v] of store) obj[k] = v
      writeFileSync(CACHE_FILE, JSON.stringify(obj), 'utf8')
    } catch { /* 忽略 */ }
  }

  /** 启动时从磁盘恢复（不校验 TTL：旧数据仍可秒开，随后会被 20s 刷新覆盖）。 */
  const load = () => {
    try {
      const raw = readFileSync(CACHE_FILE, 'utf8')
      const obj = JSON.parse(raw)
      let n = 0
      for (const [k, v] of Object.entries(obj)) {
        if (v && v.payload) { store.set(k, v); n += 1 }
      }
      return n
    } catch { return 0 }
  }

  /**
   * 后台刷新：**轮转**刷新，每次只处理一批。
   *
   * 为什么轮转：每次列目录都要走真终端（spawnTerminal ≈ 1–3 秒），
   * 如果缓存有上百条路径，20 秒内根本刷不完，定时器会堆积。
   * 所以每轮只刷 MAX_PER_TICK 条，用游标轮着来 —— 保证每轮都能在间隔内结束，
   * 且所有已缓存路径都会在一定周期内被刷新到。
   */
  let cursor = 0
  const MAX_PER_TICK = 10
  const tick = async () => {
    const all = Array.from(store.keys())
    for (const p of [MY_FOLDER, TEAM_FOLDER]) if (!all.includes(p)) all.push(p)
    if (all.length === 0) return

    // 从游标处取一批（环形）
    const batch = []
    for (let i = 0; i < Math.min(MAX_PER_TICK, all.length); i += 1) {
      batch.push(all[(cursor + i) % all.length])
    }
    cursor = (cursor + batch.length) % all.length

    for (const p of batch) {
      try { await refresh(p) } catch { /* 单个失败不影响其它 */ }
    }
    save()
  }

  return { get, peek, set, tick, load, save, size: () => store.size }
}

function trace(line) {
  const text = `[${new Date().toISOString()}] ${line}\n`
  for (const target of [TRACE_TMP, join(PROBE_DIR, 'trace.log')]) {
    try {
      mkdirSync(dirname(target), { recursive: true })
      appendFileSync(target, text, 'utf8')
    } catch {
      /* 换下一个落点 */
    }
  }
}

trace(`impl imported  pid=${process.pid}  packageRoot=${PACKAGE_ROOT}`)

function describeError(error) {
  if (error === null || error === undefined) return 'unknown error'
  return `${error?.name ?? 'Error'}: ${error?.message ?? String(error)}`
}

function safe(fn) {
  try {
    return { ok: true, value: fn() }
  } catch (error) {
    return { ok: false, error: describeError(error) }
  }
}

async function safeAsync(fn) {
  try {
    return { ok: true, value: await fn() }
  } catch (error) {
    return { ok: false, error: describeError(error) }
  }
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 本包自带的 trim-cli（按平台挑）。 */
function defaultCliPath() {
  const bin = join(PACKAGE_ROOT, 'bin')
  if (process.platform === 'win32') {
    return join(bin, process.arch === 'arm64' ? 'trim-cli-windows-arm64.exe' : 'trim-cli-windows-x64.exe')
  }
  if (process.platform === 'darwin') {
    return join(bin, process.arch === 'arm64' ? 'trim-cli-darwin-arm64' : 'trim-cli-darwin-x64')
  }
  return join(bin, process.arch === 'arm64' ? 'trim-cli-linux-arm64' : 'trim-cli-linux-x64')
}

const SERVICE_KEYS = [
  'terminals', 'subprocess', 'webServer', 'skills', 'tools', 'agents',
  'credentials', 'authorization', 'userQuestions', 'jobs',
  'storage', 'storageDomain', 'clientModules', 'systemPrompt', 'commands', 'web',
]

function collectServices(ctx) {
  const out = {}
  for (const key of SERVICE_KEYS) {
    const probe = safe(() => ctx.get(key))
    out[key] = probe.ok ? probe.value !== undefined && probe.value !== null : `ERR ${probe.error}`
  }
  return out
}

function collectOwnerCandidates(ctx) {
  const agents = ctx.get('agents')
  if (!agents) return []
  const candidates = []
  const ci = safe(() => agents.currentInitiator?.())
  if (ci.ok && ci.value?.id) candidates.push({ source: 'currentInitiator', id: String(ci.value.id) })
  for (const source of ['roots', 'list']) {
    const got = safe(() => agents[source]?.() ?? [])
    if (got.ok) for (const agent of got.value) if (agent?.id) candidates.push({ source, id: String(agent.id) })
  }
  return candidates
}

function baseReport(ctx) {
  const subprocess = ctx.get('subprocess')
  return {
    plugin: {
      name,
      packageRoot: PACKAGE_ROOT,
      cliPath: defaultCliPath(),
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      pid: process.pid,
    },
    services: collectServices(ctx),
    subprocess: subprocess
      ? {
        available: true,
        hasSpawnTerminal: typeof subprocess.spawnTerminal === 'function',
        hasSpawn: typeof subprocess.spawn === 'function',
        terminalEnvironment: safe(() => subprocess.terminalEnvironment?.())?.value ?? null,
      }
      : { available: false },
    owners: collectOwnerCandidates(ctx),
  }
}

/** 把 handle.output 收成字符串，返回一个读取器。 */
function collectOutput(handle) {
  let text = ''
  try {
    handle.output?.setEncoding?.('utf8')
    handle.output?.on?.('data', (chunk) => { text += String(chunk) })
  } catch (error) {
    trace(`collectOutput 失败：${describeError(error)}`)
  }
  return () => text
}

/**
 * 关键实验：宿主 PTY 里跑 trim-cli。
 *   A) `--help`：证明 CLI 能在真终端里正常输出
 *   B) `login --no-open`：证明 CLI 不再报 `not a terminal`，而是停在等待授权码
 * 这正是方案 §4.1 主路径成立与否的判据。
 */
async function runTerminalProbe(ctx) {
  const out = { startedAt: new Date().toISOString() }
  const subprocess = ctx.get('subprocess')
  if (!subprocess || typeof subprocess.spawnTerminal !== 'function') {
    return { ...out, error: 'subprocess.spawnTerminal 不可用，主路径不成立' }
  }

  const cli = defaultCliPath()
  const spawnSpec = (argv) => ({
    argv,
    cwd: SKILL_DIR,
    rows: 40,
    cols: 140,
    terminalType: 'xterm-256color',
    graceMs: TERM_GRACE_MS,
  })

  // ── 实验 A：trim-cli --help ──────────────────────────────────────────────
  const a = await safeAsync(() => subprocess.spawnTerminal(spawnSpec([cli, '--help'])))
  if (!a.ok) {
    out.help = { ok: false, error: a.error }
  } else {
    const readA = collectOutput(a.value)
    const settled = await Promise.race([
      a.value.done.then((r) => ({ exited: true, ...r })).catch((e) => ({ exited: true, error: describeError(e) })),
      delay(12_000).then(() => ({ exited: false })),
    ])
    out.help = { ok: true, pid: a.value.pid, settled, output: readA().slice(0, 4000) }
    out.helpVerdict = /Commands:|Usage:/i.test(out.help.output)
      ? 'PTY 通路成立：CLI 在宿主 PTY 里正常输出 help'
      : '未见 help 输出 —— 需人工看 output'
    await safeAsync(() => a.value.terminate())
  }

  // ── 实验 B：login（用独立 profile，不动 home）────────────────────────────
  // 目标地址取自 DEFAULT_TARGET（由用户在插件详情页填写），不写死在源码里。
  const loginArgv = DEFAULT_TARGET.host
    ? [
      cli, '--profile', 'dsh-probe', '--host', DEFAULT_TARGET.host,
      '--port', String(DEFAULT_TARGET.port), '--scheme', DEFAULT_TARGET.scheme,
      '--tls-insecure', 'login', '--no-open',
    ]
    : null
  const b = loginArgv
    ? await safeAsync(() => subprocess.spawnTerminal(spawnSpec(loginArgv)))
    : { ok: false, error: '未配置设备地址（DEFAULT_TARGET.host 为空），跳过 login 实验' }
  if (!b.ok) {
    out.login = { ok: false, error: b.error }
  } else {
    const readB = collectOutput(b.value)
    await delay(6_000)
    const foreground = await safeAsync(() => b.value.inspectForeground())
    const activity = await safeAsync(() => b.value.inspectActivity())
    out.login = {
      ok: true,
      pid: b.value.pid,
      foreground: foreground.ok ? foreground.value : { error: foreground.error },
      activity: activity.ok ? activity.value : { error: activity.error },
      output: readB().slice(0, 4000),
    }
    if (/not a terminal/i.test(out.login.output)) {
      out.loginVerdict = '失败：CLI 仍报 not a terminal'
    } else if (/Authorization code/i.test(out.login.output)) {
      out.loginVerdict = '成功：CLI 在宿主 PTY 里停在 Authorization code 等待输入'
    } else {
      out.loginVerdict = '未判定 —— 需人工看 login.output'
    }
    await safeAsync(() => b.value.terminate())
  }

  out.finishedAt = new Date().toISOString()
  return out
}

/** 验证技能注册链路。 */
async function runSkillsProbe(ctx) {
  const skills = ctx.get('skills')
  if (!skills) return { available: false, error: 'skills 服务不可用' }
  const out = { available: true }

  const before = await safeAsync(() => skills.list())
  out.listBefore = before.ok
    ? (before.value ?? []).map((s) => ({ name: s.name, source: s.source, provider: s.provider }))
    : { error: before.error }

  let disposer
  const registered = safe(() => {
    disposer = skills.register({
      name: 'fnos-probe-temp',
      description: 'dsh-fnos 探针临时技能（注册后立刻注销）',
      source: 'bundled',
      provider: 'dsh-fnos',
      content: '# fnos-probe-temp\n\n探针临时技能。',
      resourceBase: { kind: 'directory', path: SKILL_DIR },
    })
    return typeof disposer
  })
  out.register = registered

  if (registered.ok) {
    const after = await safeAsync(() => skills.list())
    out.listAfterRegister = after.ok
      ? (after.value ?? []).map((s) => ({ name: s.name, source: s.source, provider: s.provider }))
      : { error: after.error }
    out.tempSkillVisible = after.ok ? (after.value ?? []).some((s) => s.name === 'fnos-probe-temp') : null
    out.disposed = safe(() => { disposer?.(); return true })
  }
  return out
}

function json(res, status, body) {
  const text = JSON.stringify(body, null, 2)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(text)
}

function persist(report) {
  try {
    mkdirSync(PROBE_DIR, { recursive: true })
    writeFileSync(join(PROBE_DIR, 'report.json'), JSON.stringify(report, null, 2), 'utf8')
  } catch (error) {
    trace(`persist 失败：${describeError(error)}`)
  }
}

async function handler(ctx, req, res) {
  const url = new URL(req.url ?? ROUTE_PATH, 'http://localhost')
  const wantAll = url.searchParams.get('all') === '1'
  const report = { ...baseReport(ctx), probedAt: new Date().toISOString() }
  try {
    if (wantAll || url.searchParams.get('skills') === '1') report.skills = await runSkillsProbe(ctx)
    if (wantAll || url.searchParams.get('pty') === '1') report.pty = await runTerminalProbe(ctx)
  } catch (error) {
    report.probeError = describeError(error)
  }
  persist(report)
  json(res, 200, report)
}

/**
 * 连接默认值。
 *
 * `host` 刻意留空 —— 具体设备地址由用户在插件详情页填写（存浏览器 localStorage），
 * 不写死在源码里。空值时 /fnos/auth/start 会返回明确错误，而不是连到错误的机器。
 */
const DEFAULT_TARGET = { host: '', port: 5667, scheme: 'https', tlsInsecure: true }

/** 读 JSON 请求体；失败返回空对象。 */
async function readJson(req) {
  try {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    if (!chunks.length) return {}
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return {}
  }
}

/**
 * 授权路由：/plugins/dsh-fnos/auth/{status,start,submit,cancel}
 *
 * 安全边界：授权码只从这里进入，随后写进 PTY；**不提供任何接收授权码的工具**，
 * 因此授权码不进工具参数、不进会话记录。响应里也不回显 PTY 输出原文。
 */
function makeAuthHandler(ctx, authManager) {
  return async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const leaf = (url.pathname.split('/auth/')[1] ?? '').replace(/\/$/, '')
    const method = (req.method || 'GET').toUpperCase()
    try {
      if (method === 'GET' && leaf === 'status') {
        // 先看会话是不是"CLI 已退出但状态没跟上"——用户可能已在浏览器完成授权。
        await authManager.reconcile()
        const state = authManager.status()

        // 没有活跃会话时（例如插件刚被重新装载、或 DSH 重启过），直接查真实凭据。
        // trim-cli 的 session 是独立于本插件会话持久化的，所以这里仍能查出"已授权"。
        if (!state.state || state.state === 'idle') {
          const v = await authManager.verify('home')
          if (v.ok) {
            return json(res, 200, {
              ok: true,
              state: 'authorized',
              profile: 'home',
              authorized: true,
              device: v.text.slice(0, 1200),
              target: DEFAULT_TARGET,
            })
          }
          return json(res, 200, { ok: true, state: 'idle', authorized: false, target: DEFAULT_TARGET })
        }
        return json(res, 200, { ok: true, ...state, target: DEFAULT_TARGET })
      }
      if (method === 'POST' && leaf === 'start') {
        const body = await readJson(req)
        const host = String(body.host || DEFAULT_TARGET.host || '').trim()
        if (!host) {
          return json(res, 400, {
            ok: false,
            error: '请先在插件详情页填写飞牛设备地址（主机 / 端口）',
          })
        }
        const state = await authManager.start({
          profile: body.profile || 'home',
          host,
          port: body.port || DEFAULT_TARGET.port,
          scheme: body.scheme || DEFAULT_TARGET.scheme,
          tlsInsecure: body.tlsInsecure ?? DEFAULT_TARGET.tlsInsecure,
        })
        return json(res, 200, state)
      }
      if (method === 'POST' && leaf === 'submit') {
        const body = await readJson(req)
        const result = await authManager.submit(body?.code)
        return json(res, result.ok ? 200 : 400, result)
      }
      if (method === 'POST' && leaf === 'cancel') {
        return json(res, 200, await authManager.cancel())
      }
      return json(res, 404, { error: `未知 auth 端点：${method} ${leaf}` })
    } catch (error) {
      return json(res, 500, { error: describeError(error) })
    }
  }
}

export function apply(ctx, config) {
  try {
    trace(`apply() called  pid=${process.pid}  config=${JSON.stringify(config ?? null)}  ctxKeys=${JSON.stringify(safe(() => Object.keys(ctx))?.value)}`)
    const logger = ctx.logger ?? safe(() => ctx.get('logger')).value

    // 授权管理器：请求时才会用到 ctx.subprocess，此处仅建对象
    const authManager = createAuthManager(ctx)

    // 目录缓存：refresh 走 runCli（真终端），后台定时把已访问过的路径刷新一遍
    const dirCache = createDirCache(DIR_CACHE_TTL_MS, async (p) => {
      const text = await runCli(ctx, ['file', 'ls', p])
      let items = []
      try { items = JSON.parse(text) } catch { return }
      if (!Array.isArray(items)) return
      const dirs = items.filter((i) => i && i.dir === 1).map((i) => ({ name: String(i.name), dir: true }))
      const files = items
        .filter((i) => i && i.dir !== 1)
        .map((i) => ({ name: String(i.name), dir: false, size: typeof i.size === 'number' ? i.size : 0 }))
      const idx = p.lastIndexOf('/')
      dirCache.set(p, { ok: true, path: p, parent: idx > 0 ? p.slice(0, idx) : null, dirs, files })
    })

    // 后台定时刷新 + 落盘（用 ctx.setInterval 以便随插件卸载一起清理）
    try {
      // ① 启动先读磁盘快照 —— DSH 重启后也能立刻打开文件树，不用等 NAS
      const restored = dirCache.load()
      trace(`目录缓存：从磁盘恢复 ${restored} 条`)

      // ② 每 20 秒刷新已缓存路径并落盘
      // ⚠️ 不要用 ctx.setInterval：timer 不在本插件的 inject 里，会抛
      //    `cannot get property "timer" without inject`。直接用全局 setInterval，
      //    并在 effect 清理里自己停掉。
      const timer = setInterval(() => { dirCache.tick() }, DIR_REFRESH_INTERVAL_MS)
      if (typeof ctx.effect === 'function') {
        ctx.effect(() => () => { try { clearInterval(timer) } catch { /* 忽略 */ } }, 'dsh-fnos: dir cache timer')
      }

      // ③ 后台预热：已授权才有意义；异步进行，不阻塞插件装载
      const warm = async () => {
        try {
          const v = await authManager.verify('home')
          if (!v.ok) { trace('未授权，跳过目录预热'); return }
          await warmTree(ctx, dirCache)
          dirCache.save()
          trace(`目录预热完成（缓存 ${dirCache.size()} 条）`)
        } catch (error) {
          trace(`目录预热失败：${describeError(error)}`)
        }
      }
      warm()

      trace(`目录缓存已启动：每 ${DIR_REFRESH_INTERVAL_MS / 1000}s 后台刷新 + 落盘 ${CACHE_FILE}`)
    } catch (error) {
      trace(`目录缓存定时器启动失败：${describeError(error)}`)
    }

    // 工具注册（用 ctx.inject 等 tools 就绪后再注册）
    ctx.inject(['tools'], (tctx) => {
      try {
        tctx.effect(() => tctx.tools.register({
          name: 'fnos_probe',
          description: 'dsh-fnos 探针：返回插件装载状态与宿主服务可用性。仅用于 M0/M1 验证。',
          // 裸 register() 的 parameters 是「原样」发给模型的 input_schema，
          // 不会像 defineTool 那样补出 type:'object'。写 {} 会变成 type:null，
          // 上游直接整轮报错：Invalid schema for function 'fnos_probe'。
          parameters: { type: 'object', properties: {}, additionalProperties: false },
          output: {
            schema: {
              type: 'object',
              additionalProperties: false,
              properties: { summary: { type: 'string' } },
              required: ['summary'],
            },
            render: (_args, value) => [{ type: 'text', text: value.summary }],
          },
          timeoutMs: 20_000,
          execute: async () => {
            const r = baseReport(ctx)
            const online = Object.entries(r.services).filter(([, v]) => v === true).map(([k]) => k)
            return {
              summary: [
                `dsh-fnos 探针在线（pid=${r.plugin.pid}）`,
                `服务：${online.join(', ') || '（无）'}`,
                `spawnTerminal：${r.subprocess.available ? r.subprocess.hasSpawnTerminal : '不可用'}`,
              ].join('\n'),
            }
          },
        }), 'dsh-fnos: probe tool')
        trace('工具 fnos_probe 注册成功')
      } catch (error) {
        trace(`工具注册失败：${describeError(error)}`)
      }
    })

    // HTTP 路由：探针 + 授权
    ctx.inject(['webServer'], (wctx) => {
      try {
        wctx.effect(
          () => wctx.webServer.register({
            kind: 'exact',
            path: ROUTE_PATH,
            handler: (req, res) => handler(ctx, req, res),
          }),
          'dsh-fnos: probe route',
        )
        // 实测：kind:'prefix' 只匹配它自己那条路径，子路径进不来
        // （/plugins/dsh-fnos/auth/ 能进 handler，/auth/status 却是空 404）。
        // 所以对四个端点各注册一条 exact 路由，方法分发放在 handler 里做。
        const authHandler = makeAuthHandler(ctx, authManager)
        for (const leaf of ['status', 'start', 'submit', 'cancel']) {
          wctx.effect(
            () => wctx.webServer.register({
              kind: 'exact',
              path: AUTH_ROUTE_PREFIX + leaf,
              handler: authHandler,
            }),
            `dsh-fnos: auth ${leaf}`,
          )
        }
        wctx.effect(
          () => wctx.webServer.register({
            kind: 'exact',
            path: FILES_ROUTE,
            handler: makeFilesHandler(ctx, dirCache),
          }),
          'dsh-fnos: files route',
        )
        trace(`路由注册成功：${ROUTE_PATH} 与 ${AUTH_ROUTE_PREFIX}{status,start,submit,cancel} 与 ${FILES_ROUTE}`)
        logger?.info?.(`[dsh-fnos] 就绪：探针 GET ${ROUTE_PATH}；授权 ${AUTH_ROUTE_PREFIX}{status,start,submit,cancel}`)
      } catch (error) {
        trace(`路由注册失败：${describeError(error)}`)
      }
    })

    trace('apply() 结束')
  } catch (error) {
    trace(`apply() 抛异常：${describeError(error)}`)
  }
}
