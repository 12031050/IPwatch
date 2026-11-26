'use strict';
// IPwatch server —— fnOS 统一网关模式（Unix Socket）+ 本地开发模式（PORT）
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { initDb, getDb, getSetting, setSetting, cleanupRecords, listUsers, findUser, addUser, deleteUser, countUsers } = require('./lib/db');
const { Monitor } = require('./lib/monitor');
const { sendMail, sendWx } = require('./lib/notify');

const PORT = process.env.PORT || 5001;
const SOCKET_PATH = process.env.SOCKET_PATH || '';
const GATEWAY_PREFIX = process.env.GATEWAY_PREFIX || '/app/ipwatch';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PUBLIC_DIR = path.join(__dirname, 'public');

initDb(DATA_DIR);
cleanupRecords();

// ---------- 告警级别 / 维护窗口 工具 ----------
const SEVERITY_LABEL = { info: '提示', warning: '警告', critical: '严重' };
function sevText(s) { return SEVERITY_LABEL[s] || '警告'; }

// 判断某主机当前是否处于维护窗口内（静默告警，但仍记录状态/报警）
function inMaintenance(host) {
  if (!host || !host.maint_enabled) return false;
  const start = host.maint_start, end = host.maint_end;
  if (!start || !end) return false;
  const now = new Date();
  const mins = now.getHours() * 60 + now.getMinutes();
  const toMin = s => { const [h, m] = String(s).split(':').map(Number); return h * 60 + (m || 0); };
  const a = toMin(start), b = toMin(end);
  if (a === b) return false;
  // 跨天窗口：如 23:00-06:00
  if (a < b) return mins >= a && mins < b;
  return mins >= a || mins < b;
}

// ---------- 通知配置（掉线通知与手动补发共用） ----------
function notifyConfig() {
  return {
    smtp_host: getSetting('smtp_host'), smtp_port: getSetting('smtp_port'),
    smtp_secure: getSetting('smtp_secure'), smtp_user: getSetting('smtp_user'),
    smtp_pass: getSetting('smtp_pass'), mail_from: getSetting('mail_from'), mail_to: getSetting('mail_to'),
    wx_enabled: getSetting('wx_enabled'), wx_type: getSetting('wx_type'), wx_key: getSetting('wx_key')
  };
}

// 构造掉线通知标题/正文（首次、手动补发、重复提醒共用），带告警级别
function buildDownMessage(rec, host, mode, count) {
  const sev = rec.severity || (host && host.severity) || 'warning';
  const sevTag = `【${sevText(sev)}】`;
  const ts = new Date().toLocaleString('zh-CN');
  const downAt = new Date(rec.start_at || rec.created_at).toLocaleString('zh-CN');
  const prefix = mode === 'repeat' ? `【IPwatch 重复提醒 第${count || 2}次】`
    : mode === 'resend' ? '【IPwatch 补发】' : '【IPwatch 掉线】';
  const title = `${prefix}${sevTag}${rec.host_name} 掉线提醒`;
  const modeLine = mode === 'repeat' ? `\n提醒次数：第 ${count || 2} 次（设备仍掉线）`
    : mode === 'resend' ? '\n\n—— 此条为手动补发的历史报警 ——' : '';
  const addr = rec.host_addr || (host ? (host.port ? `${host.host}:${host.port}` : host.host) : '');
  const text = `告警级别：${sevText(sev)}\n主机：${rec.host_name}（${addr}）\n掉线时间：${downAt}${modeLine}\n当前时间：${ts}\n\n—— 来自 NAS 上的 IPwatch`;
  return { title, text };
}

