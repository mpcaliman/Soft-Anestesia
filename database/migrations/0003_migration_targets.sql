-- =============================================================================
-- Soft Anestesia — Migração 0003: alvos e idempotência para a migração de dados
-- =============================================================================
-- Rode DEPOIS da 0001 e 0002. Idempotente e aditiva (não altera dados).
--
-- Objetivo (Fase 4): preparar o banco para receber os dados atuais do app.
--   1) Coluna `legacy_id` + índice único (organization_id, legacy_id) nas
--      tabelas existentes → a migração é IDEMPOTENTE (reexecutar não duplica).
--   2) Três tabelas de destino que faltavam: `consultations` (consulta/dor),
--      `quotes` (orçamentos) e `appointments` (agenda).
-- =============================================================================

begin;
set local check_function_bodies = off;

-- 1) legacy_id nas tabelas já existentes -------------------------------------
do $$
declare t text;
  alvos text[] := array[
    'patients','encounters','preanesthetic_assessments','anesthesia_records',
    'recovery_records','risk_assessments','consents','prescriptions','documents',
    'finance_entries'
  ];
begin
  foreach t in array alvos loop
    execute format('alter table public.%I add column if not exists legacy_id text', t);
    execute format('create unique index if not exists ux_%s_legacy on public.%I(organization_id, legacy_id)', t, t);
  end loop;
end $$;

-- 2) Novas tabelas de destino -------------------------------------------------

-- Consulta / Dor (avaliação clínica ambulatorial; finalizável como as clínicas)
create table if not exists public.consultations (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  patient_id       uuid references public.patients(id) on delete set null,
  encounter_id     uuid references public.encounters(id) on delete set null,
  status           text not null default 'draft',
  version          integer not null default 1,
  data             jsonb not null default '{}'::jsonb,
  content_hash     text,
  finalized_at     timestamptz,
  finalized_by     uuid references auth.users(id),
  created_by       uuid references auth.users(id),
  updated_by       uuid references auth.users(id),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  deleted_at       timestamptz,
  device_id        text,
  legacy_id        text
);

-- Orçamentos (financeiro; versionado, sem guarda de finalização)
create table if not exists public.quotes (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  patient_id       uuid references public.patients(id) on delete set null,
  encounter_id     uuid references public.encounters(id) on delete set null,
  status           text not null default 'draft',
  version          integer not null default 1,
  data             jsonb not null default '{}'::jsonb,
  created_by       uuid references auth.users(id),
  updated_by       uuid references auth.users(id),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  deleted_at       timestamptz,
  legacy_id        text
);

-- Agenda (compromissos; edição livre, só stamp + auditoria)
create table if not exists public.appointments (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  patient_id       uuid references public.patients(id) on delete set null,
  encounter_id     uuid references public.encounters(id) on delete set null,
  scheduled_at     timestamptz,
  status           text not null default 'agendado',
  data             jsonb not null default '{}'::jsonb,
  created_by       uuid references auth.users(id),
  updated_by       uuid references auth.users(id),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  deleted_at       timestamptz,
  legacy_id        text
);

-- legacy_id único também nas novas tabelas
do $$
declare t text;
begin
  foreach t in array array['consultations','quotes','appointments'] loop
    execute format('create unique index if not exists ux_%s_legacy on public.%I(organization_id, legacy_id)', t, t);
  end loop;
end $$;

-- índices de busca úteis
create index if not exists ix_consultations_patient on public.consultations(patient_id);
create index if not exists ix_quotes_patient on public.quotes(patient_id);
create index if not exists ix_appointments_patient on public.appointments(patient_id);
create index if not exists ix_appointments_when on public.appointments(scheduled_at);

