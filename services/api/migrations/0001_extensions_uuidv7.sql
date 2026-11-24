-- Stokku core: extensions + UUIDv7 generation (DATA_MODEL.md header).
-- Postgres 16 has no native uuidv7(), so we provide a small SQL function:
-- 48-bit unix-millisecond timestamp in the MSBs, randomness from
-- gen_random_uuid(), version nibble forced to 7, variant already 10x.

create extension if not exists citext;
create extension if not exists pg_trgm;

create or replace function uuidv7() returns uuid
language sql volatile as $$
  select encode(
    set_bit(
      set_bit(
        overlay(uuid_send(gen_random_uuid())
          placing substring(int8send((floor(extract(epoch from clock_timestamp()) * 1000))::bigint) from 3)
          from 1 for 6),
        52, 1),
      53, 1),
    'hex')::uuid;
$$;

comment on function uuidv7() is
  'UUIDv7. Check: substring(u::text,15,1) = ''7'' and to_timestamp((''x''||substring(u::text,1,12))::bit(48)::bigint / 1000.0) is close to now().';
