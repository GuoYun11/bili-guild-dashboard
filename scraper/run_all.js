// run_all.js — B站工会主播数据抓取 + 腾讯云表格写入（单进程、覆盖模式、供定时任务调用）
// 用法: cd bili-guild-monitor && unset NODE_PATH && node run_all.js
// 说明: 同一浏览器上下文内先抓 B站 23 房间（支持 今日/昨日/本周/本月 四个周期）, 再开腾讯文档用剪贴板 TSV 粘贴覆盖写入 A1。
const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');

const OUTDIR = process.env.OUTDIR || __dirname;
// Chrome 可执行文件：云端用 playwright 自带的 chromium；本地未设则用系统 Chrome
function resolveChrome() {
  const p = process.env.CHROME_PATH;
  if (p && fs.existsSync(p)) return p;
  try { const ep = require('playwright').chromium.executablePath(); if (ep && fs.existsSync(ep)) return ep; } catch (e) {}
  try { const ep = require('playwright-core').chromium.executablePath(); if (ep && fs.existsSync(ep)) return ep; } catch (e) {}
  return 'C:/Program Files/Google/Chrome/Application/chrome.exe';
}
const CHROME = resolveChrome();
const PROFILE = process.env.CHROME_PROFILE || 'C:/Users/win10/WorkBuddy/2026-07-21-19-34-42/.chrome_profile_login';
const BILI_URL = 'https://live.bilibili.com/galaxy/center/data/anchor?tab=list';
const DOCS_URL = 'https://docs.qq.com/sheet/DTkZtTkVkZ0V5bkh4?tab=BB08J2';

// 默认房间列表（当 data/rooms.json 不存在时使用，并自动写出以便后续维护）
const DEFAULT_ROOM_IDS = [
  1722696335, 1832046306, 3490234, 1879000891, 1994820614,
  1994826644, 14185201, 1984345335, 1931024436, 2479015,
  1811338562, 1934308252, 1876315197, 1876312516, 1941163245,
  1941166836, 1876319219, 1934300727, 1842985015, 1842984494,
  1933934429, 1941168728, 1727073471,
];

const ROOMS_FILE = path.join(OUTDIR, 'data', 'rooms.json');

/** 从命令行参数解析 --rooms-file */
function getCustomRoomsFile() {
  const idx = process.argv.indexOf('--rooms-file');
  if (idx !== -1 && process.argv[idx + 1]) {
    const p = path.resolve(process.argv[idx + 1]);
    if (fs.existsSync(p)) return p;
    console.log('警告: 指定的 rooms-file 不存在:', p);
  }
  return null;
}

/** 读取房间列表：优先 rooms.json，不存在则写入默认列表 */
function loadRoomIds() {
  const customFile = getCustomRoomsFile();
  const targetFile = customFile || ROOMS_FILE;
  try {
    const txt = fs.readFileSync(targetFile, 'utf8');
    const obj = JSON.parse(txt);
    if (Array.isArray(obj.rooms) && obj.rooms.length) {
      // 去重 + 转数字
      const ids = [...new Set(obj.rooms.map(id => Number(id)).filter(Boolean))];
      log('从', customFile ? '自定义' : '默认', 'rooms.json 读取到房间数:', ids.length);
      return ids;
    }
  } catch (e) { /* 文件不存在或解析失败，走默认 */ }
  // 写出默认列表供后续维护
  fs.mkdirSync(path.dirname(ROOMS_FILE), { recursive: true });
  fs.writeFileSync(ROOMS_FILE, JSON.stringify({ rooms: DEFAULT_ROOM_IDS }, null, 2));
  log('已写出默认 rooms.json, 房间数:', DEFAULT_ROOM_IDS.length);
  return [...DEFAULT_ROOM_IDS];
}

// 支持的时间周期定义（tabText 字段保留兼容，现已不再用于 UI 点击）
const PERIODS = [
  { key: 'today',     label: '今日',   tabText: '今日' },
  { key: 'yesterday', label: '昨日',   tabText: '昨日' },
  { key: 'week',      label: '本周',   tabText: '本周' },
  { key: 'month',     label: '本月',   tabText: '本月' },
];

