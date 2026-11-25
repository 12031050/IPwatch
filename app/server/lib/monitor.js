'use strict';
// monitor.js —— 主机在线探测引擎：ICMP Ping 优先 + TCP 端口兜底，防抖判定掉线/恢复，触发通知
const net = require('net');
const { spawn } = require('child_process');
const { getDb, getSetting } = require('./db');

const PROBE_TIMEOUT_MS = 3000;
const PING_TIMEOUT_MS = 1500;
let pingUnavailable = false; // 系统无 ping 命令时停用 ICMP，避免每轮无用开销

// 记录一次探测结果到延迟历史（用于趋势曲线 / 丢包率）
function recordLatency(db, hostId, ok, latency) {
  try {
    db.prepare('INSERT INTO latency_history (host_id, ts, latency, ok) VALUES (?, ?, ?, ?)')
      .run(hostId, Date.now(), ok ? latency : null, ok ? 1 : 0);
  } catch (_) { /* 历史表缺失等异常不应影响主探测流程 */ }
}

function tcpProbe(host, port, timeoutMs = PROBE_TIMEOUT_MS) {
  return new Promise(resolve => {
    const start = Date.now();
    let settled = false;
    const done = ok => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch (_) {}
      resolve(ok ? Date.now() - start : -1);
    };
    const socket = net.connect({ host, port });
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
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

// 综合可达性：ICMP 通 → 在线（解决「设备在线但配置的端口没开」被误判掉线）；
// ICMP 不通时，配置端口通也算在线（兼容禁 ping 的设备）。
// ⚠️ 不用「常见端口兜底」：中间设备（如本机 DNS/网关）回包会造成误判。
async function reachability(host, port) {
  const icmp = await icmpProbe(host);
  if (icmp >= 0) return { ok: true, latency: icmp, via: 'icmp' };
  const own = await tcpProbe(host, port, PROBE_TIMEOUT_MS);
  if (own >= 0) return { ok: true, latency: own, via: 'tcp' };
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
        ).run(h.id, h.name, `${h.host}:${h.port}`, 'up', h.last_change || now, now, duration, h.severity || 'warning');
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
        ).run(h.id, h.name, `${h.host}:${h.port}`, 'down', now, now, h.severity || 'warning');
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
