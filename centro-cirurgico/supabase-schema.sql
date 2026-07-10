-- =====================================================================
--  Centro Cirúrgico — Esquema do banco de dados (Supabase / PostgreSQL)
--  Fuso horário de referência da aplicação: America/Bahia
--
--  Ordem de execução no Supabase:
--    1) supabase-schema.sql   (este arquivo)
--    2) supabase-rls.sql      (políticas de Row Level Security)
--
--  Observação: o esquema já nasce preparado para múltiplos centros
--  cirúrgicos (coluna surgical_center_id presente em todas as tabelas
--  relevantes), embora inicialmente exista apenas um centro.
-- =====================================================================

-- Extensões utilizadas ------------------------------------------------
create extension if not exists "pgcrypto";      -- gen_random_uuid()

-- =====================================================================
--  ENUMS
-- =====================================================================

-- Perfis / funções que um usuário pode exercer.
do $$
begin
  if not exists (select 1 from pg_type where typname = 'user_role') then
    create type public.user_role as enum (
      'gestor',
      'cirurgiao',
      'cirurgiao_auxiliar',
      'anestesiologista',
      'pediatra',
      'auxiliar',
      'empresa'
    );
  end if;
end$$;

-- Papel de um profissional dentro de um agendamento específico.
do $$
begin
  if not exists (select 1 from pg_type where typname = 'appointment_role') then
    create type public.appointment_role as enum (
      'cirurgiao_principal',
      'cirurgiao_adicional',
      'cirurgiao_auxiliar',
      'anestesiologista',
      'pediatra',
      'auxiliar',
      'empresa'
    );
  end if;
end$$;

-- Prioridade do procedimento.
do $$
begin
  if not exists (select 1 from pg_type where typname = 'appointment_priority') then
    create type public.appointment_priority as enum (
      'eletiva',
      'urgencia',
      'emergencia'
    );
  end if;
end$$;

-- Situação da resposta de disponibilidade do anestesiologista.
do $$
begin
  if not exists (select 1 from pg_type where typname = 'availability_answer') then
    create type public.availability_answer as enum (
      'pendente',
      'disponivel',
      'indisponivel'
    );
  end if;
end$$;

-- =====================================================================
--  TABELAS
-- =====================================================================

