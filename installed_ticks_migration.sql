-- ---------------------------------------------------------------------------
-- Installed ticks for install progress tracking
-- ---------------------------------------------------------------------------
-- Adds a JSONB column to store which games have been installed per order.
-- Keys are normalized game names (matching installNormKey), values are 1.
--
-- Run once in the Supabase dashboard (SQL Editor).
-- ---------------------------------------------------------------------------

-- 1. Add the column
alter table public.orders
  add column if not exists installed_ticks jsonb not null default '{}'::jsonb;

-- 2. RPC to get installed ticks for an order (callable by anon for tracker)
create or replace function public.get_installed_ticks(p_order_id bigint)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select installed_ticks
  from public.orders
  where id = p_order_id
$$;

-- 3. RPC to upsert installed ticks (callable by authenticated admin only)
create or replace function public.set_installed_ticks(p_order_id bigint, p_ticks jsonb)
returns void
language sql
security definer
set search_path = public
as $$
  update public.orders
  set installed_ticks = p_ticks,
      updated_at = now()
  where id = p_order_id
$$;

-- 4. Grant execute to appropriate roles
grant execute on function public.get_installed_ticks(bigint) to anon, authenticated;
grant execute on function public.set_installed_ticks(bigint, jsonb) to authenticated;

-- 5. Close the default-PUBLIC-execute hole.
-- Postgres grants EXECUTE to PUBLIC on every new function unless revoked, so
-- without this ANY anonymous client could rewrite any order's installed_ticks
-- (verified: anon got a 204 from set_installed_ticks). Explicit grants above
-- are unaffected by these revokes.
revoke execute on function public.get_installed_ticks(bigint) from public;
revoke execute on function public.set_installed_ticks(bigint, jsonb) from public;
revoke execute on function public.set_installed_ticks(bigint, jsonb) from anon;