'use strict';
/** Đóng gói lõi đã test (core/sun.js, core/schedule.js, core/reasons.js) thành dieu-khien/core.bundle.js cho trình duyệt — lõi chạy = lõi đã test. */
const fs = require('node:fs'); const path = require('node:path');
const root = path.join(__dirname, '..');
const mods = ['sun', 'schedule', 'reasons'];
let out = '/* Tự sinh bởi scripts/build-web.js — KHÔNG sửa tay */\n(function(){\nconst __m = {};\nfunction require(p){ return __m[p.replace(/^\\.\\//, "")]; }\n';
for (const m of mods) {
  const src = fs.readFileSync(path.join(root, 'core', m + '.js'), 'utf8');
  out += `__m["${m}"] = (function(){ const module = { exports: {} }; const exports = module.exports;\n${src}\nreturn module.exports; })();\n`;
}
out += 'window.PLCCore = { sun: __m.sun, schedule: __m.schedule, reasons: __m.reasons };\n})();\n';
fs.writeFileSync(path.join(root, 'dieu-khien', 'core.bundle.js'), out);
console.log('built dieu-khien/core.bundle.js', out.length, 'bytes');
// gắn mã bản dựng vào index.html và sw.js (đổi cache mỗi lần build)
const build = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
for (const f of ['index.html', 'sw.js']) {
  const p = path.join(root, 'dieu-khien', f);
  fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace(/__BUILD__|\d{12}(?=['"])/g, m => (m === '__BUILD__' || /^\d{12}$/.test(m) ? build : m)));
}
console.log('build', build);
