# Điều khiển tủ chiếu sáng LOGO! qua Internet bằng SIM 4G — Thiết kế

Phiên bản thiết kế: 0.2 (15/11/2026) — đã qua Chốt 1 (duyệt có điều kiện, đã áp thay đổi bắt buộc — xem mục 8)
Sản phẩm: mở rộng app `neo-era.github.io/plc-logo` + bộ 4G lắp tại tủ + dịch vụ `plc` trên LAVIPCO Server.

## 0. Đã chốt với anh Lâm
| Câu hỏi | Chốt |
|---|---|
| Thiết bị 4G tại tủ | Em thiết kế trọn bộ (mục 3) |
| Máy chủ trung tâm | LAVIPCO Server tại văn phòng (Ubuntu + Docker, IP tĩnh, chỉ mở 80/443) |
| Chức năng v1 | Bật/tắt cưỡng bức K1/K2/K3 (K3 thêm 16/11/2026) · xem trạng thái trực tiếp · chỉnh giờ bật/tắt & đồng hồ · cảnh báo Zalo |
| Sửa chương trình LOGO! | Được sửa (em lập bản sửa + hướng dẫn nạp) |
| Quy mô | 1 tủ thí điểm **LVC02** (LOGO! 230RCE 6ED1052-1FB08-0BA2 = LOGO! 8.4, IP 192.168.0.3, chương trình NisseLOGOProgram_V2-ELR); thiết kế sẵn cho nhiều tủ |
| Cảnh báo Zalo | Zalo Bot chính thức (bot.zapps.me) — gửi **cả nhóm trực + tin riêng** người phụ trách; không dùng đăng nhập Zalo web bằng cookie |

## 1. Bước 0 — Tiêu chí "chạy đúng"

### 1.1 Đầu vào → đầu ra
- Người vận hành mở app (PWA, điện thoại/máy tính, ở bất cứ đâu có Internet) → đăng nhập tài khoản LAVIPCO Server → thấy tủ LVC02: online/offline, K1/K2/K3 (lệnh Q và phản hồi I5/I6), chế độ đang chạy (Lịch từ xa / Lịch tại tủ / Cưỡng bức), giờ PLC, giờ bật/tắt hiện hành, lần cập nhật cuối.
- Bấm **Bật cưỡng bức / Tắt cưỡng bức / Trả về tự động** cho K1, K2 (xác nhận 2 bước, chọn thời hạn) → tủ thực hiện, app hiện kết quả theo phản hồi thật từ contactor.
- Sửa **giờ bật/tắt** K1, K2, K3 → tủ chạy theo giờ mới từ tối đó, không cần ra tủ.
- **Đồng hồ PLC** luôn đúng giờ Việt Nam (tự đồng bộ); app có nút đồng bộ ngay và hiện độ lệch.
- Sự cố → tin Zalo tới nhóm trực + người phụ trách trong ≤ 2 phút, có tin báo khi đã hồi phục.

### 1.2 Tiêu chí đạt (đo được)
| # | Tiêu chí | Ngưỡng |
|---|---|---|
| T1 | Trạng thái tủ hiện trên app | p95 trễ ≤ 5 s khi có thay đổi (đo N = 50 lần đổi trạng thái); làm mới ≤ 60 s khi không đổi |
| T2a | Lệnh tới tủ | p95 ≤ 5 s (N = 50 lệnh, 4G bình thường); lệnh quá `expiresAt` (server cấp, 30 s) → **hết hạn, không thực hiện muộn** |
| T2b | Xác nhận contactor | K1, K3 ≤ 10 s; K2 ≤ 40 s (liên động 30 s); app báo **Đã xác nhận** chỉ khi đọc lại đúng Q và phản hồi I khớp. Trạng thái lệnh: `received → applied → confirmed / failed / expired / rejected` |
| T3 | Mất 4G / server / gateway | đèn **vẫn chạy theo lịch tại tủ**; PLC tự về lịch tại tủ sau ≤ 3 phút mất nhịp tim. "Không bật/tắt sai" khi chuyển tầng = trạng thái sau chuyển **bằng** lịch tại tủ tại thời điểm đó; nếu lịch từ xa và lịch tại tủ lệch > 15 phút thì app nhắc + cảnh báo "lệch lịch". Quay lại tầng từ xa chỉ khi nhịp tim ổn định ≥ 60 s |
| T4 | Liên động K1 → K2 | giữ nguyên: K2 chỉ đóng khi K1 đã đóng ≥ 30 s, K2 cắt theo K1 — **trong mọi chế độ**; lệnh bật K2 khi K1 đang tắt → `rejected: chờ K1` |
| T5 | Lịch bật/tắt từ xa | đúng phút (sai số ≤ 1 phút), hiểu khoảng qua đêm; từ chối giờ không hợp lệ; lịch/lệnh làm **đèn tắt quá 30 phút sau hoàng hôn hoặc sáng quá 30 phút sau bình minh** (giờ mặt trời TP.HCM) cần xác nhận kèm lý do |
| T6 | Đồng hồ PLC | lệch ≤ 90 s so với giờ VN; NTP của LOGO! là chính, FC15 chỉ dự phòng; mất giờ (năm < 2025) → cảnh báo; giờ gateway / RTC PLC / server lệch nhau > 2 phút → REMOTE_EN = 0 |
| T7 | Cảnh báo Zalo | ≤ 2 phút **tính từ lúc luật cảnh báo kích hoạt** (sau trễ của luật; vd offline: trễ 5 phút → tin tới tối đa 7 phút sau khi mất kết nối); ≤ 1 tin/sự cố/30 phút; có tin hồi phục; kênh Zalo lỗi → cảnh báo trên app + email dự phòng |
| T8 | Bảo mật | không mở cổng vào tại tủ; mọi kết nối TLS; khoá gateway ≥ 128 bit, thu hồi ngắt phiên ≤ 10 s; chỉ vai trò `editor` của app plc **được gán cho đúng tủ** mới ra lệnh; nhật ký sự kiện lệnh append-only (REVOKE UPDATE/DELETE/TRUNCATE + trigger chặn); chống phát lại lệnh |
| T9 | Dữ liệu 4G | ≤ 300 MB/tháng/tủ, đo bằng bộ đếm data của router trong 7 ngày × 30/7 |
| T10 | App | PWA cài được desktop + mobile, dọc + ngang, sáng/tối, có kênh góp ý & đánh giá, nút quay lại mọi trang phụ |
| T11 | An toàn | công tắc khoá **LOCAL/REMOTE** tại tủ: ở LOCAL → REMOTE_OK = 0, huỷ mọi lệnh cưỡng bức, app hiện "Đang khoá tại tủ"; tắt cưỡng bức ban đêm tối đa 2 giờ và báo nhóm Zalo ngay; mỗi mạch ≤ 4 lần **cưỡng bức đi xa lịch**/giờ (trả về lịch luôn được phép, không bao giờ làm tối đường → trần đóng cắt vật lý ≤ 8 lần/giờ + chuyển theo lịch); tắt cưỡng bức ban đêm **cộng dồn** ≤ 2 giờ/đêm (tính mọi phút có ít nhất một mạch bị tắt cưỡng bức trong lúc lịch của nó đang bật); sửa lịch từ xa ≤ 6 lần/giờ/tủ (API); K3 (HPS) tắt ≥ 15 phút mới được bật lại |
| T12 | Chạy thử liên tục | 72 giờ trên bộ mô phỏng + tủ thật, có kịch bản rút anten, tắt server, kill gateway, mất nguồn tủ — không lần nào bật/tắt sai theo định nghĩa T3 |

