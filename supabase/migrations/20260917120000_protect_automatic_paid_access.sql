-- Um pagamento real aprovado compra um período de acesso. Ações administrativas
-- comuns não podem apagar, bloquear ou substituir esse período; ajustes de
-- preço e contato continuam permitidos para compras futuras.
begin;

create or replace function private.protect_automatic_paid_access()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- A conciliação de pagamentos roda exclusivamente com a credencial de
  -- serviço: aprovação, estorno e contestação precisam continuar funcionando.
  if auth.role() = 'service_role' then
    return new;
  end if;

  if old.status = 'active'
    and old.access_type = 'paid'
    and old.paid_until >= current_date
    and old.last_payment_transaction_id is not null
    and exists (
      select 1
      from public.platform_payment_transactions payment
      where payment.id = old.last_payment_transaction_id
        and payment.status = 'approved'
        and payment.live_mode = true
        and payment.access_granted_at is not null
    )
    and row(
      new.status, new.paid_until, new.access_type, new.access_amount,
      new.approved_at, new.approved_by, new.last_payment_transaction_id,
      new.access_reset_at
    ) is distinct from row(
      old.status, old.paid_until, old.access_type, old.access_amount,
      old.approved_at, old.approved_by, old.last_payment_transaction_id,
      old.access_reset_at
    ) then
    raise exception 'O período pago pelo Mercado Pago está protegido até %. Altere apenas dados ou o preço de compras futuras.',
      to_char(old.paid_until, 'DD/MM/YYYY') using errcode = 'P0001';
  end if;

  return new;
end;
$$;

drop trigger if exists platform_accounts_paid_access_protection on public.platform_accounts;
create trigger platform_accounts_paid_access_protection
before update on public.platform_accounts
for each row execute function private.protect_automatic_paid_access();

revoke all on function private.protect_automatic_paid_access() from public, anon, authenticated;

comment on function private.protect_automatic_paid_access() is
  'Impede alteração administrativa do período pago aprovado em produção, sem impedir preço futuro ou conciliação pelo serviço.';

commit;
