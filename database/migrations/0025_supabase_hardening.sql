-- =============================================================================
-- Soft Anestesia — 0025: hardening do Supabase, RLS e privilégios explícitos
-- =============================================================================
-- Local/G1 somente. Não aplicar em Supabase remoto sem homologação e G3.
--
-- Esta migração:
--   * fecha privilégios implícitos de schemas, tabelas e funções;
--   * torna explícita a matriz de leitura/escrita por módulo e papel;
--   * remove policies antigas que continuavam somando acesso por OR;
--   * mantém compartilhamentos entre clínicas somente quando cadastrados pelo
--     programador em org_shares;
--   * impede trocar organization_id/created_by depois da criação;
--   * fixa search_path de todas as funções próprias;
--   * tira extensões e a materialized view de medicamentos do schema exposto;
--   * preserva os mesmos nomes públicos de RPC usados pelo aplicativo.
-- =============================================================================

begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';
set local check_function_bodies = off;

-- 1) Schemas e extensões ------------------------------------------------------
create schema if not exists extensions;

revoke create on schema public from public;
revoke create on schema public from anon, authenticated;
revoke all on schema app from public, anon, authenticated;
revoke create on schema extensions from public, anon, authenticated;
grant usage on schema app to anon, authenticated, service_role;
grant usage on schema extensions to anon, authenticated, service_role;

-- Extensões não devem criar objetos dentro de `public`, que é exposto pela
-- Data API. Só move extensões relocáveis e já instaladas; a operação será
-- medida primeiro em homologação porque pode tomar locks de catálogo.
do $block$
declare
  r record;
begin
  for r in
    select e.extname, e.extrelocatable, n.nspname
      from pg_extension e
      join pg_namespace n on n.oid = e.extnamespace
     where e.extname in ('pgcrypto', 'unaccent', 'pg_trgm')
  loop
    if r.nspname <> 'extensions' and r.extrelocatable then
      execute format('alter extension %I set schema extensions', r.extname);
    elsif r.nspname <> 'extensions' then
      raise notice 'extensão % não é relocável; revisar manualmente em homologação', r.extname;
    end if;
  end loop;
end
$block$;

-- O helper antigo nomeava explicitamente o dicionário em public. Recriá-lo
-- com o caminho privado mantém generated columns e buscas existentes.
do $block$
begin
  if to_regprocedure('extensions.unaccent(regdictionary,text)') is not null then
    execute $sql$
      create or replace function public.med_unaccent(text)
      returns text
      language sql
      immutable strict parallel safe
      set search_path = pg_catalog, extensions
      as 'select extensions.unaccent(''extensions.unaccent'', $1)'
    $sql$;
  end if;
end
$block$;

-- A materialized view deixa o schema exposto. Uma view comum, security
-- invoker, preserva compatibilidade de leitura/RPC sem expor a matview.
do $block$
begin
  if to_regclass('app.medicamentos_clinicos') is null
     and exists (
       select 1
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public'
          and c.relname = 'medicamentos_clinicos'
          and c.relkind = 'm'
     ) then
    alter materialized view public.medicamentos_clinicos set schema app;
  end if;

  if to_regclass('app.medicamentos_clinicos') is not null then
    execute $sql$
      create or replace view public.medicamentos_clinicos
      with (security_invoker = true)
      as select * from app.medicamentos_clinicos
    $sql$;

    execute $sql$
      create or replace function public.refresh_medicamentos_clinicos()
      returns void
      language plpgsql
      security definer
      set search_path = pg_catalog, app
      as 'begin refresh materialized view app.medicamentos_clinicos; end;'
    $sql$;

    comment on materialized view app.medicamentos_clinicos is
      'Agrupamento clínico privado; atualizar somente pela RPC de service_role.';
    comment on view public.medicamentos_clinicos is
      'Compatibilidade de leitura, security invoker; a materialized view fica fora da Data API.';
  end if;
end
$block$;

-- Funções que resolvem objetos de pgcrypto/pg_trgm em tempo de execução
-- precisam enxergar `extensions` depois da mudança de schema. As assinaturas
-- são explícitas para não alargar o caminho de outras rotinas sem necessidade.
do $block$
begin
  if to_regprocedure('public.ensure_offline_keyring(text)') is not null then
    alter function public.ensure_offline_keyring(text)
      set search_path = pg_catalog, app, auth, extensions;
  end if;
  if to_regprocedure('app.legacy_json_hash(jsonb)') is not null then
    alter function app.legacy_json_hash(jsonb)
      set search_path = pg_catalog, app, extensions, public;
  end if;
  if to_regprocedure('public.prog_list_legacy_documents(uuid,text,text,integer,integer)') is not null then
    alter function public.prog_list_legacy_documents(uuid,text,text,integer,integer)
      set search_path = pg_catalog, app, auth, extensions, public;
  end if;
  if to_regprocedure('public.buscar_medicamentos(text,text,integer,boolean)') is not null then
    alter function public.buscar_medicamentos(text,text,integer,boolean)
      set search_path = pg_catalog, app, extensions, public;
  end if;
end
$block$;

