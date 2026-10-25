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
import { appendFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
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
const DISCOVER_ROUTE = '/fnos/discover'
const IDENTITY_ROUTE = '/fnos/me'
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
/**
 * 单次 trim-cli 调用超时。实测 1–3 秒，留足余量；超时即主动中断并回收终端。
 * 旧实现用 `Promise.race([done, delay(20_000)])`，失败分支会留下悬挂定时器。
 */
const CLI_TIMEOUT_MS = 15_000
/**
 * 每轮后台刷新最多处理几条 —— **必须很小**。
 *
 * 历史事故：这里原为「环形游标 + 每轮 10 条」。而 spawnTerminal 一次约 1–3 秒，
 * 一轮就是 10–30 秒，超过 20 秒的刷新间隔 → 轮次重叠 → 终端会话、线程、句柄
 * 线性堆积（实测每 20 秒 +12 线程 / +167 句柄），最终把 DSH 拖崩。
 */
const REFRESH_BATCH = 1
/** 刚刷新过的条目在此毫秒内不再后台重刷（按需读取已经刷新过它）。 */
const REFRESH_MIN_AGE_MS = 15_000
/** 连续失败时的最大退避间隔。 */
const REFRESH_BACKOFF_MAX_MS = 300_000
/** 授权状态检查的记忆时长，避免每轮都 spawn 一个终端去校验。 */
const AUTH_MEMO_MS = 60_000
/**
 * 后台刷新总开关。**默认关闭**。
 *
 * 实证结论：本平台下 `spawnTerminal` 每次调用会残留约 11 个句柄 / 0.7 个线程
 * （单次调用前后对比可复现），调用越频繁增长越快。后台刷新属于"保持新鲜"的
 * 锦上添花 —— 而打开文件树本来就靠 `peek()` 的 stale-while-revalidate 走内存、
 * 永远毫秒级，从不阻塞。所以不值得用"每 20 秒一个泄漏"去换那点新鲜度。
 *
 * 需要时设 `FNO_BACKGROUND_REFRESH=1` 打开，并接受句柄持续增长。
 */
const BACKGROUND_REFRESH_ENABLED = process.env.FNO_BACKGROUND_REFRESH === '1'

/** 当前平台对应的 trim-cli 文件名（包内 bin/ 用的名字）。 */
function bundledCliName() {
  if (process.platform === 'win32') {
    return process.arch === 'arm64' ? 'trim-cli-windows-arm64.exe' : 'trim-cli-windows-x64.exe'
  }
  if (process.platform === 'darwin') {
    return process.arch === 'arm64' ? 'trim-cli-darwin-arm64' : 'trim-cli-darwin-x64'
  }
  return process.arch === 'arm64' ? 'trim-cli-linux-arm64' : 'trim-cli-linux-x64'
}

/** 官方技能包的落地根目录（与 lib/official.js 的 SKILL_HOME 保持一致）。 */
const SKILL_HOME = join(homedir(), '.dsh', 'fnos-skill')

/**
 * 运行时按需下载下来的 CLI 根目录（与 lib/cli.js 的 CLI_HOME 保持一致）。
 * 插件包不再随附 6 个平台的二进制，只在使用时下载本机那一个。
 */
const CLI_HOME_DIR = join(homedir(), '.dsh', 'fnos', 'cli')
const CLI_MIN_VALID_BYTES = 1024 * 1024

/** 已下载的 CLI（同步读，取最新的版本目录）。 */
function findDownloadedCli(name) {
  try {
    if (!existsSync(CLI_HOME_DIR)) return null
    const dirs = readdirSync(CLI_HOME_DIR)
      .filter((d) => !d.startsWith('.'))
      .map((d) => ({ d, at: statSync(join(CLI_HOME_DIR, d)).mtimeMs }))
      .sort((a, b) => b.at - a.at)
    for (const { d } of dirs) {
      const p = join(CLI_HOME_DIR, d, name)
      if (existsSync(p) && statSync(p).isFile() && statSync(p).size > CLI_MIN_VALID_BYTES) return p
    }
  } catch { /* 忽略 */ }
  return null
}

/** 进行中的下载任务，避免并发重复下载。 */
let cliBootstrapPromise = null

/**
 * 确保本机 CLI 可用（必要则下载）。多次调用共享同一个进行中的任务。
 * 失败不抛异常，由调用方按 cliPath() 是否为空来判断。
 */
function ensureCliReady() {
  if (cliPath()) return Promise.resolve(true)
  if (!cliBootstrapPromise) {
    cliBootstrapPromise = (async () => {
      try {
        const mod = await import('./cli.js?t=' + Date.now())
        const r = await mod.ensureCli({ name: bundledCliName(), log: (line) => trace(`[cli] ${line}`) })
        trace(`CLI 获取结果：${r.status}${r.error ? ` — ${r.error}` : ''}`)
        return r.status === 'installed' || r.status === 'present'
      } catch (error) {
        trace(`CLI 获取异常：${describeError(error)}`)
        return false
      }
    })()
  }
  return cliBootstrapPromise
}

/**
 * 运行时同步下来的官方技能包（若已安装）。
 * 同步读取的，因为 cliPath() 是同步函数，不能在这里 await。
 */
function readOfficialCurrent() {
  try {
    const j = JSON.parse(readFileSync(join(SKILL_HOME, 'current.json'), 'utf8'))
    if (j && j.version && j.dir && existsSync(j.dir)) return j
  } catch { /* 没装或已损坏 */ }
  return null
}

/** 记录上一次见到的账号身份，用来判断"是否换了账号"。 */
const IDENTITY_FILE = join(PACKAGE_ROOT, '.cache', 'identity.json')

function readIdentity() {
  try {
    const j = JSON.parse(readFileSync(IDENTITY_FILE, 'utf8'))
    return j && j.uid ? j : null
  } catch { return null }
}

function writeIdentity(obj) {
  try {
    mkdirSync(dirname(IDENTITY_FILE), { recursive: true })
    writeFileSync(IDENTITY_FILE, JSON.stringify(obj), 'utf8')
  } catch { /* 忽略 */ }
}

/**
 * 从 `user info` 的返回里取当前账号，推导家目录。
 *
 * fnOS 的用户家目录按 uid 编号（第一个账号 1000 → /vol1/1000），
 * 所以换账号后家目录会变。写死 /vol1/1000 是错的。
 *
 * 返回结构没有官方文档保证，所以先按已知位置取，取不到再在对象树里递归找
 * `uid`，避免结构一变就退回硬编码。
 */
function parseIdentity(info) {
  const user = info?.userInfo?.user ?? info?.user ?? null
  let uid = Number(info?.uid ?? user?.uid ?? 0) || null
  let username = user?.name ?? user?.username ?? user?.nickname ?? null

  if (!uid) {
    const seen = new Set()
    const walk = (node, depth) => {
      if (!node || typeof node !== 'object' || depth > 4 || seen.has(node)) return null
      seen.add(node)
      if (typeof node.uid === 'number' && node.uid > 0) {
        if (!username) username = node.name ?? node.username ?? node.nickname ?? null
        return node.uid
      }
      for (const v of Object.values(node)) {
        const hit = walk(v, depth + 1)
        if (hit) return hit
      }
      return null
    }
    uid = walk(info, 0) || null
  }

  return { uid, username, home: uid ? `/vol1/${uid}` : null }
}

/** 在 PATH 里找一个可执行文件，返回绝对路径或 null。 */
function findOnPath(name) {
  const raw = process.env.PATH ?? process.env.Path ?? ''
  const sep = process.platform === 'win32' ? ';' : ':'
  for (const dir of raw.split(sep)) {
    const trimmed = dir.trim()
    if (!trimmed) continue
    try {
      const candidate = join(trimmed, name)
      if (existsSync(candidate)) return candidate
    } catch { /* 忽略无效 PATH 项 */ }
  }
  return null
}

/**
 * 解析 trim-cli 的位置，四级回退：
 *
 *   ① 环境变量 `FNO_TRIM_CLI` —— 显式指定绝对路径，优先级最高
 *   ② 官方技能包 —— 运行时从官方同步下来的（版本比随包更新）
 *   ③ 包内 `bin/` —— 随本插件分发的内置版本（离线兜底）
 *   ④ 系统 `PATH` 里的 `trim-cli`
 *
 * 都找不到时返回 null，由调用方给出可操作的报错，
 * 而不是拿一个不存在的路径去 spawn 然后报一个看不懂的错。
 */
function cliPath() {
  const override = (process.env.FNO_TRIM_CLI ?? '').trim()
  if (override) return override

  const name = bundledCliName()

  const official = readOfficialCurrent()
  if (official) {
    const p = join(official.dir, 'bin', name)
    if (existsSync(p)) return p
  }

  const bundled = join(PACKAGE_ROOT, 'bin', name)
  if (existsSync(bundled)) return bundled

  // 兜底：运行时按需下载下来的（仅在包内没有二进制时才会走到）
  const downloaded = findDownloadedCli(name)
  if (downloaded) return downloaded

  return findOnPath(process.platform === 'win32' ? 'trim-cli.exe' : 'trim-cli')
}

/** 技能内容目录：优先用同步下来的官方包，否则用随包内置的那份。 */
function skillSourceDir() {
  const official = readOfficialCurrent()
  if (official && existsSync(join(official.dir, 'SKILL.md'))) return official.dir
  return PACKAGE_ROOT
}

/** 清掉 ANSI 转义与终端标题序列，否则 JSON 解析会失败。 */
const ANSI_RE = /\x1B\[[0-9;?]*[ -\/]*[@-~]|\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)|\x1B[@-Z\\-_]/g
function stripAnsi(text) {
  return String(text ?? '').replace(ANSI_RE, '')
}

/**
 * 从 SKILL.md 的 YAML frontmatter 里取 name / description。
 * 只处理这两种简单键值，不引入 YAML 依赖（技能文件的 frontmatter 就这两种形态）。
 */
function parseSkillFrontmatter(text) {
  const out = {}
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(String(text ?? ''))
  if (!m) return out
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line)
    if (!kv) continue
    let value = kv[2].trim()
    if (!value) continue
    // 去掉包裹的引号（单/双）
    if ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"'))) {
      value = value.slice(1, -1)
    }
    out[kv[1]] = value
  }
  return out
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
  if (!subprocess || typeof subprocess.spawnTerminal !== 'function') {
    throw new Error('subprocess 不可用')
  }

  // 插件包不再随附二进制，第一次用到时按需下载本机平台的那一个（6–8 MB）。
  // 这里等它完成，而不是直接报错 —— 用户感知是"第一次慢一点"，不是失败。
  if (!cliPath()) await ensureCliReady()

  const cli = cliPath()
  if (!cli) {
    throw new Error(
      `找不到 trim-cli（本机应为 ${bundledCliName()}）。请任选一种：`
      + `① 点插件页的「自动发现」后重试，会自动下载；`
      + `② 手动把 ${bundledCliName()} 放到 ${join(CLI_HOME_DIR, 'v任意版本')} 目录；`
      + '③ 加入系统 PATH；④ 用环境变量 FNO_TRIM_CLI 指定绝对路径。',
    )
  }

  const controller = new AbortController()
  let handle = null
  let onData = null
  let buf = ''

  try {
    handle = await subprocess.spawnTerminal({
      argv: [cli, '--profile', profile, ...args],
      cwd: PACKAGE_ROOT,
      rows: 40,
      cols: 140,
      terminalType: 'xterm-256color',
      graceMs: TERM_GRACE_MS,
      signal: controller.signal,
    })
    try { handle.output.setEncoding('utf8') } catch { /* 忽略 */ }
    onData = (c) => { buf += String(c) }
    handle.output.on('data', onData)

    const finished = await settlesWithin(handle.done, CLI_TIMEOUT_MS)
    if (!finished) {
      try { controller.abort() } catch { /* 忽略 */ }
      trace(`runCli 超时（${CLI_TIMEOUT_MS}ms）：trim-cli ${args.join(' ')}`)
    }
    return stripAnsi(buf)
  } finally {
    // 无条件收尾：解监听 → terminate（服务契约里是 awaited 的整体回收）→ 等 done 落定。
    // 任何一步都不能省，否则 PTY 句柄与线程会随每次调用累积。
    if (handle && onData) {
      try { handle.output.removeListener('data', onData) } catch { /* 忽略 */ }
    }
    if (handle) {
      try { await handle.terminate() } catch { /* 忽略 */ }
      try { await settlesWithin(handle.done, TERM_GRACE_MS) } catch { /* 忽略 */ }
    }
  }
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

      // 已在缓存里（含启动时从磁盘恢复的）就不再 spawn 一次：每次插件重载
      // 都去拉几十个目录是纯粹的句柄浪费。要给某个目录强制换新，请求里带 fresh=1。
      const known = cache.peek(p)
      if (known) {
        if (depth < WARM_DEPTH) {
          for (const d of (known.dirs ?? []).slice(0, WARM_MAX_DIRS_PER_LEVEL)) {
            next.push(p.replace(/\/$/, '') + '/' + d.name)
          }
        }
        continue
      }

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
    //   过期但有旧值  → **也先返回旧值**（快！标 stale）
    //   完全没有      → 才去实时拉一次
    // 打开永远是毫秒级、从不阻塞；要强制取最新带 fresh=1。
    // 注：后台刷新默认关闭（spawnTerminal 每次调用会残留句柄），
    //     所以旧值可能保持到有人带 fresh=1 或缓存被淘汰为止。
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
   * 后台刷新：优先刷「最近还在用」的目录，每次只处理极少量。
   *
   * 历史事故：原实现是「环形游标 + 每轮 10 条」。spawnTerminal 一次约 1–3 秒，
   * 一轮就是 10–30 秒，**超过 20 秒的刷新间隔 → 轮次重叠 → 终端会话线性堆积**
   * （实测主进程涨到 3538 句柄 / 160 线程 / 1.4 GB）。
   *
   * 现在的策略：
   *   · 每轮最多 REFRESH_BATCH 条（默认 1）
   *   · 按 at **从新到旧**挑 —— 谁在用就保谁新鲜，冷条目自然过期、下次打开按需拉取
   *   · 跳过 REFRESH_MIN_AGE_MS 内刚刷过的，避免无效 spawn
   *   · 返回本轮实际刷新条数，调度器据此放慢
   */
  const tick = async (maxBatch = REFRESH_BATCH) => {
    const now = Date.now()
    const candidates = []
    for (const [p, v] of store) {
      if (now - v.at >= REFRESH_MIN_AGE_MS) candidates.push({ p, at: v.at })
    }
    // 缓存为空时至少把两个根拉一次，否则永远不会开始
    if (store.size === 0) {
      for (const p of [MY_FOLDER, TEAM_FOLDER]) candidates.push({ p, at: 0 })
    }
    if (candidates.length === 0) return 0

    // 越新越优先：保持用户正在浏览的目录始终热，而不是轮流把冷条目也拉一遍
    candidates.sort((a, b) => b.at - a.at)
    const batch = candidates.slice(0, Math.max(1, maxBatch))

    let refreshed = 0
    for (const { p } of batch) {
      try {
        await refresh(p)
        refreshed += 1
      } catch { /* 单个失败不影响其它 */ }
    }
    save()
    return refreshed
  }

  /**
   * 清空全部缓存。
   *
   * 账号切换后必须调用：缓存只以「路径」为 key，不区分账号，
   * 不清就会把上一个账号的目录内容继续展示给新账号，
   * 表现为"换了账号，看到的还是旧账号的文件夹"。
   */
  const clear = () => {
    const n = store.size
    store.clear()
    try { unlinkSync(CACHE_FILE) } catch { /* 文件可能不存在，忽略 */ }
    return n
  }

  return { get, peek, set, tick, load, save, clear, size: () => store.size }
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

