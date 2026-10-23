/**
 * 官方 fnOS 技能包的获取与同步。
 *
 * 背景
 *   fnOS 官方发布的 AI 技能包是**带版本号的 zip + SHA256**：
 *     https://iso.liveupdate.fnnas.com/ai_labs/trim_cli/fnos-skill-v{ver}.zip
 *   版本与哈希公布在下载页 https://fnnas.com/download 的页面数据里。
 *
 * 为什么需要它
 *   随插件打包的技能文档会**永久落后**（实测插件内是 0.1.1，官方已 0.5.1），
 *   旧文档会让 Agent 调错接口。所以文档与 CLI 都应该跟着官方走。
 *
 * 现实约束
 *   官方 CDN 在部分网络下对程序化下载返回 403（实测 curl / Node / 真实 Chrome
 *   内核全部被挡）。因此下载采取**三档降级**：
 *     ① 直连官方 CDN
 *     ② 本项目 Release 上的镜像（fnos-skill.zip）
 *     ③ 用户手动提供（详情页「导入 zip」写入 skills 目录旁的 incoming/）
 *
 * 存储布局
 *   ~/.dsh/fnos-skill/
 *     v0.5.1/            解压出来的技能包（SKILL.md / bin/ / entries/ / reference/）
 *     current.json       { version, dir, at, source }
 *
 * 设计原则
 *   - 全程非阻塞、失败静默：同步失败绝不影响插件已能用的部分
 *   - SHA256 必须校验，校验不过直接丢弃
 *   - 先解压到临时目录，成功后再原子切换，避免半成品覆盖可用版本
 */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import {
  existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, renameSync, readdirSync, statSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const SKILL_HOME = join(homedir(), '.dsh', 'fnos-skill')
const CURRENT_FILE = join(SKILL_HOME, 'current.json')
const PAGE_URL = 'https://fnnas.com/download'
const MIRROR_URL = 'https://github.com/MeetoHub/dsh-fnos/releases/latest/download/fnos-skill.zip'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const TIMEOUT_MS = 60_000

/**
 * 从下载页的 Next.js 负载里取站点公布的技能包信息。
 * 同一段 JSON 可能被转义（RSC 流）也可能不转义，两种形态都要兼容。
 */
const PICK_RE = [
  /\\?"skill\\?":\{\\?"url\\?":\\?"([^"\\]+)\\?",\\?"hash\\?":\\?"([a-f0-9]+)\\?",\\?"version\\?":\\?"([^"\\]+)\\?"/,
  /"skill":\{"url":"([^"]+)","hash":"([a-f0-9]+)","version":"([^"]+)"/,
]

/** 当前已安装的官方技能包信息；没有则返回 null。 */
export function readCurrent() {
  try {
    const j = JSON.parse(readFileSync(CURRENT_FILE, 'utf8'))
    if (j && j.version && j.dir && existsSync(j.dir)) return j
  } catch { /* 忽略 */ }
  return null
}

/** 已安装版本对应的技能目录（可直接作为 resourceBase）。 */
export function resolvedSkillDir() {
  const cur = readCurrent()
  return cur ? cur.dir : null
}

/**
 * 已安装包内的 trim-cli 路径。
 * 返回 null 表示没装官方包，调用方应继续回退到「包内 bin/ → PATH」。
 */
export function cliFromOfficial(bundledName) {
  const cur = readCurrent()
  if (!cur) return null
  const p = join(cur.dir, 'bin', bundledName)
  try {
    return existsSync(p) && statSync(p).isFile() ? p : null
  } catch {
    return null
  }
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
      headers: { 'User-Agent': UA, Accept: '*/*', Referer: PAGE_URL },
    })
  } finally {
    clearTimeout(timer)
  }
}

/** 查官方最新技能包版本。失败返回 { error }，不抛。 */
export async function checkLatest() {
  try {
    const res = await fetchWithTimeout(PAGE_URL)
    if (!res.ok) return { error: `下载页 HTTP ${res.status}` }
    const html = await res.text()
    for (const re of PICK_RE) {
      const m = html.match(re)
      if (m) return { version: m[3], url: m[1], sha256: m[2] }
    }
    return { error: '下载页里没解析到技能包信息（页面结构可能变了）' }
  } catch (error) {
    return { error: `下载页请求失败：${error?.message ?? error}` }
  }
}

/** 解压 zip。跨平台尝试 tar(bsdtar) → unzip → PowerShell Expand-Archive。 */
function extractZip(zipPath, destDir) {
  mkdirSync(destDir, { recursive: true })
  const attempts = []
  if (process.platform === 'win32') {
    attempts.push(['tar', ['-xf', zipPath, '-C', destDir]])
    attempts.push(['powershell', ['-NoProfile', '-Command',
      `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${destDir}' -Force`]])
  } else {
    attempts.push(['unzip', ['-oq', zipPath, '-d', destDir]])
    attempts.push(['tar', ['-xf', zipPath, '-C', destDir]])
  }
  const errors = []
  for (const [cmd, args] of attempts) {
    try {
      execFileSync(cmd, args, { stdio: 'ignore', timeout: 120_000 })
      return { ok: true }
    } catch (error) {
      errors.push(`${cmd}: ${error?.message ?? error}`)
    }
  }
  return { ok: false, error: errors.join(' | ') }
}

