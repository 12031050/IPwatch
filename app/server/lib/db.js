'use strict';
// db.js —— SQLite 存储（node:sqlite，随 Node 22 运行时内置，零原生编译依赖）
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

let db = null;

const DEFAULT_SETTINGS = {
  check_interval: '30',     // 探测间隔（秒）
  retries: '3',             // 连续失败多少次判定掉线
  keep_days: '90',          // 报警记录保留天数
  mail_enabled: '0',
  smtp_host: '',
  smtp_port: '465',
  smtp_secure: '1',         // 1=SSL(465) 0=STARTTLS(587)
  smtp_user: '',
  smtp_pass: '',
  mail_from: '',
  mail_to: '',
  wx_enabled: '0',
  wx_type: 'serverchan',    // serverchan | wecom | dingtalk | feishu | custom
  wx_key: '',               // Server酱 SendKey 或 各类机器人 Webhook URL
  notify_on_recovery: '1',  // 全局：设备恢复时是否发通知 1=发 0=不发
  repeat_notify_hours: '0', // 持续掉线重复提醒间隔（小时），0=关闭
  access_password: '',      // 访问密码（空 = 不锁定页面）
  auth_setup_done: '0'      // 是否已完成首次密码初始化
};

function initDb(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  db = new DatabaseSync(path.join(dataDir, 'ipwatch.db'));
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS hosts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      host TEXT NOT NULL,
      port INTEGER NOT NULL,
      interval_s INTEGER NOT NULL DEFAULT 30,
      retries INTEGER NOT NULL DEFAULT 3,
      grp TEXT NOT NULL DEFAULT '',
      notify TEXT NOT NULL DEFAULT 'default',
      severity TEXT NOT NULL DEFAULT 'warning',   -- info | warning | critical 告警级别
      notify_recovery INTEGER NOT NULL DEFAULT -1, -- -1=跟随全局 1=恢复时发通知 0=不发
      maint_enabled INTEGER NOT NULL DEFAULT 0,   -- 维护窗口开关
      maint_start TEXT NOT NULL DEFAULT '',        -- 维护开始 HH:MM
      maint_end TEXT NOT NULL DEFAULT '',          -- 维护结束 HH:MM（可跨天）
      paused INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'unknown',
      fails INTEGER NOT NULL DEFAULT 0,
      last_change INTEGER NOT NULL DEFAULT 0,
      last_latency REAL,
      last_check INTEGER NOT NULL DEFAULT 0,
      creator TEXT DEFAULT '',
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      host_id INTEGER NOT NULL,
      host_name TEXT NOT NULL,
      host_addr TEXT NOT NULL,
      event TEXT NOT NULL,            -- down | up | notify_failed
      start_at INTEGER NOT NULL,      -- 掉线发生时间
      created_at INTEGER NOT NULL,    -- 记录写入时间
      duration_s INTEGER,             -- 掉线持续秒数（恢复记录用）
      mail_status TEXT DEFAULT '',    -- sent | failed | skip
      mail_detail TEXT DEFAULT '',
      wx_status TEXT DEFAULT '',
      wx_detail TEXT DEFAULT '',
      severity TEXT DEFAULT '',        -- 触发时的告警级别快照
      acked INTEGER NOT NULL DEFAULT 0, -- 是否已确认 0/1
      ack_by TEXT DEFAULT '',           -- 确认人
      ack_at INTEGER DEFAULT 0,         -- 确认时间
      note TEXT DEFAULT '',             -- 处理备注
      notify_count INTEGER NOT NULL DEFAULT 0,  -- 已发送通知次数（含首次）
      last_notify_at INTEGER DEFAULT 0          -- 上次发送通知的时间戳
    );
    CREATE TABLE IF NOT EXISTS latency_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      host_id INTEGER NOT NULL,
      ts INTEGER NOT NULL,
      latency REAL,                     -- 探测延迟 ms；掉线为 NULL
      ok INTEGER NOT NULL DEFAULT 1     -- 1=在线 0=掉线
    );
    CREATE INDEX IF NOT EXISTS idx_latency_host_ts ON latency_history(host_id, ts);
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      pass_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);
  // 旧版本数据库自动补列（幂等：已存在则跳过）
  const hostCols = db.prepare('PRAGMA table_info(hosts)').all().map(c => c.name);
  if (!hostCols.includes('grp')) db.exec("ALTER TABLE hosts ADD COLUMN grp TEXT NOT NULL DEFAULT ''");
  if (!hostCols.includes('notify')) db.exec("ALTER TABLE hosts ADD COLUMN notify TEXT NOT NULL DEFAULT 'default'");
  if (!hostCols.includes('severity')) db.exec("ALTER TABLE hosts ADD COLUMN severity TEXT NOT NULL DEFAULT 'warning'");
  if (!hostCols.includes('notify_recovery')) db.exec("ALTER TABLE hosts ADD COLUMN notify_recovery INTEGER NOT NULL DEFAULT -1");
  if (!hostCols.includes('maint_enabled')) db.exec("ALTER TABLE hosts ADD COLUMN maint_enabled INTEGER NOT NULL DEFAULT 0");
  if (!hostCols.includes('maint_start')) db.exec("ALTER TABLE hosts ADD COLUMN maint_start TEXT NOT NULL DEFAULT ''");
  if (!hostCols.includes('maint_end')) db.exec("ALTER TABLE hosts ADD COLUMN maint_end TEXT NOT NULL DEFAULT ''");

  const recCols = db.prepare('PRAGMA table_info(records)').all().map(c => c.name);
  if (!recCols.includes('severity')) db.exec("ALTER TABLE records ADD COLUMN severity TEXT DEFAULT ''");
  if (!recCols.includes('acked')) db.exec("ALTER TABLE records ADD COLUMN acked INTEGER NOT NULL DEFAULT 0");
  if (!recCols.includes('ack_by')) db.exec("ALTER TABLE records ADD COLUMN ack_by TEXT DEFAULT ''");
  if (!recCols.includes('ack_at')) db.exec("ALTER TABLE records ADD COLUMN ack_at INTEGER DEFAULT 0");
  if (!recCols.includes('note')) db.exec("ALTER TABLE records ADD COLUMN note TEXT DEFAULT ''");
  if (!recCols.includes('notify_count')) db.exec("ALTER TABLE records ADD COLUMN notify_count INTEGER NOT NULL DEFAULT 0");
  if (!recCols.includes('last_notify_at')) db.exec("ALTER TABLE records ADD COLUMN last_notify_at INTEGER DEFAULT 0");

  const ins = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) ins.run(k, v);
  cleanupRecords();
  return db;
}

