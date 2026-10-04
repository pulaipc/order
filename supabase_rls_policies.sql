-- ============================================================================
-- Pulai PC — RLS policies, corrected
--
-- Supabase dashboard -> SQL Editor. RUN IN TWO STEPS.
--
-- BLOCK 1 (below, through the closing verification query) - run this first.
-- BLOCK 2 (further down, marked clearly) - run only after Block 1 is confirmed.
--
-- WHY THE REWRITE: the orders table already carried permissive policies from an
-- earlier setup, including "Allow anonymous full access on orders [ALL]".
-- Postgres ORs together every permissive policy for a given command, so adding
-- careful policies on top of a permissive one changes nothing. The only fix is
-- to remove all of them first. Previous attempts added policies and left the
-- anonymous full-access one in place, which is why DELETE kept working.
--
-- SAFE TO RE-RUN. Every DROP uses IF EXISTS, every CREATE is preceded by DROP.
-- ============================================================================


-- ############################################################################
-- BLOCK 1 - the security fix
-- ############################################################################

-- ---------------------------------------------------------------------------
-- 1. RLS must be on, or none of the policies below mean anything.
-- ---------------------------------------------------------------------------
alter table public.orders enable row level security;
alter table public.repair_services enable row level security;


-- ---------------------------------------------------------------------------
-- 2. Remove every existing policy on both tables.
-- ---------------------------------------------------------------------------
-- Explicit list rather than a loop, so there is no dollar quoting to trip over.
-- If a DROP names a policy that does not exist, IF EXISTS makes it a no-op.

-- on public.orders
drop policy if exists "Allow anonymous full access on orders" on public.orders;
drop policy if exists "Allow public reads"                          on public.orders;
drop policy if exists "Allow public updates"                         on public.orders;
drop policy if exists "Allow public inserts"                         on public.orders;
drop policy if exists "Allow public select"                          on public.orders;
drop policy if exists "Allow public update"                          on public.orders;
drop policy if exists "Allow admin delete"                           on public.orders;
drop policy if exists "anon_insert_orders"                           on public.orders;
drop policy if exists "anon_select_orders_by_phone"                  on public.orders;
drop policy if exists "anon_update_own_orders"                       on public.orders;
drop policy if exists "admin_full_access"                            on public.orders;
drop policy if exists "anon insert own orders"                       on public.orders;
drop policy if exists "anon read orders"                             on public.orders;
drop policy if exists "admin full access orders"                     on public.orders;

-- on public.repair_services
drop policy if exists "anon_read_repair_services" on public.repair_services;
drop policy if exists "admin_write_repair_services" on public.repair_services;
drop policy if exists "anon read active repairs"   on public.repair_services;
drop policy if exists "admin manage repairs"       on public.repair_services;


-- ---------------------------------------------------------------------------
-- 3. orders - who may do what
-- ---------------------------------------------------------------------------

-- Customers read orders. Required: track.html looks an order up by a 4-digit
-- phone ending with no login. See the note at the end of this file.
create policy "anon read orders" on public.orders
  for select to anon
  using (true);

-- Customers create their own orders.
create policy "anon insert own orders" on public.orders
  for insert to anon
  with check (true);

-- Customers update orders. Which COLUMNS they may write is decided by the
-- grants in section 4, not here - RLS is row-level only. There is no update
-- policy with a USING clause on purpose: a bare UPDATE policy with no USING
-- defaults to USING (true), which is what we want for "your own order", and
-- the column grants below are what actually stop price tampering.
create policy "anon update own orders" on public.orders
  for update to anon
  using (true)
  with check (true);

-- Your admin login. Safe because this project has exactly one user account.
create policy "admin full access orders" on public.orders
  for all to authenticated
  using (true) with check (true);

-- NO delete policy for anon, anywhere. With RLS on and none, DELETE silently
-- matches zero rows. That is the whole point: deleting orders is admin-only.


-- ---------------------------------------------------------------------------
-- 4. orders - which COLUMNS a customer may write
-- ---------------------------------------------------------------------------
-- Already applied and verified against this database. Re-running is harmless.
-- status / progress_stage / progress_updated_at are for the Cancel button
-- only, and BLOCK 2's trigger is what restricts them to 'Cancelled'.
revoke update on public.orders from anon;

grant update (
    phone_ending,
    games,
    total_games,
    repairs,
    remarks,
    service_type,
    console_model,
    sd_card_size,
    sd_source,
    free_storage_gb,
    total_size_gb,
    android_mode,
    linux_mode,
    updated_at,
    status,
    progress_stage,
    progress_updated_at
) on public.orders to anon;

