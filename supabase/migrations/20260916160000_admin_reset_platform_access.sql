-- Reset administrativo e auditável do plano de uma conta.
-- Preserva dados do negócio e a política de preço; somente o acesso é zerado.

begin;

alter table public.platform_accounts
  add column if not exists access_reset_at timestamptz;

create or replace function public.admin_reset_platform_access_v1(p_user_id text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_id text := private.current_user_id();
  previous_row public.platform_accounts%rowtype;
  saved public.platform_accounts%rowtype;
  invalidated_orders integer := 0;
begin
  if actor_id is null or not private.is_platform_admin_id(actor_id) then
    raise exception 'Acesso administrativo necessário';
  end if;
  if p_user_id is null or btrim(p_user_id) = '' or length(p_user_id) > 200 then
    raise exception 'Conta inválida';
  end if;
  if private.is_platform_admin_id(p_user_id) then
    raise exception 'A conta proprietária do painel não pode ter o acesso resetado';
  end if;

  select * into previous_row
  from public.platform_accounts
  where user_id = p_user_id;
  if previous_row.user_id is null then
    raise exception 'Conta não encontrada';
  end if;

  -- Uma recorrência precisa ser cancelada no provedor antes do reset. Apenas
  -- zerar o banco local não impediria uma cobrança futura no Mercado Pago.
  if exists (
    select 1
    from public.platform_subscriptions
    where user_id = p_user_id
      and status in ('pending', 'authorized', 'paused')
  ) or exists (
    select 1
    from public.platform_payment_orders
    where user_id = p_user_id
      and payment_mode = 'subscription'
      and status in ('creating', 'pending', 'in_process', 'authorized')
  ) then
    raise exception 'Esta conta possui assinatura recorrente ativa ou pendente. Cancele-a no Mercado Pago antes de resetar o plano.';
  end if;

  -- Invalida somente checkouts avulsos ainda abertos. O marcador na conta
  -- também protege contra webhooks atrasados e corridas com um checkout antigo.
  with invalidated as (
    update public.platform_payment_orders
    set
      status = 'expired',
      failure_reason = 'ADMIN_ACCESS_RESET',
      updated_at = now()
    where user_id = p_user_id
      and payment_mode = 'one_time'
      and status in ('creating', 'pending', 'in_process', 'authorized')
    returning 1
  )
  select count(*) into invalidated_orders from invalidated;

  update public.platform_accounts
  set
    status = 'pending',
    paid_until = null,
    access_type = 'paid',
    access_amount = 0,
    expiry_notified_at = null,
    approved_at = null,
    approved_by = null,
    last_payment_transaction_id = null,
    access_reset_at = now(),
    updated_at = now()
  where user_id = p_user_id
  returning * into saved;

  insert into public.platform_access_log (
    user_id, actor_id, action, action_label, details
  ) values (
    p_user_id,
    actor_id,
    'access_reset',
    'Plano e validade resetados pelo painel administrativo',
    jsonb_build_object(
      'previousStatus', previous_row.status,
      'previousPaidUntil', previous_row.paid_until,
      'previousAccessType', previous_row.access_type,
      'previousAccessAmount', previous_row.access_amount,
      'previousLastPaymentTransactionId', previous_row.last_payment_transaction_id,
      'invalidatedCheckoutCount', invalidated_orders,
      'businessDataPreserved', true,
      'pricingPreserved', true
    )
  );

  return to_jsonb(saved);
end;
$$;

revoke all on function public.admin_reset_platform_access_v1(text)
  from public, anon, authenticated;
grant execute on function public.admin_reset_platform_access_v1(text)
  to anon, authenticated;

comment on function public.admin_reset_platform_access_v1(text) is
  'Zera o acesso de uma conta sem apagar dados do negócio nem sua política de preço.';

-- Mantém o processamento idempotente existente e acrescenta a barreira contra
-- pagamentos originados por checkouts anteriores ao último reset administrativo.
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

  if p_status in ('pending', 'in_process', 'authorized', 'approved')
    and exists (
      select 1
      from public.platform_accounts account
      where account.user_id = order_row.user_id
        and account.access_reset_at is not null
        and order_row.created_at <= account.access_reset_at
    ) then
    update public.platform_payment_orders
    set
      status = 'expired',
      failure_reason = 'ADMIN_ACCESS_RESET',
      updated_at = now()
    where id = order_row.id;
    return jsonb_build_object(
      'accepted', false,
      'granted', false,
      'reason', 'ORDER_INVALIDATED_BY_ADMIN_RESET'
    );
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

revoke all on function public.system_process_mercado_payment_v1(
  uuid, text, text, numeric, text, text, text, timestamptz, boolean, jsonb
) from public, anon, authenticated;
grant execute on function public.system_process_mercado_payment_v1(
  uuid, text, text, numeric, text, text, text, timestamptz, boolean, jsonb
) to service_role;

commit;
