-- =============================================================================
-- Soft Anestesia — Migração 0010: criar/assumir a própria organização (gestor)
-- =============================================================================
-- Rode DEPOIS da 0001–0009. Idempotente.
--
-- PROBLEMA que esta migração resolve (ovo e galinha):
--   • `organizations` não tem policy de INSERT para usuário comum;
--   • `organization_users` só aceita escrita de quem JÁ é gestor (ou_all).
--   Resultado: uma conta nova nunca conseguia virar gestor pelo app, e a tela
--   "Equipe da nuvem" ficava travada no aviso "entre com a conta de gestor".
--
-- Solução segura: RPC SECURITY DEFINER que o próprio usuário chama, permitida
-- em apenas dois casos:
--   A) o usuário NÃO tem nenhum vínculo ativo  → cria a organização dele e o
--      registra como gestor (é o dono do próprio espaço, como o app já assume);
--   B) o usuário É membro de uma organização que ficou SEM nenhum gestor ativo
--      → assume a gestão dela (recupera organização órfã). Nunca dá acesso a
--      organização de terceiros nem promove quem já tem gestor definido.
-- =============================================================================

begin;
set local check_function_bodies = off;

create or replace function public.criar_minha_organizacao(p_nome text default null)
returns uuid
language plpgsql security definer set search_path = public, app, auth as $fn$
declare
  v_uid   uuid := auth.uid();
  v_email text;
  v_org   uuid;
  v_nome  text;
begin
  if v_uid is null then
    raise exception 'Entre na nuvem antes de criar a sua clínica.';
  end if;

  select email into v_email from auth.users where id = v_uid;
  v_nome := coalesce(nullif(trim(p_nome), ''), 'Clínica de ' || coalesce(split_part(v_email, '@', 1), 'usuário'));

  -- (B) já é membro de alguma organização?
  select ou.organization_id into v_org
    from public.organization_users ou
   where ou.user_id = v_uid and ou.ativo = true
   order by ou.created_at asc
   limit 1;

  if v_org is not null then
    -- só assume se a organização estiver SEM gestor ativo (órfã)
    if exists (select 1 from public.organization_users g
                where g.organization_id = v_org and g.ativo = true and g.role = 'gestor') then
      raise exception 'Esta clínica já tem um gestor. Peça a ele para ajustar o seu papel em Equipe da nuvem.';
    end if;
    insert into public.organization_users(organization_id, user_id, role, ativo)
      values (v_org, v_uid, 'gestor', true)
      on conflict (organization_id, user_id, role) do update set ativo = true;
    update public.organization_users
       set ativo = false
     where organization_id = v_org and user_id = v_uid and role <> 'gestor';
  else
    -- (A) primeira organização desta conta
    insert into public.organizations(nome) values (v_nome) returning id into v_org;
    insert into public.organization_users(organization_id, user_id, role, ativo)
      values (v_org, v_uid, 'gestor', true);
  end if;

  insert into public.profiles(id, nome, email, funcao, ativo)
    values (v_uid, coalesce(split_part(v_email, '@', 1), 'usuário'), v_email, 'gestor', true)
    on conflict (id) do update set ativo = true, funcao = 'gestor',
                                   email = coalesce(excluded.email, public.profiles.email);
  return v_org;
end;
$fn$;

do $$ begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function public.criar_minha_organizacao(text) to authenticated';
  end if;
end $$;

commit;