-- 2) A permissão configurada no Ajustes é a fonte única ----------------------
-- O SQL anterior não carregava os módulos `só impressão` dos papéis padrão e
-- podia transformar acesso de leitura em escrita. As duas funções abaixo
-- espelham exatamente ROLE_PERMS do aplicativo e toleram mais de um vínculo
-- ativo sem subconsulta escalar ambígua.
create or replace function app.modulos_do_papel(p_org uuid)
returns text[]
language sql stable security definer
set search_path = pg_catalog, public, app, auth
as $fn$
  select coalesce(array_agg(distinct p.modulo), array[]::text[])
    from public.organization_users ou
    cross join lateral unnest(
      case ou.role
        when 'gestor' then array['dashboard','pacientes','agenda','consulta','pre','termo','prescricao','documentos','risco','anestesia','recuperacao','financeiro','orcamento','doses','ajustes']
        when 'anestesiologista' then array['dashboard','pacientes','agenda','consulta','pre','termo','prescricao','documentos','risco','anestesia','recuperacao','financeiro','orcamento','doses']
        when 'cirurgiao' then array['dashboard','pacientes','agenda','consulta','pre','termo','documentos','risco']
        when 'auxiliar' then array['dashboard','pacientes','agenda','pre','termo','prescricao','documentos','financeiro','orcamento']
        when 'financeiro' then array['dashboard','pacientes','agenda','financeiro','orcamento']
        when 'empresa' then array['dashboard','financeiro','orcamento']
        else array[]::text[]
      end
    ) as p(modulo)
   where ou.user_id = auth.uid()
     and ou.organization_id = p_org
     and ou.ativo
$fn$;

create or replace function app.modulos_editaveis_do_papel(p_org uuid)
returns text[]
language sql stable security definer
set search_path = pg_catalog, public, app, auth
as $fn$
  select coalesce(array_agg(distinct p.modulo), array[]::text[])
    from public.organization_users ou
    cross join lateral unnest(
      case ou.role
        when 'gestor' then array['dashboard','pacientes','agenda','consulta','pre','termo','prescricao','documentos','risco','anestesia','recuperacao','financeiro','orcamento','doses','ajustes']
        when 'anestesiologista' then array['dashboard','pacientes','agenda','consulta','pre','termo','prescricao','documentos','risco','anestesia','recuperacao','financeiro','orcamento','doses']
        when 'cirurgiao' then array['dashboard','pacientes','agenda','termo']
        when 'auxiliar' then array['dashboard','pacientes','agenda','pre','termo','documentos','financeiro','orcamento']
        when 'financeiro' then array['dashboard','financeiro','orcamento']
        when 'empresa' then array['dashboard']
        else array[]::text[]
      end
    ) as p(modulo)
   where ou.user_id = auth.uid()
     and ou.organization_id = p_org
     and ou.ativo
$fn$;

create or replace function app.pode_modulo(p_org uuid, p_modulo text)
returns boolean
language sql stable security definer
set search_path = pg_catalog, public, app, auth
as $fn$
  select case
    when app.tem_config(p_org) then exists (
      select 1
        from public.organization_users ou
       where ou.user_id = auth.uid()
         and ou.organization_id = p_org
         and ou.ativo
         and ou.permissoes -> 'modulos' @> to_jsonb(p_modulo)
    )
    else p_modulo = any(app.modulos_do_papel(p_org))
  end
$fn$;

create or replace function app.pode_editar_modulo(p_org uuid, p_modulo text)
returns boolean
language sql stable security definer
set search_path = pg_catalog, public, app, auth
as $fn$
  select case
    when app.tem_config(p_org) then exists (
      select 1
        from public.organization_users ou
       where ou.user_id = auth.uid()
         and ou.organization_id = p_org
         and ou.ativo
         and ou.permissoes -> 'modulos' @> to_jsonb(p_modulo)
         and not coalesce(ou.permissoes -> 'soImpressao' @> to_jsonb(p_modulo), false)
    )
    else p_modulo = any(app.modulos_editaveis_do_papel(p_org))
  end
$fn$;

-- Uma única decisão para cada linha clínica. Cirurgião só vê o encounter que
-- lhe pertence; gestor vê tudo; anestesiologista respeita equipe/próprios; os
-- demais papéis só entram se o módulo tiver sido concedido.
create or replace function app.pode_ler_registro_modulo(
  p_org uuid,
  p_modulo text,
  p_creator uuid,
  p_encounter uuid
)
returns boolean
language sql stable security definer
set search_path = pg_catalog, public, app, auth
as $fn$
  select app.pode_modulo(p_org, p_modulo)
     and (
       app.has_role(p_org, array['gestor'])
       or (
         app.has_role(p_org, array['anestesiologista'])
         and app.pode_ver_registro(p_org, p_creator)
       )
       or (
         app.has_role(p_org, array['cirurgiao'])
         and p_encounter is not null
         and exists (
           select 1
             from public.encounters e
            where e.id = p_encounter
              and e.organization_id = p_org
              and e.surgeon_id = auth.uid()
         )
       )
       or app.has_role(p_org, array['auxiliar','financeiro','empresa'])
     )
$fn$;