### 1.3 Ca biên / ca xấu phải chịu được
- 4G chập chờn: lệnh gửi 2 lần (trùng `cmdId`) → chỉ thực hiện 1 lần; lệnh tới muộn > 30 s → bỏ.
- Gateway mất điện/treo giữa lúc đang cưỡng bức → PLC tự về lịch tại tủ sau ≤ 3 phút (watchdog trong PLC).
- Server mất → gateway vẫn chạy lịch từ xa đã lưu (bộ nhớ đệm) và nhịp tim; khi gateway cũng mất → PLC về lịch tại tủ.
- Giờ bật = giờ tắt; giờ ngoài 00:00–23:59; giờ tắt K2 > giờ tắt K1 → từ chối hoặc cảnh báo theo quy tắc K1–K2.
- Q2 = 1 nhưng I5 = 0 quá 60 s → "Contactor K1 không đóng / mất điện lưới" (cảnh báo, không tự sửa).
- Đồng hồ PLC về 2020-01-01 (mất pin/mất nguồn lâu) → cảnh báo + đồng bộ.
- Hai người cùng ra lệnh trái nhau → lệnh sau thắng, cả hai ghi nhật ký, app người kia cập nhật ngay.
- Đang có người sửa chữa tại tủ: **thao tác cưỡng bức từ xa KHÔNG thay cho cô lập điện** — quy trình an toàn phải cắt CB/MCCB tại tủ (ghi rõ trong app và hướng dẫn).

### 1.4 Ngoài phạm vi v1
- Nhiều tủ cùng lúc trên bản đồ (thiết kế sẵn; giao diện danh sách đơn giản).
- Đo dòng/điện năng (cần thêm biến dòng + module analog).
- Nạp chương trình LOGO! từ xa qua 4G (có thể dùng VPN của router — để ngỏ, tắt mặc định).

## 2. Kiến trúc

```
TẠI TỦ LVC02                                                 VĂN PHÒNG LAVIPCO                       NGƯỜI DÙNG
┌──────────────┐ Modbus TCP ┌─────────────┐ LAN ┌──────────┐  4G   ┌──────────────────────────────┐ HTTPS ┌──────────┐
│ LOGO! 8.4    │◄──────────►│ Gateway     │◄───►│ Router 4G│◄─────►│ Caddy :443                    │◄─────►│ PWA      │
│ 192.168.0.3  │            │ 192.168.0.10│     │ .0.1     │ MQTT  │  /mqtt (WSS) → broker         │  WSS  │ plc-logo │
│ NTP client ──┼── NTP ─────┼─────────────┼────►│ NTP srv  │ /WSS  │  /plc/*      → dịch vụ plc    │       └──────────┘
└──────────────┘            └─────────────┘     └──────────┘ :443  │  /auth/*     → core (sẵn có)  │
                                                                  │ plc: broker MQTT + API + cảnh │──► Zalo Bot API
                                                                  │ báo + Postgres (schema plc)   │
                                                                  └──────────────────────────────┘
```
- Tủ chỉ **kết nối ra** (outbound) → không mở cổng nào tại tủ; SIM không cần IP tĩnh.
- Gateway nối server bằng **MQTT qua WebSocket TLS trên cổng 443** (`wss://<domain>/mqtt`) → giữ nguyên chính sách LAVIPCO Server chỉ mở 80/443.
- Đăng nhập app dùng **core auth** của LAVIPCO Server (JWT), app `plc` với vai trò `viewer` (xem) / `editor` = operator (ra lệnh, sửa lịch) / `admin` (thêm tủ, cấp khoá gateway, cấu hình cảnh báo).
- Phụ thuộc: LAVIPCO Server phải chạy được với tên miền HTTPS. Nếu chưa sẵn sàng khi thí điểm → chạy tạm dịch vụ `plc` độc lập bằng `docker compose` có Caddy riêng (cùng mã), chuyển sang sau.

