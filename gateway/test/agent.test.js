'use strict';
/* Test tích hợp: gateway ↔ (Modbus TCP thật) ↔ bộ mô phỏng LOGO! V4, đồng hồ ảo dùng chung. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { LogoV4 } = require('../../sim/logo-v4');
const { createServer } = require('../../sim/modbus-server');
const { ModbusClient } = require('../modbus-client');
const { Gateway } = require('../agent');

const vn = (h, m = 0, d = 15) => Date.UTC(2026, 10, d, h - 7, m);
const SUN = { sunrise: 349, sunset: 1047 };
const SCHED = { K1: { on: '17:45', off: '05:45' }, K2: { on: '17:46', off: '05:45' }, K3: { on: '22:00', off: '04:00' } };

function memStore(init = null) { let v = init; return { load: () => v && JSON.parse(v), save: o => { v = JSON.stringify(o); }, raw: () => v }; }
function fakeMqtt() {
  const m = { states: [], acks: [], onCommand(f) { m.cmd = f; }, onConfig(f) { m.cfg = f; },
    publishState(s) { m.states.push(s); }, publishAck(a) { m.acks.push(a); } };
  return m;
}

async function rig({ h = 20, m = 0, store = memStore(), ntp = true } = {}) {
  const plc = new LogoV4({ clock: vn(h, m) }); plc.run(1000);
  const srv = createServer(plc); await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const modbus = new ModbusClient({ host: '127.0.0.1', port: srv.address().port, timeoutMs: 500 });
  const mqtt = fakeMqtt();
  const gw = new Gateway({ stationId: 'LVC02', clock: () => plc.clock, modbus, mqtt, store, sun: SUN, ntpSynced: () => ntp });
  mqtt.cfg({ schedule: SCHED });
  const advance = async ms => { const end = plc.clock + ms; while (plc.clock < end) { plc.run(1000); await gw.tick(); } };
  const stop = () => { modbus.close(); srv.close(); };
  return { plc, srv, modbus, mqtt, gw, advance, stop, store };
}
const cmd = (r, o = {}) => ({ cmdId: 'c' + Math.random().toString(36).slice(2), seq: (r.gw.lastSeq || 0) + 1, stationId: 'LVC02', kind: 'override',
  circuit: 'K1', mode: 'off', until: r.plc.clock + 30 * 60e3, issuedAt: r.plc.clock, expiresAt: r.plc.clock + 30e3, by: 'lam', ...o });

test('khởi động: liên kết ổn định 60 s rồi mới REMOTE_EN; PLC nhận REMOTE_OK; đèn giữ sáng suốt quá trình', async () => {
  const r = await rig();
  try {
    let everDark = false;
    for (let i = 0; i < 120; i++) { await r.advance(1000); if (!r.plc.Q[2]) everDark = true; if (i === 30) assert.equal(r.gw.out.remoteEn, false); }
    assert.equal(everDark, false);
    assert.equal(r.gw.out.remoteEn, true); assert.equal(r.plc.M[20], true);
    assert.ok(r.mqtt.states.at(-1).online);
  } finally { r.stop(); }
});

test('lệnh tắt K1 lúc 20:00: received → applied → confirmed, báo nhóm (tắt đêm); hết hạn tự về lịch', async () => {
  const r = await rig(); await r.advance(90e3);
  try {
    const c = cmd(r, { until: r.plc.clock + 5 * 60e3 });
    r.mqtt.cmd(c); await r.advance(15e3);
    const st = r.mqtt.acks.filter(a => a.cmdId === c.cmdId).map(a => a.status);
    assert.deepEqual(st, ['received', 'applied', 'confirmed']);
    assert.equal(r.mqtt.acks.find(a => a.cmdId === c.cmdId).notifyGroup, true);
    assert.equal(r.plc.Q[2], false); assert.equal(r.plc.Q[3], false);
    await r.advance(6 * 60e3); assert.equal(r.plc.Q[2], true, 'hết hạn → về lịch');
  } finally { r.stop(); }
});

test('chống phát lại sau khởi động lại gateway (lastSeq lưu bền); lệnh hết hạn bị bỏ', async () => {
  const store = memStore();
  const r = await rig({ store }); await r.advance(90e3);
  const c = cmd(r); r.mqtt.cmd(c); await r.advance(5e3); r.stop();
  const r2 = await rig({ store });
  try {
    await r2.advance(5e3);
    r2.mqtt.cmd({ ...c, cmdId: 'other' });
    assert.equal(r2.mqtt.acks.at(-1).reason, 'REPLAY');
    r2.mqtt.cmd(cmd(r2, { seq: c.seq + 1, issuedAt: r2.plc.clock - 60e3, expiresAt: r2.plc.clock - 31e3 }));
    assert.equal(r2.mqtt.acks.at(-1).status, 'expired');
  } finally { r2.stop(); }
});

test('khoá LOCAL tại tủ: xoá cưỡng bức, PLC về lịch tại tủ, lệnh mới bị từ chối MAINT', async () => {
  const r = await rig(); await r.advance(90e3);
  try {
    r.mqtt.cmd(cmd(r)); await r.advance(15e3); assert.equal(r.plc.Q[2], false);
    r.plc.setI(3, true); await r.advance(15e3);
    assert.deepEqual(r.gw.overrides, {}); assert.equal(r.plc.M[20], false); assert.equal(r.plc.Q[2], true);
    r.mqtt.cmd(cmd(r)); assert.equal(r.mqtt.acks.at(-1).reason, 'MAINT');
    r.plc.setI(3, false); await r.advance(90e3); assert.equal(r.plc.Q[2], true, 'lệnh cũ không tái áp dụng');
  } finally { r.stop(); }
});

test('gateway chết: PLC tự về lịch tại tủ sau ≤ 180 s', async () => {
  const r = await rig(); await r.advance(90e3);
  r.mqtt.cmd(cmd(r, { until: r.plc.clock + 60 * 60e3, mode: 'off' })); await r.advance(15e3);
  assert.equal(r.plc.Q[2], false);
  r.stop();                                      // gateway mất — chỉ còn PLC chạy
  r.plc.run(170e3); assert.equal(r.plc.Q[2], false);
  r.plc.run(15e3); assert.equal(r.plc.Q[2], true);
});

test('đồng hồ PLC mất giờ (2020) → gateway ghi lại giờ bằng FC15; PLC chưa đúng giờ thì không bật từ xa', async () => {
  const r = await rig();
  try {
    r.plc.setRtc({ year: 2020, month: 1, day: 1, hour: 0, minute: 0 });
    await r.advance(70e3);
    assert.ok(Math.abs(r.gw.plc.skewSec) < 90, 'skew=' + r.gw.plc.skewSec);
    assert.equal(r.plc.rtc().year, 2026);
  } finally { r.stop(); }
});

test('mất Modbus giữa chừng: snapshot offline, kết nối lại phải ổn định 60 s mới bật từ xa', async () => {
  const r = await rig(); await r.advance(90e3);
  try {
    const real = r.modbus.request.bind(r.modbus);
    r.modbus.request = () => Promise.reject(new Error('TIMEOUT'));          // mất liên lạc PLC 20 s
    await r.advance(20e3);
    assert.equal(r.mqtt.states.at(-1).online, false); assert.equal(r.gw.out.remoteEn, false);
    r.modbus.request = real;
    await r.advance(30e3); assert.equal(r.gw.out.remoteEn, false, 'chưa ổn định 60 s');
    await r.advance(45e3); assert.equal(r.gw.out.remoteEn, true);
  } finally { r.stop(); }
});

test('lệnh tắt ban đêm cộng dồn > 2 giờ bị chặn', async () => {
  const r = await rig(); await r.advance(90e3);
  try {
    r.mqtt.cmd(cmd(r, { until: r.plc.clock + 120 * 60e3 })); await r.advance(121 * 60e3);
    r.mqtt.cmd(cmd(r, { until: r.plc.clock + 30 * 60e3 }));
    assert.equal(r.mqtt.acks.at(-1).reason, 'OVERRIDE_NIGHT_OFF_TOTAL_TOO_LONG');
  } finally { r.stop(); }
});