create or replace function app.pode_editar_registro_modulo(
  p_org uuid,
  p_modulo text,
  p_creator uuid,
  p_encounter uuid
)
returns boolean
language sql stable security definer
set search_path = pg_catalog, public, app, auth
as $fn$
  select app.pode_editar_modulo(p_org, p_modulo)
     and (
       app.has_role(p_org, array['gestor'])
       or (
         app.has_role(p_org, array['anestesiologista'])
         and app.pode_ver_registro(p_org, p_creator)
       )
       or (
         app.has_role(p_org, array['cirurgiao'])
         and p_encounter is not null
         and exists (
           select 1
             from public.encounters e
            where e.id = p_encounter
              and e.organization_id = p_org
              and e.surgeon_id = auth.uid()
         )
       )
       or app.has_role(p_org, array['auxiliar','financeiro','empresa'])
     )
$fn$;

-- 3) Identidade e ambiente não mudam depois da criação -----------------------
create or replace function app.stamp_created()
returns trigger
language plpgsql
set search_path = pg_catalog, public, app, auth
as $fn$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is not null then
    new.created_by := v_uid;
    new.updated_by := v_uid;
  end if;
  return new;
end
$fn$;

create or replace function app.guard_organization_scope()
returns trigger
language plpgsql
set search_path = pg_catalog, public, app, auth
as $fn$
declare
  old_row jsonb := to_jsonb(old);
  new_row jsonb := to_jsonb(new);
begin
  if new.organization_id is distinct from old.organization_id then
    raise exception 'O ambiente de um registro não pode ser alterado.'
      using errcode = 'check_violation';
  end if;
  if old_row ? 'created_by'
     and (new_row -> 'created_by') is distinct from (old_row -> 'created_by') then
    raise exception 'A autoria original de um registro não pode ser alterada.'
      using errcode = 'check_violation';
  end if;
  if old_row ? 'user_id'
     and (new_row -> 'user_id') is distinct from (old_row -> 'user_id') then
    raise exception 'O usuário vinculado ao registro não pode ser alterado.'
      using errcode = 'check_violation';
  end if;
  if old_row ? 'role'
     and (new_row -> 'role') is distinct from (old_row -> 'role') then
    raise exception 'O papel de um vínculo não pode ser alterado; desative e recrie o vínculo.'
      using errcode = 'check_violation';
  end if;
  return new;
end
$fn$;

create or replace function app.guard_org_share_scope()
returns trigger
language plpgsql
set search_path = pg_catalog, public, app, auth
as $fn$
begin
  if new.org_origem is distinct from old.org_origem
     or new.org_destino is distinct from old.org_destino then
    raise exception 'A origem e o destino do compartilhamento são imutáveis; remova e recrie.'
      using errcode = 'check_violation';
  end if;
  if new.criado_por is distinct from old.criado_por then
    raise exception 'A autoria do compartilhamento é imutável.'
      using errcode = 'check_violation';
  end if;
  return new;
end
$fn$;

create or replace function app.stamp_org_share()
returns trigger
language plpgsql
set search_path = pg_catalog, auth
as $fn$
begin
  if auth.uid() is not null then new.criado_por := auth.uid(); end if;
  return new;
end
$fn$;

do $block$
declare
  t text;
begin
  foreach t in array array[
    'hospitals','rooms','equipment','organization_users','org_configs',
    'anesthesia_timeline_events','templates','standard_texts',
    'user_preferences','medicamentos_regras_anestesicas'
  ] loop
    if to_regclass(format('public.%I', t)) is null then continue; end if;
    execute format('drop trigger if exists trg_org_scope on public.%I', t);
    execute format(
      'create trigger trg_org_scope before update on public.%I '
      'for each row execute function app.guard_organization_scope()', t
    );
  end loop;
end
$block$;

drop trigger if exists trg_org_share_scope on public.org_shares;
create trigger trg_org_share_scope
  before update on public.org_shares
  for each row execute function app.guard_org_share_scope();
drop trigger if exists trg_org_share_stamp on public.org_shares;
create trigger trg_org_share_stamp
  before insert on public.org_shares
  for each row execute function app.stamp_org_share();

-- 4) Policies consolidadas: uma policy permissiva por papel/comando ----------
-- Organizações.
drop policy if exists org_sel on public.organizations;
drop policy if exists org_prog_sel on public.organizations;
create policy org_sel on public.organizations for select to authenticated
  using (id in (select app.org_ids()) or app.eh_programador());

drop policy if exists org_upd on public.organizations;
drop policy if exists org_prog_upd on public.organizations;
create policy org_upd on public.organizations for update to authenticated
  using (app.has_role(id, array['gestor']) or app.eh_programador())
  with check (app.has_role(id, array['gestor']) or app.eh_programador());

drop policy if exists org_prog_ins on public.organizations;
create policy org_prog_ins on public.organizations for insert to authenticated
  with check (app.eh_programador());
drop policy if exists org_prog_del on public.organizations;
create policy org_prog_del on public.organizations for delete to authenticated
  using (app.eh_programador());

-- Perfis.
drop policy if exists profiles_self_sel on public.profiles;
drop policy if exists prof_prog_sel on public.profiles;
create policy profiles_self_sel on public.profiles for select to authenticated
  using (
    id = (select auth.uid())
    or app.eh_programador()
    or exists (
      select 1
        from public.organization_users gestor
        join public.organization_users alvo
          on alvo.organization_id = gestor.organization_id
       where gestor.user_id = (select auth.uid())
         and gestor.ativo and gestor.role = 'gestor'
         and alvo.user_id = profiles.id and alvo.ativo
    )
  );
