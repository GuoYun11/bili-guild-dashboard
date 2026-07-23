#!/usr/bin/env node
'use strict';
/*
 * bili-guild-dashboard —— 只读分享后端
 * 零外部依赖：静态服务 + 分享令牌管理 + 写接口鉴权 + 手写 WebSocket 实时推送
 *
 * 运行：node server.js   （可选环境变量 PORT / ADMIN_SECRET / DATA_DIR）
 * 首次运行会随机生成 server/admin.secret，请妥善保存（或在环境变量 ADMIN_SECRET 中指定）。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const SERVER_DIR = __dirname;
const ROOT = path.resolve(__dirname, '..');                       // 项目根（含 index.html / data/）
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data'); // 数据目录
const SHARES_FILE = path.join(SERVER_DIR, 'shares.json');         // 分享令牌存储（不对外暴露）
const SECRET_FILE = path.join(SERVER_DIR, 'admin.secret');        // 管理员密钥（不对外暴露）
const PORT = parseInt(process.env.PORT || '8787', 10);

// ---------- 管理员密钥 ----------
let ADMIN_SECRET = process.env.ADMIN_SECRET || '';
if (!ADMIN_SECRET) {
  if (fs.existsSync(SECRET_FILE)) {
    ADMIN_SECRET = fs.readFileSync(SECRET_FILE, 'utf8').trim();
  } else {
    ADMIN_SECRET = crypto.randomBytes(24).toString('hex');
    fs.writeFileSync(SECRET_FILE, ADMIN_SECRET, { mode: 0o600 });
    console.log('\n[init] 已生成管理员密钥（admin secret）：\n  ' + ADMIN_SECRET +
      '\n       请将其填入看板「分享管理」弹窗的管理员密钥框，或设置环境变量 ADMIN_SECRET。\n');
  }
}

// ---------- 分享令牌存储 ----------
let shares = [];
if (fs.existsSync(SHARES_FILE)) {
  try { shares = JSON.parse(fs.readFileSync(SHARES_FILE, 'utf8')) || []; } catch (e) { shares = []; }
}
function saveShares() {
  try { fs.writeFileSync(SHARES_FILE, JSON.stringify(shares, null, 2)); } catch (e) { console.error('保存 shares 失败', e); }
}

function isValidShare(token) {
  const s = shares.find(x => x.token === token && !x.revoked);
  if (!s) return null;
  if (s.expiresAt && Date.now() > s.expiresAt) return null;
  return s;
}

// 鉴权解析：Bearer <token> -> { admin, shareToken }
function parseAuth(req) {
  const h = req.headers['authorization'] || '';
  if (h.startsWith('Bearer ')) {
    const t = h.slice(7).trim();
    if (t && t === ADMIN_SECRET) return { admin: true, shareToken: null };
    if (t && isValidShare(t)) return { admin: false, shareToken: t };
  }
  return { admin: false, shareToken: null };
}

// ---------- 工具 ----------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.map': 'application/json'
};

function sendJSON(res, code, obj, extraHeaders) {
  const body = JSON.stringify(obj);
  res.writeHead(code, Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, extraHeaders || {}));
  res.end(body);
}

function readDataFile(name) {
  // 仅允许 data/ 下已知文件，避免越权读取
  const allowed = new Set(['latest.json', 'history.json', 'rooms.json', 'notes.json', 'profiles.json']);
  if (!allowed.has(name)) return null;
  const p = path.join(DATA_DIR, name);
  if (!p.startsWith(DATA_DIR) || !fs.existsSync(p)) return null;
  try { return fs.readFileSync(p, 'utf8'); } catch (e) { return null; }
}

function writeDataFile(name, content) {
  const allowed = new Set(['rooms.json', 'notes.json']);
  if (!allowed.has(name)) return false;
  const p = path.join(DATA_DIR, name);
  if (!p.startsWith(DATA_DIR)) return false;
  try { fs.writeFileSync(p, content); return true; } catch (e) { return false; }
}

function getOrigin(req) {
  const proto = (req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
  const host = req.headers['x-forwarded-host'] || req.headers['host'] || ('localhost:' + PORT);
  return proto + '://' + host;
}

// ---------- 静态文件 ----------
function serveStatic(req, res) {
  let urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  if (urlPath === '/' || urlPath === '') urlPath = '/index.html';
  // 防目录穿越
  const safe = path.normalize(urlPath).replace(/^(\.\.[/\\])+/, '').replace(/^[/\\]+/, '');
  const filePath = path.join(ROOT, safe);
  if (!filePath.startsWith(ROOT)) { res.writeHead(403); return res.end('forbidden'); }
  fs.readFile(filePath, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(buf);
  });
}

// ===================================================================
//  WebSocket（手写 RFC6455，零依赖）—— 仅服务端 -> 客户端 单向实时推送
// ===================================================================
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const wsClients = new Set();

function broadcastWs(obj) {
  const payload = Buffer.from(JSON.stringify(obj), 'utf8');
  for (const sock of wsClients) sendWs(sock, payload);
}
function sendWs(sock, payload) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x81, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81; header[1] = 126; header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81; header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2);
  }
  try { sock.write(Buffer.concat([header, payload])); } catch (e) { /* ignore */ }
}