/**
 * 等一个 promise 落定，最多等 ms 毫秒；落定返回 true，超时返回 false。
 *
 * 关键：**无论哪种结果都清掉定时器**。旧代码 `Promise.race([p, delay(20_000)])`
 * 在 p 先完成时会把那个 20 秒定时器留在事件循环里，闭包还拖住终端句柄，
 * 每轮刷新攒下一批悬挂定时器。
 */
function settlesWithin(promise, ms) {
  return new Promise((resolve) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      resolve(false)
    }, ms)
    if (typeof timer.unref === 'function') timer.unref()

    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(true)
    }
    Promise.resolve(promise).then(finish, finish)
  })
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
      cliPath: cliPath(),
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

  const cli = cliPath()
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

    // ── 官方技能：随插件注册 + 后台同步 ──────────────────────────────────────
    //
    // 技能随插件注册后，用户装完插件就有完整能力说明，不需要再手动解压官方 zip。
    // 内容优先取运行时同步下来的官方包（版本更新），回退到随包内置的那份。
    // source 用 'runtime'，在技能分层里高于 user-agents，可覆盖用户手动装的副本。
    ctx.inject(['skills'], (sctx) => {
      try {
        const dir = skillSourceDir()
        const mdPath = join(dir, 'SKILL.md')
        if (!existsSync(mdPath)) {
          trace('技能注册跳过：找不到 SKILL.md')
          return
        }
        const content = readFileSync(mdPath, 'utf8')
        const meta = parseSkillFrontmatter(content)
        sctx.effect(() => sctx.skills.register({
          name: meta.name || 'fnos',
          description: meta.description || '飞牛 fnOS 设备管理：认证、文件、存储、Docker、下载、日志、监控、网络、用户',
          content,
          source: 'runtime',
          provider: 'dsh-fnos',
          resourceBase: { kind: 'directory', path: dir },
        }))
        trace(`技能已注册：${meta.name || 'fnos'}  ← ${dir}`)
      } catch (error) {
        trace(`技能注册失败：${describeError(error)}`)
      }
    })

    // 每天最多同步一次官方技能包；失败静默，绝不影响已有功能
    const syncOfficialSkill = async () => {
      if (process.env.FNO_SKILL_SYNC === '0') {
        trace('官方技能同步已禁用（FNO_SKILL_SYNC=0）')
        return
      }
      const stamp = join(PACKAGE_ROOT, '.cache', 'skill-sync.json')
      try {
        const last = JSON.parse(readFileSync(stamp, 'utf8'))
        if (last && Date.now() - (last.at ?? 0) < 24 * 3600_000) return
      } catch { /* 首次运行 */ }
      try {
        const mod = await import('./official.js?t=' + Date.now())
        const r = await mod.sync({ log: (line) => trace(`[sync] ${line}`) })
        trace(`技能同步：${r.status}${r.version ? ` v${r.version}` : ''}${r.error ? ` — ${r.error}` : ''}`)
        try {
          mkdirSync(dirname(stamp), { recursive: true })
          writeFileSync(stamp, JSON.stringify({ at: Date.now(), result: r }), 'utf8')
        } catch { /* 忽略 */ }
      } catch (error) {
        trace(`技能同步异常：${describeError(error)}`)
      }
    }
    syncOfficialSkill()


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

    // 后台定时刷新 + 落盘（定时器挂在 ctx.effect 上，随插件卸载一起清理）
    try {
      // ① 启动先读磁盘快照 —— DSH 重启后也能立刻打开文件树，不用等 NAS
      const restored = dirCache.load()
      trace(`目录缓存：从磁盘恢复 ${restored} 条`)

      // ② 后台刷新：**自调度**（上一轮结束后才排下一轮）
      //
      // 为什么不用 setInterval：tick 是 async，setInterval 无法 await 它；
      // 只要单轮耗时超过间隔就会并发堆积，而每轮都会 spawn 真终端 ——
      // 这正是之前把 DSH 拖崩的根因。自调度在结构上排除了重叠。
      let stopped = false
      let running = false
      let failures = 0
      let timer = null
      let authOk = false
      let authCheckedAt = 0

      const authReady = async () => {
        const now = Date.now()
        if (now - authCheckedAt < AUTH_MEMO_MS) return authOk
        const v = await authManager.verify('home').catch(() => ({ ok: false }))
        authOk = !!v.ok
        authCheckedAt = Date.now()
        return authOk
      }

      const arm = (ms) => {
        if (stopped) return
        timer = setTimeout(fire, ms)
        if (typeof timer.unref === 'function') timer.unref()
      }

      const fire = async () => {
        if (stopped || running) return
        running = true
        let next = DIR_REFRESH_INTERVAL_MS
        try {
          // 未授权就别刷：否则每轮都 spawn 一个注定失败的终端
          if (!(await authReady())) {
            next = Math.min(REFRESH_BACKOFF_MAX_MS, DIR_REFRESH_INTERVAL_MS * 6)
          } else {
            const n = await dirCache.tick()
            failures = 0
            // 没有过期项就放慢，别为了刷而刷
            if (n === 0) next = DIR_REFRESH_INTERVAL_MS * 3
          }
        } catch (error) {
          failures += 1
          next = Math.min(REFRESH_BACKOFF_MAX_MS, DIR_REFRESH_INTERVAL_MS * 2 ** failures)
          trace(`后台刷新失败（第 ${failures} 次）：${describeError(error)}；${next}ms 后重试`)
        } finally {
          running = false
          arm(next)
        }
      }

      if (BACKGROUND_REFRESH_ENABLED) {
        arm(DIR_REFRESH_INTERVAL_MS)
      } else {
        trace('后台刷新已禁用（FNO_BACKGROUND_REFRESH=0）')
      }

      if (typeof ctx.effect === 'function') {
        ctx.effect(() => () => {
          stopped = true
          if (timer) { try { clearTimeout(timer) } catch { /* 忽略 */ } }
          timer = null
        }, 'dsh-fnos: dir cache timer')
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

      trace(
        `目录缓存已启动：自调度刷新（间隔 ${DIR_REFRESH_INTERVAL_MS / 1000}s，每轮 ≤${REFRESH_BATCH} 条，`
        + `不重叠）+ 落盘 ${CACHE_FILE}`,
      )
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

        // 局域网设备发现：让用户不用手打 IP
        wctx.effect(
          () => wctx.webServer.register({
            kind: 'exact',
            path: DISCOVER_ROUTE,
            handler: async (req, res) => {
              try {
                const url = new URL(req.url ?? '/', 'http://localhost')
                const port = Number(url.searchParams.get('port')) || 5667
                const mod = await import('./discover.js?t=' + Date.now())
                const t0 = Date.now()
                const r = await mod.discoverDevices({ port })
                trace(`设备发现：扫 ${r.scanned} 个地址，命中 ${r.found.length} 台（${Date.now() - t0}ms）`)
                return json(res, 200, { ok: true, ...r, elapsedMs: Date.now() - t0 })
              } catch (error) {
                return json(res, 500, { ok: false, error: describeError(error) })
              }
            },
          }),
          'dsh-fnos: discover route',
        )

        // 当前账号身份：客户端用它决定从哪个目录开始浏览，
        // 并在账号变化时让目录缓存失效（缓存只按路径做 key，不区分账号）。
        wctx.effect(
          () => wctx.webServer.register({
            kind: 'exact',
            path: IDENTITY_ROUTE,
            handler: async (req, res) => {
              try {
                const text = await runCli(ctx, ['user', 'info'])
                let info = {}
                try { info = JSON.parse(text) } catch { /* 非 JSON 就当空 */ }
                const who = parseIdentity(info)

                const prev = readIdentity()
                if (who.uid && (!prev || prev.uid !== who.uid)) {
                  const n = dirCache.clear()
                  writeIdentity({ ...who, at: new Date().toISOString() })
                  trace(`账号身份 ${prev ? `${prev.uid} → ` : ''}${who.uid}（${who.username || '?'}），已清空目录缓存 ${n} 条`)
                }
                return json(res, 200, { ok: true, ...who })
              } catch (error) {
                // 拿不到身份不算致命：客户端会退回默认家目录
                return json(res, 200, { ok: false, error: describeError(error) })
              }
            },
          }),
          'dsh-fnos: identity route',
        )

        trace(`路由注册成功：${ROUTE_PATH} 与 ${AUTH_ROUTE_PREFIX}{status,start,submit,cancel} 与 ${FILES_ROUTE} 与 ${DISCOVER_ROUTE} 与 ${IDENTITY_ROUTE}`)
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
