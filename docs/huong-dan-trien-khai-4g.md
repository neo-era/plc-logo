# Hướng dẫn triển khai điều khiển tủ chiếu sáng qua 4G — thí điểm tủ LVC02

Áp dụng cho thiết kế `docs/dieu-khien-4g-thiet-ke.md` (đã qua các chốt duyệt). Làm theo thứ tự; **không bỏ bước khảo sát và phiếu thử**.

## An toàn chung (bắt buộc cho bước A, B, C)
- Có **phiếu công tác**, tối thiểu **2 người**; báo trước cho đơn vị quản lý vận hành tủ và chủ tài sản.
- Trước khi đấu I3/I4, nguồn router/gateway: **cắt MCB nguồn điều khiển và CB tổng, thử không điện, khoá CB, treo biển**. LOGO! 230RCE có ngõ vào **230 VAC**.
- Nạp chương trình chỉ trong khung **08:00–15:00** (LOGO! về STOP thì đèn tắt).
- **Phương án lùi:** nếu đến 16:00 phiếu C dòng 1–6, 8, 9 chưa đạt → nạp lại `_truoc-4G.lsc`, kiểm giờ T001/T002/T006 và RTC, tắt gateway, lập biên bản. Mang laptop có Soft Comfort + cáp đến tủ.
- Huấn luyện người trực: **thao tác từ xa không thay cho cô lập điện**; đưa nội dung này vào quy trình an toàn.

## Bước A — Khảo sát tại tủ (1 tuần, trước khi mua gateway)
1. Lắp router **Teltonika RUT241** + anten 4G gắn vỏ tủ + SIM data, nguồn lấy **trước contactor** qua MCB 2 A + SPD.
2. Trên web router (192.168.0.1): ghi lại cường độ sóng (RSRP/RSRQ), bật **giới hạn data**, bật **Ping Reboot**, đổi mật khẩu quản trị, tắt truy cập quản trị từ WAN.
3. Đặt 1 nhiệt kế ghi dữ liệu trong tủ (hoặc đọc nhiệt độ router) **7 ngày**, gồm các ngày nắng.
4. Thử **NTP server** của router: từ laptop cắm vào LAN, `w32tm /stripchart /computer:192.168.0.1 /samples:3`. Có trả lời → LOGO! dùng router làm NTP; không → gateway làm NTP server.
5. Quyết định gateway: nhiệt độ lớn nhất ≤ 45 °C → **Phương án A** (Raspberry Pi 4); > 45 °C → **Phương án B** (máy công nghiệp chịu ≥ 70 °C).

## Bước B — Sửa và nạp chương trình LOGO! (ban ngày)
1. Đọc chương trình đang chạy từ PLC về, **lưu bản sao** (`NisseLOGOProgram_V3-ELR_truoc-4G.lsc`).
2. Sửa theo mục 4.2 thiết kế (V4): watchdog T010/T011 (Rem = off), M20–M24, bộ chọn M21–M23, T003 kích bằng Q2, NI1·¬I3, reset C009 mới + **C009 Rem = on**, T012/M35 nguội K3, Q4 qua ¬M15·¬C009, M16 = C009, M32–M34.
3. Đấu dây mới: **công tắc chìa khoá LOCAL/REMOTE → I3**, tiếp điểm phụ K3 → I4.
4. Cài đặt: NTP client → 192.168.0.1 (UTC+7); Modbus server **bỏ “Accept all”, chỉ nhận 192.168.0.10**.
5. Mô phỏng trong Soft Comfort theo phiếu C, rồi nạp; kiểm tra quyền truy cập Modbus sau khi nạp.