### 2.1 Phân tầng quyết định (an toàn khi mất kết nối)
| Tầng | Ai quyết định K1/K2/K3 | Khi nào |
|---|---|---|
| 1. Cưỡng bức | lệnh người vận hành (có hạn: mặc định 60 phút ban đêm / 15 phút ban ngày, tối đa 12 giờ; tắt ban đêm tối đa 2 giờ) | đang trong hạn, REMOTE_OK = 1 |
| 2. Lịch từ xa | gateway tính theo giờ chuẩn NTP + lịch lưu trên server (đệm tại gateway) | nhịp tim còn, `REMOTE_EN = 1` |
| 3. Lịch tại tủ | khối hẹn giờ T001/T002/T006 trong PLC | mất nhịp tim > 3 phút, `REMOTE_EN = 0`, hoặc công tắc tại tủ ở LOCAL |
| (Tay tại tủ) | công tắc I2 / NI1–NI3 như chương trình hiện tại | giữ nguyên, đứng sau bộ chọn tầng |
Liên động K1→K2 30 s và logic ELR nằm **sau** bộ chọn tầng, nên luôn có hiệu lực.

Khi anh sửa lịch từ xa, server cũng ghi giờ mới vào hồ sơ tủ để lần sau ra tủ cập nhật T001/T002/T006 cho khớp (app nhắc "lịch tại tủ khác lịch từ xa").

## 3. Bộ 4G tại tủ (thiết kế phần cứng, giá tham khảo — kiểm báo giá thực tế khi mua)

### 3.1 Bước khảo sát trước khi mua gateway (bắt buộc)
Raspberry Pi 4 chỉ chịu môi trường **0–50 °C** (product brief RP-008344-DS-2); tủ thép ngoài trời TP.HCM có thể vượt. Vì vậy:
1. Lắp **router RUT241 trước** (chịu −40…+75 °C), đặt 1 cảm biến nhiệt + đọc nhiệt độ router, **ghi nhiệt độ trong tủ 7 ngày** (gồm giờ nắng gắt). Đồng thời đo luôn sóng 4G và lượng data.
2. Nhiệt độ lớn nhất trong tủ **≤ 45 °C** → dùng **Phương án A** (Pi 4). **> 45 °C** → **Phương án B** (gateway công nghiệp).

### 3.2 Danh mục
| # | Thiết bị | Đề xuất | Vai trò | Giá tham khảo |
|---|---|---|---|---|
| 1 | Router 4G công nghiệp | Teltonika **RUT241** (LTE Cat 4, 2 cổng Ethernet, 9–30 VDC, −40…+75 °C, Ping Reboot, giới hạn data) | Internet 4G + LAN; NTP cho LOGO! (**phải thử** tính năng NTP server của RutOS; nếu không có thì gateway làm NTP server cho LAN) | 2,5–3,5 tr |
| 2 | Anten 4G ngoài tủ | Anten 4G MIMO ×2 gắn vỏ tủ, cáp 3 m, SMA | Vỏ thép chặn sóng | 0,3–0,6 tr |
| 3 | Chống sét anten | Chống sét đồng trục (SMA/N), nối đất về **PE của tủ** | Sét lan theo cáp anten | 0,4–0,8 tr |
| 4A | Gateway — Phương án A | **Raspberry Pi 4 (2 GB)** + vỏ nhôm tản nhiệt DIN + thẻ nhớ công nghiệp 16 GB, hệ điều hành **chỉ đọc (overlayfs)**, watchdog phần cứng + systemd `WatchdogSec`, cảnh báo nhiệt độ CPU > 75 °C | Chạy gateway | 1,8–2,5 tr |
| 4B | Gateway — Phương án B | Máy tính công nghiệp ARM chạy Debian, **chịu ≥ 70 °C**, eMMC, 2 cổng Ethernet, nguồn 9–48 VDC (ứng viên cần kiểm datasheet khi chọn: Moxa UC-1200A series, Advantech ECU/UNO dòng ARM) | Chạy cùng phần mềm gateway | 6–12 tr |
| 5 | Nguồn 24 VDC | Mean Well **HDR-30-24** (DIN, −30…+70 °C) | Router (+ gateway B) | 0,3 tr |
| 6 | Nguồn 5 VDC (chỉ phương án A) | Mean Well DC-DC DIN **5 V ≥ 5 A** hoặc DDR-15G-5 chỉnh lên **5,1–5,2 V** | Pi 4 cần ≥ 3 A | 0,35–0,6 tr |
| 7 | UPS DC (nên có) | Mean Well **DRC-40A** + ắc quy 12 V 7 Ah, giữ router + gateway ≥ 30 phút | Phân biệt "mất điện lưới" với "mất 4G" và kịp gửi cảnh báo | 1,2–1,8 tr |
| 8 | Bảo vệ | MCB 1P 2 A + SPD Type 2 cho mạch nguồn thiết bị, phối hợp với SPD đầu vào tủ | Sét, quá dòng | 0,5–0,8 tr |
| 9 | **Công tắc khoá LOCAL/REMOTE** (bắt buộc) | Công tắc chìa khoá 2 vị trí 230 VAC, nối vào 1 ngõ vào LOGO! còn trống (xác minh từ file .lsc) | Người sửa chữa khoá điều khiển từ xa | 0,2–0,4 tr |
| 10 | Tiếp điểm phụ K3 (nên có) | Tiếp điểm phụ gắn contactor K3 → 1 ngõ vào còn trống | Phản hồi K3 (hiện chưa có) | 0,1–0,2 tr |
| 11 | Switch mini (tuỳ chọn) | Switch công nghiệp 5 cổng DIN | Cắm laptop bảo trì | 0,5 tr |
| 12 | SIM | SIM data doanh nghiệp/IoT, gói ≥ 1 GB/tháng | Đường truyền | ~30–50k/tháng |
| 13 | Phụ kiện | Ray DIN, Cat5e bọc chống nhiễu, cos, nhãn | | 0,2 tr |
**Cộng: ~8–11 triệu/tủ (phương án A, có UPS); ~13–20 triệu/tủ (phương án B)**, chưa công lắp.
Khi nhân rộng có thể bỏ gateway, dùng **Modbus MQTT Gateway** có sẵn của RUT241 — đổi lại mất bộ đệm lịch từ xa khi mất 4G và phần lõi đã kiểm thử; quyết định sau thí điểm.

