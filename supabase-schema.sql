-- Execute este arquivo inteiro em Supabase Dashboard > SQL Editor > New query.
create table if not exists public.clients (
  id uuid primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  cpf text not null,
  phone text not null,
  email text,
  note text,
  blacklisted boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists public.loans (
  id uuid primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,
  contract text not null,
  client_id uuid not null references public.clients(id) on delete restrict,
  amount numeric(14,2) not null,
  rate numeric(8,5) not null,
  installments integer not null check (installments > 0),
  frequency integer not null check (frequency > 0),
  late_fee numeric(14,2) not null default 0,
  total numeric(14,2) not null,
  installment numeric(14,2) not null,
  due_date date not null,
  payment_states jsonb not null default '{}'::jsonb,
  custom_dates jsonb not null default '{}'::jsonb,
  archived boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists public.activity_history (
  id uuid primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,
  category text not null,
  title text not null,
  description text not null default '',
  created_at timestamptz not null default now()
);

alter table public.clients enable row level security;
alter table public.loans enable row level security;
alter table public.activity_history enable row level security;

drop policy if exists "Clientes pertencem ao usuario" on public.clients;
create policy "Clientes pertencem ao usuario" on public.clients
  for all to authenticated using (owner_id = auth.uid()) with check (owner_id = auth.uid());
drop policy if exists "Emprestimos pertencem ao usuario" on public.loans;
create policy "Emprestimos pertencem ao usuario" on public.loans
  for all to authenticated using (owner_id = auth.uid()) with check (owner_id = auth.uid());
drop policy if exists "Historico pertence ao usuario" on public.activity_history;
create policy "Historico pertence ao usuario" on public.activity_history
  for all to authenticated using (owner_id = auth.uid()) with check (owner_id = auth.uid());

grant select, insert, update, delete on public.clients to authenticated;
grant select, insert, update, delete on public.loans to authenticated;
grant select, insert, update, delete on public.activity_history to authenticated;
