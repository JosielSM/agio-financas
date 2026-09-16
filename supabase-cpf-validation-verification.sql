-- Verificação transacional do CPF opcional no limite público do Supabase.
-- Todos os dados temporários são descartados no rollback.

begin;

do $$
declare
  test_user_id text := 'credmais-cpf-' || substr(
    md5(clock_timestamp()::text || random()::text),
    1,
    24
  );
  empty_cpf_client_id uuid := gen_random_uuid();
  valid_cpf_client_id uuid := gen_random_uuid();
  invalid_cpf_client_id uuid := gen_random_uuid();
  saved jsonb;
begin
  if not private.is_valid_optional_cpf('')
    or not private.is_valid_optional_cpf('529.982.247-25')
    or private.is_valid_optional_cpf('529.982.247-24')
    or private.is_valid_optional_cpf('111.111.111-11') then
    raise exception 'O algoritmo de CPF opcional retornou um resultado incorreto';
  end if;

  perform set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'sub', test_user_id,
      'email', test_user_id || '@credmais.invalid'
    )::text,
    true
  );

  insert into public.platform_accounts (
    user_id,
    email,
    display_name,
    status,
    paid_until
  ) values (
    test_user_id,
    test_user_id || '@credmais.invalid',
    'Conta temporária para CPF',
    'active',
    current_date + 1
  );

  saved := public.sync_my_workspace_v1(
    jsonb_build_array(
      jsonb_build_object(
        'id', empty_cpf_client_id,
        'name', 'Cliente sem CPF',
        'cpf', '',
        'phone', '(11) 99999-0000',
        'email', '',
        'note', '',
        'blacklisted', false
      ),
      jsonb_build_object(
        'id', valid_cpf_client_id,
        'name', 'Cliente com CPF válido',
        'cpf', '529.982.247-25',
        'phone', '(11) 99999-0001',
        'email', '',
        'note', '',
        'blacklisted', false
      )
    ),
    '[]'::jsonb,
    '[]'::jsonb,
    '{}'::jsonb
  );

  if (saved->>'clients')::integer <> 2 then
    raise exception 'A sincronização não aceitou CPF vazio e CPF válido';
  end if;

  begin
    perform public.sync_my_workspace_v1(
      jsonb_build_array(
        jsonb_build_object(
          'id', invalid_cpf_client_id,
          'name', 'Cliente com CPF inválido',
          'cpf', '529.982.247-24',
          'phone', '(11) 99999-0002',
          'email', '',
          'note', '',
          'blacklisted', false
        )
      ),
      '[]'::jsonb,
      '[]'::jsonb,
      '{}'::jsonb
    );
    raise exception 'A sincronização aceitou um CPF inválido';
  exception
    when others then
      if sqlerrm <> 'CPF do cliente inválido' then
        raise;
      end if;
  end;
end;
$$;

rollback;

select 'credmais_optional_cpf_verified' as result;
