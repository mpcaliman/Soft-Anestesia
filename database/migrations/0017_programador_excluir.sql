-- =============================================================================
-- Soft Anestesia — Migração 0017: o programador exclui pelo app, não pelo SQL
-- =============================================================================
-- Rode DEPOIS da 0009. Idempotente.
--
-- POR QUE ISTO EXISTE
-- Criar ambiente e adicionar membro já se faziam pelo módulo Programador.
-- EXCLUIR não: exigia abrir o SQL Editor e escrever um DELETE com o id certo
-- copiado à mão. Um id errado apaga a clínica errada, e o comando não pergunta
-- nada. Operação de rotina feita em console é operação esperando um acidente.
--
-- O QUE ELE PODE, E O QUE NÃO PODE
-- • Excluir um ambiente — mas a função CONTA os registros antes e recusa se
--   houver algum, a menos que quem chama diga explicitamente que sabe. Assim a
--   tela pode mostrar "esta clínica tem 12 fichas e 12 pacientes" ANTES de o
--   dedo chegar no botão.
-- • Remover uma pessoa de um ambiente (o vínculo, não a conta).
-- • Excluir a CONTA de alguém da nuvem — com três travas: não pode ser a
--   própria, não pode ser a de outro programador, e a conta não pode continuar
--   vinculada a ambiente nenhum.
-- =============================================================================

begin;
set local check_function_bodies = off;

-- 1) CONTAGEM POR AMBIENTE — a mesma pergunta que se faria antes de apagar,
--    agora disponível para a tela mostrar.
create or replace function public.prog_contar_ambiente(p_org uuid)
returns jsonb
language plpgsql security definer set search_path = public, app, auth as $fn$
declare v jsonb;
begin
  if not app.eh_programador() then
    raise exception 'Apenas o programador pode usar esta função.';
  end if;
  select jsonb_build_object(
    'fichas',     (select count(*) from public.anesthesia_records      where organization_id = p_org and deleted_at is null),
    'pre',        (select count(*) from public.preanesthetic_assessments where organization_id = p_org and deleted_at is null),
    'consultas',  (select count(*) from public.consultations           where organization_id = p_org and deleted_at is null),
    'srpa',       (select count(*) from public.recovery_records        where organization_id = p_org and deleted_at is null),
    'financeiro', (select count(*) from public.finance_entries         where organization_id = p_org and deleted_at is null),
    'pacientes',  (select count(*) from public.patients                where organization_id = p_org and deleted_at is null),
    'documentos', (select count(*) from public.documents              where organization_id = p_org and deleted_at is null),
    'orcamentos', (select count(*) from public.quotes                 where organization_id = p_org and deleted_at is null),
    'agenda',     (select count(*) from public.appointments           where organization_id = p_org and deleted_at is null),
    'membros',    (select count(*) from public.organization_users     where organization_id = p_org and ativo)
  ) into v;
  return v;
end;
$fn$;

-- 2) EXCLUIR AMBIENTE --------------------------------------------------------
-- `p_confirmo_registros` é obrigatório quando há registros. Não é burocracia:
-- é a diferença entre "apaguei uma clínica vazia que criei por engano" e
-- "apaguei 187 fichas". O cascade da 0001 leva tudo junto.
create or replace function public.prog_excluir_ambiente(p_org uuid, p_confirmo_registros boolean default false)
returns jsonb
language plpgsql security definer set search_path = public, app, auth as $fn$
declare v_cont jsonb; v_nome text; v_total bigint;
begin
  if not app.eh_programador() then
    raise exception 'Apenas o programador pode excluir ambientes.';
  end if;
  select nome into v_nome from public.organizations where id = p_org;
  if v_nome is null then
    raise exception 'Ambiente não encontrado.';
  end if;
  v_cont := public.prog_contar_ambiente(p_org);
  select coalesce(sum(value::bigint), 0) into v_total
    from jsonb_each_text(v_cont - 'membros');
  if v_total > 0 and not coalesce(p_confirmo_registros, false) then
    raise exception 'O ambiente "%" tem % registro(s). Confirme explicitamente para excluir.', v_nome, v_total;
  end if;
  delete from public.organizations where id = p_org;
  return jsonb_build_object('nome', v_nome, 'apagados', v_cont);
end;
$fn$;

-- policy de DELETE para o programador (a 0009 deu só select/insert/update)
drop policy if exists org_prog_del on public.organizations;
create policy org_prog_del on public.organizations
  for delete using (app.eh_programador());

-- 3) REMOVER PESSOA DE UM AMBIENTE (o vínculo, não a conta) -------------------
create or replace function public.prog_remover_membro(p_org uuid, p_user uuid)
returns void
language plpgsql security definer set search_path = public, app, auth as $fn$
begin
  if not app.eh_programador() then
    raise exception 'Apenas o programador pode usar esta função.';
  end if;
  delete from public.organization_users where organization_id = p_org and user_id = p_user;
end;
$fn$;

-- 4) EXCLUIR A CONTA DE ALGUÉM DA NUVEM --------------------------------------
-- Três travas, e cada uma existe por um motivo:
--  • a própria conta não: o programador se trancaria para fora;
--  • conta de outro programador não: ninguém apaga quem administra;
--  • conta ainda vinculada a um ambiente não: primeiro tira de lá, depois
--    apaga — senão some gente de dentro de uma clínica sem o gestor saber.
create or replace function public.prog_excluir_conta(p_user uuid)
returns jsonb
language plpgsql security definer set search_path = public, app, auth as $fn$
declare v_email text; v_vinc int;
begin
  if not app.eh_programador() then
    raise exception 'Apenas o programador pode excluir contas.';
  end if;
  if p_user = auth.uid() then
    raise exception 'Você não pode excluir a sua própria conta por aqui.';
  end if;
  if exists (select 1 from public.app_programmers where user_id = p_user) then
    raise exception 'Esta conta é de um programador e não pode ser excluída por aqui.';
  end if;
  select count(*) into v_vinc from public.organization_users where user_id = p_user;
  if v_vinc > 0 then
    raise exception 'Esta conta ainda pertence a % ambiente(s). Remova-a de lá antes de excluir.', v_vinc;
  end if;
  select email into v_email from auth.users where id = p_user;
  delete from public.profiles where id = p_user;
  delete from auth.users where id = p_user;
  return jsonb_build_object('email', coalesce(v_email, ''), 'ok', true);
end;
$fn$;

-- 5) grants ------------------------------------------------------------------
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function public.prog_contar_ambiente(uuid) to authenticated';
    execute 'grant execute on function public.prog_excluir_ambiente(uuid, boolean) to authenticated';
    execute 'grant execute on function public.prog_remover_membro(uuid, uuid) to authenticated';
    execute 'grant execute on function public.prog_excluir_conta(uuid) to authenticated';
  end if;
end $$;

commit;
