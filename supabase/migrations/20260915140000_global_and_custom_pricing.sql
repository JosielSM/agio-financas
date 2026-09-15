-- Política de preços do CredMais: valor global por padrão e exceção por conta.
-- Mantém o cálculo financeiro no banco e invalida checkouts com preço antigo.

begin;

create or replace function public.ensure_platform_account(
  p_display_name text default '',
  p_phone text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  account_id text := private.current_user_id();
  account_email text := coalesce(auth.jwt()->>'email', '');
  account_row public.platform_accounts%rowtype;
  setting_row public.platform_settings%rowtype;
  effective_status text;
begin
  if account_id is null then raise exception 'Usuário não autenticado'; end if;
  if length(coalesce(p_display_name, '')) > 160 then raise exception 'Nome muito longo'; end if;
  if length(coalesce(p_phone, '')) > 32 then raise exception 'Telefone inválido'; end if;

  insert into public.platform_accounts (
    user_id, email, display_name, phone, status, access_requested_at, last_seen_at
  ) values (
    account_id,
    left(account_email, 254),
    left(coalesce(p_display_name, ''), 160),
    left(coalesce(p_phone, ''), 32),
    'pending',
    now(),
    now()
  )
  on conflict (user_id) do update set
    email = case when excluded.email <> '' then excluded.email else public.platform_accounts.email end,
    display_name = case when excluded.display_name <> '' then excluded.display_name else public.platform_accounts.display_name end,
    phone = case when excluded.phone <> '' then excluded.phone else public.platform_accounts.phone end,
    last_seen_at = now(),
    updated_at = now();

  select * into strict account_row
  from public.platform_accounts
  where user_id = account_id;

  select * into strict setting_row
  from public.platform_settings
  where id = 1;

  effective_status := case
    when private.is_platform_admin_id(account_id) then 'admin'
    when account_row.status = 'active'
      and (account_row.paid_until is null or account_row.paid_until >= current_date)
      then 'active'
    when account_row.status = 'active' then 'expired'
    else account_row.status
  end;

  return jsonb_build_object(
    'enabled', true,
    'userId', account_row.user_id,
    'status', effective_status,
    'storedStatus', account_row.status,
    'phone', account_row.phone,
    'monthlyFee', coalesce(account_row.monthly_fee, setting_row.default_monthly_fee, 0),
    'defaultMonthlyFee', coalesce(setting_row.default_monthly_fee, 0),
    'monthlyFeeSource', case when account_row.monthly_fee is null then 'global' else 'custom' end,
    'paidUntil', account_row.paid_until,
    'requestedAt', account_row.access_requested_at,
    'accessType', account_row.access_type,
    'supportPhone', coalesce(setting_row.support_phone, '')
  );
end;
$$;

create or replace function public.admin_update_platform_settings_v2(
  p_default_monthly_fee numeric,
  p_billing_message text,
  p_support_phone text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_id text := private.current_user_id();
  previous_fee numeric(12,2);
  saved public.platform_settings%rowtype;
begin
  if not private.is_platform_admin_id(actor_id) then
    raise exception 'Acesso administrativo necessário';
  end if;
  if p_default_monthly_fee is null
    or p_default_monthly_fee <= 0
    or p_default_monthly_fee > 1000000 then
    raise exception 'Mensalidade global inválida';
  end if;
  if length(coalesce(p_billing_message, '')) not between 1 and 4000
    or length(coalesce(p_support_phone, '')) > 32 then
    raise exception 'Configuração de cobrança inválida';
  end if;

  select default_monthly_fee into strict previous_fee
  from public.platform_settings
  where id = 1
  for update;

  update public.platform_settings set
    default_monthly_fee = round(p_default_monthly_fee, 2),
    billing_recipient = '',
    billing_pix_key = '',
    billing_pix_type = 'Chave aleatória',
    billing_message = p_billing_message,
    support_phone = coalesce(p_support_phone, ''),
    updated_at = now()
  where id = 1
  returning * into saved;

  if previous_fee is distinct from saved.default_monthly_fee then
    update public.platform_payment_orders payment_order set
      status = 'expired',
      failure_reason = 'PRICE_CHANGED',
      updated_at = now()
    where payment_order.status in ('creating', 'pending', 'in_process', 'authorized')
      and exists (
        select 1
        from public.platform_accounts account
        where account.user_id = payment_order.user_id
          and account.monthly_fee is null
      );
  end if;

  insert into public.platform_access_log (
    user_id, actor_id, action, action_label, details
  ) values (
    actor_id,
    actor_id,
    'settings_update',
    'Valor global e configurações de cobrança atualizados',
    jsonb_build_object(
      'previousDefaultMonthlyFee', previous_fee,
      'defaultMonthlyFee', saved.default_monthly_fee,
      'automaticPaymentOnly', true
    )
  );
  return to_jsonb(saved);
end;
$$;

create or replace function public.admin_update_platform_account_v2(
  p_user_id text,
  p_phone text,
  p_notes text,
  p_use_default_fee boolean,
  p_monthly_fee numeric
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_id text := private.current_user_id();
  previous_row public.platform_accounts%rowtype;
  saved public.platform_accounts%rowtype;
  requested_fee numeric(12,2);
  effective_fee numeric(12,2);
begin
  if not private.is_platform_admin_id(actor_id) then
    raise exception 'Acesso administrativo necessário';
  end if;
  if p_user_id is null or btrim(p_user_id) = '' then raise exception 'Conta inválida'; end if;
  if p_use_default_fee is null then raise exception 'Escolha a política de preço'; end if;
  if length(coalesce(p_phone, '')) > 32 then raise exception 'Telefone inválido'; end if;
  if length(coalesce(p_notes, '')) > 2000 then raise exception 'Observação muito longa'; end if;
  if not p_use_default_fee
    and (p_monthly_fee is null or p_monthly_fee <= 0 or p_monthly_fee > 1000000) then
    raise exception 'Mensalidade personalizada inválida';
  end if;

  select * into previous_row
  from public.platform_accounts
  where user_id = p_user_id
  for update;
  if previous_row.user_id is null then raise exception 'Conta não encontrada'; end if;

  requested_fee := case when p_use_default_fee then null else round(p_monthly_fee, 2) end;

  update public.platform_accounts set
    phone = coalesce(p_phone, ''),
    notes = coalesce(p_notes, ''),
    monthly_fee = requested_fee,
    updated_at = now()
  where user_id = p_user_id
  returning * into saved;

  select coalesce(saved.monthly_fee, setting.default_monthly_fee)
  into strict effective_fee
  from public.platform_settings setting
  where setting.id = 1;

  if previous_row.monthly_fee is distinct from saved.monthly_fee then
    update public.platform_payment_orders set
      status = 'expired',
      failure_reason = 'PRICE_CHANGED',
      updated_at = now()
    where user_id = p_user_id
      and status in ('creating', 'pending', 'in_process', 'authorized');
  end if;

  insert into public.platform_access_log (
    user_id, actor_id, action, action_label, details
  ) values (
    p_user_id,
    actor_id,
    'account_update',
    'Cadastro e política de preço da assinatura atualizados',
    jsonb_build_object(
      'phoneUpdated', true,
      'notesUpdated', true,
      'pricingSource', case when p_use_default_fee then 'global' else 'custom' end,
      'monthlyFee', effective_fee
    )
  );
  return to_jsonb(saved);
end;
$$;

create or replace function public.admin_grant_platform_access_v4(
  p_user_id text,
  p_period_value integer,
  p_period_unit text,
  p_use_default_fee boolean,
  p_monthly_fee numeric,
  p_access_type text,
  p_access_amount numeric,
  p_phone text,
  p_notes text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_id text := private.current_user_id();
  updated_row public.platform_accounts%rowtype;
  stored_fee numeric(12,2);
  effective_fee numeric(12,2);
  expiration_date date;
  period_label text;
  access_label text;
begin
  if not private.is_platform_admin_id(actor_id) then
    raise exception 'Acesso administrativo necessário';
  end if;
  if p_user_id is null or btrim(p_user_id) = '' then raise exception 'Conta inválida'; end if;
  if private.is_platform_admin_id(p_user_id) then
    raise exception 'A conta proprietária já possui acesso permanente';
  end if;
  if p_period_unit not in ('days', 'months') then raise exception 'Unidade de período inválida'; end if;
  if p_period_value is null
    or (p_period_unit = 'days' and p_period_value not between 1 and 365)
    or (p_period_unit = 'months' and p_period_value not between 1 and 24) then
    raise exception 'Período de acesso inválido';
  end if;
  if p_use_default_fee is null then raise exception 'Escolha a política de preço'; end if;
  if p_access_type not in ('paid', 'free') then
    raise exception 'Escolha se a liberação foi paga ou gratuita';
  end if;
  if not p_use_default_fee
    and (p_monthly_fee is null or p_monthly_fee <= 0 or p_monthly_fee > 1000000) then
    raise exception 'Mensalidade personalizada inválida';
  end if;
  if p_access_amount is null or p_access_amount < 0 or p_access_amount > 10000000 then
    raise exception 'Valor recebido inválido';
  end if;
  if p_access_type = 'free' and p_access_amount <> 0 then
    raise exception 'Acesso gratuito não pode registrar pagamento';
  end if;
  if p_access_type = 'paid' and p_access_amount <= 0 then
    raise exception 'Informe o valor recebido para o acesso pago';
  end if;
  if length(coalesce(p_phone, '')) > 32 or length(coalesce(p_notes, '')) > 2000 then
    raise exception 'Dados administrativos inválidos';
  end if;

  perform 1 from public.platform_accounts where user_id = p_user_id for update;
  if not found then raise exception 'Conta não encontrada'; end if;

  stored_fee := case when p_use_default_fee then null else round(p_monthly_fee, 2) end;
  select coalesce(stored_fee, setting.default_monthly_fee)
  into strict effective_fee
  from public.platform_settings setting
  where setting.id = 1;
  if effective_fee is null or effective_fee <= 0 or effective_fee > 1000000 then
    raise exception 'Mensalidade efetiva inválida';
  end if;

  expiration_date := case
    when p_period_unit = 'days' then current_date + p_period_value
    else (current_date + make_interval(months => p_period_value))::date
  end;
  period_label := case
    when p_period_unit = 'days' then p_period_value || case when p_period_value = 1 then ' dia' else ' dias' end
    else p_period_value || case when p_period_value = 1 then ' mês' else ' meses' end
  end;
  access_label := case when p_access_type = 'free' then 'Teste gratuito' else 'Acesso pago' end;

  update public.platform_accounts set
    status = 'active',
    phone = coalesce(p_phone, phone),
    notes = coalesce(p_notes, notes),
    monthly_fee = stored_fee,
    paid_until = expiration_date,
    access_type = p_access_type,
    access_amount = case when p_access_type = 'free' then 0 else p_access_amount end,
    expiry_notified_at = null,
    approved_at = now(),
    approved_by = actor_id,
    updated_at = now()
  where user_id = p_user_id
  returning * into updated_row;

  update public.platform_payment_orders set
    status = 'expired',
    failure_reason = 'ACCESS_GRANTED_MANUALLY',
    updated_at = now()
  where user_id = p_user_id
    and status in ('creating', 'pending', 'in_process', 'authorized');

  insert into public.platform_access_log (
    user_id, actor_id, action, action_label, details
  ) values (
    p_user_id,
    actor_id,
    case when p_access_type = 'free' then 'grant_free' else 'grant_paid' end,
    access_label || ' de ' || period_label || ' liberado até ' || to_char(updated_row.paid_until, 'DD/MM/YYYY'),
    jsonb_build_object(
      'periodValue', p_period_value,
      'periodUnit', p_period_unit,
      'periodLabel', period_label,
      'accessType', p_access_type,
      'amount', updated_row.access_amount,
      'pricingSource', case when p_use_default_fee then 'global' else 'custom' end,
      'monthlyFee', effective_fee,
      'startsAt', current_date,
      'paidUntil', updated_row.paid_until,
      'paymentMethod', 'manual',
      'replacedPreviousExpiration', true
    )
  );
  return to_jsonb(updated_row);
end;
$$;

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
  if p_plan_months not in (1, 2, 3, 6, 12) then raise exception 'Plano inválido'; end if;
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

create or replace function public.system_process_mercado_payment_v1(
  p_external_reference uuid,
  p_provider_payment_id text,
  p_status text,
  p_amount numeric,
  p_currency text,
  p_payment_method text,
  p_payment_type text,
  p_paid_at timestamptz,
  p_live_mode boolean,
  p_details jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  order_row public.platform_payment_orders%rowtype;
  account_row public.platform_accounts%rowtype;
  transaction_row public.platform_payment_transactions%rowtype;
  new_paid_until date;
  validation_error text;
begin
  if p_provider_payment_id is null or length(p_provider_payment_id) not between 1 and 200 then
    raise exception 'Pagamento inválido';
  end if;
  if p_status not in (
    'pending', 'in_process', 'authorized', 'approved', 'rejected',
    'cancelled', 'refunded', 'charged_back'
  ) then raise exception 'Status de pagamento inválido'; end if;

  select * into order_row
  from public.platform_payment_orders
  where id = p_external_reference
  for update;
  if order_row.id is null then
    return jsonb_build_object('accepted', false, 'reason', 'ORDER_NOT_FOUND');
  end if;

  insert into public.platform_payment_transactions (
    order_id, provider_payment_id, status, amount, currency,
    payment_method, payment_type, paid_at, live_mode, details
  ) values (
    order_row.id, left(p_provider_payment_id, 200), p_status, p_amount,
    left(coalesce(p_currency, ''), 8), left(coalesce(p_payment_method, ''), 80),
    left(coalesce(p_payment_type, ''), 80), p_paid_at, p_live_mode,
    coalesce(p_details, '{}'::jsonb)
  )
  on conflict (provider_payment_id) do update set
    status = excluded.status,
    amount = excluded.amount,
    currency = excluded.currency,
    payment_method = excluded.payment_method,
    payment_type = excluded.payment_type,
    paid_at = excluded.paid_at,
    live_mode = excluded.live_mode,
    details = excluded.details,
    updated_at = now()
  returning * into transaction_row;

  if transaction_row.order_id <> order_row.id then
    raise exception 'Pagamento associado a outro pedido';
  end if;

  validation_error := case
    when p_amount is null or round(p_amount, 2) <> order_row.amount then 'AMOUNT_MISMATCH'
    when p_currency is distinct from order_row.currency then 'CURRENCY_MISMATCH'
    when p_live_mode is distinct from order_row.live_mode then 'ENVIRONMENT_MISMATCH'
    else null
  end;
  if validation_error is not null then
    update public.platform_payment_transactions
      set status = lower(validation_error), updated_at = now()
      where id = transaction_row.id;
    update public.platform_payment_orders
      set status = 'error', failure_reason = validation_error, updated_at = now()
      where id = order_row.id;
    return jsonb_build_object('accepted', false, 'reason', validation_error);
  end if;

  if p_status = 'approved'
    and order_row.payment_mode = 'one_time'
    and order_row.access_granted_at is not null then
    return jsonb_build_object(
      'accepted', true,
      'granted', false,
      'reason', 'ORDER_ALREADY_GRANTED'
    );
  end if;

  if p_status = 'approved' and transaction_row.access_granted_at is null then
    select * into strict account_row
    from public.platform_accounts where user_id = order_row.user_id for update;

    if not private.is_platform_admin_id(order_row.user_id)
      and account_row.access_type <> 'lifetime' then
      new_paid_until := (
        greatest(current_date, coalesce(account_row.paid_until, current_date))
        + make_interval(months => order_row.plan_months)
      )::date;
      update public.platform_accounts set
        status = 'active',
        paid_until = new_paid_until,
        access_type = 'paid',
        access_amount = order_row.amount,
        expiry_notified_at = null,
        approved_at = now(),
        approved_by = 'mercado_pago',
        last_payment_transaction_id = transaction_row.id,
        updated_at = now()
      where user_id = order_row.user_id;
    else
      new_paid_until := account_row.paid_until;
    end if;

    update public.platform_payment_transactions
      set access_granted_at = now(), updated_at = now()
      where id = transaction_row.id;
    update public.platform_payment_orders
      set status = 'approved', access_granted_at = coalesce(access_granted_at, now()),
          failure_reason = null, updated_at = now()
      where id = order_row.id;
    insert into public.platform_access_log (
      user_id, actor_id, action, action_label, details
    ) values (
      order_row.user_id,
      'mercado_pago',
      'payment_approved',
      'Pagamento confirmado automaticamente pelo Mercado Pago',
      jsonb_build_object(
        'orderId', order_row.id,
        'paymentId', p_provider_payment_id,
        'mode', order_row.payment_mode,
        'planMonths', order_row.plan_months,
        'amount', order_row.amount,
        'pricingSource', case when account_row.monthly_fee is null then 'global' else 'custom' end,
        'paidUntil', new_paid_until,
        'paymentMethod', coalesce(p_payment_method, ''),
        'paymentType', coalesce(p_payment_type, '')
      )
    );
    return jsonb_build_object('accepted', true, 'granted', true, 'paidUntil', new_paid_until);
  end if;

  if p_status in ('refunded', 'charged_back') then
    update public.platform_payment_orders
      set status = p_status, updated_at = now()
      where id = order_row.id;
    update public.platform_accounts set
      status = 'blocked',
      paid_until = current_date - 1,
      expiry_notified_at = now(),
      updated_at = now()
    where user_id = order_row.user_id
      and last_payment_transaction_id = transaction_row.id
      and access_type <> 'lifetime'
      and status <> 'blocked'
    returning * into account_row;
    if account_row.user_id is not null then
      insert into public.platform_access_log (
        user_id, actor_id, action, action_label, details
      ) values (
        order_row.user_id, 'mercado_pago', p_status,
        case when p_status = 'charged_back'
          then 'Acesso bloqueado após contestação do pagamento'
          else 'Acesso bloqueado após estorno do pagamento' end,
        jsonb_build_object('orderId', order_row.id, 'paymentId', p_provider_payment_id)
      );
    end if;
    return jsonb_build_object('accepted', true, 'granted', false, 'blocked', account_row.user_id is not null);
  end if;

  update public.platform_payment_orders set
    status = case when status in ('approved', 'refunded', 'charged_back') then status else p_status end,
    updated_at = now()
  where id = order_row.id;
  return jsonb_build_object(
    'accepted', true,
    'granted', transaction_row.access_granted_at is not null,
    'status', p_status
  );
end;
$$;

revoke all on function public.admin_update_platform_settings_v2(numeric, text, text) from public, anon, authenticated;
revoke all on function public.admin_update_platform_account_v2(text, text, text, boolean, numeric) from public, anon, authenticated;
revoke all on function public.admin_grant_platform_access_v4(text, integer, text, boolean, numeric, text, numeric, text, text) from public, anon, authenticated;
grant execute on function public.admin_update_platform_settings_v2(numeric, text, text) to anon, authenticated;
grant execute on function public.admin_update_platform_account_v2(text, text, text, boolean, numeric) to anon, authenticated;
grant execute on function public.admin_grant_platform_access_v4(text, integer, text, boolean, numeric, text, numeric, text, text) to anon, authenticated;

revoke all on function public.ensure_platform_account(text, text) from public, anon, authenticated;
revoke all on function public.create_platform_payment_order_v1(integer, text) from public, anon, authenticated;
revoke all on function public.system_process_mercado_payment_v1(uuid, text, text, numeric, text, text, text, timestamptz, boolean, jsonb) from public, anon, authenticated;
grant execute on function public.ensure_platform_account(text, text) to anon, authenticated;
grant execute on function public.create_platform_payment_order_v1(integer, text) to anon, authenticated;
grant execute on function public.system_process_mercado_payment_v1(uuid, text, text, numeric, text, text, text, timestamptz, boolean, jsonb) to service_role;

notify pgrst, 'reload schema';
commit;
