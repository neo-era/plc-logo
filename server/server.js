/**
 * Server trung tâm — PLC LOGO! đa trạm.
 *
 * Tích hợp trong 1 process Node.js:
 *   - Aedes MQTT broker (1883 plain, 8883 TLS nếu config cert)
 *   - Express REST API   (HTTP_PORT)
 *   - WebSocket realtime  (cùng port HTTP, path /ws)
 *   - SQLite (better-sqlite3) lưu user, station, command log, state hiện tại
 *   - Auth: JWT cho user (REST + WS), gateway dùng username=stationId / password=gatewayToken cho MQTT
 *
 * Topic schema (xem docs/architecture.md):
 *   dentat/<stationId>/state            — gateway → server (retain): trạng thái hiện tại
 *   dentat/<stationId>/state/history    — gateway → server: state cũ đã buffer khi mất mạng
 *   dentat/<stationId>/cmd              — server → gateway: lệnh ghi
 *   dentat/<stationId>/ack              — gateway → server: ACK kết quả lệnh
 *   dentat/<stationId>/online           — gateway → server (retain + LWT): online/offline
 */
'use strict';

require('dotenv').config();
const fs       = require('fs');
const path     = require('path');
const http     = require('http');
const net      = require('net');
const tls      = require('tls');
const crypto   = require('crypto');
const express  = require('express');
const Aedes    = require('aedes');
const mqtt     = require('mqtt');
const { WebSocketServer } = require('ws');
const Database = require('better-sqlite3');
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');

const HTTP_PORT     = parseInt(process.env.HTTP_PORT || '8080');
const MQTT_PORT     = parseInt(process.env.MQTT_PORT || '1883');
const MQTT_TLS_PORT = parseInt(process.env.MQTT_TLS_PORT || '8883');
const DB_PATH       = process.env.DB_PATH || './data/plc.db';
const JWT_SECRET    = process.env.JWT_SECRET || 'dev-secret-change-me';
const RETENTION_DAYS = parseInt(process.env.HISTORY_RETENTION_DAYS || '30');
const MAX_HISTORY_PER_STATION = parseInt(process.env.HISTORY_MAX_PER_STATION || '10000');

// ── DB ─────────────────────────────────────────────────────────────
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    pass_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'operator',
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS stations (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    region TEXT DEFAULT '',
    token_hash TEXT NOT NULL,
    config_json TEXT NOT NULL DEFAULT '{}',
    online INTEGER NOT NULL DEFAULT 0,
    last_seen INTEGER,
    last_state TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS commands (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cmd_id TEXT NOT NULL,
    station_id TEXT NOT NULL,
    addr TEXT NOT NULL,
    value REAL,
    by_user TEXT,
    status TEXT NOT NULL DEFAULT 'sent',
    error TEXT,
    sent_at INTEGER NOT NULL,
    ack_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    station_id TEXT NOT NULL,
    ts INTEGER NOT NULL,
    state_json TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_history_station_ts ON history(station_id, ts DESC);
  CREATE INDEX IF NOT EXISTS idx_commands_station ON commands(station_id, sent_at DESC);
`);

// seed admin nếu chưa có
const adminUser = process.env.ADMIN_USER || 'admin';
const adminPass = process.env.ADMIN_PASS || 'admin';
if (!db.prepare('SELECT 1 FROM users WHERE username=?').get(adminUser)) {
  db.prepare('INSERT INTO users(username, pass_hash, role, created_at) VALUES (?,?,?,?)').run(
    adminUser, bcrypt.hashSync(adminPass, 10), 'admin', Date.now()
  );
  console.log(`[db] Seed admin: ${adminUser}`);
}

// ── AEDES MQTT BROKER ──────────────────────────────────────────────
const aedes = new Aedes();
const INTERNAL_SECRET = crypto.randomBytes(24).toString('hex'); // random mỗi lần boot, chỉ internal client trong process biết

aedes.authenticate = (client, username, password, cb) => {
  const pw = password ? password.toString() : '';
  // 1) Internal client của chính server (loopback)
  if (username === 'INTERNAL' && pw === INTERNAL_SECRET) {
    client.user = 'INTERNAL';
    return cb(null, true);
  }
  // 2) Gateway thật: username = stationId, password = gatewayToken (bcrypt-checked)
  if (!username) return cb(null, false);
  const stn = db.prepare('SELECT token_hash FROM stations WHERE id=?').get(username);
  if (!stn) return cb(null, false);
  bcrypt.compare(pw, stn.token_hash, (err, ok) => {
    if (ok) client.user = username; // gắn stationId vào client cho ACL dùng
    cb(null, !!ok);
  });
};

// ACL: bắt buộc topic phải nằm trong namespace của chính station
aedes.authorizePublish = (client, packet, cb) => {
  if (client.user === 'INTERNAL') return cb(null);
  if (!client.user || !packet.topic.startsWith(`dentat/${client.user}/`)) {
    return cb(new Error('topic không được phép'));
  }
  cb(null);
};
aedes.authorizeSubscribe = (client, sub, cb) => {
  if (client.user === 'INTERNAL') return cb(null, sub);
  if (!client.user || !sub.topic.startsWith(`dentat/${client.user}/`)) {
    return cb(new Error('topic không được phép'));
  }
  cb(null, sub);
};

// MQTT plain
net.createServer(aedes.handle).listen(MQTT_PORT, () => console.log(`[mqtt] Plain broker on :${MQTT_PORT}`));

// MQTT TLS (nếu có cert)
if (process.env.TLS_CERT_PATH && process.env.TLS_KEY_PATH) {
  const tlsOpts = {
    cert: fs.readFileSync(process.env.TLS_CERT_PATH),
    key:  fs.readFileSync(process.env.TLS_KEY_PATH),
  };
  tls.createServer(tlsOpts, aedes.handle).listen(MQTT_TLS_PORT, () =>
    console.log(`[mqtt] TLS broker on :${MQTT_TLS_PORT}`));
} else {
  console.warn('[mqtt] Không có TLS cert → chỉ chạy plain :1883. Production: đặt sau reverse-proxy TLS hoặc cấu hình TLS_CERT_PATH.');
}

// ── INTERNAL MQTT CLIENT (server tự subscribe để xử lý state/ack) ──
const internal = mqtt.connect(`mqtt://127.0.0.1:${MQTT_PORT}`, {
  clientId: 'server-internal-' + crypto.randomBytes(4).toString('hex'),
  username: 'INTERNAL', password: INTERNAL_SECRET,
  reconnectPeriod: 2000,
});

