/**
 * 局域网 fnOS 设备发现。
 *
 * 目标：让用户不用手打 IP —— 点一下「自动发现」，把同一个网段里开着
 * OpenAPI 的飞牛设备列出来，点一下即填入。
 *
 * 判定依据：设备用自签证书，Subject CN 固定为 `fnOS`（实测 CN=fnOS）。
 * 所以只要能完成 TLS 握手且证书 CN 命中，就认为是飞牛设备，不需要认证。
 *
 * 性能取舍：只扫本机网段的 /24，并有并发上限与短超时。
 * 典型耗时 2–5 秒；扫不到就返回空数组，绝不阻塞界面。
 */
import { networkInterfaces } from 'node:os'
import { connect as tlsConnect } from 'node:tls'

const DEFAULT_PORT = 5667
const PROBE_TIMEOUT_MS = 700
const CONCURRENCY = 48
const MAX_HOSTS = 1024

/** 取本机所有 IPv4 私网地址对应的 /24 前缀，去重。 */
function localSubnets() {
  const out = new Set()
  for (const list of Object.values(networkInterfaces())) {
    for (const nic of list ?? []) {
      if (nic.family !== 'IPv4' || nic.internal) continue
      const parts = nic.address.split('.')
      if (parts.length !== 4) continue
      // 169.254.* 是链路本地地址（网线没 DHCP 时的自分配），扫它纯属浪费时间
      if (parts[0] === '169' && parts[1] === '254') continue
      out.add(`${parts[0]}.${parts[1]}.${parts[2]}`)
    }
  }
  return [...out]
}

/** 探测单个主机：能握手且证书 CN 命中 fnOS 即算命中。 */
function probe(host, port, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false
    const done = (value) => {
      if (settled) return
      settled = true
      try { socket?.destroy() } catch { /* 忽略 */ }
      resolve(value)
    }

    // 不传 servername：目标是 IP 地址，RFC 6066 明确不允许把 SNI 设成 IP，
    // 传了只会拿到 DEP0123 警告且被忽略。
    const socket = tlsConnect({
      host,
      port,
      rejectUnauthorized: false, // 自签证书，只为读 CN
      timeout: timeoutMs,
    })

    socket.once('secureConnect', () => {
      try {
        const cert = socket.getPeerCertificate()
        const cn = String(cert?.subject?.CN ?? '')
        const san = String(cert?.subjectaltname ?? '')
        if (/fnos/i.test(cn) || /fnos/i.test(san)) {
          done({ host, port, cn: cn || '(无 CN)' })
          return
        }
      } catch { /* 读证书失败当未命中 */ }
      done(null)
    })
    socket.once('timeout', () => done(null))
    socket.once('error', () => done(null))
  })
}

/**
 * 扫描本机各网段，返回发现的飞牛设备。
 *
 * @param {object} [opts]
 * @param {number} [opts.port]        端口，默认 5667
 * @param {number} [opts.timeoutMs]   单主机超时
 * @param {number} [opts.concurrency] 并发上限
 * @returns {Promise<{found: Array<{host,port,cn}>, scanned: number, subnets: string[]}>}
 */
export async function discoverDevices(opts = {}) {
  const port = Number(opts.port) || DEFAULT_PORT
  const timeoutMs = Number(opts.timeoutMs) || PROBE_TIMEOUT_MS
  const concurrency = Math.max(1, Number(opts.concurrency) || CONCURRENCY)

  const subnets = localSubnets()
  const hosts = []
  for (const prefix of subnets) {
    for (let i = 1; i <= 254 && hosts.length < MAX_HOSTS; i += 1) {
      hosts.push(`${prefix}.${i}`)
    }
  }
  if (hosts.length === 0) return { found: [], scanned: 0, subnets }

  const found = []
  let index = 0

  const worker = async () => {
    while (index < hosts.length) {
      const host = hosts[index]
      index += 1
      const hit = await probe(host, port, timeoutMs)
      if (hit) found.push(hit)
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, hosts.length) }, worker))

  // 按 IP 数值排序，结果稳定
  found.sort((a, b) => {
    const na = a.host.split('.').reduce((acc, n) => acc * 256 + Number(n), 0)
    const nb = b.host.split('.').reduce((acc, n) => acc * 256 + Number(n), 0)
    return na - nb
  })

  return { found, scanned: hosts.length, subnets }
}
