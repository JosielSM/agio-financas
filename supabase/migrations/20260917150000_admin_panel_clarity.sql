-- Dados de cobrança manual e histórico paginado para o painel do proprietário.
begin;

alter table public.platform_accounts
  add column if not exists manual_payment_method text;

alter table public.platform_accounts
  drop constraint if exists platform_accounts_manual_payment_method_check;
alter table public.platform_accounts
  add constraint platform_accounts_manual_payment_method_check
  check (manual_payment_method is null or manual_payment_method in ('cash', 'pix_direct', 'bank_transfer', 'card_external', 'other'));

create index if not exists platform_access_log_user_created_idx
  on public.platform_access_log (user_id, created_at desc);

create or replace function public.admin_grant_platform_access_v6(
  p_user_id text,
  p_period_value integer,
  p_period_unit text,
  p_pricing_tier text,
  p_monthly_fee numeric,
  p_access_type text,
  p_access_amount numeric,
  p_payment_method text,
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
  setting_row public.platform_settings%rowtype;
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
  if p_user_id is null or btrim(p_user_id) = '' or private.is_platform_admin_id(p_user_id) then
    raise exception 'Conta inválida para liberação';
  end if;
  if p_period_unit not in ('days', 'months')
    or p_period_value is null
    or (p_period_unit = 'days' and p_period_value not between 1 and 365)
    or (p_period_unit = 'months' and p_period_value not between 1 and 24) then
    raise exception 'Período de acesso inválido';
  end if;
  if p_pricing_tier not in ('global', 'launch_locked', 'custom') then
    raise exception 'Política de preço inválida';
  end if;
  if p_access_type not in ('paid', 'free') then
    raise exception 'Tipo de liberação inválido';
  end if;
  if p_pricing_tier = 'custom'
    and (p_monthly_fee is null or p_monthly_fee <= 0 or p_monthly_fee > 1000000) then
    raise exception 'Mensalidade personalizada inválida';
  end if;
  if p_access_amount is null or p_access_amount < 0 or p_access_amount > 10000000
    or (p_access_type = 'free' and p_access_amount <> 0)
    or (p_access_type = 'paid' and p_access_amount <= 0) then
    raise exception 'Valor recebido inválido';
  end if;
  if (p_access_type = 'paid' and (
    p_payment_method is null or p_payment_method not in (
      'cash', 'pix_direct', 'bank_transfer', 'card_external', 'other'
    )
  )) or (p_access_type = 'free' and p_payment_method is not null) then
    raise exception 'Informe como o pagamento manual foi recebido';
  end if;
  if length(coalesce(p_phone, '')) > 32 or length(coalesce(p_notes, '')) > 2000 then
    raise exception 'Dados administrativos inválidos';
  end if;

  perform 1 from public.platform_accounts where user_id = p_user_id for update;
  if not found then raise exception 'Conta não encontrada'; end if;

  select * into strict setting_row from public.platform_settings where id = 1;
  stored_fee := case p_pricing_tier
    when 'global' then null
    when 'launch_locked' then setting_row.launch_monthly_fee
    else round(p_monthly_fee, 2)
  end;
  effective_fee := coalesce(stored_fee, setting_row.default_monthly_fee, 0);
  if effective_fee <= 0 or effective_fee > 1000000 then
    raise exception 'Mensalidade efetiva inválida';
  end if;

  expiration_date := case
    when p_period_unit = 'days' then current_date + (p_period_value - 1)
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
    pricing_tier = p_pricing_tier,
    paid_until = expiration_date,
    access_type = p_access_type,
    access_amount = case when p_access_type = 'free' then 0 else p_access_amount end,
    last_payment_transaction_id = null,
    manual_payment_method = case when p_access_type = 'free' then null else p_payment_method end,
    trial_started_at = case when p_access_type = 'free' then coalesce(trial_started_at, now()) else trial_started_at end,
    expiry_notified_at = null,
    approved_at = now(),
    approved_by = actor_id,
    updated_at = now()
  where user_id = p_user_id
  returning * into updated_row;

  update public.platform_payment_orders set
    status = 'expired', failure_reason = 'ACCESS_GRANTED_MANUALLY', updated_at = now()
  where user_id = p_user_id and status in ('creating', 'pending', 'in_process', 'authorized');

  insert into public.platform_access_log (user_id, actor_id, action, action_label, details)
  values (
    p_user_id, actor_id,
    case when p_access_type = 'free' then 'grant_free' else 'grant_paid' end,
    access_label || ' de ' || period_label || ' liberado até ' || to_char(updated_row.paid_until, 'DD/MM/YYYY'),
    jsonb_build_object(
      'periodValue', p_period_value, 'periodUnit', p_period_unit,
      'periodLabel', period_label, 'accessType', p_access_type,
      'amount', updated_row.access_amount, 'pricingSource', updated_row.pricing_tier,
      'monthlyFee', effective_fee, 'startsAt', current_date,
      'paidUntil', updated_row.paid_until,
      'paymentMethod', coalesce(p_payment_method, 'courtesy'),
      'replacedPreviousExpiration', true
    )
  );
  return to_jsonb(updated_row);
end;
$$;

revoke all on function public.admin_grant_platform_access_v6(text, integer, text, text, numeric, text, numeric, text, text, text)
  from public, anon, authenticated;
grant execute on function public.admin_grant_platform_access_v6(text, integer, text, text, numeric, text, numeric, text, text, text)
  to anon, authenticated;

-- Chamadas antigas permanecem compatíveis, mas deixam o meio de pagamento
-- explicitamente como "outro" em vez de preservar um valor antigo incorreto.
create or replace function public.admin_grant_platform_access_v5(
  p_user_id text,
  p_period_value integer,
  p_period_unit text,
  p_pricing_tier text,
  p_monthly_fee numeric,
  p_access_type text,
  p_access_amount numeric,
  p_phone text,
  p_notes text
)
returns jsonb
language sql
security invoker
set search_path = ''
as $$
  select public.admin_grant_platform_access_v6(
    p_user_id, p_period_value, p_period_unit, p_pricing_tier,
    p_monthly_fee, p_access_type, p_access_amount,
    case when p_access_type = 'paid' then 'other' else null end,
    p_phone, p_notes
  );
$$;

create or replace function public.admin_get_platform_account_history_v1(
  p_user_id text default null,
  p_offset integer default 0,
  p_limit integer default 20
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_id text := private.current_user_id();
  events jsonb;
  has_more boolean;
  current_payment jsonb;
begin
  if not private.is_platform_admin_id(actor_id) then
    raise exception 'Acesso administrativo necessário';
  end if;
  if p_offset is null or p_offset < 0 or p_offset > 10000
    or p_limit is null or p_limit not between 1 and 50 then
    raise exception 'Paginação inválida';
  end if;
  if p_user_id is not null and not exists (
    select 1 from public.platform_accounts where user_id = p_user_id
  ) then
    raise exception 'Conta não encontrada';
  end if;

  if p_user_id is not null then
    select jsonb_build_object(
      'transactionId', payment.id,
      'status', payment.status,
      'amount', payment.amount,
      'paymentMethod', payment.payment_method,
      'paymentType', payment.payment_type,
      'paidAt', payment.paid_at,
      'accessGrantedAt', payment.access_granted_at,
      'planMonths', payment_order.plan_months,
      'liveMode', payment.live_mode
    ) into current_payment
    from public.platform_accounts account
    join public.platform_payment_transactions payment
      on payment.id = account.last_payment_transaction_id
    join public.platform_payment_orders payment_order on payment_order.id = payment.order_id
    where account.user_id = p_user_id;
  end if;

  with all_events as (
    select
      'log:' || log.id::text as event_id,
      log.created_at as occurred_at,
      jsonb_build_object(
        'id', 'log:' || log.id::text, 'kind', 'access', 'userId', log.user_id,
        'label', log.action_label, 'status', log.action,
        'occurredAt', log.created_at,
        'amount', case when jsonb_typeof(log.details->'amount') = 'number'
          then log.details->'amount' else null end,
        'paymentMethod', log.details->>'paymentMethod'
      ) as payload
    from public.platform_access_log log
    where (p_user_id is null or log.user_id = p_user_id)
      and log.action not in ('payment_approved', 'refunded', 'charged_back')

    union all

    select
      'order:' || payment_order.id::text,
      coalesce(payment.paid_at, payment.updated_at, payment_order.updated_at, payment_order.created_at),
      jsonb_build_object(
        'id', 'order:' || payment_order.id::text, 'kind', 'payment',
        'userId', payment_order.user_id,
        'label', case coalesce(payment.status, payment_order.status)
          when 'approved' then 'Pagamento confirmado pelo Mercado Pago'
          when 'refunded' then 'Pagamento estornado'
          when 'charged_back' then 'Pagamento contestado'
          else 'Pagamento: ' || coalesce(payment.status, payment_order.status) end,
        'status', coalesce(payment.status, payment_order.status),
        'occurredAt', coalesce(payment.paid_at, payment.updated_at, payment_order.updated_at, payment_order.created_at),
        'amount', to_jsonb(coalesce(payment.amount, payment_order.amount)),
        'paymentMethod', payment.payment_method, 'paymentType', payment.payment_type,
        'planMonths', payment_order.plan_months
      )
    from public.platform_payment_orders payment_order
    left join lateral (
      select transaction.* from public.platform_payment_transactions transaction
      where transaction.order_id = payment_order.id
      order by coalesce(transaction.paid_at, transaction.created_at) desc, transaction.id desc
      limit 1
    ) payment on true
    where p_user_id is null or payment_order.user_id = p_user_id
  ), page as (
    select * from all_events
    order by occurred_at desc, event_id desc
    limit p_limit + 1 offset p_offset
  ), numbered as (
    select *, row_number() over (order by occurred_at desc, event_id desc) as row_number
    from page
  )
  select
    coalesce(jsonb_agg(payload order by occurred_at desc, event_id desc)
      filter (where row_number <= p_limit), '[]'::jsonb),
    count(*) > p_limit
  into events, has_more
  from numbered;

  return jsonb_build_object(
    'events', events,
    'hasMore', has_more,
    'nextOffset', p_offset + jsonb_array_length(events),
    'currentPayment', current_payment
  );
end;
$$;

revoke all on function public.admin_get_platform_account_history_v1(text, integer, integer)
  from public, anon, authenticated;
grant execute on function public.admin_get_platform_account_history_v1(text, integer, integer)
  to anon, authenticated;

notify pgrst, 'reload schema';
commit;
