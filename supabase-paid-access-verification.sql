-- Teste transacional da proteção. Nenhuma conta de teste é preservada.
begin;

do $$
declare
  owner_id text;
  test_user_id text := 'credmais-paid-guard-' || substr(md5(clock_timestamp()::text || random()::text), 1, 20);
  order_id uuid;
  transaction_id bigint;
  blocked boolean;
begin
  select user_id into owner_id from public.platform_admins order by created_at limit 1;
  if owner_id is null then raise exception 'Administrador não encontrado'; end if;

  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config('request.jwt.claims', jsonb_build_object('sub', owner_id, 'role', 'authenticated')::text, true);

  insert into public.platform_accounts (user_id, email, display_name, status)
  values (test_user_id, test_user_id || '@credmais.invalid', 'Teste temporário', 'pending');

  insert into public.platform_payment_orders (
    user_id, payment_mode, plan_months, monthly_fee, amount, status, live_mode, access_granted_at
  ) values (
    test_user_id, 'one_time', 1, 39.90, 39.90, 'approved', true, now()
  ) returning id into order_id;

  insert into public.platform_payment_transactions (
    order_id, provider_payment_id, status, amount, currency, live_mode, access_granted_at
  ) values (
    order_id, 'paid-guard-' || order_id::text, 'approved', 39.90, 'BRL', true, now()
  ) returning id into transaction_id;

  update public.platform_accounts set
    status = 'active', access_type = 'paid', paid_until = current_date + 30,
    approved_at = now(), approved_by = 'mercado_pago',
    last_payment_transaction_id = transaction_id
  where user_id = test_user_id;

  blocked := false;
  begin
    perform public.admin_set_platform_status(test_user_id, 'blocked');
  exception when others then
    blocked := sqlerrm like '%período pago pelo Mercado Pago está protegido%';
  end;
  if not blocked then raise exception 'Bloqueio administrativo não foi impedido'; end if;

  blocked := false;
  begin
    perform public.admin_reset_platform_access_v1(test_user_id);
  exception when others then
    blocked := sqlerrm like '%período pago pelo Mercado Pago está protegido%';
  end;
  if not blocked then raise exception 'Reset administrativo não foi impedido'; end if;

  blocked := false;
  begin
    perform public.admin_grant_platform_access_v5(
      test_user_id, 1, 'months', 'custom', 29.90, 'paid', 29.90, null, null
    );
  exception when others then
    blocked := sqlerrm like '%período pago pelo Mercado Pago está protegido%';
  end;
  if not blocked then raise exception 'Troca manual de plano não foi impedida'; end if;

  blocked := false;
  begin
    perform public.admin_grant_platform_lifetime_v2(test_user_id, null, null);
  exception when others then
    blocked := sqlerrm like '%período pago pelo Mercado Pago está protegido%';
  end;
  if not blocked then raise exception 'Mudança vitalícia não foi impedida'; end if;

  perform public.admin_update_platform_account_v3(
    test_user_id, null, null, 'custom', 29.90
  );
  if (select paid_until from public.platform_accounts where user_id = test_user_id) <> current_date + 30
    or (select monthly_fee from public.platform_accounts where user_id = test_user_id) <> 29.90 then
    raise exception 'Ajuste de preço futuro alterou a validade comprada';
  end if;

  -- A conciliação de estorno/contestação com credencial de serviço permanece possível.
  perform set_config('request.jwt.claim.role', 'service_role', true);
  update public.platform_accounts set status = 'blocked', paid_until = current_date - 1
  where user_id = test_user_id;
  if (select status from public.platform_accounts where user_id = test_user_id) <> 'blocked' then
    raise exception 'Conciliação pelo serviço foi indevidamente bloqueada';
  end if;
end;
$$;

rollback;

select 'credmais_paid_access_protection_verified' as result;
