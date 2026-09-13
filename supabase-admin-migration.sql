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
  notes text not null default '',
  access_requested_at timestamptz,
  approved_at timestamptz,
  approved_by text,
  last_seen_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

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
  if p_months < 1 or p_months > 24 then
    raise exception 'Escolha um período entre 1 e 24 meses';
  end if;
  if p_monthly_fee is not null and p_monthly_fee < 0 then
    raise exception 'A mensalidade não pode ser negativa';
  end if;

  update public.platform_accounts
  set
    status = 'active',
    monthly_fee = coalesce(p_monthly_fee, monthly_fee),
    paid_until = (
      greatest(coalesce(paid_until, current_date), current_date)
      + make_interval(months => p_months)
    )::date,
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
    jsonb_build_object('months', p_months, 'monthlyFee', updated_row.monthly_fee)
  );

  return to_jsonb(updated_row);
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

create or replace function public.admin_grant_platform_lifetime(
  p_user_id text
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
    monthly_fee = 0,
    paid_until = null,
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
revoke all on function public.ensure_platform_account(text, text) from public;
revoke all on function public.request_platform_access(text, text) from public;
revoke all on function public.bootstrap_platform_admin(text) from public;
revoke all on function public.admin_grant_platform_access(text, integer, numeric) from public;
revoke all on function public.admin_set_platform_status(text, text) from public;
revoke all on function public.admin_grant_platform_lifetime(text) from public;
revoke all on function public.delete_my_account_data() from public;

grant execute on function public.is_platform_admin() to anon, authenticated;
grant execute on function public.has_active_platform_access() to anon, authenticated;
grant execute on function public.ensure_platform_account(text, text) to anon, authenticated;
grant execute on function public.request_platform_access(text, text) to anon, authenticated;
grant execute on function public.bootstrap_platform_admin(text) to anon, authenticated;
grant execute on function public.admin_grant_platform_access(text, integer, numeric) to anon, authenticated;
grant execute on function public.admin_set_platform_status(text, text) to anon, authenticated;
grant execute on function public.admin_grant_platform_lifetime(text) to anon, authenticated;
grant execute on function public.delete_my_account_data() to anon, authenticated;

commit;
