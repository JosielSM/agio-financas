-- Painel administrativo e controle mensal de acesso do CredMais.
-- Execute este arquivo inteiro uma vez no SQL Editor do Supabase.
begin;

create extension if not exists pgcrypto with schema extensions;

create table if not exists public.platform_settings (
  id smallint primary key default 1 check (id = 1),
  default_monthly_fee numeric(12,2) not null default 49.90 check (default_monthly_fee >= 0),
  billing_recipient text not null default '',
  billing_pix_key text not null default '',
  billing_pix_type text not null default 'Chave aleatória',
  billing_message text not null default 'Olá, *{nome}*! Sua mensalidade do CredMais no valor de *{valor}* vence em *{vencimento}*. PIX: {pix}. Recebedor: {recebedor}. Após pagar, envie o comprovante para liberação.',
  support_phone text not null default '',
  updated_at timestamptz not null default now()
);

insert into public.platform_settings (id) values (1)
on conflict (id) do nothing;

create table if not exists public.platform_accounts (
  user_id text primary key,
  email text not null default '',
  display_name text not null default '',
  phone text not null default '',
  status text not null default 'pending' check (status in ('pending', 'active', 'blocked')),
  monthly_fee numeric(12,2) check (monthly_fee is null or monthly_fee >= 0),
  paid_until date,
  access_type text not null default 'paid' check (access_type in ('paid', 'free', 'lifetime')),
  access_amount numeric(12,2) not null default 0 check (access_amount >= 0),
  notes text not null default '',
  access_requested_at timestamptz,
  approved_at timestamptz,
  approved_by text,
  last_seen_at timestamptz,
  expiry_notified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.platform_accounts
  add column if not exists expiry_notified_at timestamptz;
alter table public.platform_accounts
  add column if not exists access_type text not null default 'paid'
  check (access_type in ('paid', 'free', 'lifetime'));
alter table public.platform_accounts
  add column if not exists access_amount numeric(12,2) not null default 0
  check (access_amount >= 0);

create index if not exists platform_accounts_status_idx
  on public.platform_accounts (status, paid_until);

create table if not exists public.platform_admins (
  user_id text primary key,
  email text not null default '',
  created_at timestamptz not null default now()
);

create table if not exists public.platform_admin_bootstrap (
  id smallint primary key default 1 check (id = 1),
  secret_hash text not null,
  used_at timestamptz,
  used_by text
);

insert into public.platform_admin_bootstrap (id, secret_hash)
values (1, 'e999fdd69e0f2bad97e4ab2e6c5e4fb5f5070dd47516cdbd866da76c0e41f30b')
on conflict (id) do update
set secret_hash = case
  when public.platform_admin_bootstrap.used_at is null then excluded.secret_hash
  else public.platform_admin_bootstrap.secret_hash
end;

create table if not exists public.platform_access_log (
  id bigint generated always as identity primary key,
  user_id text not null,
  actor_id text not null,
  action text not null,
  action_label text not null,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create or replace function public.register_platform_expiration()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status = 'active'
    and new.paid_until is not null
    and new.paid_until < current_date
    and old.expiry_notified_at is null
  then
    new.expiry_notified_at := coalesce(new.expiry_notified_at, now());

    insert into public.platform_access_log (
      user_id, actor_id, action, action_label, details
    ) values (
      new.user_id,
      coalesce(auth.jwt()->>'sub', 'system'),
      'automatic_expiration',
      'Acesso bloqueado automaticamente por pagamento vencido',
      jsonb_build_object(
        'reason', 'payment_overdue',
        'paidUntil', new.paid_until,
        'automatic', true
      )
    );
  elsif new.status = 'active'
    and (new.paid_until is null or new.paid_until >= current_date)
  then
    new.expiry_notified_at := null;
  end if;

  return new;
end;
$$;

drop trigger if exists platform_accounts_expiration_trigger
  on public.platform_accounts;
create trigger platform_accounts_expiration_trigger
  before update on public.platform_accounts
  for each row execute function public.register_platform_expiration();

-- Contas já existentes ganham 30 dias para que a migração não interrompa ninguém.
insert into public.platform_accounts (user_id, display_name, status, paid_until, last_seen_at)
select owner_id, max(display_name), 'active', current_date + 30, now()
from public.profiles
group by owner_id
on conflict (user_id) do nothing;

insert into public.platform_accounts (user_id, status, paid_until)
select owner_id, 'active', current_date + 30
from public.clients
group by owner_id
on conflict (user_id) do nothing;

insert into public.platform_accounts (user_id, status, paid_until)
select owner_id, 'active', current_date + 30
from public.loans
group by owner_id
on conflict (user_id) do nothing;

create or replace function public.is_platform_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.platform_admins
    where user_id = (select auth.jwt()->>'sub')
  );
$$;

create or replace function public.has_active_platform_access()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select
    public.is_platform_admin()
    or exists (
      select 1
      from public.platform_accounts
      where user_id = (select auth.jwt()->>'sub')
        and status = 'active'
        and (paid_until is null or paid_until >= current_date)
    );
$$;

create or replace function public.admin_sync_expired_platform_accounts()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  expired_accounts jsonb := '[]'::jsonb;
begin
  if not public.is_platform_admin() then
    raise exception 'Acesso administrativo necessário';
  end if;

  with synchronized as (
    update public.platform_accounts
    set
      expiry_notified_at = now(),
      updated_at = now()
    where status = 'active'
      and paid_until is not null
      and paid_until < current_date
      and expiry_notified_at is null
    returning user_id, display_name, email, paid_until
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'userId', user_id,
        'name', coalesce(nullif(display_name, ''), nullif(email, ''), 'Conta sem nome'),
        'email', email,
        'paidUntil', paid_until
      )
    ),
    '[]'::jsonb
  )
  into expired_accounts
  from synchronized;

  return jsonb_build_object(
    'count', jsonb_array_length(expired_accounts),
    'accounts', expired_accounts
  );
