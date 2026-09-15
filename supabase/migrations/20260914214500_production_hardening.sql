-- Endurecimento de produção do CredMais.
-- Migração versionada aplicada pelo Supabase CLI.
-- É transacional e repetível: em caso de erro, nenhuma alteração parcial permanece.

begin;

create table if not exists public.platform_settings (
  id smallint primary key default 1 check (id = 1),
  default_monthly_fee numeric(12,2) not null default 49.90,
  billing_recipient text not null default '',
  billing_pix_key text not null default '',
  billing_pix_type text not null default 'Chave aleatória',
  billing_message text not null default 'Olá, *{nome}*! Sua mensalidade do CredMais no valor de *{valor}* vence em *{vencimento}*. PIX: {pix}. Recebedor: {recebedor}. Após pagar, envie o comprovante para liberação.',
  support_phone text not null default '',
  updated_at timestamptz not null default now()
);

alter table public.platform_settings
  add column if not exists default_monthly_fee numeric(12,2) not null default 49.90,
  add column if not exists billing_recipient text not null default '',
  add column if not exists billing_pix_key text not null default '',
  add column if not exists billing_pix_type text not null default 'Chave aleatória',
  add column if not exists billing_message text not null default 'Olá, *{nome}*! Sua mensalidade do CredMais no valor de *{valor}* vence em *{vencimento}*. PIX: {pix}. Recebedor: {recebedor}. Após pagar, envie o comprovante para liberação.',
  add column if not exists support_phone text not null default '',
  add column if not exists updated_at timestamptz not null default now();

insert into public.platform_settings (id) values (1)
on conflict (id) do nothing;

create table if not exists public.platform_accounts (
  user_id text primary key,
  email text not null default '',
  display_name text not null default '',
  phone text not null default '',
  status text not null default 'pending',
  monthly_fee numeric(12,2),
  paid_until date,
  access_type text not null default 'paid',
  access_amount numeric(12,2) not null default 0,
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
  add column if not exists email text not null default '',
  add column if not exists display_name text not null default '',
  add column if not exists phone text not null default '',
  add column if not exists status text not null default 'pending',
  add column if not exists monthly_fee numeric(12,2),
  add column if not exists paid_until date,
  add column if not exists access_type text not null default 'paid',
  add column if not exists access_amount numeric(12,2) not null default 0,
  add column if not exists notes text not null default '',
  add column if not exists access_requested_at timestamptz,
  add column if not exists approved_at timestamptz,
  add column if not exists approved_by text,
  add column if not exists last_seen_at timestamptz,
  add column if not exists expiry_notified_at timestamptz,
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now();

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

create table if not exists public.platform_access_log (
  id bigint generated always as identity primary key,
  user_id text not null,
  actor_id text not null,
  action text not null,
  action_label text not null,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.platform_accounts'::regclass
      and conname = 'platform_accounts_status_check'
  ) then
    alter table public.platform_accounts
      add constraint platform_accounts_status_check
      check (status in ('pending', 'active', 'blocked')) not valid;
    alter table public.platform_accounts
      validate constraint platform_accounts_status_check;
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.platform_accounts'::regclass
      and conname = 'platform_accounts_monthly_fee_check'
  ) then
    alter table public.platform_accounts
      add constraint platform_accounts_monthly_fee_check
      check (monthly_fee is null or monthly_fee >= 0) not valid;
    alter table public.platform_accounts
      validate constraint platform_accounts_monthly_fee_check;
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.platform_accounts'::regclass
      and conname = 'platform_accounts_access_type_check'
  ) then
    alter table public.platform_accounts
      add constraint platform_accounts_access_type_check
      check (access_type in ('paid', 'free', 'lifetime')) not valid;
    alter table public.platform_accounts
      validate constraint platform_accounts_access_type_check;
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.platform_accounts'::regclass
      and conname = 'platform_accounts_access_amount_check'
  ) then
    alter table public.platform_accounts
      add constraint platform_accounts_access_amount_check
      check (access_amount >= 0) not valid;
    alter table public.platform_accounts
      validate constraint platform_accounts_access_amount_check;
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.platform_settings'::regclass
      and conname = 'platform_settings_default_monthly_fee_check'
  ) then
    alter table public.platform_settings
      add constraint platform_settings_default_monthly_fee_check
      check (default_monthly_fee >= 0) not valid;
    alter table public.platform_settings
      validate constraint platform_settings_default_monthly_fee_check;
  end if;
end;
$$;

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

alter table public.clients
  add column if not exists updated_at timestamptz not null default now();
alter table public.loans
  add column if not exists updated_at timestamptz not null default now();
alter table public.activity_history
  add column if not exists updated_at timestamptz not null default now();

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.clients'::regclass
      and conname = 'clients_id_owner_id_key'
  ) then
    alter table public.clients
      add constraint clients_id_owner_id_key unique (id, owner_id);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.loans'::regclass
      and conname = 'loans_client_owner_id_fkey'
  ) then
    alter table public.loans
      add constraint loans_client_owner_id_fkey
      foreign key (client_id, owner_id)
      references public.clients (id, owner_id)
      on delete cascade
      not valid;
    alter table public.loans
      validate constraint loans_client_owner_id_fkey;
  end if;
end;
$$;

