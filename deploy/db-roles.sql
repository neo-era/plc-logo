-- Chạy một lần bằng tài khoản quản trị Postgres, SAU khi chạy server/db/001_plc.sql
-- Thay mật khẩu bằng giá trị trong .env (PLC_DB_PASSWORD)
create role plc_svc login password 'THAY_MAT_KHAU' in role plc_app;
grant usage on schema core to plc_svc;
grant select (id, is_active, token_version) on core.users to plc_svc;
