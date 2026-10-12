-- =============================================================================
-- Soft Anestesia — Migração 0020: conflitos preservados + imutabilidade real
-- =============================================================================
-- Regras de Ouro atendidas:
--   * conflitos nunca são descartados: os dois lados ficam retidos na nuvem;
--   * prontuário finalizado é imutável; correção é sempre um novo adendo;
--   * adendos são append-only, com autor e horário definidos pelo servidor;
--   * rascunhos usam revisão atômica, sem "último a salvar vence";
--   * todas as linhas continuam isoladas por organização e publicadas no
--     Supabase Realtime.
--
-- Rode DEPOIS da 0019. A migração é aditiva e não apaga dados existentes.
-- =============================================================================

begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';
set local check_function_bodies = off;

-- 1) Mapeamento único tabela -> módulo ----------------------------------------
create or replace function app.module_for_table(p_table text)
returns text
language sql
immutable
set search_path = pg_catalog, public, app
as $fn$
  select case p_table
    when 'patients'                     then 'pacientes'
    when 'appointments'                 then 'agenda'
    when 'preanesthetic_assessments'    then 'pre'
    when 'consultations'                then 'consulta'
    when 'anesthesia_records'           then 'anestesia'
    when 'recovery_records'             then 'recuperacao'
    when 'risk_assessments'             then 'risco'
    when 'consents'                     then 'termo'
    when 'prescriptions'                then 'prescricao'
    when 'documents'                    then 'documentos'
    when 'finance_entries'              then 'financeiro'
    when 'quotes'                       then 'orcamento'
    when 'drafts'                       then 'rascunhos'
    else null
  end
$fn$;

-- Consulta o pai com os privilégios/RLS do próprio usuário. Assim um adendo
-- nunca vira uma porta lateral para enxergar um prontuário que a pessoa não
-- poderia abrir na tabela clínica original.
create or replace function app.can_access_addendum_parent(
  p_org uuid,
  p_table text,
  p_parent uuid
)
returns boolean
language plpgsql
stable
security invoker
set search_path = pg_catalog, public, app, auth
as $fn$
declare
  permitido boolean := false;
begin
  if app.module_for_table(p_table) is null or p_table in ('patients','appointments','drafts') then
    return false;
  end if;

  execute format(
    'select exists (select 1 from public.%I where id = $1 and organization_id = $2)',
    p_table
  ) into permitido using p_parent, p_org;
  return coalesce(permitido, false);
end
$fn$;

-- 2) Conflitos: preserva proposta e versão canônica indefinidamente ----------
create table if not exists public.sync_conflicts (
  id                  uuid primary key default gen_random_uuid(),
  organization_id     uuid not null references public.organizations(id) on delete cascade,
  client_conflict_id  text not null,
  module              text not null,
  table_name          text not null,
  record_legacy_id    text not null,
  operation           text not null default 'upsert',
  base_version        integer,
  server_version      integer,
  proposed_data       jsonb not null,
  canonical_data      jsonb not null,
  metadata            jsonb not null default '{}'::jsonb,
  status              text not null default 'pending',
  resolution          jsonb,
  created_by          uuid not null references auth.users(id),
  resolved_by         uuid references auth.users(id),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  resolved_at         timestamptz,
  unique (organization_id, client_conflict_id),
  check (operation in ('upsert','delete','draft_upsert','draft_delete')),
  check (status in ('pending','resolved_local','resolved_remote','resolved_merged')),
  check (base_version is null or base_version > 0),
  check (server_version is null or server_version > 0),
  check (app.module_for_table(table_name) is not null),
  check (
    (table_name = 'drafts' and module in ('pre','consulta','anestesia','recuperacao'))
    or (table_name <> 'drafts' and module = app.module_for_table(table_name))
  )
);

create index if not exists sync_conflicts_org_pending_idx
  on public.sync_conflicts(organization_id, status, created_at desc);
create index if not exists sync_conflicts_record_idx
  on public.sync_conflicts(organization_id, table_name, record_legacy_id, created_at desc);
create index if not exists sync_conflicts_creator_idx
  on public.sync_conflicts(created_by, status, created_at desc);