drop policy if exists profiles_self_ins on public.profiles;
create policy profiles_self_ins on public.profiles for insert to authenticated
  with check (id = (select auth.uid()) or app.eh_programador());
drop policy if exists profiles_self_upd on public.profiles;
create policy profiles_self_upd on public.profiles for update to authenticated
  using (id = (select auth.uid()) or app.eh_programador())
  with check (id = (select auth.uid()) or app.eh_programador());

-- Vínculos de equipe.
drop policy if exists ou_sel on public.organization_users;
drop policy if exists ou_all on public.organization_users;
drop policy if exists ou_prog_sel on public.organization_users;
drop policy if exists ou_prog_all on public.organization_users;
drop policy if exists ou_ins on public.organization_users;
drop policy if exists ou_upd on public.organization_users;
drop policy if exists ou_del on public.organization_users;
create policy ou_sel on public.organization_users for select to authenticated
  using (
    user_id = (select auth.uid())
    or app.has_role(organization_id, array['gestor'])
    or app.eh_programador()
  );
create policy ou_ins on public.organization_users for insert to authenticated
  with check (app.has_role(organization_id, array['gestor']) or app.eh_programador());
create policy ou_upd on public.organization_users for update to authenticated
  using (app.has_role(organization_id, array['gestor']) or app.eh_programador())
  with check (app.has_role(organization_id, array['gestor']) or app.eh_programador());
create policy ou_del on public.organization_users for delete to authenticated
  using (app.has_role(organization_id, array['gestor']) or app.eh_programador());

-- Compartilhamentos: só o programador escreve; membros das duas clínicas leem.
drop policy if exists shares_sel on public.org_shares;
drop policy if exists shares_prog_all on public.org_shares;
drop policy if exists shares_ins on public.org_shares;
drop policy if exists shares_upd on public.org_shares;
drop policy if exists shares_del on public.org_shares;
create policy shares_sel on public.org_shares for select to authenticated
  using (
    app.eh_programador()
    or org_origem in (select app.org_ids())
    or org_destino in (select app.org_ids())
  );
create policy shares_ins on public.org_shares for insert to authenticated
  with check (app.eh_programador());
create policy shares_upd on public.org_shares for update to authenticated
  using (app.eh_programador()) with check (app.eh_programador());
create policy shares_del on public.org_shares for delete to authenticated
  using (app.eh_programador());

-- Cadastros estruturais da clínica.
do $block$
declare
  t text;
begin
  foreach t in array array['hospitals','rooms','equipment'] loop
    if to_regclass(format('public.%I', t)) is null then continue; end if;
    execute format('drop policy if exists %I_sel on public.%I', t, t);
    execute format('drop policy if exists %I_wr on public.%I', t, t);
    execute format('drop policy if exists %I_ins on public.%I', t, t);
    execute format('drop policy if exists %I_upd on public.%I', t, t);
    execute format('drop policy if exists %I_del on public.%I', t, t);
    execute format(
      'create policy %I_sel on public.%I for select to authenticated '
      'using (organization_id in (select app.org_ids()))', t, t
    );
    execute format(
      'create policy %I_ins on public.%I for insert to authenticated '
      'with check (app.has_role(organization_id, array[''gestor'']))', t, t
    );
    execute format(
      'create policy %I_upd on public.%I for update to authenticated '
      'using (app.has_role(organization_id, array[''gestor''])) '
      'with check (app.has_role(organization_id, array[''gestor'']))', t, t
    );
    execute format(
      'create policy %I_del on public.%I for delete to authenticated '
      'using (app.has_role(organization_id, array[''gestor'']))', t, t
    );
  end loop;
end
$block$;

-- Pacientes: cadastro central da clínica; compartilhamento é leitura explícita.
drop policy if exists patients_sel on public.patients;
drop policy if exists patients_wr on public.patients;
drop policy if exists patients_share_sel on public.patients;
drop policy if exists patients_ins on public.patients;
drop policy if exists patients_upd on public.patients;
drop policy if exists patients_del on public.patients;
create policy patients_sel on public.patients for select to authenticated
  using (
    (organization_id in (select app.org_ids()) and app.pode_modulo(organization_id, 'pacientes'))
    or app.compartilhada_para_mim(organization_id, 'pacientes')
  );
create policy patients_ins on public.patients for insert to authenticated
  with check (
    organization_id in (select app.org_ids())
    and app.pode_editar_modulo(organization_id, 'pacientes')
    and created_by = (select auth.uid())
  );
create policy patients_upd on public.patients for update to authenticated
  using (organization_id in (select app.org_ids()) and app.pode_editar_modulo(organization_id, 'pacientes'))
  with check (organization_id in (select app.org_ids()) and app.pode_editar_modulo(organization_id, 'pacientes'));
create policy patients_del on public.patients for delete to authenticated
  using (organization_id in (select app.org_ids()) and app.pode_editar_modulo(organization_id, 'pacientes'));

