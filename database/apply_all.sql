-- ############################################################################
-- Soft Anestesia — APLICAR TUDO (0001 + 0002 + SEED) — copie e cole no SQL Editor
-- Rode uma vez. É idempotente (pode rodar de novo sem estragar nada).
-- O SEED (no fim) já está com o e-mail do gestor: mpcaliman@hotmail.com
-- (a conta precisa existir em Authentication > Users).
-- ############################################################################

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

-- Permite criar funções SQL que referenciam tabelas criadas mais adiante nesta
-- mesma migração (forward references). Sem isso, funções `language sql` falham
-- na criação porque o Postgres valida o corpo imediatamente.
set local check_function_bodies = off;

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


-- =============================================================================
-- Soft Anestesia — Migração 0002: Storage (anexos) + Realtime
-- =============================================================================
-- Rode DEPOIS da 0001. Idempotente.
--
-- Storage: bucket PRIVADO para anexos clínicos. O binário NUNCA é público;
-- o app gera signed URLs sob demanda. O caminho segue o padrão:
--   {organization_id}/{patient_id}/{encounter_id}/{module}/{filename}
-- A 1ª pasta (organization_id) é usada nas policies para isolar por organização.
-- =============================================================================

-- 1) Bucket privado ----------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('clinical-attachments', 'clinical-attachments', false)
on conflict (id) do nothing;

-- 2) Policies de Storage (por organização) -----------------------------------
-- A pasta raiz do objeto = organization_id. Só membros da org acessam.

drop policy if exists clin_att_sel on storage.objects;
create policy clin_att_sel on storage.objects for select
  using (
    bucket_id = 'clinical-attachments'
    and (storage.foldername(name))[1]::uuid in (select app.org_ids())
  );

drop policy if exists clin_att_ins on storage.objects;
create policy clin_att_ins on storage.objects for insert
  with check (
    bucket_id = 'clinical-attachments'
    and (storage.foldername(name))[1]::uuid in (select app.org_ids())
    and app.has_role((storage.foldername(name))[1]::uuid,
                     array['gestor','anestesiologista','auxiliar'])
  );

drop policy if exists clin_att_upd on storage.objects;
create policy clin_att_upd on storage.objects for update
  using (
    bucket_id = 'clinical-attachments'
    and (storage.foldername(name))[1]::uuid in (select app.org_ids())
    and app.has_role((storage.foldername(name))[1]::uuid,
                     array['gestor','anestesiologista','auxiliar'])
  );

drop policy if exists clin_att_del on storage.objects;
create policy clin_att_del on storage.objects for delete
  using (
    bucket_id = 'clinical-attachments'
    and app.has_role((storage.foldername(name))[1]::uuid, array['gestor'])
  );

-- 3) Realtime ----------------------------------------------------------------
-- Publica as tabelas que precisam de edição ao vivo / "outro usuário editando".
-- (idempotente: só adiciona se ainda não estiver na publicação)
do $$
declare
  t text;
  alvo text[] := array[
    'encounters','preanesthetic_assessments','anesthesia_records',
    'anesthesia_timeline_events','recovery_records','finance_entries','patients'
  ];
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
  foreach t in array alvo loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
    -- REPLICA IDENTITY FULL: envia a linha antiga também (útil p/ diffs/conflitos)
    execute format('alter table public.%I replica identity full', t);
  end loop;
end $$;


-- =============================================================================
-- SEED INICIAL — já preenchido com o e-mail do gestor.
-- Requisito: essa conta já precisa existir no Supabase Auth
-- (Authentication → Users). É a conta de e-mail com que você entra no app.
-- =============================================================================
do $$
declare
  v_uid   uuid;
  v_org   uuid;
  v_email text := 'mpcaliman@hotmail.com';
begin
  select id into v_uid from auth.users where lower(email) = lower(v_email);
  if v_uid is null then
    raise exception 'Nenhum usuário no Auth com o e-mail %. Crie/entre com essa conta primeiro (Authentication > Users) e rode o seed de novo.', v_email;
  end if;

  select organization_id into v_org from public.organization_users where user_id = v_uid limit 1;
  if v_org is null then
    insert into public.organizations(nome, ativo)
      values ('Minha Clínica de Anestesia', true) returning id into v_org;
  end if;

  insert into public.organization_users(organization_id, user_id, role, ativo)
    values (v_org, v_uid, 'gestor', true)
    on conflict (organization_id, user_id, role) do update set ativo = true;

  insert into public.profiles(id, nome, email, funcao, ativo)
    values (v_uid, coalesce((select raw_user_meta_data->>'name' from auth.users where id = v_uid), v_email), v_email, 'gestor', true)
    on conflict (id) do update set funcao = 'gestor', ativo = true, email = excluded.email;

  raise notice 'OK: organizacao % e usuario % vinculados como gestor.', v_org, v_email;
end $$;

-- ==============================================================================
-- 0003 — alvos e idempotência para a migração de dados (Fase 4)
-- ==============================================================================
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

-- ==============================================================================
-- 0004 — índice único de anexos (idempotência)
-- ==============================================================================
-- =============================================================================
-- Soft Anestesia — Migração 0004: índice único de anexos (idempotência)
-- =============================================================================
-- Rode DEPOIS da 0001–0003. Idempotente e aditiva.
--
-- Permite registrar os metadados dos anexos (que já vão para o Storage) na
-- tabela public.attachments de forma IDEMPOTENTE: um upsert por storage_path
-- não duplica se o mesmo anexo for registrado de novo ao salvar o registro.
-- =============================================================================

begin;

create unique index if not exists ux_attachments_org_path
  on public.attachments(organization_id, storage_path);

commit;

-- ==============================================================================
-- 0005 — idempotência de adendos
-- ==============================================================================
-- =============================================================================
-- Soft Anestesia — Migração 0005: idempotência de adendos
-- =============================================================================
-- Rode DEPOIS da 0001–0004. Idempotente e aditiva.
--
-- Adendos (correções em registros finalizados) são APPEND-ONLY. Para o app
-- poder reenviar sem duplicar (offline/multi-aparelho), cada adendo carrega um
-- legacy_id (UUID gerado no app) com índice único. O envio usa
-- ON CONFLICT DO NOTHING (Prefer: resolution=ignore-duplicates), compatível
-- com a policy de INSERT-only da tabela.
-- =============================================================================

begin;

alter table public.addenda add column if not exists legacy_id text;
create unique index if not exists ux_addenda_org_legacy
  on public.addenda(organization_id, legacy_id);

commit;

-- ==============================================================================
-- 0006 — RPC de gestão da equipe (add_member)
-- ==============================================================================
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
