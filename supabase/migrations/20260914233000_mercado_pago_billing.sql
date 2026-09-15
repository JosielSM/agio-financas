-- Pagamentos automáticos e assinaturas do CredMais via Mercado Pago.
-- O navegador nunca concede acesso: somente o Worker, após consultar a API do
-- Mercado Pago, pode executar as funções reservadas ao service_role.

begin;

create table public.platform_payment_orders (
  id uuid primary key default gen_random_uuid(),
  user_id text not null references public.platform_accounts(user_id) on delete cascade,
  provider text not null default 'mercado_pago',
  payment_mode text not null,
  plan_months integer not null,
  monthly_fee numeric(12,2) not null,
  amount numeric(12,2) not null,
  currency text not null default 'BRL',
  status text not null default 'creating',
  request_key uuid not null default gen_random_uuid(),
  provider_reference text unique,
  checkout_url text,
  sandbox_checkout_url text,
  expires_at timestamptz,
  live_mode boolean not null default false,
  access_granted_at timestamptz,
  failure_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint platform_payment_orders_provider_check
    check (provider = 'mercado_pago'),
  constraint platform_payment_orders_mode_check
    check (payment_mode in ('one_time', 'subscription')),
  constraint platform_payment_orders_months_check
    check (plan_months between 1 and 12),
  constraint platform_payment_orders_fee_check
    check (monthly_fee > 0 and amount > 0),
  constraint platform_payment_orders_currency_check
    check (currency = 'BRL'),
  constraint platform_payment_orders_status_check
    check (status in (
      'creating', 'pending', 'in_process', 'authorized', 'approved',
      'rejected', 'cancelled', 'refunded', 'charged_back', 'expired', 'error'
    )),
  constraint platform_payment_orders_subscription_check
    check (payment_mode <> 'subscription' or plan_months = 1),
  constraint platform_payment_orders_request_key_key unique (request_key)
);

create index platform_payment_orders_user_created_idx
  on public.platform_payment_orders (user_id, created_at desc);
create index platform_payment_orders_status_idx
  on public.platform_payment_orders (status, expires_at);

create table public.platform_payment_transactions (
  id bigint generated always as identity primary key,
  order_id uuid not null references public.platform_payment_orders(id) on delete cascade,
  provider_payment_id text not null unique,
  status text not null,
  amount numeric(12,2),
  currency text,
  payment_method text,
  payment_type text,
  paid_at timestamptz,
  live_mode boolean not null default false,
  access_granted_at timestamptz,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint platform_payment_transactions_amount_check
    check (amount is null or amount >= 0),
  constraint platform_payment_transactions_details_check
    check (jsonb_typeof(details) = 'object')
);

create index platform_payment_transactions_order_idx
  on public.platform_payment_transactions (order_id, created_at desc);

create table public.platform_subscriptions (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null unique references public.platform_payment_orders(id) on delete cascade,
  user_id text not null references public.platform_accounts(user_id) on delete cascade,
  provider_subscription_id text not null unique,
  status text not null,
  amount numeric(12,2) not null,
  currency text not null default 'BRL',
  next_payment_date timestamptz,
  live_mode boolean not null default false,
  last_payment_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint platform_subscriptions_amount_check check (amount > 0),
  constraint platform_subscriptions_currency_check check (currency = 'BRL'),
  constraint platform_subscriptions_status_check
    check (status in ('pending', 'authorized', 'paused', 'cancelled'))
);

alter table public.platform_accounts
  add column if not exists last_payment_transaction_id bigint;

alter table public.platform_payment_orders enable row level security;
alter table public.platform_payment_transactions enable row level security;
alter table public.platform_subscriptions enable row level security;

revoke all on public.platform_payment_orders from public, anon, authenticated;
revoke all on public.platform_payment_transactions from public, anon, authenticated;
revoke all on public.platform_subscriptions from public, anon, authenticated;
revoke all on sequence public.platform_payment_transactions_id_seq from public, anon, authenticated;

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
  if p_plan_months not in (1, 2, 3, 6, 12) then
    raise exception 'Plano inválido';
  end if;
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
  if account_row.email = '' then
    raise exception 'Sua conta precisa ter um e-mail válido';
  end if;

  select * into strict setting_row from public.platform_settings where id = 1;
  effective_fee := round(coalesce(account_row.monthly_fee, setting_row.default_monthly_fee, 0), 2);
  if effective_fee <= 0 or effective_fee > 1000000 then
    raise exception 'A mensalidade ainda não foi configurada';
  end if;
  effective_amount := round(effective_fee * p_plan_months, 2);

  select * into order_row
  from public.platform_payment_orders
  where user_id = account_id
    and payment_mode = p_payment_mode
    and plan_months = p_plan_months
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

create or replace function public.get_my_billing_status_v1()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  account_id text := private.current_user_id();
begin
  if account_id is null then raise exception 'Usuário não autenticado'; end if;
  return jsonb_build_object(
    'orders', coalesce((
      select jsonb_agg(jsonb_build_object(
        'orderId', payment_order.id,
        'mode', payment_order.payment_mode,
        'planMonths', payment_order.plan_months,
        'amount', payment_order.amount,
        'currency', payment_order.currency,
        'status', payment_order.status,
        'createdAt', payment_order.created_at,
        'accessGrantedAt', payment_order.access_granted_at
      ) order by payment_order.created_at desc)
      from (
        select * from public.platform_payment_orders
        where user_id = account_id
        order by created_at desc
        limit 10
      ) payment_order
    ), '[]'::jsonb),
    'subscription', (
      select jsonb_build_object(
        'status', subscription.status,
        'amount', subscription.amount,
        'currency', subscription.currency,
        'nextPaymentDate', subscription.next_payment_date
      )
      from public.platform_subscriptions subscription
      where subscription.user_id = account_id
      order by subscription.created_at desc
      limit 1
    )
  );
