-- Adiciona acesso vitalício e gratuito para colaboradores do CredMais.
-- Execute este arquivo uma vez no SQL Editor do Supabase.
begin;

alter table public.platform_accounts
  add column if not exists expiry_notified_at timestamptz;

create or replace function public.admin_grant_platform_lifetime(
  p_user_id text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_id text := auth.jwt()->>'sub';
  updated_row public.platform_accounts%rowtype;
begin
  if not public.is_platform_admin() then
    raise exception 'Acesso administrativo necessário';
  end if;
  if exists (select 1 from public.platform_admins where user_id = p_user_id) then
    raise exception 'A conta proprietária já possui acesso permanente';
  end if;

  update public.platform_accounts
  set
    status = 'active',
    monthly_fee = 0,
    paid_until = null,
    approved_at = now(),
    approved_by = actor_id,
    updated_at = now()
  where user_id = p_user_id
  returning * into updated_row;

  if updated_row.user_id is null then
    raise exception 'Conta não encontrada';
  end if;

  insert into public.platform_access_log (
    user_id, actor_id, action, action_label, details
  ) values (
    p_user_id,
    actor_id,
    'lifetime',
    'Acesso vitalício de colaborador liberado',
    jsonb_build_object('monthlyFee', 0, 'paidUntil', null)
  );

  return to_jsonb(updated_row);
end;
$$;

revoke all on function public.admin_grant_platform_lifetime(text) from public;
grant execute on function public.admin_grant_platform_lifetime(text) to anon, authenticated;

commit;
