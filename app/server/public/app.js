'use strict';
// IPwatch 前端逻辑（原生 JS，无框架依赖）
// 支持 5 个视图 + 访问密码锁；API 相对路径，端口/网关模式均可用
const API = ((location.pathname.indexOf('/app/ipwatch') === 0) ? '/app/ipwatch' : '') + '/api';
const TOKEN_KEY = 'ipwatch_token';

const $ = s => document.querySelector(s);
const state = {
  view: 'overview', hosts: [], summary: null, records: [], feed: [], editingId: null, timer: null, needSetup: false,
  page: { hosts: 1, down: 1, records: 1 },
  filter: { q: '', grp: '' }
};

// 每页条数：设备管理不分页（全部渲染 + 鼠标滚动），掉线主机 15、报警记录 18；实时事件流不分页
const PAGE_SIZE = { hosts: 0, down: 15, records: 18 };
function paginate(key, rows) {
  const size = PAGE_SIZE[key];
  if (!size) return { rows, html: '' };
  const pages = Math.max(1, Math.ceil(rows.length / size));
  if (state.page[key] > pages) state.page[key] = pages;
  const pg = state.page[key];
  const slice = rows.slice((pg - 1) * size, pg * size);
  let html = `<div class="pager"><span>共 ${rows.length} 条 · ${pg}/${pages} 页</span>`;
  html += `<button type="button" data-pager="${key}" data-page="1" ${pg === 1 ? 'disabled' : ''}>首页</button>`;
  html += `<button type="button" data-pager="${key}" data-page="${pg - 1}" ${pg === 1 ? 'disabled' : ''}>上一页</button>`;
  html += `<button type="button" data-pager="${key}" data-page="${pg + 1}" ${pg === pages ? 'disabled' : ''}>下一页</button>`;
  html += `<button type="button" data-pager="${key}" data-page="${pages}" ${pg === pages ? 'disabled' : ''}>末页</button></div>`;
  return { rows: slice, html };
}

// 行高按「每页满页条数」计算并固定：满页时刚好铺满框，记录少时保持正常紧凑行高、下方自然留白。
// 不会因当前只有几条就把行高拉到离谱的高度。框本身仍用 flex 贴到容器底部。
function fitRows() {
  requestAnimationFrame(() => {
    const specs = [
      { sel: '#view-hosts .tbl-wrap.full', fixed: 42 },
      { sel: '#view-overview .ov-grid .tbl-wrap', size: PAGE_SIZE.down },
      { sel: '#view-records .tbl-wrap.full', size: PAGE_SIZE.records }
    ];
    for (const s of specs) {
      const wrap = $(s.sel);
      if (!wrap || !wrap.offsetParent) continue; // 隐藏视图跳过
      const scroll = wrap.querySelector('.tbl-scroll');
      const thead = wrap.querySelector('thead');
      if (!scroll) continue;
      // 设备管理全量滚动：固定紧凑行高，不随条数拉伸
      if (s.fixed) { wrap.style.setProperty('--row-h', s.fixed + 'px'); continue; }
      const avail = scroll.clientHeight - (thead ? thead.offsetHeight : 0);
      if (avail <= 0) continue;
      // 按满页条数算固定行高，并设上限避免大屏下过高
      const rowH = Math.max(34, Math.min(52, Math.floor(avail / s.size)));
      wrap.style.setProperty('--row-h', rowH + 'px');
    }
    // 实时事件流：条目保持正常高度，不按实际条数拉伸；多则内部滚动，少则下方留白
    const fw = $('#view-overview .feed');
    if (fw && fw.offsetParent) {
      fw.querySelectorAll('.evt').forEach(el => {
        el.style.minHeight = ''; el.style.display = ''; el.style.flexDirection = ''; el.style.justifyContent = '';
      });
    }
  });
}
window.addEventListener('resize', fitRows);

function token() { return localStorage.getItem(TOKEN_KEY) || ''; }
function setToken(t) { t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY); }

function fmtTs(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
function fmtShort(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  const p = n => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}
function fmtDur(s) {
  if (s == null) return '—';
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分钟`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时 ${m % 60} 分`;
  return `${Math.floor(h / 24)} 天 ${h % 24} 小时`;
}
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
// 地址显示：端口留空（0）时只显示 IP/域名
function addrText(host, port) { return esc(host) + (port ? ':' + port : ''); }

function toast(msg, ms = 2400) {
  const t = $('#toast');
  t.textContent = msg;
  t.style.display = 'block';
  clearTimeout(t._tm);
  t._tm = setTimeout(() => t.style.display = 'none', ms);
}

async function api(path, opts) {
  const headers = Object.assign(
    opts && opts.body ? { 'Content-Type': 'application/json' } : {},
    token() ? { 'X-Auth-Token': token() } : {}
  );
  const res = await fetch(API + path, opts ? { ...opts, headers } : { headers });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) { if (!state.needSetup) showLock(); throw new Error('需要访问密码'); }
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function hideModal(id) { $('#' + id).style.display = 'none'; }
// 应用内确认框（不依赖浏览器原生 confirm，避免部分 WebView 被屏蔽）
function askConfirm(title, text) {
  return new Promise(resolve => {
    $('#confirmTitle').textContent = title;
    $('#confirmText').textContent = text;
    $('#confirmModal').style.display = 'flex';
    const done = v => {
      $('#confirmModal').style.display = 'none';
      $('#confirmOk').onclick = null; $('#confirmCancel').onclick = null;
      resolve(v);
    };
    $('#confirmOk').onclick = () => done(true);
    $('#confirmCancel').onclick = () => done(false);
  });
}
// 弹窗仅允许点右上角 × 或「取消 / 保存」关闭；点遮罩、ESC 均不关闭，避免误触丢失编辑内容
$('#mClose').addEventListener('click', () => hideModal('hostModal'));

// ---------- 首次使用：强制设置访问密码 ----------
function showSetup() { state.needSetup = true; $('#setupModal').style.display = 'flex'; $('#setupPwd').focus(); }
$('#setupGo').addEventListener('click', async () => {
  const p1 = $('#setupPwd').value, p2 = $('#setupPwd2').value;
  if (p1.length < 4) { $('#setupResult').innerHTML = '<span class="fail">密码至少 4 位</span>'; return; }
  if (p1 !== p2) { $('#setupResult').innerHTML = '<span class="fail">两次输入不一致</span>'; return; }
  try {
    const r = await fetch(API + '/setup-password', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: p1 })
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || '设置失败');
    setToken(d.token || '');
    state.needSetup = false;
    hideModal('setupModal');
    $('#setupPwd').value = ''; $('#setupPwd2').value = '';
    toast('访问密码已设置，请牢记');
    refreshAll();
  } catch (e) { $('#setupResult').innerHTML = `<span class="fail">${esc(e.message)}</span>`; }
});
$('#setupPwd2').addEventListener('keydown', e => { if (e.key === 'Enter') $('#setupGo').click(); });

