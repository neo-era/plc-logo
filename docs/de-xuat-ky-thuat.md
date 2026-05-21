# ĐỀ XUẤT KỸ THUẬT
## Hệ thống giám sát và điều khiển từ xa tủ điện chiếu sáng công cộng

> **Phiên bản:** 1.0 — Tháng 05/2026
> **Người soạn:** Đội kỹ thuật dự án CSCC
> **Đối tượng:** Ban Giám đốc / Phòng Kỹ thuật / Đối tác cấp vốn
> **Mức độ:** Đề xuất khả thi — chờ phê duyệt triển khai pilot

---

## I. TÓM TẮT ĐIỀU HÀNH

Đề xuất xây dựng hệ thống **giám sát và điều khiển từ xa qua internet** cho **50 tủ điện chiếu sáng công cộng (CSCC)** sử dụng PLC Siemens LOGO! 230RCE, triển khai trong vòng **1 tháng**, ngân sách dự kiến **200–300 triệu đồng**.

Hệ thống cho phép:
- Bật/tắt từng tuyến đèn từ xa qua điện thoại hoặc máy tính.
- Giám sát realtime trạng thái contactor, cảm biến quá tải, photocell.
- Tự động cảnh báo khi tủ mất kết nối hoặc đèn không sáng theo lịch.
- Ghi log mọi thao tác để truy xuất khi có khiếu nại.

**ROI dự kiến:** giảm ≥40% thời gian phát hiện sự cố (từ trung bình 12h xuống dưới 5 phút), giảm ≥60% chi phí kiểm tra hiện trường thủ công, tăng tuổi thọ thiết bị nhờ vận hành đúng giờ.

**Đề nghị phê duyệt:** ngân sách pilot **15 triệu đồng** cho **1 trạm thử nghiệm trong 2 tháng** trước khi quyết định triển khai diện rộng.

---

## II. HIỆN TRẠNG VÀ VẤN ĐỀ

### 2.1. Hiện trạng

- Mạng lưới CSCC trên địa bàn quản lý gồm khoảng **50 tủ điều khiển** phân tán tại các tuyến đường, công viên, khu dân cư.
- Mỗi tủ trang bị **PLC Siemens LOGO! 230RCE (0BA8)** thực hiện chương trình bật/tắt theo lịch và photocell.
- Toàn bộ giám sát hiện nay là **kiểm tra thủ công**: nhân viên đi tuần ban đêm hoặc dựa vào phản ánh người dân.

### 2.2. Vấn đề tồn tại

| # | Vấn đề | Hậu quả |
|---|--------|---------|
| 1 | Phát hiện sự cố chậm | Đèn tắt nhiều giờ trước khi được sửa; mất an toàn giao thông |
| 2 | Không thể can thiệp từ xa | Mỗi sự cố nhỏ phải cử người tới hiện trường |
| 3 | Không có lịch sử vận hành | Khó truy xuất nguyên nhân, khó cải tiến chương trình PLC |
| 4 | Không có cảnh báo tự động | Phụ thuộc người dân phản ánh, ảnh hưởng hình ảnh đơn vị |
| 5 | Tiêu hao nhân lực đi kiểm tra định kỳ | Chi phí vận hành cao, hiệu quả thấp |

### 2.3. Cơ hội

Kỹ thuật IoT công nghiệp đã chín muồi và giá thành hợp lý: mạng 4G phủ rộng, thiết bị edge giá <2tr/trạm, công nghệ mã nguồn mở. **Có thể tận dụng PLC sẵn có**, không cần thay thế hệ thống đang hoạt động.

---

## III. MỤC TIÊU VÀ PHẠM VI

### 3.1. Mục tiêu kỹ thuật

1. **Real-time monitoring:** trạng thái tủ cập nhật về trung tâm trong **<5 giây**.
2. **Remote control:** lệnh bật/tắt từ trung tâm tới tủ thực thi trong **<3 giây**.
3. **Độ sẵn sàng:** hệ thống giám sát đạt uptime **≥99%**, không ảnh hưởng vận hành đèn (PLC vẫn tự chạy lịch local nếu mất kết nối).
4. **Bảo mật:** chỉ người được cấp tài khoản mới truy cập, mỗi tủ có khóa riêng, dữ liệu mã hóa truyền tải.
5. **Khả năng mở rộng:** thiết kế cho 50 tủ ban đầu, có thể nâng lên 500+ không cần thay đổi kiến trúc.

