'use strict';
/**
 * HTTP + WebSocket của dịch vụ plc (Fastify 5). Caddy định tuyến /plc/* và /mqtt về đây.
 *  - REST /plc/*: JWT của core LAVIPCO Server (Authorization: Bearer), vai trò lấy từ claims.apps.plc.
 *  - WS /plc/ws: app gửi {type:'auth', token} trong 5 s đầu, rồi {type:'subscribe', stationId}.
 *  - WS /mqtt: gateway (MQTT qua WebSocket).
 */
const Fastify = require('fastify');
const { WebSocketServer } = require('ws');
const crypto = require('node:crypto');
const { verifyJwt, newGatewayKey, hashKey } = require('./keys');
const { HttpError } = require('./service');

function buildApp({ service, broker, db, jwtSecret, allowedOrigins = ['https://neo-era.github.io'], zaloWebhookSecret = null, log = () => {} }) {
  const app = Fastify({ logger: false, bodyLimit: 32 * 1024, trustProxy: true });

  async function userFrom(token) {
    const c = verifyJwt(token, jwtSecret);
    if (!c) return null;
    const role = c.apps && c.apps.plc;
    if (!['viewer', 'editor', 'admin'].includes(role)) return null;
    // thu hồi tức thì: tài khoản bị khoá / đổi mật khẩu (token_version) → từ chối
    const u = (await db.query('select is_active, token_version from core.users where id::text = $1', [c.sub])).rows[0];
    if (!u || !u.is_active || Number(u.token_version) !== Number(c.ver)) return null;
    return { id: c.sub, role, email: c.email };
  }

  app.addHook('onRequest', async (req, reply) => {
    const origin = req.headers.origin;
    if (origin && allowedOrigins.includes(origin)) {
      reply.header('Access-Control-Allow-Origin', origin).header('Vary', 'Origin')
        .header('Access-Control-Allow-Headers', 'Authorization, Content-Type').header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE');
    }
    if (req.method === 'OPTIONS') return reply.code(204).send();
    if (req.url.startsWith('/plc/zalo/webhook') || req.url === '/plc/health') return;
    const h = req.headers.authorization || '';
    req.user = h.startsWith('Bearer ') ? await userFrom(h.slice(7)) : null;
    if (!req.user) return reply.code(401).send({ error: 'UNAUTHORIZED' });
  });
  app.setErrorHandler((e, req, reply) => {
    if (e instanceof HttpError) return reply.code(e.status).send({ error: e.code, ...(e.extra ? { detail: e.extra } : {}) });
    if (e.validation || e.statusCode === 400) return reply.code(400).send({ error: 'BAD_REQUEST' });
    log('error', e); reply.code(500).send({ error: 'INTERNAL' });
  });
  const admin = req => { if (req.user.role !== 'admin') throw new HttpError(403, 'FORBIDDEN'); };
  const sid = req => { const id = req.params.id; if (!/^[A-Z0-9-]{1,32}$/.test(id)) throw new HttpError(400, 'BAD_STATION'); return id; };

  app.get('/plc/health', async () => ({ status: 'ok' }));
  app.get('/plc/stations', async req => service.listStations(req.user));
  app.get('/plc/stations/:id', async req => {
    const st = await service.requireAccess(req.user, sid(req), 'viewer');
    return { id: st.id, name: st.name, online: st.online, state: st.last_state, stateAt: st.last_state_at, schedule: st.schedule };
  });
  app.post('/plc/stations/:id/commands', async (req, reply) => reply.code(202).send(await service.issueCommand(req.user, sid(req), req.body)));
  app.put('/plc/stations/:id/schedule', async req => service.setSchedule(req.user, sid(req), req.body));
  app.get('/plc/stations/:id/commands', async req => service.commandLog(req.user, sid(req), Number(req.query.limit) || 50));
  app.get('/plc/stations/:id/alerts', async req => {
    await service.requireAccess(req.user, sid(req), 'viewer');
    return (await db.query('select code, type, message, at, delivery from plc.alerts where station_id = $1 order by id desc limit 100', [req.params.id])).rows;
  });

  // ── quản trị ──
  app.post('/plc/stations', async (req, reply) => {
    admin(req);
    const { id, name } = req.body || {};
    if (!/^[A-Z0-9-]{1,32}$/.test(id || '') || typeof name !== 'string' || !name.trim()) throw new HttpError(400, 'BAD_STATION');
    const key = newGatewayKey();
    await db.query('insert into plc.stations(id, name, key_hash, key_ver) values ($1,$2,$3,1)', [id, name.trim().slice(0, 100), hashKey(key)]);
    return reply.code(201).send({ id, gatewayKey: key, note: 'Khoá chỉ hiện MỘT lần — chép vào /etc/plc-gateway.env của gateway' });
  });
  app.post('/plc/stations/:id/rotate-key', async req => {
    admin(req);
    const id = sid(req), key = newGatewayKey();
    const r = await db.query('update plc.stations set key_hash = $2, key_ver = key_ver + 1 where id = $1', [id, hashKey(key)]);
    if (!r.rowCount) throw new HttpError(404, 'NOT_FOUND');
    broker.revoke(id);
    return { id, gatewayKey: key };
  });
  app.put('/plc/stations/:id/users/:userId', async req => {
    admin(req);
    await db.query('insert into plc.station_users(station_id, user_id) values ($1,$2) on conflict do nothing', [sid(req), String(req.params.userId)]);
    return { ok: true };
  });
  app.delete('/plc/stations/:id/users/:userId', async req => {
    admin(req);
    await db.query('delete from plc.station_users where station_id = $1 and user_id = $2', [sid(req), String(req.params.userId)]);
    return { ok: true };
  });
  app.post('/plc/signup-codes', async req => {
    admin(req);
    const stationId = req.body?.stationId || null;
    if (stationId !== null && !/^[A-Z0-9-]{1,32}$/.test(stationId)) throw new HttpError(400, 'BAD_STATION');
    const code = crypto.randomBytes(4).toString('hex').toUpperCase();
    await db.query('insert into plc.signup_codes(code, station_id, created_by, expires_at) values ($1,$2,$3,$4)',
      [code, stationId, req.user.id, new Date(Date.now() + 24 * 3600e3)]);
    return { code, howTo: `Nhắn cho bot Zalo: /dangky ${code} (hiệu lực 24 giờ)` };
  });
  app.get('/plc/alert-recipients', async req => { admin(req); return (await db.query('select * from plc.alert_recipients order by id')).rows; });
  app.delete('/plc/alert-recipients/:rid', async req => {
    admin(req); await db.query('update plc.alert_recipients set active = false where id = $1', [Number(req.params.rid) || 0]); return { ok: true };
  });

  // ── webhook Zalo: đăng ký nhận cảnh báo bằng /dangky <mã> ──
  app.post('/plc/zalo/webhook', async (req, reply) => {
    const secret = req.headers['x-bot-api-secret-token'];
    if (!zaloWebhookSecret || typeof secret !== 'string' || secret.length !== zaloWebhookSecret.length
      || !crypto.timingSafeEqual(Buffer.from(secret), Buffer.from(zaloWebhookSecret))) return reply.code(401).send({ error: 'UNAUTHORIZED' });
    const msg = req.body?.result?.message || req.body?.message;
    const text = (msg?.text || '').trim(), chat = msg?.chat;
    const m = /^\/dangky\s+([A-F0-9]{8})$/i.exec(text);
    if (!m || !chat?.id) return { ok: true };
    const c = (await db.query('update plc.signup_codes set used_at = now() where code = $1 and used_at is null and expires_at > now() returning *', [m[1].toUpperCase()])).rows[0];
    if (!c) return { ok: true };
    await db.query(`insert into plc.alert_recipients(station_id, kind, chat_id, chat_type, name) values ($1,'zalo',$2,$3,$4)
                    on conflict (kind, chat_id, station_id) do update set active = true`,
      [c.station_id, String(chat.id), chat.chat_type === 'GROUP' ? 'GROUP' : 'PRIVATE', msg.from?.display_name || null]);
    return { ok: true };
  });

  // ── WebSocket ──
  const appWs = new WebSocketServer({ noServer: true, maxPayload: 4096 });
  appWs.on('connection', ws => {
    let user = null; const subs = new Set();
    const t = setTimeout(() => { if (!user) ws.close(4401, 'auth timeout'); }, 5000);
    const send = ev => { if (ws.readyState === 1 && subs.has(ev.stationId)) ws.send(JSON.stringify(ev)); };
    service.listeners.add(send);
    ws.on('close', () => { clearTimeout(t); service.listeners.delete(send); });
    ws.on('error', () => {});
    ws.on('message', async raw => {
      let m; try { m = JSON.parse(raw.toString()); } catch { return; }
      if (m.type === 'auth' && !user) {
        user = await userFrom(m.token);
        if (!user) return ws.close(4401, 'unauthorized');
        clearTimeout(t); ws.send(JSON.stringify({ type: 'ready' }));
      } else if (m.type === 'subscribe' && user && typeof m.stationId === 'string') {
        if (await service.canAccess(user, m.stationId)) { subs.add(m.stationId); ws.send(JSON.stringify({ type: 'subscribed', stationId: m.stationId })); }
      }
    });
  });

  app.server.on('upgrade', (req, socket, head) => {
    const url = (req.url || '').split('?')[0];
    if (url === '/mqtt') return broker.handleUpgrade(req, socket, head);
    if (url === '/plc/ws') {
      if (!allowedOrigins.includes(req.headers.origin)) { socket.destroy(); return; }
      return appWs.handleUpgrade(req, socket, head, ws => appWs.emit('connection', ws, req));
    }
    socket.destroy();
  });
  app.addHook('onClose', async () => { appWs.close(); });
  return app;
}

module.exports = { buildApp };
