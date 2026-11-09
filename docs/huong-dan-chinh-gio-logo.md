# Hướng dẫn chỉnh giờ tủ điều khiển LOGO! – chương trình NisseLOGOProgram_V2-ELR

*Tủ LVC02 – LOGO! 230RCE (6ED1052-1FB08-0BA2) – IP 192.168.0.3 – lập ngày 09/11/2026*

## 1. Các khối hẹn giờ cần chỉnh

| Khối | Điều khiển | Giờ bật | Giờ tắt | Ngày |
|---|---|---|---|---|
| **T001** – B1 timer | K1 (Q2) | 17:45 | 05:45 | MTWTFSS |
| **T002** – B2 timer | K2 (Q3) | 17:46 | 05:45 | MTWTFSS |
| **T006** – HPS timer | K3 (Q4) | 22:00 | 04:00 | MTWTFSS |

Giờ trong bảng là cài đặt gốc trong file chương trình. Mỗi khối chỉ dùng **Cam 1 (No1)**; Cam 2, Cam 3 để trống.

## 2. Kiểm tra trên màn hình tủ

```
2020-03-01  LVC02      ← ngày hiện tại – tên tủ
00:00             0    ← giờ hiện tại – (số lần ELR tác động)
K1: 17:45  05:45  1    ← T001: bật – tắt – trạng thái K1 (1 = đang đóng)
K2: 17:46  05:45  1    ← T002: bật – tắt – trạng thái K2
K3: 22:00  04:00       ← T006: bật – tắt
```

- Dòng 1–2 sai ngày/giờ (ví dụ `2020-03-01`, `00:00`) → đồng hồ đã mất giờ, đèn sẽ đóng/cắt sai, có thể sáng cả ban ngày → làm **mục 3**.
- Dòng K1/K2/K3 cần đổi lịch → làm **mục 4**.

## 3. Chỉnh đồng hồ (ngày, giờ hiện tại)

**Trên mặt LOGO!:**

1. Khi LOGO! đang RUN, nhấn **ESC**.
2. Chọn **Set..** (hoặc **Setup**) → **OK** → **Clock** → **OK** → **Set Clock** → **OK**.
3. Dùng ▲▼ đổi giá trị, ◄► sang ô kế tiếp: thứ → giờ → phút → năm → tháng → ngày.
4. Nhấn **OK** để lưu, ESC về màn hình chính, kiểm tra dòng 1–2.

**Từ máy tính (LOGO!Soft Comfort):** đặt IP máy tính 192.168.0.x (khác .3) → **Tools → Transfer → Set Clock…** → chọn LOGO! 192.168.0.3 → lấy giờ máy tính (phải đúng giờ Việt Nam) → gửi. LOGO! không phải dừng chạy.

**Giờ mùa hè:** mục **Clock → S/W Time** phải để **Off**; nếu để On, đèn lệch 1 giờ từ tháng 3 đến tháng 10.

## 4. Chỉnh giờ bật/tắt

1. Khi LOGO! đang RUN, nhấn **ESC** → **Set Param** → **OK**.
2. Dùng ▲▼ chọn khối: **T001** (K1), **T002** (K2) hoặc **T006** (K3) → **OK**.
3. Màn hình Cam 1 hiện:
    - `D=MTWTFSS` – giữ đủ 7 ngày
    - `On =17:45` – giờ bật
    - `Off=05:45` – giờ tắt
4. Dùng ◄► đưa con trỏ đến giờ/phút cần đổi, ▲▼ thay đổi, **OK** lưu.
5. ESC về màn hình chính, kiểm tra dòng K1/K2/K3 đã hiện giờ mới.

**Cách nhanh – sửa ngay trên màn hình chính:** màn hình K1/K2/K3 là màn hình thông báo SF007, luôn hiện vì chân kích hoạt (En) nối mức High. Các ô giờ trên đó sửa trực tiếp được:

1. Dùng ◄ ► chọn ô giờ cần sửa; ô được chọn sẽ bị bôi đen.
2. Dùng ▲ ▼ đổi giá trị.
3. Nhấn **OK** để lưu, hoặc **ESC** để bỏ, giữ giờ cũ.
4. Nếu ESC đưa vào menu (Stop / Set Param …), nhấn **ESC** thêm lần nữa để về màn hình chính. **Không chọn Stop.**

### Quy tắc khi đặt giờ K1 – K2

Trong chương trình, **K2 chỉ đóng khi K1 đã bật đủ 30 giây** (khối T003), và K2 cắt theo khi K1 cắt. Vì vậy:

| Quy tắc | Nếu đặt sai |
|---|---|
| Giờ bật T002 ≥ giờ bật T001 + 1 phút | K2 vẫn phải chờ K1 bật 30 giây mới đóng |
| Giờ tắt T002 ≤ giờ tắt T001 | K2 tắt cùng K1, phần giờ đặt muộn hơn không có tác dụng |
| T006 (K3) đặt tự do | K3 độc lập, không phụ thuộc K1, K2 |
| Giờ qua đêm (bật 17:45, tắt 05:45) đặt bình thường | Khối hẹn giờ tự hiểu khoảng qua 0 giờ |

> **Tủ LVC02:** ảnh chụp màn hình ngày 09/11/2026 có vẻ đang hiện K1 bật **19:45** (file gốc là 17:45). Nếu đúng vậy thì K2 dù đặt 17:46 cũng chỉ sáng từ **19:45:30**. Cần đặt lại T001 theo lịch được duyệt.

### Chỉnh bằng LOGO!Soft Comfort (khi cần)

1. **Tools → Transfer → LOGO! → PC** để đọc chương trình đang chạy về, lưu file mới có ngày tháng.
2. Nhấp đúp khối **T001 / T002 / T006** → sửa Cam 1 → **OK** → lưu file.
3. **Tools → Transfer → PC → LOGO!** để nạp xuống 192.168.0.3. Trong lúc nạp LOGO! dừng chạy, các khởi động từ cắt → nên làm ban ngày.
4. Chuyển LOGO! sang **RUN**, kiểm tra lại đồng hồ và các dòng K1/K2/K3.

Sửa trên mặt LOGO! thì file trên máy tính không tự cập nhật. Sau khi chỉnh tại tủ, nên đọc chương trình về lưu lại để hồ sơ khớp với thực tế.

## 5. Kiểm tra sau khi chỉnh

- Màn hình đúng ngày, giờ Việt Nam; S/W Time = Off.
- Dòng K1/K2/K3 đúng lịch mới, thỏa quy tắc K1 – K2 ở mục 4.
- Lần bật đầu tiên: K1 đóng đúng giờ, K2 đóng sau khoảng 30 giây (hoặc đúng giờ T002 nếu muộn hơn), K3 đúng giờ T006. Lần tắt đầu tiên đúng giờ.
- Ghi sổ nhật ký tủ: ngày chỉnh, người chỉnh, giờ cũ → giờ mới.
