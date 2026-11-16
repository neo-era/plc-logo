'use strict';
/**
 * Giờ mặt trời mọc/lặn (thuật toán NOAA rút gọn, độ cao −0,833°).
 * Trả phút trong ngày theo giờ địa phương (tz giờ). Không I/O.
 */
const HCM = { lat: 10.7769, lon: 106.7009, tz: 7 };

const rad = d => d * Math.PI / 180;
const deg = r => r * 180 / Math.PI;

function dayOfYear(y, m, d) {
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d) || m < 1 || m > 12 || d < 1) {
    throw new RangeError('Ngày không hợp lệ');
  }
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) throw new RangeError('Ngày không hợp lệ');
  return Math.round((dt - Date.UTC(y, 0, 1)) / 864e5) + 1;
}

function sunTimes(y, m, d, loc = HCM) {
  const n = dayOfYear(y, m, d);
  const g = 2 * Math.PI / 365 * (n - 1);           // phân số năm tại 0h
  const eqt = 229.18 * (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g)
    - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));
  const decl = 0.006918 - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g)
    - 0.006758 * Math.cos(2 * g) + 0.000907 * Math.sin(2 * g)
    - 0.002697 * Math.cos(3 * g) + 0.00148 * Math.sin(3 * g);
  const cosH = (Math.cos(rad(90.833)) / (Math.cos(rad(loc.lat)) * Math.cos(decl))) - Math.tan(rad(loc.lat)) * Math.tan(decl);
  const ha = deg(Math.acos(Math.min(1, Math.max(-1, cosH))));
  const noonUtc = 720 - 4 * loc.lon - eqt;          // phút UTC
  const sunrise = Math.round(noonUtc - 4 * ha + loc.tz * 60);
  const sunset = Math.round(noonUtc + 4 * ha + loc.tz * 60);
  return { sunrise, sunset };
}

module.exports = { sunTimes, HCM, dayOfYear };