### 3.2. Mục tiêu kinh doanh / xã hội

- Giảm thời gian khắc phục sự cố từ trung bình **12h xuống <2h**.
- Giảm **60%** chi phí kiểm tra hiện trường thường kỳ.
- Có dữ liệu vận hành đầy đủ để báo cáo cấp trên và cải tiến chương trình PLC.
- Nâng cao uy tín đơn vị qua phản hồi nhanh sự cố.

### 3.3. Phạm vi

**Trong phạm vi:**
- Cải tạo phần cứng tại tủ: thêm module gateway (RasPi + 4G), không thay PLC.
- Xây dựng server trung tâm self-host trên VPS.
- Web app + mobile (PWA) cho vận hành viên.
- Tài liệu vận hành + đào tạo nhân sự.

**Ngoài phạm vi:**
- Thay thế PLC hoặc tủ điện hiện có.
- Tích hợp với hệ thống SCADA của bên thứ ba.
- Bảo trì phần cơ điện ngoài hiện trường.

---

## IV. GIẢI PHÁP ĐỀ XUẤT

### 4.1. Kiến trúc tổng quan

```
┌────────────────────┐  Modbus TCP   ┌──────────────────┐   MQTT/TLS    ┌──────────────────────┐   HTTPS+WS    ┌─────────────┐
│ PLC LOGO! 230RCE   │ ←───────────→ │ Gateway (RasPi   │ ←────4G─────→ │ Server trung tâm     │ ←───────────→ │ Web/PWA UI  │
│ (đã có sẵn)        │   LAN nội bộ  │  + USB 4G)       │   Internet    │ (VPS Docker)         │   Internet    │ điện thoại  │
└────────────────────┘                └──────────────────┘                └──────────────────────┘                └─────────────┘
       Tại mỗi tủ                            Tại mỗi tủ                       1 VPS cho toàn bộ                      Người dùng
```

**Nguyên lý quan trọng:** PLC vẫn tự thực hiện chương trình điều khiển độc lập. Gateway và server chỉ làm lớp giám sát/điều khiển bổ sung. **Mất internet không ảnh hưởng vận hành đèn.**

### 4.2. Mô tả thành phần

#### A. Tại mỗi tủ điều khiển (50 vị trí)

| Thành phần | Vai trò | Ghi chú |
|------------|---------|---------|
| PLC LOGO! 230RCE 0BA8 | Đã có sẵn | Bật Modbus Slave qua Soft Comfort |
| Raspberry Pi Zero 2W | Gateway edge | ~600k, tiêu thụ ~2W |
| USB 4G dongle (Huawei E3372) | Truyền dữ liệu | ~500k |
| SIM 4G IoT doanh nghiệp | Kết nối internet | ~30k/tháng |
| Tủ phụ chống ẩm IP65 | Bảo vệ thiết bị | ~300k |
| Adapter 5V/3A | Cấp nguồn gateway | ~150k |

**Chi phí mỗi tủ: ~2.5–3 triệu đồng** (chưa kể công thi công).

#### B. Trung tâm (VPS cloud)

| Thành phần | Lựa chọn | Chi phí |
|------------|----------|---------|
| VPS Linux Ubuntu 22.04 | Hetzner CX22 (4GB, 2 vCPU) | ~150k/tháng |
| Domain riêng | <tên>.vn hoặc .com | ~300k/năm |
| Cloudflare (HTTPS, DDoS) | Free tier | Miễn phí |
| Email cảnh báo / Telegram bot | Telegram Bot API | Miễn phí |
| Backup off-site | rclone → Google Drive | Miễn phí |

#### C. Phần mềm (mã nguồn mở, không phí license)

| Lớp | Công nghệ |
|------|-----------|
| Giao thức PLC ↔ Gateway | Modbus TCP (chuẩn công nghiệp) |
| Giao thức Gateway ↔ Server | MQTT 3.1.1 over TLS |
| Backend server | Node.js 20 + Aedes (MQTT broker) + Express |
| Database | SQLite (đủ cho 500+ trạm) |
| Authentication | JWT + bcrypt |
| Frontend | Vanilla HTML/JS PWA (offline-capable) |
| Container | Docker + Docker Compose |

### 4.3. Tính năng cho người dùng