-- 3) Triggers nas novas tabelas ----------------------------------------------
do $$
begin
  -- updated_at em todas
  perform 1;
  execute 'drop trigger if exists trg_updated_at on public.consultations';
  execute 'create trigger trg_updated_at before update on public.consultations for each row execute function app.set_updated_at()';
  execute 'drop trigger if exists trg_updated_at on public.quotes';
  execute 'create trigger trg_updated_at before update on public.quotes for each row execute function app.set_updated_at()';
  execute 'drop trigger if exists trg_updated_at on public.appointments';
  execute 'create trigger trg_updated_at before update on public.appointments for each row execute function app.set_updated_at()';

  -- consultations: finalizável (stamp + guard + version + auditoria)
  execute 'drop trigger if exists trg_stamp on public.consultations';
  execute 'create trigger trg_stamp before insert on public.consultations for each row execute function app.stamp_created()';
  execute 'drop trigger if exists trg_guard on public.consultations';
  execute 'create trigger trg_guard before update on public.consultations for each row execute function app.guard_finalized()';
  execute 'drop trigger if exists trg_version on public.consultations';
  execute 'create trigger trg_version before update on public.consultations for each row execute function app.bump_version()';
  execute 'drop trigger if exists trg_audit on public.consultations';
  execute 'create trigger trg_audit after insert or update or delete on public.consultations for each row execute function app.audit_row()';

  -- quotes: versionado (stamp + version + auditoria, sem guard)
  execute 'drop trigger if exists trg_stamp on public.quotes';
  execute 'create trigger trg_stamp before insert on public.quotes for each row execute function app.stamp_created()';
  execute 'drop trigger if exists trg_version on public.quotes';
  execute 'create trigger trg_version before update on public.quotes for each row execute function app.bump_version()';
  execute 'drop trigger if exists trg_audit on public.quotes';
  execute 'create trigger trg_audit after insert or update or delete on public.quotes for each row execute function app.audit_row()';

  -- appointments: stamp + auditoria
  execute 'drop trigger if exists trg_stamp on public.appointments';
  execute 'create trigger trg_stamp before insert on public.appointments for each row execute function app.stamp_created()';
  execute 'drop trigger if exists trg_audit on public.appointments';
  execute 'create trigger trg_audit after insert or update or delete on public.appointments for each row execute function app.audit_row()';
end $$;

-- 4) RLS nas novas tabelas ----------------------------------------------------
alter table public.consultations enable row level security;
alter table public.quotes enable row level security;
alter table public.appointments enable row level security;

-- consultations: leitura clínica (gestor/anest + cirurgião do encounter),
-- escrita clínica (gestor/anestesiologista)
drop policy if exists consultations_sel on public.consultations;
create policy consultations_sel on public.consultations for select
  using (organization_id in (select app.org_ids())
         and (
           app.has_role(organization_id, array['gestor','anestesiologista'])
           or exists (select 1 from public.encounters e
                      where e.id = consultations.encounter_id
                        and e.surgeon_id = auth.uid())
         ));
drop policy if exists consultations_wr on public.consultations;
create policy consultations_wr on public.consultations for all
  using (app.can_write_clinical(organization_id))
  with check (app.can_write_clinical(organization_id));

-- quotes (orçamento): gestor/financeiro/anestesiologista/auxiliar
drop policy if exists quotes_sel on public.quotes;
create policy quotes_sel on public.quotes for select
  using (app.has_role(organization_id, array['gestor','financeiro','anestesiologista','auxiliar']));
drop policy if exists quotes_wr on public.quotes;
create policy quotes_wr on public.quotes for all
  using (app.has_role(organization_id, array['gestor','financeiro','anestesiologista','auxiliar']))
  with check (app.has_role(organization_id, array['gestor','financeiro','anestesiologista','auxiliar']));

-- appointments (agenda): org lê; escrita gestor/anestesiologista/auxiliar
drop policy if exists appointments_sel on public.appointments;
create policy appointments_sel on public.appointments for select
  using (organization_id in (select app.org_ids()));
drop policy if exists appointments_wr on public.appointments;
create policy appointments_wr on public.appointments for all
  using (app.has_role(organization_id, array['gestor','anestesiologista','auxiliar']))
  with check (app.has_role(organization_id, array['gestor','anestesiologista','auxiliar']));

-- 5) Realtime nas novas tabelas (idempotente) ---------------------------------
do $$
declare t text;
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
  foreach t in array array['consultations','quotes','appointments'] loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
    execute format('alter table public.%I replica identity full', t);
  end loop;
end $$;

commit;

-- Pronto. Agora o app pode migrar os dados (patients/encounters + módulos)
-- de forma idempotente usando `legacy_id`.