create or replace function app.stamp_sync_conflict()
returns trigger
language plpgsql
set search_path = pg_catalog, public, app, auth
as $fn$
begin
  new.created_by := auth.uid();
  new.created_at := now();
  new.updated_at := new.created_at;
  new.status := 'pending';
  new.resolution := null;
  new.resolved_by := null;
  new.resolved_at := null;
  return new;
end
$fn$;

create or replace function app.guard_sync_conflict_update()
returns trigger
language plpgsql
set search_path = pg_catalog, public, app, auth
as $fn$
begin
  if new.organization_id is distinct from old.organization_id
     or new.client_conflict_id is distinct from old.client_conflict_id
     or new.module is distinct from old.module
     or new.table_name is distinct from old.table_name
     or new.record_legacy_id is distinct from old.record_legacy_id
     or new.operation is distinct from old.operation
     or new.base_version is distinct from old.base_version
     or new.server_version is distinct from old.server_version
     or new.proposed_data is distinct from old.proposed_data
     or new.canonical_data is distinct from old.canonical_data
     or new.metadata is distinct from old.metadata
     or new.created_by is distinct from old.created_by
     or new.created_at is distinct from old.created_at then
    raise exception 'As evidências de um conflito são imutáveis.'
      using errcode = 'check_violation';
  end if;

  if old.status <> 'pending' then
    raise exception 'Este conflito já foi resolvido.'
      using errcode = 'check_violation';
  end if;
  if new.status = 'pending' then
    raise exception 'A atualização deve registrar uma resolução.'
      using errcode = 'check_violation';
  end if;

  new.resolved_by := auth.uid();
  new.resolved_at := now();
  new.updated_at := new.resolved_at;
  return new;
end
$fn$;

drop trigger if exists trg_sync_conflicts_stamp on public.sync_conflicts;
create trigger trg_sync_conflicts_stamp
  before insert on public.sync_conflicts
  for each row execute function app.stamp_sync_conflict();

drop trigger if exists trg_sync_conflicts_guard on public.sync_conflicts;
create trigger trg_sync_conflicts_guard
  before update on public.sync_conflicts
  for each row execute function app.guard_sync_conflict_update();

alter table public.sync_conflicts enable row level security;
alter table public.sync_conflicts force row level security;

drop policy if exists sync_conflicts_sel on public.sync_conflicts;
create policy sync_conflicts_sel on public.sync_conflicts for select
  to authenticated
  using (
    organization_id in (select app.org_ids())
    and (
      app.has_role(organization_id, array['gestor'])
      or (created_by = (select auth.uid()) and app.pode_modulo(organization_id, module))
    )
  );

drop policy if exists sync_conflicts_ins on public.sync_conflicts;
create policy sync_conflicts_ins on public.sync_conflicts for insert
  to authenticated
  with check (
    organization_id in (select app.org_ids())
    and created_by = (select auth.uid())
    and (
      app.has_role(organization_id, array['gestor'])
      or app.pode_editar_modulo(organization_id, module)
    )
  );

drop policy if exists sync_conflicts_upd on public.sync_conflicts;
create policy sync_conflicts_upd on public.sync_conflicts for update
  to authenticated
  using (
    organization_id in (select app.org_ids())
    and (
      app.has_role(organization_id, array['gestor'])
      or (created_by = (select auth.uid()) and app.pode_editar_modulo(organization_id, module))
    )
  )
  with check (
    organization_id in (select app.org_ids())
    and (
      app.has_role(organization_id, array['gestor'])
      or (created_by = (select auth.uid()) and app.pode_editar_modulo(organization_id, module))
    )
  );

revoke all on table public.sync_conflicts from public, anon;
revoke delete on table public.sync_conflicts from authenticated;
grant select, insert, update on table public.sync_conflicts to authenticated;

-- 3) Adendos: pai finalizado, identidade derivada e escrita somente por INSERT
alter table public.addenda add column if not exists reason text;
alter table public.addenda add column if not exists author_id uuid references auth.users(id);
alter table public.addenda add column if not exists parent_legacy_id text;

