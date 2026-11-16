'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { LogoV4 } = require('../logo-v4');

const S = 1000, MIN = 60 * S;
// 2026-11-15 giờ VN
const vn = (h, m = 0) => Date.UTC(2026, 10, 15, h - 7, m);

function plc(h, m = 0) { const p = new LogoV4({ clock: vn(h, m) }); p.run(2 * S); return p; }
const heartbeat = (p, ms) => { for (let t = 0; t < ms; t += 10 * S) { p.setV(100, 0, !p.getV(100, 0)); p.run(10 * S); } };
function remote(p, { K1 = false, K2 = false, K3 = false } = {}) {
  p.setV(100, 1, true); p.setV(100, 2, K1); p.setV(100, 3, K2); p.setV(100, 4, K3);
}

test('lịch tại tủ: 20:00 K1 sáng, K2 sáng sau 30 s, K3 tắt; 22:00 K3 sáng', () => {
  const p = plc(20, 0);
  assert.equal(p.Q[2], true); assert.equal(p.Q[3], false);
  p.run(31 * S); assert.equal(p.Q[3], true); assert.equal(p.Q[4], false);
  p.run(2 * 60 * MIN); assert.equal(p.Q[4], true);
});

test('watchdog: vừa khởi động M24 = 0; HB đảo → M24 = 1; HB kẹt 0 hoặc kẹt 1 → M24 = 0 sau ≤ 180 s', () => {
  const p = plc(20); assert.equal(p.M[24], false);
  heartbeat(p, 30 * S); assert.equal(p.M[24], true);
  p.run(160 * S); assert.equal(p.M[24], true);   // lần đảo cuối cách đây 10 s → còn trong 180 s
  p.run(15 * S); assert.equal(p.M[24], false, 'kẹt 0/1 quá 180 s');
  heartbeat(p, 30 * S); p.setV(100, 0, true); p.run(185 * S); assert.equal(p.M[24], false, 'kẹt 1');
});

test('tầng từ xa: REMOTE_OK thì theo K*_REQ; mất nhịp tim thì về lịch tại tủ', () => {
  const p = plc(20); remote(p, { K1: false }); heartbeat(p, 30 * S);
  assert.equal(p.M[20], true); assert.equal(p.Q[2], false, 'từ xa tắt K1');
  p.run(185 * S); assert.equal(p.M[20], false); assert.equal(p.Q[2], true, 'về lịch tại tủ');
});

test('công tắc LOCAL (I3) chặn từ xa và chặn NI1', () => {
  const p = plc(10); remote(p, { K1: true }); heartbeat(p, 30 * S); assert.equal(p.Q[2], true);
  p.setI(3, true); p.run(1 * S); assert.equal(p.M[20], false); assert.equal(p.Q[2], false, 'ban ngày về lịch: tắt');
  p.setV(0, 0, true); p.run(2 * S); assert.equal(p.Q[2], false, 'NI1 bị chặn khi LOCAL');
});

test('liên động: K2 chỉ đóng sau Q2 đóng 30 s ở mọi tầng (từ xa, tay I2, NI1)', () => {
  for (const mode of ['remote', 'I2', 'NI1']) {
    const p = plc(10);
    if (mode === 'remote') { remote(p, { K1: true, K2: true }); heartbeat(p, 20 * S); }
    if (mode === 'I2') { p.setI(2, true); p.run(1 * S); }
    if (mode === 'NI1') { p.setV(0, 0, true); p.run(1 * S); }
    assert.equal(p.Q[2], true, mode);
    const t0 = p.since.Q2on;
    while (!p.Q[3] && p.now - t0 < 60 * S) p.run(1 * S);
    assert.ok(p.Q[3], mode + ': K2 không đóng');
    assert.ok(p.now - t0 >= 30 * S, mode + ': K2 đóng sớm');
  }
});

test('ELR: tác động cắt cả 3 mạch 15 s; 3 lần → khoá; lệnh từ xa không gỡ được; khoá còn sau 05:45 nếu từ xa còn bật', () => {
  const p = plc(22, 30); p.run(31 * S);
  const trip = () => { p.setI(1, true); p.run(1 * S); p.setI(1, false); p.run(20 * S); };
  trip(); assert.equal(p.Q[2], true, 'nhả sau 15 s'); assert.equal(p.M[16], false);
  trip(); trip(); assert.equal(p.M[16], true); assert.equal(p.Q[2], false); assert.equal(p.Q[4], false);
  remote(p, { K1: true, K2: true, K3: true }); heartbeat(p, 60 * S); assert.equal(p.Q[2], false, 'khoá ELR giữ');
  // tới 05:50 lịch tại tủ đã tắt nhưng từ xa vẫn yêu cầu bật → vẫn khoá
  heartbeat(p, vn(5, 50) + 864e5 - p.clock); assert.equal(p.M[16], true);
  // từ xa thôi yêu cầu → ban ngày gỡ khoá
  remote(p, {}); heartbeat(p, 20 * S); assert.equal(p.M[16], false);
});

test('khoá ELR còn sau khi cúp nguồn PLC (C009 Rem = on); M24 = 0 sau cấp nguồn', () => {
  const p = plc(22, 30);
  for (let i = 0; i < 3; i++) { p.setI(1, true); p.run(1 * S); p.setI(1, false); p.run(20 * S); }
  assert.equal(p.M[16], true);
  p.powerCycle(); p.run(2 * S);
  assert.equal(p.M[16], true); assert.equal(p.M[24], false); assert.equal(p.getV(100, 1), false, 'VM xoá khi mất nguồn');
});

test('K3 nguội: ELR 1 lần lúc 22:30 → K1/K2 đóng lại ~15 s, K3 không đóng lại trước 15′', () => {
  const p = plc(22, 30); p.run(31 * S); assert.equal(p.Q[4], true);
  p.setI(1, true); p.run(1 * S); p.setI(1, false); p.run(20 * S);
  assert.equal(p.Q[2], true); assert.equal(p.Q[4], false);
  p.run(14 * MIN); assert.equal(p.Q[4], false);
  p.run(2 * MIN); assert.equal(p.Q[4], true);
});

test('NI2 (cấm K1) nay cấm luôn K2', () => {
  const p = plc(20); p.setV(0, 1, true); p.run(40 * S);
  assert.equal(p.Q[2], false); assert.equal(p.Q[3], false);
});

test('M32–M34 phản ánh lịch tại tủ; RTC đọc/ghi', () => {
  const p = plc(20); assert.equal(p.M[32], true); assert.equal(p.M[34], false);
  const r = p.rtc(); assert.deepEqual([r.hour, r.minute], [20, 0]);
  p.setRtc({ year: 2020, month: 1, day: 1, hour: 0, minute: 0 }); assert.equal(p.rtc().year, 2020);
});
