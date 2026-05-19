# Kiến trúc & giao thức

## Sơ đồ luồng dữ liệu

```
                       (LAN nội bộ trạm)                  (Internet 4G/WiFi)              (Internet HTTPS)
┌──────────────┐  Modbus TCP :502  ┌──────────────────┐   MQTT/TLS :8883   ┌────────────────────┐  REST + WS  ┌────────────┐
│ LOGO! 230RCE │ ←───────────────→ │ Gateway (gateway.js)│ ←──────────────→ │ Server trung tâm    │ ←─────────→ │ Web UI     │
│  Modbus Slave│                    │ + 4G dongle/router │                   │ Aedes broker +      │              │ plc.html   │
└──────────────┘                    └──────────────────┘                   │ Express + SQLite     │              └────────────┘
                                                                            │ + WebSocket realtime │
                                                                            └────────────────────┘
```

## MQTT topic schema

Tất cả topic theo namespace **`dentat/<stationId>/...`**. ACL trong Aedes chặn cứng — gateway của trạm A không thể publish/subscribe topic của trạm B.

| Topic | Producer | Consumer | QoS | Retain | Payload |
|-------|----------|----------|-----|--------|---------|
| `dentat/<id>/state` | Gateway | Server | 1 | ✅ | `{ ts, stationId, I:{}, Q:{}, M:{}, V:{} }` — trạng thái mới nhất |
| `dentat/<id>/state/history` | Gateway | Server | 1 | — | giống state, nhưng cũ (gửi sau khi reconnect) |
| `dentat/<id>/cmd` | Server | Gateway | 1 | — | `{ id, addr, value, ts, by }` — lệnh ghi PLC |
| `dentat/<id>/ack` | Gateway | Server | 1 | — | `{ id, addr, ts, ok, error? }` — kết quả lệnh |
| `dentat/<id>/online` | Gateway (+ LWT) | Server | 1 | ✅ | `{ stationId, online: true\|false, ts, name? }` |

**Last Will Testament**: gateway khai báo LWT là `online=false` trên topic online (retain). Khi gateway mất mạng đột ngột, broker tự publish LWT → server biết trạm offline mà không cần timeout heartbeat.

**Retained state**: client web mới connect WS lấy state hiện tại qua REST `/api/stations` (đọc từ DB column `last_state`). Khi có update mới, server forward qua WS.

## REST API

Base: `http://<server>:8080/api` — production phải dùng HTTPS qua reverse proxy.

| Method | Endpoint | Auth | Mô tả |
|--------|----------|------|-------|
| POST | `/login` | — | `{ username, password }` → `{ token, user }` |
| GET  | `/stations` | user | Liệt kê trạm + state hiện tại + online |
| POST | `/stations` | admin | Tạo trạm mới → trả về `gatewayToken` **chỉ 1 lần** |
| DELETE | `/stations/:id` | admin | Xóa trạm + history |
| POST | `/stations/:id/cmd` | user | `{ addr, value }` → publish MQTT cmd, trả `cmdId` |
| GET  | `/stations/:id/history?limit=200` | user | Mẫu state lưu trong DB |
| GET  | `/stations/:id/commands?limit=50` | user | Log lệnh đã gửi + trạng thái ACK |

## WebSocket

`ws://<server>:8080/ws?token=<JWT>` — push events realtime:

```json
{ "type": "state",  "stationId": "STN-001", "data": { ts, I, Q, M, V } }
{ "type": "online", "stationId": "STN-001", "online": true }
{ "type": "ack",    "stationId": "STN-001", "data": { id, addr, ok, error? } }
```

UI nên debounce render khi nhiều trạm đẩy state cùng lúc.

## Cơ sở dữ liệu (SQLite)

```sql
users      (id, username UNIQUE, pass_hash, role, created_at)
stations   (id PK, name, region, token_hash, config_json, online, last_seen, last_state, created_at)
commands   (id, cmd_id, station_id, addr, value, by_user, status, error, sent_at, ack_at)
history    (id, station_id, ts, state_json)   -- index trên (station_id, ts DESC)
```

GC chạy mỗi 6h: xóa history > `HISTORY_RETENTION_DAYS` (mặc định 30) và quá `HISTORY_MAX_PER_STATION` (10000) mỗi trạm.

## Auth & secret

- **User**: bcrypt hash, JWT 7 ngày, role `admin` hoặc `operator`. Chỉ admin tạo/xóa trạm.
- **Gateway**: token 24-byte hex sinh khi tạo trạm. Server lưu bcrypt hash → token chỉ trả về **1 lần khi tạo** (admin phải copy ngay). Đặt làm cả `mqtt.password` và `gatewayToken` trong `config.json`.
- **MQTT ACL**: thực thi trong Aedes — gateway chỉ thấy topic của chính nó.
- **Internal**: server tự sinh `INTERNAL_SECRET` random mỗi lần boot (chỉ trong RAM). Internal MQTT client của server bypass DB lookup.

## Mở rộng quy mô

| Khi quy mô đạt | Vấn đề | Giải pháp |
|----------------|--------|-----------|
| >500 trạm | SQLite write bottleneck cho history | Tách `history` sang InfluxDB/Timescale |
| >1000 trạm | Aedes single-thread | Đổi sang EMQX hoặc cluster nodes-mqtt |
| >5 admin | Race condition khi tạo trạm | Postgres + advisory lock |
| Phân quyền chi tiết | role chỉ có admin/operator | Thêm bảng `regions` và mapping `user_regions` |

## Failure modes

| Sự cố | Triệu chứng | Hành vi |
|-------|-------------|---------|
| Mất 4G tại trạm | Gateway buffer state vào RAM | Khi reconnect, gửi qua topic `state/history` → server backfill DB |
| Gateway crash | LWT phát online=false | Server đánh dấu offline, UI hiện chấm xám |
| PLC mất nguồn | Modbus connect fail | Gateway thử lại mỗi 5s, log `[modbus]` |
| Server down | Tất cả gateway buffer (max 200 mẫu) | Khi server lên lại, gateway reconnect MQTT + đẩy backlog |
| Token rò rỉ | Kẻ tấn công publish state giả | Admin xóa trạm → tạo lại với token mới, redeploy gateway |
