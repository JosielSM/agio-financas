-- Liberações manuais pagas ou gratuitas, com opção de 15 dias e períodos em meses.
-- Preserva contas, datas e histórico existentes.

begin;

alter table public.platform_accounts
  add column if not exists expiry_notified_at timestamptz;

alter table public.platform_accounts
  add column if not exists access_type text not null default 'paid'
  check (access_type in ('paid', 'free', 'lifetime'));

alter table public.platform_accounts
  add column if not exists access_amount numeric(12,2) not null default 0
  check (access_amount >= 0);

update public.platform_accounts
set access_type = 'lifetime', access_amount = 0
where status = 'active' and paid_until is null and coalesce(monthly_fee, 0) = 0;

create or replace function public.admin_grant_platform_access_v2(
  p_user_id text,
  p_period_value integer,
  p_period_unit text,
  p_monthly_fee numeric,
  p_access_type text,
  p_access_amount numeric
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_id text := auth.jwt()->>'sub';
  updated_row public.platform_accounts%rowtype;
  expiration_date date;
  period_label text;
  access_label text;
begin
  if not public.is_platform_admin() then
    raise exception 'Acesso administrativo necessário';
  end if;
  if p_user_id is null or btrim(p_user_id) = '' then
    raise exception 'Conta inválida';
  end if;
  if exists (select 1 from public.platform_admins where user_id = p_user_id) then
    raise exception 'A conta proprietária já possui acesso permanente';
  end if;
  if p_period_unit is null or p_period_unit not in ('days', 'months') then
    raise exception 'Unidade de período inválida';
  end if;
  if p_period_value is null
    or (p_period_unit = 'days' and (p_period_value < 1 or p_period_value > 365))
    or (p_period_unit = 'months' and (p_period_value < 1 or p_period_value > 24)) then
    raise exception 'Período de acesso inválido';
  end if;
  if p_access_type is null or p_access_type not in ('paid', 'free') then
    raise exception 'Escolha se a liberação foi paga ou gratuita';
  end if;
  if p_monthly_fee is not null and p_monthly_fee < 0 then
    raise exception 'A mensalidade não pode ser negativa';
  end if;
  if p_access_amount is not null and p_access_amount < 0 then
    raise exception 'O valor recebido não pode ser negativo';
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

  update public.platform_accounts
  set
    status = 'active',
    monthly_fee = coalesce(p_monthly_fee, monthly_fee),
    paid_until = expiration_date,
    access_type = p_access_type,
    access_amount = case when p_access_type = 'free' then 0 else coalesce(p_access_amount, 0) end,
    expiry_notified_at = null,
    approved_at = now(),
    approved_by = actor_id,
    updated_at = now()
  where user_id = p_user_id
  returning * into updated_row;

  if updated_row.user_id is null then
    raise exception 'Conta não encontrada';
  end if;

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
      'monthlyFee', updated_row.monthly_fee,
      'startsAt', current_date,
      'paidUntil', updated_row.paid_until,
      'paymentMethod', 'manual',
      'replacedPreviousExpiration', true
    )
  );

  return to_jsonb(updated_row);
end;
$$;

create or replace function public.admin_grant_platform_access(
  p_user_id text,
  p_months integer default 1,
  p_monthly_fee numeric default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  return public.admin_grant_platform_access_v2(
    p_user_id,
    p_months,
    'months',
    p_monthly_fee,
    'paid',
    coalesce(p_monthly_fee, 0) * p_months
  );
end;
$$;

create or replace function public.admin_grant_platform_lifetime(p_user_id text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_id text := auth.jwt()->>'sub';
  updated_row public.platform_accounts%rowtype;
begin
  if not public.is_platform_admin() then
    raise exception 'Acesso administrativo necessário';
  end if;
  if exists (select 1 from public.platform_admins where user_id = p_user_id) then
    raise exception 'A conta proprietária já possui acesso permanente';
  end if;

  update public.platform_accounts
  set
    status = 'active',
    monthly_fee = 0,
    paid_until = null,
    access_type = 'lifetime',
    access_amount = 0,
    expiry_notified_at = null,
    approved_at = now(),
    approved_by = actor_id,
    updated_at = now()
  where user_id = p_user_id
  returning * into updated_row;

  if updated_row.user_id is null then
    raise exception 'Conta não encontrada';
  end if;

  insert into public.platform_access_log (
    user_id, actor_id, action, action_label, details
  ) values (
    p_user_id,
    actor_id,
    'lifetime',
    'Acesso vitalício de colaborador liberado',
    jsonb_build_object('monthlyFee', 0, 'paidUntil', null, 'accessType', 'lifetime')
  );

  return to_jsonb(updated_row);
end;
$$;

revoke all on function public.admin_grant_platform_access_v2(text, integer, text, numeric, text, numeric) from public;
grant execute on function public.admin_grant_platform_access_v2(text, integer, text, numeric, text, numeric) to anon, authenticated;

commit;
