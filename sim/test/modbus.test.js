'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { LogoV4 } = require('../logo-v4');
const { createServer } = require('../modbus-server');
const { ModbusClient } = require('../../gateway/modbus-client');
const { POINTS, map } = require('../../core/modbus-map');

const vn = (h, m = 0) => Date.UTC(2026, 10, 15, h - 7, m);

async function setup(opts) {
  const plc = new LogoV4({ clock: vn(20) }); plc.run(2000);
  const srv = createServer(plc, opts); await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const c = new ModbusClient({ host: '127.0.0.1', port: srv.address().port, timeoutMs: 500 });
  return { plc, srv, c };
}

test('đọc Q/M/I, ghi V-bit bằng coil, đọc giờ HR 492', async () => {
  const { plc, srv, c } = await setup();
  try {
    await c.connect();
    const [q2] = await c.readCoils(POINTS.Q2.address, 1); assert.equal(q2, true);
    const [m32] = await c.readCoils(POINTS.M32.address, 1); assert.equal(m32, true);
    await c.writeCoil(POINTS.REMOTE_EN.address, true); assert.equal(plc.getV(100, 1), true);
    assert.equal(POINTS.HB.address, 800);
    const hr = await c.readHolding(map.RTC_HR, 4);
    assert.equal(hr[0] & 0xFF, 26); assert.equal(hr[2] >> 8, 20);
    plc.setI(2, true); const di = await c.readDiscrete(POINTS.I2.address, 1); assert.equal(di[0], true);
  } finally { c.close(); srv.close(); }
});

test('đặt giờ bằng FC15 coil 7880 (40 bit); FC16 vào HR 492 → PLC ngắt kết nối như máy thật', async () => {
  const { plc, srv, c } = await setup();
  try {
    await c.connect();
    const bytes = [26, 11, 16, 6, 30], bits = [];
    for (const b of bytes) for (let i = 0; i < 8; i++) bits.push(!!((b >> i) & 1));
    await c.writeCoils(map.RTC_WRITE_COIL, bits);
    const r = plc.rtc(); assert.deepEqual([r.year, r.month, r.day, r.hour, r.minute], [2026, 11, 16, 6, 30]);
    const f16 = Buffer.from([16, 0x01, 0xEC, 0, 1, 2, 0, 26]);
    await assert.rejects(c.request(f16));
    assert.equal(c.connected, false);
  } finally { c.close(); srv.close(); }
});

test('không ghi được Q/M từ ngoài; Modbus chỉ nhận IP gateway', async () => {
  const { srv, c } = await setup({ allowIp: '192.168.0.10' });
  try {
    await c.connect().catch(() => {});
    await assert.rejects(c.readCoils(0, 1));
  } finally { c.close(); srv.close(); }
  const s2 = await setup();
  try { await s2.c.connect(); await assert.rejects(s2.c.writeCoil(POINTS.Q2.address, false), /EXCEPTION_2/); }
  finally { s2.c.close(); s2.srv.close(); }
});
