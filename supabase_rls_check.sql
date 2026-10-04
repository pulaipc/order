-- ============================================================================
-- Pulai PC — RLS diagnostic
--
-- Supabase dashboard -> SQL Editor -> paste the WHOLE file -> Run.
-- Then reply with the result grid it returns. That grid is the only thing
-- standing between us and the fix, because it cannot be read from outside.
--
-- WHY A SEPARATE, DUMBLER FILE:
-- supabase_rls_policies.sql has never applied in full, and the SQL editor
-- reports one error at a time while discarding the rest of the batch. So
-- each statement gets proven on its own here, with no policy syntax, no
-- dollar quoting and no PL/pgSQL to trip over.
--
-- SAFE TO RE-RUN.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- Step 1 — the one statement that has never taken effect.
-- ---------------------------------------------------------------------------
-- Everything else in supabase_rls_policies.sql is inert while this is false:
-- Postgres does not evaluate policies until RLS is switched on.
alter table public.orders enable row level security;

alter table public.repair_services enable row level security;


-- ---------------------------------------------------------------------------
-- Step 2 — report the truth.
-- ---------------------------------------------------------------------------
-- Does not modify anything. Paste the output back.
select
    'orders RLS on'            as check_name,
    c.relrowsecurity::text     as result
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relname = 'orders'

union all
select
    'repair_services RLS on',
    c.relrowsecurity::text
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relname = 'repair_services'

union all
select
    'anon has BYPASSRLS',
    r.rolbypassrls::text
from pg_roles r
where r.rolname = 'anon'

union all
select
    'authenticated has BYPASSRLS',
    r.rolbypassrls::text
from pg_roles r
where r.rolname = 'authenticated'

union all
select
    'anon inherits role',
    coalesce(string_agg(p.rolname, ', '), '(none)')
from pg_auth_members m
join pg_roles c on c.oid = m.member
join pg_roles p on p.oid = m.roleid
where c.rolname = 'anon'

union all
select
    'anon DELETE policy on orders',
    coalesce(string_agg(pol.policyname || ' -> ' || array_to_string(pol.roles, ','), ', '), '(none)')
from pg_policies pol
where pol.schemaname = 'public' and pol.tablename = 'orders' and pol.cmd = 'DELETE'

union all
select
    'anon ALL policy on orders',
    coalesce(string_agg(pol.policyname || ' -> ' || array_to_string(pol.roles, ','), ', '), '(none)')
from pg_policies pol
where pol.schemaname = 'public' and pol.tablename = 'orders' and pol.cmd = 'ALL'

union all
select
    'policies on orders',
    coalesce(string_agg(pol.policyname || ' [' || pol.cmd || ' -> ' || array_to_string(pol.roles, ',') || ']', '; '), '(none)')
from pg_policies pol
where pol.schemaname = 'public' and pol.tablename = 'orders'

union all
select
    'policies on repair_services',
    coalesce(string_agg(pol.policyname || ' [' || pol.cmd || ' -> ' || array_to_string(pol.roles, ',') || ']', '; '), '(none)')
from pg_policies pol
where pol.schemaname = 'public' and pol.tablename = 'repair_services';


-- ===========================================================================
-- How to read the result
--
--   orders RLS on = true
--       Good. The enable works, so something later in policies file was
--       aborting the batch. Re-run policies Block A on its own.
--
--   anon has BYPASSRLS = true
--       The anon role skips row security entirely. Policies would be
--       decoration, and the token plan is the only real fix. Also explains
--       why DELETE keeps working no matter what we enable.
--
--   anon inherits role = something other than (none)
--       Same problem by inheritance rather than directly. The inherited
--       role is the one holding BYPASSRLS.
-- ===========================================================================