// 对指定报警记录重新发送通知并回写状态。
// mode: 'resend'=手动补发 | 'repeat'=持续掉线重复提醒
async function resendRecordNotify(recordId, mode) {
  mode = mode || 'resend';
  const db = getDb();
  const rec = db.prepare('SELECT * FROM records WHERE id = ?').get(recordId);
  if (!rec) return { error: '记录不存在' };
  const host = db.prepare('SELECT notify, severity FROM hosts WHERE id = ?').get(rec.host_id);
  const n = (host && host.notify) || 'default';
  const mailEnabled = getSetting('mail_enabled') === '1';
  const wxEnabled = getSetting('wx_enabled') === '1';
  const wantMail = n === 'default' ? mailEnabled : (n === 'mail' || n === 'both');
  const wantWx = n === 'default' ? wxEnabled : (n === 'wx' || n === 'both');
  const cfg = notifyConfig();
  const count = (rec.notify_count || 0) + 1;
  const { title, text } = buildDownMessage(rec, host, mode, count);
  const updates = {};
  const result = {};
  const tag = mode === 'repeat' ? '重复提醒' : '补发';
  const skipMail = n === 'none' ? '设备设为不通知' : (n === 'wx' ? '本设备仅微信通知' : '邮件通知未开启');
  const skipWx = n === 'none' ? '设备设为不通知' : (n === 'mail' ? '本设备仅邮件通知' : 'Webhook 通知未开启');
  if (wantMail) {
    const mr = await sendMail(cfg, title, text);
    updates.mail_status = mr.ok ? 'sent' : 'failed';
    updates.mail_detail = tag + '：' + mr.detail;
    result.mail = mr;
  } else {
    updates.mail_status = 'skip'; updates.mail_detail = skipMail;
    result.mail = { ok: false, detail: skipMail };
  }
  if (wantWx) {
    const wr = await sendWx(cfg, title, text);
    updates.wx_status = wr.ok ? 'sent' : 'failed';
    updates.wx_detail = tag + '：' + wr.detail;
    result.wx = wr;
  } else {
    updates.wx_status = 'skip'; updates.wx_detail = skipWx;
    result.wx = { ok: false, detail: skipWx };
  }
  // 仅当至少有一个渠道真正尝试发送时，才累加计数并更新时间戳
  if (wantMail || wantWx) {
    updates.notify_count = count;
    updates.last_notify_at = Date.now();
  }
  const sets = Object.keys(updates).map(k => `${k} = ?`).join(', ');
  db.prepare(`UPDATE records SET ${sets} WHERE id = ?`).run(...Object.values(updates), recordId);
  result.notifyCount = updates.notify_count || rec.notify_count || 0;
  return result;
}

// ---------- 通知事件处理 ----------
async function onMonitorEvent(host, event, extra) {
  const db = getDb();
  const now = new Date();
  const ts = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
  const mailEnabled = getSetting('mail_enabled') === '1';
  const wxEnabled = getSetting('wx_enabled') === '1';
  const n = host.notify || 'default';
  let wantMail = n === 'default' ? mailEnabled : (n === 'mail' || n === 'both');
  let wantWx = n === 'default' ? wxEnabled : (n === 'wx' || n === 'both');

  // ① 恢复通知开关：全局 + 每台设备（-1 跟随全局 / 1 发 / 0 不发）
  if (event === 'up') {
    let recovery = host.notify_recovery == null ? -1 : Number(host.notify_recovery);
    const globalRecovery = getSetting('notify_on_recovery') !== '0';
    const sendRecovery = recovery === -1 ? globalRecovery : recovery === 1;
    if (!sendRecovery) { wantMail = false; wantWx = false; }
  }

  // ② 维护窗口静默：在窗口内仍记录状态/报警，但不发通知
  const maintSilent = event === 'down' && inMaintenance(host);
  if (maintSilent) { wantMail = false; wantWx = false; }

  const cfg = notifyConfig();
  const sev = host.severity || 'warning';
  const sevTag = `【${sevText(sev)}】`;

  let title, text;
  if (event === 'down') {
    title = `【IPwatch 掉线】${sevTag}${host.name}`;
    text = `告警级别：${sevText(sev)}\n主机：${host.name}（${host.port ? `${host.host}:${host.port}` : host.host}）\n状态：探测失败，连续 ${host.fails || '?'} 次无响应\n时间：${ts}\n\n—— 来自 NAS 上的 IPwatch`;
  } else {
    const mins = extra && extra.duration ? Math.round(extra.duration / 60) : 0;
    const durText = mins >= 1 ? `${mins} 分钟` : `${extra.duration || '?'} 秒`;
    title = `【IPwatch 已恢复】${host.name}`;
    text = `主机：${host.name}（${host.port ? `${host.host}:${host.port}` : host.host}）\n状态：恢复在线\n掉线时长：${durText}\n时间：${ts}\n\n—— 来自 NAS 上的 IPwatch`;
  }

  const updates = {};
  const skipMailDetail = maintSilent ? '维护窗口内静默'
    : (event === 'up' && !wantMail && n !== 'none' ? '恢复通知已关闭'
    : (n === 'none' ? '设备设为不通知' : (n === 'wx' ? '本设备仅微信通知' : '邮件通知未开启')));
  const skipWxDetail = maintSilent ? '维护窗口内静默'
    : (event === 'up' && !wantWx && n !== 'none' ? '恢复通知已关闭'
    : (n === 'none' ? '设备设为不通知' : (n === 'mail' ? '本设备仅邮件通知' : 'Webhook 通知未开启')));

  if (wantMail) {
    const mr = await sendMail(cfg, title, text);
    updates.mail_status = mr.ok ? 'sent' : 'failed';
    updates.mail_detail = mr.detail;
    if (!mr.ok) console.error(`[notify] mail failed: ${mr.detail}`);
  } else {
    updates.mail_status = 'skip';
    updates.mail_detail = skipMailDetail;
  }
  if (wantWx) {
    const wr = await sendWx(cfg, title, text);
    updates.wx_status = wr.ok ? 'sent' : 'failed';
    updates.wx_detail = wr.detail;
    if (!wr.ok) console.error(`[notify] wx failed: ${wr.detail}`);
  } else {
    updates.wx_status = 'skip';
    updates.wx_detail = skipWxDetail;
  }
  // 首次掉线通知成功后，初始化通知计数（供重复提醒判断）
  if (event === 'down' && (wantMail || wantWx)) {
    updates.notify_count = 1;
    updates.last_notify_at = Date.now();
  }
  if (extra && extra.recordId && Object.keys(updates).length) {
    const sets = Object.keys(updates).map(k => `${k} = ?`).join(', ');
    db.prepare(`UPDATE records SET ${sets} WHERE id = ?`).run(...Object.values(updates), extra.recordId);
  }
}

