-- Política comercial do CredMais.
-- - lançamento: R$ 39,90 protegido para a coorte inicial;
-- - preço normal futuro: R$ 59,90 para novas contas;
-- - teste automático, único e completo por 15 dias;
-- - preço personalizado e acesso vitalício continuam controlados pelo administrador.

begin;

alter table public.platform_settings
  add column if not exists launch_monthly_fee numeric(12,2) not null default 39.90,
  add column if not exists standard_monthly_fee numeric(12,2) not null default 59.90,
  add column if not exists pricing_phase text not null default 'launch',
  add column if not exists trial_days smallint not null default 15;

alter table public.platform_settings
  alter column default_monthly_fee set default 39.90;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.platform_settings'::regclass
      and conname = 'platform_settings_launch_monthly_fee_check'
  ) then
    alter table public.platform_settings
      add constraint platform_settings_launch_monthly_fee_check
      check (launch_monthly_fee > 0 and launch_monthly_fee <= 1000000) not valid;
    alter table public.platform_settings
      validate constraint platform_settings_launch_monthly_fee_check;
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.platform_settings'::regclass
      and conname = 'platform_settings_standard_monthly_fee_check'
  ) then
    alter table public.platform_settings
      add constraint platform_settings_standard_monthly_fee_check
      check (standard_monthly_fee >= launch_monthly_fee and standard_monthly_fee <= 1000000) not valid;
    alter table public.platform_settings
      validate constraint platform_settings_standard_monthly_fee_check;
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.platform_settings'::regclass
      and conname = 'platform_settings_pricing_phase_check'
  ) then
    alter table public.platform_settings
      add constraint platform_settings_pricing_phase_check
      check (pricing_phase in ('launch', 'standard')) not valid;
    alter table public.platform_settings
      validate constraint platform_settings_pricing_phase_check;
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.platform_settings'::regclass
      and conname = 'platform_settings_trial_days_check'
  ) then
    alter table public.platform_settings
      add constraint platform_settings_trial_days_check
      check (trial_days = 15) not valid;
    alter table public.platform_settings
      validate constraint platform_settings_trial_days_check;
  end if;
end;
$$;

update public.platform_settings
set
  launch_monthly_fee = 39.90,
  standard_monthly_fee = case
    when standard_monthly_fee < 39.90 then 59.90
    else standard_monthly_fee
  end,
  trial_days = 15,
  default_monthly_fee = case
    when pricing_phase = 'standard' then greatest(standard_monthly_fee, 39.90)
    else 39.90
  end,
  updated_at = now()
where id = 1;

alter table public.platform_accounts
  add column if not exists pricing_tier text,
  add column if not exists trial_started_at timestamptz;

-- A coluna é inicialmente anulável para distinguir com segurança as contas anteriores
-- das contas criadas depois desta migração. Preços personalizados existentes são preservados.
update public.platform_accounts account
set pricing_tier = case
  when private.is_platform_admin_id(account.user_id)
    or account.access_type = 'lifetime'
    or (account.status = 'active' and account.paid_until is null and coalesce(account.monthly_fee, 0) = 0)
    then 'lifetime'
  when account.monthly_fee is not null and account.monthly_fee > 0 then 'custom'
  else 'launch_locked'
end
where account.pricing_tier is null;

-- Todas as contas sem preço individual que já existiam fazem parte da coorte de lançamento.
update public.platform_accounts
set
  monthly_fee = 39.90,
  pricing_tier = 'launch_locked',
  updated_at = now()
where pricing_tier = 'launch_locked'
  and (monthly_fee is null or monthly_fee <= 0);

update public.platform_accounts
set
  monthly_fee = 0,
  pricing_tier = 'lifetime',
  updated_at = now()
where pricing_tier = 'lifetime';

alter table public.platform_accounts
  alter column pricing_tier set default 'global',
  alter column pricing_tier set not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.platform_accounts'::regclass
      and conname = 'platform_accounts_pricing_tier_check'
  ) then
    alter table public.platform_accounts
      add constraint platform_accounts_pricing_tier_check
      check (pricing_tier in ('global', 'launch_locked', 'custom', 'lifetime')) not valid;
    alter table public.platform_accounts
      validate constraint platform_accounts_pricing_tier_check;
  end if;
end;
$$;

create index if not exists platform_accounts_pricing_tier_idx
  on public.platform_accounts (pricing_tier);

-- Um acesso gratuito anterior conta como teste já utilizado.
update public.platform_accounts
set trial_started_at = coalesce(approved_at, created_at, now())
where access_type = 'free'
  and trial_started_at is null;