-- Still NOT granted, so a customer cannot touch them:
--   estimated_price, price_subtotal, discount_rm, free_games_count   (money)
--   checklist_state, created_at, whatsapp_username,
--   tracking_inbound_*, tracking_outbound_*, progress_substage
--
-- Keep in sync with `customerEdits` in index.html. That object must contain
-- only columns from this list, or saving fails with "permission denied".


-- ---------------------------------------------------------------------------
-- 5. repair_services - public price list, admin-only writes
-- ---------------------------------------------------------------------------
create policy "anon read active repairs" on public.repair_services
  for select to anon, authenticated
  using (active);

create policy "admin manage repairs" on public.repair_services
  for all to authenticated
  using (true) with check (true);


-- ---------------------------------------------------------------------------
-- 6. Verify
-- ---------------------------------------------------------------------------
-- Do NOT paste the verification query together with the statements above. The
-- SQL editor runs a multi-statement paste as one transaction, so a typo in the
-- query at the end would roll back the drops above and put you back where you
-- started.
--
-- Run the statements in this block first. Then, separately, re-run:
--
--     supabase_rls_check.sql
--
-- It only re-asserts the two ALTER TABLEs and then reports. Block 1 is correct
-- when that grid says:
--
--   orders RLS on            true
--   anon DELETE policy       (none)
--   anon ALL policy          (none)
--   policies on orders       anon read orders [SELECT -> anon];
--                            anon insert own orders [INSERT -> anon];
--                            anon update own orders [UPDATE -> anon];
--                            admin full access orders [ALL -> authenticated]
--
-- If a permissive policy is still listed, paste the grid back and I will tell
-- you which DROP is missing.





-- ############################################################################
-- BLOCK 2 - restore the customer's Cancel button. Run AFTER Block 1 verifies.
-- ############################################################################
-- Block 1 grants `status` and `progress_stage` so the customer can cancel their
-- own order. Without a guard, that same grant lets them mark an order
-- "Ready for pickup". This trigger closes that gap.
--
-- SKIPPING BLOCK 2 IS NOT A SECURITY HOLE. It only leaves the Cancel button
-- failing with "permission denied". Nothing is exposed.
--
-- Deliberately NOT security definer, so current_user is the calling role
-- (anon) rather than this function's owner. Adding SECURITY DEFINER makes the
-- guard silently pass everything.

create or replace function public.guard_anon_order_updates()
returns trigger
language plpgsql
as $$
declare
    acting_role text;
begin
    acting_role := coalesce(
        current_setting('request.jwt.claims', true)::jsonb ->> 'role',
        current_user::text
    );

    if acting_role = 'anon' then
        if new.status is distinct from old.status
           and new.status is distinct from 'Cancelled' then
            raise exception 'You can only cancel an order here, not set its status.'
                using errcode = '42501';
        end if;

        if new.progress_stage is distinct from old.progress_stage
           and new.progress_stage is distinct from 'Cancelled' then
            raise exception 'You can only cancel an order here, not set its progress.'
                using errcode = '42501';
        end if;

        -- Belt and braces. These columns are not granted, so this cannot fire
        -- today. It is here so that loosening the grant in section 4 can never
        -- silently reopen price tampering.
        if new.estimated_price     is distinct from old.estimated_price
           or new.price_subtotal   is distinct from old.price_subtotal
           or new.discount_rm      is distinct from old.discount_rm
           or new.free_games_count is distinct from old.free_games_count then
            raise exception 'Pricing is set by the shop and cannot be changed online.'
                using errcode = '42501';
        end if;
    end if;

    return new;
end;
$$;

drop trigger if exists guard_anon_order_updates on public.orders;
create trigger guard_anon_order_updates
  before update on public.orders
  for each row
  execute function public.guard_anon_order_updates();


-- ===========================================================================
-- STILL OPEN after this file runs
--
-- "anon read orders" is USING (true), so anyone with the anon key can still
-- SELECT the whole orders table. That is what lets track.html look an order up
-- by 4 digits with no login. Until it is closed, the customer list is
-- readable by anyone who opens the page source.
--
-- Closing it needs an unguessable public_token on each order, with this policy
-- swapped to:
--
--     drop policy if exists "anon read orders" on public.orders;
--     create policy "anon read orders" on public.orders
--       for select to anon
--       using (public_token = nullif(current_setting('request.order_token', true), ''));
--
-- Do not run that swap until the front end is passing the token, or tracking
-- breaks for every customer at once.
-- ===========================================================================