// ---------- 访问密码锁 ----------
function showLock() {
  $('#lockModal').style.display = 'flex';
  $('#lockPwd').focus();
}
async function authCheck() {
  try {
    const r = await fetch(API + '/auth-check', { headers: token() ? { 'X-Auth-Token': token() } : {} });
    const d = await r.json();
    if (d.needSetup) { showSetup(); return false; }
    if (d.locked && !d.authed) { showLock(); return false; }
    return true;
  } catch (e) { return true; }
}
$('#lockGo').addEventListener('click', async () => {
  try {
    const r = await fetch(API + '/auth', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: $('#lockUser').value.trim(), password: $('#lockPwd').value })
    });
    const d = await r.json();
    if (d.ok) {
      setToken(d.token || '');
      $('#lockModal').style.display = 'none';
      $('#lockUser').value = ''; $('#lockPwd').value = '';
      $('#lockResult').innerHTML = '';
      refreshAll();
    } else {
      $('#lockResult').innerHTML = `<span class="fail">${esc(d.error || '密码错误，请重试')}</span>`;
    }
  } catch (e) {
    $('#lockResult').innerHTML = '<span class="fail">请求失败</span>';
  }
});
$('#lockPwd').addEventListener('keydown', e => { if (e.key === 'Enter') $('#lockGo').click(); });

// ---------- 视图切换 ----------
function switchView(name) {
  state.view = name;
  document.querySelectorAll('#nav a').forEach(a => a.classList.toggle('on', a.dataset.view === name));
  for (const v of ['overview', 'hosts', 'records', 'notify', 'settings']) {
    $('#view-' + v).style.display = v === name ? '' : 'none';
  }
  if (name === 'records') loadRecords();
  if (name === 'notify') loadSettings();
  if (name === 'settings') { loadSettings(); loadUsers(); }
  if (name === 'overview' || name === 'hosts') refreshAll();
  fitRows();
}
$('#nav').addEventListener('click', e => {
  const a = e.target.closest('a');
  if (a) { e.preventDefault(); switchView(a.dataset.view); }
});

// ---------- 数据刷新 ----------
async function refreshAll() {
  try {
    const [summary, hosts] = await Promise.all([api('/summary'), api('/hosts')]);
    state.summary = summary;
    state.hosts = hosts;
    syncGroupFilter();
    renderSummary();
    renderHosts();
    renderDownList();
    const recs = await api('/records?limit=200');
    // 实时事件流只显示掉线事件（恢复记录仍可在「报警记录」页查看）
    state.feed = (recs || []).filter(r => r.event === 'down');
    renderFeed();
    const badge = $('#navAlertBadge');
    const openDowns = hosts.filter(h => h.status === 'down').length;
    badge.textContent = openDowns;
    badge.style.display = openDowns > 0 ? '' : 'none';
  } catch (e) { console.error(e); }
}

function renderSummary() {
  const s = state.summary;
  if (!s) return;
  $('#stTotal').innerHTML = `${s.total} <small>台</small>`;
  $('#stUp').innerHTML = `${s.up} <small>台</small>`;
  $('#stDown').innerHTML = `${s.down} <small>台</small>`;
  $('#stToday').innerHTML = `${s.todayAlerts} <small>条</small>`;
}

function statusHtml(h) {
  if (h.paused) return '<span class="st pause"><i></i>暂停</span>';
  if (h.status === 'up') return '<span class="st up"><i></i>在线</span>';
  if (h.status === 'down') return '<span class="st down"><i></i>掉线</span>';
  return '<span class="st unknown"><i></i>待探测</span>';
}

const NOTIFY_LABEL = { default: '跟随全局', mail: '邮件', wx: 'Webhook', both: '邮件+推送', none: '不通知' };
function notifyHtml(n) {
  const key = NOTIFY_LABEL[n] ? n : 'default';
  const color = key === 'none' ? 'var(--sub)' : key === 'default' ? 'var(--blue)' : 'var(--green)';
  return `<span class="tag" style="color:${color}">${NOTIFY_LABEL[key]}</span>`;
}
const SEV_LABEL = { info: '提示', warning: '警告', critical: '严重' };
function sevHtml(s) {
  const key = SEV_LABEL[s] ? s : 'warning';
  return `<span class="sev ${key}">${SEV_LABEL[key]}</span>`;
}

function filteredHosts() {
  const q = (state.filter.q || '').trim().toLowerCase();
  const grp = state.filter.grp || '';
  return state.hosts.filter(h => {
    if (q && !(h.name || '').toLowerCase().includes(q) && !(h.host || '').toLowerCase().includes(q)) return false;
    if (grp && (h.grp || '') !== grp) return false;
    return true;
  });
}

