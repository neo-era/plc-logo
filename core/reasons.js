'use strict';
/** Dịch mã lý do (gateway/server/lõi) sang tiếng Việt cho người vận hành. Không bao giờ trả mã thô. */
const TEXT = {
  MAINT: 'Tủ đang khoá tại tủ (LOCAL)',
  ELR_LOCK: 'Khoá ELR (rò điện) — không bật từ xa được, cử tổ trực kiểm tra tuyến',
  K3_COOLDOWN: 'Đèn HPS đang chờ nguội',
  NOT_DELIVERED: 'Lệnh không tới tủ', NOT_APPLIED: 'Lệnh không tới tủ',
  PLC_LINK_LOST: 'Gateway mất kết nối PLC', LINK_UNSTABLE: 'Kết nối gateway ↔ PLC chưa ổn định',
  NOTE_REQUIRED: 'Cần nhập lý do tắt ban đêm (≥ 5 ký tự)',
  RATE_LIMIT: 'Đã cưỡng bức 4 lần trong 1 giờ',
  K2_NEEDS_K1: 'K2 chỉ bật được khi K1 đang sáng',
  NIGHT_OFF_TOO_LONG: 'Tắt ban đêm tối đa 2 giờ', NIGHT_OFF_TOTAL_TOO_LONG: 'Đêm nay đã tắt cưỡng bức đủ 2 giờ',
  TOO_LONG: 'Cưỡng bức tối đa 12 giờ',
  REMOTE_NOT_OK: 'PLC chưa nhận quyền điều khiển từ xa', NOT_SYNCED: 'Gateway chưa đồng bộ giờ',
  CLOCK_SKEW: 'Giờ gateway / PLC / máy chủ lệch nhau quá 2 phút',
  NO_SCHEDULE: 'Gateway chưa có lịch từ xa',
  EXPIRED: 'Lệnh tới tủ quá muộn (> 30 s)', OVERRIDE_EXPIRED: 'Hạn cưỡng bức đã qua',
  ISSUED_IN_FUTURE: 'Giờ ra lệnh sai (lệch đồng hồ máy chủ)', BAD_EXPIRY: 'Hạn lệnh không hợp lệ',
  NO_FEEDBACK: 'Contactor không phản hồi', REPLAY: 'Lệnh trùng/cũ', DUPLICATE: 'Lệnh trùng — đã thực hiện trước đó',
  NO_STATION_ACCESS: 'Anh/chị không có quyền với tủ này', FORBIDDEN: 'Không đủ quyền', NOT_FOUND: 'Không tìm thấy tủ/lệnh',
  WRONG_STATION: 'Lệnh không đúng tủ',
  SCHEDULE_RATE_LIMIT: 'Đã sửa lịch 6 lần trong 1 giờ', NEEDS_CONFIRM: 'Lịch cần xác nhận kèm lý do', BAD_SCHEDULE: 'Giờ không hợp lệ',
  ON_EQ_OFF: 'Giờ bật trùng giờ tắt', BAD_TIME: 'Giờ không hợp lệ',
  LATE_ON: 'Bật muộn hơn hoàng hôn + 30 phút', EARLY_OFF: 'Tắt sớm trước bình minh − 30 phút',
  LATE_OFF: 'Tắt muộn hơn bình minh + 30 phút', NIGHT_GAP: 'Có khoảng tắt giữa đêm', DAY_ON: 'Sáng ban ngày',
  K2_ON_BEFORE_K1: 'K2 bật trước K1', K2_OFF_AFTER_K1: 'K2 tắt sau K1',
  BAD_COMMAND: 'Lệnh không hợp lệ', BAD_MINUTES: 'Thời hạn không hợp lệ', BAD_REQUEST: 'Yêu cầu không hợp lệ',
  BAD_INPUT: 'Dữ liệu gateway không hợp lệ', BAD_CTX: 'Gateway chưa đủ dữ liệu để nhận lệnh', BAD_SUN: 'Không tính được giờ mặt trời',
  BAD_STARS: 'Số sao không hợp lệ', EMPTY_FEEDBACK: 'Chấm sao hoặc nhập nội dung', FEEDBACK_RATE_LIMIT: 'Gửi góp ý quá nhiều — thử lại sau',
  BAD_STATION: 'Mã tủ không hợp lệ', CMD_FAILED: 'Lệnh thất bại',
  NETWORK: 'Mất mạng — thử lại', UNAUTHORIZED: 'Phiên đăng nhập hết hạn',
  NO_TOKEN: 'Chưa cấu hình kênh gửi tin', NO_ZALO: 'Chưa cấu hình Zalo',
};
const CIRC = /^(.*)_(K[123])$/;
function one(code, d) {
  if (typeof code !== 'string' || !code) return '';
  let c = code.trim(), circ = '';
  if (c.startsWith('OVERRIDE_STALE_')) return 'Lệnh cưỡng bức ' + c.slice(15) + ' đã bị huỷ';
  if (c.startsWith('OVERRIDE_')) c = c.slice(9);
  if (/^HTTP_\d+$/.test(c)) return 'Máy chủ báo lỗi (' + c.slice(5) + ')';
  const m = c.match(CIRC); if (m && TEXT[m[1]]) { c = m[1]; circ = m[2]; }
  if (c === 'K3_COOLDOWN' && d && d.minutes) return `Đèn HPS đang chờ nguội, còn ${d.minutes} phút`;
  const t = TEXT[c];
  return t ? (circ ? `${circ}: ${t}` : t) : 'Lỗi khác — xem nhật ký';
}
/** "A,B" hoặc mảng → câu tiếng Việt nối bằng "; ". */
function reasonText(r, d) {
  const list = Array.isArray(r) ? r : typeof r === 'string' ? r.split(/[,;]/) : [];
  return [...new Set(list.map(x => one(x, d)).filter(Boolean))].join('; ');
}
const STATUS = { issued: 'đã gửi', received: 'đã tới tủ', applied: 'đã áp', confirmed: 'contactor đã xác nhận', failed: 'thất bại',
  expired: 'hết hạn', rejected: 'bị từ chối', duplicate: 'trùng', pending: 'đang chờ' };
const statusText = s => STATUS[s] || (s ? 'không rõ' : '');
module.exports = { reasonText, statusText, TEXT };
