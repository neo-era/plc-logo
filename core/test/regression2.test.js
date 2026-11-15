'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const R = '../';
const S = require(R + 'schedule'), C = require(R + 'commands'), A = require(R + 'alerts');
const MIN = 60e3, SUN = { sunrise: 349, sunset: 1047 };
const T0 = Date.UTC(2026, 10, 15) - 7 * 60 * MIN, at = (h, m) => T0 + (h * 60 + m) * MIN;
const SCHED = { K1: { on: '17:45', off: '05:45' }, K2: { on: '17:46', off: '05:45' }, K3: { on: '22:00', off: '04:00' } };
const inp = (o = {}) => ({ now: at(20, 0), timeSynced: true, skewOk: true, maint: false, plcLinkUpSince: at(19, 0), schedule: SCHED, overrides: {}, ...o });
const snap = (o = {}) => ({ online: true, sun: SUN, remoteEn: true, remoteOk: true, maint: false, mainsOk: true,
  Q: { K1: true, K2: true, K3: false }, I: { K1: true, K2: true, K3: null }, overrides: {}, plcClock: { year: 2026, skewSec: 1 }, legacyNI: [0, 0, 0], gatewayTempC: 50, ...o });
const dark = snap({ Q: { K1: false, K2: false, K3: false }, I: { K1: false, K2: false, K3: null } });
function run(pts) { let st = A.initialState(); const all = []; for (const [t, s] of pts) { const r = A.evaluate(st, s, t); st = r.state; all.push(...r.events.map(e => ({ ...e, t }))); } return all; }