#### Vận hành viên (operator)
- Bản đồ tủ trên toàn địa bàn, màu sắc theo trạng thái online/offline/cảnh báo.
- Xem chi tiết từng tủ: trạng thái contactor, đèn báo, photocell, đo dòng (nếu có).
- Bật/tắt thủ công từng tuyến đèn (cần xác nhận 2 bước).
- Đặt lịch tạm thời (vd: tắt sớm/bật muộn 1 tuần).
- Xem lịch sử thao tác.

#### Quản trị viên (admin)
- Tạo/xóa tủ, cấp token gateway, phân quyền user theo khu vực.
- Cấu hình ngưỡng cảnh báo (offline >5p, mất điện AC, quá tải).
- Xuất báo cáo hàng tháng (uptime, số lần can thiệp, lỗi thường gặp).

#### Cảnh báo tự động (Telegram + Email)
- Tủ mất kết nối >5 phút.
- Tủ báo quá tải.
- Đèn không bật theo lịch.
- Server down (qua dịch vụ monitoring ngoài như UptimeRobot).

### 4.4. Bảo mật

| Lớp | Biện pháp |
|------|-----------|
| Truyền tải | TLS 1.3 toàn bộ (HTTPS + MQTTS). Không có dữ liệu plaintext qua internet. |
| Xác thực gateway | Mỗi tủ có token 24-byte hex riêng, bcrypt-hash trên server, chỉ trả về 1 lần khi tạo. |
| Xác thực user | bcrypt + JWT 7 ngày, 2FA tùy chọn (TOTP). |
| Phân quyền | Role admin/operator, mở rộng theo khu vực. |
| MQTT ACL | Gateway tủ A không bao giờ thấy được dữ liệu tủ B. |
| PLC | Chỉ phơi LAN nội bộ tại tủ, không port-forward ra internet. |
| Audit log | Mọi thao tác bật/tắt + người thực hiện + thời gian ghi vào DB, không xóa. |
| Backup | DB sao lưu hàng ngày, mã hóa, gửi off-site. |

### 4.5. Failover / Đối phó sự cố

| Sự cố | Hành vi hệ thống | Tác động lên đèn |
|-------|-------------------|-------------------|
| Mất kết nối 4G tại tủ | Gateway buffer dữ liệu RAM, gửi lại khi reconnect | **Không** — PLC vẫn chạy lịch local |
| Gateway crash | Systemd tự restart sau 5s; LWT báo offline cho server | **Không** |
| PLC mất nguồn | Server cảnh báo offline | Đèn tắt — cần xử lý hiện trường |
| Server down | Mọi gateway buffer dữ liệu | **Không** — đèn vẫn hoạt động bình thường |
| VPS bị tấn công DDoS | Cloudflare WAF chặn; rate-limit; failover sang VPS dự phòng | **Không** |

---

## V. LỢI ÍCH VÀ KPI

### 5.1. Lợi ích định lượng

| Chỉ tiêu | Hiện tại | Sau triển khai | Mức cải thiện |
|----------|----------|----------------|----------------|
| Thời gian phát hiện sự cố | ~12h (TB) | <5 phút | **-99%** |
| Thời gian khắc phục sự cố | ~24h | <2h | **-92%** |
| Số lượt kiểm tra hiện trường định kỳ | 4 lượt/tháng/tủ | 1 lượt/tháng/tủ | **-75%** |
| Số khiếu nại từ người dân về đèn tắt | (đường cơ sở hiện tại) | -50% (dự kiến) | **-50%** |
| Số giờ làm thêm ngoài giờ của đội kỹ thuật | (đường cơ sở) | -40% | **-40%** |

### 5.2. Lợi ích định tính

- Hình ảnh đơn vị chuyên nghiệp, tiệm cận tiêu chuẩn smart city.
- Dữ liệu vận hành đầy đủ phục vụ cải tiến chương trình PLC.
- Cơ sở để báo cáo cấp trên với số liệu cụ thể.
- Tăng an toàn giao thông và an ninh khu vực.
- Nền tảng để mở rộng thêm tính năng (đo điện năng, điều chỉnh độ sáng LED…) trong tương lai.

### 5.3. KPI nghiệm thu

| Giai đoạn | KPI bắt buộc đạt |
|-----------|------------------|
| Cuối pilot 1 trạm (tháng 2) | Uptime ≥98% trong 30 ngày liên tục, độ trễ điều khiển <5s |
| Cuối pilot 5 trạm (tháng 5) | Uptime ≥99%, không có sự cố gây mất điện đèn ≥3 lần |
| Cuối triển khai 50 trạm (tháng 12) | Uptime ≥99%, ≥95% sự cố tự cảnh báo trong 5 phút |

