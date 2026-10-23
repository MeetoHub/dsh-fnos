#!/usr/bin/env node
/**
 * leakscan —— 敏感内容扫描器（由 opensource-guard 技能安装）
 *
 * ⚠️ 本文件是生成物：重装技能会覆盖。要定制请写项目根的 `.leakscan.json`。
 *
 * 扫描目标：
 *   （默认）  暂存区内容        —— pre-commit 用
 *   --all     所有被跟踪文件    —— CI 用
 *   --history 全部提交新增的行  —— CI 用（防历史残留）
 *
 * 退出码：0 通过 / 1 命中
 *
 * 配置（可选，项目根 .leakscan.json）：
 *   {
 *     "allow": ["正则字符串"],
 *     "deny": [{ "name": "...", "pattern": "正则字符串" }],
 *     "skip": ["^vendor/"]
 *   }
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

// ── 默认拦截规则 ────────────────────────────────────────────────────────────
const DENY = [
  {
    name: '内网/CGNAT 地址',
    re: /\b(?:10\.\d{1,3}|127\.\d{1,3}|192\.168|172\.(?:1[6-9]|2\d|3[01])|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7]))\.\d{1,3}\.\d{1,3}\b/g,
  },
  { name: '本机用户路径', re: /[A-Za-z]:\\Users\\[^\\\s"'`]+|\/Users\/[^/\s"'`]+/g },
  { name: '邮箱地址', re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g },
  { name: 'AWS Access Key', re: /AKIA[0-9A-Z]{16}/g },
  { name: 'GitHub Token', re: /gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}/g },
  { name: '私钥', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  { name: 'Slack Token', re: /xox[baprs]-[A-Za-z0-9-]{10,}/g },
  { name: 'OpenAI 风格 Key', re: /\bsk-[A-Za-z0-9]{20,}/g },
  { name: 'JWT', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
  {
    name: '疑似硬编码凭据',
    re: /\b(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?token|refresh[_-]?token)\b\s*[:=]\s*["'][^"'\s]{8,}["']/gi,
  },
]

// ── 默认放行（按行判定）──────────────────────────────────────────────────────
const ALLOW = [
  /\bre:\s*\//,                          // 规则定义里的正则字面量（避免扫描器自引用误报）
  /\b192\.168\.1\.10\b/,                 // 文档通用示例 IP
  /\b(?:127\.0\.0\.1|0\.0\.0\.0)\b/,
  /example\.com|example\.org|localhost/,
  /noreply@github\.com|users\.noreply\.github\.com/,
  /placeholder|占位|示例|例如|如\s*\d|your-|YOUR_|<[^>]*>/,
]

// ── 默认跳过 ────────────────────────────────────────────────────────────────
const SKIP = [
  /^bin\//,
  /\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|tgz|exe|node|woff2?|ttf|otf|wasm)$/i,
  /^(?:pnpm-lock\.yaml|package-lock\.json|yarn\.lock)$/,
  /^scripts\/leakscan\.mjs$/,
]

// ── 项目配置叠加 ────────────────────────────────────────────────────────────
function loadConfig() {
  const p = join(process.cwd(), '.leakscan.json')
  if (!existsSync(p)) return
  let cfg
  try {
    cfg = JSON.parse(readFileSync(p, 'utf8'))
  } catch (e) {
    console.error(`.leakscan.json 解析失败，已忽略：${e.message}`)
    return
  }
  for (const s of cfg.allow ?? []) ALLOW.push(new RegExp(s))
  for (const s of cfg.skip ?? []) SKIP.push(new RegExp(s))
  for (const d of cfg.deny ?? []) {
    if (d?.name && d?.pattern) DENY.push({ name: d.name, re: new RegExp(d.pattern, 'g') })
  }
}
loadConfig()

// ── 工具 ────────────────────────────────────────────────────────────────────
const MODE = process.argv.includes('--history')
  ? 'history'
  : process.argv.includes('--all')
    ? 'all'
    : 'staged'

function git(args, opts = {}) {
  return execFileSync('git', args, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'], // 吞掉「新文件不在 HEAD 里」这类非错误噪音
    ...opts,
  })
}

function scanText(content, file, offsetLine, findings) {
  if (content.includes('\u0000')) return // 二进制
  const lines = content.split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    if (ALLOW.some((re) => re.test(line))) continue
    for (const rule of DENY) {
      rule.re.lastIndex = 0
      if (!rule.re.exec(line)) continue
      findings.push({ file, line: offsetLine + i + 1, rule: rule.name, text: line.trim().slice(0, 100) })
    }
  }
}

function main() {
  const findings = []

  if (MODE === 'staged' || MODE === 'all') {
    let files
    try {
      files = (MODE === 'staged'
        ? git(['diff', '--cached', '--name-only', '--diff-filter=ACM'])
        : git(['ls-files'])
      )
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean)
    } catch {
      return 0 // 不在 git 仓库里
    }

    for (const file of files) {
      if (SKIP.some((re) => re.test(file))) continue
      let content
      try {
        content = MODE === 'staged' ? git(['show', `:${file}`]) : git(['show', `HEAD:${file}`])
      } catch {
        if (MODE === 'staged') continue
        try {
          content = readFileSync(file, 'utf8') // 新文件尚未提交
        } catch {
          continue
        }
      }
      scanText(content, file, 0, findings)
    }
  }

  if (MODE === 'history') {
    let patch
    try {
      patch = git(['log', '--all', '--no-merges', '-p', '--unified=0', '--', '.', ':!bin'])
    } catch {
      return 0
    }
    let currentFile = '(未知)'
    let lineNo = 0
    for (const raw of patch.split('\n')) {
      if (raw.startsWith('+++ b/')) {
        currentFile = raw.slice(6)
        continue
      }
      const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(raw)
      if (hunk) {
        lineNo = Number(hunk[1]) - 1
        continue
      }
      if (raw.startsWith('+') && !raw.startsWith('+++')) {
        lineNo += 1
        if (SKIP.some((re) => re.test(currentFile))) continue
        scanText(raw.slice(1), currentFile, lineNo - 1, findings)
      }
    }
  }

  if (findings.length === 0) {
    if (MODE !== 'staged') console.log(`✓ 扫描通过（模式：${MODE}）`)
    return 0
  }

  console.error('')
  console.error(`✗ 发现可能泄露的敏感内容（模式：${MODE}）`)
  console.error('')
  for (const f of findings.slice(0, 50)) {
    console.error(`  ${f.file}:${f.line}  [${f.rule}]`)
    console.error(`    ${f.text}`)
  }
  if (findings.length > 50) console.error(`  …共 ${findings.length} 处`)
  console.error('')
  console.error('真敏感 → 移到 .local/（已 gitignore）并 git rm --cached；')
  console.error('误报   → 往项目根 .leakscan.json 的 allow 里加精确规则。')
  console.error('')
  return 1
}

process.exit(main())