// ---------- 调用 B站工会后台数据接口（记录多字段便于对比 B站后台显示值）----------
const TIME_RANGE = { today: 1, yesterday: 5, week: 10, month: 15 };
const ANCHOR_API = 'https://api.live.bilibili.com/xlive/mcn-interface/v1/mcn_mng/GetAnchorList';

function buildAnchorUrl(timeRange, page = 1, pageSize = 10) {
  const p = new URLSearchParams({
    search: '', search_type: '2', order_by: '', order_type: '',
    is_new: '0', top_star_level: '', time_range: String(timeRange),
    start_date: '', end_date: '', all_data: '1', page: String(page), page_size: String(pageSize),
  });
  return `${ANCHOR_API}?${p.toString()}`;
}

async function fetchPeriodAnchors(page, timeRange) {
  const map = new Map();
  if (!page.request) { log('   ⚠ page.request 不可用'); return map; }
  const pageSize = 10;
  let debugDone = false;
  for (let pageNum = 1, guard = 0; guard < 10; pageNum++, guard++) {
    const url = buildAnchorUrl(timeRange, pageNum, pageSize);
    const resp = await page.request.get(url, {
      timeout: 30000,
      headers: { Referer: BILI_URL, 'X-Requested-With': 'XMLHttpRequest' },
    }).catch(e => { log('   ⚠ API 请求失败:', e.message); return null; });
    if (!resp) break;
    let j;
    try { j = await resp.json(); } catch (e) { log('   ⚠ 解析失败:', e.message); break; }
    if (!j || j.code !== 0) { log('   ⚠ API code=', j && j.code, 'msg=', j && j.message); break; }
    const items = (j.data && Array.isArray(j.data.items)) ? j.data.items : [];
    // 调试：对房间 1842985015 输出 API 返回的全部字段
    if (!debugDone) {
      for (const it of items) {
        if (String(it.room_id) === '1842985015') {
          log(`   [DEBUG 1842985015] keys:`, Object.keys(it).join(', '));
          log(`   [DEBUG 1842985015]`, {
            room_id: it.room_id, uname: it.uname, uid: it.uid,
            total_coin: it.total_coin, break_coin: it.break_coin, income: it.income,
            total_gold: it.total_gold, total_revenue: it.total_revenue,
            anchor_income: it.anchor_income, gift_value: it.gift_value,
          });
          debugDone = true;
        }
      }
    }
    for (const it of items) { if (it.room_id != null) map.set(Number(it.room_id), it); }
    if (items.length < pageSize) break;
    await sleep(300);
  }
  return map;
}

const stamp = () => new Date().toLocaleString('zh-CN', { hour12: false });
const log = (...a) => console.log(stamp(), ...a);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---------- 从 GitHub Pages 仓库拉取最新配置文件 ----------
async function pullConfigFromRepo(){
  const files = ['notes.json', 'rooms.json'];
  const branch = process.env.CONFIG_BRANCH || 'main';
  const baseUrl = `https://raw.githubusercontent.com/GuoYun11/bili-guild-dashboard/${branch}/data`;
  const dataDir = path.join(OUTDIR, 'data');
  let changed = false;

  for (const file of files) {
    const url = `${baseUrl}/${file}`;
    try {
      const resp = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (!resp.ok) { log(`   仓库文件 ${file} 不存在或无法访问 (${resp.status})`); continue; }
      const remoteContent = await resp.text();
      const localPath = path.join(dataDir, file);
      let localContent = '';
      try { localContent = fs.readFileSync(localPath, 'utf8'); } catch(e) {}

      if (remoteContent !== localContent) {
        fs.writeFileSync(localPath, remoteContent);
        log(`   ✅ 已从仓库同步 ${file} (仓库内容与本地不一致，已覆盖)`);
        changed = true;
      } else {
        log(`   ✓ ${file} 已是最新，无需同步`);
      }
    } catch(e) {
      log(`   ⚠ 拉取 ${file} 失败:`, e.message);
    }
  }
  return changed;
}

