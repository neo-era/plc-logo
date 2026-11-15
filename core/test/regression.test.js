'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const R = '../';
const S = require(R + 'schedule'), C = require(R + 'commands'), A = require(R + 'alerts'), SUN_ = require(R + 'sun');
const MIN = 60e3;
const SUN = { sunrise: 349, sunset: 1047 };
const T0 = Date.UTC(2026, 10, 15, 0, 0) - 7 * 60 * MIN;
const at = (h, m) => T0 + (h * 60 + m) * MIN;
const SCHED = { K1: { on: '17:45', off: '05:45' }, K2: { on: '17:46', off: '05:45' }, K3: { on: '22:00', off: '04:00' } };
const inp = (o = {}) => ({ now: at(20, 0), timeSynced: true, skewOk: true, maint: false, plcLinkUpSince: 0, schedule: SCHED, overrides: {}, ...o });
const NOW = 1_800_000_000_000;
const cmd = (o = {}) => ({ cmdId: 'c1', seq: 11, stationId: 'LVC02', kind: 'override', circuit: 'K1', mode: 'on', until: NOW + 3600e3, issuedAt: NOW - 1000, expiresAt: NOW + 29000, ...o });
const ctx = (o = {}) => ({ now: NOW, stationId: 'LVC02', lastSeq: 10, timeSynced: true, maint: false, k1Requested: true, sun: SUN, ...o });