-- Encounter é a âncora; cirurgião só lê o caso em que está nomeado.
drop policy if exists enc_sel on public.encounters;
drop policy if exists enc_wr on public.encounters;
drop policy if exists enc_ins on public.encounters;
drop policy if exists enc_upd on public.encounters;
drop policy if exists enc_del on public.encounters;
create policy enc_sel on public.encounters for select to authenticated
  using (
    organization_id in (select app.org_ids())
    and (
      app.pode_modulo(organization_id, 'agenda')
      or app.pode_modulo(organization_id, 'pre')
      or app.pode_modulo(organization_id, 'consulta')
      or app.pode_modulo(organization_id, 'anestesia')
      or app.pode_modulo(organization_id, 'recuperacao')
      or app.pode_modulo(organization_id, 'financeiro')
    )
    and (
      app.has_role(organization_id, array['gestor','anestesiologista','auxiliar','financeiro','empresa'])
      or (app.has_role(organization_id, array['cirurgiao']) and surgeon_id = (select auth.uid()))
    )
  );
create policy enc_ins on public.encounters for insert to authenticated
  with check (
    organization_id in (select app.org_ids())
    and created_by = (select auth.uid())
    and app.has_role(organization_id, array['gestor','anestesiologista','auxiliar','financeiro'])
    and (
      app.pode_editar_modulo(organization_id, 'agenda')
      or app.pode_editar_modulo(organization_id, 'pre')
      or app.pode_editar_modulo(organization_id, 'anestesia')
      or app.pode_editar_modulo(organization_id, 'financeiro')
    )
  );
create policy enc_upd on public.encounters for update to authenticated
  using (
    organization_id in (select app.org_ids())
    and app.has_role(organization_id, array['gestor','anestesiologista','auxiliar','financeiro'])
    and (
      app.pode_editar_modulo(organization_id, 'agenda')
      or app.pode_editar_modulo(organization_id, 'pre')
      or app.pode_editar_modulo(organization_id, 'anestesia')
      or app.pode_editar_modulo(organization_id, 'financeiro')
    )
  )
  with check (
    organization_id in (select app.org_ids())
    and app.has_role(organization_id, array['gestor','anestesiologista','auxiliar','financeiro'])
    and (
      app.pode_editar_modulo(organization_id, 'agenda')
      or app.pode_editar_modulo(organization_id, 'pre')
      or app.pode_editar_modulo(organization_id, 'anestesia')
      or app.pode_editar_modulo(organization_id, 'financeiro')
    )
  );
create policy enc_del on public.encounters for delete to authenticated
  using (
    organization_id in (select app.org_ids())
    and app.has_role(organization_id, array['gestor','anestesiologista'])
    and (
      app.pode_editar_modulo(organization_id, 'agenda')
      or app.pode_editar_modulo(organization_id, 'pre')
      or app.pode_editar_modulo(organization_id, 'anestesia')
    )
  );

-- Registros por módulo. `FOR ALL` é substituído por comandos separados para
-- que a policy de escrita não volte a conceder SELECT por uma segunda porta.
do $block$
declare
  r record;
  policy_name text;
begin
  for r in select * from (values
    ('preanesthetic_assessments', 'pre'),
    ('consultations',             'consulta'),
    ('anesthesia_records',        'anestesia'),
    ('recovery_records',          'recuperacao'),
    ('risk_assessments',          'risco'),
    ('consents',                  'termo'),
    ('prescriptions',             'prescricao'),
    ('documents',                 'documentos'),
    ('finance_entries',           'financeiro'),
    ('quotes',                    'orcamento')
  ) as x(table_name, module_name)
  loop
    if to_regclass(format('public.%I', r.table_name)) is null then continue; end if;
    foreach policy_name in array array[
      r.table_name || '_sel', r.table_name || '_wr',
      r.table_name || '_aux_sel', r.table_name || '_aux_wr',
      r.table_name || '_share_sel', r.table_name || '_ins',
      r.table_name || '_upd', r.table_name || '_del'
    ] loop
      execute format('drop policy if exists %I on public.%I', policy_name, r.table_name);
    end loop;
    -- Alguns módulos históricos usavam nomes curtos.
    if r.table_name = 'finance_entries' then
      execute 'drop policy if exists fin_sel on public.finance_entries';
      execute 'drop policy if exists fin_wr on public.finance_entries';
    end if;

    execute format(
      'create policy %I on public.%I for select to authenticated using ('
      'app.pode_ler_registro_modulo(organization_id, %L, created_by, encounter_id) '
      'or app.compartilhada_para_mim(organization_id, %L))',
      r.table_name || '_sel', r.table_name, r.module_name, r.module_name
    );
    execute format(
      'create policy %I on public.%I for insert to authenticated with check ('
      'organization_id in (select app.org_ids()) '
      'and created_by = (select auth.uid()) '
      'and app.pode_editar_registro_modulo(organization_id, %L, created_by, encounter_id))',
      r.table_name || '_ins', r.table_name, r.module_name
    );
    execute format(
      'create policy %I on public.%I for update to authenticated using ('
      'organization_id in (select app.org_ids()) '
      'and app.pode_editar_registro_modulo(organization_id, %L, created_by, encounter_id)) '
      'with check (organization_id in (select app.org_ids()) '
      'and app.pode_editar_registro_modulo(organization_id, %L, created_by, encounter_id))',
      r.table_name || '_upd', r.table_name, r.module_name, r.module_name
    );
    execute format(
      'create policy %I on public.%I for delete to authenticated using ('
      'organization_id in (select app.org_ids()) '
      'and app.pode_editar_registro_modulo(organization_id, %L, created_by, encounter_id))',
      r.table_name || '_del', r.table_name, r.module_name
    );
  end loop;
