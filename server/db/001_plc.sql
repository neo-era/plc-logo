-- Lược đồ dịch vụ plc trên LAVIPCO Server (Postgres 16).
-- Chạy bằng vai trò chủ sở hữu (migrate). Dịch vụ chạy bằng vai trò plc_app: chỉ SELECT/INSERT (và UPDATE ở bảng trạng thái).
-- Schema plc KHÔNG được mở qua PostgREST — mọi ghi đi qua /plc.

create schema if not exists plc;

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'plc_app') then create role plc_app nologin; end if;
end $$;

create table if not exists plc.stations (
  id            text primary key check (id ~ '^[A-Z0-9-]{1,32}$'),
  name          text not null,
  key_hash      text,                         -- scrypt$N$r$p$salt$hash (base64)
  key_ver       int  not null default 0,
  next_seq      bigint not null default 1,
  schedule      jsonb,
  last_state    jsonb,
  last_state_at timestamptz,
  online        boolean not null default false,
  created_at    timestamptz not null default now()
);

create table if not exists plc.station_users (
  station_id text not null references plc.stations(id),
  user_id    text not null,
  primary key (station_id, user_id)
);

-- Lệnh: bất biến sau khi tạo
create table if not exists plc.commands (
  cmd_id     uuid primary key,
  station_id text not null references plc.stations(id),
  seq        bigint not null,
  circuit    text not null check (circuit in ('K1','K2','K3')),
  mode       text not null check (mode in ('on','off','auto')),
  until_at   timestamptz,
  issued_at  timestamptz not null,
  expires_at timestamptz not null,
  issued_by  text not null,
  note       text,
  unique (station_id, seq)
);

-- Sự kiện lệnh: append-only
create table if not exists plc.command_events (
  id      bigserial primary key,
  cmd_id  uuid not null references plc.commands(cmd_id),
  status  text not null check (status in ('issued','received','applied','confirmed','failed','expired','rejected','duplicate')),
  reason  text,
  at      timestamptz not null default now(),
  detail  jsonb
);
create index if not exists command_events_cmd on plc.command_events(cmd_id, id);

-- Lịch sử sửa lịch: append-only (dùng cho giới hạn ≤ 6 lần/giờ và kiểm toán)
create table if not exists plc.schedule_changes (
  id         bigserial primary key,
  station_id text not null references plc.stations(id),
  schedule   jsonb not null,
  changed_by text not null,
  reason     text,
  at         timestamptz not null default now()
);
create index if not exists schedule_changes_station on plc.schedule_changes(station_id, at desc);

create table if not exists plc.state_history (
  id         bigserial primary key,
  station_id text not null references plc.stations(id),
  at         timestamptz not null default now(),
  state      jsonb not null
);
create index if not exists state_history_station on plc.state_history(station_id, at desc);

-- Cảnh báo đã phát: append-only
create table if not exists plc.alerts (
  id         bigserial primary key,
  station_id text not null references plc.stations(id),
  code       text not null,
  type       text not null check (type in ('raise','remind','clear')),
  message    text not null,
  at         timestamptz not null default now(),
  delivery   jsonb
);

create table if not exists plc.alert_recipients (
  id         bigserial primary key,
  station_id text references plc.stations(id),          -- null = mọi tủ
  kind       text not null check (kind in ('zalo','email')),
  chat_id    text not null,
  chat_type  text check (chat_type in ('PRIVATE','GROUP')),
  name       text,
  active     boolean not null default true,
  created_at timestamptz not null default now(),
  unique (kind, chat_id, station_id)
);

-- Mã đăng ký nhận cảnh báo qua Zalo (/dangky <mã>)
create table if not exists plc.signup_codes (
  code       text primary key,
  station_id text references plc.stations(id),
  created_by text not null,
  expires_at timestamptz not null,
  used_at    timestamptz
);

-- Chặn sửa/xoá các bảng append-only (kể cả với chủ sở hữu, trừ khi chủ động tắt trigger)
create or replace function plc.deny_change() returns trigger language plpgsql as $$
begin
  raise exception 'plc.%: bảng chỉ được ghi thêm (append-only)', tg_table_name;
end $$;

do $$
declare t text;
begin
  foreach t in array array['commands','command_events','schedule_changes','alerts'] loop
    execute format('drop trigger if exists deny_change on plc.%I', t);
    execute format('create trigger deny_change before update or delete on plc.%I for each row execute function plc.deny_change()', t);
    execute format('drop trigger if exists deny_truncate on plc.%I', t);
    execute format('create trigger deny_truncate before truncate on plc.%I for each statement execute function plc.deny_change()', t);
  end loop;
end $$;

-- Quyền cho dịch vụ
grant usage on schema plc to plc_app;
grant select, insert on all tables in schema plc to plc_app;
grant update on plc.stations, plc.alert_recipients, plc.signup_codes to plc_app;
grant delete on plc.station_users to plc_app;
grant usage on all sequences in schema plc to plc_app;
revoke update, delete, truncate on plc.commands, plc.command_events, plc.schedule_changes, plc.alerts from plc_app;