function renderHosts() {
  const tbody = $('#hostTbody');
  const now = Date.now();
  const rows = filteredHosts();
  tbody.innerHTML = rows.map(h => {
    const latency = h.status === 'up' && h.last_latency != null
      ? `<span class="latency-link" data-chart="${h.id}" title="查看延迟/丢包曲线">${h.last_latency < 1 ? '<1' : Math.round(h.last_latency)} ms</span>` : '—';
    const maintTag = h.maint_enabled ? ' <span class="tag" style="color:var(--amber)" title="维护窗口内静默告警">维护</span>' : '';
    // 「最近变化」合并进状态列：与状态徽标同一水平行显示在线时长 / 掉线时间
    const change = h.paused ? '<span class="st-sub">手动暂停</span>'
      : h.status === 'down' ? `<span class="st-sub red">${fmtTs(h.last_change).slice(5, 16)}</span>`
      : h.status === 'up' ? `<span class="st-sub green">${fmtDur(Math.floor((now - h.last_change) / 1000))}</span>`
      : '<span class="st-sub">等待首轮探测</span>';
    const statusCell = `<div class="st-cell">${statusHtml(h)}${change}</div>`;
    return `<tr>
      <td>${statusCell}</td>
      <td>${esc(h.name)}${maintTag}</td>
      <td style="font-family:Consolas,monospace">${addrText(h.host, h.port)}</td>
      <td>${latency}</td>
      <td>${sevHtml(h.severity)}</td>
      <td>${h.grp ? `<span class="tag">${esc(h.grp)}</span>` : '<span class="dur">—</span>'}</td>
      <td>${notifyHtml(h.notify)}</td>
      <td>${h.interval_s}s</td>
      <td><span class="tag">${h.retries} 次判定</span></td>
      <td style="text-align:right">
        <button type="button" class="op" data-act="check" data-id="${h.id}">探测</button>
        <button type="button" class="op" data-act="pause" data-id="${h.id}">${h.paused ? '恢复' : '暂停'}</button>
        <button type="button" class="op" data-act="edit" data-id="${h.id}">编辑</button>
        <button type="button" class="op danger" data-act="del" data-id="${h.id}">删除</button>
      </td>
    </tr>`;
  }).join('');
  const isFiltered = rows.length !== state.hosts.length;
  $('#hostEmpty').style.display = rows.length ? 'none' : 'block';
  $('#hostEmpty').textContent = isFiltered ? '没有符合筛选条件的设备，试试清空筛选' : '还没有监控目标，点右上角「＋ 添加 IP」开始';
  $('#hostPager').innerHTML = `<div class="pager"><span>共 ${rows.length} 台${isFiltered ? ` / ${state.hosts.length} 台` : ''} · 鼠标滚动查看全部</span></div>`;
  $('#hostFilterInfo').textContent = isFiltered ? `筛选出 ${rows.length} / ${state.hosts.length} 台` : '';
  fitRows();
}

// 同步分组下拉选项（保留当前选中值）
function syncGroupFilter() {
  const sel = $('#hostFilterGrp');
  if (!sel) return;
  const cur = sel.value;
  const groups = [...new Set(state.hosts.map(h => h.grp).filter(Boolean))].sort();
  sel.innerHTML = '<option value="">全部分组</option>' + groups.map(g => `<option value="${esc(g)}">${esc(g)}</option>`).join('');
  sel.value = groups.includes(cur) ? cur : '';
  if (sel.value !== cur) { state.filter.grp = ''; renderHosts(); }
}

function renderDownList() {
  const downs = state.hosts.filter(h => h.status === 'down');
  const pg = paginate('down', downs);
  $('#downTbody').innerHTML = pg.rows.map(h => `<tr>
    <td><span class="st down"><i></i>掉线</span></td>
    <td>${esc(h.name)}</td>
    <td style="font-family:Consolas,monospace">${esc(h.host)}:${h.port}</td>
    <td class="dur">${fmtTs(h.last_change)}</td>
  </tr>`).join('');
  $('#downEmpty').style.display = downs.length ? 'none' : 'block';
  $('#downPager').innerHTML = pg.html;
  fitRows();
}

async function probeAll() {
  toast('正在探测全部主机…');
  const hosts = state.hosts.filter(h => !h.paused);
  for (const h of hosts) {
    try { await api(`/hosts/${h.id}/check`, { method: 'POST' }); } catch (_) {}
  }
  toast('探测完成');
  refreshAll();
}
$('#btnProbeAll').addEventListener('click', probeAll);
$('#btnProbeAll2').addEventListener('click', probeAll);
$('#btnQuickAdd').addEventListener('click', () => openHostModal(null));
$('#btnAddHost').addEventListener('click', () => openHostModal(null));

// 事件流：仅掉线事件，每条展示通知动作（邮件/微信各自送达/失败/未启用原因）
function notifyAction(status, detail, label) {
  if (status === 'sent') return `<span class="ok">${label}✓已发</span>`;
  if (status === 'failed') return `<span class="fail" title="${esc(detail || '')}">${label}✗失败</span>`;
  // skip 或其他：显示未发送原因
  const why = detail || '未启用';
  return `<span class="dur" title="${esc(why)}">${label}—${esc(why)}</span>`;
}
function renderFeed() {
  const el = $('#feedList');
  const pg = paginate('feed', state.feed);
  el.innerHTML = pg.rows.length ? pg.rows.map(r => {
    const durSec = Math.max(0, Math.floor((Date.now() - (r.start_at || r.created_at)) / 1000));
    const mail = notifyAction(r.mail_status, r.mail_detail, '邮件');
    const wx = notifyAction(r.wx_status, r.wx_detail, '微信');
    return `<div class="evt red">
      <div class="evt-line"><span class="t">${fmtShort(r.created_at)}</span><b>${esc(r.host_name)}</b> 判定掉线 <span class="evt-dur">已持续 ${fmtDur(durSec)}</span></div>
      <div class="evt-acts">${mail} ${wx}</div>
    </div>`;
  }).join('') : '<div class="evt"><span class="d">暂无掉线事件，探测引擎按设定间隔巡检</span></div>';
  $('#feedPager').innerHTML = pg.html;
}

