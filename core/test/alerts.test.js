'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const A = require('../alerts');

const MIN = 60e3;
const SUN = { sunrise: 349, sunset: 1047 };
const T0 = Date.UTC(2026, 10, 15, 0, 0) - 7 * 60 * MIN;          // 00:00 VN
const at = (h, m) => T0 + (h * 60 + m) * MIN;

const snap = (o = {}) => ({
  online: true, sun: SUN, remoteEn: true, remoteOk: true, maint: false, mainsOk: true,
  Q: { K1: true, K2: true, K3: false }, I: { K1: true, K2: true, K3: null },
  overrides: {}, plcClock: { year: 2026, skewSec: 1 }, legacyNI: [0, 0, 0], gatewayTempC: 50, ...o,
});

function run(points) {
  let st = A.initialState(); const all = [];
  for (const [t, s] of points) { const r = A.evaluate(st, s, t); st = r.state; all.push(...r.events.map(e => ({ ...e, t }))); }
  return { st, all };
}
const codes = (evs, type) => evs.filter(e => e.type === type).map(e => e.code);

test('bình thường ban đêm: không cảnh báo', () => {
  const { all } = run([[at(20, 0), snap()], [at(20, 10), snap()]]);
  assert.deepEqual(all, []);
});

test('offline: chỉ báo sau 5 phút, báo hồi phục, không báo lặp trong 30 phút', () => {
  const off = snap({ online: false });
  const { all } = run([
    [at(20, 0), off], [at(20, 4), off], [at(20, 5), off], [at(20, 20), off], [at(20, 36), off], [at(20, 40), snap()], [at(20, 42), snap()],
  ]);
  assert.deepEqual(all.map(e => [e.type, e.code, e.t]), [
    ['raise', 'OFFLINE', at(20, 5)],
    ['remind', 'OFFLINE', at(20, 36)],
    ['clear', 'OFFLINE', at(20, 42)],   // hồi phục phải ổn định 2 phút
  ]);
});

test('khi offline thì không suy ra cảnh báo khác từ dữ liệu cũ', () => {
  const off = snap({ online: false, Q: { K1: false, K2: false, K3: false } });
  const { all } = run([[at(20, 0), off], [at(20, 30), off]]);
  assert.deepEqual(codes(all, 'raise'), ['OFFLINE']);
});

test('Q≠I > 60 s → contactor không khớp', () => {
  const bad = snap({ I: { K1: false, K2: false, K3: null } });
  const { all } = run([[at(20, 0), bad], [at(20, 0) + 59e3, bad], [at(20, 1) + 1e3, bad]]);
  assert.deepEqual(codes(all, 'raise').sort(), ['QI_MISMATCH_K1', 'QI_MISMATCH_K2']);
});

test('đèn tắt ban đêm (sau hoàng hôn + 30′) — trừ khi đang có lệnh tắt cưỡng bức', () => {
  const dark = snap({ Q: { K1: false, K2: false, K3: false }, I: { K1: false, K2: false, K3: null } });
  let r = run([[at(20, 0), dark], [at(20, 6), dark]]);
  assert.ok(codes(r.all, 'raise').includes('NIGHT_OFF'));
  const forced = { ...dark, overrides: { K1: { mode: 'off', until: at(21, 0) } } };
  r = run([[at(20, 0), forced], [at(20, 6), forced]]);
  assert.ok(!codes(r.all, 'raise').includes('NIGHT_OFF'));
  // ngay sau hoàng hôn (17:40) chưa tính là "tắt ban đêm"
  r = run([[at(17, 40), dark], [at(17, 50), dark]]);
  assert.ok(!codes(r.all, 'raise').includes('NIGHT_OFF'));
});

test('đèn sáng ban ngày — trừ khi đang bật cưỡng bức', () => {
  const lit = snap();
  let r = run([[at(10, 0), lit], [at(10, 6), lit]]);
  assert.ok(codes(r.all, 'raise').includes('DAY_ON'));
  const forced = { ...lit, overrides: { K1: { mode: 'on', until: at(10, 15) }, K2: { mode: 'on', until: at(10, 15) } } };
  r = run([[at(10, 0), forced], [at(10, 6), forced]]);
  assert.ok(!codes(r.all, 'raise').includes('DAY_ON'));
});

test('mất REMOTE_OK > 3 phút; khoá tại tủ báo ngay; mất điện lưới > 1 phút', () => {
  let r = run([[at(20, 0), snap({ remoteOk: false })], [at(20, 3), snap({ remoteOk: false })]]);
  assert.ok(codes(r.all, 'raise').includes('REMOTE_LOST'));
  r = run([[at(20, 0), snap({ maint: true, remoteOk: false })]]);
  assert.deepEqual(codes(r.all, 'raise'), ['MAINT']);          // khoá tại tủ: không báo REMOTE_LOST
  r = run([[at(20, 0), snap({ mainsOk: false })], [at(20, 1), snap({ mainsOk: false })]]);
  assert.ok(codes(r.all, 'raise').includes('MAINS_LOST'));
});

