-- ============================================================================
-- Pulai PC — lock down public.orders and public.repair_services
--
-- WHERE: Supabase dashboard -> SQL Editor.
--
--        RUN THIS IN TWO STEPS, NOT ONE.
--        Run 1 = BLOCK A.  Run 2 = BLOCK B.
--
--        The SQL editor sends a multi-statement paste as a single transaction,
--        so one bad statement rolls the whole thing back and you end up with
--        neither half applied. Splitting them means a failure in the optional
--        part cannot cost you the security-critical part.
--
--        Each block is idempotent, so re-running either is safe.
-- ============================================================================


-- ############################################################################
-- BLOCK A — the security fix. Run this first.
-- ############################################################################

-- ---------------------------------------------------------------------------
-- A1. Turn on RLS
-- ---------------------------------------------------------------------------
-- This is the statement that did NOT take effect on the previous attempt. Until
-- it runs, every policy below is inert: Postgres ignores policies while RLS is
-- off, which is why anon could still DELETE real orders.
alter table public.orders enable row level security;
alter table public.repair_services enable row level security;

-- Fail loudly rather than leave you half-protected again.
do $$
begin
  if not exists (
    select 1
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = 'orders' and c.relkind = 'r' and c.relrowsecurity
  ) then
    raise exception 'RLS is still OFF on public.orders. Nothing below is in effect.';
  end if;
end $$;


-- ---------------------------------------------------------------------------
-- A2. orders — who may do what
-- ---------------------------------------------------------------------------
-- Customers read orders. Required: track.html looks an order up by a 4-digit
-- phone ending with no login. See the note at the end of this file.
drop policy if exists "anon read orders" on public.orders;
create policy "anon read orders" on public.orders
  for select to anon
  using (true);

drop policy if exists "anon insert own orders" on public.orders;
create policy "anon insert own orders" on public.orders
  for insert to anon
  with check (true);

-- Safe because this project has exactly one user account (yours).
drop policy if exists "admin full access orders" on public.orders;
create policy "admin full access orders" on public.orders
  for all to authenticated
  using (true) with check (true);

-- There is deliberately NO delete policy for anon. With RLS on and none, DELETE
-- silently matches zero rows.


-- ---------------------------------------------------------------------------
-- A3. orders — which COLUMNS a customer may write
-- ---------------------------------------------------------------------------
-- RLS is row-level only: it cannot tell WHICH columns a caller writes. Anyone
-- holding the anon key could otherwise PATCH estimated_price to 0 on their own
-- order. Column grants are what actually prevent that.
--
-- Already applied and verified on this database. Re-running is harmless.
revoke update on public.orders from anon;

grant update (
    -- what the customer is asking for
    phone_ending,
    games,
    total_games,
    repairs,
    remarks,
    -- configuration
    service_type,
    console_model,
    sd_card_size,
    sd_source,
    free_storage_gb,
    total_size_gb,
    android_mode,
    linux_mode,
    -- bookkeeping
    updated_at,
    -- cancel only, and BLOCK B is what restricts these two values
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
-- A4. repair_services — public price list, admin-only writes
-- ---------------------------------------------------------------------------
drop policy if exists "anon read active repairs" on public.repair_services;
create policy "anon read active repairs" on public.repair_services
  for select to anon, authenticated
  using (active);

drop policy if exists "admin manage repairs" on public.repair_services;
create policy "admin manage repairs" on public.repair_services
  for all to authenticated
  using (true) with check (true);


-- ===========================================================================
-- Check A landed before continuing:
--
--   select policyname, cmd, roles from pg_policies
--     where tablename in ('orders','repair_services') order by 1;
--
-- Expect 5 rows. If you get 0, Block A did not run — do not continue.
-- ===========================================================================




-- ############################################################################
-- BLOCK B — restore the customer's Cancel button. Run this second.
-- ############################################################################
-- A3 grants `status` and `progress_stage` purely so the customer can cancel
-- their own order. Without a guard, that grant also lets them mark an order
-- "Ready for pickup". This trigger closes that gap.
--
-- SKIPPING BLOCK B IS NOT A SECURITY HOLE — it only leaves the customer's
-- Cancel button failing with "permission denied". Nothing is exposed.
--
-- Deliberately NOT security definer, so current_user is the calling role
-- (anon) rather than this function's owner. If you add SECURITY DEFINER, the
-- guard silently passes everything.

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
        -- today. It is here so that loosening the grant in A3 can never
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
-- "anon read orders" is using (true), so anyone with the anon key can still
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