// 事件委托绑定在不会被 innerHTML 重建的父容器上；用 closest 精确匹配按钮
$('#hostTbody').addEventListener('click', async e => {
  const op = e.target.closest('button.op[data-act]');
  if (!op) return;
  e.preventDefault();
  const id = parseInt(op.dataset.id, 10);
  const h = state.hosts.find(x => x.id === id);
  if (!h) { toast('设备数据未同步，请稍后重试'); return; }
  try {
    if (op.dataset.act === 'check') {
      op.textContent = '…';
      const r = await api(`/hosts/${id}/check`, { method: 'POST' });
      const viaLabel = { icmp: 'Ping', tcp: '端口', arp: 'ARP（无需端口）' }[r.via] || '探测';
      const latTxt = r.latency == null ? '' : `，${r.latency < 1 ? '<1' : Math.round(r.latency)} ms`;
      toast(r.ok ? `${h.name} 在线（${viaLabel}${latTxt}）` : `${h.name} 探测失败（无响应）`);
      refreshAll();
    } else if (op.dataset.act === 'pause') {
      await api(`/hosts/${id}`, { method: 'PUT', body: JSON.stringify({ ...h, paused: !h.paused }) });
      toast(h.paused ? `${h.name} 已恢复监控` : `${h.name} 已暂停监控`);
      refreshAll();
    } else if (op.dataset.act === 'edit') {
      openHostModal(h);
    } else if (op.dataset.act === 'del') {
      if (await askConfirm('删除设备', `确定删除「${h.name}」？其报警记录会保留。`)) {
        await api(`/hosts/${id}`, { method: 'DELETE' });
        toast('已删除');
        refreshAll();
      }
    }
  } catch (err) { toast('操作失败：' + err.message); }
});

// ---------- 主机弹窗 ----------
function openHostModal(h) {
  state.editingId = h ? h.id : null;
  $('#hostModalTitle').textContent = h ? '编辑主机' : '添加 IP';
  $('#mName').value = h ? h.name : '';
  $('#mHost').value = h ? h.host : '';
  $('#mPort').value = h ? (h.port || '') : '';
  $('#mInterval').value = h ? h.interval_s : 30;
  $('#mRetries').value = h ? h.retries : 3;
  $('#mGroup').value = h ? (h.grp || '') : '';
  $('#mNotify').value = h && NOTIFY_LABEL[h.notify] ? h.notify : 'default';
  $('#mSeverity').value = h && SEV_LABEL[h.severity] ? h.severity : 'warning';
  $('#mNotifyRecovery').value = h && h.notify_recovery != null ? String(h.notify_recovery) : '-1';
  $('#mMaintEnabled').checked = !!(h && h.maint_enabled);
  $('#mMaintStart').value = h ? (h.maint_start || '') : '';
  $('#mMaintEnd').value = h ? (h.maint_end || '') : '';
  $('#hostModal').style.display = 'flex';
  $('#mName').focus();
}
$('#mCancel').addEventListener('click', () => $('#hostModal').style.display = 'none');
$('#mSave').addEventListener('click', async () => {
  const body = JSON.stringify({
    name: $('#mName').value, host: $('#mHost').value,
    port: +($('#mPort').value || 0), interval_s: +$('#mInterval').value, retries: +$('#mRetries').value,
    grp: $('#mGroup').value.trim(), notify: $('#mNotify').value,
    severity: $('#mSeverity').value, notify_recovery: +$('#mNotifyRecovery').value,
    maint_enabled: $('#mMaintEnabled').checked ? 1 : 0,
    maint_start: $('#mMaintStart').value, maint_end: $('#mMaintEnd').value
  });
  try {
    if (state.editingId) await api(`/hosts/${state.editingId}`, { method: 'PUT', body });
    else await api('/hosts', { method: 'POST', body });
    $('#hostModal').style.display = 'none';
    toast('已保存');
    refreshAll();
  } catch (e) { toast(e.message); }
});