// ---------- B站: 切换时间周期 Tab（今日/昨日/本周/本月）----------
async function clickPeriodTab(page, tabText) {
  const logTab = (...a) => log(`   [tab:${tabText}]`, ...a);

  // 收集所有文本精确匹配且可见的候选元素
  const collect = () => page.evaluate((target) => {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const tgt = clean(target);
    return [...document.querySelectorAll('button,[role="tab"],li,span,div,a')]
      .filter(el => el.offsetParent !== null && clean(el.innerText || el.textContent || '') === tgt)
      .map(el => ({
        tag: el.tagName,
        cls: (el.className || '').toString(),
        role: el.getAttribute('role') || '',
        rect: (() => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })(),
      }));
  }, tabText);

  const cands = await collect();
  if (!cands.length) { logTab('未找到候选元素'); return { ok: false }; }

  // 优先级：role=tab / class 含 tab|radio|segment|item / button > 其它
  const rank = (o) => {
    let s = 0;
    if (o.role === 'tab') s += 100;
    if (/tab|radio|segment|item|pill/i.test(o.cls)) s += 50;
    if (o.tag === 'BUTTON') s += 30;
    if (o.tag === 'LI') s += 20;
    if (o.tag === 'A') s += 10;
    if (o.rect.w > 0 && o.rect.h > 0) s += 5;
    return s;
  };
  const ordered = cands.slice().sort((a, b) => rank(b) - rank(a));
  logTab('候选', ordered.length, '个, 最优:', ordered[0].tag, ordered[0].cls.slice(0, 40));

  // 读取当前 active 周期文本（用于校验是否真的切过去了）
  const activeTabText = () => page.evaluate(() => {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const labels = ['今日', '昨日', '本周', '本月'];
    const act = [...document.querySelectorAll('button,[role="tab"],li,span,div,a')].filter(el => {
      if (el.offsetParent === null) return false;
      const c = (el.className || '').toString();
      const sel = el.getAttribute('aria-selected');
      return /(^|\s)(is-active|active|selected)($|\s)/.test(c) || sel === 'true';
    }).map(el => clean(el.innerText || el.textContent || '')).filter(t => labels.includes(t));
    return act[0] || '';
  });

  for (const cand of ordered) {
    // 关键修复: 用真实鼠标点击元素中心（能触发 React/Vue 的 onClick），比 el.click() 可靠
    if (cand.rect.w > 0 && cand.rect.h > 0) {
      await page.mouse.click(cand.rect.x + cand.rect.w / 2, cand.rect.y + cand.rect.h / 2).catch(() => {});
    } else {
      await page.evaluate((target) => {
        const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
        const els = [...document.querySelectorAll('button,[role="tab"],li,span,div,a')].filter(el => el.offsetParent !== null && clean(el.innerText || el.textContent || '') === target);
        if (els[0]) els[0].click();
      }, tabText);
    }
    await sleep(2500);

    // 轮询等待表格数据稳定（连续两次采样一致说明加载完毕）
    let stable = 0, last = '';
    for (let i = 0; i < 14; i++) {
      await sleep(500);
      const sample = await page.evaluate(() => {
        const rows = document.querySelectorAll('.el-table__row, table tbody tr, [role="row"]');
        if (!rows.length) return '';
        const cells = rows[0].querySelectorAll('td, [role="gridcell"]');
        return [...cells].map(c => (c.textContent || '').trim().replace(/\s+/g, ' ')).join('|').slice(0, 200);
      }).catch(() => '');
      if (sample && sample === last) { stable++; if (stable >= 2) { logTab('数据已稳定'); break; } }
      else { stable = 0; last = sample; }
    }

    // B站 el-radio 不设标准 active/css/aria 状态，无法可靠检测；信任点击已生效
    logTab('已点击候选，假定切换成功 (activeText 检测不可用于此页面)');
    return { ok: true };
  }
  logTab('所有候选均无法点击（无可见元素）');
  return { ok: false };
}

