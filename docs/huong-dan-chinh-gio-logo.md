# Hướng dẫn chỉnh giờ tủ điều khiển LOGO! – chương trình NisseLOGOProgram_V2-ELR

*Ngày lập: 09/11/2026*

## 1. Phạm vi và lưu ý trước khi làm

- Áp dụng cho tủ dùng bộ điều khiển Siemens LOGO! 8 (có đồng hồ thời gian thực) chạy chương trình **NisseLOGOProgram_V2-ELR.lld**, lập bằng LOGO!Soft Comfort V8.
- "Chỉnh giờ" gồm 2 việc khác nhau, cần phân biệt:
    - **Chỉnh đồng hồ của LOGO!** (ngày, thứ, giờ hiện tại) — khi đồng hồ chạy sai, sau mất điện lâu, thay LOGO!.
    - **Chỉnh giờ bật/tắt** trong các khối hẹn giờ (Weekly Timer, Yearly Timer, Astronomical Clock) — khi cần đổi lịch đóng/cắt đèn.
- Luôn chỉnh đồng hồ đúng trước, rồi mới kiểm tra giờ bật/tắt; đồng hồ sai thì lịch đúng vẫn đóng/cắt sai.
- Trước khi sửa: ghi lại (chụp ảnh màn hình LOGO!) toàn bộ thông số cũ để có thể trả lại khi cần.
- Khi nạp chương trình từ máy tính, LOGO! chuyển sang STOP, các ngõ ra Q sẽ cắt trong lúc nạp — chọn thời điểm ban ngày, báo trước cho đơn vị quản lý tuyến.

## 2. Phím bấm trên mặt LOGO!

| Phím | Tác dụng |
|---|---|
| ESC | Vào menu (khi đang RUN) / quay lại |
| ▲ ▼ | Chọn mục menu / tăng-giảm giá trị |
| ◄ ► | Di chuyển con trỏ sang vị trí kế tiếp |
| OK | Xác nhận |

## 3. Chỉnh đồng hồ thực của LOGO! (ngày, thứ, giờ)

### Cách A – Trên mặt LOGO! (không cần máy tính)

1. Khi LOGO! đang RUN, nhấn **ESC** để vào menu tham số.
2. Dùng ▲▼ chọn **Set..** (đời LOGO! 8 có thể hiển thị là **Setup**), nhấn **OK**.
3. Chọn **Clock** → **OK** → chọn **Set Clock** → **OK**.
4. Màn hình hiện thứ, giờ và ngày (dạng `Mo 15:30` / `YYYY-MM-DD`). Con trỏ đứng ở ô thứ trong tuần.
5. Dùng ▲▼ đổi giá trị, ◄► sang ô kế tiếp: thứ → giờ → phút → năm → tháng → ngày.
6. Nhấn **OK** để lưu. Nhấn ESC nhiều lần để về màn hình chính, kiểm tra giờ hiển thị.

### Cách B – Từ máy tính bằng LOGO!Soft Comfort

1. Nối cáp mạng máy tính với cổng Ethernet của LOGO!, mở LOGO!Soft Comfort và file NisseLOGOProgram_V2-ELR.lld.
2. Vào **Tools → Transfer → Set Clock…**, chọn đúng LOGO! (theo địa chỉ IP).
3. Lấy giờ theo máy tính (đảm bảo máy tính đang đúng giờ Việt Nam), hoặc nhập tay, rồi xác nhận gửi xuống LOGO!.
4. Cách này **không làm LOGO! dừng chương trình**.

### Giờ mùa hè/mùa đông (Summer/Winter time)

Việt Nam không đổi giờ theo mùa. Kiểm tra mục **Clock → S/W Time** trên LOGO! (hoặc **Tools → Transfer → Summertime/Wintertime** trên Soft Comfort) phải để **Off**. Nếu để On (EU/US…), LOGO! sẽ tự nhảy 1 giờ vào tháng 3 và tháng 10, làm đèn bật/tắt lệch 1 giờ.

