# local-proxy — HTTP ↔ Modbus TCP bridge cho LOGO! 8

Proxy Node.js nhỏ chạy trên PC vận hành. Browser ([plc.html](../plc.html)) không nói được Modbus TCP raw, nên gọi qua HTTP `localhost:3001` → proxy này nói Modbus với PLC.

```
Browser (plc.html)  ──HTTP localhost:3001──▶  proxy.js  ──Modbus TCP──▶  LOGO! 230RCE
```

## Cài đặt

```powershell
cd local-proxy
npm install
```

## Chạy

```powershell
node proxy.js --plc-host 192.168.0.3
```

CLI flags (tất cả optional, có default):

| Flag | Default | Mô tả |
|------|---------|------|
| `--plc-host`  | `192.168.0.3` | IP của LOGO! |
| `--plc-port`  | `502`         | Port Modbus TCP |
| `--slave-id`  | `1`           | Modbus slave ID |
| `--port`      | `3001`        | Port HTTP của proxy |
| `--timeout`   | `2000`        | Modbus timeout (ms) |

Cũng có thể dùng env var: `PLC_HOST`, `PLC_PORT`, `SLAVE_ID`, `HTTP_PORT`, `TIMEOUT`.

Khi log hiện:
```
[modbus] ✓ kết nối 192.168.0.3:502 (slave 1)
[http] sẵn sàng — http://localhost:3001
```
là OK. Sau đó mở [../plc.html](../plc.html) → ⚙ **Cài đặt** → Chế độ = **Modbus Local Proxy**, URL = `http://localhost:3001` → **Lưu & Test**.

## Cấu hình PLC (1 lần)

Trong **LOGO! Soft Comfort**:
1. Tools → Transfer → **Configure Modbus Slave** → Enable.
2. Đặt IP tĩnh cho PLC (vd `192.168.0.3`), khớp với `--plc-host`.
3. Transfer chương trình xuống PLC.
4. Đảm bảo PC và PLC cùng subnet, ping được.

## HTTP API

| Method | Path | Body | Trả về |
|--------|------|------|--------|
| `GET`  | `/health` | — | `{ ok, plcConnected, plcHost, slaveId, uptimeSec }` |
| `POST` | `/read`   | `{ addr }` | `{ addr, value }` |
| `POST` | `/write`  | `{ addr, value }` | `{ ok, addr, value }` |
| `POST` | `/batch`  | `{ points: [{addr,type}] }` | `{ values: { addr:v }, ms, count }` |
| `GET`  | `/time`   | — | `{ pcTimeMs, pcTimeISO, tz, tzOffsetMin }` (PC time, dùng để đồng bộ RTC) |

`addr` là địa chỉ LOGO! gốc — proxy tự ánh xạ sang Modbus address.

**Vùng GHI được (tác động vào PLC từ HMI/browser):**
- `Q1..Q20` — ngõ ra digital
- `M1..M64` — cờ nhớ
- `NI1..NI64` — **Network Input** (vùng bit ảo, được thiết kế để hệ thống ngoài ghi vào chương trình LOGO!)
- `NQ1..NQ64` — Network Output (bit)
- `AQ1..8` — ngõ ra analog
- `AM1..64` — analog marker
- `NAI1..32` / `NAQ1..16` — network analog in/out (word)
- `VW0/VW2/...`, `VB0/VB1/...`, `VD0/VD2/...` — vùng V

**Vùng CHỈ ĐỌC (sensor / nguồn vật lý):**
- `I1..I24` — ngõ vào digital (gắn dây vật lý vào terminal)
- `AI1..8` — ngõ vào analog

Ví dụ với curl:
```powershell
curl http://localhost:3001/health
curl -X POST http://localhost:3001/read  -H "Content-Type: application/json" -d "{\"addr\":\"Q1\"}"
curl -X POST http://localhost:3001/write -H "Content-Type: application/json" -d "{\"addr\":\"Q1\",\"value\":1}"
```

## Đồng bộ RTC PLC từ giờ PC

LOGO! 8 reserved 6 byte trong V-memory cho Real-Time Clock — đọc/ghi trực tiếp qua Modbus:

| VM | Trường | Encoding |
|----|--------|---------|
| VB985 | Year | offset từ 2000 (vd 26 = 2026) |
| VB986 | Month | 1-12 |
| VB987 | Day | 1-31 |
| VB988 | Hour | 0-23 |
| VB989 | Minute | 0-59 |
| VB990 | Second | 0-59 |

UI [plc.html](../plc.html) tab **⏰ Lịch** có sẵn nút **"💾 Ghi giờ PC xuống RTC PLC ngay"** — đồng bộ tức thì, không phụ thuộc NTP. Múi giờ áp dụng từ phía LOGO! (config trong Soft Comfort).

## Auto-start trên Windows (chạy nền khi boot)

**Cách 1 — Task Scheduler (đơn giản nhất):**