const monitor = new Monitor(onMonitorEvent);
monitor.start();

// ---------- 持续掉线重复提醒定时器（每 1 分钟检查一次） ----------
// 对仍掉线、已启用重复提醒（repeat_notify_hours>0）的设备：距上次通知超过 N 小时则重发
function checkRepeatNotify() {
  try {
    const hours = parseInt(getSetting('repeat_notify_hours') || '0', 10) || 0;
    if (hours <= 0) return;
    // 两个渠道都没启用时无需重发
    if (getSetting('mail_enabled') !== '1' && getSetting('wx_enabled') !== '1') return;
    const db = getDb();
    const intervalMs = hours * 3600 * 1000;
    const now = Date.now();
    // 取每台当前掉线主机对应的最新一条 down 记录
    const rows = db.prepare(`
      SELECT r.* FROM records r
      JOIN hosts h ON h.id = r.host_id
      WHERE r.event = 'down' AND h.status = 'down' AND h.paused = 0
        AND r.id = (SELECT MAX(id) FROM records WHERE host_id = r.host_id AND event = 'down')
    `).all();
    for (const rec of rows) {
      const host = db.prepare('SELECT * FROM hosts WHERE id = ?').get(rec.host_id);
      if (!host || inMaintenance(host)) continue; // 维护窗口内不重复提醒
      if (host.notify === 'none') continue;        // 设备设为不通知
      const lastAt = rec.last_notify_at || rec.created_at || 0;
      if (now - lastAt >= intervalMs) {
        const count = (rec.notify_count || 1) + 1;
        console.log(`[repeat] ${host.name} 掉线已超 ${hours}h，发送第 ${count} 次提醒`);
        // 异步发送，不阻塞定时器
        resendRecordNotify(rec.id, 'repeat').catch(e => console.error('[repeat] failed:', e.message));
      }
    }
  } catch (e) { console.error('[repeat] check error:', e.message); }
}
setInterval(checkRepeatNotify, 60 * 1000);

// ---------- HTTP 基础设施 ----------
function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function readBody(req, limit = 200 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch (e) { reject(new Error('invalid json')); }
    });
    req.on('error', reject);
  });
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

function serveStatic(res, file) {
  let fp = path.join(PUBLIC_DIR, file);
  // 目录请求自动映射到目录下的 index.html（如 /intro/ → intro/index.html）
  if (fs.existsSync(fp) && fs.statSync(fp).isDirectory()) fp = path.join(fp, 'index.html');
  if (!fp.startsWith(PUBLIC_DIR) || !fs.existsSync(fp) || !fs.statSync(fp).isFile()) {
    // SPA fallback
    const idx = path.join(PUBLIC_DIR, 'index.html');
    if (fs.existsSync(idx)) {
      res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store, no-cache, must-revalidate' });
      return res.end(fs.readFileSync(idx));
    }
    res.writeHead(404); return res.end('Not Found');
  }
  // 静态资源禁用缓存：否则飞牛 WebView 会沿用旧 app.js，导致升级后改动不生效
  res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream', 'Cache-Control': 'no-store, no-cache, must-revalidate' });
  res.end(fs.readFileSync(fp));
}

// ---------- API ----------
function maskEmail(v) {
  // 邮箱地址打码：只保留前 2 位 + 域名，如 12***@qq.com
  const s = String(v || '');
  const i = s.indexOf('@');
  if (i <= 0) return s;
  return s.slice(0, Math.min(2, i)) + '***' + s.slice(i);
}