### Đồng bộ giờ tự động (nếu tủ có mạng)

LOGO! 8 hỗ trợ đồng bộ giờ qua mạng (NTP) trong mục Clock → Sync / cài đặt online trong Soft Comfort. Chỉ bật khi tủ có kết nối mạng ổn định và đặt múi giờ **UTC+7**.

## 4. Chỉnh giờ bật/tắt đèn

### 4.1 Xác định khối hẹn giờ trong chương trình

Mở chương trình trong Soft Comfort, tìm các khối có biểu tượng đồng hồ (thường đặt tên B001, B002…):

| Loại khối | Dùng để | Thông số chỉnh |
|---|---|---|
| Weekly Timer (hẹn giờ tuần) | Bật/tắt theo giờ cố định từng thứ trong tuần | Mỗi khối có 3 "Cam": ngày (D=), giờ bật (On), giờ tắt (Off) |
| Yearly Timer (hẹn giờ năm) | Chạy theo khoảng ngày/tháng | Ngày bắt đầu, ngày kết thúc |
| Astronomical Clock (đồng hồ thiên văn) | Bật theo hoàng hôn, tắt theo bình minh | Kinh độ, vĩ độ, múi giờ, độ lệch (offset) phút |

Ghi lại: khối nào điều khiển ngõ ra nào (Q1 – đèn cả đêm, Q2 – đèn nửa đêm…) để chỉnh đúng khối.

### 4.2 Chỉnh trên mặt LOGO! (không cần dừng chương trình)

1. Khi LOGO! đang RUN, nhấn **ESC** → chọn **Set Param** → **OK**.
2. Danh sách các khối cho phép chỉnh hiện ra. Dùng ▲▼ chọn khối hẹn giờ cần sửa (ví dụ B001) → **OK**.
3. Với Weekly Timer, màn hình hiện Cam 1, dạng:
    - `D=MTWTFSS` — các thứ có hiệu lực (M=Thứ Hai … S=Chủ nhật; dấu `–` là không chạy thứ đó)
    - `On =18:00` — giờ bật
    - `Off=05:30` — giờ tắt
4. Dùng ◄► di chuyển con trỏ đến giá trị cần đổi, ▲▼ để thay đổi, **OK** để lưu.
5. Chuyển sang Cam 2, Cam 3 (nhấn ▼/► sang trang kế tiếp) nếu khối dùng nhiều cam; làm tương tự.
6. Nhấn ESC để về, quan sát ngõ ra Q tương ứng có đóng/cắt đúng không.

> Nếu khối cần sửa **không có trong danh sách Set Param**, khối đó đang bị khóa chỉnh tham số (bảo vệ). Khi đó phải sửa bằng Soft Comfort theo mục 4.3.

> Lưu ý giờ qua đêm: với Weekly Timer, đặt On=18:00, Off=05:30 vẫn chạy được qua 0 giờ; nhưng cột D= phải chọn đúng ngày bắt đầu bật (ví dụ chọn đủ 7 ngày để đêm nào cũng bật).

### 4.3 Chỉnh bằng LOGO!Soft Comfort (khi cần sửa nhiều hoặc khối bị khóa)

1. Nên **đọc chương trình đang chạy từ LOGO! về** trước (**Tools → Transfer → LOGO! → PC**) và lưu thành file mới có ngày tháng, để chắc chắn đang sửa đúng bản trong tủ.
2. Nhấp đúp vào khối hẹn giờ cần sửa → thẻ **Parameter**.
3. Weekly Timer: chọn Cam 1/2/3, tích các thứ, nhập giờ bật/tắt. Astronomical Clock: kiểm tra vị trí TP.HCM (vĩ độ khoảng 10,8° Bắc, kinh độ khoảng 106,7° Đông), múi giờ UTC+7, rồi chỉnh **offset** (phút) nếu muốn bật sớm/tắt muộn hơn giờ hoàng hôn/bình minh.
4. Nhấn **OK**, lưu file (**File → Save As**, đặt tên có ngày, ví dụ `NisseLOGOProgram_V2-ELR_2026-11-09.lld`).
5. Thử bằng chế độ mô phỏng (**Simulation**, phím F3) để xem đèn bật/tắt đúng giờ.
6. Nạp xuống LOGO!: **Tools → Transfer → PC → LOGO!** (Ctrl+D), chọn LOGO! theo IP, đồng ý chuyển STOP.
7. Sau khi nạp, chọn chuyển LOGO! sang **RUN**. Kiểm tra lại đồng hồ (mục 3) vì một số trường hợp cần đặt lại.

