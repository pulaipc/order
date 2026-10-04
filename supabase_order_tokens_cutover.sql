-- ============================================================================
-- Pulai PC — cutover to token-only access
--
-- DO NOT RUN THIS YET.
--
-- Run it only once the front end has been deployed and you have confirmed on a
-- real device that: placing an order works, the private link opens the order,
-- a customer can edit it, they can cancel it, and phone lookup still shows
-- their order's status.
--
-- This file removes the anon role's direct access to the orders table. After
-- it runs:
--
--   * the public key cannot read, insert into, update or delete the table
--     through the REST API at all
--   * customers reach their order only through the five functions in
--     supabase_order_tokens.sql
--   * ?order=<sequential id> stops working, because nothing can read by id
--     any more
--
-- This is the step that actually closes the hole found earlier, where anyone
-- could walk ids 1-55 and read or edit all 7 orders.
--
-- WHERE: Supabase dashboard -> SQL Editor.
-- SAFE TO RE-RUN.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- 1. Take away every table privilege the anon role has on orders.
-- ---------------------------------------------------------------------------
-- REVOKE ALL also removes the column-level UPDATE grants added earlier
-- (remarks, games, status, ...). That is intended: updates now go through
-- save_order() and cancel_order(), which whitelist their own inputs.
--
-- The five functions are SECURITY DEFINER, so they keep working regardless.
revoke all on public.orders from anon;


-- ---------------------------------------------------------------------------
-- 2. Remove the anon policies. Row policies and table privileges are separate
--    layers; both have to go.
-- ---------------------------------------------------------------------------
drop policy if exists "anon read orders"        on public.orders;
drop policy if exists "anon insert own orders"  on public.orders;
drop policy if exists "anon update own orders"  on public.orders;

-- Deliberately KEPT:
--   admin full access orders [ALL -> authenticated]
-- Your admin login is unaffected. Verified working while this was absent.


-- ---------------------------------------------------------------------------
-- 3. The anon role can no longer touch orders at all.
-- ---------------------------------------------------------------------------
-- Nothing further is required. This next statement is a safety net: if a
-- future policy is ever added for anon by mistake, this raises rather than
-- letting it sit unnoticed.
do $$
declare
    v_leaks text;
begin
    select string_agg(pol.policyname, ', ')
      into v_leaks
      from pg_policies pol
     where pol.schemaname = 'public'
       and pol.tablename = 'orders'
       and pol.cmd <> 'ALL'
       and 'anon' = any(pol.roles);

    if v_leaks is not null then
        raise exception 'anon still has policies on public.orders: %', v_leaks;
    end if;
end $$;


-- ===========================================================================
-- 4. Verify. Read-only. Run separately, after the statements above.
-- ===========================================================================
select
    'anon SELECT on orders'   as check_name,
    has_table_privilege('anon', 'public.orders', 'SELECT')::text as result
union all
select 'anon INSERT on orders',   has_table_privilege('anon', 'public.orders', 'INSERT')::text
union all
select 'anon UPDATE on orders',   has_table_privilege('anon', 'public.orders', 'UPDATE')::text
union all
select 'anon DELETE on orders',   has_table_privilege('anon', 'public.orders', 'DELETE')::text
union all
select 'authenticated SELECT on orders', has_table_privilege('authenticated', 'public.orders', 'SELECT')::text
union all
select 'policies on orders',
    coalesce(string_agg(pol.policyname || ' [' || pol.cmd || ' -> ' || array_to_string(pol.roles, ',') || ']', '; '), '(none)')
from pg_policies pol
where pol.schemaname = 'public' and pol.tablename = 'orders'
union all
select 'anon may still call functions',
    has_function_privilege('anon', 'public.order_by_token(uuid)', 'EXECUTE')::text
    || ' (true is correct - this is the intended path)';

-- ===========================================================================
-- Correct result:
--
--   anon SELECT on orders            false
--   anon INSERT on orders            false
--   anon UPDATE on orders            false
--   anon DELETE on orders            false
--   authenticated SELECT on orders   true    <- your admin must still work
--   policies on orders               admin full access orders [ALL -> authenticated]
--   anon may still call functions    true (true is correct...)
--
-- If any anon row says true, stop and paste the grid back.
--
-- To confirm the end state from outside, this must now return nothing:
--   https://<project>.supabase.co/rest/v1/orders?select=id,phone_ending
-- with the public anon key. An empty array, not rows.
-- ===========================================================================
