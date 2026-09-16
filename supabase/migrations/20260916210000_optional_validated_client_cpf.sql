-- CPF de cliente opcional, com validação real no limite público do banco.
-- Cadastros legados inválidos permanecem legíveis, mas não podem ser criados
-- nem alterados para outro CPF inválido.

begin;

create or replace function private.is_valid_optional_cpf(input_value text)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  cpf text := regexp_replace(coalesce(input_value, ''), '[^0-9]', '', 'g');
  total integer := 0;
  first_digit integer;
  second_digit integer;
  position integer;
begin
  if cpf = '' then
    return true;
  end if;
  if length(cpf) <> 11 or cpf ~ '^(.)\1{10}$' then
    return false;
  end if;

  for position in 1..9 loop
    total := total + substring(cpf from position for 1)::integer * (11 - position);
  end loop;
  first_digit := (total * 10) % 11;
  if first_digit = 10 then first_digit := 0; end if;
  if first_digit <> substring(cpf from 10 for 1)::integer then
    return false;
  end if;

  total := 0;
  for position in 1..10 loop
    total := total + substring(cpf from position for 1)::integer * (12 - position);
  end loop;
  second_digit := (total * 10) % 11;
  if second_digit = 10 then second_digit := 0; end if;
  return second_digit = substring(cpf from 11 for 1)::integer;
end;
$$;

alter function public.sync_my_workspace_v1(jsonb, jsonb, jsonb, jsonb)
  set schema private;
alter function private.sync_my_workspace_v1(jsonb, jsonb, jsonb, jsonb)
  rename to sync_my_workspace_core_v1;

revoke all on function private.sync_my_workspace_core_v1(jsonb, jsonb, jsonb, jsonb)
  from public, anon, authenticated;
revoke all on function private.is_valid_optional_cpf(text)
  from public, anon, authenticated;

create or replace function public.sync_my_workspace_v1(
  p_clients jsonb,
  p_loans jsonb,
  p_history jsonb default '[]'::jsonb,
  p_profile jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  account_id text := private.current_user_id();
begin
  if account_id is null then
    raise exception 'Usuário não autenticado';
  end if;

  if jsonb_typeof(coalesce(p_clients, 'null'::jsonb)) = 'array' and exists (
    select 1
    from jsonb_array_elements(p_clients) item
    left join public.clients existing
      on existing.id::text = item->>'id'
      and existing.owner_id = account_id
    where not private.is_valid_optional_cpf(item->>'cpf')
      and not (
        existing.id is not null
        and existing.cpf is not distinct from coalesce(item->>'cpf', '')
      )
  ) then
    raise exception 'CPF do cliente inválido';
  end if;

  return private.sync_my_workspace_core_v1(
    p_clients,
    p_loans,
    p_history,
    p_profile
  );
end;
$$;

revoke all on function public.sync_my_workspace_v1(jsonb, jsonb, jsonb, jsonb)
  from public, anon, authenticated;
grant execute on function public.sync_my_workspace_v1(jsonb, jsonb, jsonb, jsonb)
  to anon, authenticated;

commit;