internal.on('connect', () => {
  console.log('[internal] Subscribed broker');
  internal.subscribe('dentat/+/state', { qos: 1 });
  internal.subscribe('dentat/+/state/history', { qos: 1 });
  internal.subscribe('dentat/+/online', { qos: 1 });
  internal.subscribe('dentat/+/ack',    { qos: 1 });
});

const upsertState   = db.prepare('UPDATE stations SET last_state=?, last_seen=? WHERE id=?');
const setOnline     = db.prepare('UPDATE stations SET online=?, last_seen=? WHERE id=?');
const insertHistory = db.prepare('INSERT INTO history(station_id, ts, state_json) VALUES (?,?,?)');
const ackCommand    = db.prepare(`UPDATE commands SET status=?, error=?, ack_at=? WHERE cmd_id=? AND station_id=?`);

internal.on('message', (topic, payload) => {
  const m = topic.match(/^dentat\/([^/]+)\/(state|state\/history|online|ack)$/);
  if (!m) return;
  const [, stnId, kind] = m;
  let data;
  try { data = JSON.parse(payload.toString()); } catch { return; }

  if (kind === 'state') {
    upsertState.run(JSON.stringify(data), Date.now(), stnId);
    insertHistory.run(stnId, data.ts || Date.now(), JSON.stringify(data));
    broadcastWS({ type: 'state', stationId: stnId, data });
  } else if (kind === 'state/history') {
    insertHistory.run(stnId, data.ts || Date.now(), JSON.stringify(data));
  } else if (kind === 'online') {
    setOnline.run(data.online ? 1 : 0, Date.now(), stnId);
    broadcastWS({ type: 'online', stationId: stnId, online: !!data.online });
  } else if (kind === 'ack') {
    ackCommand.run(data.ok ? 'ack' : 'error', data.error || null, Date.now(), data.id, stnId);
    broadcastWS({ type: 'ack', stationId: stnId, data });
  }
});

// dọn history định kỳ
setInterval(() => {
  const cutoff = Date.now() - RETENTION_DAYS * 86400 * 1000;
  const r1 = db.prepare('DELETE FROM history WHERE ts < ?').run(cutoff);
  const r2 = db.prepare(`DELETE FROM history WHERE id IN (
    SELECT id FROM history h1
    WHERE (SELECT COUNT(*) FROM history h2 WHERE h2.station_id = h1.station_id AND h2.id > h1.id) >= ?
  )`).run(MAX_HISTORY_PER_STATION);
  if (r1.changes || r2.changes) console.log(`[gc] history: -${r1.changes} (cũ), -${r2.changes} (quá hạn mức)`);
}, 6 * 3600 * 1000);

// ── REST API + STATIC ──────────────────────────────────────────────
const app = express();
app.use(express.json({ limit: '256kb' }));
app.use(express.static(path.join(__dirname, 'public')));