end
$block$;

-- Agenda.
drop policy if exists appointments_sel on public.appointments;
drop policy if exists appointments_wr on public.appointments;
drop policy if exists appointments_share_sel on public.appointments;
drop policy if exists appt_sel on public.appointments;
drop policy if exists appt_wr on public.appointments;
drop policy if exists appt_ins on public.appointments;
drop policy if exists appt_upd on public.appointments;
drop policy if exists appt_del on public.appointments;
create policy appt_sel on public.appointments for select to authenticated
  using (
    (organization_id in (select app.org_ids()) and app.pode_modulo(organization_id, 'agenda'))
    or app.compartilhada_para_mim(organization_id, 'agenda')
  );
create policy appt_ins on public.appointments for insert to authenticated
  with check (
    organization_id in (select app.org_ids())
    and app.pode_editar_modulo(organization_id, 'agenda')
    and created_by = (select auth.uid())
  );
create policy appt_upd on public.appointments for update to authenticated
  using (organization_id in (select app.org_ids()) and app.pode_editar_modulo(organization_id, 'agenda'))
  with check (organization_id in (select app.org_ids()) and app.pode_editar_modulo(organization_id, 'agenda'));
create policy appt_del on public.appointments for delete to authenticated
  using (organization_id in (select app.org_ids()) and app.pode_editar_modulo(organization_id, 'agenda'));

-- Linha do tempo da anestesia.
drop policy if exists tl_sel on public.anesthesia_timeline_events;
drop policy if exists tl_wr on public.anesthesia_timeline_events;
drop policy if exists tl_ins on public.anesthesia_timeline_events;
drop policy if exists tl_upd on public.anesthesia_timeline_events;
drop policy if exists tl_del on public.anesthesia_timeline_events;
create policy tl_sel on public.anesthesia_timeline_events for select to authenticated
  using (
    app.pode_ler_registro_modulo(organization_id, 'anestesia', created_by, encounter_id)
    or app.compartilhada_para_mim(organization_id, 'anestesia')
  );
create policy tl_ins on public.anesthesia_timeline_events for insert to authenticated
  with check (
    organization_id in (select app.org_ids())
    and created_by = (select auth.uid())
    and app.pode_editar_registro_modulo(organization_id, 'anestesia', created_by, encounter_id)
  );
create policy tl_upd on public.anesthesia_timeline_events for update to authenticated
  using (
    organization_id in (select app.org_ids())
    and app.pode_editar_registro_modulo(organization_id, 'anestesia', created_by, encounter_id)
  )
  with check (
    organization_id in (select app.org_ids())
    and app.pode_editar_registro_modulo(organization_id, 'anestesia', created_by, encounter_id)
  );
create policy tl_del on public.anesthesia_timeline_events for delete to authenticated
  using (
    organization_id in (select app.org_ids())
    and app.pode_editar_registro_modulo(organization_id, 'anestesia', created_by, encounter_id)
  );

-- Configurações compartilhadas da clínica.
drop policy if exists oc_sel on public.org_configs;
drop policy if exists oc_wr on public.org_configs;
drop policy if exists oc_ins on public.org_configs;
drop policy if exists oc_upd on public.org_configs;
drop policy if exists oc_del on public.org_configs;
create policy oc_sel on public.org_configs for select to authenticated
  using (organization_id in (select app.org_ids()));
create policy oc_ins on public.org_configs for insert to authenticated
  with check (organization_id in (select app.org_ids()));
create policy oc_upd on public.org_configs for update to authenticated
  using (organization_id in (select app.org_ids()))
  with check (organization_id in (select app.org_ids()));
create policy oc_del on public.org_configs for delete to authenticated
  using (organization_id in (select app.org_ids()));

-- Modelos/textos: separa SELECT de escrita e otimiza auth.uid().
do $block$
declare
  t text;
begin
  foreach t in array array['templates','standard_texts'] loop
    if to_regclass(format('public.%I', t)) is null then continue; end if;
    execute format('drop policy if exists %I_sel on public.%I', t, t);
    execute format('drop policy if exists %I_wr on public.%I', t, t);
    execute format('drop policy if exists %I_ins on public.%I', t, t);
    execute format('drop policy if exists %I_upd on public.%I', t, t);
    execute format('drop policy if exists %I_del on public.%I', t, t);
    execute format(
      'create policy %I_sel on public.%I for select to authenticated using ('
      'organization_id in (select app.org_ids()) and ('
      'owner_id is null or owner_id = (select auth.uid()) '
      'or coalesce((to_jsonb(%I.*)->>''compartilhado'')::boolean, false)))', t, t, t
    );
    execute format(
      'create policy %I_ins on public.%I for insert to authenticated with check ('
      'organization_id in (select app.org_ids()) and ('
      'owner_id = (select auth.uid()) or owner_id is null '
      'or app.has_role(organization_id, array[''gestor''])))', t, t
    );
    execute format(
      'create policy %I_upd on public.%I for update to authenticated using ('
      'organization_id in (select app.org_ids()) and ('
      'owner_id = (select auth.uid()) or app.has_role(organization_id, array[''gestor'']))) '
      'with check (organization_id in (select app.org_ids()) and ('
      'owner_id = (select auth.uid()) or owner_id is null '
      'or app.has_role(organization_id, array[''gestor''])))', t, t
    );
    execute format(
      'create policy %I_del on public.%I for delete to authenticated using ('
      'organization_id in (select app.org_ids()) and ('
      'owner_id = (select auth.uid()) or app.has_role(organization_id, array[''gestor''])))', t, t
    );
  end loop;
