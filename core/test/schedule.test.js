'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../schedule');

const SUN = { sunrise: 353, sunset: 1048 }; // 05:53 / 17:28
const SCHED = { K1: { on: '17:45', off: '05:45' }, K2: { on: '17:46', off: '05:45' }, K3: { on: '22:00', off: '04:00' } };
const MIN = 60 * 1000;
const T0 = Date.UTC(2026, 10, 15, 0, 0) - 7 * 60 * MIN; // 2026-11-15 00:00 giờ VN
const at = (h, m, dayOffset = 0) => T0 + ((dayOffset * 24 + h) * 60 + m) * MIN;

// ── parse & khoảng giờ ─────────────────────────────────────
test('parseHM hợp lệ / không hợp lệ', () => {
  assert.equal(S.parseHM('17:45'), 1065);
  assert.equal(S.parseHM('00:00'), 0);
  for (const bad of ['24:00', '7:5', '12:60', '', null, 'ab:cd', '-1:00']) assert.equal(S.parseHM(bad), null, String(bad));
});

test('isOnAt hiểu khoảng qua đêm', () => {
  const w = { on: 1065, off: 345 };
  assert.equal(S.isOnAt(w, 1064), false);
  assert.equal(S.isOnAt(w, 1065), true);
  assert.equal(S.isOnAt(w, 0), true);
  assert.equal(S.isOnAt(w, 344), true);
  assert.equal(S.isOnAt(w, 345), false);
  assert.equal(S.isOnAt({ on: 600, off: 720 }, 650), true);   // trong ngày
  assert.equal(S.isOnAt({ on: 600, off: 720 }, 800), false);
});

test('vnMinute: đổi epoch sang phút trong ngày giờ VN', () => {
  assert.equal(S.vnMinute(at(19, 52)), 19 * 60 + 52);
  assert.equal(S.vnMinute(at(0, 5, 1)), 5);
});

// ── kiểm lịch ──────────────────────────────────────────────
test('lịch chuẩn hợp lệ, không cần xác nhận', () => {
  const r = S.validateSchedule(SCHED, SUN);
  assert.deepEqual(r.errors, []);
  assert.equal(r.needsConfirm, false);
});

test('giờ bật = giờ tắt → lỗi', () => {
  const r = S.validateSchedule({ ...SCHED, K3: { on: '22:00', off: '22:00' } }, SUN);
  assert.ok(r.errors.some(e => e.code === 'ON_EQ_OFF' && e.circuit === 'K3'));
});

test('giờ sai định dạng → lỗi', () => {
  const r = S.validateSchedule({ ...SCHED, K1: { on: '25:00', off: '05:45' } }, SUN);
  assert.ok(r.errors.some(e => e.code === 'BAD_TIME' && e.circuit === 'K1'));
});

test('quy tắc K1–K2: K2 bật trước K1+1 phút → lỗi; K2 tắt sau K1 → lỗi', () => {
  let r = S.validateSchedule({ ...SCHED, K2: { on: '17:45', off: '05:45' } }, SUN);
  assert.ok(r.errors.some(e => e.code === 'K2_ON_BEFORE_K1'));
  r = S.validateSchedule({ ...SCHED, K2: { on: '17:50', off: '06:00' } }, SUN);
  assert.ok(r.errors.some(e => e.code === 'K2_OFF_AFTER_K1'));
  r = S.validateSchedule({ ...SCHED, K2: { on: '18:30', off: '23:00' } }, SUN); // K2 tắt sớm hơn: hợp lệ
  assert.deepEqual(r.errors, []);
});

test('lịch làm đèn tắt > 30 phút sau hoàng hôn hoặc sáng > 30 phút sau bình minh → cần xác nhận', () => {
  let r = S.validateSchedule({ ...SCHED, K1: { on: '18:10', off: '05:45' }, K2: { on: '18:11', off: '05:45' } }, SUN);
  assert.equal(r.needsConfirm, true);
  assert.ok(r.warnings.some(w => w.code === 'LATE_ON' && w.circuit === 'K1'));
  r = S.validateSchedule({ ...SCHED, K1: { on: '17:45', off: '06:30' } , K2: { on: '17:46', off: '06:30' }}, SUN);
  assert.ok(r.warnings.some(w => w.code === 'LATE_OFF' && w.circuit === 'K1'));
  r = S.validateSchedule({ ...SCHED, K1: { on: '17:45', off: '23:00' }, K2: { on: '17:46', off: '23:00' } }, SUN);
  assert.ok(r.warnings.some(w => w.code === 'EARLY_OFF' && w.circuit === 'K1'));
  // K3 (HPS bổ sung, bật 22h–4h) không áp quy tắc phủ cả đêm
  r = S.validateSchedule(SCHED, SUN);
  assert.equal(r.warnings.filter(w => w.circuit === 'K3').length, 0);
});

