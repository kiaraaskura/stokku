-- Tenancy: tenant, outlet, user_app (reserved word "user" avoided),
-- membership, device. Plus refresh_token, requested by Backend for
-- auth rotation/reuse detection (not in DATA_MODEL.md §1; columns as
-- Backend specified: SHA-256 of the opaque token, never the token itself).

create table tenant (
  id          uuid primary key default uuidv7(),
  name        text not null,
  tax_rate    numeric(5,2) not null default 0,
  created_at  timestamptz not null default now()
);

create table outlet (
  id             uuid primary key default uuidv7(),
  tenant_id      uuid not null references tenant(id),
  name           text not null,
  address        text,
  timezone       text not null default 'Asia/Jakarta',
  qris_mode      text not null default 'none'
                   check (qris_mode in ('none','static_image','static_payload')),
  qris_image_key text,
  qris_payload   text,
  mdr_pct        numeric(5,2) not null default 0,
  created_at     timestamptz not null default now()
);
create index outlet_tenant_idx on outlet (tenant_id);

create table user_app (
  id            uuid primary key default uuidv7(),
  email         citext not null unique,
  password_hash text not null,
  name          text not null,
  created_at    timestamptz not null default now()
);

create table membership (
  id         uuid primary key default uuidv7(),
  tenant_id  uuid not null references tenant(id),
  user_id    uuid not null references user_app(id),
  role       text not null check (role in ('owner','staff')),
  created_at timestamptz not null default now(),
  unique (tenant_id, user_id)
);

create table device (
  id           uuid primary key default uuidv7(),
  user_id      uuid not null references user_app(id),
  name         text not null,
  platform     text,
  last_seen_at timestamptz
);
create index device_user_idx on device (user_id);

-- Requested by Backend (channel, not in DATA_MODEL.md §1):
-- refresh-token rotation + reuse detection.
create table refresh_token (
  id         uuid primary key default uuidv7(),
  user_id    uuid not null references user_app(id),
  tenant_id  uuid not null references tenant(id),
  token_hash text not null unique,          -- SHA-256 of the opaque token
  expires_at timestamptz not null,
  rotated_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);
create index refresh_token_user_idx on refresh_token (user_id);
