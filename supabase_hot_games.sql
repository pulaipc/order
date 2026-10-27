-- ---------------------------------------------------------------------------
-- game_order_counts()
--
-- Counts how many placed orders include each game title. The customer order
-- form calls this (as an anon RPC) to decide which games earn the "hot" badge
-- in the selection list.
--
-- The orders table itself is not readable by anon, so this SECURITY DEFINER
-- function exposes ONLY the aggregate result (game title + order count) --
-- no customer rows, phone endings, prices or remarks.
--
-- Run once in the Supabase dashboard (SQL Editor).
-- ---------------------------------------------------------------------------

create or replace function public.game_order_counts()
returns table (game_name text, order_count bigint)
language sql
stable
security definer
set search_path = public
as $$
  select e.game_name, count(*) as order_count
  from (
    select
      case
        -- games is stored as a JSON array of titles ("[\"Game A\",\"Game B\"]")
        when left(o.games::text, 1) = '[' then
          (select array_agg(trim(x))
             from jsonb_array_elements_text(o.games::jsonb) as t(x))
        -- older rows may hold a plain comma-separated string instead
        else
          (select array_agg(trim(part))
             from unnest(string_to_array(o.games::text, ',')) as t(part)
            where length(trim(part)) > 0)
      end as game_arr
    from public.orders o
    where o.games is not null
      and coalesce(o.status, 'Pending') <> 'Cancelled'
  ) parsed
  cross join lateral unnest(parsed.game_arr) as e(game_name)
  where length(e.game_name) > 0
  group by e.game_name
  order by order_count desc, e.game_name asc;
$$;

-- The order form (anon role) needs to call this.
grant execute on function public.game_order_counts() to anon, authenticated;