// ---------- schedule ----------
test('S1 step: now = NaN không được REMOTE_EN=1 và tắt đèn ban đêm', () => {
  let st = S.step(S.initialState(), inp()).state;
  const r = S.step(st, inp({ now: NaN }));
  assert.ok(!(r.out.remoteEn && r.out.req.K1 === false), JSON.stringify(r.out));
});
test('S2 step: lịch đệm rỗng/hỏng → không được tắt đèn ban đêm với REMOTE_EN=1', () => {
  let st = S.step(S.initialState(), inp()).state;
  const r = S.step(st, inp({ schedule: undefined }));
  assert.ok(!(r.out.remoteEn && r.out.req.K1 === false), JSON.stringify(r.out));
});
test('S3 validateOverride: tắt cưỡng bức bắt đầu 17:00 (ban ngày) kéo 11 h qua đêm phải bị chặn (T11 ≤ 2 h đêm)', () => {
  const r = S.validateOverride({ circuit: 'K1', mode: 'off', until: at(17, 0) + 11 * 60 * MIN }, at(17, 0), SUN);
  assert.equal(r.ok, false, JSON.stringify(r));
});
test('S4 validateSchedule: K1 05:50–06:10 (tắt cả đêm) phải cần xác nhận', () => {
  const r = S.validateSchedule({ ...SCHED, K1: { on: '05:50', off: '06:10' }, K2: { on: '05:51', off: '06:10' } }, SUN);
  assert.ok(r.needsConfirm || r.errors.length, JSON.stringify(r));
});
test('S5 K3 nguội: PLC (tầng tại tủ) vừa tắt K3, 2 phút sau từ xa giành lại → không được bật K3', () => {
  // 04:00 T006 tắt K3 khi REMOTE_EN=0; 04:02 lịch từ xa (K3 22:00–04:30) muốn bật
  const sch = { ...SCHED, K3: { on: '22:00', off: '04:30' } };
  let st = S.initialState();
  st = S.step(st, inp({ now: at(3, 0), schedule: sch, timeSynced: false, plcQ: { K1: true, K2: true, K3: true } })).state;
  const r = S.step(st, inp({ now: at(4, 2), schedule: sch, plcLinkUpSince: at(4, 0) - 61e3, plcQ: { K1: true, K2: true, K3: false } }));
  assert.equal(r.out.req.K3, false, JSON.stringify(r.out));
});
test('S6 khởi động lại gateway mất bộ đếm chuyển/nguội (state chỉ trong RAM)', () => {
  // 4 lần chuyển K1 trong giờ, restart → được chuyển tiếp
  // ban ngày (lịch = tắt): 4 lần bật cưỡng bức đi xa lịch trong 1 giờ
  let st = S.initialState(); const ov = m => ({ K1: { mode: m, until: at(11, 0) } });
  st = S.step(st, inp({ now: at(10, 0) })).state;
  for (let i = 1; i <= 8; i++) st = S.step(st, inp({ now: at(10, i), overrides: ov(i % 2 ? 'on' : 'off') })).state;
  const blocked = S.step(st, inp({ now: at(10, 9), overrides: ov('on') }));
  assert.equal(blocked.out.req.K1, false);
  assert.ok(blocked.out.reasons.includes('RATE_LIMIT_K1'));
  // khởi động lại: gateway khôi phục state đã lưu bền → giới hạn vẫn giữ
  const restored = S.restore(S.serialize(blocked.state));
  const r = S.step(restored, inp({ now: at(10, 10), overrides: ov('on') }));
  assert.equal(r.out.req.K1, false, 'restart bypass rate limit: ' + JSON.stringify(r.out));
  // dữ liệu lưu hỏng → state ban đầu, không ném lỗi
  for (const bad of ['{', 'null', '{"v":9}', '{"v":1,"flips":{"K1":["x"]}}']) assert.deepEqual(S.restore(bad), S.initialState());
});
test('S7 K2 bị ép tắt bởi bất biến cuối vẫn bị trừ lượt chuyển (đếm ảo)', () => {
  let st = S.initialState();
  const ov = (k1, k2) => ({ K1: { mode: k1, until: at(23, 0) }, K2: { mode: k2, until: at(23, 0) } });
  // ban ngày: K1 dùng hết 4 lượt bật cưỡng bức, đang tắt; K2 yêu cầu bật nhưng bị bất biến ép tắt
  st = S.step(st, inp({ now: at(10, 0), overrides: ov('off', 'off') })).state;
  for (let i = 1; i <= 8; i++) st = S.step(st, inp({ now: at(10, i), overrides: ov(i % 2 ? 'on' : 'off', 'off') })).state;
  const r = S.step(st, inp({ now: at(10, 9), overrides: ov('on', 'on') }));
  assert.equal(r.out.req.K2, false);
  assert.equal(r.state.flips.K2.length, 0, 'K2 flips=' + r.state.flips.K2.length);
});
test('S8 K2⇒K1 mọi lúc (fuzz 20k bước) + không đột biến prev', () => {
  let st = S.initialState(), t = at(17, 0), seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let i = 0; i < 20000; i++) {
    t += Math.floor(rnd() * 5 * MIN);
    const m = () => ['on', 'off', 'auto'][Math.floor(rnd() * 3)];
    const o = { K1: { mode: m(), until: t + rnd() * 3600e3 }, K2: { mode: m(), until: t + rnd() * 3600e3 }, K3: { mode: m(), until: t + rnd() * 3600e3 } };
    const frozen = JSON.stringify(st);
    const r = S.step(st, inp({ now: t, overrides: o, timeSynced: rnd() > 0.1, plcLinkUpSince: t - 120e3 }));
    assert.equal(JSON.stringify(st), frozen, 'prev bị đột biến');
    if (r.out.req.K2) assert.ok(r.out.req.K1, 'K2 không K1 tại ' + i);
    for (const c of ['K1', 'K2', 'K3']) assert.ok(r.state.flips[c].length <= 4);
    st = r.state;
  }
});
test('S9 LOCAL (maint) phải huỷ cưỡng bức: sau khi về REMOTE, lệnh cũ còn hạn không được tái áp dụng', () => {
  let st = S.initialState(); const ov = { K1: { mode: 'off', until: at(21, 0) } };
  st = S.step(st, inp({ now: at(20, 0), overrides: ov })).state;
  st = S.step(st, inp({ now: at(20, 5), overrides: ov, maint: true })).state;
  const r = S.step(st, inp({ now: at(20, 10), overrides: ov }));
  assert.equal(r.out.req.K1, true, JSON.stringify(r.out));
});
test('S10 nửa đêm/biên', () => {
  assert.equal(S.vnMinute(at(23, 59) + 59999), 1439);
  assert.equal(S.vnMinute(at(24, 0)), 0);
  assert.equal(S.isOnAt({ on: 1080, off: 0 }, 1439), true);
  assert.equal(S.isOnAt({ on: 1080, off: 0 }, 0), false);
  assert.equal(S.validateOverride({ circuit: 'K1', mode: 'on', until: at(20, 0) }, at(20, 0), SUN).ok, false); // until == now
  assert.throws(() => SUN_.sunTimes(2026, 2, 29)); assert.doesNotThrow(() => SUN_.sunTimes(2028, 2, 29));
});

