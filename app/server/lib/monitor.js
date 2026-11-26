'use strict';
// monitor.js —— 主机在线探测引擎：ICMP Ping → TCP（含 RST 判活）→ 同网段 ARP 兜底
// 端口可留空：port=0 时不做 TCP 探测，仅用 Ping / ARP 判定在线，满足"只有 IP 也要能检测"的场景
const net = require('net');
const fs = require('fs');
const os = require('os');
const dgram = require('dgram');
const { spawn } = require('child_process');
const { getDb, getSetting } = require('./db');

const PROBE_TIMEOUT_MS = 3000;
const PING_TIMEOUT_MS = 1500;
const ARP_TIMEOUT_MS = 900;
let pingUnavailable = false; // 系统无 ping 命令时停用 ICMP，避免每轮无用开销

// 记录一次探测结果到延迟历史（用于趋势曲线 / 丢包率）
function recordLatency(db, hostId, ok, latency) {
  try {
    db.prepare('INSERT INTO latency_history (host_id, ts, latency, ok) VALUES (?, ?, ?, ?)')
      .run(hostId, Date.now(), ok ? latency : null, ok ? 1 : 0);
  } catch (_) { /* 历史表缺失等异常不应影响主探测流程 */ }
}

// TCP 探测：connect 成功 = 在线；ECONNREFUSED/ECONNRESET（主机回 RST）= 端口没开但主机在线；
// 只有超时/网络不可达才算失败。这样门禁机、摄像头等"没有配的端口"也不会被误判掉线。
function tcpProbe(host, port, timeoutMs = PROBE_TIMEOUT_MS) {
  return new Promise(resolve => {
    if (!(port >= 1 && port <= 65535)) return resolve(-1); // 端口留空：不做 TCP 探测
    const start = Date.now();
    let settled = false;
    const done = (ok, via) => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch (_) {}
      resolve(ok ? Math.max(1, Date.now() - start) : -1);
    };
    const socket = net.connect({ host, port });
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('error', e => {
      const code = e && e.code;
      if (code === 'ECONNREFUSED' || code === 'ECONNRESET') done(true);
      else done(false);
    });
    socket.once('timeout', () => done(false));
  });
}

// 同网段 ARP 探测：先发一个 UDP 包触发内核 ARP 解析，再读 /proc/net/arp 看是否拿到 MAC。
// 不依赖端口、不依赖设备是否回 Ping——只要网卡在线并响应 ARP 即为在线。仅对同网段 IPv4 有效。
function localIPv4() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push({ addr: ni.address.split('.').map(Number), mask: ni.netmask.split('.').map(Number) });
    }
  }
  return out;
}
function sameLan(host) {
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(host)) return false;
  const ip = host.split('.').map(Number);
  return localIPv4().some(n => ip.every((v, i) => (v & n.mask[i]) === (n.addr[i] & n.mask[i])));
}
function arpProbe(host, timeoutMs = ARP_TIMEOUT_MS) {
  if (process.platform !== 'linux' || !sameLan(host)) return Promise.resolve(-1);
  return new Promise(resolve => {
    let sock;
    try {
      sock = dgram.createSocket('udp4');
      sock.on('error', () => {});
      sock.send(Buffer.from([0]), 9, host, () => { try { sock.close(); } catch (_) {} });
    } catch (_) { try { sock && sock.close(); } catch (_) {} }
    const deadline = Date.now() + timeoutMs;
    const check = () => {
      try {
        const lines = fs.readFileSync('/proc/net/arp', 'utf8').split('\n').slice(1);
        for (const line of lines) {
          const c = line.trim().split(/\s+/);
          if (c[0] === host && parseInt(c[2], 16) & 2 && c[3] && !/^00:00:00:00:00:00$/i.test(c[3])) {
            try { sock && sock.close(); } catch (_) {}
            return resolve(1);
          }
        }
      } catch (_) {}
      if (Date.now() >= deadline) { try { sock && sock.close(); } catch (_) {} return resolve(-1); }
      setTimeout(check, 120);
    };
    setTimeout(check, 150);
  });
}

// ICMP ping：调用系统 ping（飞牛基础系统自带 iputils-ping）。
// 注意：第三方应用以低权用户运行，若内核 ping_group_range 不允许，退出码非 0，会自动回退 TCP，不影响判定。
function icmpProbe(host, timeoutMs = PING_TIMEOUT_MS) {
  return new Promise(resolve => {
    if (pingUnavailable) return resolve(-1);
    const start = Date.now();
    const args = process.platform === 'win32'
      ? ['-n', '1', '-w', String(timeoutMs), host]
      : ['-c', '1', '-W', String(Math.ceil(timeoutMs / 1000)), host];
    let settled = false, child;
    const finish = (ok, noCmd) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (noCmd) pingUnavailable = true;
      resolve(ok ? Math.max(1, Date.now() - start) : -1);
    };
    try {
      child = spawn('ping', args, { stdio: 'ignore' });
      child.once('error', e => finish(false, e && e.code === 'ENOENT'));
      child.once('close', code => finish(code === 0, false));
    } catch (_) { return finish(false, true); }
    const timer = setTimeout(() => { try { child.kill(); } catch (_) {} finish(false, false); }, timeoutMs + 400);
  });
}