-- Centros cirúrgicos -------------------------------------------------
create table if not exists public.surgical_centers (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  time_zone     text not null default 'America/Bahia',
  active        boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- Perfis de usuário (1:1 com auth.users) -----------------------------
create table if not exists public.profiles (
  id                  uuid primary key references auth.users(id) on delete cascade,
  surgical_center_id  uuid not null references public.surgical_centers(id) on delete restrict,
  full_name           text not null,                 -- nome completo ou razão social
  email               text not null,
  phone_whatsapp      text,                           -- celular com WhatsApp (E.164 sem símbolos)
  registration_type   text,                           -- tipo de registro profissional (CRM, COREN, etc.)
  registration_number text,                           -- número do registro
  status              text not null default 'ativo'   -- 'ativo' | 'inativo'
                       check (status in ('ativo','inativo')),
  -- Campos exclusivos de empresa prestadora de serviço:
  is_company          boolean not null default false,
  company_trade_name  text,                           -- nome fantasia
  cnpj                text,                           -- opcional
  company_responsible text,                           -- nome do responsável
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index if not exists idx_profiles_center on public.profiles(surgical_center_id);

-- Funções do usuário (N:N) — permite múltiplas funções por usuário ---
create table if not exists public.user_roles (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.profiles(id) on delete cascade,
  role        public.user_role not null,
  created_at  timestamptz not null default now(),
  unique (user_id, role)
);
create index if not exists idx_user_roles_user on public.user_roles(user_id);

-- Salas cirúrgicas ---------------------------------------------------
create table if not exists public.rooms (
  id                  uuid primary key default gen_random_uuid(),
  surgical_center_id  uuid not null references public.surgical_centers(id) on delete cascade,
  name                text not null,
  description         text,
  sort_order          int not null default 0,
  active              boolean not null default true,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index if not exists idx_rooms_center on public.rooms(surgical_center_id);

-- Equipamentos -------------------------------------------------------
create table if not exists public.equipment (
  id                  uuid primary key default gen_random_uuid(),
  surgical_center_id  uuid not null references public.surgical_centers(id) on delete cascade,
  name                text not null,
  description         text,
  active              boolean not null default true,
  -- Quando verdadeiro, o equipamento não pode ser reservado por dois
  -- agendamentos com horários sobrepostos (exclusividade / uso único).
  block_simultaneous  boolean not null default false,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index if not exists idx_equipment_center on public.equipment(surgical_center_id);

-- Tipos de acomodação ------------------------------------------------
create table if not exists public.accommodation_types (
  id                  uuid primary key default gen_random_uuid(),
  surgical_center_id  uuid not null references public.surgical_centers(id) on delete cascade,
  name                text not null,
  active              boolean not null default true,
  created_at          timestamptz not null default now()
);
create index if not exists idx_accommodation_center on public.accommodation_types(surgical_center_id);

-- Status configuráveis dos agendamentos ------------------------------
create table if not exists public.appointment_statuses (
  id                  uuid primary key default gen_random_uuid(),
  surgical_center_id  uuid not null references public.surgical_centers(id) on delete cascade,
  name                text not null,
  color               text not null default '#3b82f6',
  sort_order          int not null default 0,
  is_default          boolean not null default false,
  active              boolean not null default true,
  created_at          timestamptz not null default now()
);
create index if not exists idx_status_center on public.appointment_statuses(surgical_center_id);

-- Matriz de permissões de edição (definida pelo gestor) --------------
-- Define, por função, quais campos/ações o usuário associado pode editar.
create table if not exists public.permission_matrix (
  id                  uuid primary key default gen_random_uuid(),
  surgical_center_id  uuid not null references public.surgical_centers(id) on delete cascade,
  role                public.user_role not null,
  can_edit_appointment boolean not null default false,
  can_edit_fields     jsonb not null default '[]'::jsonb, -- lista de campos editáveis
  can_upload_files    boolean not null default false,
  can_delete_files    boolean not null default false,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (surgical_center_id, role)
);

-- Configurações gerais do centro (agenda, WhatsApp, etc.) ------------
create table if not exists public.center_settings (
  surgical_center_id  uuid primary key references public.surgical_centers(id) on delete cascade,
  slot_minutes        int not null default 30
                       check (slot_minutes in (10,15,20,30,60)),
  opening_time        time not null default '07:00',
  closing_time        time not null default '19:00',
  require_authorization boolean not null default true, -- senha de autorização obrigatória
  allow_auth_not_applicable boolean not null default false, -- habilita "Não se aplica"
  whatsapp_enabled    boolean not null default false,   -- integração automática ativa
  whatsapp_template   text not null default
    'Olá, {nome}. Existe uma atualização em um procedimento no Centro Cirúrgico para {data}, das {hora_inicial} às {hora_final}. Acesse o sistema para consultar os detalhes.',
  updated_at          timestamptz not null default now()
);

-- Agendamentos -------------------------------------------------------
create table if not exists public.appointments (
  id                    uuid primary key default gen_random_uuid(),
  surgical_center_id    uuid not null references public.surgical_centers(id) on delete cascade,
  room_id               uuid not null references public.rooms(id) on delete restrict,

  -- Dados do paciente (sensíveis)
  patient_name          text not null,
  patient_birthdate     date,
  patient_cpf           text,
  patient_insurance_card text,
  insurance_name        text,                              -- convênio (opcional)
  accommodation_type_id uuid references public.accommodation_types(id),
  authorization_password text,                             -- senha de autorização do plano
  authorization_not_applicable boolean not null default false,

  -- Dados do procedimento
  procedure_name        text not null,
  appointment_date      date not null,
  start_time            time not null,
  end_time              time not null,
  status_id             uuid references public.appointment_statuses(id),
  priority              public.appointment_priority not null default 'eletiva',
  needs_pediatrician    boolean not null default false,
  needs_company         boolean not null default false,
  needs_uti             boolean not null default false,   -- requisito especial: UTI
  needs_hemoba          boolean not null default false,   -- requisito especial: HEMOBA
  latex_allergy         boolean not null default false,   -- requisito especial: alergia a látex
  special_notes         text,                              -- observação livre dos requisitos especiais
  notes                 text,                              -- observações operacionais

  -- Cirurgião principal (também replicado em appointment_professionals)
  surgeon_id            uuid references public.profiles(id),

  -- Auditoria básica
  created_by            uuid references public.profiles(id),
  updated_by            uuid references public.profiles(id),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),

  constraint chk_times check (end_time > start_time),
  constraint chk_patient_id check (
    coalesce(patient_cpf,'') <> '' or coalesce(patient_insurance_card,'') <> ''
  )
);
create index if not exists idx_appt_center on public.appointments(surgical_center_id);
create index if not exists idx_appt_room_date on public.appointments(room_id, appointment_date);
create index if not exists idx_appt_date on public.appointments(appointment_date);
create index if not exists idx_appt_surgeon on public.appointments(surgeon_id);
create index if not exists idx_appt_created_by on public.appointments(created_by);

-- Profissionais / empresas associados ao agendamento -----------------
create table if not exists public.appointment_professionals (
  id              uuid primary key default gen_random_uuid(),
  appointment_id  uuid not null references public.appointments(id) on delete cascade,
  user_id         uuid not null references public.profiles(id) on delete cascade,
  role            public.appointment_role not null,
  created_at      timestamptz not null default now(),
  unique (appointment_id, user_id, role)
);
create index if not exists idx_appt_prof_appt on public.appointment_professionals(appointment_id);
create index if not exists idx_appt_prof_user on public.appointment_professionals(user_id);

-- Equipamentos reservados para o agendamento -------------------------
create table if not exists public.appointment_equipment (
  id              uuid primary key default gen_random_uuid(),
  appointment_id  uuid not null references public.appointments(id) on delete cascade,
  equipment_id    uuid not null references public.equipment(id) on delete restrict,
  quantity        int not null default 1 check (quantity > 0),
  created_at      timestamptz not null default now(),
  unique (appointment_id, equipment_id)
);
create index if not exists idx_appt_equip_appt on public.appointment_equipment(appointment_id);

-- Arquivos anexados (metadados; o binário fica no Storage) -----------
create table if not exists public.appointment_files (
  id              uuid primary key default gen_random_uuid(),
  appointment_id  uuid not null references public.appointments(id) on delete cascade,
  storage_path    text not null unique,   -- caminho no bucket 'appointment-files'
  file_name       text not null,
  file_type       text not null,          -- image/jpeg, image/png, application/pdf
  file_size       bigint,
  uploaded_by     uuid references public.profiles(id),
  uploaded_at     timestamptz not null default now()
);
create index if not exists idx_appt_files_appt on public.appointment_files(appointment_id);

-- Bloqueios de salas -------------------------------------------------
create table if not exists public.room_blocks (
  id                  uuid primary key default gen_random_uuid(),
  surgical_center_id  uuid not null references public.surgical_centers(id) on delete cascade,
  room_id             uuid references public.rooms(id) on delete cascade, -- null = todas as salas
  block_date          date not null,
  start_time          time not null,
  end_time            time not null,
  reason              text,
  -- Bloqueio direcionado: quando preenchido, o horário fica reservado
  -- exclusivamente para este usuário — só ele pode agendar nele; para
  -- os demais o horário aparece como bloqueado.
  reserved_user_id    uuid references public.profiles(id) on delete cascade,
  created_by          uuid references public.profiles(id),
  created_at          timestamptz not null default now(),
  constraint chk_block_times check (end_time > start_time)
);
create index if not exists idx_block_center_date on public.room_blocks(surgical_center_id, block_date);
create index if not exists idx_block_room_date on public.room_blocks(room_id, block_date);

-- Solicitações confidenciais de disponibilidade (anestesiologista) ---
create table if not exists public.availability_requests (
  id                  uuid primary key default gen_random_uuid(),
  surgical_center_id  uuid not null references public.surgical_centers(id) on delete cascade,
  appointment_id      uuid references public.appointments(id) on delete set null,
  target_role         public.user_role not null default 'anestesiologista',
  request_date        date not null,
  start_time          time,
  end_time            time,
  message             text,
  created_by          uuid references public.profiles(id),
  created_at          timestamptz not null default now()
);
create index if not exists idx_avreq_center on public.availability_requests(surgical_center_id);

create table if not exists public.availability_responses (
  id              uuid primary key default gen_random_uuid(),
  request_id      uuid not null references public.availability_requests(id) on delete cascade,
  responder_id    uuid not null references public.profiles(id) on delete cascade,
  answer          public.availability_answer not null default 'pendente',
  message         text,
  responded_at    timestamptz not null default now(),
  unique (request_id, responder_id)
);
create index if not exists idx_avresp_request on public.availability_responses(request_id);
create index if not exists idx_avresp_responder on public.availability_responses(responder_id);

-- Indisponibilidade informada pelo próprio usuário -------------------
create table if not exists public.unavailability (
  id                  uuid primary key default gen_random_uuid(),
  surgical_center_id  uuid not null references public.surgical_centers(id) on delete cascade,
  user_id             uuid not null references public.profiles(id) on delete cascade,
  start_datetime      timestamptz not null,
  end_datetime        timestamptz not null,
  reason              text,
  created_at          timestamptz not null default now(),
  constraint chk_unavail_range check (end_datetime > start_datetime)
);
create index if not exists idx_unavail_user on public.unavailability(user_id);

-- Notificações internas ----------------------------------------------
create table if not exists public.notifications (
  id                  uuid primary key default gen_random_uuid(),
  surgical_center_id  uuid not null references public.surgical_centers(id) on delete cascade,
  user_id             uuid not null references public.profiles(id) on delete cascade,
  title               text not null,
  body                text,
  type                text not null default 'geral',
  related_appointment_id uuid references public.appointments(id) on delete set null,
  is_read             boolean not null default false,
  created_at          timestamptz not null default now()
);
create index if not exists idx_notif_user on public.notifications(user_id, is_read);

-- Registro completo de alterações (auditoria) ------------------------
create table if not exists public.audit_log (
  id                  uuid primary key default gen_random_uuid(),
  surgical_center_id  uuid references public.surgical_centers(id) on delete set null,
  table_name          text not null,
  record_id           uuid,
  action              text not null,          -- INSERT | UPDATE | DELETE
  changed_by          uuid references public.profiles(id),
  justification       text,                   -- justificativa de alteração excepcional
  old_data            jsonb,
  new_data            jsonb,
  created_at          timestamptz not null default now()
);
create index if not exists idx_audit_record on public.audit_log(table_name, record_id);
create index if not exists idx_audit_center on public.audit_log(surgical_center_id);

-- =====================================================================
--  FUNÇÕES AUXILIARES (usadas por RLS e pela aplicação)
-- =====================================================================

-- Centro cirúrgico do usuário autenticado.
create or replace function public.current_center_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select surgical_center_id from public.profiles where id = auth.uid();
$$;

-- Usuário autenticado é gestor?
create or replace function public.is_gestor()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.user_roles
    where user_id = auth.uid() and role = 'gestor'
  );
$$;

-- Usuário autenticado está ativo?
create or replace function public.is_active_user()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select status = 'ativo' from public.profiles where id = auth.uid()),
    false
  );