function maskSettings() {
  const keys = ['check_interval', 'retries', 'keep_days', 'mail_enabled', 'smtp_host', 'smtp_port', 'smtp_secure', 'mail_enabled', 'wx_enabled', 'wx_type', 'wx_key', 'notify_on_recovery', 'repeat_notify_hours'];
  const out = {};
  for (const k of keys) out[k] = getSetting(k) || '';
  // 含邮箱的字段打码显示，前端回传含 *** 的值会被忽略（保留原值）
  out.smtp_user = maskEmail(getSetting('smtp_user'));
  out.mail_from = maskEmail(getSetting('mail_from'));
  out.mail_to = maskEmail(getSetting('mail_to'));
  out.smtp_pass_set = !!(getSetting('smtp_pass') || '');
  out.access_password_set = !!(getSetting('access_password') || '');
  out.user_count = countUsers();
  return out;
}

// ---------- 访问控制（端口模式下局域网直达，提供应用级口令保护） ----------
// 两类凭证：① 访问密码（全局） ② 用户账户（用户名+密码）。任一通过即可。
const sessionTokens = new Set();
const userHash = (u, p) => crypto.createHash('sha256').update(`ipwatch-user|${u}|${p}`).digest('hex');
const legacyToken = () => {
  const pwd = getSetting('access_password');
  return pwd ? crypto.createHash('sha256').update('ipwatch|' + pwd).digest('hex') : '';
};

function isAuthed(req) {
  const token = String(req.headers['x-auth-token'] || '');
  if (sessionTokens.has(token)) return true;
  const expect = legacyToken();
  // 兼容重启前的旧会话 token（由访问密码派生）
  if (expect && token.length === expect.length && crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expect))) return true;
  // 无密码且无用户 = 不锁定
  return !expect && countUsers() === 0;
}

function issueToken() {
  const t = crypto.randomBytes(32).toString('hex');
  sessionTokens.add(t);
  return t;
}

function validateHost(body) {
  const name = String(body.name || '').trim().slice(0, 64);
  const host = String(body.host || '').trim().slice(0, 120);
  const portRaw = parseInt(body.port, 10);
  const port = Number.isNaN(portRaw) ? 0 : portRaw; // 留空 = 0，不用端口探测
  const interval = parseInt(body.interval_s, 10) || 30;
  const retries = parseInt(body.retries, 10) || 3;
  const grp = String(body.grp || '').trim().slice(0, 32);
  const notify = ['default', 'mail', 'wx', 'both', 'none'].includes(body.notify) ? body.notify : 'default';
  const severity = ['info', 'warning', 'critical'].includes(body.severity) ? body.severity : 'warning';
  const notifyRecovery = [-1, 0, 1].includes(Number(body.notify_recovery)) ? Number(body.notify_recovery) : -1;
  const maintEnabled = body.maint_enabled ? 1 : 0;
  const hhmm = s => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(s || '')) ? String(s) : '';
  const maintStart = hhmm(body.maint_start);
  const maintEnd = hhmm(body.maint_end);
  if (!name) return { err: '名称不能为空' };
  if (!/^([a-zA-Z0-9._-]+|\[[0-9a-fA-F:]+\])$/.test(host)) return { err: 'IP 或域名格式不正确' };
  // 端口可留空（0）：只用 Ping + ARP 判定在线，不依赖任何 TCP 端口
  if (!(port >= 0 && port <= 65535)) return { err: '端口留空或填 1-65535' };
  return {
    name, host, port, interval: Math.min(Math.max(interval, 10), 3600),
    retries: Math.min(Math.max(retries, 1), 10), grp, notify,
    severity, notifyRecovery, maintEnabled, maintStart, maintEnd
  };
}

