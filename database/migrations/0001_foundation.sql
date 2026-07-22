-- =============================================================================
-- Soft Anestesia — Migração 0001: Fundação do banco relacional (Supabase)
-- =============================================================================
-- OBJETIVO
--   Estabelecer o Supabase como fonte oficial dos registros clínicos:
--   organizações, perfis (ligados ao auth.users), pacientes, encounters
--   (atendimentos cirúrgicos), tabelas clínicas com versão/status/finalização,
--   linha do tempo da anestesia, auditoria, anexos, RLS por papel/organização,
--   triggers de updated_at/versão/imutabilidade e Realtime.
--
-- SEGURANÇA DESTA MIGRAÇÃO
--   * ADITIVA e IDEMPOTENTE: usa IF NOT EXISTS / CREATE OR REPLACE /
--     DROP POLICY IF EXISTS. Pode ser rodada mais de uma vez sem erro.
--   * NÃO apaga nem altera a tabela legada `documentos` (sync atual continua).
--   * NÃO migra dados ainda — a migração dos JSON atuais é uma etapa posterior,
--     testada à parte (não faz parte deste script).
--
-- COMO APLICAR
--   Supabase → SQL Editor → cole este arquivo inteiro → Run.
--   Rode também 0002 (storage/realtime) e depois faça o seed inicial da sua
--   organização + o vínculo do seu usuário admin (ver database/README.md).
-- =============================================================================

begin;

create extension if not exists pgcrypto;      -- gen_random_uuid()

-- schema para funções auxiliares (não polui o public)
create schema if not exists app;

-- -----------------------------------------------------------------------------
-- Funções utilitárias de trigger
-- -----------------------------------------------------------------------------

-- updated_at automático
create or replace function app.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- incrementa version e carimba updated_by em cada UPDATE
create or replace function app.bump_version()
returns trigger language plpgsql as $$
begin
  new.version := coalesce(old.version, 1) + 1;
  new.updated_by := auth.uid();
  new.updated_at := now();
  return new;
end $$;

-- carimba created_by/updated_by no INSERT
create or replace function app.stamp_created()
returns trigger language plpgsql as $$
begin
  if new.created_by is null then new.created_by := auth.uid(); end if;
  new.updated_by := auth.uid();
  return new;
end $$;

-- impede alterar o CONTEÚDO clínico (data) após finalizado/assinado.
-- Correções passam por adendo (tabela addenda). Permite mudar só metadados
-- de status/assinatura e o soft-delete.
create or replace function app.guard_finalized()
returns trigger language plpgsql as $$
begin
  if old.finalized_at is not null
     and new.data is distinct from old.data then
    raise exception 'Registro finalizado/assinado é imutável. Use um adendo para correções (record %, tabela %).', old.id, tg_table_name
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

-- -----------------------------------------------------------------------------
-- Funções de segurança (RLS) — SECURITY DEFINER p/ evitar recursão de policy
-- -----------------------------------------------------------------------------

-- organizações ativas do usuário atual
create or replace function app.org_ids()
returns setof uuid
language sql stable security definer set search_path = public, app, auth as $$
  select organization_id
    from public.organization_users
   where user_id = auth.uid() and ativo = true
$$;

-- o usuário atual tem algum dos papéis na organização?
create or replace function app.has_role(p_org uuid, p_roles text[])
returns boolean
language sql stable security definer set search_path = public, app, auth as $$
  select exists(
    select 1 from public.organization_users
     where user_id = auth.uid()
       and organization_id = p_org
       and ativo = true
       and role = any(p_roles)
  )
$$;

-- pode LER dados clínicos? gestor/anestesiologista (org inteira);
-- cirurgião só os atendimentos dele; financeiro/auxiliar NÃO leem clínico.
create or replace function app.can_read_clinical(p_org uuid, p_surgeon uuid)
returns boolean
language sql stable security definer set search_path = public, app, auth as $$
  select exists(
    select 1 from public.organization_users ou
     where ou.user_id = auth.uid()
       and ou.organization_id = p_org
       and ou.ativo = true
       and (
            ou.role in ('gestor','anestesiologista')
         or (ou.role = 'cirurgiao' and p_surgeon = auth.uid())
       )
  )