**Mạng LAN tủ:** 192.168.0.0/24 — Router .1, LOGO! .3 (giữ nguyên), Gateway .10. Router chặn mọi truy cập từ 4G vào LAN, không chuyển cổng 502/102; quản trị từ xa (RMS/VPN) tắt mặc định. Tắt cập nhật tự động hệ điều hành qua 4G; bật giới hạn data trên router.

**Đấu nguồn:** lấy từ thanh cái **trước** contactor (nguồn thường trực), qua MCB 2 A + SPD → UPS DC / HDR-30-24 → router, gateway. Không lấy sau contactor.

## 4. Sửa chương trình LOGO! → NisseLOGOProgram_V4-4G

### 4.0 Chương trình hiện tại (bản in Soft Comfort anh gửi 15/11/2026, dạng LAD; tên trong khung tên bản in là NisseLOGOProgram_V2-ELR.lld, file gửi kèm tên V3-ELR.lsc — cần anh xác nhận bản nào đang nạp ở tủ)
| Thành phần | Nội dung |
|---|---|
| Mạng | IP 192.168.0.3/24, GW 192.168.0.1; Modbus server cổng 502, *Accept all connection requests* |
| Ngõ vào dùng | I1 = ELR (rơ-le chống dòng rò), I2 = SW (công tắc tay), I5 = phản hồi K1, I6 = phản hồi K2. **Còn trống: I3, I4, I7, I8** |
| Ngõ ra | Q2 = K1, Q3 = K2, Q4 = K3 (HPS) |
| Cờ M dùng | M2 (yêu cầu K1), M3 (yêu cầu K2), M4 = M2·I5, M5 = M3·I6, M6 = M4·M5 (cả 2 nhánh đã đóng & có phản hồi), M10 (thông báo SF007), M15 (ELR tác động). **Còn trống: M1, M7, M9, M11–M14, M16–M24, M32–M64** (M8 = cờ khởi động; M25–M31 = cờ hệ thống đèn nền/bộ ký tự — **không dùng**) |
| NI | NI1 = V0.0 (bật cưỡng bức 15′ qua T005), NI2 = V0.1 (tiếp điểm thường đóng: 1 = cấm K1), NI3 = V0.2 (1 = cấm K2) |
| Parameter VM mapping | VW2/4 T001 On/Off · VW6/8 T002 On/Off · VW10/12/14 T004 · VW16/18/20 T005 · VW22/24 T006 On/Off. **VB100 trở lên còn trống** |
| Khối | T001 B1 17:45–05:45 · T002 B2 17:46–05:45 · T006 HPS 22:00–04:00 (tuần, cả tuần) · T003 trễ 30 s (Trg = T001) · T004 tay 15′ (Trg = I2) · T005 cưỡng bức 15′ (Trg = NI1) · T008 ELR 15 s · C009 đếm ELR (On = 3, R = ¬T001·¬C011) · C011 đếm tổng ELR · SF007 màn hình. Rất xa giới hạn 400 khối |

Logic hiện tại:
- `M2 = [T001 + I2·¬T001·¬T004 + NI1·¬T001·¬T005] · ¬NI2`
- `M3 = [T002·T003 + I2·¬T002·¬T004 + NI1·¬T002·¬T005] · ¬NI3`
- `Q2 = ¬M15·¬C009·M2`, `Q3 = ¬M15·¬C009·M3`, `Q4 = T006`
- ELR: I1 → M15 tự giữ đến khi T008 (15 s) cắt; mỗi lần M15 lên C009 đếm; **đủ 3 lần → khoá K1/K2** đến khi lịch K1 tắt (sáng hôm sau).

**Phát hiện cần biết:**
1. **Liên động 30 s chỉ có ở nhánh lịch** (T003 kích từ T001). Nhánh tay I2 và nhánh NI1 đóng K2 **cùng lúc** K1, không qua 30 s và không cần K1. → Bản V4 đưa liên động áp cho mọi nhánh (đúng tiêu chí T4).
2. **K3 (Q4) hiện không bị khoá ELR** và không có phản hồi → anh chốt: **V4 cho K3 bị khoá ELR như K1/K2**; thêm tiếp điểm phụ K3 vào I4.
3. M6 không phải "chế độ tay" (sửa lại so với thiết kế v0.2): M6 = cả hai nhánh đã đóng và có phản hồi.
4. Khoá ELR (C009) là **an toàn điện**: lệnh từ xa **không được** gỡ khoá này; V4 đổi reset thành `¬T001·¬M2·¬M3·¬M23·¬C011` (chỉ gỡ ban ngày khi không còn mạch nào được yêu cầu bật — xem 4.2 bước 6). App chỉ hiển thị "Khoá ELR — kiểm tra rò điện tại tủ".

### 4.1 Ánh xạ mới (đã đối chiếu vùng trống)
| Địa chỉ | Kiểu | Hướng | Ý nghĩa |
|---|---|---|---|
| V100.0 | NI4 | gateway → PLC | **HB** nhịp tim, đảo mỗi 10 s |
| V100.1 | NI5 | gateway → PLC | **REMOTE_EN** |
| V100.2 / .3 / .4 | NI6 / NI7 / NI8 | gateway → PLC | **K1_REQ / K2_REQ / K3_REQ** |
| I3 | DI | công tắc khoá | **MAINT** (LOCAL = 1) — đấu dây mới |
| I4 | DI | tiếp điểm phụ K3 | phản hồi K3 — đấu dây mới (nên có) |
| M20 | cờ | PLC → gateway | **REMOTE_OK** |
| M21 / M22 / M23 | cờ | PLC → gateway | `K1_DEM` / `K2_DEM` / `K3_DEM` (yêu cầu sau bộ chọn) |
| M24 | cờ | PLC → gateway | HB_ALIVE |
| M16 | cờ | PLC → gateway | **Khoá ELR** = C009 |
| M32 / M33 / M34 | cờ | PLC → gateway | Trạng thái lịch tại tủ T001 / T002 / T006 |
| đọc sẵn | | | Q2/Q3/Q4, I1, I2, I3, I4, I5, I6, M2–M6, M15 |
| VB984–990 | | đọc; ghi FC15 coil 7880 (dự phòng) | Đồng hồ PLC |