// 解析流水文本为数值
const parseRevenue = (s) => {
  if (!s) return null;
  let v = (s || '').replace(/元/g, '').replace(/,/g, '').trim();
  let mult = 1;
  if (/万/.test(v)) { mult = 10000; v = v.replace(/万/g, ''); }
  const n = parseFloat(v);
  return isNaN(n) ? null : n * mult;
};

// ---------- B站: 切换到"房间号"搜索模式并输入 ----------
async function switchToRoomMode(page) {
  const rect = await page.evaluate(() => {
    const el = document.querySelector('input[placeholder="请输入主播昵称"], input[placeholder="请输入房间号"], input[placeholder="请输入主播UID"]');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), ph: el.placeholder };
  });
  if (!rect) return { ok: false, reason: 'NO_SEARCH_INPUT' };
  if (rect.ph === '请输入房间号') return { ok: true, mode: 'already' };
  const arrowX = rect.x - 40, arrowY = rect.y + rect.h / 2;
  await page.mouse.click(arrowX, arrowY);
  await sleep(800);
  const picked = await page.evaluate(() => {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const lis = [...document.querySelectorAll('li, [role="option"], .el-select-dropdown__item')];
    const target = lis.find(li => li.offsetParent !== null && clean(li.innerText) === '房间号');
    if (target) { target.click(); return { ok: true, text: '房间号' }; }
    return { ok: false, visibleOptions: lis.filter(li => li.offsetParent !== null).map(li => clean(li.innerText)).slice(0, 10) };
  });
  if (!picked.ok) return { ok: false, reason: 'ROOM_OPTION_NOT_FOUND', options: picked.visibleOptions };
  await sleep(600);
  return { ok: true, mode: 'switched' };
}

async function searchRoom(page, roomId) {
  const modeRes = await switchToRoomMode(page);
  if (!modeRes.ok) return { room_id: roomId, error: 'MODE_SWITCH_FAILED', detail: modeRes };
  const input = await page.$('input[placeholder="请输入房间号"]');
  if (!input) return { room_id: roomId, error: 'NO_ROOM_INPUT' };
  await input.click({ clickCount: 3 }).catch(() => {});
  await sleep(200);
  await input.fill(String(roomId));
  await sleep(300);
  const qBtn = await page.$('button:has-text("查询")');
  if (!qBtn) return { room_id: roomId, error: 'NO_QUERY_BTN' };
  await qBtn.click();
  await sleep(3500);
  return { ok: true };
}

async function extractRow(page, roomId, isFirst) {
  const data = await page.evaluate(({ rid, firstDump }) => {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const out = { room_id: rid };
    const rows = [...document.querySelectorAll('.el-table__row, table tbody tr, [role="row"]')]
      .filter(r => r.querySelectorAll('td, [role="gridcell"]').length > 0);
    out.totalRows = rows.length;
    const allCells = [...document.querySelectorAll('td, [role="gridcell"]')];
    const isHidden = (c) => (c.className || '').toString().includes('is-hidden');
    const colCell = (n) => allCells.find(c => {
      const cls = (c.className || '').toString();
      return new RegExp(`column_${n}(?:\\s|$)`).test(cls) && !isHidden(c) && clean(c.innerText).length > 0;
    });
    const anchorCell = colCell(1), opCell = colCell(2), revCell = colCell(10);
    out.foundAnchor = !!anchorCell; out.foundOp = !!opCell; out.foundRev = !!revCell;
    if (!anchorCell) { out.error = 'NO_DATA_ROW'; out.pageText = clean(document.body ? document.body.innerText : '').slice(0, 400); return JSON.stringify(out); }
    const anchorText = clean(anchorCell.innerText), opText = clean(opCell.innerText), revText = clean(revCell.innerText);
    let nickname = '', uid = '', roomFromRow = '';
    const m = anchorText.match(/^(.*?)\s*UID[：:]\s*(\d+)\s*房间号[：:]\s*(\d+)/);
    if (m) { nickname = m[1].trim(); uid = m[2]; roomFromRow = m[3]; }
    let revenue = '';
    const rm = revText.match(/([\d,]+\.?\d*)\s*元/);
    if (rm) revenue = rm[1] + '元';
    out.nickname = nickname; out.uid = uid; out.roomFromRow = roomFromRow; out.operator = opText; out.revenue = revenue;
    out.rawAnchor = anchorText; out.rawRevenue = revText;
    if (firstDump) { out.headers = [...document.querySelectorAll('th')].map(h => clean(h.innerText)); out.anchorCellHTML = anchorCell.innerHTML.slice(0, 1200); }
    return JSON.stringify(out);
  }, { rid: roomId, firstDump: isFirst });
  const parsed = JSON.parse(data);
  if (!parsed.error) parsed.scraped_at = stamp();
  return parsed;
}