$$;

-- pode ESCREVER dados clínicos? gestor/anestesiologista.
create or replace function app.can_write_clinical(p_org uuid)
returns boolean
language sql stable security definer set search_path = public, app, auth as $$
  select app.has_role(p_org, array['gestor','anestesiologista'])
$$;

-- =============================================================================
-- TABELAS BASE (organização / perfis / cadastros)
-- =============================================================================

create table if not exists public.organizations (
  id          uuid primary key default gen_random_uuid(),
  nome        text not null,
  cnpj        text,
  endereco    text,
  ativo       boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- perfil do usuário: id = auth.users.id
create table if not exists public.profiles (
  id             uuid primary key references auth.users(id) on delete cascade,
  nome           text,
  email          text,
  celular        text,
  crm            text,
  crm_uf         text,
  funcao         text,                    -- papel principal (informativo)
  organizacao    text,                    -- nome livre (compat)
  hospital_id    uuid,                    -- unidade principal (FK adicionada abaixo)
  ativo          boolean not null default true,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- vínculo usuário ↔ organização ↔ papel (um usuário pode estar em várias orgs)
create table if not exists public.organization_users (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id         uuid not null references auth.users(id) on delete cascade,
  role            text not null check (role in
                    ('gestor','anestesiologista','cirurgiao','auxiliar','financeiro','empresa')),
  ativo           boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  primary key (organization_id, user_id, role)
);

create table if not exists public.hospitals (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  nome            text not null,
  cnpj            text,
  endereco        text,
  ativo           boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- FK tardia de profiles.hospital_id (agora que hospitals existe)
do $$ begin
  if not exists (select 1 from information_schema.table_constraints
                 where constraint_name = 'profiles_hospital_id_fkey') then
    alter table public.profiles
      add constraint profiles_hospital_id_fkey
      foreign key (hospital_id) references public.hospitals(id) on delete set null;
  end if;
end $$;

create table if not exists public.rooms (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  hospital_id     uuid references public.hospitals(id) on delete set null,
  nome            text not null,
  ativo           boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create table if not exists public.equipment (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  hospital_id     uuid references public.hospitals(id) on delete set null,
  nome            text not null,
  tipo            text,
  ativo           boolean not null default true,
  data            jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- =============================================================================
-- PACIENTE (cadastro central único por organização)
-- =============================================================================

create table if not exists public.patients (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    uuid not null references public.organizations(id) on delete cascade,
  nome               text not null,
  nome_social        text,
  nascimento         date,
  sexo               text,
  cpf                text,
  prontuario         text,
  telefone           text,
  email              text,
  endereco           text,
  responsavel        text,
  responsavel_tel    text,
  convenio           text,
  carteirinha        text,
  observacoes        text,
  data               jsonb not null default '{}'::jsonb,  -- campos extras (compat)
  created_by         uuid references auth.users(id),
  updated_by         uuid references auth.users(id),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  deleted_at         timestamptz
);

create index if not exists patients_org_idx        on public.patients(organization_id);
create index if not exists patients_cpf_idx        on public.patients(organization_id, cpf);
create index if not exists patients_nome_idx       on public.patients(organization_id, lower(nome));
create index if not exists patients_nasc_idx       on public.patients(organization_id, nascimento);
create index if not exists patients_prontuario_idx on public.patients(organization_id, prontuario);

-- =============================================================================
-- ENCOUNTER / SURGICAL CASE (atendimento — âncora de todos os módulos)
-- =============================================================================

create table if not exists public.encounters (
  id                  uuid primary key default gen_random_uuid(),
  organization_id     uuid not null references public.organizations(id) on delete cascade,
  patient_id          uuid not null references public.patients(id) on delete restrict,
  hospital_id         uuid references public.hospitals(id) on delete set null,
  room_id             uuid references public.rooms(id) on delete set null,
  surgeon_id          uuid references auth.users(id) on delete set null,
  anesthesiologist_id uuid references auth.users(id) on delete set null,
  procedimento        text,
  tuss                text,
  diagnostico         text,
  lateralidade        text,
  carater             text check (carater in ('eletivo','urgencia','emergencia') or carater is null),
  data_prevista       date,
  hora_prevista       time,
  status              text not null default 'agendado',
  senha               text,
  convenio            text,
  guia                text,
  acomodacao          text,
  data                jsonb not null default '{}'::jsonb,
  created_by          uuid references auth.users(id),
  updated_by          uuid references auth.users(id),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  deleted_at          timestamptz
);

create index if not exists enc_org_idx      on public.encounters(organization_id);
create index if not exists enc_patient_idx  on public.encounters(patient_id);
create index if not exists enc_surgeon_idx  on public.encounters(surgeon_id);
create index if not exists enc_anesth_idx   on public.encounters(anesthesiologist_id);
create index if not exists enc_data_idx     on public.encounters(organization_id, data_prevista);

-- =============================================================================
-- TABELAS CLÍNICAS (um registro por módulo, ligado ao encounter)
--   Padrão híbrido: colunas indexáveis + `data jsonb` para preservar todos os
--   campos do formulário atual durante a transição, sem perder nada.
-- =============================================================================

-- macro (via DO) evitaria repetição, mas mantemos explícito p/ clareza/idempotência.

create table if not exists public.preanesthetic_assessments (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  patient_id       uuid references public.patients(id) on delete set null,
  encounter_id     uuid references public.encounters(id) on delete set null,
  status           text not null default 'draft',   -- draft|completed|finalized|signed
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
  device_id        text
);

create table if not exists public.anesthesia_records (
  id                        uuid primary key default gen_random_uuid(),
  organization_id           uuid not null references public.organizations(id) on delete cascade,
  patient_id                uuid references public.patients(id) on delete set null,
  encounter_id              uuid references public.encounters(id) on delete set null,
  preanesthetic_assessment_id uuid references public.preanesthetic_assessments(id) on delete set null,
  preanesthetic_version     integer,
  imported_at               timestamptz,
  imported_by               uuid references auth.users(id),
  imported_snapshot         jsonb,
  status                    text not null default 'draft',
  version                   integer not null default 1,
  data                      jsonb not null default '{}'::jsonb,
  content_hash              text,
  finalized_at              timestamptz,
  finalized_by              uuid references auth.users(id),
  created_by                uuid references auth.users(id),
  updated_by                uuid references auth.users(id),
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  deleted_at                timestamptz,
  device_id                 text
);

create table if not exists public.recovery_records (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    uuid not null references public.organizations(id) on delete cascade,
  patient_id         uuid references public.patients(id) on delete set null,
  encounter_id       uuid references public.encounters(id) on delete set null,
  anesthesia_record_id uuid references public.anesthesia_records(id) on delete set null,
  status             text not null default 'draft',
  version            integer not null default 1,
  data               jsonb not null default '{}'::jsonb,
  content_hash       text,
  finalized_at       timestamptz,
  finalized_by       uuid references auth.users(id),
  created_by         uuid references auth.users(id),
  updated_by         uuid references auth.users(id),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  deleted_at         timestamptz,
  device_id          text
);

create table if not exists public.risk_assessments (
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
  deleted_at       timestamptz
);

create table if not exists public.consents (            -- Termo (TCLE)
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
  deleted_at       timestamptz
);

create table if not exists public.prescriptions (       -- Receituário
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  patient_id       uuid references public.patients(id) on delete set null,
  encounter_id     uuid references public.encounters(id) on delete set null,
  modelo           text,
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
  deleted_at       timestamptz
);

create table if not exists public.documents (           -- Atestados / Declarações / Laudos
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  patient_id       uuid references public.patients(id) on delete set null,
  encounter_id     uuid references public.encounters(id) on delete set null,
  modelo           text,                                  -- atestado|declaracao|laudo
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
  deleted_at       timestamptz
);

create table if not exists public.finance_entries (     -- Financeiro (rascunho/lançamento)
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  patient_id       uuid references public.patients(id) on delete set null,
  encounter_id     uuid references public.encounters(id) on delete set null,
  status           text not null default 'rascunho',     -- rascunho|conferido|faturado|pago|glosado
  version          integer not null default 1,
  data             jsonb not null default '{}'::jsonb,
  created_by       uuid references auth.users(id),
  updated_by       uuid references auth.users(id),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  deleted_at       timestamptz
);

-- índices de vínculo p/ todas as tabelas clínicas
create index if not exists pre_enc_idx     on public.preanesthetic_assessments(encounter_id);
create index if not exists pre_pat_idx     on public.preanesthetic_assessments(patient_id);
create index if not exists pre_org_idx     on public.preanesthetic_assessments(organization_id);
create index if not exists anes_enc_idx    on public.anesthesia_records(encounter_id);
create index if not exists anes_pat_idx    on public.anesthesia_records(patient_id);
create index if not exists anes_org_idx    on public.anesthesia_records(organization_id);
create index if not exists rec_enc_idx     on public.recovery_records(encounter_id);
create index if not exists risk_enc_idx    on public.risk_assessments(encounter_id);
create index if not exists cons_enc_idx    on public.consents(encounter_id);
create index if not exists presc_pat_idx   on public.prescriptions(patient_id);
create index if not exists doc_pat_idx     on public.documents(patient_id);
create index if not exists fin_enc_idx     on public.finance_entries(encounter_id);
create index if not exists fin_org_idx     on public.finance_entries(organization_id);

-- =============================================================================
-- LINHA DO TEMPO DA ANESTESIA (medicações, sinais, eventos, fluidos… unificados)
-- =============================================================================

create table if not exists public.anesthesia_timeline_events (
  id                   uuid primary key default gen_random_uuid(),
  organization_id      uuid not null references public.organizations(id) on delete cascade,
  encounter_id         uuid references public.encounters(id) on delete set null,
  anesthesia_record_id uuid not null references public.anesthesia_records(id) on delete cascade,
  ts                   timestamptz not null,
  type                 text not null check (type in
                         ('vital','medication','fluid','blood_product','event','procedure',
                          'airway','ventilation','note','urine_output','blood_loss',
                          'position_change','antibiotic','neuromuscular_monitoring')),
  subtype              text,
  payload              jsonb not null default '{}'::jsonb,
  created_by           uuid references auth.users(id),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  deleted_at           timestamptz
);

create index if not exists tl_record_ts_idx on public.anesthesia_timeline_events(anesthesia_record_id, ts);
create index if not exists tl_org_idx        on public.anesthesia_timeline_events(organization_id);
create index if not exists tl_type_idx       on public.anesthesia_timeline_events(anesthesia_record_id, type);

-- =============================================================================
-- ADENDOS (correções após finalização, preservando o original)
-- =============================================================================

create table if not exists public.addenda (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  parent_table     text not null,
  parent_id        uuid not null,
  encounter_id     uuid references public.encounters(id) on delete set null,
  patient_id       uuid references public.patients(id) on delete set null,
  texto            text not null,
  data             jsonb not null default '{}'::jsonb,
  created_by       uuid references auth.users(id),
  created_at       timestamptz not null default now()
);
create index if not exists addenda_parent_idx on public.addenda(parent_table, parent_id);

-- =============================================================================
-- ANEXOS (metadados; binário fica no Supabase Storage)
-- =============================================================================

create table if not exists public.attachments (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  patient_id       uuid references public.patients(id) on delete set null,
  encounter_id     uuid references public.encounters(id) on delete set null,
  module           text,
  storage_path     text not null,
  filename         text,
  mime_type        text,
  size             bigint,
  hash             text,
  uploaded_by      uuid references auth.users(id),
  uploaded_at      timestamptz not null default now(),
  deleted_at       timestamptz
);
create index if not exists att_org_idx  on public.attachments(organization_id);
create index if not exists att_pat_idx  on public.attachments(patient_id);
create index if not exists att_hash_idx on public.attachments(organization_id, hash);

-- =============================================================================
-- MODELOS / TEXTOS PADRÃO (por usuário e por organização)
-- =============================================================================

create table if not exists public.templates (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  owner_id         uuid references auth.users(id) on delete set null,  -- null = da organização
  categoria        text not null,     -- tecnica|medicacoes|via_aerea|analgesia|nvpo|resumo|...
  nome             text not null,
  favorito         boolean not null default false,
  padrao           boolean not null default false,
  compartilhado    boolean not null default false,
  data             jsonb not null default '{}'::jsonb,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  deleted_at       timestamptz
);
create index if not exists tpl_org_cat_idx on public.templates(organization_id, categoria);
create index if not exists tpl_owner_idx   on public.templates(owner_id);

create table if not exists public.standard_texts (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  owner_id         uuid references auth.users(id) on delete set null,
  chave            text not null,
  texto            text,
  data             jsonb not null default '{}'::jsonb,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- =============================================================================
-- AUDITORIA
-- =============================================================================

create table if not exists public.audit_logs (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid,
  user_id          uuid,
  patient_id       uuid,
  encounter_id     uuid,
  module           text,
  record_id        uuid,
  action           text not null,     -- insert|update|delete|restore|finalize|sign|addendum|access|export|sync|conflict|sync_error
  field_name       text,
  previous_value   jsonb,
  new_value        jsonb,
  device_id        text,
  ip               text,
  user_agent       text,
  created_at       timestamptz not null default now()
);
create index if not exists audit_org_idx     on public.audit_logs(organization_id, created_at desc);
create index if not exists audit_record_idx  on public.audit_logs(record_id);
create index if not exists audit_patient_idx on public.audit_logs(patient_id);

-- trigger genérico de auditoria p/ tabelas clínicas.
-- Lê os campos via JSONB → robusto a tabelas sem patient_id/encounter_id/finalized_at.
create or replace function app.audit_row()
returns trigger language plpgsql security definer set search_path = public, app, auth as $$
declare
  jn jsonb;      -- new (ou old, em delete)
  jo jsonb;      -- old (em update/delete)
  v_action text;
begin
  jn := case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end;
  jo := case when tg_op in ('UPDATE','DELETE') then to_jsonb(old) else '{}'::jsonb end;

  if tg_op = 'INSERT' then
    v_action := 'insert';
  elsif tg_op = 'UPDATE' then
    if  (jn->>'deleted_at')   is not null and (jo->>'deleted_at')   is null then v_action := 'delete';
    elsif (jo->>'deleted_at') is not null and (jn->>'deleted_at')   is null then v_action := 'restore';
    elsif (jn->>'finalized_at') is not null and (jo->>'finalized_at') is null then v_action := 'finalize';
    else v_action := 'update';
    end if;
  else
    v_action := 'delete';
  end if;

  insert into public.audit_logs(organization_id, user_id, patient_id, encounter_id,
                                module, record_id, action, new_value, created_at)
  values (nullif(jn->>'organization_id','')::uuid, auth.uid(),
          nullif(jn->>'patient_id','')::uuid, nullif(jn->>'encounter_id','')::uuid,
          tg_table_name, nullif(jn->>'id','')::uuid, v_action, jn, now());
  return null; -- AFTER trigger
end $$;

-- =============================================================================
-- TABELA LEGADA `documentos` (sync atual) — apenas garante RLS por usuário.
--   NÃO alteramos dados; mantém a sincronização atual funcionando na transição.
-- =============================================================================
do $$ begin
  if exists (select 1 from information_schema.tables
             where table_schema='public' and table_name='documentos') then
    execute 'alter table public.documentos enable row level security';
  end if;
end $$;

-- =============================================================================
-- TRIGGERS (updated_at, versão, created_by, guard finalizado, auditoria)
-- =============================================================================
do $$
declare
  t text;
  -- tabelas finalizáveis: têm finalized_at + version + guard de imutabilidade
  finalizaveis text[] := array[
    'preanesthetic_assessments','anesthesia_records','recovery_records',
    'risk_assessments','consents','prescriptions','documents'
  ];
  -- versionadas com auditoria e stamp, MAS sem guard de finalização
  versionadas  text[] := array['finance_entries'];
  -- só stamp + auditoria (sem version/guard)
  admin        text[] := array['patients','encounters'];
  -- só updated_at
  restantes    text[] := array[
    'organizations','profiles','organization_users','hospitals','rooms',
    'equipment','templates','standard_texts','anesthesia_timeline_events'
  ];
begin
  -- updated_at em todas
  foreach t in array (finalizaveis || versionadas || admin || restantes) loop
    execute format('drop trigger if exists trg_updated_at on public.%I', t);
    execute format('create trigger trg_updated_at before update on public.%I
                    for each row execute function app.set_updated_at()', t);
  end loop;

  -- finalizáveis: stamp + guard + version + auditoria
  foreach t in array finalizaveis loop
    execute format('drop trigger if exists trg_stamp on public.%I', t);
    execute format('create trigger trg_stamp before insert on public.%I
                    for each row execute function app.stamp_created()', t);
    execute format('drop trigger if exists trg_guard on public.%I', t);
    execute format('create trigger trg_guard before update on public.%I
                    for each row execute function app.guard_finalized()', t);
    execute format('drop trigger if exists trg_version on public.%I', t);
    execute format('create trigger trg_version before update on public.%I
                    for each row execute function app.bump_version()', t);
    execute format('drop trigger if exists trg_audit on public.%I', t);
    execute format('create trigger trg_audit after insert or update or delete on public.%I
                    for each row execute function app.audit_row()', t);
  end loop;

  -- versionadas (finance): stamp + version + auditoria (sem guard)
  foreach t in array versionadas loop
    execute format('drop trigger if exists trg_stamp on public.%I', t);
    execute format('create trigger trg_stamp before insert on public.%I
                    for each row execute function app.stamp_created()', t);
    execute format('drop trigger if exists trg_version on public.%I', t);
    execute format('create trigger trg_version before update on public.%I
                    for each row execute function app.bump_version()', t);
    execute format('drop trigger if exists trg_audit on public.%I', t);
    execute format('create trigger trg_audit after insert or update or delete on public.%I
                    for each row execute function app.audit_row()', t);
  end loop;

  -- patients/encounters: stamp + auditoria (sem guard/version)
  foreach t in array admin loop
    execute format('drop trigger if exists trg_stamp on public.%I', t);
    execute format('create trigger trg_stamp before insert on public.%I
                    for each row execute function app.stamp_created()', t);
    execute format('drop trigger if exists trg_audit on public.%I', t);
    execute format('create trigger trg_audit after insert or update or delete on public.%I
                    for each row execute function app.audit_row()', t);
  end loop;
end $$;

-- =============================================================================
-- RLS — habilitar em todas as tabelas
-- =============================================================================
do $$
declare t text;
  todas text[] := array[
    'organizations','profiles','organization_users','hospitals','rooms','equipment',
    'patients','encounters','preanesthetic_assessments','anesthesia_records',
    'recovery_records','risk_assessments','consents','prescriptions','documents',
    'finance_entries','anesthesia_timeline_events','addenda','attachments',
    'templates','standard_texts','audit_logs'
  ];
begin
  foreach t in array todas loop
    execute format('alter table public.%I enable row level security', t);
  end loop;
end $$;

-- ---- profiles: cada um lê/edita o próprio; gestor da org lê os da org --------
drop policy if exists profiles_self_sel on public.profiles;
create policy profiles_self_sel on public.profiles for select
  using (id = auth.uid()
         or exists (select 1 from public.organization_users ou
                    where ou.user_id = auth.uid() and ou.ativo
                      and ou.role = 'gestor'
                      and ou.organization_id in (
                        select organization_id from public.organization_users
                        where user_id = profiles.id)));
drop policy if exists profiles_self_upd on public.profiles;
create policy profiles_self_upd on public.profiles for update
  using (id = auth.uid()) with check (id = auth.uid());
drop policy if exists profiles_self_ins on public.profiles;
create policy profiles_self_ins on public.profiles for insert
  with check (id = auth.uid());

-- ---- organizations: membros leem; gestor edita -------------------------------
drop policy if exists org_sel on public.organizations;
create policy org_sel on public.organizations for select
  using (id in (select app.org_ids()));
drop policy if exists org_upd on public.organizations;
create policy org_upd on public.organizations for update
  using (app.has_role(id, array['gestor'])) with check (app.has_role(id, array['gestor']));

-- ---- organization_users: usuário vê seus vínculos; gestor gerencia -----------
drop policy if exists ou_sel on public.organization_users;
create policy ou_sel on public.organization_users for select
  using (user_id = auth.uid() or app.has_role(organization_id, array['gestor']));
drop policy if exists ou_all on public.organization_users;
create policy ou_all on public.organization_users for all
  using (app.has_role(organization_id, array['gestor']))
  with check (app.has_role(organization_id, array['gestor']));

-- ---- cadastros (hospitals/rooms/equipment): org lê; gestor escreve -----------
do $$
declare t text;
begin
  foreach t in array array['hospitals','rooms','equipment'] loop
    execute format('drop policy if exists %I_sel on public.%I', t, t);
    execute format($f$create policy %I_sel on public.%I for select
                     using (organization_id in (select app.org_ids()))$f$, t, t);
    execute format('drop policy if exists %I_wr on public.%I', t, t);
    execute format($f$create policy %I_wr on public.%I for all
                     using (app.has_role(organization_id, array['gestor']))
                     with check (app.has_role(organization_id, array['gestor']))$f$, t, t);
  end loop;
end $$;

-- ---- patients / encounters: org lê (clínico/admin); escrita p/ papéis ---------
drop policy if exists patients_sel on public.patients;
create policy patients_sel on public.patients for select
  using (organization_id in (select app.org_ids()));
drop policy if exists patients_wr on public.patients;
create policy patients_wr on public.patients for all
  using (app.has_role(organization_id, array['gestor','anestesiologista','auxiliar']))
  with check (app.has_role(organization_id, array['gestor','anestesiologista','auxiliar']));

drop policy if exists enc_sel on public.encounters;
create policy enc_sel on public.encounters for select
  using (organization_id in (select app.org_ids())
         and app.can_read_clinical(organization_id, surgeon_id));
drop policy if exists enc_wr on public.encounters;
create policy enc_wr on public.encounters for all
  using (app.has_role(organization_id, array['gestor','anestesiologista','auxiliar']))
  with check (app.has_role(organization_id, array['gestor','anestesiologista','auxiliar']));

-- ---- tabelas clínicas: leitura clínica (gestor/anest/cirurgião-próprio),
--      escrita gestor/anestesiologista. finance_entries à parte. --------------
do $$
declare t text;
  clin text[] := array['preanesthetic_assessments','anesthesia_records','recovery_records',
                       'risk_assessments','consents','prescriptions','documents'];
begin
  foreach t in array clin loop
    execute format('drop policy if exists %I_sel on public.%I', t, t);
    -- leitura: se a tabela tem encounter_id, deriva o cirurgião do encounter
    execute format($f$create policy %I_sel on public.%I for select
      using (organization_id in (select app.org_ids())
             and (
               app.has_role(organization_id, array['gestor','anestesiologista'])
               or exists (select 1 from public.encounters e
                          where e.id = %I.encounter_id
                            and e.surgeon_id = auth.uid())
             ))$f$, t, t, t);

    execute format('drop policy if exists %I_wr on public.%I', t, t);
    execute format($f$create policy %I_wr on public.%I for all
      using (app.can_write_clinical(organization_id))
      with check (app.can_write_clinical(organization_id))$f$, t, t);
  end loop;
end $$;

-- finance_entries: gestor/financeiro/anestesiologista (rascunho) ---------------
drop policy if exists fin_sel on public.finance_entries;
create policy fin_sel on public.finance_entries for select
  using (app.has_role(organization_id, array['gestor','financeiro','anestesiologista']));
drop policy if exists fin_wr on public.finance_entries;
create policy fin_wr on public.finance_entries for all
  using (app.has_role(organization_id, array['gestor','financeiro','anestesiologista']))
  with check (app.has_role(organization_id, array['gestor','financeiro','anestesiologista']));

-- timeline: segue o registro de anestesia (clínico) ---------------------------
drop policy if exists tl_sel on public.anesthesia_timeline_events;
create policy tl_sel on public.anesthesia_timeline_events for select
  using (organization_id in (select app.org_ids())
         and app.has_role(organization_id, array['gestor','anestesiologista']));
drop policy if exists tl_wr on public.anesthesia_timeline_events;
create policy tl_wr on public.anesthesia_timeline_events for all
  using (app.can_write_clinical(organization_id))
  with check (app.can_write_clinical(organization_id));

-- addenda: quem pode ler o clínico pode ler; escrita = clínico -----------------
drop policy if exists addenda_sel on public.addenda;
create policy addenda_sel on public.addenda for select
  using (organization_id in (select app.org_ids()));
drop policy if exists addenda_wr on public.addenda;
create policy addenda_wr on public.addenda for insert
  with check (app.can_write_clinical(organization_id));

-- attachments: org lê clínico; escrita = clínico/gestor ------------------------
drop policy if exists att_sel on public.attachments;
create policy att_sel on public.attachments for select
  using (organization_id in (select app.org_ids())
         and app.has_role(organization_id, array['gestor','anestesiologista','financeiro','auxiliar']));
drop policy if exists att_wr on public.attachments;
create policy att_wr on public.attachments for all
  using (app.has_role(organization_id, array['gestor','anestesiologista','auxiliar']))
  with check (app.has_role(organization_id, array['gestor','anestesiologista','auxiliar']));

-- templates / standard_texts: da org (compartilhados) OU do próprio dono -------
do $$
declare t text;
begin
  foreach t in array array['templates','standard_texts'] loop
    execute format('drop policy if exists %I_sel on public.%I', t, t);
    execute format($f$create policy %I_sel on public.%I for select
      using (organization_id in (select app.org_ids())
             and (owner_id is null or owner_id = auth.uid()
                  or coalesce((to_jsonb(%I.*)->>'compartilhado')::boolean, false)))$f$, t, t, t);
    execute format('drop policy if exists %I_wr on public.%I', t, t);
    execute format($f$create policy %I_wr on public.%I for all
      using (organization_id in (select app.org_ids())
             and (owner_id = auth.uid() or app.has_role(organization_id, array['gestor'])))
      with check (organization_id in (select app.org_ids())
             and (owner_id = auth.uid() or owner_id is null
                  or app.has_role(organization_id, array['gestor'])))$f$, t, t);
  end loop;
end $$;

-- audit_logs: gestor lê tudo da org; usuário lê o que ele mesmo gerou ----------
drop policy if exists audit_sel on public.audit_logs;
create policy audit_sel on public.audit_logs for select
  using (user_id = auth.uid()
         or app.has_role(organization_id, array['gestor']));
-- inserção é feita pelos triggers (security definer); sem policy de insert p/ clientes.

commit;

-- =============================================================================
-- FIM DA 0001. Rode em seguida:
--   * 0002_storage_realtime.sql (bucket privado + Realtime)
--   * o seed inicial (ver database/README.md): criar sua organização, seu
--     profile e o vínculo organization_users como 'gestor'.
-- =============================================================================
