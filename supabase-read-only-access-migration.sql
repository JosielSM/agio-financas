-- Permite consultar os próprios dados sem assinatura, mantendo todas as escritas bloqueadas.
begin;

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

commit;
