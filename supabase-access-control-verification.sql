-- Teste transacional das liberações manuais do CredMais.
-- Todos os registros criados e alterações simuladas são desfeitos no ROLLBACK.

begin;

do $$
declare
  admin_id text;
  test_user_id text := 'credmais-integration-' || substr(
    md5(clock_timestamp()::text || random()::text),
    1,
    24
  );
  expected_expiration date;
  saved jsonb;
begin
  select user_id into admin_id
  from public.platform_admins
  order by created_at
  limit 1;

  if admin_id is null then
    raise exception 'Nenhuma conta proprietária está cadastrada';
  end if;

  perform set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'sub', admin_id,
      'email', 'integration-test@credmais.invalid'
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
    'Conta temporária de integração',
    'active',
    current_date + 365
  );

  saved := public.admin_grant_platform_access_v5(
    test_user_id,
    1,
    'months',
    'custom',
    49.90,
    'paid',
    49.90,
    null,
    'Teste transacional'
  );
  expected_expiration := (current_date + make_interval(months => 1))::date;
  if (saved->>'paid_until')::date <> expected_expiration
    or saved->>'status' <> 'active'
    or saved->>'access_type' <> 'paid' then
    raise exception 'A liberação paga mensal não substituiu a validade corretamente';
  end if;

  saved := public.admin_grant_platform_access_v5(
    test_user_id,
    15,
    'days',
    'launch_locked',
    null,
    'free',
    0,
    null,
    'Teste gratuito'
  );
  if (saved->>'paid_until')::date <> current_date + 14
    or saved->>'access_type' <> 'free'
    or (saved->>'access_amount')::numeric <> 0 then
    raise exception 'A liberação gratuita de 15 dias está incorreta';
  end if;

  saved := public.admin_grant_platform_lifetime_v2(
    test_user_id,
    null,
    'Colaborador de teste'
  );
  if saved->>'status' <> 'active'
    or saved->>'access_type' <> 'lifetime'
    or saved->>'pricing_tier' <> 'lifetime'
    or saved->>'paid_until' is not null then
    raise exception 'A liberação vitalícia está incorreta';
  end if;

  saved := public.admin_set_platform_status(test_user_id, 'blocked');
  if saved->>'status' <> 'blocked'
    or private.has_active_platform_access_id(test_user_id) then
    raise exception 'O bloqueio manual não interrompeu o acesso';
  end if;

  saved := public.admin_grant_platform_access_v5(
    test_user_id,
    2,
    'months',
    'custom',
    49.90,
    'paid',
    99.80,
    null,
    'Renovação de teste'
  );
  expected_expiration := (current_date + make_interval(months => 2))::date;
  if (saved->>'paid_until')::date <> expected_expiration
    or not private.has_active_platform_access_id(test_user_id) then
    raise exception 'A renovação após bloqueio não restabeleceu o acesso';
  end if;
end;
$$;

rollback;

select 'credmais_access_control_verified' as result;