### 4.2 Sửa LAD
1. **Watchdog (không cần khối bắt sườn):** T010 Off-delay 180 s kích bằng `HB`, T011 Off-delay 180 s kích bằng `¬HB`; `M24 HB_ALIVE = T010·T011` → HB kẹt 0 hoặc kẹt 1 đều làm M24 = 0 sau ≤ 180 s. **T010/T011 đặt Rem = off** (sau cấp nguồn M24 = 0 cho đến khi HB đảo thật). T012 cũng Rem = off: cúp nguồn PLC thì mất thời gian nguội K3 còn lại — chấp nhận vì đèn đã tắt trong lúc mất điện.
2. `M20 REMOTE_OK = NI5 · M24 · ¬I3`.
3. Bộ chọn: `M21 = NI6·M20 + T001·¬M20`; `M23 = NI8·M20 + T006·¬M20`; `M22 = NI7·M20 + T002·¬M20`.
4. T003 (30 s) **kích bằng Q2** (lệnh ra cuộn hút K1) thay vì T001 → liên động áp cho mọi tầng. (Dùng Q2 chứ không dùng I5 để khi K1 hỏng tiếp điểm, K2 vẫn sáng được.)
5. Thay ở các rung: `M2 = [M21 + I2·¬M21·¬T004 + NI1·¬I3·¬M21·¬T005] · ¬NI2`; `M3 = [M22·T003 + (I2·¬M22·¬T004 + NI1·¬I3·¬M22·¬T005)·T003] · ¬NI3` (**NI1 bị chặn khi khoá LOCAL**); `Q4 = ¬M15·¬C009·M23` — **K3 cũng bị khoá ELR** (anh Lâm chốt 15/11/2026).
6. Q2/Q3/Q4 qua ¬M15·¬C009. **Reset C009 đổi thành `¬T001·¬M2·¬M3·¬M23·¬C011`** — chỉ gỡ khoá ELR ban ngày khi không còn mạch nào được yêu cầu bật (lịch từ xa hay cưỡng bức không gỡ được khoá). C009 đặt **Rem = on** để cúp nguồn PLC không xoá khoá. Không cho ghi giờ T001 (VW2/VW4) qua Modbus khi chưa đánh giá lại điều kiện gỡ khoá này.
7. `M16 = C009`; `M32/M33/M34 = T001/T002/T006`; dòng màn hình `4G: REMOTE / LOCAL / KHOA`.
8. **K3 nguội trong PLC:** T012 Off-delay 15′ kích bằng Q4; `M35 = T012·¬Q4` (vừa tắt chưa đủ 15′); `Q4 = ¬M15·¬C009·M23·¬M35`. **Áp dụng** — anh Lâm xác nhận 16/11/2026: K3 là mạch đèn riêng giống K1, K2 (không phải contactor chuyển nấc công suất).
9. Hệ quả: vì K2 cần K1 đóng 30 s, **NI2 (cấm K1) nay cấm luôn K2** — khác chương trình cũ; **anh Lâm đồng ý 16/11/2026**.

### 4.3 Cấu hình & thử
- Modbus server: **bỏ *Accept all*, chỉ nhận kết nối từ 192.168.0.10** (gateway); thử từ máy IP khác phải bị từ chối. **NTP client** → 192.168.0.1 (hoặc gateway .10), UTC+7 — đồng bộ giờ chính.
- **[TREO — chưa làm ở v1]** Ghi Modbus vào VW2/VW4 (giờ T001) để cập nhật lịch tại tủ từ xa: cấm theo 4.2 bước 6 vì T001 quyết định thời điểm gỡ khoá ELR; chỉ xem xét lại ở v1.1 sau khi đánh giá an toàn.
- Phiếu thử: HB kẹt 0/1, rút gateway, PLC mất điện, I3 = LOCAL, **I3 = LOCAL + ghi V0.0 = 1 → K1 không đổi**, ELR tác động 3 lần (khoá giữ dù có lệnh từ xa), **khoá ELR + lịch từ xa còn bật sau 05:45 → vẫn khoá**, **cúp nguồn PLC → M24 = 0 cho đến khi HB đảo**, **ELR tác động 1 lần lúc 22:30 → K1/K2 đóng lại sau ~15 s, K3 không đóng lại trước 15′**, cúp nguồn PLC khi đang khoá ELR → vẫn khoá, K3 tắt rồi bật lại trong 15′ → bị chặn, liên động 30 s ở tầng từ xa/tay/NI1, thứ trong tuần sau ghi giờ, **địa chỉ coil Modbus thật của V100.x / VB984 (đọc bảng mapping trong Soft Comfort, có tài liệu cho rằng lệch +1)**.

## 5. Phần mềm