---

## VI. LỘ TRÌNH TRIỂN KHAI 12 THÁNG

| Tháng | Mốc | Đầu ra cụ thể | Người chịu trách nhiệm |
|-------|-----|----------------|-------------------------|
| **1** | POC kiến trúc | Server VPS chạy, gateway test với Modbus simulator, web UI hoạt động | Freelancer DevOps + Đội KT |
| **2** | Pilot 1 trạm tại văn phòng | 1 LOGO! + RasPi + 4G vận hành liên tục 30 ngày, ghi nhận tất cả vấn đề | Đội KT |
| **3** | Đóng gói tủ chuẩn + SOP | Bản vẽ tủ, BOM linh kiện, quy trình thi công, video training | Đội KT + Cơ điện |
| **4–5** | Triển khai 5 trạm pilot tại 1 phường | 5 trạm chạy thật, đo KPI, tinh chỉnh | Đội thi công |
| **6** | Nghiệm thu pilot + duyệt mở rộng | Báo cáo cấp trên, quyết định phê duyệt rollout | Ban Giám đốc |
| **7–11** | Rollout 45 trạm còn lại | 9 trạm/tháng theo batch, có buffer 1 tháng | Đội thi công + KT |
| **12** | Nghiệm thu toàn dự án + bàn giao | 50 trạm hoạt động, đào tạo xong, tài liệu đầy đủ | Toàn đội |

### Biểu đồ Gantt rút gọn

```
Tháng       1   2   3   4   5   6   7   8   9   10  11  12
POC         ██
Pilot 1     ─── ██
SOP             ─── ██
Pilot 5             ─── ███ ██
Nghiệm thu                  ─── ██
Rollout                         ─── ███ ███ ███ ███ ███
Bàn giao                                                ██
```

---

## VII. NGÂN SÁCH CHI TIẾT

### 7.1. Chi phí một lần (CAPEX)

| Khoản | Đơn giá | Số lượng | Thành tiền |
|------|---------|----------|------------|
| Phần cứng gateway/tủ | 2.500.000đ | 50 | 125.000.000đ |
| Tủ phụ chống ẩm + phụ kiện | 500.000đ | 50 | 25.000.000đ |
| Công thi công, đấu nối, test | 1.000.000đ/tủ | 50 | 50.000.000đ |
| Freelancer DevOps setup (4 tháng đầu) | 15.000.000đ/tháng | 4 | 60.000.000đ |
| Thuê VPS + domain năm đầu | trọn gói | — | 5.000.000đ |
| Dự phòng linh kiện thay thế (10%) | — | — | 20.000.000đ |
| **Tổng CAPEX** | | | **285.000.000đ** |

### 7.2. Chi phí vận hành thường xuyên (OPEX)

| Khoản | Định mức | Tháng | Năm |
|------|----------|-------|------|
| SIM 4G IoT × 50 tủ | 30.000đ/SIM | 1.500.000đ | 18.000.000đ |
| VPS + domain | trọn gói | 200.000đ | 2.400.000đ |
| Freelancer bảo trì on-call (sau tháng 4) | — | 5.000.000đ | 60.000.000đ |
| Thay thế phần cứng hư hỏng | — | — | 5.000.000đ |
| **Tổng OPEX** | | **6.700.000đ** | **85.400.000đ/năm** |

### 7.3. ROI ước tính

Giả sử mỗi sự cố đèn tắt tốn trung bình:
- Đi kiểm tra: 200k/lượt × 2 lượt = 400k
- Sửa chữa khẩn cấp: 500k
- Đêm ngoài giờ: phụ cấp 300k
→ **Mỗi sự cố ~1.200k**

Hệ thống giảm 60% sự cố không kịp xử lý = tiết kiệm:
- Giả định 50 tủ × 2 sự cố/tháng × 60% = 60 sự cố/tháng giảm tổn thất
- 60 × 1.200k = **72 triệu/tháng** tiết kiệm

→ **Hoàn vốn dự kiến: ~5 tháng** sau khi rollout 50 trạm.

---

## VIII. PHÂN TÍCH RỦI RO