// ---------- 报警记录 ----------
async function loadRecords() {
  const type = $('#recFilter').value;
  try {
    state.records = await api(`/records?limit=300${type ? '&type=' + type : ''}`);
    renderRecords();
  } catch (e) { console.error(e); }
}
function notifyCell(status, detail) {
  if (status === 'sent') return '<span class="ok">✓ 已送达</span>';
  if (status === 'failed') return `<span class="fail" title="${esc(detail || '')}">✗ 失败</span>`;
  if (status === 'skip') return `<span class="dur" title="${esc(detail || '')}">— 未发</span>`;
  return '<span class="dur">—</span>';
}
function renderRecords() {
  const tbody = $('#recTbody');
  const pg = paginate('records', state.records);
  tbody.innerHTML = pg.rows.map(r => {
    const ev = r.event === 'down'
      ? '<span class="lvl down"><i></i>掉线</span>'
      : '<span class="lvl rec"><i></i>恢复</span>';
    const dur = r.event === 'down' ? '进行中' : '已恢复';
    // 持续时间：进行中的掉线按开始时间实时计时；恢复记录用实际掉线时长
    const durSec = r.event === 'down'
      ? Math.max(0, Math.floor((Date.now() - (r.start_at || r.created_at)) / 1000))
      : (r.duration_s || 0);
    const durText = `<span style="color:${r.event === 'down' ? 'var(--amber)' : 'var(--green)'}">${fmtDur(durSec)}</span>`;
    const resendBtn = r.event === 'down'
      ? `<button type="button" class="op" data-resend="${r.id}" title="用当前通知配置重新发送这条报警">↻ 补发</button>`
      : '<span class="dur">—</span>';
    const ackCell = r.acked
      ? `<span class="ack-yes" data-ack="${r.id}" title="点击查看/编辑">✓ 已处理</span>${r.note ? `<span class="ack-note" title="${esc(r.note)}">${esc(r.note)}</span>` : ''}`
      : `<span class="ack-no" data-ack="${r.id}" title="点击标记已处理并写备注">＋ 标记处理</span>`;
    const notifyTimes = r.notify_count ? `<span class="dur" title="已通知 ${r.notify_count} 次"> (${r.notify_count}次)</span>` : '';
    return `<tr class="${r.event === 'down' && r.created_at > Date.now() - 86400000 ? 'hl' : ''}">
      <td>${ev}</td><td>${sevHtml(r.severity)}</td><td>${esc(r.host_name)}</td>
      <td style="font-family:Consolas,monospace">${esc(r.host_addr)}</td>
      <td>${fmtTs(r.start_at)}</td><td class="dur">${dur}</td><td class="dur">${durText}</td>
      <td>${notifyCell(r.mail_status, r.mail_detail)}${notifyTimes}</td><td>${notifyCell(r.wx_status, r.wx_detail)}</td>
      <td>${ackCell}</td>
      <td style="text-align:right">${resendBtn}</td>
    </tr>`;
  }).join('');
  $('#recEmpty').style.display = state.records.length ? 'none' : 'block';
  $('#recPager').innerHTML = pg.html;
  fitRows();
}
// 设备管理筛选：名称/IP 即时搜索 + 分组选择
$('#hostFilterQ').addEventListener('input', e => { state.filter.q = e.target.value; renderHosts(); });
$('#hostFilterGrp').addEventListener('change', e => { state.filter.grp = e.target.value; renderHosts(); });
$('#hostFilterClear').addEventListener('click', () => {
  state.filter.q = ''; state.filter.grp = '';
  $('#hostFilterQ').value = ''; $('#hostFilterGrp').value = '';
  renderHosts();
});

$('#recFilter').addEventListener('change', loadRecords);
$('#btnExportCsv').addEventListener('click', () => {
  const rows = [['事件', '级别', '主机', '地址', '开始时间', '状态', '持续时间', '持续秒', '邮件状态', '微信状态', '通知次数', '已处理', '备注']];
  for (const r of state.records) {
    const sec = r.event === 'down'
      ? Math.max(0, Math.floor((Date.now() - (r.start_at || r.created_at)) / 1000))
      : (r.duration_s || 0);
    rows.push([r.event, SEV_LABEL[r.severity] || '警告', r.host_name, r.host_addr, fmtTs(r.start_at), r.event === 'down' ? '进行中' : '已恢复', fmtDur(sec), sec, r.mail_status, r.wx_status, r.notify_count || 0, r.acked ? '是' : '否', r.note || '']);
  }
  const csv = '\ufeff' + rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = 'ipwatch-records.csv';
  a.click();
});
$('#btnClearRecords').addEventListener('click', async () => {
  if (!await askConfirm('清空记录', '确定清空全部报警记录？此操作不可恢复。')) return;
  await api('/records', { method: 'DELETE' });
  toast('已清空');
  loadRecords();
});

// ---------- 用户管理 ----------
async function loadUsers() {
  try {
    const users = await api('/users');
    const tbody = $('#userTbody');
    tbody.innerHTML = users.map(u => `<tr>
      <td>${esc(u.username)}</td>
      <td class="dur">添加于 ${fmtTs(u.created_at).slice(0, 10)}</td>
      <td style="text-align:right"><span class="op" data-uid="${u.id}" data-uname="${esc(u.username)}" style="color:var(--red)">删除</span></td>
    </tr>`).join('');
    $('#userEmpty').style.display = users.length ? 'none' : 'block';
  } catch (e) { console.error(e); }
}
$('#userTbody').addEventListener('click', async e => {
  const op = e.target.closest('.op');
  if (!op) return;
  if (!await askConfirm('删除用户', `确定删除用户「${op.dataset.uname}」？`)) return;
  try { await api(`/users/${op.dataset.uid}`, { method: 'DELETE' }); toast('用户已删除'); loadUsers(); }
  catch (err) { toast('删除失败：' + err.message); }
});
$('#btnAddUser').addEventListener('click', async () => {
  const username = $('#newUserName').value.trim();
  const password = $('#newUserPass').value;
  if (!username || !password) { toast('填写用户名和密码'); return; }
  try {
    await api('/users', { method: 'POST', body: JSON.stringify({ username, password }) });
    $('#newUserName').value = ''; $('#newUserPass').value = '';
    toast(`用户「${username}」已添加，可用该账户解锁页面`);
    loadUsers();
  } catch (e) { toast('添加失败：' + e.message); }
});

// ---------- 系统备份 / 还原 ----------
$('#btnBackup').addEventListener('click', async () => {
  const el = $('#backupResult');
  try {
    el.innerHTML = '正在生成备份…';
    const data = await api('/backup');
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    const p = n => String(n).padStart(2, '0');
    const d = new Date();
    a.href = URL.createObjectURL(blob);
    a.download = `ipwatch-backup-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.json`;
    a.click();
    el.innerHTML = `<span class="ok">✓ 备份完成：${data.hosts.length} 台主机 / ${(data.records || []).length} 条记录</span>`;
  } catch (e) { el.innerHTML = `<span class="fail">备份失败：${esc(e.message)}</span>`; }
});
$('#btnRestorePick').addEventListener('click', () => $('#restoreFile').click());
$('#restoreFile').addEventListener('change', async e => {
  const f = e.target.files[0];
  if (!f) return;
  if (!await askConfirm('系统还原', `确定从「${f.name}」还原？当前的设备、记录、配置和账户将被覆盖！`)) { e.target.value = ''; return; }
  const el = $('#backupResult');
  try {
    el.innerHTML = '正在还原，请勿关闭页面…';
    const text = await f.text();
    const r = await fetch(API + '/restore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Auth-Token': token() },
      body: text
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
    el.innerHTML = `<span class="ok">✓ 还原完成：${d.hosts} 台主机 / ${d.records} 条记录</span>`;
    toast('还原完成，页面即将刷新');
    setTimeout(() => location.reload(), 1500);
  } catch (err) { el.innerHTML = `<span class="fail">还原失败：${esc(err.message)}</span>`; }
  e.target.value = '';
});