/** zip 解出来可能带一层 fnos/ 目录，找到真正的包根。 */
function locateRoot(dir) {
  if (existsSync(join(dir, 'SKILL.md'))) return dir
  for (const name of readdirSync(dir)) {
    const sub = join(dir, name)
    try {
      if (statSync(sub).isDirectory() && existsSync(join(sub, 'SKILL.md'))) return sub
    } catch { /* 忽略 */ }
  }
  return null
}

/**
 * 同步到最新官方版本。
 *
 * @param {object} opts
 * @param {string} [opts.localZip] 用户手动提供的 zip 路径（优先级最高）
 * @returns {Promise<{status:string, version?:string, source?:string, error?:string}>}
 */
export async function sync(opts = {}) {
  const log = opts.log ?? (() => {})
  mkdirSync(SKILL_HOME, { recursive: true })

  // ── 0. 用户手动提供的 zip：跳过版本比较，直接安装 ────────────────────────
  // 官方 CDN 在部分网络下 403，此时把 zip 丢进 incoming/ 再重载插件即可。
  if (!opts.localZip) {
    const incomingDir = join(SKILL_HOME, 'incoming')
    try {
      mkdirSync(incomingDir, { recursive: true })
      const zips = readdirSync(incomingDir).filter((f) => f.toLowerCase().endsWith('.zip'))
      if (zips.length) {
        const p = join(incomingDir, zips[0])
        log(`发现手动导入的 ${zips[0]}，优先安装`)
        const r = installZip(readFileSync(p), { version: 'auto', source: 'incoming', log })
        if (r.status === 'installed') {
          try { renameSync(p, `${p}.done-${Date.now()}`) } catch { /* 忽略 */ }
        }
        return r
      }
    } catch { /* 忽略 */ }
  }

  if (opts.localZip) {
    if (!existsSync(opts.localZip)) return { status: 'failed', error: `文件不存在：${opts.localZip}` }
    const buf = readFileSync(opts.localZip)
    return installZip(buf, { version: opts.assumeVersion ?? 'auto', source: 'manual', log })
  }

  // ── 1. 查官方最新版本 ────────────────────────────────────────────────────
  const latest = await checkLatest()
  if (latest.error) return { status: 'failed', error: latest.error }

  const cur = readCurrent()
  if (cur && cur.version === latest.version) {
    return { status: 'up-to-date', version: cur.version }
  }

  // ── 2. 下载：直连官方 → 镜像 ─────────────────────────────────────────────
  const sources = [
    { name: 'official', url: latest.url, expect: latest.sha256 },
    { name: 'mirror', url: MIRROR_URL, expect: null },
  ]
  const failures = []
  for (const src of sources) {
    try {
      log(`尝试从 ${src.name} 下载技能包…`)
      const res = await fetchWithTimeout(src.url)
      if (!res.ok) { failures.push(`${src.name}: HTTP ${res.status}`); continue }
      const buf = Buffer.from(await res.arrayBuffer())

      // 官方源必须哈希一致；镜像没有公布哈希，至少校验它是个 zip
      if (src.expect) {
        const got = sha256(buf)
        if (got !== src.expect) {
          failures.push(`${src.name}: SHA256 不匹配（期望 ${src.expect.slice(0, 12)}…，实得 ${got.slice(0, 12)}…）`)
          continue
        }
      } else if (buf.subarray(0, 2).toString('ascii') !== 'PK') {
        failures.push(`${src.name}: 返回的不是 zip`)
        continue
      }

      const out = installZip(buf, { version: latest.version, source: src.name, log })
      if (out.status === 'installed') return out
      failures.push(`${src.name}: ${out.error}`)
    } catch (error) {
      failures.push(`${src.name}: ${error?.message ?? error}`)
    }
  }

  return { status: 'failed', error: failures.join(' | ') }
}

/** 把 zip 内容装到版本目录并切换 current。 */
function installZip(buf, { version, source, log }) {
  const tmpZip = join(SKILL_HOME, `.incoming-${Date.now()}.zip`)
  const tmpDir = join(SKILL_HOME, `.extract-${Date.now()}`)
  try {
    writeFileSync(tmpZip, buf)
    const ex = extractZip(tmpZip, tmpDir)
    if (!ex.ok) return { status: 'failed', error: `解压失败：${ex.error}` }

    const root = locateRoot(tmpDir)
    if (!root) return { status: 'failed', error: '解压后找不到 SKILL.md' }

    // 版本号：显式指定优先；'auto' 则读包内 manifest.json
    let v = version
    if (!v || v === 'auto') {
      try { v = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8')).version || 'local' }
      catch { v = 'local' }
    }
    const finalDir = join(SKILL_HOME, `v${v}`)

    // 原子切换：先删旧的同名版本，再改名
    try { rmSync(finalDir, { recursive: true, force: true }) } catch { /* 忽略 */ }
    renameSync(root, finalDir)
    writeFileSync(CURRENT_FILE, JSON.stringify({
      version: v, dir: finalDir, at: new Date().toISOString(), source,
    }, null, 2), 'utf8')

    log(`技能包已安装 v${v}（来源 ${source}）→ ${finalDir}`)
    return { status: 'installed', version: v, source }
  } catch (error) {
    return { status: 'failed', error: `${error?.message ?? error}` }
  } finally {
    try { rmSync(tmpZip, { force: true }) } catch { /* 忽略 */ }
    try { rmSync(tmpDir, { recursive: true, force: true }) } catch { /* 忽略 */ }
  }
}