end
$block$;

-- Policies menores ainda apontavam auth.uid() diretamente por linha.
drop policy if exists prog_self_sel on public.app_programmers;
create policy prog_self_sel on public.app_programmers for select to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists audit_sel on public.audit_logs;
create policy audit_sel on public.audit_logs for select to authenticated
  using (user_id = (select auth.uid()) or app.has_role(organization_id, array['gestor']));

drop policy if exists user_preferences_sel on public.user_preferences;
drop policy if exists user_preferences_ins on public.user_preferences;
drop policy if exists user_preferences_upd on public.user_preferences;
create policy user_preferences_sel on public.user_preferences for select to authenticated
  using (organization_id in (select app.org_ids()) and user_id = (select auth.uid()));
create policy user_preferences_ins on public.user_preferences for insert to authenticated
  with check (organization_id in (select app.org_ids()) and user_id = (select auth.uid()));
create policy user_preferences_upd on public.user_preferences for update to authenticated
  using (organization_id in (select app.org_ids()) and user_id = (select auth.uid()))
  with check (organization_id in (select app.org_ids()) and user_id = (select auth.uid()));

drop policy if exists legacy_access_logs_prog_ins on public.legacy_access_logs;
create policy legacy_access_logs_prog_ins on public.legacy_access_logs for insert to authenticated
  with check (app.eh_programador() and programmer_id = (select auth.uid()));

drop policy if exists medregras_sel on public.medicamentos_regras_anestesicas;
create policy medregras_sel on public.medicamentos_regras_anestesicas for select to authenticated
  using (
    ativo and (
      organization_id is null
      or exists (
        select 1 from public.organization_users ou
         where ou.user_id = (select auth.uid())
           and ou.organization_id = medicamentos_regras_anestesicas.organization_id
           and ou.ativo
      )
    )
  );
drop policy if exists medregras_ins on public.medicamentos_regras_anestesicas;
create policy medregras_ins on public.medicamentos_regras_anestesicas for insert to authenticated
  with check (
    organization_id is not null
    and app.has_role(organization_id, array['gestor','anestesiologista'])
  );
drop policy if exists medregras_upd on public.medicamentos_regras_anestesicas;
create policy medregras_upd on public.medicamentos_regras_anestesicas for update to authenticated
  using (
    organization_id is not null
    and app.has_role(organization_id, array['gestor','anestesiologista'])
  )
  with check (
    organization_id is not null
    and app.has_role(organization_id, array['gestor','anestesiologista'])
  );

-- 5) Privilégios: tudo fechado por padrão e somente o necessário reaberto ----
alter default privileges in schema public revoke all on tables from public, anon, authenticated;
alter default privileges in schema public revoke execute on functions from public, anon, authenticated;
alter default privileges in schema app revoke all on tables from public, anon, authenticated;
alter default privileges in schema app revoke execute on functions from public, anon, authenticated;

revoke all on all tables in schema public from public, anon, authenticated;
revoke all on all tables in schema app from public, anon, authenticated;
revoke execute on all functions in schema public from public, anon, authenticated;
revoke execute on all functions in schema app from public, anon, authenticated;

-- Tabelas usuais protegidas por RLS.
do $block$
declare
  t text;
begin
  foreach t in array array[
    'hospitals','rooms','equipment','organization_users','org_shares',
    'patients','encounters','preanesthetic_assessments','consultations',
    'anesthesia_records','recovery_records','risk_assessments','consents',
    'prescriptions','documents','finance_entries','quotes','appointments',
    'anesthesia_timeline_events','templates','standard_texts','org_configs'
  ] loop
    if to_regclass(format('public.%I', t)) is not null then
      execute format('grant select, insert, update, delete on table public.%I to authenticated', t);
    end if;
  end loop;

  foreach t in array array['organizations','profiles'] loop
    if to_regclass(format('public.%I', t)) is not null then
      execute format('grant select, insert, update on table public.%I to authenticated', t);
    end if;
  end loop;

  foreach t in array array[
    'audit_logs','app_programmers','legacy_access_logs',
    'legacy_migration_runs','legacy_document_registry',
    'legacy_migration_targets','legacy_migration_events'
  ] loop
    if to_regclass(format('public.%I', t)) is not null then
      execute format('grant select on table public.%I to authenticated', t);
    end if;
  end loop;
end
$block$;

grant select, insert on table public.addenda to authenticated;
grant select, insert on table public.attachments to authenticated;
grant select, insert, update on table public.sync_conflicts to authenticated;
grant select, insert, update, delete on table public.drafts to authenticated;
grant select, insert, update on table public.user_preferences to authenticated;

grant select on table public.cbhpm_codigos to authenticated;
grant select on table public.medicamentos to anon, authenticated;
grant select on table public.medicamentos_base_versao to authenticated;
grant select, insert, update on table public.medicamentos_regras_anestesicas to authenticated;