end;
$$;

create or replace function public.system_attach_mercado_checkout_v1(
  p_order_id uuid,
  p_provider_reference text,
  p_checkout_url text,
  p_sandbox_checkout_url text,
  p_expires_at timestamptz,
  p_live_mode boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  saved public.platform_payment_orders%rowtype;
begin
  if p_provider_reference is null or length(p_provider_reference) not between 1 and 200 then
    raise exception 'Referência do provedor inválida';
  end if;
  if p_checkout_url is null or length(p_checkout_url) not between 10 and 2000 then
    raise exception 'URL de checkout inválida';
  end if;

  update public.platform_payment_orders set
    provider_reference = p_provider_reference,
    checkout_url = p_checkout_url,
    sandbox_checkout_url = nullif(p_sandbox_checkout_url, ''),
    expires_at = p_expires_at,
    live_mode = p_live_mode,
    status = 'pending',
    failure_reason = null,
    updated_at = now()
  where id = p_order_id and status = 'creating'
  returning * into saved;

  if saved.id is null then raise exception 'Pedido não está disponível'; end if;
  return jsonb_build_object('orderId', saved.id, 'status', saved.status);
end;
$$;

create or replace function public.system_mark_mercado_checkout_error_v1(
  p_order_id uuid,
  p_reason text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.platform_payment_orders set
    status = 'error',
    failure_reason = left(coalesce(p_reason, 'Falha ao criar checkout'), 500),
    updated_at = now()
  where id = p_order_id and status = 'creating';
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
        monthly_fee = order_row.monthly_fee,
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

create or replace function public.system_sync_mercado_subscription_v1(
  p_external_reference uuid,
  p_provider_subscription_id text,
  p_status text,
  p_amount numeric,
  p_currency text,
  p_next_payment_date timestamptz,
  p_live_mode boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  order_row public.platform_payment_orders%rowtype;
  saved public.platform_subscriptions%rowtype;
begin
  if p_status not in ('pending', 'authorized', 'paused', 'cancelled') then
    raise exception 'Status de assinatura inválido';
  end if;
  select * into order_row
  from public.platform_payment_orders
  where id = p_external_reference and payment_mode = 'subscription'
  for update;
  if order_row.id is null then
    return jsonb_build_object('accepted', false, 'reason', 'ORDER_NOT_FOUND');
  end if;
  if p_amount is null
    or round(p_amount, 2) <> order_row.amount
    or p_currency is distinct from order_row.currency
    or p_live_mode is distinct from order_row.live_mode then
    update public.platform_payment_orders set
      status = 'error', failure_reason = 'SUBSCRIPTION_VALIDATION_FAILED', updated_at = now()
    where id = order_row.id;
    return jsonb_build_object('accepted', false, 'reason', 'SUBSCRIPTION_VALIDATION_FAILED');
  end if;

  insert into public.platform_subscriptions (
    order_id, user_id, provider_subscription_id, status, amount,
    currency, next_payment_date, live_mode
  ) values (
    order_row.id, order_row.user_id, left(p_provider_subscription_id, 200),
    p_status, p_amount, p_currency, p_next_payment_date, p_live_mode
  )
  on conflict (provider_subscription_id) do update set
    status = excluded.status,
    amount = excluded.amount,
    currency = excluded.currency,
    next_payment_date = excluded.next_payment_date,
    live_mode = excluded.live_mode,
    updated_at = now()
  returning * into saved;

  update public.platform_payment_orders set
    status = case
      when status = 'approved' then status
      when p_status = 'cancelled' then 'cancelled'
      when p_status = 'authorized' then 'authorized'
      else 'pending'
    end,
    updated_at = now()
  where id = order_row.id;
  return jsonb_build_object('accepted', true, 'status', saved.status);
end;
$$;

revoke all on function public.create_platform_payment_order_v1(integer, text) from public, anon, authenticated;
revoke all on function public.get_my_billing_status_v1() from public, anon, authenticated;
grant execute on function public.create_platform_payment_order_v1(integer, text) to anon, authenticated;
grant execute on function public.get_my_billing_status_v1() to anon, authenticated;

revoke all on function public.system_attach_mercado_checkout_v1(uuid, text, text, text, timestamptz, boolean) from public, anon, authenticated;
revoke all on function public.system_mark_mercado_checkout_error_v1(uuid, text) from public, anon, authenticated;
revoke all on function public.system_process_mercado_payment_v1(uuid, text, text, numeric, text, text, text, timestamptz, boolean, jsonb) from public, anon, authenticated;
revoke all on function public.system_sync_mercado_subscription_v1(uuid, text, text, numeric, text, timestamptz, boolean) from public, anon, authenticated;
grant execute on function public.system_attach_mercado_checkout_v1(uuid, text, text, text, timestamptz, boolean) to service_role;
grant execute on function public.system_mark_mercado_checkout_error_v1(uuid, text) to service_role;
grant execute on function public.system_process_mercado_payment_v1(uuid, text, text, numeric, text, text, text, timestamptz, boolean, jsonb) to service_role;
grant execute on function public.system_sync_mercado_subscription_v1(uuid, text, text, numeric, text, timestamptz, boolean) to service_role;

commit;
