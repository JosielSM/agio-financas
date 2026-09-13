-- Registra e informa automaticamente os bloqueios causados por mensalidade vencida.
-- Execute este arquivo uma vez no SQL Editor do Supabase.
begin;

alter table public.platform_accounts
  add column if not exists expiry_notified_at timestamptz;

create or replace function public.register_platform_expiration()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status = 'active'
    and new.paid_until is not null
    and new.paid_until < current_date
    and old.expiry_notified_at is null
  then
    new.expiry_notified_at := coalesce(new.expiry_notified_at, now());

    insert into public.platform_access_log (
      user_id, actor_id, action, action_label, details
    ) values (
      new.user_id,
      coalesce(auth.jwt()->>'sub', 'system'),
      'automatic_expiration',
      'Acesso bloqueado automaticamente por pagamento vencido',
      jsonb_build_object(
        'reason', 'payment_overdue',
        'paidUntil', new.paid_until,
        'automatic', true
      )
    );
  elsif new.status = 'active'
    and (new.paid_until is null or new.paid_until >= current_date)
  then
    new.expiry_notified_at := null;
  end if;

  return new;
end;
$$;

drop trigger if exists platform_accounts_expiration_trigger
  on public.platform_accounts;
create trigger platform_accounts_expiration_trigger
  before update on public.platform_accounts
  for each row execute function public.register_platform_expiration();

create or replace function public.admin_sync_expired_platform_accounts()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  expired_accounts jsonb := '[]'::jsonb;
begin
  if not public.is_platform_admin() then
    raise exception 'Acesso administrativo necessário';
  end if;

  with synchronized as (
    update public.platform_accounts
    set
      expiry_notified_at = now(),
      updated_at = now()
    where status = 'active'
      and paid_until is not null
      and paid_until < current_date
      and expiry_notified_at is null
    returning user_id, display_name, email, paid_until
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'userId', user_id,
        'name', coalesce(nullif(display_name, ''), nullif(email, ''), 'Conta sem nome'),
        'email', email,
        'paidUntil', paid_until
      )
    ),
    '[]'::jsonb
  )
  into expired_accounts
  from synchronized;

  return jsonb_build_object(
    'count', jsonb_array_length(expired_accounts),
    'accounts', expired_accounts
  );
end;
$$;

revoke all on function public.register_platform_expiration() from public;
revoke all on function public.admin_sync_expired_platform_accounts() from public;
grant execute on function public.admin_sync_expired_platform_accounts()
  to anon, authenticated;

commit;
