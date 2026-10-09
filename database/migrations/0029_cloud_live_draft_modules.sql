-- =============================================================================
-- Soft Anestesia — 0029: rascunhos cloud-only dos formulários adicionais
-- =============================================================================
-- Arquivo revisável, sem aplicação remota. A fronteira organização/usuário e
-- as permissões de edição continuam no servidor. `live:` identifica somente
-- a prateleira do formulário aberto; não é um novo papel nem dá acesso extra.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

alter table public.drafts drop constraint if exists drafts_module_check;
alter table public.drafts add constraint drafts_module_check check (module in (
  'pre','consulta','anestesia','recuperacao',
  'live:termo','live:prescricao','live:risco','live:documentos',
  'live:orcamento','live:financeiro','live:agenda'
));

create or replace function app.draft_permission_module(p_module text)
returns text language sql immutable security invoker
set search_path = pg_catalog
as $fn$
  select case p_module
    when 'pre' then 'pre' when 'consulta' then 'consulta'
    when 'anestesia' then 'anestesia' when 'recuperacao' then 'recuperacao'
    when 'live:termo' then 'termo' when 'live:prescricao' then 'prescricao'
    when 'live:risco' then 'risco' when 'live:documentos' then 'documentos'
    when 'live:orcamento' then 'orcamento' when 'live:financeiro' then 'financeiro'
    when 'live:agenda' then 'agenda'
    else null
  end
$fn$;
revoke all on function app.draft_permission_module(text) from public,anon;
grant execute on function app.draft_permission_module(text) to authenticated;

drop policy if exists drafts_sel on public.drafts;
create policy drafts_sel on public.drafts for select to authenticated using (
  organization_id in (select app.org_ids()) and user_id = (select auth.uid())
  and app.pode_modulo(organization_id,app.draft_permission_module(module))
);
drop policy if exists drafts_ins on public.drafts;
create policy drafts_ins on public.drafts for insert to authenticated with check (
  organization_id in (select app.org_ids()) and user_id = (select auth.uid())
  and app.pode_editar_modulo(organization_id,app.draft_permission_module(module))
);
drop policy if exists drafts_upd on public.drafts;
create policy drafts_upd on public.drafts for update to authenticated using (
  organization_id in (select app.org_ids()) and user_id = (select auth.uid())
  and app.pode_editar_modulo(organization_id,app.draft_permission_module(module))
) with check (
  organization_id in (select app.org_ids()) and user_id = (select auth.uid())
  and app.pode_editar_modulo(organization_id,app.draft_permission_module(module))
);
drop policy if exists drafts_del on public.drafts;
create policy drafts_del on public.drafts for delete to authenticated using (
  organization_id in (select app.org_ids()) and user_id = (select auth.uid())
  and app.pode_editar_modulo(organization_id,app.draft_permission_module(module))
);

-- Conflitos dos formulários adicionais precisam reter os dois lados na nuvem
-- com o mesmo módulo usado pelo cliente. O envelope `live:` também é aceito
-- explicitamente, sem dar permissão a nomes arbitrários/prefixos inventados.
create or replace function app.sync_conflict_permission_module(p_table text,p_module text)
returns text language sql immutable security invoker
set search_path = pg_catalog, app
as $fn$
  select case
    when p_table = 'drafts' and p_module in (
      'pre','consulta','anestesia','recuperacao','termo','prescricao','risco',
      'documentos','orcamento','financeiro','agenda'
    ) then p_module
    when p_table = 'drafts' then app.draft_permission_module(p_module)
    when p_module = app.module_for_table(p_table) then p_module
    else null
  end
$fn$;
revoke all on function app.sync_conflict_permission_module(text,text) from public,anon;
grant execute on function app.sync_conflict_permission_module(text,text) to authenticated;

-- 0020 criou um CHECK sem nome explícito: localizamos só o CHECK composto
-- de `module` + `table_name`, preservando operação/status/versões e a whitelist
-- de tabelas. Isso funciona também em baseline cujo nome foi reconciliado.
do $block$
declare r record; v_module smallint; v_table smallint;
begin
  select attnum into v_module from pg_attribute
   where attrelid = 'public.sync_conflicts'::regclass and attname = 'module';
  select attnum into v_table from pg_attribute
   where attrelid = 'public.sync_conflicts'::regclass and attname = 'table_name';
  for r in
    select conname from pg_constraint
     where conrelid = 'public.sync_conflicts'::regclass and contype = 'c'
       and conkey @> array[v_module,v_table]::smallint[]
       and cardinality(conkey) = 2
  loop
    execute format('alter table public.sync_conflicts drop constraint %I',r.conname);
  end loop;
end
$block$;
alter table public.sync_conflicts add constraint sync_conflicts_module_table_check
  check (app.sync_conflict_permission_module(table_name,module) is not null);

-- A autorização continua limitada à clínica e ao autor/gestor. O helper só
-- resolve o nome operacional do módulo; não altera fronteiras nem evidências.
drop policy if exists sync_conflicts_sel on public.sync_conflicts;
create policy sync_conflicts_sel on public.sync_conflicts for select to authenticated using (
  organization_id in (select app.org_ids()) and (
    app.has_role(organization_id,array['gestor'])
    or (created_by = (select auth.uid())
        and app.pode_modulo(organization_id,app.sync_conflict_permission_module(table_name,module)))
  )
);
drop policy if exists sync_conflicts_ins on public.sync_conflicts;
create policy sync_conflicts_ins on public.sync_conflicts for insert to authenticated with check (
  organization_id in (select app.org_ids()) and created_by = (select auth.uid()) and (
    app.has_role(organization_id,array['gestor'])
    or app.pode_editar_modulo(organization_id,app.sync_conflict_permission_module(table_name,module))
  )
);
drop policy if exists sync_conflicts_upd on public.sync_conflicts;
create policy sync_conflicts_upd on public.sync_conflicts for update to authenticated using (
  organization_id in (select app.org_ids()) and (
    app.has_role(organization_id,array['gestor'])
    or (created_by = (select auth.uid())
        and app.pode_editar_modulo(organization_id,app.sync_conflict_permission_module(table_name,module)))
  )
) with check (
  organization_id in (select app.org_ids()) and (
    app.has_role(organization_id,array['gestor'])
    or (created_by = (select auth.uid())
        and app.pode_editar_modulo(organization_id,app.sync_conflict_permission_module(table_name,module)))
  )
);
commit;