function getDb() {
  if (!db) throw new Error('DB not initialized');
  return db;
}

function getSetting(key) {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : undefined;
}

function setSetting(key, value) {
  getDb().prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, String(value));
}

// ---------- 用户管理 ----------
function listUsers() {
  return getDb().prepare('SELECT id, username, created_at FROM users ORDER BY id').all();
}
function findUser(username) {
  return getDb().prepare('SELECT * FROM users WHERE username = ?').get(String(username || ''));
}
function addUser(username, passHash) {
  return getDb().prepare('INSERT INTO users (username, pass_hash, created_at) VALUES (?, ?, ?)')
    .run(String(username), String(passHash), Date.now());
}
function deleteUser(id) {
  return getDb().prepare('DELETE FROM users WHERE id = ?').run(id);
}
function countUsers() {
  return getDb().prepare('SELECT COUNT(*) c FROM users').get().c;
}

// 按保留天数清理旧记录（启动时 + 每天一次由 server 调用）
function cleanupRecords() {
  const days = parseInt(getSetting('keep_days') || '90', 10) || 90;
  const ts = Date.now() - days * 86400 * 1000;
  const r = getDb().prepare('DELETE FROM records WHERE created_at < ?').run(ts);
  // 延迟历史保留 30 天（曲线用，量比报警记录大得多）
  try { getDb().prepare('DELETE FROM latency_history WHERE ts < ?').run(Date.now() - 30 * 86400 * 1000); } catch (_) {}
  return r.changes;
}

module.exports = { initDb, getDb, getSetting, setSetting, cleanupRecords, listUsers, findUser, addUser, deleteUser, countUsers };