test('N1 tái phát sau khi đã báo HỒI PHỤC phải báo lại ≤ 2 phút sau khi luật kích hoạt (T7)', () => {
  const pts = []; for (let m = 0; m <= 40; m++) { const lit = m >= 10 && m < 13; pts.push([at(20, m), lit ? snap() : dark]); }
  const ev = run(pts).filter(e => e.code === 'NIGHT_OFF');
  // đèn sáng lại chỉ 3 phút rồi tắt: hoặc không báo "hồi phục" (CLEAR_HOLD dài), hoặc nếu đã báo thì phải có tin tái phát ≤ 20:20
  const clearIdx = ev.findIndex(e => e.type === 'clear' && e.t <= at(20, 20));
  if (clearIdx >= 0) assert.ok(ev.slice(clearIdx + 1).some(e => e.type === 'raise' && e.t <= at(20, 20)), JSON.stringify(ev));
  assert.equal(ev[0].type, 'raise');
  assert.ok(!ev.length || ev.at(-1).type !== 'clear', 'tin cuối không được là HỒI PHỤC khi đèn đang tắt');
});
test('N2 CMD_FAILED: lệnh thất bại lần 2 trong 30 phút bị nuốt im lặng', () => {
  const ok = snap(), f = snap({ cmdFailed: true });
  const ev = run([[at(20, 0), f], [at(20, 1), ok], [at(20, 10), f], [at(20, 11), ok]]).filter(e => e.code === 'CMD_FAILED' && e.type !== 'clear');
  assert.equal(ev.length, 2, JSON.stringify(ev));
});
test('N3 restore: dấu thời gian tương lai trong file lưu (hỏng/đổi giờ) không được khoá mạch mãi', () => {
  const bad = JSON.stringify({ v: 1, req: { K1: true, K2: true, K3: false }, flips: { K1: [9e15, 9e15, 9e15, 9e15], K2: [], K3: [] }, k3OffSince: 9e15, lastQ3: false, maintAt: 9e15 });
  const st = S.restore(bad);
  const r = S.step(st, inp({ now: at(10, 0), overrides: { K1: { mode: 'on', until: at(10, 15), setAt: at(10, 0) } } }));
  assert.equal(r.out.req.K1, true, 'override hợp lệ bị bỏ vì maintAt tương lai / flips tương lai: ' + JSON.stringify(r.out));
});
test('N4 sửa lịch từ app bị giới hạn ≤ 6 lần/giờ/tủ (API dùng scheduleEditAllowed)', () => {
  const h = [];
  for (let i = 0; i < 6; i++) { assert.equal(S.scheduleEditAllowed(h, at(20, i)).ok, true); h.push(at(20, i)); }
  assert.equal(S.scheduleEditAllowed(h, at(20, 10)).ok, false);
  assert.equal(S.scheduleEditAllowed(h, at(21, 1)).ok, true);          // cửa sổ trượt 60′
  assert.equal(S.scheduleEditAllowed([9e15, NaN, 'x'], at(20, 0)).ok, true);   // dữ liệu hỏng không khoá
});
test('N5 số lần chuyển VẬT LÝ do cưỡng bức ↔ tự động trong 1 giờ', () => {
  let st = S.initialState(), n = 0, prev = null;
  for (let i = 0; i < 30; i++) {
    const ov = i % 2 ? {} : { K1: { mode: 'off', until: at(21, 30), setAt: at(20, i * 2) } };
    const r = S.step(st, inp({ now: at(20, i * 2), overrides: ov })); st = r.state;
    if (prev !== null && r.out.req.K1 !== prev) n++; prev = r.out.req.K1;
  }
  // T11 (đã chốt): ≤ 4 lần cưỡng bức đi XA lịch/giờ; về lịch luôn được → trần vật lý ≤ 8/giờ
  assert.ok(n <= 8, 'K1 chuyển vật lý ' + n + ' lần/giờ (trần 8)');
});
test('N6 K3 đang yêu cầu bật, Q4 rơi (ELR) → không được bật lại trước 15 phút', () => {
  const sch = SCHED; let st = S.initialState();
  st = S.step(st, inp({ now: at(22, 30), plcQ: { K1: true, K2: true, K3: true } })).state;
  const r = S.step(st, inp({ now: at(22, 31), plcQ: { K1: true, K2: true, K3: false } }));
  assert.equal(r.out.req.K3, false, JSON.stringify(r.out));
});
test('N7 maintAt/setAt: lệnh đặt sau khi mở khoá nhưng setAt (giờ server) lệch 60 s vẫn phải áp dụng — hoặc accept phải từ chối', () => {
  let st = S.initialState();
  st = S.step(st, inp({ now: at(20, 0), maint: true })).state;
  st = S.step(st, inp({ now: at(20, 1) })).state;
  // gateway gán setAt = giờ gateway lúc accept (không dùng giờ server) → luôn sau maintAt
  const acc = C.accept({ cmdId: 'n7', seq: 2, stationId: 'L', kind: 'override', circuit: 'K1', mode: 'off', until: at(20, 30), issuedAt: at(20, 2) - 1000, expiresAt: at(20, 2) + 29000 },
    { now: at(20, 2), lastSeq: 1, stationId: 'L', sun: SUN, timeSynced: true, k1Requested: true });
  assert.equal(acc.status, 'received');
  const ov = { K1: { mode: 'off', until: at(20, 30), setAt: acc.setAt } };
  const r = S.step(st, inp({ now: at(20, 2), overrides: ov }));
  assert.equal(r.out.req.K1, false, 'lệnh received nhưng bị bỏ im lặng: ' + JSON.stringify(r.out));
});
test('N8 override thiếu setAt sau khi từng có MAINT → bị bỏ vĩnh viễn (ghi nhận hành vi)', () => {
  let st = S.initialState(); st = S.step(st, inp({ now: at(18, 0), maint: true })).state;
  const r = S.step(st, inp({ now: at(20, 0), overrides: { K1: { mode: 'off', until: at(20, 30) } } }));
  assert.equal(r.out.req.K1, true, 'lệnh đặt trước/thiếu setAt sau khi khoá LOCAL bị bỏ');
  assert.ok(r.out.reasons.includes('OVERRIDE_STALE_K1'), 'phải báo lý do để lệnh chuyển failed');
});
test('N9 chuỗi lệnh tắt đêm nối tiếp (mỗi lệnh 2 h) → tắt cộng dồn > 2 h', () => {
  const a = S.validateOverride({ circuit: 'K1', mode: 'off', until: at(22, 0) }, at(20, 0), SUN);
  const b = S.validateOverride({ circuit: 'K1', mode: 'off', until: at(23, 59) }, at(22, 0), SUN, 120);   // đã dùng 120′ trong đêm
  assert.ok(!(a.ok && b.ok), 'cả hai đều ok → tắt 4 h liên tục');
});
test('N10 validateSchedule: K3 sáng giữa trưa không cảnh báo; sun thiếu → ném lỗi', () => {
  const r = S.validateSchedule({ ...SCHED, K3: { on: '10:00', off: '14:00' } }, SUN);
  assert.ok(r.needsConfirm, 'K3 ban ngày: ' + JSON.stringify(r));
});
test('N11 validateSchedule(sun thiếu) không được ném', () => {
  assert.doesNotThrow(() => S.validateSchedule(SCHED, undefined));
});
test('N12 nightMinutesBetween biên', () => {
  assert.equal(S.nightMinutesBetween(at(17, 27), at(17, 28), SUN), 1);
  assert.equal(S.nightMinutesBetween(at(5, 48), at(5, 50), SUN), 1);
  assert.equal(S.nightMinutesBetween(at(20, 0), at(20, 0), SUN), 0);
  assert.equal(S.validateOverride({ circuit: 'K1', mode: 'off', until: at(22, 0) }, at(20, 0), SUN).ok, true);   // đúng 120′
  assert.equal(S.validateOverride({ circuit: 'K1', mode: 'off', until: at(22, 0) + 60e3 }, at(20, 0), SUN).ok, false);
  const t = Date.now(); S.nightMinutesBetween(0, 12 * 60 * MIN, SUN); assert.ok(Date.now() - t < 50);
});
test('N13 alerts: offline lâu rồi online, điều kiện vẫn đúng → không raise ngay bằng since cũ trước khi có ≥ hold dữ liệu online', () => {
  const ev = run([[at(20, 0), dark], [at(20, 3), dark], [at(20, 4), { ...dark, online: false }], [at(23, 0), dark]]);
  const nf = ev.filter(e => e.code === 'NIGHT_OFF' && e.type === 'raise');
  assert.ok(!nf.some(e => e.t === at(23, 0)), 'raise ngay khi vừa online: ' + JSON.stringify(nf));
});
test('N14 alerts: cảnh báo đang raise, offline 3 giờ, online & hết lỗi → clear sau CLEAR_HOLD, không remind giả', () => {
  const ev = run([[at(20, 0), dark], [at(20, 6), dark], [at(20, 7), { ...dark, online: false }], [at(23, 0), snap()], [at(23, 1), snap()], [at(23, 2), snap()], [at(23, 10), snap()]]);   // NIGHT_OFF: hồi phục phải ổn định 10′
  const nf = ev.filter(e => e.code === 'NIGHT_OFF');
  assert.deepEqual(nf.map(e => e.type), ['raise', 'clear'], JSON.stringify(nf));
});
test('N15 accept: RATE_LIMIT chặn cả lệnh "off" khi lịch đang off (về đúng lịch) — mâu thuẫn B6', () => {
  const NOW = at(10, 0);
  const r = C.accept({ cmdId: 'x', seq: 2, stationId: 'L', kind: 'override', circuit: 'K1', mode: 'auto', issuedAt: NOW, expiresAt: NOW + 30e3 },
    { now: NOW, lastSeq: 1, stationId: 'L', sun: SUN, timeSynced: true, k1Requested: true, remoteOk: false });
  assert.notEqual(r.reason, 'REMOTE_NOT_OK', '"Trả về tự động" bị chặn khi REMOTE_OK=0');
});
test('N16 transition: không có received→rejected/duplicate; applied→expired', () => {
  assert.equal(C.transition('confirmed', 'failed').ok, false);
  assert.equal(C.transition('received', 'confirmed').ok, false);
});
test('N17 fuzz restore(serialize) + step: K2⇒K1, flips ≤ 4 đi xa lịch, không ném', () => {
  let st = S.initialState(), t = at(16, 0), seed = 3;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let i = 0; i < 20000; i++) {
    t += Math.floor(rnd() * 3 * MIN);
    const m = () => ['on', 'off', 'auto'][Math.floor(rnd() * 3)];
    const o = { K1: { mode: m(), until: t + rnd() * 3600e3, setAt: t }, K2: { mode: m(), until: t + rnd() * 3600e3, setAt: t } };
    if (rnd() < 0.05) st = S.restore(S.serialize(st));
    const r = S.step(st, inp({ now: t, overrides: o, maint: rnd() < 0.02, plcQ: { K1: true, K2: true, K3: rnd() < 0.5 }, plcLinkUpSince: t - 120e3 }));
    if (r.out.req.K2) assert.ok(r.out.req.K1);
    for (const c of ['K1', 'K2', 'K3']) assert.ok(r.state.flips[c].length <= 4);
    st = r.state;
  }
});
