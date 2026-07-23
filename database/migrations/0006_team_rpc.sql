-- =============================================================================
-- Soft Anestesia — Migração 0006: RPC para gestão da equipe (add_member)
-- =============================================================================
-- Rode DEPOIS da 0001–0005. Idempotente.
--
-- O app não consegue descobrir o uid de um usuário pelo e-mail (a tabela
-- auth.users não é exposta). Esta função SECURITY DEFINER resolve isso de
-- forma SEGURA: só o GESTOR da organização pode chamar; ela acha o uid pelo
-- e-mail, vincula a pessoa à organização com o papel escolhido e garante o
-- profile. Papel efetivo é ÚNICO (desativa os demais papéis do usuário).
--
-- As demais operações (mudar papel, ativar/desativar) o app faz direto nas
-- tabelas, pois a policy `ou_all` já permite ao gestor.
-- =============================================================================

begin;
set local check_function_bodies = off;

create or replace function public.add_member(p_org uuid, p_email text, p_role text)
returns uuid
language plpgsql
security definer
set search_path = public, app, auth
as $fn$
declare
  v_uid uuid;
begin
  -- 1) Só o gestor da organização pode adicionar membros
  if not app.has_role(p_org, array['gestor']) then
    raise exception 'Apenas o gestor da organização pode adicionar membros.';
  end if;

  -- 2) Papel válido
  if p_role not in ('gestor','anestesiologista','cirurgiao','auxiliar','financeiro','empresa') then
    raise exception 'Papel inválido: %', p_role;
  end if;

  -- 3) Encontra o usuário pelo e-mail (precisa já ter conta na nuvem)
  select id into v_uid from auth.users where lower(email) = lower(trim(p_email)) limit 1;
  if v_uid is null then
    raise exception 'Nenhuma conta na nuvem com o e-mail %. Peça para a pessoa criar a conta primeiro (Entrar -> Criar conta).', p_email;
  end if;

  -- 4) Vincula com o papel (ativo) e torna esse o papel efetivo (único ativo)
  insert into public.organization_users(organization_id, user_id, role, ativo)
    values (p_org, v_uid, p_role, true)
    on conflict (organization_id, user_id, role) do update set ativo = true;
  update public.organization_users
    set ativo = false
    where organization_id = p_org and user_id = v_uid and role <> p_role;

  -- 5) Garante o profile
  insert into public.profiles(id, nome, email, funcao, ativo)
    values (v_uid,
            coalesce((select raw_user_meta_data->>'name' from auth.users where id = v_uid), split_part(p_email,'@',1)),
            p_email, p_role, true)
    on conflict (id) do update set ativo = true, funcao = p_role, email = excluded.email;

  return v_uid;
end;
$fn$;

do $$ begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function public.add_member(uuid, text, text) to authenticated';
  end if;
end $$;

commit;