## Bước C — Phiếu thử tại tủ (ký xác nhận từng dòng)
| # | Thao tác | Kết quả đúng | Đạt |
|---|---|---|---|
| 1 | Cấp nguồn PLC, chưa chạy gateway | M24 = 0, PLC chạy lịch tại tủ, màn hình "4G: LOCAL" | ☐ |
| 2 | Chạy gateway, chờ 2 phút | M20 = 1, màn hình "4G: REMOTE"; đèn **không chớp tắt** lúc chuyển | ☐ |
| 3 | Rút cáp mạng gateway | Sau ≤ 180 s PLC về lịch tại tủ | ☐ |
| 4 | Gateway ghi HB kẹt 1 (thử bằng phần mềm) | Sau ≤ 180 s M24 = 0 | ☐ |
| 5 | Vặn công tắc LOCAL | M20 = 0 ngay, mọi cưỡng bức bị huỷ, app báo "Khoá tại tủ" | ☐ |
| 6 | LOCAL + ghi V0.0 = 1 bằng laptop | K1 **không** đổi | ☐ |
| 7 | Từ app: Tắt K1 ban đêm 10 phút (báo nhóm trực trước, giờ thấp điểm, có người quan sát tại tuyến) | Bắt nhập lý do; "Contactor đã xác nhận" ≤ 10 s; K2 tắt theo; Zalo nhóm nhận tin có giờ, mạch, người ra lệnh, lý do; trước hạn 10′ có tin "sẽ TỰ BẬT"; hết hạn K1 sáng, K2 sáng sau 30 s | ☐ |
| 8 | Từ app: Bật K2 khi K1 đang tắt | Bị từ chối "K2 chỉ bật được khi K1 đang sáng" | ☐ |
| 9 | Bật K1 → K2 (từ xa, tay I2, NI1) | K2 đóng sau K1 ≥ 30 s ở cả 3 cách | ☐ |
| 10 | Bật/tắt K3 từ xa; tắt K3 rồi bật lại trong 15′ | Đúng lệnh; lần bật lại bị từ chối "Đèn HPS đang chờ nguội, còn x phút" | ☐ |
| 11 | Ghi NI2 = 1 | K2 cũng tắt (không chỉ K1) | ☐ |
| 12 | ELR tác động 1 lần (nút TEST của ELR) lúc có lịch thử ban ngày | K1/K2 đóng lại ~15 s; K3 không đóng lại trước 15′; Zalo "ELR vừa tác động" | ☐ |
| 13 | ELR 3 lần (nút TEST, **ban ngày, lịch thử**) | Khoá cả 3 mạch; bật từ xa bị từ chối; cúp nguồn PLC → vẫn khoá; trả lịch về → C009 = 0 | ☐ |
| 14 | Khoá ELR + lịch từ xa còn bật sau 05:45 | Vẫn khoá; gỡ khi không còn mạch nào được yêu cầu bật | ☐ |
| 15 | Đặt giờ PLC sai (2020) | NTP sửa lại ≤ 2 phút; thứ trong tuần đúng; khối hẹn giờ không đóng cắt bù | ☐ |
| 16 | Gateway ghi HB kẹt 0 | Sau ≤ 180 s M24 = 0 | ☐ |
| 17 | Máy IP khác (laptop) kết nối Modbus | Bị từ chối | ☐ |
| 18 | Chuyển LOCAL → REMOTE | Đèn không chớp tắt | ☐ |
| 19 | Đọc bảng Modbus mapping trong Soft Comfort | V100.0 = coil 800 (byte × 8 + bit) như `core/modbus-map.js` | ☐ |
| 20 | Rút anten 4G 10 phút | Đèn chạy lịch bình thường; Zalo báo mất kết nối ~5–7′ và hồi phục khi cắm lại | ☐ |
| 21 | Cắt nguồn tủ (UPS giữ gateway) | Zalo báo "mất điện lưới". **Không lắp UPS → ghi "Không áp dụng"** | ☐ |
| 22 | Tắt bot Zalo (đổi token sai) rồi tạo cảnh báo | Tin đến kênh Telegram dự phòng | ☐ |

