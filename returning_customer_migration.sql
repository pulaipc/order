-- Returning-customer System Setup price.
--
-- Run once in the Supabase SQL editor. Safe to re-run.
--
-- orders.returning_customer is set only by the shop, from the admin order
-- editor. create_order and save_order build their rows from a fixed key
-- whitelist that does not include it, so a customer cannot set it on
-- themselves. order_by_token returns to_jsonb(o), so the tracker sees it
-- with no function change.

alter table public.orders
    add column if not exists returning_customer boolean not null default false;

alter table public.service_pricing
    add column if not exists system_setup_returning numeric not null default 30;

-- Verify (read-only).
select
    (select count(*) from information_schema.columns
      where table_schema = 'public' and table_name = 'orders'
        and column_name = 'returning_customer')            as orders_column,
    (select system_setup_returning from public.service_pricing limit 1) as returning_price;
