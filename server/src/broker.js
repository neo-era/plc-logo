'use strict';
/**
 * Broker MQTT (Aedes 1.x) qua WebSocket — chạy sau Caddy tại /mqtt, KHÔNG mở cổng 1883/8883.
 * Gateway đăng nhập: username = stationId, password = khoá; clientId bắt buộc = gw-<stationId>.
 * ACL: tủ X chỉ publish lvc/X/{state,ack,online}, chỉ subscribe lvc/X/{cmd,config}.
 */
const { WebSocketServer, createWebSocketStream } = require('ws');
const { verifyKeyAsync } = require('./keys');

const STATION_RE = /^[A-Z0-9-]{1,32}$/;
const PUB_OK = ['state', 'ack', 'online', 'hist'];
const SUB_OK = ['cmd', 'config'];
const FAIL_LIMIT = 5, FAIL_WINDOW = 10 * 60e3, BLOCK_MS = 15 * 60e3;
const MAX_PAYLOAD = 16 * 1024;

/** IP thật của kết nối: chỉ tin X-Forwarded-For khi kết nối đến từ proxy tin cậy (Caddy). */
function clientIp(req, trustedProxies) {
  const remote = (req?.socket?.remoteAddress || '').replace(/^::ffff:/, '') || 'unknown';
  if (trustedProxies.includes(remote)) {
    const xff = String(req.headers['x-forwarded-for'] || '').split(',').map(x => x.trim()).filter(Boolean);
    if (xff.length) return xff[xff.length - 1];
  }
  return remote;
}

async function createBroker({ getStation, onState, onAck, onOnline, onHist = () => {}, log = () => {}, now = Date.now, trustedProxies = ['172.30.0.2'], maxConcurrentAuth = 4 }) {
  const { Aedes } = await import('aedes');
  const broker = await Aedes.createBroker({ id: 'plc-broker' });
  const fails = new Map();     // ip → { times: [], blockedUntil }
  const stationFails = new Map();   // stationId → số lần sai (chỉ để ghi log/cảnh báo, KHÔNG chặn khoá đúng)
  let authInFlight = 0;

  const blocked = ip => { const f = fails.get(ip); return f && f.blockedUntil > now(); };
  const fail = ip => {
    const f = fails.get(ip) || { times: [], blockedUntil: 0 };
    f.times = f.times.filter(t => now() - t < FAIL_WINDOW); f.times.push(now());
    if (f.times.length >= FAIL_LIMIT) f.blockedUntil = now() + BLOCK_MS;
    fails.set(ip, f);
  };
  const parts = topic => { const m = /^lvc\/([A-Z0-9-]{1,32})\/([a-z]+)$/.exec(topic); return m ? { station: m[1], kind: m[2] } : null; };

  broker.authenticate = (client, username, password, cb) => {
    const ip = clientIp(client.req, trustedProxies);
    let done = false;
    const finish = (err, ok) => { if (done) return; done = true; cb(err, ok); };
    const deny = () => {
      fail(ip);
      if (typeof username === 'string' && STATION_RE.test(username)) {
        const n = (stationFails.get(username) || 0) + 1; stationFails.set(username, n);
        if (n % 10 === 0) log('auth: nhiều lần sai khoá cho tủ', username, 'từ', ip);
      }
      const e = new Error('Auth error'); e.returnCode = 4; finish(e, false);
    };
    if (blocked(ip)) { const e = new Error('Blocked'); e.returnCode = 5; return finish(e, false); }
    if (typeof username !== 'string' || !STATION_RE.test(username) || client.id !== `gw-${username}` || !password) return deny();
    if (authInFlight >= maxConcurrentAuth) { const e = new Error('Busy'); e.returnCode = 3; return finish(e, false); }
    authInFlight++;
    Promise.resolve(getStation(username))
      .then(async st => {
        if (!st || !st.key_hash || !(await verifyKeyAsync(password.toString(), st.key_hash))) return deny();
        client.stationId = username; client.keyVer = st.key_ver;
        finish(null, true);
      })
      .catch(() => deny())
      .finally(() => { authInFlight--; });
  };
  broker.authorizePublish = (client, packet, cb) => {
    if (!client) return cb(null);                                    // server tự publish
    const p = parts(packet.topic);
    if (!p || p.station !== client.stationId || !PUB_OK.includes(p.kind) || packet.payload.length > MAX_PAYLOAD) return cb(new Error('denied'));
    cb(null);
  };
  broker.authorizeSubscribe = (client, sub, cb) => {
    const p = parts(sub.topic);
    if (!p || p.station !== client.stationId || !SUB_OK.includes(p.kind)) return cb(new Error('denied'));
    cb(null, sub);
  };
  broker.on('publish', (packet, client) => {
    if (!client || !client.stationId) return;
    const p = parts(packet.topic); if (!p) return;
    let msg = null;
    if (p.kind !== 'online') { try { msg = JSON.parse(packet.payload.toString('utf8')); } catch { return; } }
    if (p.kind === 'state') onState(p.station, msg);
    else if (p.kind === 'ack') onAck(p.station, msg);
    else if (p.kind === 'hist') onHist(p.station, msg);
    else if (p.kind === 'online') onOnline(p.station, packet.payload.toString() === '1');
  });
  broker.on('clientDisconnect', c => { if (c.stationId) onOnline(c.stationId, false); });

  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  wss.on('connection', (ws, req) => {
    const stream = createWebSocketStream(ws);
    stream.on('error', () => {});
    broker.handle(stream, req);
  });

  return {
    broker,
    handleUpgrade(req, socket, head) { wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req)); },
    publish(topic, obj, { retain = false } = {}) {
      return new Promise(r => broker.publish({ topic, payload: Buffer.from(JSON.stringify(obj)), qos: 1, retain, cmd: 'publish', dup: false }, r));
    },
    /** Thu hồi khoá: ngắt ngay phiên đang mở của tủ. */
    revoke(stationId) {
      const c = broker.clients[`gw-${stationId}`];
      if (c) c.close();
    },
    isConnected(stationId) { return !!broker.clients[`gw-${stationId}`]; },
    close() { return new Promise(r => { wss.close(); broker.close(r); }); },
  };
}

module.exports = { createBroker, STATION_RE, clientIp };