-- Contas que ainda aguardavam a primeira liberação recebem os 15 dias uma única vez.
with activated_trials as (
  update public.platform_accounts account
  set
    status = 'active',
    paid_until = current_date + 14,
    access_type = 'free',
    access_amount = 0,
    trial_started_at = now(),
    expiry_notified_at = null,
    approved_at = now(),
    approved_by = 'automatic_trial',
    updated_at = now()
  where account.status = 'pending'
    and account.trial_started_at is null
    and not private.is_platform_admin_id(account.user_id)
  returning account.user_id, account.paid_until, account.monthly_fee, account.pricing_tier
)
insert into public.platform_access_log (
  user_id, actor_id, action, action_label, details
)
select
  user_id,
  'system',
  'trial_started',
  'Teste gratuito de 15 dias iniciado automaticamente',
  jsonb_build_object(
    'trialDays', 15,
    'paidUntil', paid_until,
    'monthlyFee', monthly_fee,
    'pricingSource', pricing_tier,
    'automatic', true
  )
from activated_trials;

-- Checkouts antigos com R$ 40,00 não podem continuar válidos após a nova política.
update public.platform_payment_orders payment_order
set
  status = 'expired',
  failure_reason = 'PRICE_CHANGED',
  updated_at = now()
from public.platform_accounts account, public.platform_settings setting
where payment_order.user_id = account.user_id
  and setting.id = 1
  and payment_order.status in ('creating', 'pending', 'in_process', 'authorized')
  and payment_order.monthly_fee is distinct from round(
    coalesce(account.monthly_fee, setting.default_monthly_fee),
    2
  );

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
  created_account_id text;
  effective_status text;
  is_admin boolean;
begin
  if account_id is null then raise exception 'Usuário não autenticado'; end if;
  if length(coalesce(p_display_name, '')) > 160 then raise exception 'Nome muito longo'; end if;
  if length(coalesce(p_phone, '')) > 32 then raise exception 'Telefone inválido'; end if;

  select * into strict setting_row
  from public.platform_settings
  where id = 1;

  is_admin := private.is_platform_admin_id(account_id);

  insert into public.platform_accounts (
    user_id, email, display_name, phone, status, monthly_fee, paid_until,
    access_type, access_amount, pricing_tier, trial_started_at,
    access_requested_at, approved_at, approved_by, last_seen_at
  ) values (
    account_id,
    left(account_email, 254),
    left(coalesce(p_display_name, ''), 160),
    left(coalesce(p_phone, ''), 32),
    'active',
    case
      when is_admin then 0
      when setting_row.pricing_phase = 'launch' then setting_row.launch_monthly_fee
      else null
    end,
    case when is_admin then null else current_date + (setting_row.trial_days - 1) end,
    case when is_admin then 'lifetime' else 'free' end,
    0,
    case
      when is_admin then 'lifetime'
      when setting_row.pricing_phase = 'launch' then 'launch_locked'
      else 'global'
    end,
    case when is_admin then null else now() end,
    now(),
    now(),
    case when is_admin then account_id else 'automatic_trial' end,
    now()
  )
  on conflict (user_id) do nothing
  returning user_id into created_account_id;

  if created_account_id is null then
    update public.platform_accounts set
      email = case when account_email <> '' then left(account_email, 254) else email end,
      display_name = case
        when coalesce(p_display_name, '') <> '' then left(p_display_name, 160)
        else display_name
      end,
      phone = case when coalesce(p_phone, '') <> '' then left(p_phone, 32) else phone end,
      last_seen_at = now(),
      updated_at = now()
    where user_id = account_id;
  elsif not is_admin then
    insert into public.platform_access_log (
      user_id, actor_id, action, action_label, details
    ) values (
      account_id,
      'system',
      'trial_started',
      'Teste gratuito de 15 dias iniciado automaticamente',
      jsonb_build_object(
        'trialDays', setting_row.trial_days,
        'paidUntil', current_date + (setting_row.trial_days - 1),
        'monthlyFee', case
          when setting_row.pricing_phase = 'launch' then setting_row.launch_monthly_fee
          else setting_row.default_monthly_fee
        end,
        'pricingSource', case
          when setting_row.pricing_phase = 'launch' then 'launch_locked'
          else 'global'
        end,
        'automatic', true
      )
    );
  end if;

  select * into strict account_row
  from public.platform_accounts
  where user_id = account_id;

  effective_status := case
    when is_admin then 'admin'
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
    'launchMonthlyFee', setting_row.launch_monthly_fee,
    'standardMonthlyFee', setting_row.standard_monthly_fee,
    'pricingPhase', setting_row.pricing_phase,
    'monthlyFeeSource', account_row.pricing_tier,
    'paidUntil', account_row.paid_until,
    'requestedAt', account_row.access_requested_at,
    'accessType', account_row.access_type,
    'trialDays', setting_row.trial_days,
    'trialStartedAt', account_row.trial_started_at,
    'supportPhone', coalesce(setting_row.support_phone, '')
  );
