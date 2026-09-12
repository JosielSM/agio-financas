-- Execute UMA VEZ no Supabase SQL Editor antes de ativar firebase-config.js.
-- Esta migração preserva os dados e permite UIDs alfanuméricos do Firebase.
begin;

-- Algumas instalações antigas ainda não têm histórico e perfil na nuvem.
-- Criar as tabelas primeiro torna a migração repetível e evita uma ativação parcial.
create table if not exists public.activity_history (
  id uuid primary key,
  owner_id text not null,
  category text not null,
  title text not null,
  description text not null default '',
  created_at timestamptz not null default now()
);

create table if not exists public.profiles (
  owner_id text primary key,
  display_name text not null default '',
  pix_key text not null default '',
  pix_key_type text not null default 'Chave aleatória',
  pix_recipient_name text not null default '',
  updated_at timestamptz not null default now()
);

alter table public.clients
  drop constraint if exists clients_owner_id_fkey;
alter table public.loans
  drop constraint if exists loans_owner_id_fkey;
alter table public.activity_history
  drop constraint if exists activity_history_owner_id_fkey;

drop policy if exists "Clientes pertencem ao usuario" on public.clients;
drop policy if exists "Emprestimos pertencem ao usuario" on public.loans;
drop policy if exists "Historico pertence ao usuario" on public.activity_history;
drop policy if exists "Perfil pertence ao usuario" on public.profiles;

alter table public.clients
  alter column owner_id type text using owner_id::text;
alter table public.loans
  alter column owner_id type text using owner_id::text;
alter table public.activity_history
  alter column owner_id type text using owner_id::text;

-- Excluir um cliente e seus empréstimos em uma única transação do banco.
-- O CASCADE evita o estado parcial que ocorreria com duas requisições separadas.
alter table public.loans
  drop constraint if exists loans_client_id_fkey;
alter table public.loans
  add constraint loans_client_id_fkey
  foreign key (client_id) references public.clients(id) on delete cascade;

alter table public.clients enable row level security;
alter table public.loans enable row level security;
alter table public.activity_history enable row level security;
alter table public.profiles enable row level security;

-- Tokens Firebase sem uma claim "role" são executados pelo PostgREST como anon.
-- O sub continua sendo o UID autenticado; as políticas abaixo exigem esse UID e
-- também funcionam para contas antigas que já tenham role=authenticated.

create policy "Clientes pertencem ao usuario" on public.clients
  for all to anon, authenticated
  using (owner_id = (select auth.jwt()->>'sub'))
  with check (owner_id = (select auth.jwt()->>'sub'));

create policy "Emprestimos pertencem ao usuario" on public.loans
  for all to anon, authenticated
  using (owner_id = (select auth.jwt()->>'sub'))
  with check (owner_id = (select auth.jwt()->>'sub'));

create policy "Historico pertence ao usuario" on public.activity_history
  for all to anon, authenticated
  using (owner_id = (select auth.jwt()->>'sub'))
  with check (owner_id = (select auth.jwt()->>'sub'));

create policy "Perfil pertence ao usuario" on public.profiles
  for all to anon, authenticated
  using (owner_id = (select auth.jwt()->>'sub'))
  with check (owner_id = (select auth.jwt()->>'sub'));

grant select, insert, update, delete on public.clients to anon, authenticated;
grant select, insert, update, delete on public.loans to anon, authenticated;
grant select, insert, update, delete on public.activity_history to anon, authenticated;
grant select, insert, update, delete on public.profiles to anon, authenticated;

-- Exclusão completa da própria conta em uma única transação do banco.
-- A função usa as políticas RLS do usuário que fez a solicitação.
create or replace function public.delete_my_account_data()
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  account_id text := auth.jwt()->>'sub';
begin
  if account_id is null or account_id = '' then
    raise exception 'Usuário não autenticado';
  end if;

  delete from public.activity_history where owner_id = account_id;
  delete from public.loans where owner_id = account_id;
  delete from public.clients where owner_id = account_id;
  delete from public.profiles where owner_id = account_id;
end;
$$;

revoke all on function public.delete_my_account_data() from public;
grant execute on function public.delete_my_account_data() to anon, authenticated;

commit;
