/**
 * trim-cli 的按需获取。
 *
 * 为什么需要
 *   官方发布的是一整个 41 MB 的技能包，里面 6 个平台的 trim-cli 各占 6–8 MB。
 *   把 6 个全塞进插件包，用户装一次要下 18.4 MB（实测慢网 4 分 35 秒），
 *   而实际只用到其中 1 个。
 *
 * 做法
 *   插件包不再随附二进制（体积从 18.4 MB 降到约 0.4 MB，安装瞬间完成）；
 *   首次真正要用 CLI 时，只下载**本机平台那一个**（6.5 MB），
 *   校验 SHA256 后落到 ~/.dsh/fnos/cli/v<版本>/，之后一直复用。
 *
 * 安全
 *   - 优先用 Release 里的 checksums.txt 做 SHA256 校验，校验不过直接丢弃
 *   - 拿不到 checksums 时，至少校验文件大小与可执行性（大小 < 1 MB 视为错误页）
 *   - 先写 .part 再改名，避免半截文件被当成可用
 *
 * 失败时
 *   返回 { status:'failed', error }，由调用方给出可操作提示。
 *   用户也可以自己把二进制丢到 CLI_HOME 下任意版本目录，或设 FNO_TRIM_CLI。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync, chmodSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const CLI_HOME = join(homedir(), '.dsh', 'fnos', 'cli')
const RELEASE_BASE = 'https://github.com/MeetoHub/dsh-fnos/releases/latest/download/'
const MIN_VALID_BYTES = 1024 * 1024 // 小于 1 MB 基本是错误页而不是二进制
const TIMEOUT_MS = 10 * 60 * 1000 // 慢网下 6.5 MB 可能要几分钟

/** 已安装的 CLI（按版本目录名倒序，新的优先）。同步、纯文件系统。 */
export function findInstalledCli(name) {
  try {
    if (!existsSync(CLI_HOME)) return null
    const dirs = readdirSync(CLI_HOME)
      .filter((d) => !d.startsWith('.'))
      .map((d) => ({ d, at: statSync(join(CLI_HOME, d)).mtimeMs }))
      .sort((a, b) => b.at - a.at)
    for (const { d } of dirs) {
      const p = join(CLI_HOME, d, name)
      if (existsSync(p) && statSync(p).isFile() && statSync(p).size > MIN_VALID_BYTES) return p
    }
  } catch { /* 忽略 */ }
  return null
}

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex')
}

async function fetchWithTimeout(url) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  if (typeof timer.unref === 'function') timer.unref()
  try {
    return await fetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: { 'User-Agent': 'dsh-fnos-cli-bootstrap', Accept: '*/*' },
    })
  } finally {
    clearTimeout(timer)
  }
}

/** 取 Release 里的 checksums.txt，解析成 { 文件名: 哈希 }。拿不到返回空表。 */
async function fetchChecksums() {
  try {
    const res = await fetchWithTimeout(RELEASE_BASE + 'checksums.txt')
    if (!res.ok) return {}
    const text = await res.text()
    const map = {}
    for (const line of text.split(/\r?\n/)) {
      const m = /^([a-f0-9]{64})\s+\*?(.+)$/i.exec(line.trim())
      if (m) map[m[2].trim()] = m[1].toLowerCase()
    }
    return map
  } catch {
    return {}
  }
}

/**
 * 确保本机平台的 trim-cli 可用，必要时下载。
 *
 * @param {object} opts
 * @param {string} opts.name     本机对应的文件名，如 trim-cli-windows-x64.exe
 * @param {string} [opts.version] 版本目录名，默认取当前日期
 * @returns {Promise<{status:'present'|'installed'|'failed', path?:string, error?:string}>}
 */
export async function ensureCli(opts = {}) {
  const log = opts.log ?? (() => {})
  const name = String(opts.name ?? '').trim()
  if (!name) return { status: 'failed', error: '未指定 CLI 文件名' }

  // 已经装过（含用户手动放的）
  const existing = findInstalledCli(name)
  if (existing) return { status: 'present', path: existing }

  const version = String(opts.version ?? new Date().toISOString().slice(0, 10)).replace(/[^\w.-]/g, '')
  const dir = join(CLI_HOME, `v${version}`)
  const finalPath = join(dir, name)
  const partPath = `${finalPath}.part`

  try {
    log(`开始下载本机 CLI（${name}，约 6–8 MB）…`)
    const res = await fetchWithTimeout(RELEASE_BASE + encodeURIComponent(name))
    if (!res.ok) return { status: 'failed', error: `下载失败：HTTP ${res.status}` }
    const buf = Buffer.from(await res.arrayBuffer())

    if (buf.length < MIN_VALID_BYTES) {
      return { status: 'failed', error: `下载内容过小（${buf.length} 字节），可能是错误页` }
    }

    // 有 checksums 就必须对上；官方没发布校验值时至少保证大小合理
    const sums = await fetchChecksums()
    const expected = sums[name]
    if (expected) {
      const got = sha256(buf)
      if (got !== expected) {
        return { status: 'failed', error: `SHA256 不匹配（期望 ${expected.slice(0, 12)}…，实得 ${got.slice(0, 12)}…）` }
      }
      log('SHA256 校验通过')
    } else {
      log('（未取到 checksums.txt，跳过哈希校验，仅做体积检查）')
    }

    mkdirSync(dir, { recursive: true })
    writeFileSync(partPath, buf)
    try { chmodSync(partPath, 0o755) } catch { /* Windows 上无效，忽略 */ }
    renameSync(partPath, finalPath)
    try { chmodSync(finalPath, 0o755) } catch { /* 忽略 */ }

    log(`CLI 已就绪：${finalPath}`)
    return { status: 'installed', path: finalPath }
  } catch (error) {
    try { rmSync(partPath, { force: true }) } catch { /* 忽略 */ }
    return { status: 'failed', error: `${error?.message ?? error}` }
  }
}

/** 给报错信息用的手动安装指引。 */
export function manualCliHint(name) {
  return [
    `也可以手动放置：把 ${name} 放到 ${join(CLI_HOME, 'v<任意版本>')}${requireSep()}${name}`,
    '或用环境变量 FNO_TRIM_CLI 指定 trim-cli 的绝对路径。',
  ].join('\n')
}

function requireSep() {
  return process.platform === 'win32' ? '\\' : '/'
}