end;
$$;

create or replace function public.ensure_platform_account(
  p_display_name text default '',
  p_phone text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  account_id text := auth.jwt()->>'sub';
  account_email text := coalesce(auth.jwt()->>'email', '');
  account_row public.platform_accounts%rowtype;
  setting_row public.platform_settings%rowtype;
  effective_status text;
begin
  if account_id is null or account_id = '' then
    raise exception 'Usuário não autenticado';
  end if;

  insert into public.platform_accounts (
    user_id, email, display_name, phone, status, access_requested_at, last_seen_at
  ) values (
    account_id,
    account_email,
    coalesce(p_display_name, ''),
    coalesce(p_phone, ''),
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

  select * into account_row
  from public.platform_accounts
  where user_id = account_id;

  select * into setting_row
  from public.platform_settings
  where id = 1;

  effective_status := case
    when public.is_platform_admin() then 'admin'
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
    'monthlyFee', coalesce(account_row.monthly_fee, setting_row.default_monthly_fee),
    'defaultMonthlyFee', setting_row.default_monthly_fee,
    'paidUntil', account_row.paid_until,
    'requestedAt', account_row.access_requested_at,
    'supportPhone', setting_row.support_phone,
    'billingRecipient', setting_row.billing_recipient,
    'billingPixKey', setting_row.billing_pix_key,
    'billingPixType', setting_row.billing_pix_type
  );
end;
$$;

create or replace function public.request_platform_access(
  p_display_name text default '',
  p_phone text default ''
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  account_id text := auth.jwt()->>'sub';
begin
  if account_id is null or account_id = '' then
    raise exception 'Usuário não autenticado';
  end if;
  if length(regexp_replace(coalesce(p_phone, ''), '\D', '', 'g')) < 10 then
    raise exception 'Informe um WhatsApp válido';
  end if;

  perform public.ensure_platform_account(p_display_name, p_phone);

  update public.platform_accounts
  set
    phone = p_phone,
    status = case
      when status = 'blocked' then 'blocked'
      when status = 'active' and (paid_until is null or paid_until >= current_date) then 'active'
      else 'pending'
    end,
    access_requested_at = now(),
    updated_at = now()
  where user_id = account_id;

  insert into public.platform_access_log (user_id, actor_id, action, action_label)
  values (account_id, account_id, 'request', 'Solicitação de acesso enviada');

  return public.ensure_platform_account(p_display_name, p_phone);
end;
$$;

create or replace function public.bootstrap_platform_admin(p_activation_code text)
returns boolean
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  account_id text := auth.jwt()->>'sub';
  account_email text := coalesce(auth.jwt()->>'email', '');
  expected_hash text;
begin
  if account_id is null or account_id = '' then
    raise exception 'Usuário não autenticado';
  end if;
  if exists (select 1 from public.platform_admins) then
    raise exception 'ADMIN_ALREADY_CONFIGURED';
  end if;

  select secret_hash into expected_hash
  from public.platform_admin_bootstrap
  where id = 1 and used_at is null
  for update;

  if expected_hash is null
    or encode(digest(convert_to(upper(trim(coalesce(p_activation_code, ''))), 'UTF8'), 'sha256'), 'hex') <> expected_hash
  then
    raise exception 'INVALID_ACTIVATION_CODE';
  end if;

  insert into public.platform_admins (user_id, email)
  values (account_id, account_email);

  insert into public.platform_accounts (user_id, email, display_name, status, paid_until, last_seen_at)
  values (account_id, account_email, coalesce(auth.jwt()->>'name', 'Proprietário'), 'active', null, now())
  on conflict (user_id) do update set
    email = excluded.email,
    status = 'active',
    paid_until = null,
    updated_at = now();

  update public.platform_admin_bootstrap
  set used_at = now(), used_by = account_id
  where id = 1;

  insert into public.platform_access_log (user_id, actor_id, action, action_label)
  values (account_id, account_id, 'bootstrap', 'Painel administrativo ativado');

  return true;
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
declare
  actor_id text := auth.jwt()->>'sub';
  updated_row public.platform_accounts%rowtype;
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
  if p_months is null or p_months < 1 or p_months > 24 then
    raise exception 'Escolha um período entre 1 e 24 meses';
  end if;
  if p_monthly_fee is not null and p_monthly_fee < 0 then
    raise exception 'A mensalidade não pode ser negativa';
  end if;

  update public.platform_accounts
  set
    status = 'active',
    monthly_fee = coalesce(p_monthly_fee, monthly_fee),
    paid_until = (current_date + make_interval(months => p_months))::date,
    access_type = 'paid',
    access_amount = coalesce(p_monthly_fee, monthly_fee, 0) * p_months,
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
    'grant',
    'Acesso liberado até ' || to_char(updated_row.paid_until, 'DD/MM/YYYY'),
    jsonb_build_object(
      'months', p_months,
      'monthlyFee', updated_row.monthly_fee,
      'startsAt', current_date,
      'replacedPreviousExpiration', true
    )
  );

  return to_jsonb(updated_row);
end;
$$;

create or replace function public.admin_grant_platform_access_v3(
  p_user_id text,
  p_period_value integer,
  p_period_unit text,
  p_monthly_fee numeric,
  p_access_type text,
  p_access_amount numeric,
  p_phone text default null,
  p_notes text default null
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
    phone = case when p_phone is null then phone else p_phone end,
    notes = case when p_notes is null then notes else p_notes end,
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
begin
  return public.admin_grant_platform_access_v3(
    p_user_id, p_period_value, p_period_unit, p_monthly_fee,
    p_access_type, p_access_amount, null, null
  );
end;
$$;

create or replace function public.admin_set_platform_status(
  p_user_id text,
  p_status text
)
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
  if p_status not in ('pending', 'blocked') then
    raise exception 'Situação inválida';
  end if;
  if exists (select 1 from public.platform_admins where user_id = p_user_id) then
    raise exception 'A conta proprietária não pode ser bloqueada';
  end if;

  update public.platform_accounts
  set status = p_status, updated_at = now()
  where user_id = p_user_id
  returning * into updated_row;

  if updated_row.user_id is null then
    raise exception 'Conta não encontrada';
  end if;

  insert into public.platform_access_log (user_id, actor_id, action, action_label)
  values (
    p_user_id,
    actor_id,
    p_status,
    case when p_status = 'blocked' then 'Acesso bloqueado' else 'Solicitação reaberta' end
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
    phone = case when p_phone is null then phone else p_phone end,
    notes = case when p_notes is null then notes else p_notes end,
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
    jsonb_build_object('monthlyFee', 0, 'paidUntil', null)
  );

  return to_jsonb(updated_row);
end;
$$;

create or replace function public.admin_grant_platform_lifetime(p_user_id text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  return public.admin_grant_platform_lifetime_v2(p_user_id, null, null);
end;
$$;

alter table public.platform_settings enable row level security;
alter table public.platform_accounts enable row level security;
alter table public.platform_admins enable row level security;
alter table public.platform_admin_bootstrap enable row level security;
alter table public.platform_access_log enable row level security;

drop policy if exists "Administrador gerencia configuracoes" on public.platform_settings;
create policy "Administrador gerencia configuracoes" on public.platform_settings
  for all to anon, authenticated
  using (public.is_platform_admin())
  with check (public.is_platform_admin());

drop policy if exists "Usuario ve a propria assinatura" on public.platform_accounts;
create policy "Usuario ve a propria assinatura" on public.platform_accounts
  for select to anon, authenticated
  using (user_id = (select auth.jwt()->>'sub') or public.is_platform_admin());

drop policy if exists "Administrador gerencia assinaturas" on public.platform_accounts;
create policy "Administrador gerencia assinaturas" on public.platform_accounts
  for update to anon, authenticated
  using (public.is_platform_admin())
  with check (public.is_platform_admin());

drop policy if exists "Administrador ve administradores" on public.platform_admins;
create policy "Administrador ve administradores" on public.platform_admins
  for select to anon, authenticated
  using (public.is_platform_admin());

drop policy if exists "Administrador ve historico de acessos" on public.platform_access_log;
create policy "Administrador ve historico de acessos" on public.platform_access_log
  for select to anon, authenticated
  using (public.is_platform_admin());

-- A leitura permanece disponível; qualquer alteração exige acesso ativo.
drop policy if exists "Clientes pertencem ao usuario" on public.clients;
drop policy if exists "Cliente consulta os proprios dados" on public.clients;
drop policy if exists "Cliente cria com acesso ativo" on public.clients;
drop policy if exists "Cliente altera com acesso ativo" on public.clients;
drop policy if exists "Cliente exclui com acesso ativo" on public.clients;
create policy "Cliente consulta os proprios dados" on public.clients
  for select to anon, authenticated
  using (owner_id = (select auth.jwt()->>'sub'));
create policy "Cliente cria com acesso ativo" on public.clients
  for insert to anon, authenticated
  with check (owner_id = (select auth.jwt()->>'sub') and public.has_active_platform_access());
create policy "Cliente altera com acesso ativo" on public.clients
  for update to anon, authenticated
  using (owner_id = (select auth.jwt()->>'sub') and public.has_active_platform_access())
  with check (owner_id = (select auth.jwt()->>'sub') and public.has_active_platform_access());
create policy "Cliente exclui com acesso ativo" on public.clients
  for delete to anon, authenticated
  using (owner_id = (select auth.jwt()->>'sub') and public.has_active_platform_access());

drop policy if exists "Emprestimos pertencem ao usuario" on public.loans;
drop policy if exists "Usuario consulta os proprios emprestimos" on public.loans;
drop policy if exists "Usuario cria emprestimo com acesso ativo" on public.loans;
drop policy if exists "Usuario altera emprestimo com acesso ativo" on public.loans;
drop policy if exists "Usuario exclui emprestimo com acesso ativo" on public.loans;
create policy "Usuario consulta os proprios emprestimos" on public.loans
  for select to anon, authenticated
  using (owner_id = (select auth.jwt()->>'sub'));
create policy "Usuario cria emprestimo com acesso ativo" on public.loans
  for insert to anon, authenticated
  with check (owner_id = (select auth.jwt()->>'sub') and public.has_active_platform_access());
create policy "Usuario altera emprestimo com acesso ativo" on public.loans
  for update to anon, authenticated
  using (owner_id = (select auth.jwt()->>'sub') and public.has_active_platform_access())
  with check (owner_id = (select auth.jwt()->>'sub') and public.has_active_platform_access());
create policy "Usuario exclui emprestimo com acesso ativo" on public.loans
  for delete to anon, authenticated
  using (owner_id = (select auth.jwt()->>'sub') and public.has_active_platform_access());

drop policy if exists "Historico pertence ao usuario" on public.activity_history;
drop policy if exists "Usuario consulta o proprio historico" on public.activity_history;
drop policy if exists "Usuario cria historico com acesso ativo" on public.activity_history;
drop policy if exists "Usuario altera historico com acesso ativo" on public.activity_history;
drop policy if exists "Usuario exclui historico com acesso ativo" on public.activity_history;
create policy "Usuario consulta o proprio historico" on public.activity_history
  for select to anon, authenticated
  using (owner_id = (select auth.jwt()->>'sub'));
create policy "Usuario cria historico com acesso ativo" on public.activity_history
  for insert to anon, authenticated
  with check (owner_id = (select auth.jwt()->>'sub') and public.has_active_platform_access());
create policy "Usuario altera historico com acesso ativo" on public.activity_history
  for update to anon, authenticated
  using (owner_id = (select auth.jwt()->>'sub') and public.has_active_platform_access())
  with check (owner_id = (select auth.jwt()->>'sub') and public.has_active_platform_access());
create policy "Usuario exclui historico com acesso ativo" on public.activity_history
  for delete to anon, authenticated
  using (owner_id = (select auth.jwt()->>'sub') and public.has_active_platform_access());

drop policy if exists "Perfil pertence ao usuario" on public.profiles;
drop policy if exists "Usuario consulta o proprio perfil" on public.profiles;
drop policy if exists "Usuario cria perfil com acesso ativo" on public.profiles;
drop policy if exists "Usuario altera perfil com acesso ativo" on public.profiles;
drop policy if exists "Usuario exclui perfil com acesso ativo" on public.profiles;
create policy "Usuario consulta o proprio perfil" on public.profiles
  for select to anon, authenticated
  using (owner_id = (select auth.jwt()->>'sub'));
create policy "Usuario cria perfil com acesso ativo" on public.profiles
  for insert to anon, authenticated
  with check (owner_id = (select auth.jwt()->>'sub') and public.has_active_platform_access());
create policy "Usuario altera perfil com acesso ativo" on public.profiles
  for update to anon, authenticated
  using (owner_id = (select auth.jwt()->>'sub') and public.has_active_platform_access())
  with check (owner_id = (select auth.jwt()->>'sub') and public.has_active_platform_access());
create policy "Usuario exclui perfil com acesso ativo" on public.profiles
  for delete to anon, authenticated
  using (owner_id = (select auth.jwt()->>'sub') and public.has_active_platform_access());

-- A exclusão da própria conta continua possível mesmo com assinatura vencida.
create or replace function public.delete_my_account_data()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  account_id text := auth.jwt()->>'sub';
begin
  if account_id is null or account_id = '' then
    raise exception 'Usuário não autenticado';
  end if;
  if exists (select 1 from public.platform_admins where user_id = account_id) then
    raise exception 'A conta proprietária deve ser preservada';
  end if;

  delete from public.activity_history where owner_id = account_id;
  delete from public.loans where owner_id = account_id;
  delete from public.clients where owner_id = account_id;
  delete from public.profiles where owner_id = account_id;
  delete from public.platform_accounts where user_id = account_id;
end;
$$;

revoke all on public.platform_settings from public;
revoke all on public.platform_accounts from public;
revoke all on public.platform_admins from public;
revoke all on public.platform_admin_bootstrap from public;
revoke all on public.platform_access_log from public;

grant select, update on public.platform_settings to anon, authenticated;
grant select, update on public.platform_accounts to anon, authenticated;
grant select on public.platform_admins to anon, authenticated;
grant select on public.platform_access_log to anon, authenticated;

revoke all on function public.is_platform_admin() from public;
revoke all on function public.has_active_platform_access() from public;
revoke all on function public.admin_sync_expired_platform_accounts() from public;
revoke all on function public.register_platform_expiration() from public;
revoke all on function public.ensure_platform_account(text, text) from public;
revoke all on function public.request_platform_access(text, text) from public;
revoke all on function public.bootstrap_platform_admin(text) from public;
revoke all on function public.admin_grant_platform_access(text, integer, numeric) from public;
revoke all on function public.admin_grant_platform_access_v2(text, integer, text, numeric, text, numeric) from public;
revoke all on function public.admin_grant_platform_access_v3(text, integer, text, numeric, text, numeric, text, text) from public;
revoke all on function public.admin_set_platform_status(text, text) from public;
revoke all on function public.admin_grant_platform_lifetime(text) from public;
revoke all on function public.admin_grant_platform_lifetime_v2(text, text, text) from public;
revoke all on function public.delete_my_account_data() from public;

grant execute on function public.is_platform_admin() to anon, authenticated;
grant execute on function public.has_active_platform_access() to anon, authenticated;
grant execute on function public.admin_sync_expired_platform_accounts() to anon, authenticated;
grant execute on function public.ensure_platform_account(text, text) to anon, authenticated;
grant execute on function public.request_platform_access(text, text) to anon, authenticated;
grant execute on function public.bootstrap_platform_admin(text) to anon, authenticated;
grant execute on function public.admin_grant_platform_access(text, integer, numeric) to anon, authenticated;
grant execute on function public.admin_grant_platform_access_v2(text, integer, text, numeric, text, numeric) to anon, authenticated;
grant execute on function public.admin_grant_platform_access_v3(text, integer, text, numeric, text, numeric, text, text) to anon, authenticated;
grant execute on function public.admin_set_platform_status(text, text) to anon, authenticated;
grant execute on function public.admin_grant_platform_lifetime(text) to anon, authenticated;
grant execute on function public.admin_grant_platform_lifetime_v2(text, text, text) to anon, authenticated;
grant execute on function public.delete_my_account_data() to anon, authenticated;

commit;