## 5. Kiểm tra sau khi chỉnh

- Màn hình LOGO! hiển thị đúng thứ, ngày, giờ Việt Nam.
- S/W Time = Off.
- Thông số từng khối hẹn giờ đúng lịch mới (đối chiếu ảnh chụp trước/sau).
- Theo dõi ít nhất 1 lần bật (chiều tối) và 1 lần tắt (sáng sớm) đầu tiên: đèn đóng/cắt đúng giờ, đúng nhánh (cả đêm/nửa đêm).
- Ghi sổ nhật ký tủ: ngày chỉnh, người chỉnh, giờ cũ → giờ mới, lý do.

## 6. Sự cố thường gặp

| Hiện tượng | Nguyên nhân hay gặp | Cách xử lý |
|---|---|---|
| Đèn bật/tắt lệch đúng 1 giờ | S/W Time đang bật | Đặt S/W Time = Off (mục 3) |
| Sau mất điện lâu, giờ bị sai/về mặc định | Hết thời gian lưu đồng hồ khi mất nguồn | Đặt lại đồng hồ; cân nhắc lắp module pin/đồng bộ NTP |
| Không thấy khối trong Set Param | Khối bị bảo vệ tham số | Sửa bằng Soft Comfort (mục 4.3) |
| Sửa trên máy tính xong nhưng tủ không đổi | Chưa nạp xuống hoặc nạp sai LOGO! (sai IP) | Nạp lại, kiểm tra IP; đọc chương trình về để đối chiếu |
| Đêm có đêm không bật | Cột D= chưa chọn đủ các thứ | Chọn đủ 7 ngày (MTWTFSS) |

## 7. Đọc màn hình chính của tủ – ví dụ tủ LUC02

Màn hình chính của LOGO! 230RCE (6ED1052-1FB08-0BA2) trong tủ hiển thị dạng:

```
2020-03-01 LUC02
Su 00:00        0
1 19:45 05:45   1
2 17:46 05:45   1
3 18:00 04:00
www.LAVIPCO.TECH
```

| Dòng | Ý nghĩa (theo ảnh chụp thực tế tại tủ) |
|---|---|
| `2020-03-01 LUC02` | Ngày hiện tại của đồng hồ LOGO! và tên tủ |
| `Su 00:00` | Thứ và giờ hiện tại của đồng hồ LOGO! |
| `1 19:45 05:45` | Lịch mạch/nhánh 1: giờ bật – giờ tắt |
| `2 17:46 05:45` | Lịch mạch/nhánh 2: giờ bật – giờ tắt |
| `3 18:00 04:00` | Lịch mạch/nhánh 3: giờ bật – giờ tắt |

> **Dấu hiệu đồng hồ đã mất giờ:** ngày hiện `2020-03-01` (hoặc một ngày cũ bất kỳ) và giờ đứng ở `00:00`. Đây là trạng thái sau khi LOGO! mất nguồn quá lâu (theo Siemens, LOGO! 8 giữ được giờ khoảng 20 ngày khi mất điện). Khi đó lịch bật/tắt vẫn còn nhưng tủ sẽ đóng/cắt sai giờ → **phải làm ngay mục 3 (chỉnh đồng hồ)**, sau đó đối chiếu lại các dòng 1–3 với lịch vận hành được duyệt.