// ---------- 腾讯文档: 剪贴板 TSV 覆盖写入 ----------
async function writeDocs(ctx, rows) {
  try { await ctx.grantPermissions(['clipboard-read', 'clipboard-write']); } catch (e) { log('grant_perm_err', e.message); }
  const page = await ctx.newPage();
  await page.goto(DOCS_URL, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(e => log('goto_err', e.message));
  await sleep(8000);
  const gate = await page.evaluate(() => ({ hasCanvas: document.querySelectorAll('canvas').length, loginHint: /请登录后使用|立即登录/.test(document.body ? document.body.innerText : '') }));
  log('文档状态:', JSON.stringify(gate));
  if (gate.loginHint) { await page.screenshot({ path: path.join(OUTDIR, 'docs_not_logged_in.png') }).catch(() => {}); return { ok: false, reason: 'NOT_LOGGED_IN' }; }
  await sleep(1500);
  const boxes = await page.evaluate(() => [...document.querySelectorAll('canvas')].map(c => { const r = c.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, area: r.width * r.height }; }).filter(c => c.w > 50 && c.h > 50).sort((a, b) => b.area - a.area));
  log('canvas 候选:', JSON.stringify(boxes.slice(0, 3)));
  const main = boxes[0];
  if (!main) return { ok: false, reason: 'NO_CANVAS' };
  await page.screenshot({ path: path.join(OUTDIR, 'docs_before_write.png') }).catch(() => {});
  await page.mouse.click(main.x + main.w / 2, main.y + main.h / 2);
  await sleep(600);
  await page.keyboard.press('Control+Home');
  await sleep(500);
  const header = ['房间号', '主播昵称', 'UID', '运营经纪人', '总流水', '更新时间'];
  const tsv = [header, ...rows].map(r => r.join('\t')).join('\n');
  try {
    await page.evaluate(async (txt) => { await navigator.clipboard.writeText(txt); }, tsv);
    await sleep(400);
    const clipCheck = await page.evaluate(() => navigator.clipboard.readText().catch(() => ''));
    log('剪贴板写入校验长度:', clipCheck.length);
    await page.keyboard.press('Control+v');
    await sleep(2000);
  } catch (e) {
    log('剪贴板粘贴失败, 回退键盘输入:', e.message);
    await page.keyboard.press('Control+Home'); await sleep(300);
    for (const r of [header, ...rows]) { for (let i = 0; i < r.length; i++) { await page.keyboard.type(String(r[i])); if (i < r.length - 1) await page.keyboard.press('Tab'); } await page.keyboard.press('Enter'); }
    await sleep(1500);
  }
  await page.screenshot({ path: path.join(OUTDIR, 'docs_after_write.png') }).catch(() => {});
  return { ok: true, written: rows.length };
}