## Bước D — Máy chủ (LAVIPCO Server)
1. Tạo vai trò CSDL: chạy `server/db/001_plc.sql` (tài khoản chủ), rồi `deploy/db-roles.sql` (đổi mật khẩu).
2. Thêm khối `deploy/docker-compose.plc.yml` vào compose — **Caddy phải có IP cố định 172.30.0.2** và `TRUSTED_PROXIES` khớp. Thêm `deploy/Caddyfile.plc` vào site `api.lavipco.vn`.
3. Đặt `.env`: `PLC_DB_PASSWORD`, `JWT_SECRET` (cùng core), `ZALO_BOT_TOKEN`, `ZALO_WEBHOOK_SECRET` (≥ 32 ký tự ngẫu nhiên), `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` (bot cảnh báo sẵn có — kênh dự phòng khi Zalo lỗi).
4. `docker compose up -d plc` → `curl https://api.lavipco.vn/plc/health` trả `{"status":"ok"}`. Xem log không có dòng "CẢNH BÁO … TRUSTED_PROXIES".
5. Cấp quyền app plc: `docker compose exec core node bin/admin.js grant lam@lavipco.vn plc admin`.
6. Tạo tủ (admin): `POST /plc/stations {"id":"LVC02","name":"Tủ LVC02 — Lê Lợi"}` → **chép khoá trả về (chỉ hiện 1 lần)**. Gán người dùng: `PUT /plc/stations/LVC02/users/<id>`.

## Bước E — Gateway
1. Cài Node 20+ (Pi OS Lite 64-bit), tạo user `plcgw`, chép thư mục `gateway/` + `core/` vào `/opt/plc-gateway`, `npm ci --omit=dev`.
2. `/etc/plc-gateway.env` (chmod 600) theo `gateway/plc-gateway.env.example`, điền `GATEWAY_KEY`.
3. Phương án A: bật **overlayfs chỉ đọc**, nhưng `/var/lib/plc-gateway` phải nằm trên phân vùng ghi được; bật watchdog phần cứng; tắt cập nhật tự động qua 4G.
4. `systemctl enable --now plc-gateway` → chạy 30 phút, `systemctl show plc-gateway -p NRestarts` phải bằng **0**.

## Bước F — Zalo Bot
1. Tạo bot tại bot.zaloplatforms.com, lấy token → `ZALO_BOT_TOKEN`.
2. Đặt webhook `https://api.lavipco.vn/plc/zalo/webhook` với secret = `ZALO_WEBHOOK_SECRET`.
3. Admin tạo mã: `POST /plc/signup-codes` → mỗi người trực nhắn bot `/dangky <mã>`; thử thêm bot vào nhóm trực rồi nhắn `/dangky <mã>` trong nhóm.
4. Nếu bot **không vào được nhóm** → mỗi người trong nhóm trực đăng ký tin riêng.

## Bước G — App
- Mở `https://neo-era.github.io/plc-logo/dieu-khien/` → đăng nhập → cài ứng dụng (⚙ → Cài ứng dụng; iPhone: Chia sẻ → Thêm vào MH chính).
- Xem thử không cần tài khoản: thêm `?demo=1`.

## Chạy thử liên tục 72 giờ (T12) và nghiệm thu
- 72 giờ liên tục với kịch bản: rút anten, tắt máy chủ, tắt gateway, mất nguồn tủ — ghi nhật ký; **không lần nào bật/tắt sai** (theo định nghĩa T3).
- Đo data 4G bằng bộ đếm router 7 ngày (T9 ≤ 300 MB/tháng).
- Đo p95 trễ trạng thái và lệnh trên 50 lần (T1, T2a).

## Kiểm thử phần mềm (để tái lập)
```bash
npm test                                   # lõi + bộ mô phỏng + gateway (118 test)
# e2e cần Postgres 16 thử:
cd server && TEST_DATABASE_URL=postgres://postgres@127.0.0.1:55432/postgres node --test test/e2e.test.js
node scripts/build-web.js                  # đóng gói lõi cho app, đổi mã bản dựng
```

## Góp ý người dùng
- Xem góp ý mới: `select * from plc.feedback where status = 'moi' order by at desc;`
- Xử lý xong: `update plc.feedback set status = 'da_xu_ly', note = '<bản sửa>' where id = …;`
