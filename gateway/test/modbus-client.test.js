'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { ModbusClient } = require('../modbus-client');

function server(handler) { return new Promise(r => { const s = net.createServer(handler); s.listen(0, '127.0.0.1', () => r(s)); }); }

test('B3: timeout giữa khung rồi kết nối lại → khung mới đọc đúng (không lệch vĩnh viễn)', async () => {
  let n = 0;
  const srv = await server(s => { const k = n++; s.on('data', d => {
    const tid = d.readUInt16BE(0), resp = Buffer.from([tid >> 8, tid & 255, 0, 0, 0, 4, 1, 1, 1, 0x05]);
    s.write(k === 0 ? resp.subarray(0, 5) : resp);
  }); });
  const c = new ModbusClient({ host: '127.0.0.1', port: srv.address().port, timeoutMs: 300 });
  try {
    await c.connect();
    await assert.rejects(c.readCoils(0, 3), /TIMEOUT/);
    c.close(); await new Promise(r => setTimeout(r, 50)); await c.connect();
    for (let i = 0; i < 3; i++) assert.deepEqual(await c.readCoils(0, 3), [true, false, true]);
  } finally { c.close(); srv.close(); }
});

test('khung sai (protocol id ≠ 0 / sai mã hàm / sai số byte) → huỷ kết nối, không trả dữ liệu nhầm', async () => {
  const bad = [
    tid => Buffer.from([tid >> 8, tid & 255, 0, 9, 0, 4, 1, 1, 1, 0x05]),       // protocol id 9
    tid => Buffer.from([tid >> 8, tid & 255, 0, 0, 0, 4, 1, 3, 1, 0x05]),       // FC 3 cho yêu cầu FC 1
    tid => Buffer.from([tid >> 8, tid & 255, 0, 0, 0, 5, 1, 1, 2, 0x05, 0]),    // 2 byte cho 3 bit
  ];
  for (const mk of bad) {
    const srv = await server(s => s.on('data', d => s.write(mk(d.readUInt16BE(0)))));
    const c = new ModbusClient({ host: '127.0.0.1', port: srv.address().port, timeoutMs: 300 });
    try { await c.connect(); await assert.rejects(c.readCoils(0, 3)); assert.equal(c.connected, false); }
    finally { c.close(); srv.close(); }
  }
});

test('connect có timeout (PLC không trả lời SYN)', async () => {
  const c = new ModbusClient({ host: '10.255.255.1', port: 502, timeoutMs: 300, connectTimeoutMs: 300 });
  const t0 = Date.now();
  await assert.rejects(c.connect());
  assert.ok(Date.now() - t0 < 2000);
});