| Rủi ro | Khả năng | Tác động | Biện pháp giảm thiểu |
|--------|----------|----------|----------------------|
| Mất 4G hàng loạt khi nhà mạng sự cố | Trung bình | Thấp | PLC vẫn tự chạy; sử dụng 2 nhà mạng SIM khác nhau cho 25 tủ mỗi bên |
| Server VPS bị tấn công | Thấp | Trung bình | Cloudflare WAF, fail2ban, backup ngày |
| Token gateway rò rỉ qua nhân viên cũ | Trung bình | Thấp | Quy trình thu hồi token khi nghỉ việc; xóa+tạo lại token nhanh |
| Phần cứng gateway hư hỏng do nhiệt độ | Trung bình | Trung bình | Tủ phụ IP65 + quạt nếu cần; dự phòng 10% |
| Freelancer DevOps nghỉ giữa chừng | Trung bình | Cao | Hợp đồng có điều khoản bàn giao; tài liệu hóa đầy đủ; có 2 người am hiểu |
| Cấp trên không phê duyệt rollout sau pilot | Trung bình | Cao | Pilot phải đạt KPI rõ ràng và có demo trực quan |
| Vượt ngân sách | Thấp | Trung bình | Có 10% dự phòng; review chi phí hàng tháng |

---

## IX. ĐỘI NGŨ VÀ TRÁCH NHIỆM

### 9.1. Cơ cấu nhân sự đề xuất

| Vai trò | Người | Trách nhiệm | Thời gian tham gia |
|---------|--------|-------------|--------------------|
| Chủ nhiệm dự án | (Quản lý phòng KT) | Phê duyệt, báo cáo cấp trên | Toàn bộ |
| Kỹ thuật trưởng | Đội KT hiện có (mạnh PLC/điện) | Lập trình PLC, thiết kế tủ, giám sát thi công | Toàn bộ |
| Freelancer DevOps/Node.js | Tuyển ngoài | Setup server, code, troubleshoot | 4 tháng full-time + 12 tháng on-call |
| Đội thi công | Đội cơ điện hiện có | Lắp đặt tủ tại hiện trường | Tháng 4–11 |
| Vận hành viên | 2 nhân viên trực ca | Theo dõi dashboard, xử lý cảnh báo | Sau go-live |

### 9.2. Phân chia trách nhiệm rõ ràng

- **Đội KT nội bộ:** mạnh sẵn, làm phần PLC, điện, thi công, mua sắm.
- **Freelancer:** làm phần server + code + DevOps mà nội bộ chưa có chuyên môn.
- **Sau pilot:** đào tạo 1 nhân viên IT nội bộ để giảm phụ thuộc freelancer dài hạn.

---

## X. KIẾN NGHỊ VÀ KẾT LUẬN

### 10.1. Kiến nghị

1. **Phê duyệt ngân sách pilot 15 triệu đồng** cho **1 trạm thử nghiệm trong 2 tháng đầu** trước khi quyết định triển khai diện rộng. Đây là khoản đầu tư rủi ro thấp giúp xác nhận khả thi.
2. **Tuyển 1 freelancer DevOps/Node.js** ngay trong tháng 1 (ngân sách ~15tr cho 1 tháng đầu) để chạy POC song song với chuẩn bị pilot.
3. **Phân công 1 đầu mối nội bộ** chịu trách nhiệm xuyên suốt dự án để đảm bảo tiến độ và bàn giao tri thức.
4. **Tổ chức buổi demo cho lãnh đạo** vào cuối tháng 2 sau khi pilot 1 trạm chạy ổn, để quyết định mở rộng giai đoạn tiếp.

### 10.2. Kết luận

Đề xuất này dựa trên công nghệ đã trưởng thành, chi phí hợp lý, rủi ro được kiểm soát qua mô hình pilot trước rollout. Hệ thống được thiết kế để **không ảnh hưởng đến vận hành đèn hiện tại** (PLC vẫn độc lập), đảm bảo an toàn cho dịch vụ công.

ROI dự kiến hoàn vốn trong khoảng **5–6 tháng** sau khi triển khai đủ 50 trạm. Sau hoàn vốn, hệ thống tiếp tục mang lại giá trị về chất lượng dịch vụ, hình ảnh đơn vị và nền tảng cho các tính năng smart city trong tương lai.

**Đề nghị cấp có thẩm quyền xem xét, phê duyệt giai đoạn pilot.**

---

## PHỤ LỤC A. SƠ ĐỒ CHI TIẾT

### A.1. Sơ đồ vật lý tại 1 tủ điện

