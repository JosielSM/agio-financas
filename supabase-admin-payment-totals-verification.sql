-- Comprova que o mês usa todos os pagamentos, além dos 250 exibidos. ROLLBACK.
begin;

do $$
declare
  owner_id text;
  test_user_id text := 'credmais-total-' || substr(md5(clock_timestamp()::text || random()::text), 1, 20);
  before_totals jsonb;
  after_dashboard jsonb;
begin
  select user_id into owner_id from public.platform_admins order by created_at limit 1;
  if owner_id is null then raise exception 'Administrador não encontrado'; end if;
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config('request.jwt.claims', jsonb_build_object('sub', owner_id, 'role', 'authenticated')::text, true);

  before_totals := public.admin_get_platform_billing_dashboard_v1()->'totals';
  insert into public.platform_accounts (user_id, email, display_name, status)
  values (test_user_id, test_user_id || '@credmais.invalid', 'Teste temporário de totais', 'pending');

  with inserted as (
    insert into public.platform_payment_orders (
      user_id, payment_mode, plan_months, monthly_fee, amount, status, live_mode, access_granted_at
    )
    select test_user_id, 'one_time', 1, 39.90, 39.90, 'approved', true, now()
    from generate_series(1, 251)
    returning id
  )
  insert into public.platform_payment_transactions (
    order_id, provider_payment_id, status, amount, currency, live_mode, paid_at, access_granted_at
  )
  select id, 'admin-total-test-' || id::text, 'approved', 39.90, 'BRL', true, now(), now()
  from inserted;

  after_dashboard := public.admin_get_platform_billing_dashboard_v1();
  if (after_dashboard->'totals'->>'approvedCountMonth')::integer
      <> (before_totals->>'approvedCountMonth')::integer + 251
    or (after_dashboard->'totals'->>'approvedAmountMonth')::numeric
      <> (before_totals->>'approvedAmountMonth')::numeric + (251 * 39.90)
    or jsonb_array_length(after_dashboard->'payments') <> 250 then
    raise exception 'Indicadores do mês foram limitados pela lista recente';
  end if;
end;
$$;

rollback;
select 'credmais_admin_payment_totals_verified' as result;