1. Mở **Task Scheduler** → Create Task...
2. **General**: tên `PLC Local Proxy`, tick *Run whether user is logged on or not*, *Run with highest privileges*.
3. **Triggers**: New → *At startup*.
4. **Actions**: New → Program: `node`, Arguments: `proxy.js --plc-host 192.168.0.3`, Start in: `C:\Users\<bạn>\Documents\GitHub\plc-logo\local-proxy`.
5. **Settings**: bật *If task fails, restart every 1 minute, attempt up to 3 times*.

**Cách 2 — Dùng `pm2` (có log + auto-restart khi crash):**

```powershell
npm install -g pm2 pm2-windows-startup
pm2-startup install
cd local-proxy
pm2 start proxy.js --name plc-proxy -- --plc-host 192.168.0.3
pm2 save
```
Xem log: `pm2 logs plc-proxy`. Stop: `pm2 stop plc-proxy`.

## Troubleshoot

| Triệu chứng | Nguyên nhân thường gặp | Cách xử lý |
|--------------|------------------------|-----------|
| `[modbus] ✗ không kết nối được ... ETIMEDOUT` | Sai IP, khác subnet, firewall PC chặn outbound 502 | `ping <ip-plc>`. Tắt Windows Defender Firewall thử. |
| `[modbus] ✗ ... ECONNREFUSED` | PLC chưa enable Modbus Slave | Soft Comfort → Tools → Configure Modbus Slave → Enable + transfer lại. |
| Proxy chạy OK nhưng `plcConnected: false` | PLC vừa khởi động hoặc đang transfer | Đợi 5–10s. Proxy tự retry mỗi 5s. |
| `400 Vùng chỉ đọc: I1` | Gọi `/write` lên Discrete Input | I/AI chỉ đọc được. Ghi Q/M/VW/AQ. |
| `400 VW phải là số chẵn` | Gửi `VW1` thay vì `VW0/VW2` | LOGO! V-area địa chỉ theo byte, word phải bắt đầu chẵn. |
| Browser báo `proxy 0` hoặc `Failed to fetch` | URL sai port, hoặc proxy chưa chạy | Kiểm tra log proxy + URL trong ⚙ Cài đặt. |
| `CORS error` | URL trong ⚙ Cài đặt có path lạ | Để đúng `http://localhost:3001`, không trailing slash. |

## Bảng địa chỉ LOGO! ↔ Modbus

| LOGO! | Modbus address | FC đọc | FC ghi | Ghi chú |
|-------|----------------|--------|--------|--------|
| `I1..I24`     | Discrete Input `0..23`     | 02 | — | Ngõ vào vật lý — chỉ đọc |
| `Q1..Q20`     | Coil `8192..8211`          | 01 | 05 | Ngõ ra digital |
| `M1..M64`     | Coil `8256..8319`          | 01 | 05 | Cờ nhớ |
| **`NI1..NI64`** | **Coil `8320..8383`**    | 01 | 05 | **Network Input — vùng bit ảo, GHI ĐƯỢC từ HMI** |
| `NQ1..NQ64`   | Coil `8384..8447`          | 01 | 05 | Network Output |
| `AI1..8`      | Input Register `1..8`      | 04 | — | Ngõ vào analog — chỉ đọc |
| `AQ1..8`      | Holding Register `513..520`| 03 | 06 | Ngõ ra analog |
| `AM1..64`     | Holding Register `529..592`| 03 | 06 | Analog marker |
| `NAI1..32`    | Holding Register `593..624`| 03 | 06 | Network analog input — GHI ĐƯỢC |
| `NAQ1..16`    | Holding Register `625..640`| 03 | 06 | Network analog output |
| `VW0,2,4..`   | Holding Register `0..n/2`  | 03 | 06 | V-area word |
| `VB0,1,2..`   | Holding Register `n/2` (hi/lo byte) | 03 | 06 (read-modify-write) | V-area byte |
| `VD0,2,4..`   | Holding Register `n/2`+`n/2+1` (dword) | 03 | 16 | V-area double word |
| **`V<n>.<m>`** | **Holding Register `n/2` + bit-mask** | 03 | 06 (read-modify-write) | **V-area bit — dùng cho NI/NQ ở chế độ VM mapping** |

> 💡 **NI vs V-bit**: trong **LOGO! Soft Comfort**, block `NI` có 2 chế độ:
> - **Local**: NI đọc từ vùng coil chuẩn (`8320..8383`) → dùng địa chỉ `NI1..NI64`.
> - **VM mapping** (set Parameter = `V0.0`, `V0.1`...): NI đọc từ V-bit → phải ghi vào `V0.0`, `V0.1`... thay vì `NI1`, `NI2`...
>
> Nếu click `NI1` không giữ trạng thái → block đang ở VM mode. Mở Properties block trong Soft Comfort, xem ô Parameter để biết V-bit nào.

## License

MIT — chia sẻ chung với repo gốc.