### 5.1 Gateway (Node 20, lõi thuần + phần I/O)
- Vòng đọc 2 s; đẩy MQTT khi có thay đổi + định kỳ 60 s; keepalive 30 s.
- Nhịp tim HB 10 s; mỗi 10 s tính tầng bằng lõi thuần `core/schedule.js` → ghi K*_REQ, REMOTE_EN.
- **REMOTE_EN = 0** khi: giờ hệ thống chưa NTP-sync; giờ gateway – RTC PLC – server lệch > 2 phút; nhịp tim/kết nối PLC chưa ổn định đủ 60 s sau khi khôi phục; MAINT = 1.
- **Lệnh:** `{cmdId, seq, stationId, kind, circuit, mode, until, issuedAt, expiresAt, by}`. Gateway từ chối khi chưa NTP-sync, khi `now > expiresAt`, khi `seq ≤ lastSeq` (lastSeq lưu bền, ghi nguyên tử) — chống phát lại kể cả sau khởi động lại. MQTT: `cmd` QoS 1, không retain, clean session.
- Máy trạng thái lệnh `received → applied → confirmed/failed/expired/rejected`, gửi ACK từng bước; đọc lại sau 3 s và 35 s (K2).
- Giới hạn an toàn trong lõi: ≤ 4 lần chuyển/mạch/giờ; K3 tắt ≥ 15 phút mới bật lại; tắt cưỡng bức ban đêm ≤ 2 giờ; hạn cưỡng bức mặc định 60 phút (ban đêm), 15 phút (ban ngày), tối đa 12 giờ.
- Giờ mặt trời mọc/lặn TP.HCM tính trong lõi (`core/sun.js`, công thức NOAA, kiểm với bảng chuẩn).
- Đồng bộ đồng hồ PLC dự phòng bằng FC15: chỉ khi lệch > 90 s **và** NTP của LOGO! không chạy, chỉ ghi khi giây ∈ [2, 50], ≤ 1 lần/30 phút.
- Đệm lịch + lệnh còn hạn + lastSeq (file nhỏ, ghi nguyên tử); đệm trạng thái khi mất MQTT ≤ 500 mẫu.

### 5.2 Dịch vụ `plc` trên LAVIPCO Server
- **Broker:** Aedes 1.x (ESM, `Aedes.createBroker()`), WebSocket bằng `ws` + `createWebSocketStream`, chỉ nghe trong mạng Docker; Caddy `/mqtt` với `stream_close_delay` (≥ 5 phút) cho `/mqtt` và `/plc/ws`. Không publish cổng 1883/8883. Thiếu biến bí mật → dừng khởi động (bỏ mặc định admin/admin, JWT mặc định của khung cũ).
- **Xác thực gateway:** stationId `^[A-Z0-9-]{1,32}$`; khoá ≥ 128 bit, lưu băm; khoá sai 5 lần/10 phút → chặn IP 15 phút; **thu hồi** = đổi băm + ngắt client đang kết nối ≤ 10 s. ACL: tủ X chỉ publish `lvc/X/state|ack|online`, subscribe `lvc/X/cmd|config`.
- **API `/plc/*`:** JWT core, kiểm quyền **từng lệnh**: vai trò `editor` của app plc **và** được gán tủ đó (`station_users`). CORS chỉ `https://neo-era.github.io`; WebSocket kiểm Origin; JWT gửi qua message đầu tiên sau khi mở WS, **không** để trong query string.
- **CSDL schema `plc`:** `stations`, `station_users`, `schedules`, `commands` (bất biến sau tạo), `command_events` (append-only: REVOKE UPDATE/DELETE/TRUNCATE + trigger chặn), `state_history`, `alerts`, `alert_recipients`, `feedback`. Schema `plc` **không** mở qua PostgREST; mọi ghi đi qua `/plc`.
- **Cảnh báo** (lõi `core/alerts.js`, có trễ chuyển): offline > 5 phút (dài hơn thời gian kết nối lại); Q≠I > 60 s; **đèn sáng ban ngày** / **đèn tắt ban đêm** (độc lập với lịch, theo giờ mặt trời ± 30 phút); REMOTE_OK mất > 3 phút; khoá LOCAL; mất điện lưới (UPS báo); lệch lịch > 15 phút; lệnh thất bại; V0.0–V0.2 ≠ 0; nhiệt độ gateway cao. Chống lặp 30 phút; tin hồi phục.
- **Zalo Bot:** trước task 6 làm **thử nghiệm với bot thật**: gửi tin riêng, thử thêm vào nhóm (tài liệu cho thấy bot có thể không vào được nhóm). Người nhận đăng ký bằng cách nhắn bot `/dangky <mã>` → webhook (kiểm `X-Bot-Api-Secret-Token`) lưu `chat_id`. Tin ≤ 2000 ký tự. Nếu bot không vào được nhóm → báo anh, chuyển sang tin riêng cho từng người trong nhóm trực. Kênh dự phòng: email + thông báo trên app.

### 5.3 App PWA (`plc-logo`)
- Thêm chế độ **"Từ xa qua 4G"** (giữ Demo / Modbus Proxy / LOGO! Web).
- Màn hình: danh sách tủ → chi tiết tủ (3 mạch, chế độ: Lịch từ xa / Lịch tại tủ / Cưỡng bức / Tay / Khoá tại tủ; đồng hồ; lịch) → sửa lịch → nhật ký → góp ý.
- Lệnh: xác nhận 2 bước, chọn hạn, hiện từng trạng thái lệnh; ghi chú an toàn "Thao tác từ xa không thay cô lập điện".
- PWA đủ (manifest, service worker, icon, nút cài); CSP; repo bật bảo vệ nhánh + 2FA (khuyến nghị anh bật).
- **Giao diện đã chốt: phương án A (thẻ mạch) + bảng thao tác đáy (B) + dòng thời gian ở màn Lịch (C)** — chi tiết ở Nhật ký duyệt.