// ── kiểm lệnh cưỡng bức ───────────────────────────────────
test('cưỡng bức: hạn mặc định, tối đa 12 h, tắt ban đêm tối đa 2 h', () => {
  assert.equal(S.defaultForceMinutes(at(20, 0), SUN), 60);
  assert.equal(S.defaultForceMinutes(at(10, 0), SUN), 15);
  let r = S.validateOverride({ circuit: 'K1', mode: 'on', until: at(20, 0) + 13 * 60 * MIN }, at(20, 0), SUN);
  assert.equal(r.ok, false); assert.equal(r.code, 'TOO_LONG');
  r = S.validateOverride({ circuit: 'K1', mode: 'off', until: at(20, 0) + 3 * 60 * MIN }, at(20, 0), SUN);
  assert.equal(r.ok, false); assert.equal(r.code, 'NIGHT_OFF_TOO_LONG');
  r = S.validateOverride({ circuit: 'K1', mode: 'off', until: at(20, 0) + 90 * MIN }, at(20, 0), SUN);
  assert.equal(r.ok, true); assert.equal(r.notifyGroup, true);
  r = S.validateOverride({ circuit: 'K1', mode: 'on', until: at(20, 0) - MIN }, at(20, 0), SUN);
  assert.equal(r.ok, false); assert.equal(r.code, 'EXPIRED');
  r = S.validateOverride({ circuit: 'K3', mode: 'on', until: at(20, 30) }, at(20, 0), SUN);
  assert.equal(r.ok, true, 'K3 điều khiển được (anh Lâm chốt 16/11/2026)');
  r = S.validateOverride({ circuit: 'K3', mode: 'off', until: at(23, 0) + 60e3 }, at(23, 0) - 120 * MIN, SUN);
  assert.equal(r.ok, false); assert.equal(r.code, 'NIGHT_OFF_TOO_LONG');
});

// ── bộ quyết định tầng (reducer thuần) ────────────────────
const baseIn = (now, over = {}) => ({
  now, sun: SUN, schedule: SCHED, overrides: {}, timeSynced: true, skewOk: true,
  plcLinkUpSince: now - 10 * MIN, maint: false, ...over,
});

function run(seq) {
  let st = S.initialState();
  const outs = [];
  for (const inp of seq) { const r = S.step(st, inp); st = r.state; outs.push(r.out); }
  return { st, outs };
}

test('theo lịch: 19:52 K1,K2 bật; K3 tắt; REMOTE_EN = 1', () => {
  const { outs } = run([baseIn(at(19, 52))]);
  assert.deepEqual(outs[0], { remoteEn: true, req: { K1: true, K2: true, K3: false }, reasons: [], clearOverrides: false });
});

test('REMOTE_EN = 0 khi chưa đồng bộ giờ / lệch giờ / khoá tại tủ / liên kết PLC chưa ổn định 60 s', () => {
  for (const [k, v, reason] of [['timeSynced', false, 'NOT_SYNCED'], ['skewOk', false, 'CLOCK_SKEW'], ['maint', true, 'MAINT']]) {
    const { outs } = run([baseIn(at(19, 52), { [k]: v })]);
    assert.equal(outs[0].remoteEn, false, k); assert.ok(outs[0].reasons.includes(reason), k);
  }
  const { outs } = run([baseIn(at(19, 52), { plcLinkUpSince: at(19, 52) - 30 * 1000 })]);
  assert.equal(outs[0].remoteEn, false); assert.ok(outs[0].reasons.includes('LINK_UNSTABLE'));
});

test('cưỡng bức có hạn thắng lịch, hết hạn tự về lịch', () => {
  const ov = { K1: { mode: 'off', until: at(20, 30) } };
  const { outs } = run([baseIn(at(20, 0), { overrides: ov }), baseIn(at(20, 31), { overrides: ov })]);
  assert.equal(outs[0].req.K1, false);
  assert.equal(outs[1].req.K1, true);
});

test('K2 không bao giờ được yêu cầu khi K1 không được yêu cầu', () => {
  const ov = { K1: { mode: 'off', until: at(21, 0) }, K2: { mode: 'on', until: at(21, 0) } };
  const { outs } = run([baseIn(at(20, 0), { overrides: ov })]);
  assert.equal(outs[0].req.K1, false); assert.equal(outs[0].req.K2, false);
  assert.ok(outs[0].reasons.includes('K2_NEEDS_K1'));
});

test('giới hạn ≤ 4 lần cưỡng bức đi xa lịch / mạch / giờ; về lịch luôn được', () => {
  const seq = []; let t = at(10, 0);   // ban ngày: lịch = tắt, cưỡng bức "on" là đi xa lịch
  for (let i = 0; i < 10; i++) { // đảo lệnh liên tục mỗi 5 phút
    seq.push(baseIn(t, { overrides: { K1: { mode: i % 2 ? 'off' : 'on', until: t + 10 * MIN } } }));
    t += 5 * MIN;
  }
  const { outs } = run(seq);
  let flips = 0;
  for (let i = 1; i < outs.length; i++) if (outs[i].req.K1 !== outs[i - 1].req.K1) flips++;
  assert.ok(outs.some(o => o.reasons.includes('RATE_LIMIT_K1')));
  const ons = outs.filter((o, i) => i > 0 && o.req.K1 && !outs[i - 1].req.K1).length + (outs[0].req.K1 ? 1 : 0);
  assert.equal(ons, 4, 'số lần bật cưỡng bức=' + ons);
  assert.equal(outs.at(-1).req.K1, false, 'cuối cùng phải ở đúng lịch (tắt ban ngày)');
});

