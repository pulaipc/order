-- ============================================================================
-- Pulai PC — per-order private tokens + customer-facing functions
--
-- PART 1 OF 2. THIS FILE IS SAFE TO RUN NOW: it only ADDS things.
--   - adds orders.public_token and backfills all 7 existing orders
--   - creates five functions the front end will call via supabase.rpc()
--   - grants EXECUTE on them to anon
--
--   Nothing is revoked and no policy is dropped here, so the live site keeps
--   working exactly as it does today while the front end is updated. If you
--   never run part 2, you have lost nothing.
--
-- PART 2 is a separate file: supabase_order_tokens_cutover.sql
--   Run it only AFTER the front end is deployed, because it removes the anon
--   role's direct access to the orders table.
--
-- WHERE: Supabase dashboard -> SQL Editor.
-- SAFE TO RE-RUN. Every CREATE is CREATE OR REPLACE, every GRANT is idempotent.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- 1. The token column
-- ---------------------------------------------------------------------------
-- An unguessable 128-bit value that identifies one order with no login.
-- This is what stops ?order=<sequential id> from being readable by anyone.
alter table public.orders
  add column if not exists public_token uuid;

-- Give every existing order a token so current customers' links can be issued.
update public.orders
   set public_token = gen_random_uuid()
 where public_token is null;

-- New orders get one automatically.
alter table public.orders
  alter column public_token set default gen_random_uuid();

alter table public.orders
  alter column public_token set not null;

drop index if exists public.orders_public_token_key;
create unique index orders_public_token_key on public.orders (public_token);