function handleWsFrame(sock, buf) {
  let offset = 0;
  while (offset + 2 <= buf.length) {
    const b0 = buf[offset], b1 = buf[offset + 1];
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let p = offset + 2;
    if (len === 126) { if (p + 2 > buf.length) break; len = buf.readUInt16BE(p); p += 2; }
    else if (len === 127) { if (p + 8 > buf.length) break; len = Number(buf.readBigUInt64BE(p)); p += 8; }
    let maskKey;
    if (masked) { if (p + 4 > buf.length) break; maskKey = buf.slice(p, p + 4); p += 4; }
    const payloadEnd = p + len;
    if (payloadEnd > buf.length) break; // 帧未接收完整
    if (opcode === 0x8) { // close
      try { sock.write(Buffer.from([0x88, 0x00])); } catch (e) {}
      sock.end(); return;
    } else if (opcode === 0x9) { // ping -> pong
      const pl = masked ? buf.slice(p, payloadEnd).map((v, i) => v ^ maskKey[i % 4]) : buf.slice(p, payloadEnd);
      const resp = Buffer.concat([Buffer.from([0x8a, len]), pl]);
      try { sock.write(resp); } catch (e) {}
    }
    // text/binary 帧（来自客户端）本服务不处理，直接跳过
    offset = payloadEnd;
  }
}