-- Numa reaplicação, libera apenas o backfill desta transação; o guard é
-- recriado antes do commit.
drop trigger if exists trg_addenda_append_only on public.addenda;

update public.addenda
   set reason = coalesce(nullif(btrim(reason), ''), 'historical_addendum'),
       author_id = coalesce(author_id, created_by),
       legacy_id = coalesce(nullif(btrim(legacy_id), ''), id::text)
 where reason is null
    or btrim(reason) = ''
    or legacy_id is null
    or btrim(legacy_id) = ''
    or (author_id is null and created_by is not null);

alter table public.addenda alter column reason set default 'correcao';
alter table public.addenda alter column reason set not null;
alter table public.addenda alter column legacy_id set not null;

create index if not exists addenda_org_parent_legacy_idx
  on public.addenda(organization_id, parent_table, parent_legacy_id, created_at);

-- Completa a chave do pai em adendos históricos. O allowlist impede SQL
-- dinâmico arbitrário e mantém a atualização curta por tabela.
do $block$
declare
  t text;
begin
  foreach t in array array[
    'preanesthetic_assessments','consultations','anesthesia_records',
    'recovery_records','risk_assessments','consents','prescriptions','documents'
  ] loop
    execute format(
      'update public.addenda a set parent_legacy_id = p.legacy_id '
      'from public.%I p where a.parent_table = %L and a.parent_id = p.id '
      'and a.organization_id = p.organization_id and a.parent_legacy_id is null',
      t, t
    );
  end loop;
end
$block$;

create or replace function app.stamp_and_validate_addendum()
returns trigger
language plpgsql
set search_path = pg_catalog, public, app, auth
as $fn$
declare
  parent_org uuid;
  parent_encounter uuid;
  parent_patient uuid;
  parent_finalized timestamptz;
  parent_legacy text;
begin
  if app.module_for_table(new.parent_table) is null
     or new.parent_table in ('patients','appointments','drafts','finance_entries','quotes') then
    raise exception 'Tabela pai inválida para adendo.'
      using errcode = 'check_violation';
  end if;

  execute format(
    'select organization_id, encounter_id, patient_id, finalized_at, legacy_id '
    'from public.%I where id = $1',
    new.parent_table
  ) into parent_org, parent_encounter, parent_patient, parent_finalized, parent_legacy
    using new.parent_id;

  if parent_org is null then
    raise exception 'Registro pai do adendo não encontrado.'
      using errcode = 'foreign_key_violation';
  end if;
  if new.organization_id is distinct from parent_org then
    raise exception 'Adendo e registro pai devem pertencer ao mesmo ambiente.'
      using errcode = 'check_violation';
  end if;
  if parent_finalized is null then
    raise exception 'Adendos só podem corrigir registros finalizados.'
      using errcode = 'check_violation';
  end if;

  new.encounter_id := parent_encounter;
  new.patient_id := parent_patient;
  new.parent_legacy_id := parent_legacy;
  new.created_by := auth.uid();
  new.author_id := auth.uid();
  new.created_at := now();
  new.reason := coalesce(nullif(btrim(new.reason), ''), 'correcao');
  new.legacy_id := coalesce(nullif(btrim(new.legacy_id), ''), new.id::text);
  return new;
end
$fn$;

create or replace function app.guard_append_only()
returns trigger
language plpgsql
set search_path = pg_catalog, public, app, auth
as $fn$
begin
  raise exception 'Adendos são permanentes e não podem ser alterados ou excluídos.'
    using errcode = 'check_violation';
end
$fn$;

drop trigger if exists trg_addenda_stamp on public.addenda;
create trigger trg_addenda_stamp
  before insert on public.addenda
  for each row execute function app.stamp_and_validate_addendum();

drop trigger if exists trg_addenda_append_only on public.addenda;
create trigger trg_addenda_append_only
  before update or delete on public.addenda
  for each row execute function app.guard_append_only();

drop trigger if exists trg_addenda_audit on public.addenda;
create trigger trg_addenda_audit
  after insert on public.addenda
  for each row execute function app.audit_row();

