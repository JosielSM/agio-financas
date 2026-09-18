-- Novas compras podem ter no máximo seis meses. Pedidos antigos permanecem
-- registrados para auditoria e eventual confirmação de pagamentos já iniciados.
begin;

create or replace function public.create_platform_payment_order_v1(
  p_plan_months integer,
  p_payment_mode text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  account_id text := private.current_user_id();
  account_row public.platform_accounts%rowtype;
  setting_row public.platform_settings%rowtype;
  order_row public.platform_payment_orders%rowtype;
  effective_fee numeric(12,2);
  effective_amount numeric(12,2);
begin
  if account_id is null then raise exception 'Usuário não autenticado'; end if;
  if p_payment_mode not in ('one_time', 'subscription') then
    raise exception 'Forma de pagamento inválida';
  end if;
  if p_plan_months not in (1, 2, 3, 6) then raise exception 'Plano inválido'; end if;
  if p_payment_mode = 'subscription' and p_plan_months <> 1 then
    raise exception 'A assinatura recorrente é mensal';
  end if;

  perform public.ensure_platform_account('', null);
  perform pg_advisory_xact_lock(
    hashtextextended(account_id || ':' || p_payment_mode || ':' || p_plan_months, 0)
  );

  select * into strict account_row
  from public.platform_accounts
  where user_id = account_id
  for update;

  if private.is_platform_admin_id(account_id) or account_row.access_type = 'lifetime' then
    raise exception 'Esta conta já possui acesso permanente';
  end if;
  if account_row.email = '' then raise exception 'Sua conta precisa ter um e-mail válido'; end if;

  select * into strict setting_row from public.platform_settings where id = 1;
  effective_fee := round(coalesce(account_row.monthly_fee, setting_row.default_monthly_fee, 0), 2);
  if effective_fee <= 0 or effective_fee > 1000000 then
    raise exception 'A mensalidade ainda não foi configurada';
  end if;
  effective_amount := round(effective_fee * p_plan_months, 2);

  update public.platform_payment_orders set
    status = 'expired',
    failure_reason = 'PRICE_CHANGED',
    updated_at = now()
  where user_id = account_id
    and payment_mode = p_payment_mode
    and plan_months = p_plan_months
    and status in ('creating', 'pending', 'in_process', 'authorized')
    and (monthly_fee is distinct from effective_fee or amount is distinct from effective_amount);

  select * into order_row
  from public.platform_payment_orders
  where user_id = account_id
    and payment_mode = p_payment_mode
    and plan_months = p_plan_months
    and monthly_fee = effective_fee
    and amount = effective_amount
    and status in ('creating', 'pending', 'in_process', 'authorized')
    and (
      (checkout_url is not null and coalesce(expires_at, now() + interval '1 day') > now())
      or (checkout_url is null and created_at > now() - interval '2 minutes')
    )
  order by created_at desc
  limit 1;

  if order_row.id is not null then
    return jsonb_build_object(
      'orderId', order_row.id,
      'requestKey', order_row.request_key,
      'mode', order_row.payment_mode,
      'planMonths', order_row.plan_months,
      'monthlyFee', order_row.monthly_fee,
      'amount', order_row.amount,
      'currency', order_row.currency,
      'email', account_row.email,
      'name', account_row.display_name,
      'status', order_row.status,
      'checkoutUrl', order_row.checkout_url,
      'sandboxCheckoutUrl', order_row.sandbox_checkout_url,
      'processing', order_row.checkout_url is null,
      'reused', true
    );
  end if;

  update public.platform_payment_orders
  set status = 'expired', updated_at = now()
  where user_id = account_id
    and status in ('creating', 'pending', 'in_process', 'authorized')
    and (
      (checkout_url is null and created_at <= now() - interval '2 minutes')
      or (expires_at is not null and expires_at <= now())
    );

  insert into public.platform_payment_orders (
    user_id, payment_mode, plan_months, monthly_fee, amount
  ) values (
    account_id, p_payment_mode, p_plan_months, effective_fee, effective_amount
  ) returning * into order_row;

  return jsonb_build_object(
    'orderId', order_row.id,
    'requestKey', order_row.request_key,
    'mode', order_row.payment_mode,
    'planMonths', order_row.plan_months,
    'monthlyFee', order_row.monthly_fee,
    'amount', order_row.amount,
    'currency', order_row.currency,
    'email', account_row.email,
    'name', account_row.display_name,
    'status', order_row.status,
    'processing', false,
    'reused', false
  );
end;
$$;

commit;