```
┌────────────────────────────────────────────────────────┐
│  TỦ ĐIỆN CHIẾU SÁNG (hiện hữu)                         │
│                                                         │
│  ┌──────────────────┐         ┌────────────────────┐   │
│  │ LOGO! 230RCE     │ Ethernet │ TỦ PHỤ IP65 (mới) │   │
│  │ - Chương trình   │ ──CAT5──→│                     │   │
│  │   bật/tắt theo   │          │  Raspberry Pi      │   │
│  │   lịch hiện hữu  │          │  + USB 4G dongle   │   │
│  │ - Modbus Slave   │          │  + Adapter 5V/3A   │   │
│  │   (mới enable)   │          │                     │   │
│  └──────────────────┘          └─────────┬───────────┘   │
│         │                                │                │
│         ▼                                ▼ 4G/internet    │
│  Contactor → Đèn                  Server trung tâm        │
└────────────────────────────────────────────────────────┘
```

### A.2. Sơ đồ luồng dữ liệu

```
[Người dùng] → HTTPS → [Web/PWA] → [Server VPS]
                                       │
                                       ├─ REST API (lệnh điều khiển)
                                       ├─ WebSocket (push state realtime)
                                       └─ MQTT broker (Aedes)
                                              ↕ MQTT/TLS
                                       [Gateway tại tủ]
                                              ↕ Modbus TCP
                                       [PLC LOGO!]
                                              ↕ Digital I/O
                                       [Contactor → Đèn]
```

## PHỤ LỤC B. BOM PHẦN CỨNG ĐỀ XUẤT (1 TỦ)

| STT | Mặt hàng | Model gợi ý | Số lượng | Đơn giá (đ) | Nhà cung cấp tham khảo |
|-----|----------|-------------|----------|-------------|-------------------------|
| 1 | Single-board computer | Raspberry Pi Zero 2 W | 1 | 600.000 | Cytron VN, Hshop |
| 2 | USB 4G modem | Huawei E3372h-320 (stick mode) | 1 | 500.000 | Tiki, Shopee |
| 3 | SIM 4G IoT (data only) | Viettel/MobiFone gói IoT | 1 | 30.000/tháng | Đại lý nhà mạng |
| 4 | Thẻ nhớ microSD | SanDisk Industrial 32GB | 1 | 250.000 | Phong Vũ |
| 5 | Adapter cấp nguồn | 5V/3A micro-USB | 1 | 150.000 | Phong Vũ |
| 6 | Cáp Ethernet CAT6 | 2m | 1 | 80.000 | Phong Vũ |
| 7 | Tủ phụ chống ẩm | IP65 200×150×100mm | 1 | 350.000 | Cơ điện địa phương |
| 8 | Cảm biến nhiệt độ trong tủ (tùy chọn) | DS18B20 | 1 | 50.000 | Cytron VN |
| 9 | Quạt 5V tản nhiệt (tùy chọn) | 40×40mm | 1 | 80.000 | Phong Vũ |
| | **TỔNG PHẦN CỨNG/TỦ** | | | **~2.090.000** | |
| | + Công thi công | | | **1.000.000** | |
| | **TỔNG/TỦ** | | | **~3.000.000đ** | |

## PHỤ LỤC C. CHECKLIST NGHIỆM THU PILOT 1 TRẠM

- [ ] Gateway boot tự động khi mất điện và có lại
- [ ] PLC tự chạy chương trình bình thường khi mất 4G
- [ ] Lệnh ON/OFF từ web app thực thi tại tủ trong <3 giây
- [ ] Trạng thái contactor cập nhật trên dashboard trong <5 giây
- [ ] LWT phát "offline" khi rút dây 4G
- [ ] Đăng nhập sai mật khẩu 5 lần bị tạm khóa (rate limit)
- [ ] Token gateway không hiển thị trong log server
- [ ] Backup DB chạy thành công lúc 02:00 hàng ngày
- [ ] Cảnh báo Telegram nhận được trong vòng 1 phút khi tủ offline
- [ ] Vận hành 30 ngày liên tục với uptime ≥98%

---

*Tài liệu này được soạn theo định dạng Markdown, có thể convert sang Word/PDF bằng Pandoc hoặc dán trực tiếp vào Google Docs để chia sẻ với cấp trên.*

```bash
# Convert sang PDF (cần cài Pandoc + LaTeX)
pandoc de-xuat-ky-thuat.md -o de-xuat-ky-thuat.pdf --pdf-engine=xelatex -V mainfont="Times New Roman"

# Convert sang Word
pandoc de-xuat-ky-thuat.md -o de-xuat-ky-thuat.docx
```