end;
$$;

create or replace function public.admin_update_platform_settings_v3(
  p_standard_monthly_fee numeric,
  p_pricing_phase text,
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
  next_fee numeric(12,2);
  saved public.platform_settings%rowtype;
begin
  if not private.is_platform_admin_id(actor_id) then
    raise exception 'Acesso administrativo necessário';
  end if;
  if p_pricing_phase not in ('launch', 'standard') then
    raise exception 'Escolha uma fase de preço válida';
  end if;
  if p_standard_monthly_fee is null
    or p_standard_monthly_fee < 39.90
    or p_standard_monthly_fee > 1000000 then
    raise exception 'O preço normal deve ser igual ou maior que R$ 39,90';
  end if;
  if length(coalesce(p_billing_message, '')) not between 1 and 4000
    or length(coalesce(p_support_phone, '')) > 32 then
    raise exception 'Configuração de cobrança inválida';
  end if;

  select default_monthly_fee into strict previous_fee
  from public.platform_settings
  where id = 1
  for update;

  next_fee := case
    when p_pricing_phase = 'launch' then 39.90
    else round(p_standard_monthly_fee, 2)
  end;

  update public.platform_settings set
    launch_monthly_fee = 39.90,
    standard_monthly_fee = round(p_standard_monthly_fee, 2),
    pricing_phase = p_pricing_phase,
    trial_days = 15,
    default_monthly_fee = next_fee,
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
          and account.pricing_tier = 'global'
      );
  end if;

  insert into public.platform_access_log (
    user_id, actor_id, action, action_label, details
  ) values (
    actor_id,
    actor_id,
    'pricing_policy_update',
    case when p_pricing_phase = 'launch'
      then 'Preço de lançamento ativado para novas contas'
      else 'Preço normal ativado para novas contas'
    end,
    jsonb_build_object(
      'previousDefaultMonthlyFee', previous_fee,
      'defaultMonthlyFee', saved.default_monthly_fee,
      'launchMonthlyFee', saved.launch_monthly_fee,
      'standardMonthlyFee', saved.standard_monthly_fee,
      'pricingPhase', saved.pricing_phase,
      'trialDays', saved.trial_days,
      'launchAccountsPreserved', true,
      'automaticPaymentOnly', true
    )
  );
  return to_jsonb(saved);
end;
$$;

create or replace function public.admin_update_platform_account_v3(
  p_user_id text,
  p_phone text,
  p_notes text,
  p_pricing_tier text,
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
  setting_row public.platform_settings%rowtype;
  saved public.platform_accounts%rowtype;
  requested_fee numeric(12,2);
  requested_tier text;
  effective_fee numeric(12,2);
begin
  if not private.is_platform_admin_id(actor_id) then
    raise exception 'Acesso administrativo necessário';
  end if;
  if p_user_id is null or btrim(p_user_id) = '' then raise exception 'Conta inválida'; end if;
  if p_pricing_tier not in ('global', 'launch_locked', 'custom') then
    raise exception 'Escolha uma política de preço válida';
  end if;
  if length(coalesce(p_phone, '')) > 32 then raise exception 'Telefone inválido'; end if;
  if length(coalesce(p_notes, '')) > 2000 then raise exception 'Observação muito longa'; end if;
  if p_pricing_tier = 'custom'
    and (p_monthly_fee is null or p_monthly_fee <= 0 or p_monthly_fee > 1000000) then
    raise exception 'Mensalidade personalizada inválida';
  end if;

  select * into previous_row
  from public.platform_accounts
  where user_id = p_user_id
  for update;
  if previous_row.user_id is null then raise exception 'Conta não encontrada'; end if;

  select * into strict setting_row from public.platform_settings where id = 1;

  if previous_row.access_type = 'lifetime' then
    requested_tier := 'lifetime';
    requested_fee := 0;
  else
    requested_tier := p_pricing_tier;
    requested_fee := case p_pricing_tier
      when 'global' then null
      when 'launch_locked' then setting_row.launch_monthly_fee
      else round(p_monthly_fee, 2)
    end;
  end if;

  update public.platform_accounts set
    phone = coalesce(p_phone, ''),
    notes = coalesce(p_notes, ''),
    monthly_fee = requested_fee,
    pricing_tier = requested_tier,
    updated_at = now()
  where user_id = p_user_id
  returning * into saved;

  effective_fee := coalesce(saved.monthly_fee, setting_row.default_monthly_fee, 0);

  if previous_row.monthly_fee is distinct from saved.monthly_fee
    or previous_row.pricing_tier is distinct from saved.pricing_tier then
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
      'pricingSource', saved.pricing_tier,
      'monthlyFee', effective_fee
    )
  );
  return to_jsonb(saved);
