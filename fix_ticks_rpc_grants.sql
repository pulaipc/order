-- ---------------------------------------------------------------------------
-- SECURITY FIX (run now in the Supabase SQL Editor)
-- ---------------------------------------------------------------------------
-- Postgres grants EXECUTE to PUBLIC on every new function by default, so the
-- migration's "grant ... to authenticated" on set_installed_ticks did NOT
-- stop anonymous clients: anyone could call it and rewrite any order's
-- installed_ticks (verified from this machine: anon call returned 204).
--
-- These revokes remove the implicit PUBLIC grant. The explicit grants from
-- the migration are untouched, so:
--   get_installed_ticks  -> anon (tracker) + authenticated (admin) still work
--   set_installed_ticks  -> authenticated (admin) only
-- ---------------------------------------------------------------------------

revoke execute on function public.get_installed_ticks(bigint) from public;

revoke execute on function public.set_installed_ticks(bigint, jsonb) from public;
revoke execute on function public.set_installed_ticks(bigint, jsonb) from anon;
