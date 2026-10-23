/**
 * dsh-fnos 授权管理器
 *
 * 用宿主唯一的真终端原语 ctx.subprocess.spawnTerminal 驱动 trim-cli login：
 *   start()  → 起 PTY 跑 login --no-open，从输出里抓授权 URL
 *   submit() → 把用户给的授权码写进 PTY（等价于"用户粘贴到 CLI 提示"）
 *   verify() → 跑 system info 确认 session 真的落盘
 *
 * 授权码只经过 webServer 路由，不进工具参数、不进会话记录。
 *
 * 实测依据（M1）：
 *   - 非 TTY 下 CLI 报 `IO error: not a terminal` 并退出；
 *   - spawnTerminal 下 CLI 正常打印授权 URL 并停在 `Authorization code:`。
 */
import { appendFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const PROBE_DIR = join(PACKAGE_ROOT, '.probe')
const TRACE_TMP = join(tmpdir(), 'dsh-fnos-trace.log')

/** 授权会话最长存活时间（授权码本身 5 分钟有效，留一点余量）。 */
const SESSION_TTL_MS = 10 * 60 * 1000
const TERM_ROWS = 40
const TERM_COLS = 140
const TERM_GRACE_MS = 5_000

function trace(line) {
  const text = `[${new Date().toISOString()}] [auth] ${line}\n`
  for (const target of [TRACE_TMP, join(PROBE_DIR, 'trace.log')]) {
    try {
      mkdirSync(dirname(target), { recursive: true })
      appendFileSync(target, text, 'utf8')
    } catch { /* 换下一个落点 */ }
  }
}

/** 清掉 ANSI 转义与终端标题序列，否则正则匹配不干净。 */
const ANSI = /\x1B\[[0-9;?]*[ -\/]*[@-~]|\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)|\x1B[@-Z\\-_]/g
function strip(text) {
  return String(text ?? '').replace(ANSI, '')
}

// 去掉换行后 URL 是一整串；用 \S+ 吃到底，再去掉尾部的分隔符。
// 注意 challenge 的参数名是 code_challenge（不是 codeChallenge）。
const URL_RE = /https?:\/\/\S*?\/signin\?\S+/
const WAIT_RE = /Authorization code/i
const FAIL_RE = /not a terminal|invalid|expired|failed|error|拒绝|无效|过期/i
const NEED_LOGIN_RE = /saved (proxy )?session is required|run login first/i

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

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 创建授权管理器。
 * @param ctx - 宿主插件上下文（请求时 ctx.subprocess 已可用）。
 */
export function createAuthManager(ctx) {
  /** @type {null | {handle, buffer, state, url, error, profile, startedAt, timer}} */
  let session = null

  function terminal() {
    const subprocess = ctx.get('subprocess')
    if (!subprocess || typeof subprocess.spawnTerminal !== 'function') return null
    return subprocess
  }

  /**
   * CLI 已退出但状态还停在 waiting-code —— 说明用户已经在浏览器里走完授权，
   * 进程正常结束。此时不该报失败，应当去查真实凭据（system info）。
   */
  async function reconcile() {
    if (!session || !session.exited) return
    if (session.state !== 'waiting-code' && session.state !== 'starting') return
    const r = await verify(session.profile)
    if (r.ok) {
      session.state = 'authorized'
      trace('对账：CLI 已退出且 system info 可取到数据 → 判定为已授权')
    }
  }

  function current() {
    if (!session) return { state: 'idle' }
    return {
      state: session.state,
      profile: session.profile,
      url: session.url,
      error: session.error,
      pid: session.handle?.pid,
      exited: !!session.exited,
      exitCode: session.exitCode ?? null,
      elapsedMs: Date.now() - session.startedAt,
      /** 剩余有效毫秒（授权码 5 分钟），仅 waiting-code 时有意义 */
      remainingMs: session.state === 'waiting-code'
        ? Math.max(0, 5 * 60 * 1000 - (Date.now() - session.codeReadyAt))
        : null,
      // 刻意不返回 PTY 输出原文：终端可能回显授权码，不能让它出现在 HTTP 响应里。
    }
  }

  async function dispose(reason) {
    if (!session) return
    const s = session
    session = null
    clearTimeout(s.timer)
    try { await s.handle?.terminate?.() } catch (e) { trace(`terminate 失败：${e?.message}`) }
    trace(`会话结束（${reason}）`)
  }

  /**
   * 起一次登录。成功后会话停在 waiting-code，url 可直接给用户打开。
   */
  async function start(options = {}) {
    const subprocess = terminal()
    if (!subprocess) throw new Error('subprocess.spawnTerminal 不可用，无法起真终端')

    await dispose('重新登录')

    const profile = options.profile || 'home'
    const argv = [cliPath(), '--profile', profile]
    if (options.host) argv.push('--host', String(options.host))
    if (options.port) argv.push('--port', String(options.port))
    if (options.scheme) argv.push('--scheme', String(options.scheme))
    if (options.tlsInsecure) argv.push('--tls-insecure')
    if (options.allowInsecureHttp) argv.push('--allow-insecure-http')
    argv.push('login', '--no-open')

    trace(`spawnTerminal: ${argv.join(' ')}`)
    const handle = await subprocess.spawnTerminal({
      argv,
      cwd: PACKAGE_ROOT,
      rows: TERM_ROWS,
      cols: TERM_COLS,
      terminalType: 'xterm-256color',
      graceMs: TERM_GRACE_MS,
    })

    session = {
      handle,
      buffer: '',
      state: 'starting',
      url: null,
      error: null,
      profile,
      startedAt: Date.now(),
      codeReadyAt: 0,
      timer: setTimeout(() => dispose('会话超时'), SESSION_TTL_MS),
    }

    try { handle.output?.setEncoding?.('utf8') } catch { /* 忽略 */ }
    handle.output?.on?.('data', (chunk) => {
      if (!session) return
      session.buffer += String(chunk)
      detect()
    })
    handle.done?.then(
      (outcome) => {
        if (!session) return
        // ⚠️ 不要在这里判失败。
        // 实测：trim-cli 授权成功后**不打印任何成功文案**就直接退出（exit=0），
        // 所以"进程退出 + 输出里没有 authorized 字样"是**正常成功**，不是失败。
        // 一律以 system info 能否取到设备数据为准（见 submit / status 里的 verify）。
        if (session.state === 'starting' || session.state === 'waiting-code') {
          trace(`CLI 进程退出（exit=${outcome?.exitCode}）；是否授权成功交由 system info 校验`)
          session.exited = true
          session.exitCode = outcome?.exitCode ?? null
        }
      },
      (error) => {
        if (!session) return
        session.state = 'failed'
        session.error = String(error?.message ?? error)
      },
    )

    // 等授权 URL 出现（最多 20 秒）
    const deadline = Date.now() + 20_000
    while (Date.now() < deadline) {
      if (session?.state === 'waiting-code' || session?.state === 'failed') break
      await delay(300)
    }
    if (!session) throw new Error('会话已在启动过程中被清理')
    if (session.state === 'failed') throw new Error(session.error || '登录启动失败')
    if (!session.url) throw new Error('未能从 CLI 输出中取到授权 URL')

    return { ...current(), ok: true }
  }

  /** 从 PTY 输出里判定状态。 */
  function detect() {
    if (!session || session.state === 'authorized') return
    // ⚠️ 关键：必须先把换行去掉再匹配。
    // 终端按列宽折行，授权 URL 会被切成好几段（实测切成 3 段，第一段只有 140 字符）。
    // 直接 \S+ 匹配只能拿到第一段 —— 这正是之前手工重建 URL 导致"参数异常"的根因。
    const text = strip(session.buffer).replace(/\r\n|\r|\n/g, '')
    if (/not a terminal/i.test(text)) {
      session.state = 'failed'
      session.error = 'CLI 仍报 not a terminal（终端分配失败）'
      return
    }
    if (!session.url) {
      const m = text.match(URL_RE)
      if (m) {
        session.url = m[0].replace(/[.,;]+$/, '')
        session.state = 'waiting-code'
        session.codeReadyAt = Date.now()
        trace(`拿到授权 URL（challenge=${/code_challenge=([^&]+)/.exec(session.url)?.[1]?.slice(0, 12)}…）`)
        return
      }
    }
    if (/authorized|login success|登录成功|已授权/i.test(text)) {
      session.state = 'authorized'
      trace('CLI 报告授权成功')
    }
  }

  /**
   * 提交授权码。写入 PTY 后等 CLI 完成 token 交换，再用 system info 验证。
   */
  async function submit(code) {
    if (!session) throw new Error('当前没有进行中的登录，请先调用 start')
    if (session.state === 'authorized') return { ...current(), ok: true, alreadyAuthorized: true }
    if (session.state !== 'waiting-code') {
      throw new Error(`当前状态不支持提交授权码（state=${session.state}）`)
    }

    const clean = String(code ?? '').trim()
    if (!clean) throw new Error('授权码为空')
    if (/[\x00-\x1F\x7F]/.test(clean)) throw new Error('授权码含控制字符，已拒绝')

    const before = session.buffer.length
    trace('写入授权码（内容不记录）')
    await session.handle.write(`${clean}\r`)

    // 等 CLI 消化
    const deadline = Date.now() + 30_000
    while (Date.now() < deadline) {
      await delay(400)
      if (!session) throw new Error('会话已结束')
      if (session.state === 'authorized') break
      if (session.state === 'failed') break
    }

    // ⚠️ 不要靠 CLI 输出文本判断成败：授权成功后它不打印成功文案，静默退出（exit=0）。
    // 唯一可信的凭据是 system info 能否取到设备数据 —— 直接以它为准。
    const profile = session.profile
    const verifyResult = await verify(profile)
    if (verifyResult.ok) {
      session.state = 'authorized'
      trace('授权成功（system info 校验通过）')
      return { ...current(), ok: true, device: verifyResult.text.slice(0, 1200) }
    }

    // 只有确实没拿到 session 才判失败，并把 CLI 的输出片段作为线索（脱敏后给出）
    session.state = 'failed'
    const hint = /not a terminal/i.test(fresh)
      ? '终端分配失败'
      : /invalid|expired|拒绝|无效|过期/i.test(fresh)
        ? '授权码可能被拒绝或已过期'
        : '未取到有效 session'
    session.error = `授权未成功（${hint}）`
    return { ...current(), ok: false, message: session.error, hint: fresh.slice(0, 300) }
  }

  /**
   * 用 system info 判断某个 profile 有没有可用 session。
   * 没登录时 CLI 会报 `saved session is required`。
   */
  async function verify(profile = 'home') {
    const subprocess = terminal()
    if (!subprocess) return { ok: false, text: 'subprocess 不可用' }
    const handle = await subprocess.spawnTerminal({
      argv: [cliPath(), '--profile', profile, 'system', 'info'],
      cwd: PACKAGE_ROOT,
      rows: TERM_ROWS,
      cols: TERM_COLS,
      terminalType: 'xterm-256color',
      graceMs: TERM_GRACE_MS,
    })
    let buf = ''
    try { handle.output?.setEncoding?.('utf8') } catch { /* 忽略 */ }
    handle.output?.on?.('data', (c) => { buf += String(c) })
    await Promise.race([handle.done.catch(() => null), delay(20_000)])
    let text = ''
    try { text = strip(buf) } catch { /* 忽略 */ }
    try { await handle.terminate() } catch { /* 忽略 */ }
    const ok = text.length > 0 && !NEED_LOGIN_RE.test(text)
    return { ok, text: text.slice(0, 2000) }
  }

  async function cancel() {
    await dispose('用户取消')
    return { ok: true, state: 'idle' }
  }

  return {
    start,
    submit,
    verify,
    cancel,
    reconcile,
    status: current,
    dispose: () => dispose('显式清理'),
  }
}