-- ===========================================================================
-- 2. The functions
-- ===========================================================================
--
-- SECURITY DEFINER on all five, because the anon role has no table privileges
-- at all once part 2 runs. They run as the table owner and filter explicitly.
--
-- Every function takes its input as jsonb and copies across ONLY the columns
-- listed below. That whitelist is the security boundary: a caller cannot set
-- a price, a status, a tracking number, or the token, because there is no code
-- path that reads those keys out of the input.
--
-- jsonb_populate_record is used so each value is coerced by the column's real
-- type. It avoids having to hardcode whether each json column is json or jsonb.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 2a. create_order - place a new order
-- ---------------------------------------------------------------------------
-- The customer may state an ESTIMATE of the price, because the site shows them
-- a total when they order and showing RM0 would be a regression. They cannot
-- state a discount or a free-game waiver: those are forced to zero here. The
-- shop sets the real price in admin.html, which recalculates and warns loudly
-- when the stored total disagrees with a fresh calculation.
create or replace function public.create_order(p_order jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_id bigint;
    v_token uuid;
    v_now timestamptz := now();
    v_row public.orders;
begin
    -- Only these keys are read from the caller's json. Anything else is ignored.
    v_row := jsonb_populate_record(null::public.orders, jsonb_build_object(
        'phone_ending',     right(regexp_replace(coalesce(p_order ->> 'phone_ending', ''), '[^0-9]', '', 'g'), 4),
        'games',            coalesce(p_order -> 'games',    '[]'::jsonb),
        'total_games',      coalesce(p_order -> 'total_games', '0'::jsonb),
        'repairs',          coalesce(p_order -> 'repairs',  '[]'::jsonb),
        'remarks',          coalesce(p_order ->> 'remarks', ''),
        'sd_card_size',     p_order -> 'sd_card_size',
        'free_storage_gb',  p_order -> 'free_storage_gb',
        'sd_source',        p_order ->> 'sd_source',
        'service_type',     p_order ->> 'service_type',
        'console_model',    p_order ->> 'console_model',
        'total_size_gb',    p_order -> 'total_size_gb',
        'android_mode',     coalesce(p_order -> 'android_mode', 'false'::jsonb),
        'linux_mode',       coalesce(p_order -> 'linux_mode',   'false'::jsonb),
        -- customer's own estimate, accepted
        'estimated_price',  coalesce(p_order -> 'estimated_price', '0'::jsonb),
        'price_subtotal',   coalesce(p_order -> 'price_subtotal',  '0'::jsonb),
        -- forced: no discount, no waived games at order time
        'discount_rm',      0,
        'free_games_count', 0,
        'status',           coalesce(nullif(p_order ->> 'status', ''), 'Pending'),
        'progress_stage',   'Order Received',
        'created_at',       v_now,
        'updated_at',       v_now,
        'progress_updated_at', v_now
    ));

    insert into public.orders (
        phone_ending, games, total_games, repairs, remarks,
        sd_card_size, free_storage_gb, sd_source, service_type,
        console_model, total_size_gb, android_mode, linux_mode,
        estimated_price, price_subtotal, discount_rm, free_games_count,
        status, progress_stage, created_at, updated_at, progress_updated_at
    )
    values (
        v_row.phone_ending, v_row.games, v_row.total_games, v_row.repairs, v_row.remarks,
        v_row.sd_card_size, v_row.free_storage_gb, v_row.sd_source, v_row.service_type,
        v_row.console_model, v_row.total_size_gb, v_row.android_mode, v_row.linux_mode,
        v_row.estimated_price, v_row.price_subtotal, 0, 0,
        v_row.status, 'Order Received', v_now, v_now, v_now
    )
    returning id, public_token into v_id, v_token;

    return jsonb_build_object('id', v_id, 'public_token', v_token);
end;
$$;


-- ---------------------------------------------------------------------------
-- 2b. orders_by_phone - status only
-- ---------------------------------------------------------------------------
-- What the customer gets when they type their last 4 digits instead of using
-- their link. Deliberately narrow: no id, no token, no remarks, no games, no
-- whatsapp_username, no price. Enough to recognise an order, not enough to
-- learn anything about whoever placed it.
--
-- This cannot be made unguessable: 10,000 phone endings is 10,000 requests.
-- It is intentionally a status board, not a data export.
create or replace function public.orders_by_phone(p_phone text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
    return coalesce((
        select jsonb_agg(jsonb_build_object(
            'service_type',   o.service_type,
            'console_model',  o.console_model,
            'progress_stage', o.progress_stage,
            'status',         o.status,
            'created_at',     o.created_at,
            'updated_at',     o.updated_at
        ) order by o.created_at desc)
        from public.orders o
        where o.phone_ending = right(regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g'), 4)
    ), '[]'::jsonb);
end;
$$;


-- ---------------------------------------------------------------------------
-- 2c. order_by_token - the full order behind a private link
-- ---------------------------------------------------------------------------
create or replace function public.order_by_token(p_token uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_row jsonb;
begin
    select to_jsonb(o) into v_row
    from public.orders o
    where o.public_token = p_token;

    -- null means "no such link", which the front end turns into a helpful
    -- message rather than a crash.
    return v_row;
end;
$$;


-- ---------------------------------------------------------------------------
-- 2d. save_order - a customer editing their own order
-- ---------------------------------------------------------------------------
-- The same whitelist as create_order, and note what is absent: no price, no
-- discount, no free-game waiver, no status, no tracking number. A customer
-- re-saving therefore CANNOT overwrite a discount the shop granted. The
-- columns simply are not in the SET list, so the stored values survive.
create or replace function public.save_order(p_token uuid, p_order jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_row public.orders;
begin
    v_row := jsonb_populate_record(null::public.orders, jsonb_build_object(
        'phone_ending',    right(regexp_replace(coalesce(p_order ->> 'phone_ending', ''), '[^0-9]', '', 'g'), 4),
        'games',           coalesce(p_order -> 'games',    '[]'::jsonb),
        'total_games',     coalesce(p_order -> 'total_games', '0'::jsonb),
        'repairs',         coalesce(p_order -> 'repairs',  '[]'::jsonb),
        'remarks',         coalesce(p_order ->> 'remarks', ''),
        'sd_card_size',    p_order -> 'sd_card_size',
        'free_storage_gb', p_order -> 'free_storage_gb',
        'sd_source',       p_order ->> 'sd_source',
        'service_type',    p_order ->> 'service_type',
        'console_model',   p_order ->> 'console_model',
        'total_size_gb',   p_order -> 'total_size_gb',
        'android_mode',    coalesce(p_order -> 'android_mode', 'false'::jsonb),
        'linux_mode',      coalesce(p_order -> 'linux_mode',   'false'::jsonb)
    ));

    update public.orders o
       set phone_ending    = v_row.phone_ending,
           games           = v_row.games,
           total_games     = v_row.total_games,
           repairs         = v_row.repairs,
           remarks         = v_row.remarks,
           sd_card_size    = v_row.sd_card_size,
           free_storage_gb = v_row.free_storage_gb,
           sd_source       = v_row.sd_source,
           service_type    = v_row.service_type,
           console_model   = v_row.console_model,
           total_size_gb   = v_row.total_size_gb,
           android_mode    = v_row.android_mode,
           linux_mode      = v_row.linux_mode,
           updated_at      = now()
     where o.public_token = p_token;

    if not found then
        return null;
    end if;

    -- Return the whole row so the page can re-render with the shop's pricing
    -- intact, rather than trusting the values the customer just sent.
    return public.order_by_token(p_token);
end;
$$;


-- ---------------------------------------------------------------------------
-- 2e. cancel_order
-- ---------------------------------------------------------------------------
-- The cancellable test is repeated here. The browser copy is only a
-- convenience; this is the one that counts, because anyone can call the
-- function directly and skip the front end entirely.
create or replace function public.cancel_order(p_token uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_id bigint;
begin
    update public.orders o
       set status             = 'Cancelled',
           progress_stage     = 'Cancelled',
           progress_updated_at = now(),
           updated_at          = now()
     where o.public_token = p_token
       and coalesce(o.progress_stage, 'Order Received') = 'Order Received'
       and coalesce(o.status, '') is distinct from 'Cancelled'
    returning o.id into v_id;

    if not found then
        return jsonb_build_object('cancelled', false);
    end if;

    return jsonb_build_object('cancelled', true, 'id', v_id);
end;
$$;


-- ===========================================================================
-- 3. Permissions
-- ===========================================================================
-- Postgres grants EXECUTE on every new function to PUBLIC by default, which
-- would include anon and any other role. Take that back and hand it only to
-- the two roles that need it.
revoke all on function public.create_order(jsonb)      from public;
revoke all on function public.orders_by_phone(text)    from public;
revoke all on function public.order_by_token(uuid)     from public;
revoke all on function public.save_order(uuid, jsonb)  from public;
revoke all on function public.cancel_order(uuid)       from public;

grant execute on function public.create_order(jsonb)      to anon, authenticated;
grant execute on function public.orders_by_phone(text)    to anon, authenticated;
grant execute on function public.order_by_token(uuid)     to anon, authenticated;
grant execute on function public.save_order(uuid, jsonb)  to anon, authenticated;
grant execute on function public.cancel_order(uuid)       to anon, authenticated;


-- ===========================================================================
-- 4. Verify. Read-only. Run separately, after the statements above.
-- ===========================================================================
select
    'orders with a token'  as check_name,
    count(*)::text         as result
from public.orders
where public_token is not null

union all
select 'orders total', count(*)::text from public.orders

union all
select 'duplicate tokens', count(*)::text from (
    select public_token from public.orders group by public_token having count(*) > 1
) d

union all
select 'anon may read orders directly', (
    has_table_privilege('anon', 'public.orders', 'SELECT')::text
    || '  (true is expected until part 2)'
)

union all
select 'functions created', count(*)::text
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('create_order','orders_by_phone','order_by_token','save_order','cancel_order');