// ---------- commands ----------
test('C1 ctx.now thiếu/NaN → không được "received" lệnh đã hết hạn (fail-open)', () => {
  const r = C.accept(cmd({ expiresAt: NOW - 1e6, issuedAt: NOW - 1e6 - 1000 }), ctx({ now: undefined }));
  assert.notEqual(r.status, 'received');
});
test('C2 ctx.lastSeq thiếu/NaN → mọi seq đều qua (mất chống phát lại)', () => {
  const r = C.accept(cmd({ seq: 1 }), ctx({ lastSeq: NaN }));
  assert.notEqual(r.status, 'received');
});
test('C3 issuedAt ở tương lai xa → lệnh sống mãi', () => {
  const r = C.accept(cmd({ issuedAt: NOW + 864e5, expiresAt: NOW + 864e5 + 30e3 }), ctx());
  assert.notEqual(r.status, 'received');
});
test('C4 lệnh until đã qua / until == now không được received; K3 nay điều khiển được (chốt 16/11/2026)', () => {
  assert.equal(C.accept(cmd({ circuit: 'K3' }), ctx()).status, 'received', 'K3');
  assert.notEqual(C.accept(cmd({ until: NOW - 1 }), ctx()).status, 'received', 'until quá khứ');
  assert.notEqual(C.accept(cmd({ until: NOW }), ctx()).status, 'received', 'until == now');
});
test('C5 lệnh trùng (cùng cmdId, cùng seq) đã thực hiện → ACK phải idempotent, không "rejected"', () => {
  const r = C.accept(cmd({ seq: 10 }), ctx({ lastSeq: 10, lastCmdId: 'c1' }));
  assert.notEqual(r.status, 'rejected', JSON.stringify(r));
});
test('C6 evaluate: K1 thiếu trường I (lỗi đọc) không được confirmed', () => {
  assert.notEqual(C.evaluate({ circuit: 'K1', want: true }, { Q: true }, 3000), 'confirmed');
});
test('C7 biên expiresAt / CONFIRM', () => {
  assert.equal(C.accept(cmd({ expiresAt: NOW }), ctx()).status, 'received');   // now == expiresAt
  assert.equal(C.evaluate({ circuit: 'K1', want: true }, { Q: false, I: false }, 10000), 'pending');
});
test('C8 máy trạng thái lệnh: có hàm chuyển trạng thái received→applied→confirmed?', () => {
  assert.ok(typeof C.transition === 'function' || typeof C.next === 'function', 'chưa có');
});

// ---------- alerts ----------
const snap = (o = {}) => ({ online: true, sun: SUN, remoteEn: true, remoteOk: true, maint: false, mainsOk: true,
  Q: { K1: true, K2: true, K3: false }, I: { K1: true, K2: true, K3: null }, overrides: {}, plcClock: { year: 2026, skewSec: 1 }, legacyNI: [0, 0, 0], gatewayTempC: 50, ...o });
function run(points) { let st = A.initialState(); const all = [];
  for (const [t, s] of points) { const r = A.evaluate(st, s, t); st = r.state; all.push(...r.events.map(e => ({ ...e, t }))); } return all; }
const dark = snap({ Q: { K1: false, K2: false, K3: false }, I: { K1: false, K2: false, K3: null } });
test('A1 đang NIGHT_OFF mà tủ offline → KHÔNG được báo "ĐÃ HỒI PHỤC" NIGHT_OFF', () => {
  const ev = run([[at(20, 0), dark], [at(20, 6), dark], [at(20, 7), { ...dark, online: false }]]);
  assert.ok(!ev.some(e => e.type === 'clear' && e.code === 'NIGHT_OFF'), JSON.stringify(ev));
});
test('A2 offline chập chờn xen kẽ → NIGHT_OFF ≤ 1 tin/30 phút', () => {
  const pts = []; let t = at(20, 0);
  for (let i = 0; i < 30; i++) { pts.push([t, dark]); t += 6 * MIN; pts.push([t, dark]); pts.push([t + 1000, { ...dark, online: false }]); t += 2 * MIN; }
  const ev = run(pts).filter(e => e.code === 'NIGHT_OFF' && e.type !== 'clear');
  const first30 = ev.filter(e => e.t < at(20, 30));
  assert.ok(first30.length <= 1, 'NIGHT_OFF raise trong 30 phút: ' + first30.length + ', tổng ' + ev.length);
});
test('A3 snapshot thiếu Q/I (gateway gửi hỏng) không được ném lỗi', () => {
  assert.doesNotThrow(() => A.evaluate(A.initialState(), { online: true, sun: SUN }, at(20, 0)));
});
test('A4 đổi ngày: NIGHT_OFF giữ liên tục qua 00:00 không raise lại', () => {
  const ev = run([[at(23, 50), dark], [at(23, 56), dark], [at(24, 1), dark], [at(24, 10), dark]]);
  assert.equal(ev.filter(e => e.type === 'raise').length, 1);
});
test('A5 thiếu luật lệch lịch > 15′ và lệnh thất bại (mục 5.2)', () => {
  const codes = A.RULES.map(r => r[0]);
  assert.ok(codes.some(c => /SCHED|DRIFT|LECH/.test(c)), 'thiếu lệch lịch');
  assert.ok(codes.some(c => /CMD|FAIL/.test(c)), 'thiếu lệnh thất bại');
});
test('A6 không đột biến state đầu vào', () => {
  const st0 = A.initialState(); const r1 = A.evaluate(st0, { ...dark, online: false }, at(20, 0));
  const fr = JSON.stringify(r1.state); A.evaluate(r1.state, { ...dark, online: false }, at(20, 6));
  assert.equal(JSON.stringify(r1.state), fr);
});