// ---------- 设置加载 ----------
async function loadSettings() {
  try {
    const s = await api('/settings');
    $('#setInterval').value = s.check_interval;
    $('#setRetries').value = s.retries;
    $('#setKeepDays').value = s.keep_days;
    $('#setMailEnabled').checked = s.mail_enabled === '1';
    $('#setSmtpHost').value = s.smtp_host;
    $('#setSmtpPort').value = s.smtp_port;
    $('#setSmtpSecure').value = s.smtp_secure;
    $('#setSmtpUser').value = s.smtp_user;
    $('#setSmtpPass').value = '';
    $('#setSmtpPass').placeholder = s.smtp_pass_set ? '已设置，留空表示不修改' : '请输入 SMTP 授权码';
    $('#setMailFrom').value = s.mail_from;
    $('#setMailTo').value = s.mail_to;
    $('#setWxEnabled').checked = s.wx_enabled === '1';
    $('#setWxType').value = s.wx_type || 'serverchan';
    $('#setWxKey').value = s.wx_key;
    $('#setRepeatHours').value = s.repeat_notify_hours != null ? s.repeat_notify_hours : '0';
    $('#setNotifyRecovery').value = s.notify_on_recovery === '0' ? '0' : '1';
    $('#setAccessPwd').value = '';
    $('#setAccessPwd').placeholder = s.access_password_set ? '已设置，留空表示不修改' : '设置后打开页面需解锁';
    $('#accessResult').innerHTML = s.access_password_set || s.user_count > 0
      ? '<span class="ok">已启用保护：访问密码' + (s.access_password_set ? '已设置' : '未设置') + '，账户 ' + s.user_count + ' 个</span>'
      : '<span class="dur">未设置任何保护，局域网内可直接访问</span>';
    // 通知渠道页顶部状态横幅：明确"测试通过"与"真实掉线会发"的区别
    const banner = $('#notifyBanner');
    if (banner) {
      const on = [];
      if (s.mail_enabled === '1') on.push('邮件');
      if (s.wx_enabled === '1') on.push('微信');
      if (on.length) {
        banner.className = 'notify-banner ok';
        banner.innerHTML = `✓ 报警通知已启用：<b>${on.join(' + ')}</b> —— 设备掉线时会自动发送（设备单独设为「不通知」的除外）。`;
      } else {
        banner.className = 'notify-banner warn';
        banner.innerHTML = '⚠ 当前<b>未启用</b>任何报警通知：即使配置正确、测试发送成功，真实掉线时也不会发邮件/微信。请打开下方开关并点「保存」。';
      }
    }
    try {
      const st = await api('/status');
      $('#runtimeInfo').innerHTML = `运行环境：Node ${esc(st.node)} · 已运行 ${fmtDur(st.uptime)}<br>数据目录：${esc(st.dataDir)}`;
    } catch (_) {}
  } catch (e) { console.error(e); }
}