// 综合可达性（端口可留空）：
// ① ICMP 通 → 在线；
// ② 配了端口 → TCP 连上或收到 RST 都算在线（RST 说明主机活着、只是端口没开）；
// ③ 同网段 ARP 拿到 MAC → 在线（不依赖 ping 和端口，专治禁 ping/无端口的设备）。
// ⚠️ 不用「常见端口兜底」：中间设备（如本机 DNS/网关）回包会造成误判。
async function reachability(host, port) {
  const icmp = await icmpProbe(host);
  if (icmp >= 0) return { ok: true, latency: icmp, via: 'icmp' };
  const own = await tcpProbe(host, port, PROBE_TIMEOUT_MS);
  if (own >= 0) return { ok: true, latency: own, via: 'tcp' };
  const arp = await arpProbe(host);
  if (arp >= 0) return { ok: true, latency: arp, via: 'arp' };
  return { ok: false, latency: -1, via: '' };
}

class Monitor {
  constructor(onEvent) {
    this.onEvent = onEvent;          // async (host, event:'down'|'up', extra) => void
    this.state = new Map();          // id -> { nextCheck, probing }
    this.timer = null;
    this.dailyTimer = null;
    this.scanning = false;
  }

  defaults() {
    return {
      interval: Math.max(10, parseInt(getSetting('check_interval') || '30', 10) || 30),
      retries: Math.max(1, parseInt(getSetting('retries') || '3', 10) || 3)
    };
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick().catch(e => console.error('[monitor] tick error:', e.message)), 5000);
    // 每天凌晨 4 点清理过期记录
    this.dailyTimer = setInterval(() => {
      const { cleanupRecords } = require('./db');
      const n = cleanupRecords();
      if (n > 0) console.log(`[monitor] cleaned ${n} expired records`);
    }, 6 * 3600 * 1000);
    console.log('[monitor] started');
  }

  stop() {
    clearInterval(this.timer);
    clearInterval(this.dailyTimer);
    this.timer = null;
    this.dailyTimer = null;
  }

  async tick() {
    if (this.scanning) return;
    this.scanning = true;
    try {
      const now = Date.now();
      const hosts = getDb().prepare('SELECT * FROM hosts WHERE paused = 0').all();
      const def = this.defaults();
      for (const h of hosts) {
        let st = this.state.get(h.id);
        if (!st) { st = { nextCheck: 0, probing: false }; this.state.set(h.id, st); }
        if (st.probing) continue;
        const interval = Math.max(10, h.interval_s || def.interval) * 1000;
        if (now < st.nextCheck) continue;
        st.nextCheck = now + interval;
        st.probing = true;
        this.probeHost(h, def).catch(e => console.error(`[monitor] probe ${h.name}:`, e.message)).finally(() => { st.probing = false; });
      }
    } finally {
      this.scanning = false;
    }
  }

  async probeHost(h, def) {
    const db = getDb();
    const now = Date.now();
    const probe = await reachability(h.host, h.port);
    const latency = probe.latency;
    const retries = Math.max(1, h.retries || def.retries);

    // 每次探测都写入延迟历史（无论在线/掉线），供趋势曲线使用
    recordLatency(db, h.id, latency >= 0, latency >= 0 ? latency : null);

    if (latency >= 0) {
      // 探测成功
      if (h.status === 'down') {
        const duration = Math.max(1, Math.round((now - (h.last_change || now)) / 1000));
        db.prepare('UPDATE hosts SET status = ?, fails = 0, last_change = ?, last_latency = ?, last_check = ? WHERE id = ?')
          .run('up', now, latency, now, h.id);
        const r = db.prepare(
          'INSERT INTO records (host_id, host_name, host_addr, event, start_at, created_at, duration_s, severity) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
        ).run(h.id, h.name, h.port ? `${h.host}:${h.port}` : h.host, 'up', h.last_change || now, now, duration, h.severity || 'warning');
        if (this.onEvent) this.onEvent({ ...h, status: 'up' }, 'up', { recordId: r.lastInsertRowid, duration });
      } else {
        // 首次探测成功（unknown -> up）时，把在线起始时间记为现在，避免"保持在线 2 万天"
        const since = h.status === 'up' ? (h.last_change || now) : now;
        db.prepare('UPDATE hosts SET status = ?, fails = 0, last_change = ?, last_latency = ?, last_check = ? WHERE id = ?')
          .run('up', since, latency, now, h.id);
      }
    } else {
      // 探测失败
      const fails = (h.fails || 0) + 1;
      if (fails >= retries && h.status !== 'down') {
        db.prepare('UPDATE hosts SET status = ?, fails = ?, last_change = ?, last_latency = NULL, last_check = ? WHERE id = ?')
          .run('down', fails, now, now, h.id);
        const r = db.prepare(
          'INSERT INTO records (host_id, host_name, host_addr, event, start_at, created_at, severity) VALUES (?, ?, ?, ?, ?, ?, ?)'
        ).run(h.id, h.name, h.port ? `${h.host}:${h.port}` : h.host, 'down', now, now, h.severity || 'warning');
        if (this.onEvent) this.onEvent({ ...h, status: 'down', fails }, 'down', { recordId: r.lastInsertRowid });
      } else {
        db.prepare('UPDATE hosts SET fails = ?, last_check = ? WHERE id = ?').run(fails, now, h.id);
      }
    }
  }

  // 手动立即探测（不触发状态机/通知，只返回结果）
  async probeOnce(h) {
    const probe = await reachability(h.host, h.port);
    const db = getDb();
    if (probe.ok) {
      db.prepare('UPDATE hosts SET last_latency = ?, last_check = ? WHERE id = ?').run(probe.latency, Date.now(), h.id);
    } else {
      db.prepare('UPDATE hosts SET last_check = ? WHERE id = ?').run(Date.now(), h.id);
    }
    recordLatency(db, h.id, probe.ok, probe.ok ? probe.latency : null);
    return { ok: probe.ok, latency: probe.latency, via: probe.via };
  }
}

module.exports = { Monitor, tcpProbe };
