'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { sunTimes, HCM } = require('../sun');

// Giá trị tham chiếu TP.HCM (UTC+7), làm tròn phút — xem docs ghi nguồn.
// Nguồn: weather2travel.com (TP.HCM 11/2026), trek.zone (TP.HCM 07/2026).
const REF = [
  { d: [2026, 11, 1],  rise: '05:45', set: '17:29' },
  { d: [2026, 11, 15], rise: '05:49', set: '17:27' },
  { d: [2026, 11, 30], rise: '05:55', set: '17:28' },
  { d: [2026, 7, 9],   rise: '05:35', set: '18:21' },
];
const hm = s => { const [h, m] = s.split(':').map(Number); return h * 60 + m; };

for (const r of REF) {
  test(`mặt trời TP.HCM ${r.d.join('-')}`, () => {
    const t = sunTimes(r.d[0], r.d[1], r.d[2], HCM);
    assert.ok(Math.abs(t.sunrise - hm(r.rise)) <= 3, `mọc ${t.sunrise} vs ${hm(r.rise)}`);
    assert.ok(Math.abs(t.sunset - hm(r.set)) <= 3, `lặn ${t.sunset} vs ${hm(r.set)}`);
  });
}

test('đầu vào ngày sai → lỗi', () => {
  assert.throws(() => sunTimes(2026, 13, 1, HCM));
  assert.throws(() => sunTimes(2026, 2, 30, HCM));
});
