'use strict';
/**
 * Kiểm thử đầu-cuối: App (HTTP/JWT) → dịch vụ plc (Postgres thật + broker MQTT/WS) → gateway (mqtt.js thật)
 * → Modbus TCP → bộ mô phỏng LOGO! V4. Đồng hồ ảo dùng chung.
 * Cần Postgres: TEST_DATABASE_URL (vd postgres://postgres@127.0.0.1:55432/postgres).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');
const mqttLib = require('mqtt');
const { createBroker } = require('../src/broker');
const { createService } = require('../src/service');
const { buildApp } = require('../src/app');
const { signJwt } = require('../src/keys');
const { LogoV4 } = require('../../sim/logo-v4');
const { createServer: createModbus } = require('../../sim/modbus-server');
const { ModbusClient } = require('../../gateway/modbus-client');
const { createMqttAdapter } = require('../../gateway/mqtt-adapter');
const { Gateway } = require('../../gateway/agent');

const DB = process.env.TEST_DATABASE_URL;
const SECRET = 'x'.repeat(48);
const vn = (h, m = 0) => Date.UTC(2026, 10, 15, h - 7, m);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const SCHED = { K1: { on: '17:45', off: '05:45' }, K2: { on: '17:46', off: '05:45' }, K3: { on: '22:00', off: '04:00' } };

async function resetDb(pool) {
  await pool.query('drop schema if exists plc cascade; drop schema if exists core cascade; create schema core;');
  await pool.query('create table core.users(id text primary key, is_active boolean, token_version int)');
  await pool.query(fs.readFileSync(path.join(__dirname, '../db/001_plc.sql'), 'utf8'));
  await pool.query(`insert into core.users values ('admin', true, 1), ('lam', true, 1), ('xem', true, 1), ('khoa', false, 1)`);
}
const token = (sub, role, ver = 1) => signJwt({ sub, aud: 'lavipco', exp: Math.floor(Date.now() / 1000) + 3600, ver, apps: { plc: role } }, SECRET);

async function stack() {
  const pool = new Pool({ connectionString: DB, max: 5 });
  await resetDb(pool);
  const plc = new LogoV4({ clock: vn(20) }); plc.run(1000);
  const clock = () => plc.clock;
  const zaloSent = [];
  const zalo = { sendMessage: async (chat, text) => { zaloSent.push({ chat, text }); return { ok: true }; } };
  let brokerRef;
  const service = createService({ db: pool, publish: (t, o, opt) => brokerRef.publish(t, o, opt), zalo, now: clock });
  brokerRef = await createBroker({ trustedProxies: ['127.0.0.1'], getStation: id => service.getStation(id), onState: (i, s) => service.onState(i, s),
    onAck: (i, a) => service.onAck(i, a), onOnline: (i, o) => service.onOnline(i, o) });
  const app = buildApp({ service, broker: brokerRef, db: pool, jwtSecret: SECRET, zaloWebhookSecret: 's'.repeat(32), trustedProxies: ['127.0.0.1'] });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const api = async (method, url, tok, body) => {
    const headers = { Authorization: `Bearer ${tok}`, Origin: 'https://neo-era.github.io', ...(body ? { 'Content-Type': 'application/json' } : {}) };
    const r = await fetch(base + url, { method, headers,
      body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const created = await api('POST', '/plc/stations', token('admin', 'admin'), { id: 'LVC02', name: 'Tủ LVC02' });
  await api('POST', '/plc/stations', token('admin', 'admin'), { id: 'LVC03', name: 'Tủ khác' });
  await api('PUT', '/plc/stations/LVC02/users/lam', token('admin', 'admin'));
  await api('PUT', '/plc/stations/LVC02/users/xem', token('admin', 'admin'));
  await pool.query(`insert into plc.alert_recipients(station_id, kind, chat_id, chat_type) values (null, 'zalo', 'nhom-truc', 'GROUP')`);

  const mb = createModbus(plc); await new Promise(r => mb.listen(0, '127.0.0.1', r));
  const modbus = new ModbusClient({ host: '127.0.0.1', port: mb.address().port, timeoutMs: 500 });
  let saved = null; const store = { load: () => saved, save: o => { saved = JSON.parse(JSON.stringify(o)); } };
  // giả lập Caddy: gateway thật đến từ IP 10.0.0.2
  const viaCaddy = ip => (u, o) => mqttLib.connect(u, { ...o, wsOptions: { headers: { 'X-Forwarded-For': ip } } });
  const mqtt = createMqttAdapter({ url: `ws://127.0.0.1:${app.server.address().port}/mqtt`, stationId: 'LVC02', key: created.body.gatewayKey, connectFn: viaCaddy('10.0.0.2') });
  const gw = new Gateway({ stationId: 'LVC02', clock, modbus, mqtt, store, ntpSynced: () => true });
  const advance = async ms => { const end = plc.clock + ms; while (plc.clock < end) { plc.run(1000); await gw.tick(); await sleep(2); } };
  const until = async (fn, ms = 60e3) => { const end = plc.clock + ms; while (plc.clock < end) { if (await fn()) return true; await advance(1000); } return false; };
  const stop = async () => { mqtt.client.end(true); modbus.close(); mb.close(); await app.close(); await brokerRef.close(); await pool.end(); };
  return { viaCaddy, pool, plc, service, broker: brokerRef, app, api, base, gw, mqtt, advance, until, stop, zaloSent, key: created.body.gatewayKey, created };
}

test('đầu-cuối', { skip: !DB && 'cần TEST_DATABASE_URL' }, async t => {
  const s = await stack();
  try {
    await t.test('tạo tủ trả khoá 1 lần; gateway kết nối, tủ online, lịch đến được gateway', async () => {
      assert.equal(s.created.status, 201); assert.ok(s.key.length >= 32);
      for (let i = 0; i < 100 && !s.mqtt.connected; i++) await sleep(100);   // thời gian thật (scrypt bất đồng bộ)
      assert.ok(s.mqtt.connected, 'mqtt chưa kết nối');
      const r = await s.api('PUT', '/plc/stations/LVC02/schedule', token('lam', 'editor'), { schedule: SCHED });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.ok(await s.until(() => s.gw.schedule !== null, 10e3));
      assert.ok(await s.until(async () => (await s.service.getStation('LVC02')).last_state?.remoteOk === true, 120e3));   // PLC đã nhận quyền từ xa (M20)
      const st = await s.service.getStation('LVC02'); assert.equal(st.online, true);
    });

    await t.test('ra lệnh tắt K1 → issued, received, applied, confirmed; PLC tắt K1; báo nhóm vì tắt đêm', async () => {
      const r = await s.api('POST', '/plc/stations/LVC02/commands', token('lam', 'editor'), { circuit: 'K1', mode: 'off', minutes: 10 });
      assert.equal(r.status, 202, JSON.stringify(r.body));
      const id = r.body.cmdId;
      const ok = await s.until(async () => (await s.pool.query(`select 1 from plc.command_events where cmd_id = $1 and status = 'confirmed'`, [id])).rowCount > 0, 30e3);
      if (!ok) console.log('DEBUG', (await s.pool.query('select status, reason from plc.command_events where cmd_id = $1 order by id', [id])).rows, s.gw.out, s.mqtt.connected, s.gw.lastSeq);
      assert.ok(ok);
      const ev = (await s.pool.query('select status from plc.command_events where cmd_id = $1 order by id', [id])).rows.map(x => x.status);
      assert.deepEqual(ev, ['issued', 'received', 'applied', 'confirmed']);
      assert.equal(s.plc.Q[2], false);
      assert.ok(s.zaloSent.some(z => z.chat === 'nhom-truc'), 'báo nhóm khi tắt đêm');
      const back = await s.api('POST', '/plc/stations/LVC02/commands', token('lam', 'editor'), { circuit: 'K1', mode: 'auto' });
      assert.equal(back.status, 202);
      assert.ok(await s.until(() => s.plc.Q[2] === true, 30e3));
    });

    await t.test('phân quyền: viewer không ra lệnh; không có quyền tủ khác; tài khoản bị khoá / token cũ bị từ chối', async () => {
      assert.equal((await s.api('POST', '/plc/stations/LVC02/commands', token('xem', 'viewer'), { circuit: 'K1', mode: 'auto' })).status, 403);
      assert.equal((await s.api('GET', '/plc/stations/LVC03', token('lam', 'editor'))).status, 403);
      assert.equal((await s.api('GET', '/plc/stations', token('khoa', 'editor'))).status, 401);
      assert.equal((await s.api('GET', '/plc/stations', token('lam', 'editor', 0))).status, 401);
      assert.equal((await s.api('GET', '/plc/stations', 'abc.def.ghi')).status, 401);
      const list = await s.api('GET', '/plc/stations', token('lam', 'editor'));
      assert.deepEqual(list.body.map(x => x.id), ['LVC02']);
    });

    await t.test('kiểm tra phía server: tắt đêm > 2 h, sửa lịch cần xác nhận, K2 khi K1 tắt', async () => {
      const tok = token('lam', 'editor');
      assert.equal((await s.api('POST', '/plc/stations/LVC02/commands', tok, { circuit: 'K1', mode: 'off', minutes: 180 })).body.error, 'OVERRIDE_NIGHT_OFF_TOO_LONG');
      const bad = { ...SCHED, K1: { on: '19:00', off: '05:45' }, K2: { on: '19:01', off: '05:45' } };
      const r = await s.api('PUT', '/plc/stations/LVC02/schedule', tok, { schedule: bad });
      assert.equal(r.status, 409); assert.equal(r.body.error, 'NEEDS_CONFIRM');
      assert.equal((await s.api('PUT', '/plc/stations/LVC02/schedule', tok, { schedule: { K1: { on: '25:00' } } })).status, 422);
    });

    await t.test('nhật ký lệnh chỉ ghi thêm: không sửa/xoá được', async () => {
      await assert.rejects(s.pool.query(`update plc.command_events set status = 'confirmed'`), /append-only/);
      await assert.rejects(s.pool.query('delete from plc.commands'), /append-only/);
      await assert.rejects(s.pool.query('truncate plc.alerts'), /append-only/);
    });

    await t.test('broker: khoá sai bị từ chối; tủ không publish được topic tủ khác', async () => {
      const bad = mqttLib.connect(`ws://127.0.0.1:${s.app.server.address().port}/mqtt`, { clientId: 'gw-LVC02', username: 'LVC02', password: 'sai', reconnectPeriod: 0 });
      const err = await new Promise(r => { bad.on('error', e => r(e)); bad.on('connect', () => r(null)); });
      assert.ok(err, 'khoá sai phải bị từ chối'); bad.end(true);
      let got = false; s.service.listeners.add(ev => { if (ev.stationId === 'LVC03') got = true; });
      s.mqtt.client.publish('lvc/LVC03/state', JSON.stringify({ stationId: 'LVC03' }));
      await sleep(200); assert.equal(got, false);
      // broker ngắt phiên vi phạm ACL; gateway tự kết nối lại (mqtt.js, 5 s thời gian thật)
      for (let i = 0; i < 100 && !s.mqtt.connected; i++) await sleep(100);
      assert.equal(s.mqtt.connected, true, 'gateway phải tự kết nối lại');
    });

    await t.test('khoá ELR → cảnh báo Zalo; lệnh bật bị từ chối', async () => {
      for (let i = 0; i < 3; i++) { s.plc.setI(1, true); await s.advance(1000); s.plc.setI(1, false); await s.advance(20e3); }
      const ok = await s.until(() => s.zaloSent.some(z => /KHOÁ ELR/.test(z.text)), 20e3);
      if (!ok) console.log('DEBUG', s.zaloSent.map(z => z.text.split('\n')[1]), (await s.service.getStation('LVC02')).last_state.elrLock, s.plc.M[16]);
      assert.ok(ok);
      const r = await s.api('POST', '/plc/stations/LVC02/commands', token('lam', 'editor'), { circuit: 'K1', mode: 'on', minutes: 10 });
      assert.equal(r.body.error, 'ELR_LOCK');
    });

    await t.test('B1: gói WS hỏng từ người chưa đăng nhập không làm sập dịch vụ', async () => {
      const WS = require('ws');
      for (const payload of ['null', 'true', '[]', '"x"', '{"type":"auth","token":5}', '{"type":"subscribe","stationId":{"a":1}}']) {
        const ws = new WS(s.base.replace('http', 'ws') + '/plc/ws', { headers: { Origin: 'https://neo-era.github.io' } });
        await new Promise(r => ws.on('open', r)); ws.send(payload); await sleep(50); ws.close();
      }
      await sleep(100);
      assert.equal((await fetch(s.base + '/plc/health')).status, 200);
    });

    await t.test('B2: 6 lần sai khoá từ IP lạ không chặn gateway thật ở IP khác', async () => {
      for (let i = 0; i < 6; i++) {
        const bad = s.viaCaddy('10.0.0.66')(`ws://127.0.0.1:${s.app.server.address().port}/mqtt`, { clientId: 'gw-LVC02', username: 'LVC02', password: 'sai' + i, reconnectPeriod: 0 });
        await new Promise(r => { bad.on('error', r); bad.on('close', r); }); bad.end(true);
      }
      s.mqtt.client.end(true);
      const m2 = require('../../gateway/mqtt-adapter').createMqttAdapter({ url: `ws://127.0.0.1:${s.app.server.address().port}/mqtt`, stationId: 'LVC02', key: s.key, connectFn: s.viaCaddy('10.0.0.2') });
      for (let i = 0; i < 50 && !m2.connected; i++) await sleep(100);
      assert.equal(m2.connected, true, 'gateway thật phải vào được');
      const blocked = s.viaCaddy('10.0.0.66')(`ws://127.0.0.1:${s.app.server.address().port}/mqtt`, { clientId: 'gw-LVC02', username: 'LVC02', password: s.key, reconnectPeriod: 0 });
      const res = await new Promise(r => { blocked.on('connect', () => r('connected')); blocked.on('error', () => r('blocked')); blocked.on('close', () => r('blocked')); });
      assert.equal(res, 'blocked', 'IP dò khoá bị chặn 15 phút'); blocked.end(true);
      m2.client.end(true);
    });

    await t.test('đổi khoá: phiên gateway đang mở bị ngắt ngay', async () => {
      const r = await s.api('POST', '/plc/stations/LVC02/rotate-key', token('admin', 'admin'));
      assert.equal(r.status, 200);
      await sleep(300);
      assert.equal(s.broker.isConnected('LVC02'), false);
    });

    await t.test('lệnh không tới được tủ → expired NOT_DELIVERED sau hạn', async () => {
      await s.pool.query(`update plc.stations set last_state = jsonb_set(jsonb_set(last_state, '{elrLock}', 'false'), '{maint}', 'false') where id = 'LVC02'`);
      const r = await s.api('POST', '/plc/stations/LVC02/commands', token('lam', 'editor'), { circuit: 'K3', mode: 'auto' });
      assert.equal(r.status, 202, JSON.stringify(r.body));
      s.plc.run(45e3); await s.service.sweep();
      const ev = (await s.pool.query('select status, reason from plc.command_events where cmd_id = $1 order by id', [r.body.cmdId])).rows;
      assert.deepEqual(ev.map(e => e.status), ['issued', 'expired']); assert.equal(ev[1].reason, 'NOT_DELIVERED');
    });
  } finally { await s.stop(); }
});
