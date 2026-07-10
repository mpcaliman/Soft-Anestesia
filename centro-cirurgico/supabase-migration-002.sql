-- =====================================================================
--  Migração 002 — Requisitos especiais, notificação ao gestor,
--  bloqueio direcionado por usuário e exclusividade de equipamento.
--
--  Aplique este arquivo em bancos que já executaram a versão inicial
--  (supabase-schema.sql). Para instalações novas, o supabase-schema.sql
--  já contém tudo — não é necessário rodar esta migração.
--
--  Idempotente: pode ser executado mais de uma vez com segurança.
-- =====================================================================

-- 1) Requisitos especiais e observação livre no agendamento ----------
alter table public.appointments
  add column if not exists needs_uti     boolean not null default false,
  add column if not exists needs_hemoba  boolean not null default false,
  add column if not exists latex_allergy boolean not null default false,
  add column if not exists special_notes text;

-- 2) Exclusividade de equipamento (bloqueia uso simultâneo) ----------
alter table public.equipment
  add column if not exists block_simultaneous boolean not null default false;

-- 3) Bloqueio de sala direcionado a um usuário -----------------------
alter table public.room_blocks
  add column if not exists reserved_user_id uuid references public.profiles(id) on delete cascade;

-- 4) Conflito de sala/bloqueio: respeita bloqueio direcionado --------
create or replace function public.check_appointment_conflict(
  p_room_id       uuid,
  p_date          date,
  p_start_time    time,
  p_end_time      time,
  p_exclude_id    uuid default null
)
returns table (
  conflict_type text,
  conflict_id   uuid,
  start_time    time,
  end_time      time
)
language sql
stable
security definer
set search_path = public
as $$
  select 'agendamento'::text, a.id, a.start_time, a.end_time
  from public.appointments a
  where a.room_id = p_room_id
    and a.appointment_date = p_date
    and (p_exclude_id is null or a.id <> p_exclude_id)
    and a.start_time < p_end_time
    and a.end_time   > p_start_time
  union all
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

-- 5) Conflito de equipamento exclusivo -------------------------------
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

-- 6) Ocupação: marca bloqueio direcionado como 'reservado' ao dono ---
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
  situation   text
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
    case when b.reserved_user_id = auth.uid() then 'reservado' else 'bloqueado' end as situation
  from public.room_blocks b, center c
  where b.surgical_center_id = c.id
    and b.block_date between p_date_from and p_date_to;
$$;

-- 7) Gravação: novos campos + verificação de equipamento -------------
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
  perform set_config('app.justification', coalesce(p_justification,''), true);

  select * into v_conflict
  from public.check_appointment_conflict(v_room, v_date, v_start, v_end, v_id)
  limit 1;
  if found then
    raise exception 'CONFLITO: % das % às %',
      v_conflict.conflict_type, v_conflict.start_time, v_conflict.end_time
      using errcode = 'P0001';
  end if;

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

  if p_payload ? 'professionals' then
    delete from public.appointment_professionals where appointment_id = v_id;
    insert into public.appointment_professionals(appointment_id, user_id, role)
    select v_id, (e->>'user_id')::uuid, (e->>'role')::public.appointment_role
    from jsonb_array_elements(p_payload->'professionals') e
    where nullif(e->>'user_id','') is not null;
  end if;

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

-- 8) Notificação ao gestor a cada novo agendamento -------------------
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

-- =====================================================================
--  FIM DA MIGRAÇÃO 002
-- =====================================================================