const server = http.createServer(async (req, res) => {
  try {
    let pathname = (req.url || '/').split('?')[0];
    // 统一网关前缀剥离（兼容根路径访问）
    let p = pathname;
    if (p.startsWith(GATEWAY_PREFIX)) p = p.slice(GATEWAY_PREFIX.length) || '/';
    const userid = String(req.headers['x-trim-userid'] || 'local');

    // ---- API ----
    if (p.startsWith('/api/')) {
      const route = p.slice(4); // 去掉 /api
      const method = req.method;

      // 访问口令：除登录/状态检查外全部要求携带有效 token
      const openRoutes = ['/auth', '/auth-check', '/setup-password'];
      if (!openRoutes.includes(route) && !isAuthed(req)) {
        return sendJson(res, 401, { error: '需要访问密码' });
      }

      if (route === '/auth-check' && method === 'GET') {
        const locked = !!getSetting('access_password') || countUsers() > 0;
        const needSetup = !locked; // 从未设过密码/账户 → 前端引导首次设置
        return sendJson(res, 200, { locked, needSetup, authed: isAuthed(req) });
      }

      if (route === '/setup-password' && method === 'POST') {
        // 仅在尚未设置任何凭证时允许初始化，防止被重复调用改密码
        if (getSetting('access_password') || countUsers() > 0) return sendJson(res, 409, { error: '访问密码已初始化，请到系统设置修改' });
        const body = await readBody(req);
        const pwd = String(body.password || '');
        if (pwd.length < 4) return sendJson(res, 400, { error: '密码至少 4 位' });
        setSetting('access_password', pwd);
        setSetting('auth_setup_done', '1');
        return sendJson(res, 200, { ok: true, token: issueToken() });
      }

      if (route === '/auth' && method === 'POST') {
        const body = await readBody(req);
        const username = String(body.username || '').trim();
        const password = String(body.password || '');
        // ① 用户账户登录
        if (username) {
          const u = findUser(username);
          if (u && u.pass_hash === userHash(username, password)) {
            return sendJson(res, 200, { ok: true, token: issueToken(), user: username });
          }
          return sendJson(res, 403, { error: '用户名或密码错误' });
        }
        // ② 访问密码登录（兼容原模式）
        const pwd = getSetting('access_password');
        if (!pwd && countUsers() === 0) return sendJson(res, 200, { ok: true, token: '' });
        if (pwd && password === pwd) return sendJson(res, 200, { ok: true, token: issueToken() });
        return sendJson(res, 403, { error: '密码错误' });
      }

      // ---- 用户管理 ----
      if (route === '/users' && method === 'GET') {
        return sendJson(res, 200, listUsers().map(u => ({ ...u, pass_hash: undefined })));
      }
      if (route === '/users' && method === 'POST') {
        const body = await readBody(req);
        const username = String(body.username || '').trim().slice(0, 32);
        const password = String(body.password || '');
        if (!/^[a-zA-Z0-9_\u4e00-\u9fa5-]{1,32}$/.test(username)) return sendJson(res, 400, { error: '用户名限 1-32 位（中文/字母/数字/_/-）' });
        if (password.length < 4) return sendJson(res, 400, { error: '密码至少 4 位' });
        if (findUser(username)) return sendJson(res, 400, { error: '用户名已存在' });
        addUser(username, userHash(username, password));
        return sendJson(res, 200, { ok: true });
      }
      const userIdMatch = route.match(/^\/users\/(\d+)$/);
      if (userIdMatch && method === 'DELETE') {
        deleteUser(parseInt(userIdMatch[1], 10));
        return sendJson(res, 200, { ok: true });
      }

      if (route === '/status' && method === 'GET') {
        return sendJson(res, 200, {
          app: 'IPwatch', version: '0.7.0', node: process.version,
          uptime: Math.round(process.uptime()), dataDir: DATA_DIR, user: userid
        });
      }

      if (route === '/summary' && method === 'GET') {
        const db = getDb();
        const total = db.prepare('SELECT COUNT(*) c FROM hosts').get().c;
        const up = db.prepare("SELECT COUNT(*) c FROM hosts WHERE status = 'up'").get().c;
        const down = db.prepare("SELECT COUNT(*) c FROM hosts WHERE status = 'down'").get().c;
        const paused = db.prepare('SELECT COUNT(*) c FROM hosts WHERE paused = 1').get().c;
        const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
        const todayAlerts = db.prepare("SELECT COUNT(*) c FROM records WHERE event = 'down' AND created_at >= ?").get(dayStart.getTime()).c;
        return sendJson(res, 200, { total, up, down, paused, todayAlerts });
      }

      if (route === '/hosts' && method === 'GET') {
        const rows = getDb().prepare('SELECT * FROM hosts ORDER BY id').all();
        return sendJson(res, 200, rows);
      }

      if (route === '/hosts' && method === 'POST') {
        const body = await readBody(req);
        const v = validateHost(body);
        if (v.err) return sendJson(res, 400, { error: v.err });
        const r = getDb().prepare(
          'INSERT INTO hosts (name, host, port, interval_s, retries, grp, notify, severity, notify_recovery, maint_enabled, maint_start, maint_end, creator, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
        ).run(v.name, v.host, v.port, v.interval, v.retries, v.grp, v.notify, v.severity, v.notifyRecovery, v.maintEnabled, v.maintStart, v.maintEnd, userid, Date.now());
        return sendJson(res, 200, { id: r.lastInsertRowid });
      }

      const hostIdMatch = route.match(/^\/hosts\/(\d+)(\/check)?$/);
      if (hostIdMatch) {
        const id = parseInt(hostIdMatch[1], 10);
        const db = getDb();
        const host = db.prepare('SELECT * FROM hosts WHERE id = ?').get(id);
        if (!host) return sendJson(res, 404, { error: '主机不存在' });

        if (hostIdMatch[2] === '/check' && method === 'POST') {
          const r = await monitor.probeOnce(host);
          const fresh = db.prepare('SELECT last_latency, last_check FROM hosts WHERE id = ?').get(id);
          return sendJson(res, 200, { ...r, ...fresh });
        }
        if (method === 'PUT') {
          const body = await readBody(req);
          const v = validateHost(body);
          if (v.err) return sendJson(res, 400, { error: v.err });
          const paused = body.paused !== undefined ? (body.paused ? 1 : 0) : host.paused;
          db.prepare('UPDATE hosts SET name = ?, host = ?, port = ?, interval_s = ?, retries = ?, grp = ?, notify = ?, severity = ?, notify_recovery = ?, maint_enabled = ?, maint_start = ?, maint_end = ?, paused = ? WHERE id = ?')
            .run(v.name, v.host, v.port, v.interval, v.retries, v.grp, v.notify, v.severity, v.notifyRecovery, v.maintEnabled, v.maintStart, v.maintEnd, paused, id);
          return sendJson(res, 200, { ok: true });
        }
        if (method === 'DELETE') {
          db.prepare('DELETE FROM hosts WHERE id = ?').run(id);
          return sendJson(res, 200, { ok: true });
        }
      }

      if (route === '/records' && method === 'GET') {
        const url = new URL(req.url, 'http://x');
        const limit = Math.min(parseInt(url.searchParams.get('limit') || '100', 10) || 100, 500);
        const type = url.searchParams.get('type');
        const db = getDb();
        let rows;
        if (type === 'down' || type === 'up') {
          rows = db.prepare('SELECT * FROM records WHERE event = ? ORDER BY created_at DESC LIMIT ?').all(type, limit);
        } else {
          rows = db.prepare('SELECT * FROM records ORDER BY created_at DESC LIMIT ?').all(limit);
        }
        return sendJson(res, 200, rows);
      }

      if (route === '/records' && method === 'DELETE') {
        getDb().prepare('DELETE FROM records').run();
        return sendJson(res, 200, { ok: true });
      }

      // 手动补发指定记录的通知（历史记录 / 验证通知关联）
      const recNotifyMatch = route.match(/^\/records\/(\d+)\/notify$/);
      if (recNotifyMatch && method === 'POST') {
        const id = parseInt(recNotifyMatch[1], 10);
        const result = await resendRecordNotify(id);
        if (result.error) return sendJson(res, 404, result);
        return sendJson(res, 200, result);
      }

      // 补发全部仍掉线且未成功送达的报警（一键补发 / 配置邮件后自动补发）
      if (route === '/records/notify-all' && method === 'POST') {
        const body = await readBody(req).catch(() => ({}));
        // 默认只补发"仍掉线且未成功送达"的记录；force=1 时补发全部掉线记录
        const force = body && body.force === 1;
        const db = getDb();
        let rows;
        if (force) {
          rows = db.prepare("SELECT id FROM records WHERE event = 'down' ORDER BY id DESC").all();
        } else {
          rows = db.prepare(
            "SELECT id FROM records WHERE event = 'down' AND (mail_status IS NULL OR mail_status != 'sent' OR wx_status IS NULL OR wx_status != 'sent') ORDER BY id DESC"
          ).all();
        }
        let mailOk = 0, wxOk = 0, done = 0;
        for (const row of rows) {
          try {
            const r = await resendRecordNotify(row.id);
            if (r.mail && r.mail.ok) mailOk++;
            if (r.wx && r.wx.ok) wxOk++;
            done++;
          } catch (e) { console.error('[notify-all] record', row.id, e.message); }
        }
        return sendJson(res, 200, { total: rows.length, done, mailOk, wxOk });
      }

      // 报警记录：确认 / 取消确认 + 处理备注
      const recAckMatch = route.match(/^\/records\/(\d+)\/ack$/);
      if (recAckMatch && method === 'POST') {
        const id = parseInt(recAckMatch[1], 10);
        const body = await readBody(req);
        const db = getDb();
        const rec = db.prepare('SELECT id FROM records WHERE id = ?').get(id);
        if (!rec) return sendJson(res, 404, { error: '记录不存在' });
        const acked = body.acked ? 1 : 0;
        const note = String(body.note || '').slice(0, 500);
        const actor = body.actor || userid || 'local';
        if (acked) {
          db.prepare('UPDATE records SET acked = 1, ack_by = ?, ack_at = ?, note = ? WHERE id = ?')
            .run(actor, Date.now(), note, id);
        } else {
          db.prepare('UPDATE records SET acked = 0, ack_by = ?, ack_at = 0, note = ? WHERE id = ?')
            .run('', note, id);
        }
        return sendJson(res, 200, { ok: true });
      }

      // 延迟 / 丢包历史曲线：GET /hosts/:id/latency?hours=24
      const latencyMatch = route.match(/^\/hosts\/(\d+)\/latency$/);
      if (latencyMatch && method === 'GET') {
        const id = parseInt(latencyMatch[1], 10);
        const url = new URL(req.url, 'http://x');
        const hours = Math.min(Math.max(parseInt(url.searchParams.get('hours') || '24', 10) || 24, 1), 720);
        const since = Date.now() - hours * 3600 * 1000;
        const db = getDb();
        const rows = db.prepare(
          'SELECT ts, latency, ok FROM latency_history WHERE host_id = ? AND ts >= ? ORDER BY ts ASC'
        ).all(id, since);
        const total = rows.length;
        const failed = rows.filter(r => !r.ok).length;
        const okRows = rows.filter(r => r.ok && r.latency != null);
        const avg = okRows.length ? Math.round(okRows.reduce((s, r) => s + r.latency, 0) / okRows.length) : 0;
        const max = okRows.length ? Math.round(Math.max(...okRows.map(r => r.latency))) : 0;
        const min = okRows.length ? Math.round(Math.min(...okRows.map(r => r.latency))) : 0;
        return sendJson(res, 200, { points: rows, total, failed, lossRate: total ? +(failed / total * 100).toFixed(1) : 0, avg, max, min, hours });
      }

      if (route === '/settings' && method === 'GET') {
        return sendJson(res, 200, maskSettings());
      }

      if (route === '/settings' && method === 'POST') {
        const body = await readBody(req);
        const allowed = ['check_interval', 'retries', 'keep_days', 'mail_enabled', 'smtp_host', 'smtp_port', 'smtp_secure', 'smtp_user', 'mail_from', 'mail_to', 'wx_enabled', 'wx_type', 'wx_key', 'notify_on_recovery', 'repeat_notify_hours'];
        for (const k of allowed) {
          // 含 *** 的打码值 = 前端未修改，保留原值
          if (body[k] !== undefined && !String(body[k]).includes('***')) setSetting(k, body[k]);
        }
        // 密码：空字符串表示不修改
        if (typeof body.smtp_pass === 'string' && body.smtp_pass.length > 0) setSetting('smtp_pass', body.smtp_pass);
        // 访问密码：显式传空串表示清除，非空则更新
        if (typeof body.access_password === 'string') {
          if (body.access_password.length > 0) setSetting('access_password', body.access_password);
          else setSetting('access_password', '');
        }
        return sendJson(res, 200, { ok: true });
      }

      if (route === '/notify/test' && method === 'POST') {
        const cfg = {
          smtp_host: getSetting('smtp_host'), smtp_port: getSetting('smtp_port'),
          smtp_secure: getSetting('smtp_secure'), smtp_user: getSetting('smtp_user'),
          smtp_pass: getSetting('smtp_pass'), mail_from: getSetting('mail_from'), mail_to: getSetting('mail_to'),
          wx_type: getSetting('wx_type'), wx_key: getSetting('wx_key')
        };
        const now = new Date().toLocaleString('zh-CN');
        const mail = await sendMail(cfg, '【IPwatch】测试邮件', `这是一条测试通知。\n时间：${now}\n\n—— 来自 NAS 上的 IPwatch`);
        const wx = await sendWx(cfg, '【IPwatch】测试推送', `这是一条测试通知。\n时间：${now}\n\n—— 来自 NAS 上的 IPwatch`);
        return sendJson(res, 200, { mail, wx });
      }

      // ---- 系统备份 / 还原 ----
      if (route === '/backup' && method === 'GET') {
        const db = getDb();
        const data = {
          app: 'ipwatch', backup_version: 2,
          exported_at: Date.now(),
          settings: Object.fromEntries(db.prepare('SELECT key, value FROM settings').all().map(r => [r.key, r.value])),
          hosts: db.prepare('SELECT * FROM hosts ORDER BY id').all(),
          records: db.prepare('SELECT * FROM records ORDER BY id').all(),
          latency: db.prepare('SELECT * FROM latency_history ORDER BY id').all(),
          users: db.prepare('SELECT username, pass_hash, created_at FROM users ORDER BY id').all()
        };
        return sendJson(res, 200, data);
      }
      if (route === '/restore' && method === 'POST') {
        const body = await readBody(req, 50 * 1024 * 1024); // 备份文件最大 50MB
        if (body.app !== 'ipwatch' || !Array.isArray(body.hosts)) return sendJson(res, 400, { error: '不是有效的 IPwatch 备份文件' });
        const db = getDb();
        db.exec('DELETE FROM records; DELETE FROM hosts; DELETE FROM users; DELETE FROM settings; DELETE FROM latency_history;');
        if (body.settings && typeof body.settings === 'object') {
          const ins = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)');
          for (const [k, v] of Object.entries(body.settings)) ins.run(k, String(v));
        }
        const ih = db.prepare('INSERT INTO hosts (id, name, host, port, interval_s, retries, grp, notify, severity, notify_recovery, maint_enabled, maint_start, maint_end, paused, status, fails, last_change, last_latency, last_check, creator, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
        for (const h of body.hosts) ih.run(h.id, h.name, h.host, h.port, h.interval_s, h.retries, h.grp || '', h.notify || 'default', h.severity || 'warning', h.notify_recovery == null ? -1 : h.notify_recovery, h.maint_enabled || 0, h.maint_start || '', h.maint_end || '', h.paused, h.status, h.fails, h.last_change, h.last_latency, h.last_check, h.creator, h.created_at);
        const ir = db.prepare('INSERT INTO records (id, host_id, host_name, host_addr, event, start_at, created_at, duration_s, mail_status, mail_detail, wx_status, wx_detail, severity, acked, ack_by, ack_at, note, notify_count, last_notify_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
        for (const r of (body.records || [])) ir.run(r.id, r.host_id, r.host_name, r.host_addr, r.event, r.start_at, r.created_at, r.duration_s, r.mail_status, r.mail_detail, r.wx_status, r.wx_detail, r.severity || '', r.acked || 0, r.ack_by || '', r.ack_at || 0, r.note || '', r.notify_count || 0, r.last_notify_at || 0);
        if (Array.isArray(body.latency)) {
          const il = db.prepare('INSERT INTO latency_history (id, host_id, ts, latency, ok) VALUES (?, ?, ?, ?, ?)');
          for (const l of body.latency) il.run(l.id, l.host_id, l.ts, l.latency, l.ok);
        }
        const iu = db.prepare('INSERT INTO users (username, pass_hash, created_at) VALUES (?, ?, ?)');
        for (const u of (body.users || [])) iu.run(u.username, u.pass_hash, u.created_at);
        // 还原后同步自增序号，避免新记录 ID 冲突
        db.exec("UPDATE sqlite_sequence SET seq = (SELECT MAX(id) FROM hosts) WHERE name = 'hosts';" +
                "UPDATE sqlite_sequence SET seq = (SELECT MAX(id) FROM records) WHERE name = 'records';" +
                "UPDATE sqlite_sequence SET seq = (SELECT MAX(id) FROM latency_history) WHERE name = 'latency_history';");
        cleanupRecords();
        return sendJson(res, 200, { ok: true, hosts: body.hosts.length, records: (body.records || []).length });
      }

      return sendJson(res, 404, { error: 'unknown api route' });
    }

    // ---- 静态资源 ----
    if (req.method !== 'GET') { res.writeHead(405); return res.end(); }
    if (p === '/' || p === '/index.html') return serveStatic(res, 'index.html');
    return serveStatic(res, p.replace(/^\/+/, ''));
  } catch (e) {
    console.error('[server]', e.message);
    try { sendJson(res, 500, { error: e.message }); } catch (_) {}
  }
});

// ---------- 启动 ----------
process.on('SIGTERM', () => { monitor.stop(); process.exit(0); });
process.on('SIGINT', () => { monitor.stop(); process.exit(0); });

if (SOCKET_PATH) {
  try { fs.rmSync(SOCKET_PATH, { force: true }); } catch (_) {}
  server.listen(SOCKET_PATH, () => {
    console.log(`IPwatch server listening on ${SOCKET_PATH} (gateway: ${GATEWAY_PREFIX})`);
    console.log(`data dir: ${DATA_DIR}`);
  });
  // 网关转发进程可能属不同用户，放开 socket 权限
  setInterval(() => { try { fs.chmodSync(SOCKET_PATH, 0o666); } catch (_) {} }, 3000).unref();
} else {
  server.listen(PORT, () => {
    console.log(`IPwatch server running at http://localhost:${PORT}${GATEWAY_PREFIX}`);
    console.log(`data dir: ${DATA_DIR}`);
  });
}
