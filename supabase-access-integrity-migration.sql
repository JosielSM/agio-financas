-- Reparo transacional da gestão de acesso do CredMais.
-- É seguro executar mais de uma vez: não apaga contas, vencimentos ou históricos.
begin;

alter table public.platform_accounts
  add column if not exists expiry_notified_at timestamptz;
alter table public.platform_accounts
  add column if not exists access_type text not null default 'paid';
alter table public.platform_accounts
  add column if not exists access_amount numeric(12,2) not null default 0;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.platform_accounts'::regclass
      and conname = 'platform_accounts_access_type_check'
  ) then
    alter table public.platform_accounts
      add constraint platform_accounts_access_type_check
      check (access_type in ('paid', 'free', 'lifetime'));
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.platform_accounts'::regclass
      and conname = 'platform_accounts_access_amount_check'
  ) then
    alter table public.platform_accounts
      add constraint platform_accounts_access_amount_check
      check (access_amount >= 0);
  end if;
end;
$$;

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
    set expiry_notified_at = now(), updated_at = now()
    where status = 'active'
      and paid_until is not null
      and paid_until < current_date
      and expiry_notified_at is null
    returning user_id, display_name, email, paid_until
  )
  select coalesce(
    jsonb_agg(jsonb_build_object(
      'userId', user_id,
      'name', coalesce(nullif(display_name, ''), nullif(email, ''), 'Conta sem nome'),
      'email', email,
      'paidUntil', paid_until
    )),
    '[]'::jsonb
  ) into expired_accounts
  from synchronized;
  return jsonb_build_object(
    'count', jsonb_array_length(expired_accounts),
    'accounts', expired_accounts
  );
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
    or (p_period_unit = 'days' and p_period_value not between 1 and 365)
    or (p_period_unit = 'months' and p_period_value not between 1 and 24) then
    raise exception 'Período de acesso inválido';
  end if;
  if p_access_type is null or p_access_type not in ('paid', 'free') then
    raise exception 'Escolha se a liberação foi paga ou gratuita';
  end if;
  if coalesce(p_monthly_fee, 0) < 0 then
    raise exception 'A mensalidade não pode ser negativa';
  end if;
  if coalesce(p_access_amount, 0) < 0 then
    raise exception 'O valor recebido não pode ser negativo';
  end if;

  expiration_date := case
    when p_period_unit = 'days' then current_date + p_period_value
    else (current_date + make_interval(months => p_period_value))::date
  end;
  period_label := case
    when p_period_unit = 'days'
      then p_period_value || case when p_period_value = 1 then ' dia' else ' dias' end
    else p_period_value || case when p_period_value = 1 then ' mês' else ' meses' end
  end;
  access_label := case
    when p_access_type = 'free' then 'Teste gratuito'
    else 'Acesso pago'
  end;

  update public.platform_accounts
  set
    status = 'active',
    phone = case when p_phone is null then phone else p_phone end,
    notes = case when p_notes is null then notes else p_notes end,
    monthly_fee = coalesce(p_monthly_fee, monthly_fee, 0),
    paid_until = expiration_date,
    access_type = p_access_type,
    access_amount = case
      when p_access_type = 'free' then 0
      else coalesce(p_access_amount, 0)
    end,
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
    access_label || ' de ' || period_label || ' liberado até ' ||
      to_char(updated_row.paid_until, 'DD/MM/YYYY'),
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
  return public.admin_grant_platform_access_v3(
    p_user_id, p_months, 'months', p_monthly_fee, 'paid',
    coalesce(p_monthly_fee, 0) * p_months, null, null
  );
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
    jsonb_build_object(
      'monthlyFee', 0,
      'paidUntil', null,
      'accessType', 'lifetime',
      'paymentMethod', 'manual'
    )
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

alter table public.clients enable row level security;
alter table public.loans enable row level security;
alter table public.activity_history enable row level security;
alter table public.profiles enable row level security;
alter table public.platform_accounts enable row level security;

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

revoke all on function public.register_platform_expiration() from public;
revoke all on function public.has_active_platform_access() from public;
revoke all on function public.admin_sync_expired_platform_accounts() from public;
revoke all on function public.admin_grant_platform_access_v3(text, integer, text, numeric, text, numeric, text, text) from public;
revoke all on function public.admin_grant_platform_access_v2(text, integer, text, numeric, text, numeric) from public;
revoke all on function public.admin_grant_platform_access(text, integer, numeric) from public;
revoke all on function public.admin_grant_platform_lifetime_v2(text, text, text) from public;
revoke all on function public.admin_grant_platform_lifetime(text) from public;
revoke all on function public.delete_my_account_data() from public;

grant execute on function public.has_active_platform_access() to anon, authenticated;
grant execute on function public.admin_sync_expired_platform_accounts() to anon, authenticated;
grant execute on function public.admin_grant_platform_access_v3(text, integer, text, numeric, text, numeric, text, text) to anon, authenticated;
grant execute on function public.admin_grant_platform_access_v2(text, integer, text, numeric, text, numeric) to anon, authenticated;
grant execute on function public.admin_grant_platform_access(text, integer, numeric) to anon, authenticated;
grant execute on function public.admin_grant_platform_lifetime_v2(text, text, text) to anon, authenticated;
grant execute on function public.admin_grant_platform_lifetime(text) to anon, authenticated;
grant execute on function public.delete_my_account_data() to anon, authenticated;

do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'platform_accounts'
      and column_name = 'expiry_notified_at'
  ) then
    raise exception 'Falha ao instalar expiry_notified_at';
  end if;
  if to_regprocedure(
    'public.admin_grant_platform_access_v3(text,integer,text,numeric,text,numeric,text,text)'
  ) is null then
    raise exception 'Falha ao instalar a liberação atômica';
  end if;
  if not (
    select relrowsecurity
    from pg_class
    where oid = 'public.platform_accounts'::regclass
  ) then
    raise exception 'RLS de platform_accounts precisa permanecer ativo';
  end if;
  if exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and policyname in (
        'Clientes pertencem ao usuario',
        'Emprestimos pertencem ao usuario',
        'Historico pertence ao usuario',
        'Perfil pertence ao usuario'
      )
  ) then
    raise exception 'As políticas antigas de escrita ainda estão presentes';
  end if;
  if (
    select count(*)
    from pg_policies
    where schemaname = 'public'
      and tablename in ('clients', 'loans', 'activity_history', 'profiles')
      and cmd = 'SELECT'
  ) <> 4 then
    raise exception 'Políticas de leitura incompletas';
  end if;
  if (
    select count(*)
    from pg_policies
    where schemaname = 'public'
      and tablename in ('clients', 'loans', 'activity_history', 'profiles')
      and cmd in ('INSERT', 'UPDATE', 'DELETE')
  ) <> 12 then
    raise exception 'Políticas de escrita protegida incompletas';
  end if;
end;
$$;

notify pgrst, 'reload schema';
commit;
