'use strict';
/**
 * Bản đồ địa chỉ Modbus TCP của LOGO! 8.4 — MỘT CHỖ DUY NHẤT để sửa sau khi thử tại tủ.
 * Nguồn: local-proxy/proxy.js (đã đọc/ghi thành công trên tủ LVC02 ngày 20/5/2026: Q, M, I, VW, RTC HR 492–495, ghi giờ FC15 coil 7880).
 * CẦN XÁC MINH TẠI TỦ: V-bit → coil = byte × 8 + bit (một số tài liệu nói lệch +1). Đổi OFFSET_V_COIL nếu lệch.
 */
const OFFSET_V_COIL = 0;

const map = {
  I: n => ({ fc: 'discrete', address: n - 1 }),           // I1 → DI 0 (chỉ đọc)
  Q: n => ({ fc: 'coil', address: 8192 + (n - 1) }),       // Q1 → coil 8192
  M: n => ({ fc: 'coil', address: 8256 + (n - 1) }),       // M1 → coil 8256
  V: (byte, bit) => ({ fc: 'coil', address: byte * 8 + bit + OFFSET_V_COIL }),   // V100.0 → coil 800
  VW: byte => ({ fc: 'holding', address: byte / 2 }),      // VW2 → HR 1
  RTC_HR: 492,          // VB984..991 → HR 492..495 (năm, tháng, ngày, giờ, phút, giây)
  RTC_WRITE_COIL: 7880, // FC15 5 byte Y/M/D/H/Mn (đã thử 20/5/2026)
};

/** Các điểm gateway dùng (theo thiết kế V4, mục 4.1). */
const POINTS = {
  HB: map.V(100, 0), REMOTE_EN: map.V(100, 1), K1_REQ: map.V(100, 2), K2_REQ: map.V(100, 3), K3_REQ: map.V(100, 4),
  NI1: map.V(0, 0), NI2: map.V(0, 1), NI3: map.V(0, 2),
  Q2: map.Q(2), Q3: map.Q(3), Q4: map.Q(4),
  I1: map.I(1), I2: map.I(2), I3: map.I(3), I4: map.I(4), I5: map.I(5), I6: map.I(6),
  M15: map.M(15), M16: map.M(16), M20: map.M(20), M21: map.M(21), M22: map.M(22), M23: map.M(23), M24: map.M(24),
  M32: map.M(32), M33: map.M(33), M34: map.M(34),
};

module.exports = { map, POINTS, OFFSET_V_COIL };