$$;

-- O usuário autenticado está associado ao agendamento?
-- Associado = criador, cirurgião principal, ou consta em appointment_professionals.
create or replace function public.is_associated(p_appointment_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.appointments a
    where a.id = p_appointment_id
      and (a.created_by = auth.uid() or a.surgeon_id = auth.uid())
  )
  or exists (
    select 1 from public.appointment_professionals ap
    where ap.appointment_id = p_appointment_id
      and ap.user_id = auth.uid()
  );
$$;

-- =====================================================================
--  VERIFICAÇÃO DE CONFLITOS (função PostgreSQL segura)
--  Retorna verdadeiro quando há sobreposição de horário na mesma sala
--  (ignorando o próprio agendamento em edição) ou um bloqueio ativo.
-- =====================================================================
create or replace function public.check_appointment_conflict(
  p_room_id       uuid,
  p_date          date,
  p_start_time    time,
  p_end_time      time,
  p_exclude_id    uuid default null
)
returns table (
  conflict_type text,   -- 'agendamento' | 'bloqueio'
  conflict_id   uuid,
  start_time    time,
  end_time      time
)
language sql
stable
security definer
set search_path = public
as $$
  -- Conflito com outros agendamentos na mesma sala/data
  select 'agendamento'::text, a.id, a.start_time, a.end_time
  from public.appointments a
  where a.room_id = p_room_id
    and a.appointment_date = p_date
    and (p_exclude_id is null or a.id <> p_exclude_id)
    and a.start_time < p_end_time
    and a.end_time   > p_start_time
  union all
  -- Conflito com bloqueios (da sala específica ou de todas as salas).
  -- Bloqueios direcionados a um usuário NÃO conflitam para o próprio
  -- usuário reservado — apenas ele pode agendar naquele horário.
  select 'bloqueio'::text, b.id, b.start_time, b.end_time
  from public.room_blocks b
  where b.block_date = p_date
    and (b.room_id = p_room_id or b.room_id is null)
    and b.start_time < p_end_time
    and b.end_time   > p_start_time
    and (b.reserved_user_id is null or b.reserved_user_id <> auth.uid())
    and b.surgical_center_id = (
      select surgical_center_id from public.rooms where id = p_room_id
    );
