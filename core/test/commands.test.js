'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../commands');

const NOW = 1_800_000_000_000;
const cmd = (o = {}) => ({ cmdId: 'c1', seq: 11, stationId: 'LVC02', kind: 'override', circuit: 'K1', mode: 'on',
  until: NOW + 3600e3, issuedAt: NOW - 1000, expiresAt: NOW + 29000, by: 'lam', ...o });
const ctx = (o = {}) => ({ now: NOW, stationId: 'LVC02', lastSeq: 10, timeSynced: true, maint: false, k1Requested: true, sun: { sunrise: 349, sunset: 1047 }, ...o });

test('lệnh hợp lệ → received', () => {
  const r = C.accept(cmd(), ctx());
  assert.equal(r.status, 'received'); assert.equal(r.newLastSeq, 11);
});

test('hết hạn / phát lại / sai tủ / chưa đồng bộ giờ / khoá tại tủ', () => {
  assert.equal(C.accept(cmd({ expiresAt: NOW - 1 }), ctx()).status, 'expired');
  let r = C.accept(cmd({ seq: 10 }), ctx()); assert.equal(r.status, 'rejected'); assert.equal(r.reason, 'REPLAY');
  r = C.accept(cmd({ seq: 5 }), ctx()); assert.equal(r.reason, 'REPLAY');
  r = C.accept(cmd({ stationId: 'LVC03' }), ctx()); assert.equal(r.reason, 'WRONG_STATION');
  r = C.accept(cmd(), ctx({ timeSynced: false })); assert.equal(r.reason, 'NOT_SYNCED');
  r = C.accept(cmd(), ctx({ maint: true })); assert.equal(r.reason, 'MAINT');
});

test('lệnh hỏng cấu trúc → rejected BAD_COMMAND (không ném lỗi)', () => {
  for (const bad of [null, {}, cmd({ circuit: 'K9' }), cmd({ mode: 'x' }), cmd({ seq: 'a' }), cmd({ expiresAt: undefined }), cmd({ kind: 'rm -rf' })]) {
    const r = C.accept(bad, ctx());
    assert.equal(r.status, 'rejected'); assert.equal(r.reason, 'BAD_COMMAND');
  }
});

test('hạn quá xa (> 60 s sau issuedAt) → rejected, chống server lỗi cấp hạn dài', () => {
  const r = C.accept(cmd({ expiresAt: NOW + 120e3 }), ctx());
  assert.equal(r.reason, 'BAD_EXPIRY');
});

test('bật K2 khi K1 không được yêu cầu → rejected chờ K1', () => {
  const r = C.accept(cmd({ circuit: 'K2' }), ctx({ k1Requested: false }));
  assert.equal(r.status, 'rejected'); assert.equal(r.reason, 'K2_NEEDS_K1');
  assert.equal(C.accept(cmd({ circuit: 'K2', mode: 'off' }), ctx({ k1Requested: false })).status, 'received');
});

test('lệnh "auto" xoá cưỡng bức', () => {
  assert.equal(C.accept(cmd({ mode: 'auto', until: undefined }), ctx()).status, 'received');
});

test('đánh giá đọc lại: confirmed / pending / failed', () => {
  // K1 bật: Q2 = 1 và phản hồi I5 = 1
  assert.equal(C.evaluate({ circuit: 'K1', want: true }, { Q: true, I: true }, 3000), 'confirmed');
  assert.equal(C.evaluate({ circuit: 'K1', want: true }, { Q: true, I: false }, 3000), 'pending');
  assert.equal(C.evaluate({ circuit: 'K1', want: true }, { Q: true, I: false }, 11000), 'failed');
  // K2 có liên động 30 s → cho tới 40 s
  assert.equal(C.evaluate({ circuit: 'K2', want: true }, { Q: false, I: false }, 20000), 'pending');
  assert.equal(C.evaluate({ circuit: 'K2', want: true }, { Q: true, I: true }, 35000), 'confirmed');
  assert.equal(C.evaluate({ circuit: 'K2', want: true }, { Q: false, I: false }, 41000), 'failed');
  // K3 không có phản hồi → chỉ xét Q
  assert.equal(C.evaluate({ circuit: 'K3', want: false }, { Q: false, I: null }, 2000), 'confirmed');
});

test('B7: từ chối khi khoá ELR (lệnh bật), khi REMOTE_OK = 0, khi đã hết 4 lượt cưỡng bức/giờ', () => {
  assert.equal(C.accept(cmd(), ctx({ elrLock: true })).reason, 'ELR_LOCK');
  assert.equal(C.accept(cmd({ mode: 'auto', until: undefined }), ctx({ elrLock: true })).status, 'received');
  assert.equal(C.accept(cmd(), ctx({ remoteOk: false })).reason, 'REMOTE_NOT_OK');
  assert.equal(C.accept(cmd(), ctx({ flipsLastHour: { K1: 4 } })).reason, 'RATE_LIMIT');
  assert.equal(C.accept(cmd({ mode: 'auto', until: undefined }), ctx({ flipsLastHour: { K1: 4 } })).status, 'received');
});

test('B7: gateway chạy lại validateOverride — K3 điều khiển được như K1/K2, tắt đêm > 2 h bị chặn, báo nhóm khi tắt đêm', () => {
  assert.equal(C.accept(cmd({ circuit: 'K3' }), ctx()).status, 'received');
  assert.equal(C.accept(cmd({ circuit: 'K3', until: NOW + 13 * 3600e3 }), ctx()).reason, 'OVERRIDE_TOO_LONG');
  const night = Date.UTC(2026, 10, 15, 13, 0);   // 20:00 VN
  const c = { issuedAt: night - 1000, expiresAt: night + 29000 };
  assert.equal(C.accept(cmd({ ...c, mode: 'off', until: night + 3 * 3600e3 }), ctx({ now: night })).reason, 'OVERRIDE_NIGHT_OFF_TOO_LONG');
  const ok = C.accept(cmd({ ...c, mode: 'off', until: night + 3600e3 }), ctx({ now: night }));
  assert.equal(ok.status, 'received'); assert.equal(ok.notifyGroup, true);
});

test('máy trạng thái lệnh: chỉ cho chuyển hợp lệ', () => {
  assert.equal(C.transition('new', 'received').ok, true);
  assert.equal(C.transition('received', 'applied').ok, true);
  assert.equal(C.transition('applied', 'confirmed').ok, true);
  assert.equal(C.transition('confirmed', 'failed').ok, false);
  assert.equal(C.transition('received', 'confirmed').ok, false);
  assert.equal(C.transition('expired', 'applied').ok, false);
});

test('phản hồi: K3 có tiếp điểm phụ (I4) thì phải khớp I', () => {
  const fb = { K1: true, K2: true, K3: true };
  assert.equal(C.evaluate({ circuit: 'K3', want: true }, { Q: true, I: false }, 3000, fb), 'pending');
  assert.equal(C.evaluate({ circuit: 'K3', want: true }, { Q: true, I: true }, 3000, fb), 'confirmed');
  assert.equal(C.evaluate({ circuit: 'K1', want: true }, null, 11000), 'failed');
});