## 6. Kế hoạch task
| # | Task | Kiểm chứng |
|---|---|---|
| 0 | **Khảo sát tại tủ**: lắp RUT241, ghi nhiệt độ + sóng + data 7 ngày; thử NTP server của router; anh gửi file .lsc | số liệu đo, chọn phương án A/B |
| 1 | Lõi `schedule.js` + `sun.js` (tầng, qua đêm, hạn cưỡng bức, giới hạn đóng cắt, K3 nguội, ổn định 60 s) | unit test |
| 2 | Lõi `alerts.js` | unit test |
| 3 | Lõi `commands.js` (expiresAt, seq, máy trạng thái, rejected chờ K1) | unit test |
| 4 | **Bộ mô phỏng LOGO! V3** (Modbus server: watchdog 2 sườn + Off-delay, bộ chọn, MAINT, liên động 30 s, NI1–NI3, RTC) | dùng cho test tích hợp; ca HB kẹt 0/1, PLC mất điện |
| 5 | Gateway I/O + MQTT + mô phỏng | test tích hợp: mất mạng, lệnh trễ, phát lại sau khởi động lại, gateway chết |
| 6 | Thử Zalo Bot thật → dịch vụ `plc` (broker ACL, thu hồi, API, DB append-only, cảnh báo) | test API + ACL + trigger |
| 7 | Chốt UI → app chế độ 4G | Playwright dọc/ngang/sáng/tối |
| 8 | Chương trình LOGO! V3 (theo .lsc thật) + phiếu thử tại tủ | mô phỏng Soft Comfort + phiếu |
| 9 | Hướng dẫn lắp đặt, cấu hình router, phiếu nghiệm thu; chạy thử 72 giờ (T12) | QA độc lập |

## 7. Rủi ro
| Rủi ro | Đối sách |
|---|---|
| Lệnh từ xa bật đèn khi đang sửa chữa | Công tắc khoá LOCAL/REMOTE bắt buộc + quy trình cắt CB, treo biển; app ghi chú |
| Ghi nhầm làm tắt đèn ban đêm | Vùng VM riêng (VB100+), chỉ ghi coil, giữ V0.0–V0.2 = 0, cảnh báo đèn tắt ban đêm, giới hạn tắt cưỡng bức 2 giờ |
| Đóng cắt dồn dập khi mạng chập chờn | Ổn định 60 s mới về từ xa; ≤ 4 lần/giờ; K3 nguội 15 phút |
| Lộ khoá gateway / phát lại lệnh | Khoá 128 bit, thu hồi ngắt phiên; seq bền + expiresAt |
| Nóng tủ làm hỏng gateway | Đo 7 ngày, chọn A/B; cảnh báo nhiệt; PLC vẫn chạy lịch tại tủ |
| Pin RTC LOGO! (≈ 20 ngày ở 25 °C, ngắn hơn khi nóng) | NTP tự đồng bộ khi cấp nguồn lại + cảnh báo mất giờ |
| Zalo Bot không vào nhóm | Thử trước; tin riêng + email dự phòng |
| LAVIPCO Server chưa sẵn | Chạy dịch vụ `plc` độc lập tạm thời |