do $block$
begin
  if to_regclass('app.medicamentos_clinicos') is not null then
    grant select on table app.medicamentos_clinicos to anon, authenticated;
    grant select on table public.medicamentos_clinicos to anon, authenticated;
  end if;
end
$block$;

-- Funções internas usadas por RLS; o schema app não é exposto pela Data API.
do $block$
declare
  signature text;
begin
  foreach signature in array array[
    'app.org_ids()',
    'app.has_role(uuid,text[])',
    'app.can_read_clinical(uuid,uuid)',
    'app.can_write_clinical(uuid)',
    'app.visibilidade_registros(uuid)',
    'app.pode_ver_registro(uuid,uuid)',
    'app.eh_programador()',
    'app.compartilhada_para_mim(uuid,text)',
    'app.tem_config(uuid)',
    'app.modulos_do_papel(uuid)',
    'app.modulos_editaveis_do_papel(uuid)',
    'app.pode_modulo(uuid,text)',
    'app.pode_editar_modulo(uuid,text)',
    'app.pode_ler_registro_modulo(uuid,text,uuid,uuid)',
    'app.pode_editar_registro_modulo(uuid,text,uuid,uuid)',
    'app.module_for_table(text)',
    'app.can_access_addendum_parent(uuid,text,uuid)',
    'app.attachment_path_org(text)',
    'app.attachment_path_owned(text,uuid,uuid)'
  ] loop
    if to_regprocedure(signature) is not null then
      execute format('grant execute on function %s to authenticated', to_regprocedure(signature));
    end if;
  end loop;
end
$block$;

-- RPCs públicas indispensáveis ao cliente, todas com verificação interna.
do $block$
declare
  signature text;
begin
  foreach signature in array array[
    'public.add_member(uuid,text,text)',
    'public.prog_criar_ambiente(text,text)',
    'public.prog_add_member(uuid,text,text)',
    'public.criar_minha_organizacao(text)',
    'public.prog_contar_ambiente(uuid)',
    'public.prog_excluir_ambiente(uuid,boolean)',
    'public.prog_remover_membro(uuid,uuid)',
    'public.prog_excluir_conta(uuid)',
    'public.ensure_offline_keyring(text)',
    'public.prog_inventory_legacy_documents()',
    'public.prog_legacy_migration_summary()',
    'public.prog_list_legacy_documents(uuid,text,text,integer,integer)',
    'public.prog_classify_legacy_documents(uuid[],uuid,text)',
    'public.prog_copy_legacy_documents(uuid[],integer)',
    'public.prog_validate_legacy_documents(uuid[])',
    'public.prog_rollback_legacy_documents(uuid[],text)',
    'public.prog_ack_legacy_source_change(uuid,text)'
  ] loop
    if to_regprocedure(signature) is not null then
      execute format('grant execute on function %s to authenticated', to_regprocedure(signature));
    end if;
  end loop;
end
$block$;

-- Busca pública de medicamentos é somente leitura.
do $block$
declare
  signature text;
begin
  foreach signature in array array[
    'public.med_unaccent(text)',
    'public.med_normalizar(text)',
    'public.buscar_medicamentos(text,text,integer,boolean)',
    'public.apresentacoes_do_principio(text,text,integer)'
  ] loop
    if to_regprocedure(signature) is not null then
      execute format('grant execute on function %s to anon, authenticated', to_regprocedure(signature));
    end if;
  end loop;

  if to_regprocedure('public.refresh_medicamentos_clinicos()') is not null
     and exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.refresh_medicamentos_clinicos() to service_role;
  end if;
end
$block$;

-- Toda função própria sem configuração recebe search_path explícito. Funções
-- que já declararam um caminho mais estreito mantêm sua configuração. `public`
-- fica depois dos schemas controlados e não aceita CREATE não confiável.
do $block$
declare
  r record;
begin
  for r in
    select n.nspname, p.proname, pg_get_function_identity_arguments(p.oid) as args
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname in ('public', 'app')
       and p.prokind = 'f'
       and not exists (
         select 1 from pg_depend d
          where d.classid = 'pg_proc'::regclass
            and d.objid = p.oid
            and d.deptype = 'e'
       )
       and not exists (
         select 1
           from unnest(coalesce(p.proconfig, array[]::text[])) as config(setting)
          where setting like 'search_path=%'
       )
  loop
    execute format(
      'alter function %I.%I(%s) set search_path = pg_catalog, app, auth, extensions, storage, public',
      r.nspname, r.proname, r.args
    );
  end loop;
end
$block$;

-- Reafirma RLS/force RLS nas tabelas multi-tenant mutáveis.
do $block$
declare
  t text;
begin
  foreach t in array array[
    'organization_users','org_shares','hospitals','rooms','equipment','patients',
    'encounters','preanesthetic_assessments','consultations','anesthesia_records',
    'recovery_records','risk_assessments','consents','prescriptions','documents',
    'finance_entries','quotes','appointments','anesthesia_timeline_events',
    'addenda','attachments','templates','standard_texts','org_configs',
    'sync_conflicts','drafts','user_preferences','medicamentos_regras_anestesicas'
  ] loop
    if to_regclass(format('public.%I', t)) is null then continue; end if;
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
  end loop;
end
$block$;

commit;
