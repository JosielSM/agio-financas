-- Verificação independente da fronteira de pagamentos automáticos.
-- Falha imediatamente se o navegador puder confirmar pagamentos ou gravar nas tabelas.

begin;

do $$
declare
  payment_table text;
  function_signature text;
begin
  foreach payment_table in array array[
    'platform_payment_orders',
    'platform_payment_transactions',
    'platform_subscriptions'
  ] loop
    if to_regclass('public.' || payment_table) is null then
      raise exception 'Tabela de pagamentos ausente: %', payment_table;
    end if;
    if not exists (
      select 1 from pg_class relation
      join pg_namespace namespace on namespace.oid = relation.relnamespace
      where namespace.nspname = 'public'
        and relation.relname = payment_table
        and relation.relrowsecurity
    ) then
      raise exception 'RLS não está ativo em %', payment_table;
    end if;
  end loop;

  if exists (
    select 1
    from information_schema.role_table_grants
    where table_schema = 'public'
      and table_name in (
        'platform_payment_orders',
        'platform_payment_transactions',
        'platform_subscriptions'
      )
      and grantee in ('PUBLIC', 'anon', 'authenticated')
  ) then
    raise exception 'O navegador ainda possui privilégio direto em tabelas de pagamento';
  end if;

  foreach function_signature in array array[
    'public.system_attach_mercado_checkout_v1(uuid,text,text,text,timestamp with time zone,boolean)',
    'public.system_mark_mercado_checkout_error_v1(uuid,text)',
    'public.system_process_mercado_payment_v1(uuid,text,text,numeric,text,text,text,timestamp with time zone,boolean,jsonb)',
    'public.system_sync_mercado_subscription_v1(uuid,text,text,numeric,text,timestamp with time zone,boolean)'
  ] loop
    if to_regprocedure(function_signature) is null then
      raise exception 'Função reservada ausente: %', function_signature;
    end if;
    if has_function_privilege('anon', function_signature, 'EXECUTE')
      or has_function_privilege('authenticated', function_signature, 'EXECUTE') then
      raise exception 'Função reservada exposta ao navegador: %', function_signature;
    end if;
    if not has_function_privilege('service_role', function_signature, 'EXECUTE') then
      raise exception 'Worker sem acesso à função reservada: %', function_signature;
    end if;
  end loop;

  if not has_function_privilege(
    'authenticated',
    'public.create_platform_payment_order_v1(integer,text)',
    'EXECUTE'
  ) then
    raise exception 'Usuário autenticado não consegue iniciar um checkout';
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'platform_accounts'
      and column_name = 'last_payment_transaction_id'
  ) then
    raise exception 'Proteção contra estorno concorrente não foi instalada';
  end if;

  if exists (
    select 1
    from pg_proc function_definition
    join pg_namespace namespace on namespace.oid = function_definition.pronamespace
    where namespace.nspname = 'public'
      and function_definition.proname like '%mercado%'
      and function_definition.prosecdef
      and not exists (
        select 1
        from unnest(coalesce(function_definition.proconfig, array[]::text[])) setting
        where setting = 'search_path=' or setting like 'search_path=%'
      )
  ) then
    raise exception 'Função de pagamento com search_path inseguro';
  end if;
end;
$$;

select 'credmais_mercado_pago_database_verified' as result;

rollback;
