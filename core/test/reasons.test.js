'use strict';
const test = require('node:test'); const assert = require('node:assert');
const fs = require('node:fs'); const path = require('node:path');
const { reasonText, statusText } = require('../reasons');
const RAW = /[A-Z]+_[A-Z_]+|\b[A-Z]{4,}\b/;
// mọi mã viết hoa có gạch dưới trong lõi, gateway, server
const codes = new Set();
for (const f of ['core/commands.js', 'core/schedule.js', 'core/alerts.js', 'gateway/agent.js', 'server/src/service.js', 'server/src/app.js', 'server/src/broker.js']) {
  for (const m of fs.readFileSync(path.join(__dirname, '..', '..', f), 'utf8').matchAll(/'([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)'/g)) codes.add(m[1]);
}
for (const x of ['DATABASE_URL', 'JWT_SECRET', 'GATEWAY_KEY', 'ZALO_BOT_TOKEN']) codes.delete(x);    // biến môi trường
test('QA Chốt 2 v2: không mã lý do nào hiện thô, kể cả dạng ghép và theo mạch', () => {
  assert.ok(codes.size > 30, 'quét được mã: ' + codes.size);
  const all = [...codes, 'RATE_LIMIT_K1', 'RATE_LIMIT_K3', 'OVERRIDE_STALE_K2', 'OVERRIDE_NIGHT_OFF_TOO_LONG', 'HTTP_500', 'XYZ_LA_LAM'];
  for (const a of all) {
    assert.doesNotMatch(reasonText(a), RAW, a + ' → ' + reasonText(a));
    for (const b of all.slice(0, 12)) assert.doesNotMatch(reasonText(a + ',' + b), RAW, a + ',' + b);
  }
  assert.equal(reasonText('K3_COOLDOWN,LINK_UNSTABLE'), 'Đèn HPS đang chờ nguội; Kết nối gateway ↔ PLC chưa ổn định');
  assert.equal(reasonText('RATE_LIMIT_K1'), 'K1: Đã cưỡng bức 4 lần trong 1 giờ');
  assert.equal(reasonText('K3_COOLDOWN', { minutes: 7 }), 'Đèn HPS đang chờ nguội, còn 7 phút');
  assert.equal(reasonText('BLAH'), 'Lỗi khác — xem nhật ký');
  assert.equal(reasonText(''), ''); assert.equal(reasonText(null), '');
  for (const s of ['issued', 'received', 'applied', 'confirmed', 'failed', 'expired', 'rejected', 'duplicate']) assert.doesNotMatch(statusText(s), /[a-z]{5,}d\b/);
});
