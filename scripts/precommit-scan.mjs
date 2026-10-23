#!/usr/bin/env node
/**
 * pre-commit 敏感内容扫描
 *
 * 扫的是**暂存区内容**（即将进入提交的东西），不是工作树 —— 这样被 .gitignore
 * 忽略的文件不会误报，而 `git add -f` 强行加进来的会被抓住。
 *
 * 设计原则：宁可拦错，不可漏放。真有例外就往下面 ALLOW 里加明确的放行规则，
 * 而不是放宽 DENY。
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

// ── 拦截规则 ────────────────────────────────────────────────────────────────
const DENY = [
  {
    name: '内网/Tailscale 地址',
    re: /\b(?:10\.\d{1,3}|127\.\d{1,3}|192\.168|172\.(?:1[6-9]|2\d|3[01])|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7]))\.\d{1,3}\.\d{1,3}\b/g,
  },
  { name: '本机用户路径', re: /[A-Za-z]:\\Users\\[^\\\s"'`]+/g },
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
  { name: '飞牛 trim token', re: /trim-access-token|web\.token\s*[:=]/g },
]

// ── 放行规则（按行判定：命中 DENY 的行若同时命中这里，则跳过）────────────────
const ALLOW = [
  /\bre:\s*\//,                          // 规则定义里的正则字面量，不是真实凭据（避免扫描器自引用误报）
  /\b192\.168\.1\.10\b/,                 // 文档里的通用示例 IP
  /\b(?:127\.0\.0\.1|0\.0\.0\.0)\b/,     // 本机回环，无敏感信息
  /example\.com|example\.org|localhost/,
  /noreply@github\.com|users\.noreply\.github\.com/,
  /placeholder|占位|示例|例如|如\s*\d|your-|YOUR_|<[^>]*>/,
]

// ── 不扫的文件（二进制 / 锁文件 / 已核验的第三方产物）───────────────────────
const SKIP = [
  /^bin\//,
  /\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|tgz|exe|node|woff2?|ttf|otf|wasm)$/i,
  /^(?:pnpm-lock\.yaml|package-lock\.json|yarn\.lock)$/,
]

function git(args, opts = {}) {
  return execFileSync('git', args, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    // 吞掉 stderr：取不到某个版本时（新文件不在 HEAD 里）不算错误，
    // 由调用方 try/catch 回落处理，不必污染输出。
    stdio: ['ignore', 'pipe', 'ignore'],
    ...opts,
  })
}

/**
 * 扫描目标：
 *   （默认）  暂存区内容 —— pre-commit 用
 *   --all     所有被跟踪的文件 —— CI 用
 *   --history 全部提交里新增过的行 —— CI 用（防止历史残留）
 */
const MODE = process.argv.includes('--history')
  ? 'history'
  : process.argv.includes('--all')
    ? 'all'
    : 'staged'

/** 对一段文本做扫描，把命中项 push 进 findings。 */
function scanText(content, file, offsetLine, findings) {
  if (content.includes('\u0000')) return // 二进制
  const lines = content.split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    if (ALLOW.some((re) => re.test(line))) continue
    for (const rule of DENY) {
      rule.re.lastIndex = 0
      const m = rule.re.exec(line)
      if (!m) continue
      findings.push({
        file,
        line: offsetLine + i + 1,
        rule: rule.name,
        text: line.trim().slice(0, 100),
      })
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
        // 暂存区取不到（已删除等）→ 跳过；HEAD 取不到（新文件尚未提交）→ 回落到磁盘
        if (MODE === 'staged') continue
        try {
          content = readFileSync(file, 'utf8')
        } catch {
          continue
        }
      }
      scanText(content, file, 0, findings)
    }
  }

  if (MODE === 'history') {
    // 汇总所有提交新增的行：只扫 '+' 开头、且不是 diff 头的行
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
  console.error('若确认无害，把例外加进 scripts/precommit-scan.mjs 的 ALLOW 规则；')
  console.error('若是真敏感信息，请移到 .local/（已被 .gitignore 忽略）后重试。')
  console.error('')
  return 1
}

process.exit(main())