// ===================================================================
// HTTP 路由
// ===================================================================
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const pathname = u.pathname;
  const method = req.method.toUpperCase();

  // ---- WebSocket 升级 ----
  if (pathname === '/ws' && req.headers['upgrade'] && req.headers['upgrade'].toLowerCase() === 'websocket') {
    return; // 由 upgrade 事件处理
  }

  // ---- 只读数据接口（任何人可访问，含分享者）----
  if (method === 'GET' && pathname === '/api/data') { return serveApiData(res, 'latest.json'); }
  if (method === 'GET' && pathname === '/api/history') { return serveApiData(res, 'history.json'); }
  if (method === 'GET' && pathname === '/api/rooms') { return serveApiData(res, 'rooms.json'); }
  if (method === 'GET' && pathname === '/api/notes') { return serveApiData(res, 'notes.json'); }
  if (method === 'GET' && pathname === '/api/profiles') { return serveApiData(res, 'profiles.json'); }

  // ---- 分享令牌校验（公开，供前端判断是否仍有效）----
  if (method === 'GET' && pathname.startsWith('/api/share/')) {
    const token = decodeURIComponent(pathname.slice('/api/share/'.length));
    const s = isValidShare(token);
    if (s) return sendJSON(res, 200, { valid: true, token: s.token, label: s.label || '', createdAt: s.createdAt, expiresAt: s.expiresAt || null });
    return sendJSON(res, 403, { valid: false, reason: 'invalid_or_revoked', message: '分享链接无效、已撤销或已过期' });
  }

  // ---- 管理员：分享管理 ----
  if (method === 'POST' && pathname === '/api/admin/share') {
    const auth = parseAuth(req);
    if (!auth.admin) return sendJSON(res, 401, { error: 'unauthorized', message: '需要管理员密钥' });
    return readBody(req).then(body => {
      const label = (body.label || '').toString().slice(0, 60);
      let expiresAt = null;
      const hrs = Number(body.expiresInHours || 0);
      if (hrs > 0) expiresAt = Date.now() + hrs * 3600 * 1000;
      const token = crypto.randomBytes(24).toString('hex');
      const rec = { token, label, createdAt: Date.now(), expiresAt, revoked: false };
      shares.push(rec); saveShares();
      const url = getOrigin(req) + '/?share=' + token;
      return sendJSON(res, 200, { token, url, expiresAt, label });
    }).catch(() => sendJSON(res, 400, { error: 'bad_request' }));
  }
  if (method === 'GET' && pathname === '/api/admin/shares') {
    const auth = parseAuth(req);
    if (!auth.admin) return sendJSON(res, 401, { error: 'unauthorized', message: '需要管理员密钥' });
    const list = shares.map(s => ({
      token: s.token, label: s.label || '', createdAt: s.createdAt,
      expiresAt: s.expiresAt || null, revoked: !!s.revoked,
      expired: s.expiresAt ? Date.now() > s.expiresAt : false
    }));
    return sendJSON(res, 200, { shares: list });
  }
  if (method === 'DELETE' && pathname.startsWith('/api/admin/share/')) {
    const auth = parseAuth(req);
    if (!auth.admin) return sendJSON(res, 401, { error: 'unauthorized', message: '需要管理员密钥' });
    const token = decodeURIComponent(pathname.slice('/api/admin/share/'.length));
    const s = shares.find(x => x.token === token);
    if (!s) return sendJSON(res, 404, { error: 'not_found' });
    s.revoked = true; saveShares();
    // 立即广播，让仍连着的只读客户端刷新（链接已失效）
    broadcastWs({ type: 'share_revoked', token });
    return sendJSON(res, 200, { ok: true });
  }

  // ---- 写接口：房间 / 备注（管理员可写；分享令牌或无凭据 -> 拒绝）----
  if (method === 'POST' && (pathname === '/api/rooms' || pathname === '/api/notes')) {
    const auth = parseAuth(req);
    if (auth.shareToken) return sendJSON(res, 403, { error: 'readonly', message: '分享链接为只读，无法修改数据' });
    if (!auth.admin) return sendJSON(res, 401, { error: 'unauthorized', message: '需要管理员密钥' });
    return readBody(req).then(body => {
      if (pathname === '/api/rooms') {
        if (!Array.isArray(body.rooms)) return sendJSON(res, 400, { error: 'bad_rooms' });
        const ok = writeDataFile('rooms.json', JSON.stringify({ rooms: body.rooms }, null, 2));
        if (ok) { broadcastWs({ type: 'data' }); return sendJSON(res, 200, { ok: true }); }
        return sendJSON(res, 500, { error: 'write_failed' });
      } else {
        if (body.room_id == null) return sendJSON(res, 400, { error: 'bad_note' });
        // 合并写入 notes.json
        let notes = {};
        const raw = readDataFile('notes.json');
        if (raw) { try { notes = JSON.parse(raw) || {}; } catch (e) { notes = {}; } }
        const key = String(body.room_id);
        if (body.note === '' || body.note == null) delete notes[key];
        else notes[key] = String(body.note);
        const ok = writeDataFile('notes.json', JSON.stringify(notes, null, 2));
        if (ok) { broadcastWs({ type: 'data' }); return sendJSON(res, 200, { ok: true }); }
        return sendJSON(res, 500, { error: 'write_failed' });
      }
    }).catch(() => sendJSON(res, 400, { error: 'bad_request' }));
  }

  // ---- 静态资源 ----
  if (method === 'GET' || method === 'HEAD') return serveStatic(req, res);

  res.writeHead(405, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'method_not_allowed' }));
});

function serveApiData(res, name) {
  const raw = readDataFile(name);
  if (raw == null) return sendJSON(res, 404, { error: 'not_found', file: name });
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(raw);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', c => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

// ---- WebSocket upgrade 处理 ----
server.on('upgrade', (req, socket) => {
  if (new URL(req.url, 'http://localhost').pathname !== '/ws') { socket.destroy(); return; }
  const key = req.headers['sec-websocket-key'];
  if (!key) { socket.destroy(); return; }
  const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n'
  );
  socket.on('data', buf => handleWsFrame(socket, buf));
  socket.on('close', () => wsClients.delete(socket));
  socket.on('error', () => wsClients.delete(socket));
  wsClients.add(socket);
});

// ---- 监听 data/ 变化 -> 实时广播 ----
if (fs.existsSync(DATA_DIR)) {
  try {
    fs.watch(DATA_DIR, (eventType, filename) => {
      if (!filename) return;
      if (filename.endsWith('.json')) broadcastWs({ type: 'data', file: filename, ts: Date.now() });
    });
  } catch (e) { console.warn('[warn] 无法监听 data/ 目录变化：', e.message); }
}
// 心跳：保持连接、探测死链
setInterval(() => broadcastWs({ type: 'ping', ts: Date.now() }), 30000);

server.listen(PORT, () => {
  console.log('[server] bili-guild-dashboard 只读分享后端已启动');
  console.log('[server] 访问地址: http://localhost:' + PORT + '/');
  console.log('[server] 管理员密钥: ' + (ADMIN_SECRET ? '(已配置)' : '(缺失)'));
  console.log('[server] 实时通道: ws://localhost:' + PORT + '/ws');
});
