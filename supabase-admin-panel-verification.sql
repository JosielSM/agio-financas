-- Verificação transacional do histórico e das liberações manuais. Nada persiste.
begin;

do $$
declare
  owner_id text;
  test_user_id text := 'credmais-admin-ux-' || substr(md5(clock_timestamp()::text || random()::text), 1, 20);
  saved jsonb;
  history jsonb;
  denied boolean := false;
begin
  select user_id into owner_id from public.platform_admins order by created_at limit 1;
  if owner_id is null then raise exception 'Administrador não encontrado'; end if;

  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config('request.jwt.claims', jsonb_build_object('sub', owner_id, 'role', 'authenticated')::text, true);
  insert into public.platform_accounts (user_id, email, display_name, status)
  values (test_user_id, test_user_id || '@credmais.invalid', 'Teste temporário do painel', 'pending');

  saved := public.admin_grant_platform_access_v6(
    test_user_id, 1, 'months', 'custom', 39.90, 'paid', 39.90, 'cash', null, 'Teste transacional'
  );
  if saved->>'manual_payment_method' <> 'cash'
    or saved->>'access_type' <> 'paid'
    or saved->>'last_payment_transaction_id' is not null then
    raise exception 'Liberação paga não registrou corretamente a origem manual';
  end if;

  history := public.admin_get_platform_account_history_v1(test_user_id, 0, 1);
  if jsonb_array_length(history->'events') <> 1
    or history->'events'->0->>'paymentMethod' <> 'cash'
    or history->'events'->0->>'kind' <> 'access' then
    raise exception 'Histórico manual não identifica o meio de pagamento';
  end if;

  saved := public.admin_grant_platform_access_v6(
    test_user_id, 15, 'days', 'global', null, 'free', 0, null, null, 'Teste gratuito'
  );
  if saved->>'manual_payment_method' is not null
    or saved->>'access_type' <> 'free' then
    raise exception 'Cortesia preservou dados de pagamento anterior';
  end if;

  history := public.admin_get_platform_account_history_v1(test_user_id, 0, 1);
  if history->>'hasMore' <> 'true'
    or (history->>'nextOffset')::integer <> 1 then
    raise exception 'Paginação do histórico está incorreta';
  end if;

  perform set_config('request.jwt.claims', jsonb_build_object('sub', test_user_id, 'role', 'authenticated')::text, true);
  begin
    perform public.admin_get_platform_account_history_v1(test_user_id, 0, 1);
  exception when others then
    denied := sqlerrm like '%Acesso administrativo necessário%';
  end;
  if not denied then raise exception 'Histórico administrativo acessível a usuário comum'; end if;
end;
$$;

rollback;
select 'credmais_admin_panel_verified' as result;
