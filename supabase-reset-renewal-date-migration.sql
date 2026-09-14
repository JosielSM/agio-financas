-- Atualiza somente a regra de liberação de acesso. Não altera contas nem datas existentes.
-- Depois desta migração, cada nova liberação substitui a validade anterior e começa hoje.

alter table public.platform_accounts
  add column if not exists expiry_notified_at timestamptz;

create or replace function public.admin_grant_platform_access(
  p_user_id text,
  p_months integer default 1,
  p_monthly_fee numeric default null
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
  if p_months is null or p_months < 1 or p_months > 24 then
    raise exception 'Escolha um período entre 1 e 24 meses';
  end if;
  if p_monthly_fee is not null and p_monthly_fee < 0 then
    raise exception 'A mensalidade não pode ser negativa';
  end if;

  update public.platform_accounts
  set
    status = 'active',
    monthly_fee = coalesce(p_monthly_fee, monthly_fee),
    paid_until = (current_date + make_interval(months => p_months))::date,
    expiry_notified_at = null,
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
    'grant',
    'Acesso liberado até ' || to_char(updated_row.paid_until, 'DD/MM/YYYY'),
    jsonb_build_object(
      'months', p_months,
      'monthlyFee', updated_row.monthly_fee,
      'startsAt', current_date,
      'replacedPreviousExpiration', true
    )
  );

  return to_jsonb(updated_row);
end;
$$;

revoke all on function public.admin_grant_platform_access(text, integer, numeric) from public;
grant execute on function public.admin_grant_platform_access(text, integer, numeric) to anon, authenticated;
