-- Execute UMA VEZ no Supabase SQL Editor antes de ativar firebase-config.js.
-- Esta migração preserva os dados e permite UIDs alfanuméricos do Firebase.
begin;

alter table public.clients
  drop constraint if exists clients_owner_id_fkey;
alter table public.loans
  drop constraint if exists loans_owner_id_fkey;
alter table public.activity_history
  drop constraint if exists activity_history_owner_id_fkey;

alter table public.clients
  alter column owner_id type text using owner_id::text;
alter table public.loans
  alter column owner_id type text using owner_id::text;
alter table public.activity_history
  alter column owner_id type text using owner_id::text;

create table if not exists public.profiles (
  owner_id text primary key,
  display_name text not null default '',
  pix_key text not null default '',
  pix_key_type text not null default 'Chave aleatória',
  pix_recipient_name text not null default '',
  updated_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

drop policy if exists "Clientes pertencem ao usuario" on public.clients;
create policy "Clientes pertencem ao usuario" on public.clients
  for all to authenticated
  using (owner_id = (select auth.jwt()->>'sub'))
  with check (owner_id = (select auth.jwt()->>'sub'));

drop policy if exists "Emprestimos pertencem ao usuario" on public.loans;
create policy "Emprestimos pertencem ao usuario" on public.loans
  for all to authenticated
  using (owner_id = (select auth.jwt()->>'sub'))
  with check (owner_id = (select auth.jwt()->>'sub'));

drop policy if exists "Historico pertence ao usuario" on public.activity_history;
create policy "Historico pertence ao usuario" on public.activity_history
  for all to authenticated
  using (owner_id = (select auth.jwt()->>'sub'))
  with check (owner_id = (select auth.jwt()->>'sub'));

drop policy if exists "Perfil pertence ao usuario" on public.profiles;
create policy "Perfil pertence ao usuario" on public.profiles
  for all to authenticated
  using (owner_id = (select auth.jwt()->>'sub'))
  with check (owner_id = (select auth.jwt()->>'sub'));

grant select, insert, update, delete on public.profiles to authenticated;

commit;