## 8. Nhật ký duyệt
| Ngày | Chốt | Chuyên gia | Quyết định | Thay đổi đã áp |
|---|---|---|---|---|
| 15/11/2026 | Chốt 1 | Điện chiếu sáng & LOGO! | Duyệt có điều kiện | Dời VM sang VB100+, ghi coil, M cờ cho chiều về; giữ V0.0–V0.2 = 0, đọc I2/M6; công tắc LOCAL bắt buộc; giờ mặt trời + cảnh báo sáng ngày/tắt đêm + giới hạn tắt đêm 2 h; lệch giờ > 2 phút → REMOTE_EN = 0; ổn định 60 s, ≤ 4 lần/giờ, K3 nguội 15 phút; watchdog 2 sườn; khảo sát nhiệt 7 ngày + phương án gateway công nghiệp; nguồn 5 V ≥ 5 A; chống sét anten; NTP chính, FC15 dự phòng (giây 2–50, ngưỡng 90 s); T7 tính từ lúc luật kích hoạt. Nhận NÊN: UPS DC, tiếp điểm phụ K3, cưỡng bức ban ngày 15 phút, nhắc lệch lịch 15 phút, kiểm quyền Modbus sau nạp |
| 15/11/2026 | Chốt 1 | IoT kiến trúc & bảo mật | Duyệt có điều kiện | expiresAt + seq bền + clean session; máy trạng thái lệnh, tách T2a/T2b, rejected chờ K1; commands + command_events append-only, không mở qua PostgREST, quyền editor theo tủ; khoá 128 bit, thu hồi ngắt ≤ 10 s, regex stationId, broker không publish cổng, bỏ mặc định; Caddy stream_close_delay; thử Zalo Bot thật, đăng ký chat_id, kênh dự phòng; T1/T2 p95 N = 50, T9 đo router, T12 chạy thử 72 h. Nhận NÊN: Aedes 1.x ESM + ws, CORS/Origin/không JWT trong URL, tắt cập nhật qua 4G, watchdog systemd + phần cứng + Ping Reboot |
| 15/11/2026 | Chốt UI | UX/UI (mobile, accessibility) | Duyệt có điều kiện — **chọn phương án A (thẻ mạch)**, ghép ý B, C | Bỏ nút phân đoạn 1 chạm → nhãn trạng thái theo Q/I + nút "Đổi chế độ…" ≥ 48 px mở bảng thao tác đáy (ý B); thao tác 2 bước: chọn lệnh + hạn (mặc định 30′, Tắt đêm ≤ 2 h) → màn tóm tắt "K1 sẽ TẮT đến 21:52", nút xác nhận khác vị trí, khoá 800 ms, Tắt màu đỏ + chữ, dòng "không thay cô lập điện"; trạng thái lệnh trong thẻ (received→applied→confirmed, đếm ngược liên động K2, lỗi đỏ + lý do + Thử lại); băng trạng thái tủ cố định (mất kết nối từ HH:MM + làm xám + dữ liệu cũ; khoá tại tủ; lịch tại tủ; lệch lịch); Q≠I > 60 s → trạng thái lỗi; 360×640 thấy đủ 3 mạch; K3 ghi "Chỉ xem (v1)" [đã thay 16/11/2026: K3 điều khiển như K1/K2]; màu chữ sáng: on #166534, warn #92400e, off #475569, err #b91c1c, brand-ink #0a5aa8; viền nút ≥ 3:1 (#8a94a6 sáng / #5b6b86 tối). Nhận NÊN: dòng thời gian 24 h ở màn Lịch, giờ PLC lớn ở đầu, dòng "↳ liên động 30 s", danh sách tủ 1 dòng/tủ + lọc lỗi/cưỡng bức, ngang: bảng thao tác cột phải, toast dưới tiêu đề, nút Huỷ/Về tự động trong thẻ |
| 15/11/2026 | Đối chiếu .lsc | (em, theo bản in Soft Comfort anh gửi) | — | Xác nhận vùng trống VB100+, M16–M64, I3/I4/I7/I8; sửa mô tả M6; phát hiện liên động 30 s chỉ ở nhánh lịch → V4 kích T003 bằng Q2 cho mọi tầng; khoá ELR C009 không cho gỡ từ xa; K3 không qua ELR → anh chốt V4 khoá luôn K3 |
| 15/11/2026 | Duyệt trước bước mô phỏng | Điện chiếu sáng & LOGO! | Duyệt có điều kiện | B1 cờ trạng thái lịch dời M32–M34 (M8, M25–M31 là cờ hệ thống); B2 NI1 chặn khi LOCAL + Modbus chỉ nhận IP gateway; B3 reset C009 = ¬T001·¬M2·¬M3·¬M23·¬C011, C009 Rem = on; B4 watchdog bằng 2 Off-delay (không cần bắt sườn); B5 K3 nguội cả trong PLC (T012/M35, chỉ khi K3 là mạch đèn riêng) và lõi tính theo Q4 thật; B6 giới hạn đóng cắt không bao giờ chặn việc về đúng lịch; B7 gateway từ chối khi khoá ELR / REMOTE_OK = 0 / hết lượt. Nhận NÊN: câu chữ T003, ghi hệ quả NI2 cấm cả K2, NIGHT_OFF xét K2, báo ngay mỗi lần ELR tác động, DAY_ON bỏ qua khi khoá tại tủ, ghi chú tên file bản in |
| 15/11/2026 | Duyệt trước bước mô phỏng | QA & kiến trúc | **Không duyệt** (17/24 ca xấu hỏng) → đã sửa toàn bộ | Đầu vào hỏng (now NaN, lịch thiếu) → REMOTE_EN = 0; tắt cưỡng bức tính phần giao với đêm (> 2 h chặn, có giao thì báo nhóm); kiểm lịch theo từng phút (LATE_ON/EARLY_OFF/NIGHT_GAP/LATE_OFF/DAY_ON); K3 nguội theo Q4 thật; LOCAL huỷ cưỡng bức (clearOverrides + bỏ lệnh đặt trước khi khoá); state lưu bền (serialize/restore, dữ liệu hỏng → state đầu); accept kiểm ctx (BAD_CTX), issuedAt tương lai, expiresAt ≥ issuedAt, gọi validateOverride, lệnh trùng → duplicate; máy trạng thái transition(); thiếu phản hồi I → pending; cảnh báo đóng băng khi offline/snapshot hỏng, hồi phục phải ổn định 2 phút, chống lặp 30′ cả sau hồi phục, thêm BAD_SNAPSHOT, SCHED_DRIFT, CMD_FAILED; đếm lượt chuyển sau bất biến và chỉ đếm chuyển đi xa lịch. 24 ca của QA đưa vào `core/test/regression.test.js`. Kết quả: **70/70 test đạt** |
| 15/11/2026 | Vòng 2 | Điện chiếu sáng & LOGO! | Duyệt có điều kiện (chỉ sửa câu chữ, không cần duyệt lại) | BB1 T010/T011 Rem = off + ca thử cúp nguồn; BB2 sửa mâu thuẫn reset C009 và treo việc ghi VW2/VW4; BB3 ca thử ELR 1 lần lúc 22:30 với K3. Nhận NÊN: T11 ghi rõ "≤ 4 lần cưỡng bức đi xa lịch", giới hạn sửa lịch ≤ 6 lần/giờ ở API, cảnh báo khoá ELR còn sau 07:00, ghi chú T012 Rem = off |
| 15/11/2026 | Vòng 2 | QA & kiến trúc | Duyệt có điều kiện → đã sửa | Bỏ im lặng chống lặp: tái phát sau hồi phục luôn báo "TÁI PHÁT", NIGHT_OFF/DAY_ON chờ ổn định 10′ mới báo hồi phục, CMD_FAILED báo mỗi lần; bỏ dấu thời gian tương lai trong state; K3 rơi (ELR) khi đang yêu cầu bật → nguội 15′; T11 chọn phương án (a) + `scheduleEditAllowed` ≤ 6 lần sửa lịch/giờ; lệnh "Tự động" luôn được nhận. Nhận NÊN: setAt = giờ gateway lúc accept, lý do OVERRIDE_STALE, cộng dồn tắt đêm (nightOffUsedMin), K3 sáng ban ngày cảnh báo, BAD_SUN, tính lại thời gian giữ sau khi hết mất kết nối, chống trùng theo danh sách cmdId gần nhất, `flipsLastHour` lấy từ state. 41 ca xấu của QA thành test hồi quy. **90/90 test đạt** |
| 16/11/2026 | Xác nhận nghiệp vụ | anh Lâm | — | K3 là mạch đèn riêng giống K1, K2 → giữ khoá nguội 15′ cho K3 trong PLC (T012/M35) và trong gateway |
| 16/11/2026 | Thay đổi phạm vi | anh Lâm | — | K3 bật/tắt cưỡng bức từ xa giống K1/K2 (vẫn giữ khoá nguội 15′, khoá ELR, giới hạn đóng cắt, giới hạn tắt đêm cộng dồn); app hiện nút "Đổi chế độ…" cho cả K3 |
| 16/11/2026 | Xác nhận nghiệp vụ | anh Lâm | — | Đồng ý NI2 (cấm K1) cấm luôn K2 trong V4 |