$$;

-- =====================================================================
--  VERIFICAÇÃO DE CONFLITO DE EQUIPAMENTO
--  Retorna os equipamentos marcados como exclusivos (block_simultaneous)
--  que já estão reservados por outro agendamento com horário sobreposto,
--  em qualquer sala do centro. Usado para impedir uso simultâneo.
-- =====================================================================
create or replace function public.check_equipment_conflict(
  p_date          date,
  p_start_time    time,
  p_end_time      time,
  p_equipment_ids uuid[],
  p_exclude_id    uuid default null
)
returns table (
  equipment_id   uuid,
  equipment_name text,
  start_time     time,
  end_time       time
)
language sql
stable
security definer
set search_path = public
as $$
  select distinct e.id, e.name, a.start_time, a.end_time
  from public.appointment_equipment ae
  join public.appointments a on a.id = ae.appointment_id
  join public.equipment e on e.id = ae.equipment_id
  where e.block_simultaneous = true
    and ae.equipment_id = any(p_equipment_ids)
    and a.appointment_date = p_date
    and (p_exclude_id is null or a.id <> p_exclude_id)
    and a.start_time < p_end_time
    and a.end_time   > p_start_time;
$$;

-- =====================================================================
--  OCUPAÇÃO PÚBLICA (visão neutra e anônima)
--  Qualquer usuário autenticado do centro pode ver salas ocupadas ou
--  bloqueadas, SEM qualquer dado sensível. Não revela paciente,
--  procedimento, profissionais, equipamentos, arquivos, etc.
-- =====================================================================
create or replace function public.get_occupancy(
  p_date_from date,
  p_date_to   date
)
returns table (
  anon_id     text,
  room_id     uuid,
  occ_date    date,
  start_time  time,
  end_time    time,
  situation   text   -- 'ocupado' | 'bloqueado'
)
language sql
stable
security definer
set search_path = public
as $$
  with center as (
    select public.current_center_id() as id
  )
  select
    'occ-' || md5(a.id::text) as anon_id,
    a.room_id,
    a.appointment_date as occ_date,
    a.start_time,
    a.end_time,
    'ocupado'::text as situation
  from public.appointments a, center c
  where a.surgical_center_id = c.id
    and a.appointment_date between p_date_from and p_date_to
  union all
  select
    'blk-' || md5(b.id::text) as anon_id,
    b.room_id,
    b.block_date as occ_date,
    b.start_time,
    b.end_time,
    -- Para o usuário reservado, o bloqueio direcionado aparece como
    -- 'reservado' (ele pode agendar); para os demais, 'bloqueado'.
    case when b.reserved_user_id = auth.uid() then 'reservado' else 'bloqueado' end as situation
  from public.room_blocks b, center c
  where b.surgical_center_id = c.id
    and b.block_date between p_date_from and p_date_to;