function collectProbe() {
  return JSON.stringify({
    check_interval: +$('#setInterval').value,
    retries: +$('#setRetries').value,
    keep_days: +$('#setKeepDays').value
  });
}
function collectMail() {
  const body = {
    mail_enabled: $('#setMailEnabled').checked ? '1' : '0',
    smtp_host: $('#setSmtpHost').value.trim(),
    smtp_port: $('#setSmtpPort').value,
    smtp_secure: $('#setSmtpSecure').value,
    smtp_user: $('#setSmtpUser').value.trim(),
    mail_from: $('#setMailFrom').value.trim(),
    mail_to: $('#setMailTo').value.trim()
  };
  const pass = $('#setSmtpPass').value;
  if (pass) body.smtp_pass = pass;
  return JSON.stringify(body);
}
$('#btnSaveProbe').addEventListener('click', async () => {
  try { await api('/settings', { method: 'POST', body: collectProbe() }); toast('探测参数已保存'); }
  catch (e) { toast('保存失败：' + e.message); }
});
$('#btnSaveMail').addEventListener('click', async () => {
  try { await api('/settings', { method: 'POST', body: collectMail() }); toast('邮件配置已保存'); }
  catch (e) { toast('保存失败：' + e.message); }
});
$('#btnSaveWx').addEventListener('click', async () => {
  try {
    await api('/settings', {
      method: 'POST',
      body: JSON.stringify({
        wx_enabled: $('#setWxEnabled').checked ? '1' : '0',
        wx_type: $('#setWxType').value,
        wx_key: $('#setWxKey').value.trim()
      })
    });
    toast('推送配置已保存');
  } catch (e) { toast('保存失败：' + e.message); }
});
$('#btnSavePolicy').addEventListener('click', async () => {
  const el = $('#policyResult');
  try {
    await api('/settings', {
      method: 'POST',
      body: JSON.stringify({
        repeat_notify_hours: String(Math.min(Math.max(+$('#setRepeatHours').value || 0, 0), 720)),
        notify_on_recovery: $('#setNotifyRecovery').value
      })
    });
    el.innerHTML = '<span class="ok">✓ 告警策略已保存</span>';
    toast('告警策略已保存');
  } catch (e) { el.innerHTML = `<span class="fail">保存失败：${esc(e.message)}</span>`; }
});
$('#btnSaveAccess').addEventListener('click', async () => {
  const clear = $('#setAccessClear').value.trim().toUpperCase() === 'CLR';
  const pwd = $('#setAccessPwd').value;
  if (!pwd && !clear) { toast('输入新密码，或填写 CLR 清除'); return; }
  try {
    await api('/settings', { method: 'POST', body: JSON.stringify({ access_password: clear ? '' : pwd }) });
    if (clear) { setToken(''); toast('访问密码已清除'); }
    else { const t = await api('/auth', { method: 'POST', body: JSON.stringify({ password: pwd }) }); setToken(t.token || ''); toast('访问密码已设置'); }
    $('#setAccessPwd').value = ''; $('#setAccessClear').value = '';
    $('#accessResult').innerHTML = clear ? '<span class="ok">已清除，页面不再锁定</span>' : '<span class="ok">已设置，新开页面需解锁</span>';
  } catch (e) { toast('保存失败：' + e.message); }
});
// 对所有仍掉线且未成功送达的报警补发通知
async function resendAllOffline(force) {
  const r = await api('/records/notify-all', { method: 'POST', body: JSON.stringify({ force: force ? 1 : 0 }) });
  return r;
}
$('#btnResendAll').addEventListener('click', async () => {
  const btn = $('#btnResendAll');
  const old = btn.textContent;
  btn.disabled = true; btn.textContent = '补发中…';
  try {
    const r = await resendAllOffline(true);
    toast(`已补发 ${r.done}/${r.total} 条离线报警：邮件成功 ${r.mailOk}，微信成功 ${r.wxOk}`, 5000);
    loadRecords();
  } catch (e) { toast('补发失败：' + e.message); }
  finally { btn.disabled = false; btn.textContent = old; }
});
$('#btnTestMail').addEventListener('click', async () => {
  const el = $('#testMailResult');
  el.innerHTML = '正在发送测试邮件…';
  await api('/settings', { method: 'POST', body: collectMail() });
  const r = (await api('/notify/test', { method: 'POST' })).mail;
  const enabledNote = $('#setMailEnabled').checked
    ? ''
    : '<div class="hint" style="color:var(--amber);margin-top:6px">⚠ 测试已通过，但「启用邮件通知」开关未打开——真实掉线时不会发邮件。请打开开关并保存。</div>';
  let autoNote = '';
  // 测试通过且开关已打开时，自动把当前仍掉线、尚未送达的设备一并补发
  if (r.ok && $('#setMailEnabled').checked) {
    try {
      const rr = await resendAllOffline(false);
      if (rr.done > 0) {
        autoNote = `<div class="hint" style="color:var(--green);margin-top:6px">✓ 已自动向 ${rr.done} 台仍掉线且未送达的设备补发报警邮件（成功 ${rr.mailOk} 台）。</div>`;
      }
    } catch (_) {}
  }
  el.innerHTML = (r.ok ? `<span class="ok">✓ 测试邮件已发送，请查收（${esc(r.detail)}）</span>` : `<span class="fail">✗ 发送失败：${esc(r.detail)}</span>`) + enabledNote + autoNote;
});
$('#btnTestWx').addEventListener('click', async () => {
  const el = $('#testWxResult');
  el.innerHTML = '正在发送测试推送…';
  await api('/settings', { method: 'POST', body: JSON.stringify({ wx_enabled: $('#setWxEnabled').checked ? '1' : '0', wx_type: $('#setWxType').value, wx_key: $('#setWxKey').value.trim() }) });
  const r = (await api('/notify/test', { method: 'POST' })).wx;
  const enabledNote = $('#setWxEnabled').checked
    ? ''
    : '<div class="hint" style="color:var(--amber);margin-top:6px">⚠ 测试已通过，但「启用微信推送」开关未打开——真实掉线时不会发推送。请打开开关并保存。</div>';
  el.innerHTML = (r.ok ? `<span class="ok">✓ 测试推送已发送，请在微信查收</span>` : `<span class="fail">✗ 发送失败：${esc(r.detail)}</span>`) + enabledNote;
});

// ---------- 事件委托：翻页 / 补发 / 确认 / 曲线入口 ----------
document.addEventListener('click', async e => {
  // 翻页（控件会被 innerHTML 重建，故用 document 委托）
  const pb = e.target.closest('button[data-pager]');
  if (pb && !pb.disabled) {
    const key = pb.dataset.pager;
    state.page[key] = Math.max(1, parseInt(pb.dataset.page, 10) || 1);
    if (key === 'hosts') renderHosts();
    else if (key === 'down') renderDownList();
    else if (key === 'records') renderRecords();
    return;
  }
  // 补发
  const rb = e.target.closest('button[data-resend]');
  if (rb) {
    const id = rb.dataset.resend;
    rb.disabled = true; rb.textContent = '发送中…';
    try {
      const r = await api(`/records/${id}/notify`, { method: 'POST' });
      const bits = [];
      bits.push(`邮件 ${r.mail && r.mail.ok ? '✓已送达' : '—' + (r.mail ? r.mail.detail : '')}`);
      bits.push(`推送 ${r.wx && r.wx.ok ? '✓已送达' : '—' + (r.wx ? r.wx.detail : '')}`);
      toast('补发完成：' + bits.join(' / '), 5000);
      loadRecords();
    } catch (err) {
      toast('补发失败：' + err.message);
      rb.disabled = false; rb.textContent = '↻ 补发';
    }
    return;
  }
  // 确认 / 备注
  const ab = e.target.closest('[data-ack]');
  if (ab) { openAckModal(parseInt(ab.dataset.ack, 10)); return; }
  // 延迟曲线
  const cb = e.target.closest('[data-chart]');
  if (cb) { openChart(parseInt(cb.dataset.chart, 10)); return; }
});

