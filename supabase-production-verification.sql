-- Verificação somente de leitura para a configuração de produção do CredMais.
-- Qualquer requisito ausente encerra o comando com erro.

do $$
begin
  if not exists (
    select 1 from public.platform_admins
  ) then
    raise exception 'Nenhuma conta proprietária está cadastrada';
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'platform_accounts'
      and column_name = 'expiry_notified_at'
  ) then
    raise exception 'A coluna expiry_notified_at não existe';
  end if;

  if exists (
    select required.column_name
    from unnest(array['pricing_tier', 'trial_started_at']) as required(column_name)
    where not exists (
      select 1 from information_schema.columns actual
      where actual.table_schema = 'public'
        and actual.table_name = 'platform_accounts'
        and actual.column_name = required.column_name
    )
  ) then
    raise exception 'A política de lançamento ou teste gratuito está incompleta em platform_accounts';
  end if;

  if exists (
    select required.column_name
    from unnest(array[
      'launch_monthly_fee', 'standard_monthly_fee', 'pricing_phase', 'trial_days'
    ]) as required(column_name)
    where not exists (
      select 1 from information_schema.columns actual
      where actual.table_schema = 'public'
        and actual.table_name = 'platform_settings'
        and actual.column_name = required.column_name
    )
  ) then
    raise exception 'A política comercial está incompleta em platform_settings';
  end if;

  if not exists (
    select 1 from public.platform_settings
    where id = 1
      and launch_monthly_fee = 39.90
      and standard_monthly_fee >= 39.90
      and pricing_phase in ('launch', 'standard')
      and trial_days = 15
      and default_monthly_fee = case
        when pricing_phase = 'launch' then launch_monthly_fee
        else standard_monthly_fee
      end
  ) then
    raise exception 'Os valores comerciais do CredMais estão inconsistentes';
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.loans'::regclass
      and conname = 'loans_client_owner_id_fkey'
      and convalidated
  ) then
    raise exception 'O vínculo composto entre empréstimo e proprietário não está validado';
  end if;

  if exists (
    select 1
    from public.loans loan
    left join public.clients client
      on client.id = loan.client_id
      and client.owner_id = loan.owner_id
    where client.id is null
  ) then
    raise exception 'Existe empréstimo vinculado a cliente de outra conta';
  end if;

  if exists (
    select 1 from information_schema.role_table_grants
    where table_schema = 'public'
      and table_name in (
        'clients', 'loans', 'activity_history', 'profiles',
        'workspace_audit_log', 'platform_settings', 'platform_accounts',
        'platform_admins', 'platform_admin_bootstrap', 'platform_access_log'
      )
      and grantee in ('PUBLIC', 'anon', 'authenticated')
      and privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')
  ) then
    raise exception 'Uma tabela protegida ainda aceita escrita direta';
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
    raise exception 'Uma política antiga de escrita ainda está ativa';
  end if;

  if to_regprocedure('public.sync_my_workspace_v1(jsonb,jsonb,jsonb,jsonb)') is null
    or to_regprocedure('public.admin_update_platform_settings_v3(numeric,text,text,text)') is null
    or to_regprocedure('public.admin_update_platform_account_v3(text,text,text,text,numeric)') is null
    or to_regprocedure('public.admin_grant_platform_access_v5(text,integer,text,text,numeric,text,numeric,text,text)') is null
    or to_regprocedure('public.delete_my_account_data()') is null then
    raise exception 'Uma RPC obrigatória não está instalada';
  end if;

  if has_function_privilege('anon', 'public.bootstrap_platform_admin(text)', 'EXECUTE')
    or has_function_privilege('authenticated', 'public.bootstrap_platform_admin(text)', 'EXECUTE') then
    raise exception 'O bootstrap administrativo ainda pode ser executado';
  end if;

  if exists (
    select 1 from pg_proc function_row
    join pg_namespace namespace_row on namespace_row.oid = function_row.pronamespace
    where namespace_row.nspname in ('public', 'private')
      and function_row.prosecdef
      and function_row.proname in (
        'is_platform_admin', 'has_active_platform_access',
        'ensure_platform_account', 'request_platform_access',
        'sync_my_workspace_v1', 'save_my_profile_v1',
        'delete_my_loan_v1', 'delete_my_client_v1',
        'admin_update_platform_account_v1', 'admin_update_platform_account_v3',
        'admin_update_platform_settings_v1', 'admin_update_platform_settings_v3',
        'admin_grant_platform_access_v3', 'admin_grant_platform_access_v5',
        'admin_grant_platform_lifetime_v2',
        'admin_set_platform_status', 'admin_sync_expired_platform_accounts',
        'delete_my_account_data', 'audit_workspace_change',
        'register_platform_expiration'
      )
      and not exists (
        select 1
        from unnest(coalesce(function_row.proconfig, array[]::text[])) setting
        where setting like 'search_path=%'
      )
  ) then
    raise exception 'Uma função privilegiada possui search_path inseguro';
  end if;
end;
$$;

select 'credmais_production_database_verified' as result;
