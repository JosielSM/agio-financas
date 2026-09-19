-- Permite ao administrador configurar o teste gratuito sem alterar contas existentes.

begin;

alter table public.platform_settings
  drop constraint if exists platform_settings_trial_days_check;

alter table public.platform_settings
  add constraint platform_settings_trial_days_check
  check (trial_days between 1 and 90) not valid;

alter table public.platform_settings
  validate constraint platform_settings_trial_days_check;

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
      format(
        'Teste gratuito de %s %s iniciado automaticamente',
        setting_row.trial_days,
        case when setting_row.trial_days = 1 then 'dia' else 'dias' end
      ),
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

create or replace function public.admin_update_platform_settings_v4(
  p_standard_monthly_fee numeric,
  p_pricing_phase text,
  p_trial_days integer,
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
  previous_trial_days smallint;
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
  if p_trial_days is null or p_trial_days not between 1 and 90 then
    raise exception 'O teste gratuito deve ter entre 1 e 90 dias';
  end if;
  if length(coalesce(p_billing_message, '')) not between 1 and 4000
    or length(coalesce(p_support_phone, '')) > 32 then
    raise exception 'Configuração de cobrança inválida';
  end if;

  select default_monthly_fee, trial_days
  into strict previous_fee, previous_trial_days
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
    trial_days = p_trial_days,
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
    'Política comercial e teste gratuito atualizados',
    jsonb_build_object(
      'previousDefaultMonthlyFee', previous_fee,
      'defaultMonthlyFee', saved.default_monthly_fee,
      'launchMonthlyFee', saved.launch_monthly_fee,
      'standardMonthlyFee', saved.standard_monthly_fee,
      'pricingPhase', saved.pricing_phase,
      'previousTrialDays', previous_trial_days,
      'trialDays', saved.trial_days,
      'existingTrialsPreserved', true,
      'launchAccountsPreserved', true,
      'automaticPaymentOnly', true
    )
  );
  return to_jsonb(saved);
end;
$$;

-- Clientes antigos em cache continuam salvando os demais ajustes sem redefinir o teste.
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
  current_trial_days integer;
  result jsonb;
begin
  select trial_days into strict current_trial_days
  from public.platform_settings
  where id = 1;

  select public.admin_update_platform_settings_v4(
    p_standard_monthly_fee,
    p_pricing_phase,
    current_trial_days,
    p_billing_message,
    p_support_phone
  ) into result;
  return result;
end;
$$;

revoke all on function public.admin_update_platform_settings_v4(numeric, text, integer, text, text)
  from public, anon, authenticated;
grant execute on function public.admin_update_platform_settings_v4(numeric, text, integer, text, text)
  to anon, authenticated;

commit;