// ---------- 主流程 ----------
(async () => {
  fs.mkdirSync(OUTDIR, { recursive: true });
  log('启动 Chrome (profile=', PROFILE, ')');
  const ctx = await chromium.launchPersistentContext(PROFILE, {
    executablePath: CHROME, headless: true, viewport: { width: 1440, height: 900 },
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--no-first-run', '--no-default-browser-check',
           '--disable-background-networking', '--disable-sync', '--disable-features=Translate',
           '--disable-extensions', '--disable-gpu', '--disable-dev-shm-usage'],
  });
  // 云端支持：从密钥(BILI_COOKIES)或文件(COOKIES_FILE)注入 B站登录 Cookie（无本地登录态时必需）
  const cookiesEnv = process.env.BILI_COOKIES;
  const cookiesFile = process.env.COOKIES_FILE;
  let cookies = null;
  if (cookiesEnv) { try { cookies = JSON.parse(cookiesEnv); } catch (e) { log('⚠ BILI_COOKIES 解析失败:', e.message); } }
  else if (cookiesFile && fs.existsSync(cookiesFile)) { try { cookies = JSON.parse(fs.readFileSync(cookiesFile, 'utf8')); } catch (e) { log('⚠ COOKIES_FILE 解析失败:', e.message); } }
  if (Array.isArray(cookies) && cookies.length) {
    try { await ctx.addCookies(cookies); log('✓ 已从密钥/文件注入', cookies.length, '条 Cookie'); }
    catch (e) { log('⚠ Cookie 注入失败:', e.message); }
  }
  const biliPage = ctx.pages[0] || await ctx.newPage();
  biliPage.on('console', m => { if (m.type() === 'error') log('[cerr]', m.text().slice(0, 120)); });

  // Step 1: B站抓取（多周期）
  log('打开 B站工会后台');
  await biliPage.goto(BILI_URL, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(e => log('goto_err', e.message));
  await sleep(5000);
  const biliBody = await biliPage.evaluate(() => (document.body ? document.body.innerText : '').slice(0, 200)).catch(() => '');
  if (/账号未登录|请登录|立即登录/.test(biliBody)) {
    log('⚠️ B站未登录'); await ctx.close(); console.log(JSON.stringify({ status: 'BILI_NOT_LOGGED_IN' }, null, 2)); process.exit(2);
  }
  log('✓ B站已登录');

  // Step 0: 从仓库拉取最新配置文件（notes.json / rooms.json），捕获看板端的自动同步变更
  log('\n===== 同步仓库配置 =====');
  const configChanged = await pullConfigFromRepo();
  if (configChanged) log('⚠ 配置文件已更新，将使用最新的房间列表和备注数据');

  const ROOM_IDS = loadRoomIds();
  const progressPath = path.join(OUTDIR, 'result_progress.json');
  const allPeriodsData = {};  // { today: {...}, yesterday: {...}, ... }

  // Step 1: 通过后台接口拉取四个周期的主播数据
  const rawByPeriod = {};
  for (const pi in PERIODS) {
    const period = PERIODS[pi];
    log(`\n===== 拉取周期 [${period.label}] (${Number(pi)+1}/${PERIODS.length}) time_range=${TIME_RANGE[period.key]} =====`);
    const map = await fetchPeriodAnchors(biliPage, TIME_RANGE[period.key]);
    rawByPeriod[period.key] = map;
    log(`   接口返回主播数: ${map.size}`);
    fs.writeFileSync(progressPath, JSON.stringify({ period: period.key, count: map.size }));
  }

  // 汇总身份（昵称/UID/运营经纪人）跨周期取首个非空，保证各周期房间身份一致
  const identity = {};
  // 优先从 API 汇总，再补充 profiles.json 的静态映射
  let profiles = {};
  try { profiles = JSON.parse(fs.readFileSync(path.join(OUTDIR, 'data', 'profiles.json'), 'utf8')) || {}; } catch(e) {}
  const profileForRoom = (rid) => profiles[String(rid)] || {};

  for (const key of Object.keys(rawByPeriod)) {
    for (const [rid, it] of rawByPeriod[key]) {
      if (!identity[rid] && (it.uname || it.uid)) {
        identity[rid] = { room_id: rid, nickname: it.uname || ('房间' + rid), uid: it.uid, operator: it.staff_uname || '' };
      }
    }
  }
  // 未在 API 中出现的房间，尝试从 profiles.json 补充身份
  for (const rid of ROOM_IDS) {
    if (!identity[rid]) {
      const pf = profileForRoom(rid);
      if (pf.uid || pf.nickname) {
        identity[rid] = { room_id: rid, nickname: pf.nickname || ('房间' + rid), uid: pf.uid, operator: pf.operator || '' };
      }
    }
  }

  // Step 2: 按监控房间列表装配各周期数据
  for (const pi in PERIODS) {
    const period = PERIODS[pi];
    const map = rawByPeriod[period.key];
    const scrapedAt = stamp();
    const cleanRooms = ROOM_IDS.map(rid => {
      const it = map.get(rid);
      const id = identity[rid] || { room_id: rid, nickname: '房间' + rid, uid: '', operator: '' };
      const rv = it ? Math.round(Number(it.break_coin) || 0) : 0;
      const op = (it && it.staff_uname) ? it.staff_uname : id.operator;
      const opTop = (op || '').split('|')[0].trim() || op || '未分组';
      return {
        room_id: rid,
        nickname: (it && it.uname) ? it.uname : id.nickname,
        uid: (it && it.uid) ? it.uid : id.uid,
        operator: op,
        operator_top: opTop,
        revenue: rv + '元',
        revenue_value: rv,
        scraped_at: scrapedAt,
        missing: false,
      };
    });
    const totalRev = cleanRooms.reduce((a, r) => a + (r.revenue_value || 0), 0);
    const sorted = [...cleanRooms].sort((a, b) => (b.revenue_value || 0) - (a.revenue_value || 0));
    const ok = cleanRooms.filter(r => !r.missing).length;
    allPeriodsData[period.key] = {
      label: period.label,
      scraped_at: scrapedAt,
      generated_at: new Date().toISOString(),
      count: ROOM_IDS.length,
      success: ok,
      summary: {
        total_revenue: Math.round(totalRev),
        avg_revenue: cleanRooms.length ? Math.round(totalRev / cleanRooms.length) : 0,
        max_revenue: sorted[0] || null,
        min_revenue: sorted[sorted.length - 1] || null,
      },
      rooms: cleanRooms,
    };
    log(`   周期[${period.label}]完成: 命中 ${ok}/${ROOM_IDS.length}, 总流水 ¥${Math.round(totalRev)}`);
  }

  // 跨周期合理性日志：今日/昨日/本周/本月 总额对比
  const tNow = allPeriodsData['today']?.summary?.total_revenue || 0;
  const tYest = allPeriodsData['yesterday']?.summary?.total_revenue || 0;
  const tWeek = allPeriodsData['week']?.summary?.total_revenue || 0;
  const tMon = allPeriodsData['month']?.summary?.total_revenue || 0;
  log(`\n📊 四周期总额: 今日 ¥${tNow} | 昨日 ¥${tYest} | 本周 ¥${tWeek} | 本月 ¥${tMon}`);
  if (tWeek <= tNow + 2) log('   ⚠ 本周总额未明显高于今日，请核查接口 time_range 映射');
  if (tMon <= tWeek + 2) log('   ⚠ 本月总额未明显高于本周，请核查接口 time_range 映射');

  // ---- 解析并写出本地看板数据（供局域网网页读取，含多周期）----
  const dataDir = path.join(OUTDIR, 'data');
  fs.mkdirSync(dataDir, { recursive: true });

  // 构建多周期 latest.json（dashboard 按需切换）
  const activePeriod = allPeriodsData['today'] || allPeriodsData[Object.keys(allPeriodsData)[0]];
  const latest = {
    scraped_at: stamp(),
    generated_at: new Date().toISOString(),
    active_period: 'today',
    periods: allPeriodsData,
    // 向后兼容: 顶层也放一份当前活跃周期的数据
    count: activePeriod?.count || 0,
    success: activePeriod?.success || 0,
    summary: activePeriod?.summary || null,
    rooms: activePeriod?.rooms || [],
  };
  fs.writeFileSync(path.join(dataDir, 'latest.json'), JSON.stringify(latest, null, 2));

  // 历史快照（趋势分析用）— 用今日数据作为主快照
  const histPath = path.join(dataDir, 'history.json');
  let history = { snapshots: [] };
  try { history = JSON.parse(fs.readFileSync(histPath, 'utf8')); if (!Array.isArray(history.snapshots)) history.snapshots = []; } catch (e) {}
  if (activePeriod && activePeriod.rooms) {
    history.snapshots.push({
      scraped_at: latest.scraped_at,
      generated_at: latest.generated_at,
      total_revenue: activePeriod.summary?.total_revenue || 0,
      avg_revenue: activePeriod.summary?.avg_revenue || 0,
      count: activePeriod.success,
      periods_snapshot: Object.fromEntries(
        Object.entries(allPeriodsData).filter(([k,v]) => !v.error).map(([k,v]) => [k, {
          total_revenue: v.summary?.total_revenue || 0,
          avg_revenue: v.summary?.avg_revenue || 0,
          count: v.success,
        }])
      ),
      rooms: activePeriod.rooms.map(r => ({ room_id: r.room_id, nickname: r.nickname, uid: r.uid || '', operator: r.operator || '', revenue_value: r.revenue_value })),
    });
  }
  if (history.snapshots.length > 500) history.snapshots = history.snapshots.slice(-500);
  fs.writeFileSync(histPath, JSON.stringify(history));
  log('已写出本地看板数据: data/latest.json (含' + Object.keys(allPeriodsData).length + '个周期) + data/history.json');

  // 同时保存原始结果文件
  const rf = path.join(OUTDIR, `result_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}.json`);
  fs.writeFileSync(rf, JSON.stringify(allPeriodsData, null, 2));
  log(`抓取完成 -> ${rf}`);

  // ---- 同步数据文件到 dist/ 目录（供 GitHub Pages 部署）----
  const distDir = path.join(OUTDIR, 'dist', 'data');
  fs.mkdirSync(distDir, { recursive: true });
  const syncFiles = ['latest.json', 'history.json', 'rooms.json', 'notes.json', 'profiles.json'];
  for (const f of syncFiles) {
    const src = path.join(dataDir, f);
    const dst = path.join(distDir, f);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, dst);
      log(`   同步 data/${f} -> dist/data/`);
    }
  }
  log('✓ 已同步数据文件到 dist/ (供 GitHub Pages 部署)');

  // ---- 可选: 写入腾讯文档（默认关闭，设 WRITE_TENCENT=1 开启）----
  if (process.env.WRITE_TENCENT === '1' && activePeriod && activePeriod.rooms) {
    const rows = activePeriod.rooms.map(r => [String(r.room_id), r.nickname, r.uid, r.operator, r.revenue, r.scraped_at || '']);
    const writeRes = await writeDocs(ctx, rows);
    log('写入腾讯文档结果:', JSON.stringify(writeRes));
  } else if (process.env.WRITE_TENCENT === '1') {
    log('腾讯文档写入跳过：无有效周期数据');
  } else {
    log('腾讯文档写入已跳过（如需开启请设环境变量 WRITE_TENCENT=1）');
  }

  await ctx.close().catch(e => log('ctx.close err', e && e.message ? e.message : e));
  const periodSummary = Object.fromEntries(Object.entries(allPeriodsData).map(([k,v]) => [k, v.error ? v.error : `${v.success}/${v.count}`]));
  console.log(JSON.stringify({ status: 'DONE', periods: periodSummary, resultFile: rf, dashboard: 'data/latest.json' }, null, 2));
})().catch(e => { console.error('FATAL', e && e.message ? e.message : e); process.exit(1); });