// ---------- 报警确认 / 备注 ----------
let ackEditingId = null;
function openAckModal(id) {
  const r = state.records.find(x => x.id === id);
  if (!r) { toast('记录数据未同步'); return; }
  ackEditingId = id;
  $('#ackTitle').textContent = r.acked ? '编辑处理记录' : '处理报警';
  $('#ackMeta').innerHTML = `${esc(r.host_name)} · ${esc(r.host_addr || '')} · ${fmtTs(r.start_at)} · ${SEV_LABEL[r.severity] || '警告'}`;
  $('#ackDone').checked = !!r.acked;
  $('#ackDoneLabel').textContent = r.acked ? '保持「已处理」状态' : '标记为已处理';
  $('#ackNote').value = r.note || '';
  $('#ackModal').style.display = 'flex';
  $('#ackNote').focus();
}
$('#ackClose').addEventListener('click', () => hideModal('ackModal'));
$('#ackCancel').addEventListener('click', () => hideModal('ackModal'));
$('#ackSave').addEventListener('click', async () => {
  try {
    await api(`/records/${ackEditingId}/ack`, {
      method: 'POST',
      body: JSON.stringify({ acked: $('#ackDone').checked, note: $('#ackNote').value, actor: 'local' })
    });
    hideModal('ackModal');
    toast('处理记录已保存');
    loadRecords();
  } catch (e) { toast('保存失败：' + e.message); }
});

// ---------- 延迟 / 丢包曲线 ----------
let chartHostId = null;
async function openChart(hostId) {
  chartHostId = hostId;
  const h = state.hosts.find(x => x.id === hostId);
  $('#chartTitle').textContent = `延迟 / 丢包趋势 — ${h ? esc(h.name) : '#' + hostId}`;
  $('#chartModal').style.display = 'flex';
  await loadChart();
}
$('#chartClose').addEventListener('click', () => hideModal('chartModal'));
$('#chartRefresh').addEventListener('click', loadChart);
$('#chartHours').addEventListener('change', loadChart);
async function loadChart() {
  if (!chartHostId) return;
  const hours = $('#chartHours').value;
  try {
    const d = await api(`/hosts/${chartHostId}/latency?hours=${hours}`);
    const latTxt = v => v == null ? '—' : `${v < 1 ? '<1' : v} ms`;
    $('#chartStats').innerHTML = `
      <div>采样点<b>${d.total}</b></div>
      <div>丢包率<span class="loss"><b>${d.lossRate}%</b></span></div>
      <div>平均延迟<b>${latTxt(d.avg)}</b></div>
      <div>最低<b>${latTxt(d.min)}</b></div>
      <div>最高<b>${latTxt(d.max)}</b></div>`;
    drawChart(d.points, hours);
  } catch (e) { $('#chartStats').innerHTML = `<span class="fail">加载失败：${esc(e.message)}</span>`; }
}
function drawChart(points, hours) {
  const svg = $('#chartSvg');
  const W = 680, H = 260, padL = 38, padR = 10, padT = 14, padB = 24;
  const iw = W - padL - padR, ih = H - padT - padB;
  if (!points.length) {
    svg.innerHTML = '<text x="340" y="130" fill="#5b6678" font-size="14" text-anchor="middle">该时间段内暂无探测数据</text>';
    return;
  }
  const times = points.map(p => p.ts);
  const tMin = Math.min(...times), tMax = Math.max(...times);
  const latencies = points.filter(p => p.ok && p.latency != null).map(p => p.latency);
  const maxLat = Math.max(10, ...latencies) * 1.15;
  const x = ts => padL + (tMax === tMin ? iw / 2 : (ts - tMin) / (tMax - tMin) * iw);
  const y = lat => padT + ih - (lat / maxLat) * ih;
  const parts = [];
  // 网格线 + Y 轴刻度
  for (let i = 0; i <= 4; i++) {
    const gy = padT + ih * i / 4;
    const val = Math.round(maxLat * (1 - i / 4));
    parts.push(`<line x1="${padL}" y1="${gy}" x2="${W - padR}" y2="${gy}" stroke="#2a3547" stroke-width="1"/>`);
    parts.push(`<text x="${padL - 6}" y="${gy + 4}" fill="#5b6678" font-size="10" text-anchor="end">${val}</text>`);
  }
  // X 轴时间标签（首尾）
  const fmtAxis = ts => { const d = new Date(ts); return `${String(d.getMonth()+1).padStart(2,'0')}/${String(d.getDate()).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`; };
  parts.push(`<text x="${padL}" y="${H - 6}" fill="#5b6678" font-size="10">${fmtAxis(tMin)}</text>`);
  parts.push(`<text x="${W - padR}" y="${H - 6}" fill="#5b6678" font-size="10" text-anchor="end">${fmtAxis(tMax)}</text>`);
  // 掉线点（红色竖线标记）
  for (const p of points) {
    if (!p.ok) {
      parts.push(`<line x1="${x(p.ts)}" y1="${padT}" x2="${x(p.ts)}" y2="${padT + ih}" stroke="rgba(255,77,90,.35)" stroke-width="1"/>`);
    }
  }
  // 延迟折线
  const line = points.filter(p => p.ok && p.latency != null).map((p, i) => `${i ? 'L' : 'M'}${x(p.ts).toFixed(1)},${y(p.latency).toFixed(1)}`).join(' ');
  if (line) parts.push(`<path d="${line}" fill="none" stroke="#3498db" stroke-width="2" stroke-linejoin="round"/>`);
  // 在线点
  for (const p of points) {
    if (p.ok && p.latency != null) parts.push(`<circle cx="${x(p.ts).toFixed(1)}" cy="${y(p.latency).toFixed(1)}" r="1.8" fill="#5dade2"/>`);
  }
  svg.innerHTML = parts.join('');
}

// ---------- 启动 ----------
(async () => {
  const ok = await authCheck();
  if (!ok) return;
  refreshAll();
  state.timer = setInterval(() => {
    if (state.view === 'overview' || state.view === 'hosts') refreshAll();
    if (state.view === 'records') loadRecords(); // 进行中的报警持续时长实时更新
  }, 10000);
})();