test('đồng hồ PLC mất giờ / lệch > 120 s; NI cũ ≠ 0; nhiệt độ gateway cao', () => {
  let r = run([[at(20, 0), snap({ plcClock: { year: 2020, skewSec: 9e7 } })], [at(20, 2), snap({ plcClock: { year: 2020, skewSec: 9e7 } })]]);
  assert.ok(codes(r.all, 'raise').includes('CLOCK'));
  r = run([[at(20, 0), snap({ legacyNI: [0, 1, 0] })], [at(20, 1), snap({ legacyNI: [0, 1, 0] })]]);
  assert.ok(codes(r.all, 'raise').includes('LEGACY_NI'));
  r = run([[at(20, 0), snap({ gatewayTempC: 80 })], [at(20, 5), snap({ gatewayTempC: 80 })]]);
  assert.ok(codes(r.all, 'raise').includes('GW_TEMP'));
});

test('dao động ngắn (chập chờn < ngưỡng) không sinh cảnh báo', () => {
  const pts = [];
  for (let i = 0; i < 20; i++) pts.push([at(20, 0) + i * 60e3, snap({ online: i % 2 === 0 })]);
  const { all } = run(pts);
  assert.deepEqual(all, []);
});

test('mỗi sự kiện có thông điệp tiếng Việt ≤ 2000 ký tự', () => {
  const { all } = run([[at(20, 0), snap({ online: false })], [at(20, 5), snap({ online: false })]]);
  const msg = A.format(all[0], { stationId: 'LVC02', name: 'Tủ Lê Lợi' });
  assert.match(msg, /LVC02/); assert.match(msg, /mất kết nối/i); assert.ok(msg.length <= 2000);
});

test('khoá ELR (C009 đủ 3 lần) báo ngay; không suy thành "đèn tắt ban đêm"', () => {
  const lock = snap({ elrLock: true, Q: { K1: false, K2: false, K3: false }, I: { K1: false, K2: false, K3: null } });
  const { all } = run([[at(20, 0), lock], [at(20, 10), lock]]);
  assert.ok(codes(all, 'raise').includes('ELR_LOCK'));
  assert.ok(!codes(all, 'raise').includes('NIGHT_OFF'));
});

test('ELR tác động 1 lần báo ngay; K2 tắt ban đêm cũng báo; DAY_ON bỏ qua khi khoá tại tủ', () => {
  let r = run([[at(20, 0), snap({ elrActive: true })]]);
  assert.ok(codes(r.all, 'raise').includes('ELR_TRIP'));
  const k2off = snap({ Q: { K1: true, K2: false, K3: false }, I: { K1: true, K2: false, K3: null } });
  r = run([[at(20, 0), k2off], [at(20, 6), k2off]]);
  assert.ok(codes(r.all, 'raise').includes('NIGHT_OFF'));
  r = run([[at(10, 0), snap({ maint: true })], [at(10, 6), snap({ maint: true })]]);
  assert.ok(!codes(r.all, 'raise').includes('DAY_ON'));
});

test('mất điện lưới không kéo theo cảnh báo Q≠I', () => {
  const s = snap({ mainsOk: false, I: { K1: false, K2: false, K3: null } });
  const r = run([[at(20, 0), s], [at(20, 2), s]]);
  assert.ok(codes(r.all, 'raise').includes('MAINS_LOST'));
  assert.ok(!codes(r.all, 'raise').some(c => c.startsWith('QI_')));
});

test('khoá ELR vẫn còn sau 07:00 → cảnh báo riêng', () => {
  const r = run([[at(7, 5), snap({ elrLock: true, Q: { K1: false, K2: false, K3: false }, I: { K1: false, K2: false, K3: null } })]]);
  assert.ok(codes(r.all, 'raise').includes('ELR_LOCK_DAY'));
});

test('sự kiện (lệnh thất bại, ELR tác động) không gửi tin "hồi phục"; lệch lịch phải kéo dài 15′', () => {
  let r = run([[at(20, 0), snap({ cmdFailed: true })], [at(20, 1), snap()], [at(20, 5), snap()]]);
  assert.deepEqual(r.all.map(e => [e.type, e.code]), [['raise', 'CMD_FAILED']]);
  r = run([[at(20, 0), snap({ schedMismatch: true })], [at(20, 14), snap({ schedMismatch: true })]]);
  assert.ok(!codes(r.all, 'raise').includes('SCHED_DRIFT'));
  r = run([[at(20, 0), snap({ schedMismatch: true })], [at(20, 15), snap({ schedMismatch: true })]]);
  assert.ok(codes(r.all, 'raise').includes('SCHED_DRIFT'));
});