test('B6: sau 4 lần đóng cắt ban đêm, trả "Tự động" lúc 20:00 → K1 sáng ngay (không làm tối đường)', () => {
  const seq = []; let t = at(20, 0);
  for (let i = 0; i < 5; i++) { seq.push(baseIn(t, { overrides: { K1: { mode: i % 2 ? 'on' : 'off', until: t + 10 * MIN } } })); t += MIN; }
  seq.push(baseIn(t));
  const { outs } = run(seq);
  assert.equal(outs.at(-1).req.K1, true);
});

test('K3 tắt chưa đủ 15 phút thì không bật lại', () => {
  const sched = { ...SCHED, K3: { on: '22:00', off: '04:00' } };
  const { outs } = run([
    baseIn(at(22, 30), { schedule: sched }),
    baseIn(at(22, 31), { schedule: sched, overrides: { K3: { mode: 'off', until: at(22, 35) } } }),
    baseIn(at(22, 40), { schedule: sched }),   // mới tắt 9 phút
    baseIn(at(22, 47), { schedule: sched }),   // đủ 16 phút
  ]);
  assert.deepEqual(outs.map(o => o.req.K3), [true, false, false, true]);
  assert.ok(outs[2].reasons.includes('K3_COOLDOWN'));
});

test('khi REMOTE_EN = 0 thì req giữ nguyên giá trị cuối (PLC không dùng), không đếm chuyển', () => {
  const { outs } = run([baseIn(at(19, 52)), baseIn(at(19, 53), { maint: true })]);
  assert.equal(outs[1].remoteEn, false);
  assert.deepEqual(outs[1].req, outs[0].req);
});

test('cộng dồn phút K1 tắt cưỡng bức trong đêm (để chặn chuỗi lệnh nối tiếp)', () => {
  const ov = { K1: { mode: 'off', until: at(21, 0), setAt: at(20, 0) } };
  let st = S.initialState();
  for (let m = 0; m <= 30; m += 5) st = S.step(st, baseIn(at(20, m), { overrides: ov })).state;
  assert.ok(Math.abs(st.night.offMin - 30) < 0.01, 'offMin=' + st.night.offMin);
  const r = S.restore(S.serialize(st)); assert.equal(r.night.offMin, st.night.offMin);
});

test('dấu thời gian tương lai trong state bị bỏ ở bước kế tiếp', () => {
  const st = S.restore({ ...S.initialState(), k3OffSince: 9e15, maintAt: 9e15, flips: { K1: [9e15], K2: [], K3: [] } });
  const r = S.step(st, baseIn(at(22, 30)));
  assert.equal(r.state.k3OffSince, null); assert.equal(r.state.maintAt, null); assert.equal(r.state.flips.K1.length, 0);
  assert.equal(r.out.req.K3, true);
});

test('K3 cưỡng bức: bật ban ngày được nhưng vẫn qua khoá nguội 15′; tắt ban đêm cộng dồn vào giới hạn 2 h', () => {
  // K3 đang sáng 22:30, cưỡng bức tắt 5′ rồi cưỡng bức bật lại → phải chờ đủ 15′ kể từ lúc tắt
  let st = S.initialState();
  st = S.step(st, baseIn(at(22, 30), { plcQ: { K1: true, K2: true, K3: true } })).state;
  st = S.step(st, baseIn(at(22, 31), { overrides: { K3: { mode: 'off', until: at(22, 36), setAt: at(22, 31) } }, plcQ: { K1: true, K2: true, K3: true } })).state;
  let r = S.step(st, baseIn(at(22, 32), { overrides: { K3: { mode: 'off', until: at(22, 36), setAt: at(22, 31) } }, plcQ: { K1: true, K2: true, K3: false } }));
  st = r.state; assert.equal(r.out.req.K3, false);
  r = S.step(st, baseIn(at(22, 40), { overrides: { K3: { mode: 'on', until: at(23, 0), setAt: at(22, 40) } }, plcQ: { K1: true, K2: true, K3: false } }));
  assert.equal(r.out.req.K3, false); assert.ok(r.out.reasons.includes('K3_COOLDOWN'));
  r = S.step(r.state, baseIn(at(22, 48), { overrides: { K3: { mode: 'on', until: at(23, 0), setAt: at(22, 40) } }, plcQ: { K1: true, K2: true, K3: false } }));
  assert.equal(r.out.req.K3, true);
  // phút tắt cưỡng bức K3 trong lúc lịch K3 bật được cộng dồn
  let s2 = S.initialState();
  const ov = { K3: { mode: 'off', until: at(23, 30), setAt: at(22, 30) } };
  for (let m = 30; m <= 60; m += 5) s2 = S.step(s2, baseIn(at(22, m), { overrides: ov })).state;
  assert.ok(Math.abs(s2.night.offMin - 30) < 0.01, 'offMin=' + s2.night.offMin);
});