create table if not exists public.workspace_audit_log (
  id bigint generated always as identity primary key,
  owner_id text not null,
  actor_id text not null,
  entity_type text not null,
  entity_id text not null,
  operation text not null check (operation in ('insert', 'update', 'delete')),
  changed_fields jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists workspace_audit_owner_created_idx
  on public.workspace_audit_log (owner_id, created_at desc);

alter table public.clients enable row level security;
alter table public.loans enable row level security;
alter table public.activity_history enable row level security;
alter table public.profiles enable row level security;
alter table public.workspace_audit_log enable row level security;
alter table public.platform_settings enable row level security;
alter table public.platform_accounts enable row level security;
alter table public.platform_admins enable row level security;
alter table public.platform_admin_bootstrap enable row level security;
alter table public.platform_access_log enable row level security;

create or replace function private.current_user_id()
returns text
language sql
stable
security invoker
set search_path = ''
as $$
  select nullif(btrim(coalesce(auth.jwt()->>'sub', '')), '');
$$;

create or replace function private.is_platform_admin_id(p_user_id text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_user_id is not null and exists (
    select 1 from public.platform_admins where user_id = p_user_id
  );
$$;

create or replace function private.has_active_platform_access_id(p_user_id text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select
    private.is_platform_admin_id(p_user_id)
    or exists (
      select 1
      from public.platform_accounts
      where user_id = p_user_id
        and status = 'active'
        and (paid_until is null or paid_until >= current_date)
    );
$$;

create or replace function public.is_platform_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.is_platform_admin_id(private.current_user_id());
$$;

create or replace function public.has_active_platform_access()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.has_active_platform_access_id(private.current_user_id());
$$;

create or replace function private.audit_workspace_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  old_data jsonb := case when tg_op = 'INSERT' then '{}'::jsonb else to_jsonb(old) end;
  new_data jsonb := case when tg_op = 'DELETE' then '{}'::jsonb else to_jsonb(new) end;
  row_data jsonb := case when tg_op = 'DELETE' then old_data else new_data end;
  fields jsonb;
begin
  if tg_op = 'UPDATE' then
    select coalesce(jsonb_agg(key order by key), '[]'::jsonb)
      into fields
    from jsonb_each(new_data - array['owner_id', 'updated_at']) next_value
    where next_value.value is distinct from old_data -> next_value.key;
  else
    select coalesce(jsonb_agg(keys.key order by keys.key), '[]'::jsonb)
      into fields
    from jsonb_object_keys(row_data - array['owner_id', 'updated_at']) as keys(key);
  end if;

  if tg_op <> 'UPDATE' or jsonb_array_length(fields) > 0 then
    insert into public.workspace_audit_log (
      owner_id, actor_id, entity_type, entity_id, operation, changed_fields
    ) values (
      row_data ->> 'owner_id',
      coalesce(private.current_user_id(), 'system'),
      tg_table_name,
      coalesce(row_data ->> 'id', row_data ->> 'owner_id'),
      lower(tg_op),
      fields
    );
  end if;

  return null;
end;
$$;

drop trigger if exists clients_workspace_audit on public.clients;
create trigger clients_workspace_audit
after insert or update or delete on public.clients
for each row execute function private.audit_workspace_change();

drop trigger if exists loans_workspace_audit on public.loans;
create trigger loans_workspace_audit
after insert or update or delete on public.loans
for each row execute function private.audit_workspace_change();

drop trigger if exists profiles_workspace_audit on public.profiles;
create trigger profiles_workspace_audit
after insert or update or delete on public.profiles
for each row execute function private.audit_workspace_change();

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
  if account_id is null then
    raise exception 'Usuário não autenticado';
  end if;
  if length(coalesce(p_display_name, '')) > 160 then
    raise exception 'Nome muito longo';
  end if;
  if length(coalesce(p_phone, '')) > 32 then
    raise exception 'Telefone inválido';
  end if;

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

  select * into setting_row
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
    'paidUntil', account_row.paid_until,
    'requestedAt', account_row.access_requested_at,
    'accessType', account_row.access_type,
    'supportPhone', coalesce(setting_row.support_phone, ''),
    'billingRecipient', coalesce(setting_row.billing_recipient, ''),
    'billingPixKey', coalesce(setting_row.billing_pix_key, ''),
    'billingPixType', coalesce(setting_row.billing_pix_type, 'Chave aleatória')
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
set search_path = ''
as $$
declare
  account_id text := private.current_user_id();
begin
  if account_id is null then
    raise exception 'Usuário não autenticado';
  end if;
  if length(regexp_replace(coalesce(p_phone, ''), '\D', '', 'g')) < 10
    or length(coalesce(p_phone, '')) > 32 then
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

create or replace function public.sync_my_workspace_v1(
  p_clients jsonb,
  p_loans jsonb,
  p_history jsonb default '[]'::jsonb,
  p_profile jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  account_id text := private.current_user_id();
  client_count integer;
  loan_count integer;
  history_count integer;
begin
  if account_id is null then
    raise exception 'Usuário não autenticado';
  end if;
  if not private.has_active_platform_access_id(account_id) then
    raise exception 'Sua assinatura não permite alterações';
  end if;
  if jsonb_typeof(coalesce(p_clients, 'null'::jsonb)) <> 'array'
    or jsonb_typeof(coalesce(p_loans, 'null'::jsonb)) <> 'array'
    or jsonb_typeof(coalesce(p_history, 'null'::jsonb)) <> 'array'
    or jsonb_typeof(coalesce(p_profile, 'null'::jsonb)) <> 'object' then
    raise exception 'Formato de sincronização inválido';
  end if;
  if jsonb_array_length(p_clients) > 5000
    or jsonb_array_length(p_loans) > 5000
    or jsonb_array_length(p_history) > 15000
    or octet_length(p_clients::text) > 5000000
    or octet_length(p_loans::text) > 10000000
    or octet_length(p_history::text) > 10000000 then
    raise exception 'Limite seguro de sincronização excedido';
  end if;

  if exists (
    select 1 from jsonb_array_elements(p_clients) item
    where coalesce(item->>'id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      or length(btrim(coalesce(item->>'name', ''))) not between 1 and 160
      or length(coalesce(item->>'cpf', '')) > 32
      or length(coalesce(item->>'phone', '')) > 32
      or length(coalesce(item->>'email', '')) > 254
      or length(coalesce(item->>'note', '')) > 2000
  ) then
    raise exception 'Dados de cliente inválidos';
  end if;
  if (select count(*) from jsonb_array_elements(p_clients)) <>
     (select count(distinct item->>'id') from jsonb_array_elements(p_clients) item) then
    raise exception 'Cliente duplicado na sincronização';
  end if;
  if exists (
    select 1
    from public.clients existing
    join jsonb_array_elements(p_clients) item
      on existing.id = (item->>'id')::uuid
    where existing.owner_id <> account_id
  ) then
    raise exception 'Identificador de cliente pertence a outra conta';
  end if;

  insert into public.clients (
    id, owner_id, name, cpf, phone, email, note, blacklisted, updated_at
  )
  select
    (item->>'id')::uuid,
    account_id,
    btrim(item->>'name'),
    coalesce(item->>'cpf', ''),
    coalesce(item->>'phone', ''),
    nullif(item->>'email', ''),
    nullif(item->>'note', ''),
    coalesce((item->>'blacklisted')::boolean, false),
    now()
  from jsonb_array_elements(p_clients) item
  on conflict (id) do update set
    name = excluded.name,
    cpf = excluded.cpf,
    phone = excluded.phone,
    email = excluded.email,
    note = excluded.note,
    blacklisted = excluded.blacklisted,
    updated_at = now()
  where public.clients.owner_id = account_id
    and (public.clients.name, public.clients.cpf, public.clients.phone,
         public.clients.email, public.clients.note, public.clients.blacklisted)
        is distinct from
        (excluded.name, excluded.cpf, excluded.phone,
         excluded.email, excluded.note, excluded.blacklisted);

  if exists (
    select 1 from jsonb_array_elements(p_loans) item
    where coalesce(item->>'id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      or coalesce(item->>'client_id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      or length(btrim(coalesce(item->>'contract', ''))) not between 1 and 120
      or jsonb_typeof(coalesce(item->'payment_states', '{}'::jsonb)) <> 'object'
      or jsonb_typeof(coalesce(item->'custom_dates', '{}'::jsonb)) <> 'object'
      or octet_length(coalesce(item->'payment_states', '{}'::jsonb)::text) > 250000
      or octet_length(coalesce(item->'custom_dates', '{}'::jsonb)::text) > 100000
  ) then
    raise exception 'Dados de empréstimo inválidos';
  end if;
  if (select count(*) from jsonb_array_elements(p_loans)) <>
     (select count(distinct item->>'id') from jsonb_array_elements(p_loans) item) then
    raise exception 'Empréstimo duplicado na sincronização';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_loans) item
    where (item->>'amount')::numeric < 0 or (item->>'amount')::numeric > 1000000000000
      or (item->>'rate')::numeric < 0 or (item->>'rate')::numeric > 10000
      or (item->>'installments')::integer not between 1 and 600
      or (item->>'frequency')::integer not between 1 and 3650
      or coalesce((item->>'late_fee')::numeric, 0) < 0
      or coalesce((item->>'late_fee')::numeric, 0) > 1000000000000
      or (item->>'total')::numeric < 0 or (item->>'total')::numeric > 1000000000000
      or (item->>'installment')::numeric < 0 or (item->>'installment')::numeric > 1000000000000
      or coalesce(item->>'due_date', '') !~ '^\d{4}-\d{2}-\d{2}$'
  ) then
    raise exception 'Valores do empréstimo fora dos limites permitidos';
  end if;
  if exists (
    select 1
    from public.loans existing
    join jsonb_array_elements(p_loans) item
      on existing.id = (item->>'id')::uuid
    where existing.owner_id <> account_id
  ) then
    raise exception 'Identificador de empréstimo pertence a outra conta';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(p_loans) item
    left join public.clients owned_client
      on owned_client.id = (item->>'client_id')::uuid
      and owned_client.owner_id = account_id
    where owned_client.id is null
  ) then
    raise exception 'O cliente do empréstimo não pertence à conta autenticada';
  end if;

  insert into public.loans (
    id, owner_id, contract, client_id, amount, rate, installments, frequency,
    late_fee, total, installment, due_date, payment_states, custom_dates,
    archived, created_at, updated_at
  )
  select
    (item->>'id')::uuid,
    account_id,
    btrim(item->>'contract'),
    (item->>'client_id')::uuid,
    (item->>'amount')::numeric,
    (item->>'rate')::numeric,
    (item->>'installments')::integer,
    (item->>'frequency')::integer,
    coalesce((item->>'late_fee')::numeric, 0),
    (item->>'total')::numeric,
    (item->>'installment')::numeric,
    (item->>'due_date')::date,
    coalesce(item->'payment_states', '{}'::jsonb),
    coalesce(item->'custom_dates', '{}'::jsonb),
    coalesce((item->>'archived')::boolean, false),
    coalesce(nullif(item->>'created_at', '')::timestamptz, now()),
    now()
  from jsonb_array_elements(p_loans) item
  on conflict (id) do update set
    contract = excluded.contract,
    client_id = excluded.client_id,
    amount = excluded.amount,
    rate = excluded.rate,
    installments = excluded.installments,
    frequency = excluded.frequency,
    late_fee = excluded.late_fee,
    total = excluded.total,
    installment = excluded.installment,
    due_date = excluded.due_date,
    payment_states = excluded.payment_states,
    custom_dates = excluded.custom_dates,
    archived = excluded.archived,
    updated_at = now()
  where public.loans.owner_id = account_id
    and (public.loans.contract, public.loans.client_id, public.loans.amount,
         public.loans.rate, public.loans.installments, public.loans.frequency,
         public.loans.late_fee, public.loans.total, public.loans.installment,
         public.loans.due_date, public.loans.payment_states,
         public.loans.custom_dates, public.loans.archived)
        is distinct from
        (excluded.contract, excluded.client_id, excluded.amount,
         excluded.rate, excluded.installments, excluded.frequency,
         excluded.late_fee, excluded.total, excluded.installment,
         excluded.due_date, excluded.payment_states,
         excluded.custom_dates, excluded.archived);

  if exists (
    select 1 from jsonb_array_elements(p_history) item
    where coalesce(item->>'id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      or length(btrim(coalesce(item->>'category', ''))) not between 1 and 60
      or length(btrim(coalesce(item->>'title', ''))) not between 1 and 200
      or length(coalesce(item->>'description', '')) > 3000
  ) then
    raise exception 'Dados do histórico inválidos';
  end if;
  if exists (
    select 1
    from public.activity_history existing
    join jsonb_array_elements(p_history) item
      on existing.id = (item->>'id')::uuid
    where existing.owner_id <> account_id
  ) then
    raise exception 'Identificador de histórico pertence a outra conta';
  end if;

  insert into public.activity_history (
    id, owner_id, category, title, description, created_at, updated_at
  )
  select
    (item->>'id')::uuid,
    account_id,
    btrim(item->>'category'),
    btrim(item->>'title'),
    coalesce(item->>'description', ''),
    coalesce(nullif(item->>'created_at', '')::timestamptz, now()),
    now()
  from jsonb_array_elements(p_history) item
  on conflict (id) do nothing;

  if p_profile <> '{}'::jsonb then
    if length(coalesce(p_profile->>'display_name', '')) > 160
      or length(coalesce(p_profile->>'pix_key', '')) > 254
      or length(coalesce(p_profile->>'pix_key_type', '')) > 60
      or length(coalesce(p_profile->>'pix_recipient_name', '')) > 160 then
      raise exception 'Dados do perfil inválidos';
    end if;
    insert into public.profiles (
      owner_id, display_name, pix_key, pix_key_type, pix_recipient_name, updated_at
    ) values (
      account_id,
      coalesce(p_profile->>'display_name', ''),
      coalesce(p_profile->>'pix_key', ''),
      coalesce(nullif(p_profile->>'pix_key_type', ''), 'Chave aleatória'),
      coalesce(p_profile->>'pix_recipient_name', ''),
      now()
    )
    on conflict (owner_id) do update set
      display_name = excluded.display_name,
      pix_key = excluded.pix_key,
      pix_key_type = excluded.pix_key_type,
      pix_recipient_name = excluded.pix_recipient_name,
      updated_at = now()
    where (public.profiles.display_name, public.profiles.pix_key,
           public.profiles.pix_key_type, public.profiles.pix_recipient_name)
          is distinct from
          (excluded.display_name, excluded.pix_key,
           excluded.pix_key_type, excluded.pix_recipient_name);
  end if;

  client_count := jsonb_array_length(p_clients);
  loan_count := jsonb_array_length(p_loans);
  history_count := jsonb_array_length(p_history);
  return jsonb_build_object(
    'ok', true,
    'clients', client_count,
    'loans', loan_count,
    'history', history_count,
    'syncedAt', now()
  );
end;
$$;

create or replace function public.save_my_profile_v1(
  p_display_name text,
  p_pix_key text,
  p_pix_key_type text,
  p_pix_recipient_name text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  account_id text := private.current_user_id();
  saved public.profiles%rowtype;
begin
  if account_id is null then raise exception 'Usuário não autenticado'; end if;
  if not private.has_active_platform_access_id(account_id) then
    raise exception 'Sua assinatura não permite alterações';
  end if;
  if length(coalesce(p_display_name, '')) > 160
    or length(coalesce(p_pix_key, '')) > 254
    or length(coalesce(p_pix_key_type, '')) > 60
    or length(coalesce(p_pix_recipient_name, '')) > 160 then
    raise exception 'Dados do perfil inválidos';
  end if;

  insert into public.profiles (
    owner_id, display_name, pix_key, pix_key_type, pix_recipient_name, updated_at
  ) values (
    account_id, coalesce(p_display_name, ''), coalesce(p_pix_key, ''),
    coalesce(nullif(p_pix_key_type, ''), 'Chave aleatória'),
    coalesce(p_pix_recipient_name, ''), now()
  )
  on conflict (owner_id) do update set
    display_name = excluded.display_name,
    pix_key = excluded.pix_key,
    pix_key_type = excluded.pix_key_type,
    pix_recipient_name = excluded.pix_recipient_name,
    updated_at = now()
  returning * into saved;
  return to_jsonb(saved);
end;
$$;

create or replace function public.delete_my_loan_v1(p_loan_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  account_id text := private.current_user_id();
  removed public.loans%rowtype;
begin
  if account_id is null then raise exception 'Usuário não autenticado'; end if;
  if not private.has_active_platform_access_id(account_id) then
    raise exception 'Sua assinatura não permite alterações';
  end if;
  delete from public.loans
  where id = p_loan_id and owner_id = account_id
  returning * into removed;
  if removed.id is null then raise exception 'Empréstimo não encontrado'; end if;
  return jsonb_build_object('ok', true, 'id', removed.id);
end;
$$;

create or replace function public.delete_my_client_v1(p_client_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  account_id text := private.current_user_id();
  removed public.clients%rowtype;
  linked_loans integer;
begin
  if account_id is null then raise exception 'Usuário não autenticado'; end if;
  if not private.has_active_platform_access_id(account_id) then
    raise exception 'Sua assinatura não permite alterações';
  end if;
  select count(*) into linked_loans from public.loans
  where client_id = p_client_id and owner_id = account_id;
  delete from public.clients
  where id = p_client_id and owner_id = account_id
  returning * into removed;
  if removed.id is null then raise exception 'Cliente não encontrado'; end if;
  return jsonb_build_object('ok', true, 'id', removed.id, 'deletedLoans', linked_loans);
end;
$$;

create or replace function public.admin_update_platform_account_v1(
  p_user_id text,
  p_phone text,
  p_notes text,
  p_monthly_fee numeric
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_id text := private.current_user_id();
  saved public.platform_accounts%rowtype;
begin
  if not private.is_platform_admin_id(actor_id) then
    raise exception 'Acesso administrativo necessário';
  end if;
  if p_user_id is null or btrim(p_user_id) = '' then raise exception 'Conta inválida'; end if;
  if length(coalesce(p_phone, '')) > 32 then raise exception 'Telefone inválido'; end if;
  if length(coalesce(p_notes, '')) > 2000 then raise exception 'Observação muito longa'; end if;
  if p_monthly_fee is null or p_monthly_fee < 0 or p_monthly_fee > 1000000 then
    raise exception 'Mensalidade inválida';
  end if;

  update public.platform_accounts set
    phone = coalesce(p_phone, ''),
    notes = coalesce(p_notes, ''),
    monthly_fee = p_monthly_fee,
    updated_at = now()
  where user_id = p_user_id
  returning * into saved;
  if saved.user_id is null then raise exception 'Conta não encontrada'; end if;

  insert into public.platform_access_log (
    user_id, actor_id, action, action_label, details
  ) values (
    p_user_id, actor_id, 'account_update', 'Cadastro da assinatura atualizado',
    jsonb_build_object('phoneUpdated', true, 'notesUpdated', true, 'monthlyFee', p_monthly_fee)
  );
  return to_jsonb(saved);
end;
$$;

create or replace function public.admin_update_platform_settings_v1(
  p_default_monthly_fee numeric,
  p_billing_recipient text,
  p_billing_pix_key text,
  p_billing_pix_type text,
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
  saved public.platform_settings%rowtype;
begin
  if not private.is_platform_admin_id(actor_id) then
    raise exception 'Acesso administrativo necessário';
  end if;
  if p_default_monthly_fee is null or p_default_monthly_fee < 0 or p_default_monthly_fee > 1000000 then
    raise exception 'Mensalidade padrão inválida';
  end if;
  if length(coalesce(p_billing_recipient, '')) > 160
    or length(coalesce(p_billing_pix_key, '')) > 254
    or length(coalesce(p_billing_pix_type, '')) > 60
    or length(coalesce(p_billing_message, '')) not between 1 and 4000
    or length(coalesce(p_support_phone, '')) > 32 then
    raise exception 'Configuração de cobrança inválida';
  end if;

  update public.platform_settings set
    default_monthly_fee = p_default_monthly_fee,
    billing_recipient = p_billing_recipient,
    billing_pix_key = p_billing_pix_key,
    billing_pix_type = p_billing_pix_type,
    billing_message = p_billing_message,
    support_phone = p_support_phone,
    updated_at = now()
  where id = 1
  returning * into saved;
  if saved.id is null then raise exception 'Configuração não encontrada'; end if;

  insert into public.platform_access_log (
    user_id, actor_id, action, action_label, details
  ) values (
    actor_id, actor_id, 'settings_update', 'Configurações de cobrança atualizadas',
    jsonb_build_object('defaultMonthlyFee', p_default_monthly_fee)
  );
  return to_jsonb(saved);
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
set search_path = ''
as $$
declare
  actor_id text := private.current_user_id();
  updated_row public.platform_accounts%rowtype;
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
  if p_access_type not in ('paid', 'free') then
    raise exception 'Escolha se a liberação foi paga ou gratuita';
  end if;
  if p_monthly_fee is null or p_monthly_fee < 0 or p_monthly_fee > 1000000
    or p_access_amount is null or p_access_amount < 0 or p_access_amount > 10000000 then
    raise exception 'Valor de acesso inválido';
  end if;
  if p_access_type = 'free' and p_access_amount <> 0 then
    raise exception 'Acesso gratuito não pode registrar pagamento';
  end if;
  if length(coalesce(p_phone, '')) > 32 or length(coalesce(p_notes, '')) > 2000 then
    raise exception 'Dados administrativos inválidos';
  end if;

  perform 1 from public.platform_accounts where user_id = p_user_id for update;
  if not found then raise exception 'Conta não encontrada'; end if;

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
    phone = case when p_phone is null then phone else p_phone end,
    notes = case when p_notes is null then notes else p_notes end,
    monthly_fee = p_monthly_fee,
    paid_until = expiration_date,
    access_type = p_access_type,
    access_amount = case when p_access_type = 'free' then 0 else p_access_amount end,
    expiry_notified_at = null,
    approved_at = now(),
    approved_by = actor_id,
    updated_at = now()
  where user_id = p_user_id
  returning * into updated_row;

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
language sql
security invoker
set search_path = ''
as $$
  select public.admin_grant_platform_access_v3(
    p_user_id, p_period_value, p_period_unit, p_monthly_fee,
    p_access_type, p_access_amount, null, null
  );
$$;

create or replace function public.admin_grant_platform_access(
  p_user_id text,
  p_months integer default 1,
  p_monthly_fee numeric default null
)
returns jsonb
language sql
security invoker
set search_path = ''
as $$
  select public.admin_grant_platform_access_v3(
    p_user_id, p_months, 'months', coalesce(p_monthly_fee, 0),
    'paid', coalesce(p_monthly_fee, 0) * p_months, null, null
  );
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
  if private.is_platform_admin_id(p_user_id) then
    raise exception 'A conta proprietária já possui acesso permanente';
  end if;
  if length(coalesce(p_phone, '')) > 32 or length(coalesce(p_notes, '')) > 2000 then
    raise exception 'Dados administrativos inválidos';
  end if;
  perform 1 from public.platform_accounts where user_id = p_user_id for update;
  if not found then raise exception 'Conta não encontrada'; end if;

  update public.platform_accounts set
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

  insert into public.platform_access_log (
    user_id, actor_id, action, action_label, details
  ) values (
    p_user_id, actor_id, 'lifetime', 'Acesso vitalício de colaborador liberado',
    jsonb_build_object('monthlyFee', 0, 'paidUntil', null)
  );
  return to_jsonb(updated_row);
end;
$$;

create or replace function public.admin_grant_platform_lifetime(p_user_id text)
returns jsonb
language sql
security invoker
set search_path = ''
as $$
  select public.admin_grant_platform_lifetime_v2(p_user_id, null, null);
$$;

create or replace function public.admin_set_platform_status(
  p_user_id text,
  p_status text
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
  if p_status not in ('pending', 'blocked') then raise exception 'Situação inválida'; end if;
  if private.is_platform_admin_id(p_user_id) then
    raise exception 'A conta proprietária não pode ser bloqueada';
  end if;
  perform 1 from public.platform_accounts where user_id = p_user_id for update;
  if not found then raise exception 'Conta não encontrada'; end if;

  update public.platform_accounts set
    status = p_status,
    expiry_notified_at = case when p_status = 'blocked' then expiry_notified_at else null end,
    updated_at = now()
  where user_id = p_user_id
  returning * into updated_row;

  insert into public.platform_access_log (user_id, actor_id, action, action_label)
  values (
    p_user_id, actor_id, p_status,
    case when p_status = 'blocked' then 'Acesso bloqueado' else 'Solicitação reaberta' end
  );
  return to_jsonb(updated_row);
end;
$$;

drop trigger if exists platform_accounts_expiration_trigger on public.platform_accounts;
drop function if exists public.register_platform_expiration();

create or replace function private.register_platform_expiration()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status = 'active'
    and new.paid_until is not null
    and new.paid_until < current_date
    and old.expiry_notified_at is null then
    new.expiry_notified_at := coalesce(new.expiry_notified_at, now());
    insert into public.platform_access_log (
      user_id, actor_id, action, action_label, details
    ) values (
      new.user_id,
      coalesce(private.current_user_id(), 'system'),
      'automatic_expiration',
      'Acesso bloqueado automaticamente por pagamento vencido',
      jsonb_build_object('reason', 'payment_overdue', 'paidUntil', new.paid_until, 'automatic', true)
    );
  elsif new.status = 'active'
    and (new.paid_until is null or new.paid_until >= current_date) then
    new.expiry_notified_at := null;
  end if;
  return new;
end;
$$;

create trigger platform_accounts_expiration_trigger
before update on public.platform_accounts
for each row execute function private.register_platform_expiration();

create or replace function public.admin_sync_expired_platform_accounts()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_id text := private.current_user_id();
  expired_accounts jsonb := '[]'::jsonb;
begin
  if not private.is_platform_admin_id(actor_id) then
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
  select coalesce(jsonb_agg(jsonb_build_object(
    'userId', user_id,
    'name', coalesce(nullif(display_name, ''), nullif(email, ''), 'Conta sem nome'),
    'email', email,
    'paidUntil', paid_until
  )), '[]'::jsonb)
  into expired_accounts
  from synchronized;
  return jsonb_build_object(
    'count', jsonb_array_length(expired_accounts),
    'accounts', expired_accounts
  );
end;
$$;

create or replace function public.delete_my_account_data()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  account_id text := private.current_user_id();
begin
  if account_id is null then raise exception 'Usuário não autenticado'; end if;
  if private.is_platform_admin_id(account_id) then
    raise exception 'A conta proprietária deve ser preservada';
  end if;
  delete from public.activity_history where owner_id = account_id;
  delete from public.loans where owner_id = account_id;
  delete from public.clients where owner_id = account_id;
  delete from public.profiles where owner_id = account_id;
  delete from public.workspace_audit_log where owner_id = account_id;
  delete from public.platform_accounts where user_id = account_id;
end;
$$;

-- O bootstrap antigo tinha um hash publicado no histórico do repositório.
-- Ele permanece apenas como estrutura de compatibilidade, sem conceder novo acesso.
create or replace function public.bootstrap_platform_admin(p_activation_code text)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
begin
  raise exception 'ADMIN_BOOTSTRAP_DISABLED';
end;
$$;
revoke all on public.platform_admin_bootstrap from public, anon, authenticated;
revoke all on function public.bootstrap_platform_admin(text) from public, anon, authenticated;

-- Remove todas as políticas antigas antes de instalar a lista mínima e explícita.
do $$
declare
  policy_row record;
begin
  for policy_row in
    select schemaname, tablename, policyname
    from pg_policies
    where schemaname = 'public'
      and tablename in (
        'clients', 'loans', 'activity_history', 'profiles',
        'workspace_audit_log', 'platform_settings', 'platform_accounts',
        'platform_admins', 'platform_admin_bootstrap', 'platform_access_log'
      )
  loop
    execute format(
      'drop policy if exists %I on %I.%I',
      policy_row.policyname, policy_row.schemaname, policy_row.tablename
    );
  end loop;
end;
$$;

drop policy if exists "Clientes pertencem ao usuario" on public.clients;
drop policy if exists "Cliente consulta os proprios dados" on public.clients;
create policy "Cliente consulta os proprios dados" on public.clients
  for select to anon, authenticated
  using (owner_id = (select auth.jwt()->>'sub'));

drop policy if exists "Emprestimos pertencem ao usuario" on public.loans;
drop policy if exists "Usuario consulta os proprios emprestimos" on public.loans;
create policy "Usuario consulta os proprios emprestimos" on public.loans
  for select to anon, authenticated
  using (owner_id = (select auth.jwt()->>'sub'));

drop policy if exists "Historico pertence ao usuario" on public.activity_history;
drop policy if exists "Usuario consulta o proprio historico" on public.activity_history;
create policy "Usuario consulta o proprio historico" on public.activity_history
  for select to anon, authenticated
  using (owner_id = (select auth.jwt()->>'sub'));

drop policy if exists "Perfil pertence ao usuario" on public.profiles;
drop policy if exists "Usuario consulta o proprio perfil" on public.profiles;
create policy "Usuario consulta o proprio perfil" on public.profiles
  for select to anon, authenticated
  using (owner_id = (select auth.jwt()->>'sub'));

drop policy if exists "Usuario consulta a propria auditoria" on public.workspace_audit_log;
create policy "Usuario consulta a propria auditoria" on public.workspace_audit_log
  for select to anon, authenticated
  using (
    owner_id = (select auth.jwt()->>'sub')
    or public.is_platform_admin()
  );

drop policy if exists "Administrador gerencia configuracoes" on public.platform_settings;
create policy "Administrador consulta configuracoes" on public.platform_settings
  for select to anon, authenticated
  using (public.is_platform_admin());

drop policy if exists "Administrador gerencia assinaturas" on public.platform_accounts;
create policy "Usuario ve a propria assinatura" on public.platform_accounts
  for select to anon, authenticated
  using (
    user_id = (select auth.jwt()->>'sub')
    or public.is_platform_admin()
  );

create policy "Administrador ve administradores" on public.platform_admins
  for select to anon, authenticated
  using (public.is_platform_admin());

create policy "Administrador ve historico de acessos" on public.platform_access_log
  for select to anon, authenticated
  using (public.is_platform_admin());

revoke all on public.clients from public, anon, authenticated;
revoke all on public.loans from public, anon, authenticated;
revoke all on public.activity_history from public, anon, authenticated;
revoke all on public.profiles from public, anon, authenticated;
revoke all on public.platform_settings from public, anon, authenticated;
revoke all on public.platform_accounts from public, anon, authenticated;
revoke all on public.platform_admins from public, anon, authenticated;
revoke all on public.platform_access_log from public, anon, authenticated;
revoke all on public.platform_admin_bootstrap from public, anon, authenticated;
revoke all on public.workspace_audit_log from public, anon, authenticated;
revoke all on sequence public.platform_access_log_id_seq from public, anon, authenticated;
revoke all on sequence public.workspace_audit_log_id_seq from public, anon, authenticated;

grant select on public.clients to anon, authenticated;
grant select on public.loans to anon, authenticated;
grant select on public.activity_history to anon, authenticated;
grant select on public.profiles to anon, authenticated;
grant select on public.workspace_audit_log to anon, authenticated;
grant select on public.platform_settings to anon, authenticated;
grant select on public.platform_accounts to anon, authenticated;
grant select on public.platform_admins to anon, authenticated;
grant select on public.platform_access_log to anon, authenticated;

revoke all on function private.current_user_id() from public, anon, authenticated;
revoke all on function private.is_platform_admin_id(text) from public, anon, authenticated;
revoke all on function private.has_active_platform_access_id(text) from public, anon, authenticated;
revoke all on function private.audit_workspace_change() from public, anon, authenticated;
revoke all on function private.register_platform_expiration() from public, anon, authenticated;

revoke all on function public.is_platform_admin() from public, anon, authenticated;
revoke all on function public.has_active_platform_access() from public, anon, authenticated;
revoke all on function public.ensure_platform_account(text, text) from public, anon, authenticated;
revoke all on function public.request_platform_access(text, text) from public, anon, authenticated;
revoke all on function public.sync_my_workspace_v1(jsonb, jsonb, jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.save_my_profile_v1(text, text, text, text) from public, anon, authenticated;
revoke all on function public.delete_my_loan_v1(uuid) from public, anon, authenticated;
revoke all on function public.delete_my_client_v1(uuid) from public, anon, authenticated;
revoke all on function public.admin_update_platform_account_v1(text, text, text, numeric) from public, anon, authenticated;
revoke all on function public.admin_update_platform_settings_v1(numeric, text, text, text, text, text) from public, anon, authenticated;
revoke all on function public.admin_grant_platform_access_v3(text, integer, text, numeric, text, numeric, text, text) from public, anon, authenticated;
revoke all on function public.admin_grant_platform_access_v2(text, integer, text, numeric, text, numeric) from public, anon, authenticated;
revoke all on function public.admin_grant_platform_access(text, integer, numeric) from public, anon, authenticated;
revoke all on function public.admin_grant_platform_lifetime_v2(text, text, text) from public, anon, authenticated;
revoke all on function public.admin_grant_platform_lifetime(text) from public, anon, authenticated;
revoke all on function public.admin_set_platform_status(text, text) from public, anon, authenticated;
revoke all on function public.admin_sync_expired_platform_accounts() from public, anon, authenticated;
revoke all on function public.delete_my_account_data() from public, anon, authenticated;

grant execute on function public.is_platform_admin() to anon, authenticated;
grant execute on function public.has_active_platform_access() to anon, authenticated;
grant execute on function public.ensure_platform_account(text, text) to anon, authenticated;
grant execute on function public.request_platform_access(text, text) to anon, authenticated;
grant execute on function public.sync_my_workspace_v1(jsonb, jsonb, jsonb, jsonb) to anon, authenticated;
grant execute on function public.save_my_profile_v1(text, text, text, text) to anon, authenticated;
grant execute on function public.delete_my_loan_v1(uuid) to anon, authenticated;
grant execute on function public.delete_my_client_v1(uuid) to anon, authenticated;
grant execute on function public.admin_update_platform_account_v1(text, text, text, numeric) to anon, authenticated;
grant execute on function public.admin_update_platform_settings_v1(numeric, text, text, text, text, text) to anon, authenticated;
grant execute on function public.admin_grant_platform_access_v3(text, integer, text, numeric, text, numeric, text, text) to anon, authenticated;
grant execute on function public.admin_grant_platform_access_v2(text, integer, text, numeric, text, numeric) to anon, authenticated;
grant execute on function public.admin_grant_platform_access(text, integer, numeric) to anon, authenticated;
grant execute on function public.admin_grant_platform_lifetime_v2(text, text, text) to anon, authenticated;
grant execute on function public.admin_grant_platform_lifetime(text) to anon, authenticated;
grant execute on function public.admin_set_platform_status(text, text) to anon, authenticated;
grant execute on function public.admin_sync_expired_platform_accounts() to anon, authenticated;
grant execute on function public.delete_my_account_data() to anon, authenticated;

do $$
begin
  if exists (
    select 1 from information_schema.role_table_grants
    where table_schema = 'public'
      and table_name in (
        'clients', 'loans', 'activity_history', 'profiles',
        'workspace_audit_log', 'platform_settings', 'platform_accounts',
        'platform_admins', 'platform_admin_bootstrap', 'platform_access_log'
      )
      and grantee in ('PUBLIC', 'anon', 'authenticated')
      and privilege_type in ('INSERT', 'UPDATE', 'DELETE')
  ) then
    raise exception 'Escrita direta ainda está autorizada';
  end if;
  if exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename in (
        'clients', 'loans', 'activity_history', 'profiles',
        'workspace_audit_log', 'platform_settings', 'platform_accounts',
        'platform_admins', 'platform_admin_bootstrap', 'platform_access_log'
      )
      and cmd <> 'SELECT'
  ) then
    raise exception 'Política antiga de escrita ainda está ativa';
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.loans'::regclass
      and conname = 'loans_client_owner_id_fkey'
      and convalidated
  ) then
    raise exception 'Vínculo seguro entre empréstimo e cliente não foi validado';
  end if;
  if to_regprocedure('public.sync_my_workspace_v1(jsonb,jsonb,jsonb,jsonb)') is null then
    raise exception 'RPC transacional de sincronização não foi instalada';
  end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'platform_accounts'
      and column_name = 'expiry_notified_at'
  ) then
    raise exception 'Coluna de notificação de vencimento não foi instalada';
  end if;
  if has_function_privilege('anon', 'public.bootstrap_platform_admin(text)', 'EXECUTE')
    or has_function_privilege('authenticated', 'public.bootstrap_platform_admin(text)', 'EXECUTE') then
    raise exception 'Bootstrap administrativo ainda pode ser executado';
  end if;
  if exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'private')
      and p.prosecdef
      and not exists (
        select 1 from unnest(coalesce(p.proconfig, array[]::text[])) setting
        where setting like 'search_path=%'
      )
      and p.proname in (
        'is_platform_admin', 'has_active_platform_access',
        'ensure_platform_account', 'request_platform_access',
        'sync_my_workspace_v1', 'save_my_profile_v1',
        'delete_my_loan_v1', 'delete_my_client_v1',
        'admin_update_platform_account_v1', 'admin_update_platform_settings_v1',
        'admin_grant_platform_access_v3', 'admin_grant_platform_lifetime_v2',
        'admin_set_platform_status', 'admin_sync_expired_platform_accounts',
        'delete_my_account_data', 'audit_workspace_change',
        'register_platform_expiration'
      )
  ) then
    raise exception 'Uma função privilegiada está com search_path inseguro';
  end if;
end;
$$;

notify pgrst, 'reload schema';
commit;