function authUser(req, res, next) {
  const h = req.headers.authorization || '';
  const tok = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!tok) return res.status(401).json({ error: 'thiếu token' });
  try { req.user = jwt.verify(tok, JWT_SECRET); next(); }
  catch { return res.status(401).json({ error: 'token không hợp lệ' }); }
}
function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'cần quyền admin' });
  next();
}

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  const u = db.prepare('SELECT * FROM users WHERE username=?').get(username);
  if (!u || !bcrypt.compareSync(password || '', u.pass_hash)) {
    return res.status(401).json({ error: 'sai tài khoản hoặc mật khẩu' });
  }
  const token = jwt.sign({ sub: u.id, username: u.username, role: u.role }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, user: { username: u.username, role: u.role } });
});

app.get('/api/stations', authUser, (req, res) => {
  const rows = db.prepare('SELECT id, name, region, online, last_seen, last_state, config_json FROM stations ORDER BY name').all();
  res.json(rows.map(r => ({
    id: r.id, name: r.name, region: r.region,
    online: !!r.online, lastSeen: r.last_seen,
    state: r.last_state ? JSON.parse(r.last_state) : null,
    config: JSON.parse(r.config_json || '{}'),
  })));
});

app.post('/api/stations', authUser, requireAdmin, (req, res) => {
  const { id, name, region, config } = req.body || {};
  if (!id || !name) return res.status(400).json({ error: 'thiếu id hoặc name' });
  if (db.prepare('SELECT 1 FROM stations WHERE id=?').get(id)) {
    return res.status(409).json({ error: 'trạm đã tồn tại' });
  }
  // sinh token gateway 32 byte hex
  const token = crypto.randomBytes(24).toString('hex');
  const hash = bcrypt.hashSync(token, 10);
  db.prepare('INSERT INTO stations(id, name, region, token_hash, config_json, created_at) VALUES (?,?,?,?,?,?)').run(
    id, name, region || '', hash, JSON.stringify(config || {}), Date.now()
  );
  // trả token 1 lần duy nhất — admin phải copy ngay vào gateway config
  res.json({ id, name, gatewayToken: token, mqttUsername: id });
});

app.delete('/api/stations/:id', authUser, requireAdmin, (req, res) => {
  db.prepare('DELETE FROM stations WHERE id=?').run(req.params.id);
  db.prepare('DELETE FROM history WHERE station_id=?').run(req.params.id);
  res.json({ ok: true });
});

app.post('/api/stations/:id/cmd', authUser, (req, res) => {
  const { addr, value } = req.body || {};
  if (!addr) return res.status(400).json({ error: 'thiếu addr' });
  const stn = db.prepare('SELECT 1 FROM stations WHERE id=?').get(req.params.id);
  if (!stn) return res.status(404).json({ error: 'trạm không tồn tại' });
  const cmdId = crypto.randomBytes(8).toString('hex');
  db.prepare('INSERT INTO commands(cmd_id, station_id, addr, value, by_user, sent_at) VALUES (?,?,?,?,?,?)').run(
    cmdId, req.params.id, addr, typeof value === 'boolean' ? (value?1:0) : Number(value), req.user.username, Date.now()
  );
  internal.publish(`dentat/${req.params.id}/cmd`, JSON.stringify({ id: cmdId, addr, value, ts: Date.now(), by: req.user.username }), { qos: 1 });
  res.json({ ok: true, cmdId });
});

app.get('/api/stations/:id/history', authUser, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 200, 5000);
  const rows = db.prepare('SELECT ts, state_json FROM history WHERE station_id=? ORDER BY ts DESC LIMIT ?').all(req.params.id, limit);
  res.json(rows.reverse().map(r => ({ ts: r.ts, ...JSON.parse(r.state_json) })));
});

app.get('/api/stations/:id/commands', authUser, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 500);
  const rows = db.prepare('SELECT cmd_id, addr, value, by_user, status, error, sent_at, ack_at FROM commands WHERE station_id=? ORDER BY sent_at DESC LIMIT ?').all(req.params.id, limit);
  res.json(rows);
});

// ── HTTP + WS ──────────────────────────────────────────────────────
const httpServer = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

httpServer.on('upgrade', (req, sock, head) => {
  if (!req.url.startsWith('/ws')) return sock.destroy();
  const url = new URL(req.url, 'http://x');
  const token = url.searchParams.get('token');
  try { req.user = jwt.verify(token, JWT_SECRET); }
  catch { sock.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); sock.destroy(); return; }
  wss.handleUpgrade(req, sock, head, ws => { ws.user = req.user; wss.emit('connection', ws); });
});

function broadcastWS(msg) {
  const txt = JSON.stringify(msg);
  wss.clients.forEach(c => { if (c.readyState === 1) c.send(txt); });
}

httpServer.listen(HTTP_PORT, () => console.log(`[http] REST + WS on :${HTTP_PORT}`));

// graceful
['SIGINT','SIGTERM'].forEach(s => process.on(s, () => {
  console.log('[server] Dừng...');
  internal.end(true);
  aedes.close(() => httpServer.close(() => process.exit(0)));
  setTimeout(() => process.exit(0), 3000);
}));