$$;

-- =====================================================================
--  TRIGGERS: updated_at automático
-- =====================================================================
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

do $$
declare t text;
begin
  foreach t in array array[
    'surgical_centers','profiles','rooms','equipment',
    'permission_matrix','appointments'
  ]
  loop
    execute format(
      'drop trigger if exists trg_updated_at on public.%I;', t);
    execute format(
      'create trigger trg_updated_at before update on public.%I
         for each row execute function public.set_updated_at();', t);
  end loop;
end$$;

-- =====================================================================
--  TRIGGERS: auditoria de agendamentos e bloqueios
-- =====================================================================
create or replace function public.audit_appointments()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_center uuid;
  v_record uuid;
begin
  if (tg_op = 'DELETE') then
    v_center := old.surgical_center_id;
    v_record := old.id;
  else
    v_center := new.surgical_center_id;
    v_record := new.id;
  end if;

  insert into public.audit_log(
    surgical_center_id, table_name, record_id, action,
    changed_by, justification, old_data, new_data
  ) values (
    v_center, tg_table_name, v_record, tg_op,
    auth.uid(),
    case when tg_op <> 'DELETE'
         then nullif(current_setting('app.justification', true), '')
         else null end,
    case when tg_op <> 'INSERT' then to_jsonb(old) else null end,
    case when tg_op <> 'DELETE' then to_jsonb(new) else null end
  );

  if (tg_op = 'DELETE') then return old; else return new; end if;
end;
$$;

drop trigger if exists trg_audit_appointments on public.appointments;
create trigger trg_audit_appointments
  after insert or update or delete on public.appointments
  for each row execute function public.audit_appointments();

drop trigger if exists trg_audit_blocks on public.room_blocks;
create trigger trg_audit_blocks
  after insert or update or delete on public.room_blocks
  for each row execute function public.audit_appointments();

-- =====================================================================
--  TRIGGER: notificação interna aos profissionais associados
--  Ao inserir/atualizar um agendamento, gera notificações para os
--  profissionais vinculados (exceto quem realizou a ação).
-- =====================================================================
create or replace function public.notify_associated()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_title text;
begin
  v_title := case when tg_op = 'INSERT'
                  then 'Novo procedimento agendado'
                  else 'Procedimento atualizado' end;

  insert into public.notifications(surgical_center_id, user_id, title, body, type, related_appointment_id)
  select distinct new.surgical_center_id, u.user_id, v_title,
         'Procedimento em ' || to_char(new.appointment_date,'DD/MM/YYYY') ||
         ' das ' || to_char(new.start_time,'HH24:MI') ||
         ' às '  || to_char(new.end_time,'HH24:MI') || '.',
         'agendamento', new.id
  from (
    select ap.user_id from public.appointment_professionals ap where ap.appointment_id = new.id
    union
    select new.surgeon_id where new.surgeon_id is not null
  ) u
  where u.user_id is not null
    and u.user_id <> coalesce(auth.uid(), '00000000-0000-0000-0000-000000000000');

  -- Todo NOVO agendamento gera uma notificação para o(s) gestor(es) do centro.
  if tg_op = 'INSERT' then
    insert into public.notifications(surgical_center_id, user_id, title, body, type, related_appointment_id)
    select new.surgical_center_id, ur.user_id, 'Novo agendamento criado',
           'Novo procedimento em ' || to_char(new.appointment_date,'DD/MM/YYYY') ||
           ' das ' || to_char(new.start_time,'HH24:MI') ||
           ' às '  || to_char(new.end_time,'HH24:MI') || '.',
           'agendamento', new.id
    from public.user_roles ur
    join public.profiles p on p.id = ur.user_id
    where ur.role = 'gestor'
      and p.surgical_center_id = new.surgical_center_id
      and ur.user_id <> coalesce(auth.uid(), '00000000-0000-0000-0000-000000000000');
  end if;

  return new;
end;
$$;

drop trigger if exists trg_notify_associated on public.appointments;
create trigger trg_notify_associated
  after insert or update on public.appointments
  for each row execute function public.notify_associated();

-- =====================================================================
--  RPC: criar/atualizar agendamento com verificação de conflito e
--  registro de justificativa (chamada pela aplicação).
--  Faz a checagem de conflito no servidor e grava a justificativa
--  para a trigger de auditoria via GUC app.justification.
-- =====================================================================
create or replace function public.save_appointment(
  p_payload       jsonb,
  p_justification text default null
)
returns uuid
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_id            uuid := nullif(p_payload->>'id','')::uuid;
  v_room          uuid := (p_payload->>'room_id')::uuid;
  v_date          date := (p_payload->>'appointment_date')::date;
  v_start         time := (p_payload->>'start_time')::time;
  v_end           time := (p_payload->>'end_time')::time;
  v_center        uuid := public.current_center_id();
  v_conflict      record;
  v_equip_ids     uuid[];
  v_eq_conflict   record;
begin
  -- Registra a justificativa para a trigger de auditoria.
  perform set_config('app.justification', coalesce(p_justification,''), true);

  -- Verificação de conflito de sala/bloqueio no servidor (fonte da verdade).
  select * into v_conflict
  from public.check_appointment_conflict(v_room, v_date, v_start, v_end, v_id)
  limit 1;

  if found then
    raise exception 'CONFLITO: % das % às %',
      v_conflict.conflict_type, v_conflict.start_time, v_conflict.end_time
      using errcode = 'P0001';
  end if;

  -- Verificação de conflito de equipamento exclusivo (uso simultâneo).
  if p_payload ? 'equipment' then
    select array_agg((e->>'equipment_id')::uuid)
      into v_equip_ids
      from jsonb_array_elements(p_payload->'equipment') e
      where nullif(e->>'equipment_id','') is not null;
  end if;

  if v_equip_ids is not null and array_length(v_equip_ids, 1) > 0 then
    select * into v_eq_conflict
    from public.check_equipment_conflict(v_date, v_start, v_end, v_equip_ids, v_id)
    limit 1;

    if found then
      raise exception 'EQUIP_CONFLITO: % (ocupado das % às %)',
        v_eq_conflict.equipment_name, v_eq_conflict.start_time, v_eq_conflict.end_time
        using errcode = 'P0001';
    end if;
  end if;

  if v_id is null then
    insert into public.appointments(
      surgical_center_id, room_id, patient_name, patient_birthdate, patient_cpf,
      patient_insurance_card, insurance_name, accommodation_type_id,
      authorization_password, authorization_not_applicable, procedure_name,
      appointment_date, start_time, end_time, status_id, priority,
      needs_pediatrician, needs_company, needs_uti, needs_hemoba, latex_allergy,
      special_notes, notes, surgeon_id, created_by, updated_by
    ) values (
      v_center, v_room,
      p_payload->>'patient_name',
      nullif(p_payload->>'patient_birthdate','')::date,
      nullif(p_payload->>'patient_cpf',''),
      nullif(p_payload->>'patient_insurance_card',''),
      nullif(p_payload->>'insurance_name',''),
      nullif(p_payload->>'accommodation_type_id','')::uuid,
      nullif(p_payload->>'authorization_password',''),
      coalesce((p_payload->>'authorization_not_applicable')::boolean, false),
      p_payload->>'procedure_name',
      v_date, v_start, v_end,
      nullif(p_payload->>'status_id','')::uuid,
      coalesce((p_payload->>'priority')::public.appointment_priority,'eletiva'),
      coalesce((p_payload->>'needs_pediatrician')::boolean,false),
      coalesce((p_payload->>'needs_company')::boolean,false),
      coalesce((p_payload->>'needs_uti')::boolean,false),
      coalesce((p_payload->>'needs_hemoba')::boolean,false),
      coalesce((p_payload->>'latex_allergy')::boolean,false),
      nullif(p_payload->>'special_notes',''),
      nullif(p_payload->>'notes',''),
      nullif(p_payload->>'surgeon_id','')::uuid,
      auth.uid(), auth.uid()
    ) returning id into v_id;
  else
    update public.appointments set
      room_id                = v_room,
      patient_name           = p_payload->>'patient_name',
      patient_birthdate      = nullif(p_payload->>'patient_birthdate','')::date,
      patient_cpf            = nullif(p_payload->>'patient_cpf',''),
      patient_insurance_card = nullif(p_payload->>'patient_insurance_card',''),
      insurance_name         = nullif(p_payload->>'insurance_name',''),
      accommodation_type_id  = nullif(p_payload->>'accommodation_type_id','')::uuid,
      authorization_password = nullif(p_payload->>'authorization_password',''),
      authorization_not_applicable = coalesce((p_payload->>'authorization_not_applicable')::boolean,false),
      procedure_name         = p_payload->>'procedure_name',
      appointment_date       = v_date,
      start_time             = v_start,
      end_time               = v_end,
      status_id              = nullif(p_payload->>'status_id','')::uuid,
      priority               = coalesce((p_payload->>'priority')::public.appointment_priority,'eletiva'),
      needs_pediatrician     = coalesce((p_payload->>'needs_pediatrician')::boolean,false),
      needs_company          = coalesce((p_payload->>'needs_company')::boolean,false),
      needs_uti              = coalesce((p_payload->>'needs_uti')::boolean,false),
      needs_hemoba           = coalesce((p_payload->>'needs_hemoba')::boolean,false),
      latex_allergy          = coalesce((p_payload->>'latex_allergy')::boolean,false),
      special_notes          = nullif(p_payload->>'special_notes',''),
      notes                  = nullif(p_payload->>'notes',''),
      surgeon_id             = nullif(p_payload->>'surgeon_id','')::uuid,
      updated_by             = auth.uid()
    where id = v_id;
  end if;

  -- Regrava profissionais associados, se informados.
  if p_payload ? 'professionals' then
    delete from public.appointment_professionals where appointment_id = v_id;
    insert into public.appointment_professionals(appointment_id, user_id, role)
    select v_id, (e->>'user_id')::uuid, (e->>'role')::public.appointment_role
    from jsonb_array_elements(p_payload->'professionals') e
    where nullif(e->>'user_id','') is not null;
  end if;

  -- Regrava equipamentos, se informados.
  if p_payload ? 'equipment' then
    delete from public.appointment_equipment where appointment_id = v_id;
    insert into public.appointment_equipment(appointment_id, equipment_id, quantity)
    select v_id, (e->>'equipment_id')::uuid, coalesce((e->>'quantity')::int,1)
    from jsonb_array_elements(p_payload->'equipment') e
    where nullif(e->>'equipment_id','') is not null;
  end if;

  return v_id;
end;
$$;

-- =====================================================================
--  SEED / BOOTSTRAP: primeiro centro cirúrgico + configurações padrão
--  (Ajuste o nome conforme necessário. Executado apenas se vazio.)
-- =====================================================================
do $$
declare
  v_center uuid;
begin
  if not exists (select 1 from public.surgical_centers) then
    insert into public.surgical_centers(name) values ('Centro Cirúrgico')
      returning id into v_center;

    insert into public.center_settings(surgical_center_id) values (v_center);

    insert into public.appointment_statuses(surgical_center_id, name, color, sort_order, is_default)
    values
      (v_center,'Agendado','#3b82f6',1,true),
      (v_center,'Confirmado','#10b981',2,false),
      (v_center,'Em andamento','#f59e0b',3,false),
      (v_center,'Concluído','#6b7280',4,false),
      (v_center,'Cancelado','#ef4444',5,false);

    insert into public.accommodation_types(surgical_center_id, name)
    values (v_center,'Enfermaria'),(v_center,'Apartamento'),(v_center,'UTI');

    insert into public.rooms(surgical_center_id, name, sort_order)
    values (v_center,'Sala 1',1),(v_center,'Sala 2',2),(v_center,'Sala 3',3);

    -- Matriz de permissões padrão (edição desabilitada; gestor ajusta).
    insert into public.permission_matrix(surgical_center_id, role)
    values
      (v_center,'cirurgiao'),
      (v_center,'cirurgiao_auxiliar'),
      (v_center,'anestesiologista'),
      (v_center,'pediatra'),
      (v_center,'auxiliar'),
      (v_center,'empresa');
  end if;
end$$;

-- =====================================================================
--  FIM DO ESQUEMA
-- =====================================================================
