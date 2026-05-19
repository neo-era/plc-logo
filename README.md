# PLC LOGO! 230RCE — Hệ thống điều khiển & giám sát

Repo này gồm **4 thành phần** để giao tiếp / điều khiển PLC Siemens LOGO! 8 (0BA8) từ web/PWA. Có thể dùng riêng từng phần tùy quy mô:

| # | Thành phần | Dùng khi nào | Triển khai ở đâu |
|---|------------|--------------|------------------|
| 1 | [`plc.html`](plc.html) | Web UI standalone — 3 chế độ kết nối (Demo / Modbus Proxy / LOGO! Web) | Browser bất kỳ |
| 2 | [`local-proxy/`](local-proxy/) | 1 PC + 1 PLC trên cùng LAN, muốn UI custom (`plc.html`) qua Modbus | PC vận hành |
| 3 | [`gateway/`](gateway/) | Nhiều trạm phân tán qua 4G, đẩy data về server trung tâm | Raspberry Pi tại mỗi trạm |
| 4 | [`server/`](server/) | Server trung tâm cho hệ đa trạm (MQTT broker + REST + WS + DB) | VPS Docker |

```
                 1 PC + 1 PLC                              Nhiều trạm + 1 VPS trung tâm
┌─────────────┐                                   ┌──────────────┐    ┌──────────────────┐    ┌──────────┐
│  Browser    │                                   │ PLC LOGO!    │    │ Gateway (RasPi)  │    │ Server   │
│  plc.html   │                                   │ tại tủ A     │←──→│ gateway.js + 4G  │←──→│ Aedes +  │
└──────┬──────┘                                   └──────────────┘    └──────────────────┘    │ Express +│
       │                                                                                       │ SQLite + │
       ↓ HTTP localhost                            ┌──────────────┐    ┌──────────────────┐    │ JWT + WS │
┌─────────────┐                                    │ PLC LOGO!    │    │ Gateway (RasPi)  │←──→│          │
│ local-proxy │  ← (PC vận hành)                   │ tại tủ B     │←──→│ gateway.js + 4G  │    │ public/  │
│ proxy.js    │                                    └──────────────┘    └──────────────────┘    │ plc.html │
└──────┬──────┘                                          ...                  ...              │ (multi-  │
       │ Modbus TCP                                                                            │  station)│
       ↓                                                                                       └──────────┘
┌─────────────┐                                                                                     │
│ PLC LOGO!   │                                                                                     ↓
│ 230RCE      │                                                                              ┌──────────┐
└─────────────┘                                                                              │ Browser  │
                                                                                             │ (cloud)  │
                                                                                             └──────────┘
```

---

## Quick start theo kịch bản

### Kịch bản A — 1 PC + 1 PLC tại bàn (test / vận hành đơn)

Chỉ cần `local-proxy/` + `plc.html`:

```bash
# 1. Trong LOGO! Soft Comfort: enable Modbus Slave + transfer chương trình
#    (Tools → Transfer → Configure Modbus Slave → Enable + Transfer xuống PLC)

# 2. Chạy proxy trên PC
cd local-proxy
npm install
node proxy.js --plc-host 192.168.0.3

# 3. Mở plc.html trong browser
#    → ⚙ Cài đặt → Chế độ "Modbus Local Proxy" → URL http://localhost:3001 → Lưu
```

Chi tiết: [local-proxy/README.md](local-proxy/README.md)

### Kịch bản B — Nhiều trạm phân tán

Cần `gateway/` (mỗi trạm) + `server/` (1 VPS):

```bash
# === Trên VPS ===
cp server/.env.example server/.env       # đổi JWT_SECRET, ADMIN_PASS
docker compose up -d
# Mở http://<vps-ip>:8080 → đăng nhập admin → tab Quản trị → tạo trạm → copy gatewayToken

# === Trên RasPi tại mỗi trạm ===
cd gateway
npm install
cp config.example.json config.json       # paste stationId + gatewayToken từ server
node gateway.js                           # test trước
sudo cp systemd/plc-gateway.service /etc/systemd/system/
sudo systemctl enable --now plc-gateway
```

Chi tiết kiến trúc: [docs/architecture.md](docs/architecture.md)

### Kịch bản C — Chỉ xem qua trang built-in của Siemens

Không cần repo này. Mở browser → `http://<ip-plc>` → đăng nhập user/pass đã setup trong Soft Comfort.

---

## Yêu cầu phần cứng / phần mềm

- **PLC**: LOGO! 230RCE **0BA8** trở lên (model cũ 0BA7 không hỗ trợ Modbus Slave). Mã: `6ED1052-2HB00-0BA8`.
- **Soft Comfort**: V8.0+ để cấu hình Modbus.
- **Local Proxy / Gateway**: Node.js 20+.
- **Server**: VPS Linux + Docker (Hetzner CX22 ~$5/th là đủ cho 50 trạm).
- **Gateway tại trạm** (Kịch bản B): Raspberry Pi Zero 2W + USB 4G dongle, hoặc 4G router công nghiệp (Teltonika RUT240).

---

## Tài liệu

- [docs/architecture.md](docs/architecture.md) — sơ đồ chi tiết, MQTT topic schema, DB schema, failure modes, scale-out.
- [docs/de-xuat-ky-thuat.md](docs/de-xuat-ky-thuat.md) — bản đề xuất kỹ thuật trang trọng (50 trạm/12 tháng, ngân sách, ROI, KPI). [Có sẵn .docx](docs/de-xuat-ky-thuat.docx) để thuyết trình.
- [local-proxy/README.md](local-proxy/README.md) — hướng dẫn cài + auto-start Windows + troubleshoot.

---

## Bảng địa chỉ LOGO! ↔ Modbus

| LOGO! | Modbus | FC đọc/ghi |
|-------|--------|------------|
| `I1..I24` | Discrete Input 0..23 | 02 / — |
| `Q1..Q20` | Coil 8192..8211 | 01 / 05 |
| `M1..M64` | Coil 8256..8319 | 01 / 05 |
| `VW0..n` | Holding Register 0..n/2 | 03 / 06 |
| `AI1..8` | Input Register 1..8 | 04 / — |
| `AQ1..8` | Holding Register 513..520 | 03 / 06 |

Cả `local-proxy/proxy.js` lẫn `gateway/gateway.js` đều dùng mapping này — bạn chỉ cần gọi địa chỉ kiểu LOGO! (`Q1`, `VW0`), không phải lo Modbus address.

---

## License

MIT — sử dụng tự do cho mục đích thương mại / phi thương mại. Không bảo hành.

## Liên hệ / đóng góp

PR welcome. Issue/bug: mở GitHub Issues của repo này.