end;
$$;

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
  if p_pricing_tier not in ('global', 'launch_locked', 'custom') then
    raise exception 'Escolha uma política de preço válida';
  end if;
  if p_access_type not in ('paid', 'free') then
    raise exception 'Escolha se a liberação foi paga ou gratuita';
  end if;
  if p_pricing_tier = 'custom'
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
    trial_started_at = case
      when p_access_type = 'free' then coalesce(trial_started_at, now())
      else trial_started_at
    end,
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
      'pricingSource', updated_row.pricing_tier,
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

create or replace function public.admin_grant_platform_lifetime_v2(
  p_user_id text,
  p_phone text default null,
  p_notes text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_id text := private.current_user_id();
  updated_row public.platform_accounts%rowtype;
begin
  if not private.is_platform_admin_id(actor_id) then
    raise exception 'Acesso administrativo necessário';
  end if;
  if p_user_id is null or btrim(p_user_id) = '' then raise exception 'Conta inválida'; end if;
  if private.is_platform_admin_id(p_user_id) then
    raise exception 'A conta proprietária já possui acesso permanente';
  end if;
  if length(coalesce(p_phone, '')) > 32 or length(coalesce(p_notes, '')) > 2000 then
    raise exception 'Dados administrativos inválidos';
  end if;

  update public.platform_accounts set
    status = 'active',
    phone = case when p_phone is null then phone else p_phone end,
    notes = case when p_notes is null then notes else p_notes end,
    monthly_fee = 0,
    pricing_tier = 'lifetime',
    paid_until = null,
    access_type = 'lifetime',
    access_amount = 0,
    expiry_notified_at = null,
    approved_at = now(),
    approved_by = actor_id,
    updated_at = now()
  where user_id = p_user_id
  returning * into updated_row;

  if updated_row.user_id is null then raise exception 'Conta não encontrada'; end if;

  update public.platform_payment_orders set
    status = 'expired',
    failure_reason = 'LIFETIME_ACCESS_GRANTED',
    updated_at = now()
  where user_id = p_user_id
    and status in ('creating', 'pending', 'in_process', 'authorized');

  insert into public.platform_access_log (
    user_id, actor_id, action, action_label, details
  ) values (
    p_user_id,
    actor_id,
    'lifetime',
    'Acesso vitalício de colaborador liberado',
    jsonb_build_object(
      'monthlyFee', 0,
      'paidUntil', null,
      'accessType', 'lifetime',
      'pricingSource', 'lifetime'
    )
  );
  return to_jsonb(updated_row);
end;
$$;

revoke all on function public.admin_update_platform_settings_v3(numeric, text, text, text) from public, anon, authenticated;
revoke all on function public.admin_update_platform_account_v3(text, text, text, text, numeric) from public, anon, authenticated;
revoke all on function public.admin_grant_platform_access_v5(text, integer, text, text, numeric, text, numeric, text, text) from public, anon, authenticated;
grant execute on function public.admin_update_platform_settings_v3(numeric, text, text, text) to anon, authenticated;
grant execute on function public.admin_update_platform_account_v3(text, text, text, text, numeric) to anon, authenticated;
grant execute on function public.admin_grant_platform_access_v5(text, integer, text, text, numeric, text, numeric, text, text) to anon, authenticated;

revoke all on function public.ensure_platform_account(text, text) from public, anon, authenticated;
revoke all on function public.admin_grant_platform_lifetime_v2(text, text, text) from public, anon, authenticated;
grant execute on function public.ensure_platform_account(text, text) to anon, authenticated;
grant execute on function public.admin_grant_platform_lifetime_v2(text, text, text) to anon, authenticated;

notify pgrst, 'reload schema';
commit;
