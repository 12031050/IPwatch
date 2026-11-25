'use strict';
// notify.js —— 报警通知：邮件（SMTP）+ Webhook（Server酱 / 企业微信 / 钉钉 / 飞书 / 自定义）
const https = require('https');
const http = require('http');
const { URL } = require('url');

let mailer = null;
let mailerFrom = '';

function getMailer(cfg) {
  // 惰性创建 nodemailer transporter，配置变化时重建
  const sig = `${cfg.smtp_host}|${cfg.smtp_port}|${cfg.smtp_secure}|${cfg.smtp_user}|${cfg.smtp_pass}`;
  if (mailer && mailer._ipwatchSig === sig) return mailer;
  // eslint-disable-next-line global-require
  const nodemailer = require('nodemailer');
  mailer = nodemailer.createTransport({
    host: cfg.smtp_host,
    port: parseInt(cfg.smtp_port || '465', 10),
    secure: cfg.smtp_secure === '1',
    auth: cfg.smtp_user ? { user: cfg.smtp_user, pass: cfg.smtp_pass } : undefined,
    connectionTimeout: 15000,
    greetingTimeout: 10000
  });
  mailer._ipwatchSig = sig;
  mailerFrom = cfg.mail_from || cfg.smtp_user;
  return mailer;
}

function sendMail(cfg, subject, text) {
  return new Promise(resolve => {
    if (!cfg.smtp_host || !cfg.mail_to) {
      return resolve({ ok: false, detail: 'SMTP 未配置（服务器或收件人缺失）' });
    }
    try {
      const transport = getMailer(cfg);
      transport.sendMail({
        from: mailerFrom,
        to: cfg.mail_to,
        subject,
        text
      }, (err, info) => {
        if (err) resolve({ ok: false, detail: String(err.message || err) });
        else resolve({ ok: true, detail: info && info.response ? String(info.response).slice(0, 120) : 'accepted' });
      });
    } catch (e) {
      resolve({ ok: false, detail: String(e.message || e) });
    }
  });
}

// 简易 HTTP POST（不引额外依赖）
function httpPost(urlStr, body, headers) {
  return new Promise(resolve => {
    const u = new URL(urlStr);
    const mod = u.protocol === 'https:' ? https : http;
    const data = typeof body === 'string' ? body : JSON.stringify(body);
    const req = mod.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }, headers),
      timeout: 15000
    }, res => {
      let buf = '';
      res.on('data', d => { buf += d; if (buf.length > 16384) req.destroy(); });
      res.on('end', () => resolve({ status: res.statusCode, body: buf.slice(0, 500) }));
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', e => resolve({ status: 0, body: String(e.message || e) }));
    req.end(data);
  });
}

async function sendWx(cfg, title, text) {
  if (!cfg.wx_key) return { ok: false, detail: 'Webhook 未配置 Key / URL' };
  const type = cfg.wx_type || 'serverchan';
  const key = cfg.wx_key.trim();
  try {
    if (type === 'wecom') {
      // 企业微信群机器人：POST 完整 Webhook URL
      const url = key.startsWith('http') ? key : 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=' + key;
      const r = await httpPost(url, { msgtype: 'text', text: { content: `${title}\n${text}` } });
      const ok = r.status === 200 && /"errcode"\s*:\s*0/.test(r.body);
      return { ok, detail: `HTTP ${r.status} ${r.body}`.slice(0, 160) };
    }
    if (type === 'dingtalk') {
      // 钉钉群机器人：URL 可带 &secret=xxx 启用加签
      let url = key, secret = '';
      const sidx = key.indexOf('&secret=');
      if (sidx >= 0) { url = key.slice(0, sidx); secret = key.slice(sidx + 8); }
      if (secret) {
        const crypto = require('crypto');
        const ts = String(Date.now());
        const sign = encodeURIComponent(crypto.createHmac('sha256', secret).update(ts + '\n' + secret).digest('base64'));
        url += `&timestamp=${ts}&sign=${sign}`;
      }
      const r = await httpPost(url, { msgtype: 'text', text: { content: `${title}\n${text}` } });
      const ok = r.status === 200 && /"errcode"\s*:\s*0/.test(r.body);
      return { ok, detail: `HTTP ${r.status} ${r.body}`.slice(0, 160) };
    }
    if (type === 'feishu') {
      // 飞书群机器人：POST { msg_type:'text', content:{text} }
      const r = await httpPost(key, { msg_type: 'text', content: { text: `${title}\n${text}` } });
      const ok = r.status === 200 && /"(?:code|StatusCode)"\s*:\s*0/.test(r.body);
      return { ok, detail: `HTTP ${r.status} ${r.body}`.slice(0, 160) };
    }
    if (type === 'custom') {
      // 自定义 Webhook：POST 通用 JSON，适配大多数机器人/自动化平台
      if (!/^https?:\/\//i.test(key)) return { ok: false, detail: '自定义 Webhook 需填写完整 http(s) URL' };
      const r = await httpPost(key, { title, text, content: `${title}\n${text}`, time: new Date().toISOString() });
      const ok = r.status >= 200 && r.status < 300;
      return { ok, detail: `HTTP ${r.status} ${r.body}`.slice(0, 160) };
    }
    // 默认：Server酱 Turbo
    const params = new URLSearchParams({ title, desp: text }).toString();
    const r = await httpPost(`https://sctapi.ftqq.com/${encodeURIComponent(key)}.send`, params,
      { 'Content-Type': 'application/x-www-form-urlencoded' });
    const ok = r.status === 200 && /"code"\s*:\s*0/.test(r.body);
    return { ok, detail: `HTTP ${r.status} ${r.body}`.slice(0, 160) };
  } catch (e) {
    return { ok: false, detail: String(e.message || e) };
  }
}

module.exports = { sendMail, sendWx };
