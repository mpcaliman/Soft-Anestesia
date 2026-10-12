-- =============================================================================
-- Soft Anestesia — 0027: fechamento de caixa relacional + Realtime completo
-- =============================================================================
-- G3 autorizado em 2026-10-08, mas aplicação continua bloqueada até confirmar
-- o projeto/ref exato de homologação e reconciliar os históricos de migração.
--
-- O fechamento diário ainda era um array exclusivo do navegador. Esta
-- migração lhe dá o mesmo contrato dos demais módulos: organização obrigatória,
-- RLS, versão atômica, recibo idempotente, soft-delete, auditoria e Realtime.
-- Também publica os módulos relacionais que ainda dependiam apenas do polling.
-- =============================================================================

begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';
set local check_function_bodies = off;

-- `sync_conflicts` valida tabela + módulo por esta função. Sem incluir o
-- fechamento, duas pessoas editando o mesmo caixa preservariam o conflito no
-- aparelho, mas o INSERT da evidência seria recusado pelo CHECK do servidor.
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
    when 'cash_closings'                then 'financeiro'
    when 'quotes'                       then 'orcamento'
    when 'drafts'                       then 'rascunhos'
    else null
  end
$fn$;

create table if not exists public.cash_closings (
  id                       uuid primary key default gen_random_uuid(),
  organization_id          uuid not null references public.organizations(id) on delete cascade,
  patient_id               uuid references public.patients(id) on delete set null,
  encounter_id             uuid references public.encounters(id) on delete set null,
  status                   text not null default 'closed',
  version                  integer not null default 1,
  data                     jsonb not null default '{}'::jsonb,
  finalized_at             timestamptz,
  finalized_by             uuid references auth.users(id),
  created_by               uuid references auth.users(id),
  updated_by               uuid references auth.users(id),
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  deleted_at               timestamptz,
  legacy_id                text not null,
  last_operation_id        uuid,
  last_operation_checksum  text,
  constraint cash_closings_version_positive check (version > 0),
  constraint cash_closings_operation_receipt_valid check (
    (last_operation_id is null and last_operation_checksum is null)
    or
    (last_operation_id is not null and last_operation_checksum ~ '^[0-9a-f]{64}$')
  ),
  unique (organization_id, legacy_id)
);

create index if not exists cash_closings_org_updated_idx
  on public.cash_closings(organization_id, updated_at desc)
  where deleted_at is null;
create index if not exists cash_closings_patient_idx
  on public.cash_closings(patient_id)
  where patient_id is not null;
create index if not exists cash_closings_encounter_idx
  on public.cash_closings(encounter_id)
  where encounter_id is not null;
create unique index if not exists ux_cash_closings_last_operation
  on public.cash_closings(organization_id, last_operation_id)
  where last_operation_id is not null;

drop trigger if exists trg_stamp on public.cash_closings;
create trigger trg_stamp before insert on public.cash_closings
  for each row execute function app.stamp_created();

drop trigger if exists trg_org_scope on public.cash_closings;
create trigger trg_org_scope before update on public.cash_closings
  for each row execute function app.guard_organization_scope();

drop trigger if exists trg_version on public.cash_closings;
create trigger trg_version before update on public.cash_closings
  for each row execute function app.bump_version();

drop trigger if exists trg_audit on public.cash_closings;
create trigger trg_audit after insert or update or delete on public.cash_closings
  for each row execute function app.audit_row();

alter table public.cash_closings enable row level security;
alter table public.cash_closings force row level security;

drop policy if exists cash_closings_sel on public.cash_closings;
create policy cash_closings_sel on public.cash_closings for select to authenticated
  using (
    app.pode_ler_registro_modulo(
      organization_id, 'financeiro', created_by, encounter_id
    )
  );

drop policy if exists cash_closings_ins on public.cash_closings;
create policy cash_closings_ins on public.cash_closings for insert to authenticated
  with check (
    organization_id in (select app.org_ids())
    and created_by = (select auth.uid())
    and app.pode_editar_registro_modulo(
      organization_id, 'financeiro', created_by, encounter_id
    )
  );

drop policy if exists cash_closings_upd on public.cash_closings;
create policy cash_closings_upd on public.cash_closings for update to authenticated
  using (
    organization_id in (select app.org_ids())
    and app.pode_editar_registro_modulo(
      organization_id, 'financeiro', created_by, encounter_id
    )
  )
  with check (
    organization_id in (select app.org_ids())
    and app.pode_editar_registro_modulo(
      organization_id, 'financeiro', created_by, encounter_id
    )
  );

drop policy if exists cash_closings_del on public.cash_closings;
create policy cash_closings_del on public.cash_closings for delete to authenticated
  using (
    organization_id in (select app.org_ids())
    and app.pode_editar_registro_modulo(
      organization_id, 'financeiro', created_by, encounter_id
    )
  );

revoke all on table public.cash_closings from public, anon, authenticated;
grant select, insert, update, delete on table public.cash_closings to authenticated;

do $block$
declare
  t text;
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
  foreach t in array array[
    'patients','appointments','preanesthetic_assessments','consultations',
    'anesthesia_records','recovery_records','risk_assessments','consents',
    'prescriptions','documents','finance_entries','cash_closings','quotes',
    'addenda','drafts','sync_conflicts'
  ] loop
    if to_regclass(format('public.%I', t)) is null then
      raise notice 'tabela public.% ainda não existe — pulando', t;
      continue;
    end if;
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