alter table public.addenda enable row level security;
alter table public.addenda force row level security;

drop policy if exists addenda_wr on public.addenda;
drop policy if exists addenda_sel on public.addenda;
drop policy if exists addenda_ins on public.addenda;

create policy addenda_sel on public.addenda for select
  to authenticated
  using (
    organization_id in (select app.org_ids())
    and (
      app.has_role(organization_id, array['gestor'])
      or app.pode_modulo(organization_id, app.module_for_table(parent_table))
    )
    and app.can_access_addendum_parent(organization_id, parent_table, parent_id)
  );

create policy addenda_ins on public.addenda for insert
  to authenticated
  with check (
    organization_id in (select app.org_ids())
    and created_by = (select auth.uid())
    and (
      app.has_role(organization_id, array['gestor'])
      or app.pode_editar_modulo(organization_id, app.module_for_table(parent_table))
    )
    and app.can_access_addendum_parent(organization_id, parent_table, parent_id)
  );

revoke all on table public.addenda from public, anon;
revoke update, delete on table public.addenda from authenticated;
grant select, insert on table public.addenda to authenticated;

-- 4) Finalização canônica + imutabilidade integral ---------------------------
create or replace function app.try_timestamptz(p_value text)
returns timestamptz
language plpgsql
stable
set search_path = pg_catalog
as $fn$
begin
  if nullif(btrim(p_value), '') is null then return null; end if;
  return p_value::timestamptz;
exception when others then
  return null;
end
$fn$;

-- Versões antigas carimbavam a finalização apenas dentro de data. Converte o
-- carimbo antes de apertar o guard, preservando a data quando ela for válida.
do $block$
declare
  t text;
begin
  foreach t in array array[
    'preanesthetic_assessments','consultations','anesthesia_records',
    'recovery_records','risk_assessments','consents','prescriptions','documents'
  ] loop
    execute format(
      'update public.%I set status = %L, '
      'finalized_at = coalesce(app.try_timestamptz(data->>%L), updated_at, created_at, now()), '
      'finalized_by = coalesce(finalized_by, updated_by, created_by) '
      'where finalized_at is null and lower(coalesce(data->>%L, %L)) = %L',
      t, 'finalized', '_finalizadoEm', '_finalizado', 'false', 'true'
    );
  end loop;
end
$block$;

create or replace function app.guard_finalized()
returns trigger
language plpgsql
set search_path = pg_catalog, public, app, auth
as $fn$
begin
  if old.finalized_at is not null then
    raise exception 'Registro finalizado/assinado é imutável. Use um adendo para correções (record %, tabela %).', old.id, tg_table_name
      using errcode = 'check_violation';
  end if;
  return new;
end
$fn$;

-- O instante e o autor da finalização são fatos do servidor. O cliente pode
-- trabalhar offline e conservar seu horário em `data._finalizadoEm`, mas não
-- pode escolher quem assinou nem retroagir a coluna canônica do banco.
create or replace function app.stamp_finalization()
returns trigger
language plpgsql
set search_path = pg_catalog, public, app, auth
as $fn$
begin
  if tg_op = 'INSERT' then
    if new.finalized_at is not null or lower(coalesce(new.status, '')) = 'finalized' then
      new.finalized_at := now();
      new.finalized_by := auth.uid();
      new.status := 'finalized';
    else
      new.finalized_by := null;
    end if;
    return new;
  end if;

  if old.finalized_at is null then
    if new.finalized_at is not null or lower(coalesce(new.status, '')) = 'finalized' then
      new.finalized_at := now();
      new.finalized_by := auth.uid();
      new.status := 'finalized';
    else
      new.finalized_by := old.finalized_by;
    end if;
  end if;
  return new;
end
$fn$;

do $block$
declare
  t text;
begin
  foreach t in array array[
    'preanesthetic_assessments','consultations','anesthesia_records',
    'recovery_records','risk_assessments','consents','prescriptions','documents'
  ] loop
    execute format('drop trigger if exists trg_finalization_stamp on public.%I', t);
    execute format(
      'create trigger trg_finalization_stamp before insert or update on public.%I '
      'for each row execute function app.stamp_finalization()', t
    );
    execute format('drop trigger if exists trg_guard on public.%I', t);
    execute format(
      'create trigger trg_guard before update on public.%I '
      'for each row execute function app.guard_finalized()', t
    );
  end loop;
end
$block$;

-- 5) Rascunhos também participam da concorrência otimista -------------------
alter table public.drafts add column if not exists version integer not null default 1;
alter table public.drafts add column if not exists updated_by uuid references auth.users(id);

do $block$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'drafts_version_positive'
       and conrelid = 'public.drafts'::regclass
  ) then
    alter table public.drafts
      add constraint drafts_version_positive check (version > 0);
  end if;
end
$block$;

create or replace function app.stamp_draft()
returns trigger
language plpgsql
set search_path = pg_catalog, public, app, auth
as $fn$
begin
  new.user_id := auth.uid();
  new.updated_by := auth.uid();
  new.created_at := now();
  new.updated_at := new.created_at;
  new.version := 1;
  return new;
end
$fn$;

create or replace function app.guard_draft_identity()
returns trigger
language plpgsql
set search_path = pg_catalog, public, app, auth
as $fn$
begin
  if new.organization_id is distinct from old.organization_id
     or new.user_id is distinct from old.user_id
     or new.module is distinct from old.module
     or new.doc_id is distinct from old.doc_id then
    raise exception 'A identidade e o ambiente de um rascunho não podem ser alterados.'
      using errcode = 'check_violation';
  end if;
  return new;
end
$fn$;

drop trigger if exists trg_drafts_stamp on public.drafts;
create trigger trg_drafts_stamp
  before insert on public.drafts
  for each row execute function app.stamp_draft();

drop trigger if exists trg_drafts_identity on public.drafts;
create trigger trg_drafts_identity
  before update on public.drafts
  for each row execute function app.guard_draft_identity();

drop trigger if exists trg_updated_at on public.drafts;
drop trigger if exists trg_version on public.drafts;
create trigger trg_version
  before update on public.drafts
  for each row execute function app.bump_version();

alter table public.drafts enable row level security;
alter table public.drafts force row level security;

-- Reafirma as políticas depois da mudança de identidade/versionamento. Além
-- de explicitar o papel, `(select auth.uid())` é avaliado uma vez por consulta
-- em vez de uma vez por linha.
drop policy if exists drafts_sel on public.drafts;
create policy drafts_sel on public.drafts for select
  to authenticated
  using (
    organization_id in (select app.org_ids())
    and user_id = (select auth.uid())
    and app.pode_modulo(organization_id, module)
  );

drop policy if exists drafts_ins on public.drafts;
create policy drafts_ins on public.drafts for insert
  to authenticated
  with check (
    organization_id in (select app.org_ids())
    and user_id = (select auth.uid())
    and app.pode_editar_modulo(organization_id, module)
  );

drop policy if exists drafts_upd on public.drafts;
create policy drafts_upd on public.drafts for update
  to authenticated
  using (
    organization_id in (select app.org_ids())
    and user_id = (select auth.uid())
    and app.pode_editar_modulo(organization_id, module)
  )
  with check (
    organization_id in (select app.org_ids())
    and user_id = (select auth.uid())
    and app.pode_editar_modulo(organization_id, module)
  );

drop policy if exists drafts_del on public.drafts;
create policy drafts_del on public.drafts for delete
  to authenticated
  using (
    organization_id in (select app.org_ids())
    and user_id = (select auth.uid())
    and app.pode_editar_modulo(organization_id, module)
  );

revoke all on table public.drafts from public, anon;
grant select, insert, update, delete on table public.drafts to authenticated;

-- 6) Realtime: conflitos/adendos/rascunhos convergem sem ação manual ---------
do $block$
declare
  t text;
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
  foreach t in array array['sync_conflicts','addenda','drafts'] loop
    if not exists (
      select 1 from pg_publication_tables
       where pubname = 'supabase_realtime'
         and schemaname = 'public'
         and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
    execute format('alter table public.%I replica identity full', t);
  end loop;
end
$block$;

commit;
