-- =============================================================================
-- Soft Anestesia — 0024: quarentena e migração controlada do acervo legado
-- =============================================================================
-- Local/G1 somente. Não aplicar em Supabase remoto sem autorização G3.
--
-- Contrato de segurança:
--   * nenhuma linha recebe organização por inferência (nem "usuário com uma
--     clínica só"); a classificação é uma ação explícita do programador;
--   * o conteúdo clínico nunca sai por RPC de inventário/relatório;
--   * a tabela `documentos` continua intacta e sem acesso direto pelo app;
--   * a cópia é idempotente, confere SHA-256 e nunca sobrescreve um destino
--     divergente;
--   * cada associação, cópia, validação e reversão deixa trilha de auditoria;
--   * a reversão só oculta linhas criadas pela migração, dentro da janela e
--     enquanto versão e hash ainda forem os mesmos.
-- =============================================================================

begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';
set local check_function_bodies = off;

-- 1) Estado operacional sem conteúdo de prontuário --------------------------
create table if not exists public.legacy_migration_runs (
  id                 uuid primary key default gen_random_uuid(),
  operation          text not null,
  status             text not null default 'running',
  programmer_id      uuid not null references auth.users(id),
  requested_count    integer not null default 0,
  succeeded_count    integer not null default 0,
  blocked_count      integer not null default 0,
  failed_count       integer not null default 0,
  filters            jsonb not null default '{}'::jsonb,
  report             jsonb not null default '{}'::jsonb,
  started_at         timestamptz not null default now(),
  finished_at        timestamptz,
  check (operation in ('inventory','classify','copy','validate','rollback')),
  check (status in ('running','completed','completed_with_blocks','failed')),
  check (jsonb_typeof(filters) = 'object'),
  check (jsonb_typeof(report) = 'object')
);

create table if not exists public.legacy_document_registry (
  id                    uuid primary key default gen_random_uuid(),
  source_user_id        uuid not null,
  source_module         text not null,
  source_doc_id         text not null,
  source_updated_at     timestamptz,
  source_hash           text not null,
  source_bytes          bigint not null default 0,
  observed_hash         text not null,
  observed_updated_at   timestamptz,
  observed_bytes        bigint not null default 0,
  target_table          text,
  status                text not null default 'quarantined',
  organization_id       uuid references public.organizations(id) on delete restrict,
  classification_reason text,
  classified_by         uuid references auth.users(id),
  classified_at         timestamptz,
  target_id             uuid,
  target_legacy_id      text,
  target_hash           text,
  target_version        integer,
  target_created        boolean,
  copied_by             uuid references auth.users(id),
  copied_at             timestamptz,
  validated_by          uuid references auth.users(id),
  validated_at          timestamptz,
  rollback_deadline     timestamptz,
  rolled_back_by        uuid references auth.users(id),
  rolled_back_at        timestamptz,
  last_error_code       text,
  last_error_at         timestamptz,
  first_seen_at         timestamptz not null default now(),
  last_seen_at          timestamptz not null default now(),
  unique (source_user_id, source_module, source_doc_id),
  check (source_hash ~ '^[0-9a-f]{64}$'),
  check (observed_hash ~ '^[0-9a-f]{64}$'),
  check (source_bytes >= 0 and observed_bytes >= 0),
  check (target_hash is null or target_hash ~ '^[0-9a-f]{64}$'),
  check (status in (
    'quarantined','unsupported','classified','copied','validated',
    'target_conflict','source_changed','source_missing',
    'rollback_pending','rollback_blocked','rolled_back'
  )),
  check (target_table is null or target_table in (
    'patients','appointments','preanesthetic_assessments','consultations',
    'anesthesia_records','recovery_records','risk_assessments','consents',
    'prescriptions','documents','finance_entries','quotes'
  )),
  check (
    status not in ('classified','copied','validated','target_conflict',
                   'rollback_pending','rollback_blocked','rolled_back')
    or organization_id is not null
  ),
  check (
    classification_reason is null
    or char_length(classification_reason) between 12 and 500
  )
);

create index if not exists legacy_runs_programmer_idx
  on public.legacy_migration_runs(programmer_id, started_at desc);

create index if not exists legacy_registry_status_idx
  on public.legacy_document_registry(status, source_module);
create index if not exists legacy_registry_user_idx
  on public.legacy_document_registry(source_user_id, source_module, status);
create index if not exists legacy_registry_org_idx
  on public.legacy_document_registry(organization_id, status)
  where organization_id is not null;

create table if not exists public.legacy_migration_targets (
  id                   uuid primary key default gen_random_uuid(),
  registry_id          uuid not null references public.legacy_document_registry(id) on delete cascade,
  run_id                uuid references public.legacy_migration_runs(id) on delete set null,
  target_role           text not null,
  organization_id      uuid not null references public.organizations(id) on delete restrict,
  table_name            text not null,
  target_id             uuid not null,
  target_legacy_id      text not null,
  copied_hash           text not null,
  copied_version        integer not null,
  created_by_migration  boolean not null default false,
  created_at            timestamptz not null default now(),
  unique (registry_id, target_role),
  check (target_role in ('primary','patient','encounter')),
  check (table_name in (
    'patients','encounters','appointments','preanesthetic_assessments',
    'consultations','anesthesia_records','recovery_records',
    'risk_assessments','consents','prescriptions','documents',
    'finance_entries','quotes'
  )),
  check (copied_hash ~ '^[0-9a-f]{64}$'),
  check (copied_version > 0)
);

create index if not exists legacy_targets_lookup_idx
  on public.legacy_migration_targets(organization_id, table_name, target_id);
create index if not exists legacy_targets_run_idx
  on public.legacy_migration_targets(run_id)
  where run_id is not null;

create table if not exists public.legacy_migration_events (
  id                 uuid primary key default gen_random_uuid(),
  registry_id        uuid references public.legacy_document_registry(id) on delete set null,
  run_id              uuid references public.legacy_migration_runs(id) on delete set null,
  programmer_id      uuid not null references auth.users(id),
  action             text not null,
  previous_status    text,
  new_status         text,
  organization_id    uuid references public.organizations(id) on delete restrict,
  reason             text,
  metadata           jsonb not null default '{}'::jsonb,
  created_at         timestamptz not null default now(),
  check (action in (
    'inventory','list','classify','copy','copy_blocked','validate',
    'validate_blocked','rollback','rollback_blocked','ack_source_change'
  )),
  check (jsonb_typeof(metadata) = 'object'),
  check (reason is null or char_length(reason) <= 500)
);

create index if not exists legacy_events_created_idx
  on public.legacy_migration_events(created_at desc);
create index if not exists legacy_events_registry_idx
  on public.legacy_migration_events(registry_id, created_at desc);
create index if not exists legacy_events_run_idx
  on public.legacy_migration_events(run_id)
  where run_id is not null;

-- Estas tabelas só expõem metadados e somente ao programador. Escrita direta
-- não é concedida: todas as mudanças passam pelos RPCs auditados abaixo.
do $block$
declare t text;
begin
  foreach t in array array[
    'legacy_migration_runs','legacy_document_registry',
    'legacy_migration_targets','legacy_migration_events'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
    execute format('drop policy if exists %I on public.%I', t || '_prog_sel', t);
    execute format(
      'create policy %I on public.%I for select using (app.eh_programador())',
      t || '_prog_sel', t
    );
    execute format('revoke all on table public.%I from public, anon, authenticated', t);
    execute format('grant select on table public.%I to authenticated', t);
  end loop;
end
$block$;

-- 2) Funções puras de classificação -----------------------------------------
create or replace function app.legacy_target_table(p_module text)
returns text
language sql
immutable
set search_path = pg_catalog, public, app
as $fn$
  select case p_module
    when 'pacientes'   then 'patients'
    when 'agenda'      then 'appointments'
    when 'pre'         then 'preanesthetic_assessments'
    when 'consulta'    then 'consultations'
    when 'anestesia'   then 'anesthesia_records'
    when 'recuperacao' then 'recovery_records'
    when 'risco'       then 'risk_assessments'
    when 'termo'       then 'consents'
    when 'prescricao'  then 'prescriptions'
    when 'documentos'  then 'documents'
    when 'financeiro'  then 'finance_entries'
    when 'orcamento'   then 'quotes'
    else null
  end
$fn$;

create or replace function app.legacy_json_hash(p_data jsonb)
returns text
language sql
immutable
parallel safe
set search_path = pg_catalog, public, app
as $fn$
  select encode(digest(convert_to(coalesce(p_data, '{}'::jsonb)::text, 'UTF8'), 'sha256'), 'hex')
$fn$;

create or replace function app.legacy_patient_name(p_data jsonb)
returns text
language sql
immutable
parallel safe
set search_path = pg_catalog, public, app
as $fn$
  select coalesce(
    nullif(btrim(p_data->>'paciente_nome'), ''),
    nullif(btrim(p_data->>'nome'), ''),
    nullif(btrim(p_data#>>'{paciente,nome}'), ''),
    case when jsonb_typeof(p_data->'paciente') = 'string'
         then nullif(btrim(p_data->>'paciente'), '') end,
    ''
  )
$fn$;

create or replace function app.legacy_patient_key(p_data jsonb)
returns text
language plpgsql
immutable
parallel safe
set search_path = pg_catalog, public, app
as $fn$
declare
  v_name text := public.med_normalizar(app.legacy_patient_name(p_data));
  v_cpf text := regexp_replace(
    coalesce(p_data->>'cpf', p_data->>'paciente_cpf', p_data#>>'{paciente,cpf}', ''),
    '[^0-9]', '', 'g'
  );
begin
  if char_length(v_name) >= 3 then return 'nome:' || v_name; end if;
  if char_length(v_cpf) >= 11 then return 'cpf:' || v_cpf; end if;
  return null;
end
$fn$;

create or replace function app.legacy_date(p_value text)
returns date
language plpgsql
immutable
parallel safe
set search_path = pg_catalog, public, app
as $fn$
begin
  if coalesce(p_value, '') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}' then
    begin
      return substring(p_value from 1 for 10)::date;
    exception when others then
      return null;
    end;
  end if;
  return null;
end
$fn$;

create or replace function app.legacy_timestamp(p_value text)
returns timestamptz
language plpgsql
immutable
parallel safe
set search_path = pg_catalog, public, app
as $fn$
begin
  if nullif(btrim(coalesce(p_value, '')), '') is null then return null; end if;
  begin
    return p_value::timestamptz;
  exception when others then
    return null;
  end;
end
$fn$;

create or replace function app.legacy_is_finalized(p_data jsonb)
returns boolean
language sql
immutable
parallel safe
set search_path = pg_catalog, public, app
as $fn$
  select lower(coalesce(p_data->>'_finalizado', 'false')) in ('true','1','yes','sim')
$fn$;

create or replace function app.legacy_encounter_key(p_data jsonb)
returns text
language plpgsql
immutable
parallel safe
set search_path = pg_catalog, public, app
as $fn$
declare
  v_patient text := app.legacy_patient_key(p_data);
  v_procedure text := public.med_normalizar(
    coalesce(nullif(p_data->>'procedimento', ''), p_data->>'cirurgia', '')
  );
  v_date date := app.legacy_date(p_data->>'data');
begin
  if v_patient is null or v_procedure = '' then return null; end if;
  return v_patient || '|' || coalesce(v_date::text, '') || '|' || v_procedure;
end
$fn$;

revoke all on function app.legacy_target_table(text) from public, anon, authenticated;
revoke all on function app.legacy_json_hash(jsonb) from public, anon, authenticated;
revoke all on function app.legacy_patient_name(jsonb) from public, anon, authenticated;
revoke all on function app.legacy_patient_key(jsonb) from public, anon, authenticated;
revoke all on function app.legacy_date(text) from public, anon, authenticated;
revoke all on function app.legacy_timestamp(text) from public, anon, authenticated;
revoke all on function app.legacy_is_finalized(jsonb) from public, anon, authenticated;
revoke all on function app.legacy_encounter_key(jsonb) from public, anon, authenticated;

-- Helpers internos: criam somente identidades auxiliares ausentes. Nunca
-- atualizam uma linha já existente e nunca são executáveis pelo navegador.
create or replace function app.legacy_ensure_patient(
  p_org uuid,
  p_data jsonb,
  p_primary boolean default false
)
returns table (
  out_target_id uuid,
  out_legacy_id text,
  out_hash text,
  out_version integer,
  out_created boolean
)
language plpgsql
security definer
set search_path = pg_catalog, public, app, auth
as $fn$
declare
  v_key text := app.legacy_patient_key(p_data);
  v_name text := app.legacy_patient_name(p_data);
  v_payload jsonb := case when p_primary then coalesce(p_data, '{}'::jsonb)
                          else jsonb_build_object('origem', 'legacy_b2') end;
  v_id uuid;
  v_data jsonb;
  v_version integer;
  v_deleted timestamptz;
  v_created boolean := false;
  v_birth date;
  v_cpf text;
begin
  if v_key is null then return; end if;
  v_birth := app.legacy_date(coalesce(
    p_data->>'paciente_nasc', p_data->>'nascimento', p_data#>>'{paciente,nascimento}'
  ));
  v_cpf := regexp_replace(
    coalesce(p_data->>'cpf', p_data->>'paciente_cpf', p_data#>>'{paciente,cpf}', ''),
    '[^0-9]', '', 'g'
  );
  if char_length(v_cpf) < 11 then v_cpf := null; end if;

  insert into public.patients(
    organization_id, legacy_id, nome, nascimento, cpf, prontuario,
    convenio, telefone, sexo, data
  ) values (
    p_org, v_key, coalesce(nullif(v_name, ''), 'Sem nome'), v_birth, v_cpf,
    coalesce(nullif(p_data->>'prontuario', ''), nullif(p_data#>>'{paciente,prontuario}', '')),
    coalesce(nullif(p_data->>'convenio', ''), nullif(p_data->>'paciente_convenio', ''),
             nullif(p_data#>>'{paciente,convenio}', '')),
    coalesce(nullif(p_data->>'telefone', ''), nullif(p_data#>>'{paciente,telefone}', '')),
    coalesce(nullif(p_data->>'sexo', ''), nullif(p_data#>>'{paciente,sexo}', '')),
    v_payload
  )
  on conflict (organization_id, legacy_id) do nothing
  returning id, data, version, deleted_at
       into v_id, v_data, v_version, v_deleted;
  v_created := found;

  if v_id is null then
    select p.id, p.data, p.version, p.deleted_at
      into v_id, v_data, v_version, v_deleted
      from public.patients p
     where p.organization_id = p_org and p.legacy_id = v_key
     for update;
  end if;
  if v_id is null then raise exception 'legacy_patient_target_missing'; end if;
  if v_deleted is not null then raise exception 'legacy_patient_target_deleted'; end if;

  return query select v_id, v_key, app.legacy_json_hash(v_data), v_version, v_created;
end
$fn$;

create or replace function app.legacy_ensure_encounter(
  p_org uuid,
  p_patient uuid,
  p_data jsonb
)
returns table (
  out_target_id uuid,
  out_legacy_id text,
  out_hash text,
  out_version integer,
  out_created boolean
)
language plpgsql
security definer
set search_path = pg_catalog, public, app, auth
as $fn$
declare
  v_key text := app.legacy_encounter_key(p_data);
  v_id uuid;
  v_data jsonb;
  v_version integer;
  v_deleted timestamptz;
  v_created boolean := false;
begin
  if v_key is null or p_patient is null then return; end if;

  insert into public.encounters(
    organization_id, legacy_id, patient_id, procedimento, data_prevista,
    convenio, status, data
  ) values (
    p_org, v_key, p_patient,
    coalesce(nullif(p_data->>'procedimento', ''), nullif(p_data->>'cirurgia', '')),
    app.legacy_date(p_data->>'data'),
    coalesce(nullif(p_data->>'convenio', ''), nullif(p_data->>'paciente_convenio', ''),
             nullif(p_data#>>'{paciente,convenio}', '')),
    'migrado', jsonb_build_object('origem', 'legacy_b2')
  )
  on conflict (organization_id, legacy_id) do nothing
  returning id, data, version, deleted_at
       into v_id, v_data, v_version, v_deleted;
  v_created := found;

  if v_id is null then
    select e.id, e.data, e.version, e.deleted_at
      into v_id, v_data, v_version, v_deleted
      from public.encounters e
     where e.organization_id = p_org and e.legacy_id = v_key
     for update;
  end if;
  if v_id is null then raise exception 'legacy_encounter_target_missing'; end if;
  if v_deleted is not null then raise exception 'legacy_encounter_target_deleted'; end if;

  return query select v_id, v_key, app.legacy_json_hash(v_data), v_version, v_created;
end
$fn$;

revoke all on function app.legacy_ensure_patient(uuid, jsonb, boolean) from public, anon, authenticated;
revoke all on function app.legacy_ensure_encounter(uuid, uuid, jsonb) from public, anon, authenticated;

create or replace function app.legacy_dependency_count(
  p_table text,
  p_target uuid
)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public, app, auth
as $fn$
declare
  v_table text;
  v_column text;
  v_total integer := 0;
  v_count integer;
begin
  if p_table = 'patients' then
    select count(*) into v_count from public.encounters
     where patient_id = p_target and deleted_at is null;
    v_total := v_total + v_count;
    v_column := 'patient_id';
  elsif p_table = 'encounters' then
    v_column := 'encounter_id';
  else
    raise exception 'legacy_dependency_table_invalid';
  end if;

  foreach v_table in array array[
    'appointments','preanesthetic_assessments','consultations',
    'anesthesia_records','recovery_records','risk_assessments','consents',
    'prescriptions','documents','finance_entries','quotes'
  ] loop
    execute format(
      'select count(*) from public.%I where %I = $1 and deleted_at is null',
      v_table, v_column
    ) into v_count using p_target;
    v_total := v_total + v_count;
  end loop;

  if p_table = 'patients' then
    select count(*) into v_count from public.addenda where patient_id = p_target;
    v_total := v_total + v_count;
    select count(*) into v_count from public.attachments
     where patient_id = p_target and deleted_at is null;
    v_total := v_total + v_count;
  else
    select count(*) into v_count from public.addenda where encounter_id = p_target;
    v_total := v_total + v_count;
    select count(*) into v_count from public.attachments
     where encounter_id = p_target and deleted_at is null;
    v_total := v_total + v_count;
    select count(*) into v_count from public.anesthesia_timeline_events
     where encounter_id = p_target and deleted_at is null;
    v_total := v_total + v_count;
  end if;
  return v_total;
end
$fn$;

revoke all on function app.legacy_dependency_count(text, uuid) from public, anon, authenticated;

create or replace function app.legacy_primary_dependency_count(
  p_table text,
  p_target uuid
)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public, app, auth
as $fn$
declare
  v_total integer := 0;
  v_count integer;
begin
  select count(*) into v_count
    from public.addenda
   where parent_table = p_table and parent_id = p_target;
  v_total := v_total + v_count;

  if p_table = 'preanesthetic_assessments' then
    select count(*) into v_count
      from public.anesthesia_records
     where preanesthetic_assessment_id = p_target and deleted_at is null;
    v_total := v_total + v_count;
  elsif p_table = 'anesthesia_records' then
    select count(*) into v_count
      from public.recovery_records
     where anesthesia_record_id = p_target and deleted_at is null;
    v_total := v_total + v_count;
    select count(*) into v_count
      from public.anesthesia_timeline_events
     where anesthesia_record_id = p_target and deleted_at is null;
    v_total := v_total + v_count;
  end if;
  return v_total;
end
$fn$;

revoke all on function app.legacy_primary_dependency_count(text, uuid) from public, anon, authenticated;

-- 3) Inventário: lê o conteúdo somente dentro do banco e persiste só hash,
-- tamanho, datas e identificadores operacionais. Nenhum `dados` é retornado.
create or replace function public.prog_inventory_legacy_documents()
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, app, auth
as $fn$
declare
  v_run uuid;
  v_started timestamptz := clock_timestamp();
  v_scanned integer := 0;
  v_report jsonb;
begin
  if not app.eh_programador() then
    raise exception 'Apenas o programador pode inventariar o acervo legado.'
      using errcode = 'insufficient_privilege';
  end if;

  insert into public.legacy_migration_runs(operation, programmer_id)
  values ('inventory', auth.uid()) returning id into v_run;

  if to_regclass('public.documentos') is not null then
    execute $sql$
      insert into public.legacy_document_registry(
        source_user_id, source_module, source_doc_id, source_updated_at,
        source_hash, source_bytes, observed_hash, observed_updated_at,
        observed_bytes, target_table, status, last_seen_at
      )
      select d.user_id::text::uuid,
             d.modulo::text,
             d.doc_id::text,
             d.atualizado_em::timestamptz,
             app.legacy_json_hash(coalesce(d.dados::jsonb, '{}'::jsonb)),
             octet_length(coalesce(d.dados::jsonb, '{}'::jsonb)::text),
             app.legacy_json_hash(coalesce(d.dados::jsonb, '{}'::jsonb)),
             d.atualizado_em::timestamptz,
             octet_length(coalesce(d.dados::jsonb, '{}'::jsonb)::text),
             app.legacy_target_table(d.modulo::text),
             case when app.legacy_target_table(d.modulo::text) is null
                  then 'unsupported' else 'quarantined' end,
             clock_timestamp()
        from public.documentos d
       where d.user_id is not null
         and d.modulo is not null
         and d.doc_id is not null
      on conflict (source_user_id, source_module, source_doc_id) do update
        set observed_hash = excluded.observed_hash,
            observed_updated_at = excluded.observed_updated_at,
            observed_bytes = excluded.observed_bytes,
            target_table = excluded.target_table,
            last_seen_at = clock_timestamp(),
            status = case
              when legacy_document_registry.source_hash <> excluded.observed_hash
                then 'source_changed'
              when legacy_document_registry.status = 'source_missing'
                then case
                  when legacy_document_registry.target_id is not null
                       and legacy_document_registry.validated_at is not null then 'validated'
                  when legacy_document_registry.target_id is not null then 'copied'
                  when legacy_document_registry.organization_id is not null then 'classified'
                  when excluded.target_table is null then 'unsupported'
                  else 'quarantined'
                end
              else legacy_document_registry.status
            end,
            last_error_code = case
              when legacy_document_registry.source_hash <> excluded.observed_hash
                then 'source_hash_changed'
              else legacy_document_registry.last_error_code
            end,
            last_error_at = case
              when legacy_document_registry.source_hash <> excluded.observed_hash
                then clock_timestamp()
              else legacy_document_registry.last_error_at
            end
    $sql$;
    get diagnostics v_scanned = row_count;

    update public.legacy_document_registry r
       set status = 'source_missing',
           last_error_code = 'source_missing',
           last_error_at = clock_timestamp()
     where r.last_seen_at < v_started
       and r.status <> 'rolled_back';
  end if;

  select jsonb_build_object(
    'run_id', v_run,
    'scanned', v_scanned,
    'total', count(*),
    'quarantined', count(*) filter (where r.status = 'quarantined'),
    'unsupported', count(*) filter (where r.status = 'unsupported'),
    'classified', count(*) filter (where r.status = 'classified'),
    'copied', count(*) filter (where r.status = 'copied'),
    'validated', count(*) filter (where r.status = 'validated'),
    'anomalies', count(*) filter (where r.status in (
      'source_changed','source_missing','target_conflict','rollback_blocked'
    ))
  ) into v_report
  from public.legacy_document_registry r;

  insert into public.legacy_migration_events(
    run_id, programmer_id, action, metadata
  ) values (v_run, auth.uid(), 'inventory', v_report - 'run_id');

  insert into public.legacy_access_logs(
    programmer_id, target_user_id, action, row_count, metadata
  )
  select auth.uid(), r.source_user_id, 'inventory', count(*)::integer,
         jsonb_build_object('run_id', v_run)
    from public.legacy_document_registry r
    join auth.users u on u.id = r.source_user_id
   group by r.source_user_id;

  update public.legacy_migration_runs
     set status = 'completed', succeeded_count = v_scanned,
         report = v_report - 'run_id', finished_at = clock_timestamp()
   where id = v_run;
  return v_report;
exception when others then
  if v_run is not null then
    update public.legacy_migration_runs
       set status = 'failed', failed_count = 1,
           report = jsonb_build_object('error_code', sqlstate),
           finished_at = clock_timestamp()
     where id = v_run;
  end if;
  raise;
end
$fn$;

-- 4) Relatórios sem payload --------------------------------------------------
create or replace function public.prog_legacy_migration_summary()
returns table (
  source_user_id uuid,
  source_email text,
  source_module text,
  status text,
  row_count bigint,
  total_bytes numeric,
  oldest_at timestamptz,
  newest_at timestamptz
)
language plpgsql
security definer
set search_path = pg_catalog, public, app, auth
as $fn$
begin
  if not app.eh_programador() then
    raise exception 'Apenas o programador pode consultar o inventário legado.'
      using errcode = 'insufficient_privilege';
  end if;
  insert into public.legacy_migration_events(programmer_id, action, metadata)
  values (auth.uid(), 'list', jsonb_build_object('view', 'summary'));
  return query
    select r.source_user_id, coalesce(u.email::text, '(conta removida)'),
           r.source_module, r.status, count(*), sum(r.source_bytes)::numeric,
           min(r.source_updated_at), max(r.source_updated_at)
      from public.legacy_document_registry r
      left join auth.users u on u.id = r.source_user_id
     group by r.source_user_id, u.email, r.source_module, r.status
     order by coalesce(u.email::text, r.source_user_id::text),
              r.source_module, r.status;
end
$fn$;

create or replace function public.prog_list_legacy_documents(
  p_source_user uuid,
  p_source_module text,
  p_status text,
  p_limit integer,
  p_offset integer
)
returns table (
  registry_id uuid,
  source_user_id uuid,
  source_email text,
  source_module text,
  source_ref text,
  source_updated_at timestamptz,
  source_hash text,
  source_bytes bigint,
  status text,
  organization_id uuid,
  target_table text,
  target_id uuid,
  rollback_deadline timestamptz,
  last_error_code text
)
language plpgsql
security definer
set search_path = pg_catalog, public, app, auth
as $fn$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 100), 1), 250);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
begin
  if not app.eh_programador() then
    raise exception 'Apenas o programador pode consultar o inventário legado.'
      using errcode = 'insufficient_privilege';
  end if;
  insert into public.legacy_migration_events(programmer_id, action, metadata)
  values (
    auth.uid(), 'list',
    jsonb_strip_nulls(jsonb_build_object(
      'view', 'items', 'source_user_id', p_source_user,
      'source_module', p_source_module, 'status', p_status,
      'limit', v_limit, 'offset', v_offset
    ))
  );
  return query
    select r.id, r.source_user_id, coalesce(u.email::text, '(conta removida)'),
           r.source_module,
           left(encode(digest(convert_to(
             r.source_user_id::text || '|' || r.source_module || '|' || r.source_doc_id,
             'UTF8'
           ), 'sha256'), 'hex'), 16),
           r.source_updated_at,
           r.source_hash, r.source_bytes, r.status, r.organization_id,
           r.target_table, r.target_id, r.rollback_deadline,
           r.last_error_code
      from public.legacy_document_registry r
      left join auth.users u on u.id = r.source_user_id
     where (p_source_user is null or r.source_user_id = p_source_user)
       and (nullif(p_source_module, '') is null or r.source_module = p_source_module)
       and (nullif(p_status, '') is null or r.status = p_status)
     order by r.source_updated_at nulls first, r.source_module, r.source_doc_id
     limit v_limit offset v_offset;
end
$fn$;

-- 5) Classificação manual: IDs explícitos + clínica sem valor padrão --------
create or replace function public.prog_classify_legacy_documents(
  p_registry_ids uuid[],
  p_org uuid,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, app, auth
as $fn$
declare
  v_run uuid;
  v_requested integer;
  v_eligible integer;
  v_row record;
begin
  if not app.eh_programador() then
    raise exception 'Apenas o programador pode classificar o acervo legado.'
      using errcode = 'insufficient_privilege';
  end if;
  if p_org is null or not exists (select 1 from public.organizations o where o.id = p_org) then
    raise exception 'Escolha uma organização válida.' using errcode = 'invalid_parameter_value';
  end if;
  if char_length(btrim(coalesce(p_reason, ''))) < 12 then
    raise exception 'Informe uma justificativa com pelo menos 12 caracteres.'
      using errcode = 'invalid_parameter_value';
  end if;
  select count(distinct x) into v_requested from unnest(coalesce(p_registry_ids, '{}')) x;
  if v_requested = 0 or v_requested > 250 then
    raise exception 'Selecione entre 1 e 250 linhas.' using errcode = 'invalid_parameter_value';
  end if;

  select count(*) into v_eligible
    from public.legacy_document_registry r
     where r.id = any(p_registry_ids)
     and r.target_table is not null
     and r.status in ('quarantined','classified','target_conflict')
     and (r.target_id is null or r.status = 'target_conflict');
  if v_eligible <> v_requested then
    raise exception 'Há linhas inexistentes, sem destino suportado, anômalas ou já copiadas.'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  insert into public.legacy_migration_runs(
    operation, programmer_id, requested_count, filters
  ) values (
    'classify', auth.uid(), v_requested,
    jsonb_build_object('organization_id', p_org)
  ) returning id into v_run;

  for v_row in
    select r.id, r.status, r.target_table, r.target_id
      from public.legacy_document_registry r
     where r.id = any(p_registry_ids)
     order by r.id
     for update
  loop
    if v_row.target_table is null
       or v_row.status not in ('quarantined','classified','target_conflict')
       or (v_row.target_id is not null and v_row.status <> 'target_conflict') then
      raise exception 'A seleção mudou durante a classificação; recarregue o relatório.'
        using errcode = 'serialization_failure';
    end if;
    update public.legacy_document_registry
       set organization_id = p_org,
           classification_reason = btrim(p_reason),
           classified_by = auth.uid(), classified_at = clock_timestamp(),
           status = 'classified',
           target_id = null, target_legacy_id = null, target_hash = null,
           target_version = null, target_created = null,
           copied_by = null, copied_at = null,
           validated_by = null, validated_at = null,
           rollback_deadline = null,
           rolled_back_by = null, rolled_back_at = null,
           last_error_code = null, last_error_at = null
     where id = v_row.id;
    insert into public.legacy_migration_events(
      registry_id, run_id, programmer_id, action, previous_status,
      new_status, organization_id, reason
    ) values (
      v_row.id, v_run, auth.uid(), 'classify', v_row.status,
      'classified', p_org, btrim(p_reason)
    );
  end loop;

  update public.legacy_migration_runs
     set status = 'completed', succeeded_count = v_requested,
         report = jsonb_build_object('classified', v_requested),
         finished_at = clock_timestamp()
   where id = v_run;

  insert into public.legacy_access_logs(
    programmer_id, target_user_id, action, row_count, metadata
  )
  select auth.uid(), r.source_user_id, 'assign', count(*)::integer,
         jsonb_build_object('run_id', v_run, 'organization_id', p_org)
    from public.legacy_document_registry r
    join auth.users u on u.id = r.source_user_id
   where r.id = any(p_registry_ids)
   group by r.source_user_id;

  return jsonb_build_object('run_id', v_run, 'classified', v_requested);
end
$fn$;

-- 6) Cópia idempotente -------------------------------------------------------
create or replace function public.prog_copy_legacy_documents(
  p_registry_ids uuid[],
  p_rollback_hours integer
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, app, auth
as $fn$
declare
  v_run uuid;
  v_requested integer;
  v_hours integer := least(greatest(coalesce(p_rollback_hours, 168), 24), 720);
  v_row record;
  v_source jsonb;
  v_source_hash text;
  v_source_updated timestamptz;
  v_source_bytes bigint;
  v_patient record;
  v_encounter record;
  v_target_id uuid;
  v_target_data jsonb;
  v_target_hash text;
  v_target_version integer;
  v_target_deleted timestamptz;
  v_target_finalized timestamptz;
  v_target_created boolean;
  v_lookup_legacy text;
  v_changed integer;
  v_ok integer := 0;
  v_blocked integer := 0;
  v_failed integer := 0;
  v_code text;
begin
  if not app.eh_programador() then
    raise exception 'Apenas o programador pode copiar o acervo legado.'
      using errcode = 'insufficient_privilege';
  end if;
  if to_regclass('public.documentos') is null then
    raise exception 'A tabela legada documentos não existe.'
      using errcode = 'undefined_table';
  end if;
  select count(distinct x) into v_requested from unnest(coalesce(p_registry_ids, '{}')) x;
  if v_requested = 0 or v_requested > 250 then
    raise exception 'Selecione entre 1 e 250 linhas.' using errcode = 'invalid_parameter_value';
  end if;
  if (select count(*) from public.legacy_document_registry r where r.id = any(p_registry_ids)) <> v_requested then
    raise exception 'Uma ou mais linhas do inventário não existem.' using errcode = 'invalid_parameter_value';
  end if;

  insert into public.legacy_migration_runs(
    operation, programmer_id, requested_count,
    filters
  ) values (
    'copy', auth.uid(), v_requested,
    jsonb_build_object('rollback_hours', v_hours)
  ) returning id into v_run;

  for v_row in
    select r.*
     from public.legacy_document_registry r
     where r.id = any(p_registry_ids)
     order by case when r.target_table = 'patients' then 0 else 1 end,
              r.source_user_id, r.source_module, r.source_doc_id
     for update
  loop
    begin
      if v_row.status in ('copied','validated') then
        v_ok := v_ok + 1;
        continue;
      end if;
      if v_row.status not in ('classified','target_conflict')
         or v_row.organization_id is null or v_row.target_table is null then
        raise exception 'legacy_not_classified' using errcode = 'object_not_in_prerequisite_state';
      end if;

      v_source := null; v_source_hash := null; v_source_updated := null;
      execute
        'select coalesce(dados::jsonb, ''{}''::jsonb), '
        '       app.legacy_json_hash(coalesce(dados::jsonb, ''{}''::jsonb)), '
        '       atualizado_em::timestamptz, '
        '       octet_length(coalesce(dados::jsonb, ''{}''::jsonb)::text) '
        '  from public.documentos '
        ' where user_id::text = $1::text and modulo::text = $2 and doc_id::text = $3 '
        ' limit 1'
        into v_source, v_source_hash, v_source_updated, v_source_bytes
        using v_row.source_user_id, v_row.source_module, v_row.source_doc_id;

      if v_source_hash is null then
        update public.legacy_document_registry
           set status = 'source_missing', last_error_code = 'source_missing',
               last_error_at = clock_timestamp()
         where id = v_row.id;
        v_blocked := v_blocked + 1;
        insert into public.legacy_migration_events(
          registry_id, run_id, programmer_id, action, previous_status,
          new_status, organization_id, metadata
        ) values (
          v_row.id, v_run, auth.uid(), 'copy_blocked', v_row.status,
          'source_missing', v_row.organization_id,
          jsonb_build_object('error_code', 'source_missing')
        );
        continue;
      end if;
      if v_source_hash <> v_row.source_hash then
        update public.legacy_document_registry
           set status = 'source_changed', observed_hash = v_source_hash,
               observed_updated_at = v_source_updated,
               observed_bytes = v_source_bytes,
               last_error_code = 'source_hash_changed',
               last_error_at = clock_timestamp()
         where id = v_row.id;
        v_blocked := v_blocked + 1;
        insert into public.legacy_migration_events(
          registry_id, run_id, programmer_id, action, previous_status,
          new_status, organization_id, metadata
        ) values (
          v_row.id, v_run, auth.uid(), 'copy_blocked', v_row.status,
          'source_changed', v_row.organization_id,
          jsonb_build_object('error_code', 'source_hash_changed')
        );
        continue;
      end if;
      if v_row.target_table <> 'patients'
         and v_row.source_module <> 'agenda'
         and app.legacy_patient_key(v_source) is null then
        raise exception 'legacy_patient_identity_missing';
      end if;

      select null::uuid as out_target_id, null::text as out_legacy_id,
             null::text as out_hash, null::integer as out_version,
             false::boolean as out_created
        into v_patient;
      select null::uuid as out_target_id, null::text as out_legacy_id,
             null::text as out_hash, null::integer as out_version,
             false::boolean as out_created
        into v_encounter;
      v_target_id := null; v_target_data := null; v_target_version := null;
      v_target_deleted := null; v_target_finalized := null;
      v_target_created := false; v_target_hash := null;
      v_lookup_legacy := case when v_row.target_table = 'patients'
                              then app.legacy_patient_key(v_source)
                              else v_row.source_doc_id end;
      if v_lookup_legacy is null then
        raise exception 'legacy_patient_identity_missing';
      end if;

      -- Detecta colisão antes de criar paciente/encounter auxiliar. Um destino
      -- divergente fica intocado e não deixa órfãos derivados pelo caminho.
      execute format(
        'select id, data, version, deleted_at from public.%I '
        'where organization_id = $1 and legacy_id = $2 for update',
        v_row.target_table
      ) into v_target_id, v_target_data, v_target_version, v_target_deleted
        using v_row.organization_id, v_lookup_legacy;
      if v_target_id is not null then
        v_target_hash := app.legacy_json_hash(v_target_data);
        if v_row.target_table in (
          'preanesthetic_assessments','consultations','anesthesia_records',
          'recovery_records','risk_assessments','consents','prescriptions','documents'
        ) then
          execute format('select finalized_at from public.%I where id = $1', v_row.target_table)
            into v_target_finalized using v_target_id;
        end if;
        if v_target_deleted is not null or v_target_hash <> v_source_hash
           or (
             app.legacy_is_finalized(v_source)
             and v_row.target_table in (
               'preanesthetic_assessments','consultations','anesthesia_records',
               'recovery_records','risk_assessments','consents','prescriptions','documents'
             )
             and v_target_finalized is null
           ) then
          update public.legacy_document_registry
             set status = 'target_conflict',
                 target_id = v_target_id,
                 target_legacy_id = v_lookup_legacy,
                 target_hash = v_target_hash,
                 target_version = v_target_version,
                 target_created = false,
                 last_error_code = case
                   when v_target_deleted is not null then 'target_deleted'
                   when v_target_hash <> v_source_hash then 'target_hash_conflict'
                   else 'target_finalization_mismatch' end,
                 last_error_at = clock_timestamp()
           where id = v_row.id;
          v_blocked := v_blocked + 1;
          insert into public.legacy_migration_events(
            registry_id, run_id, programmer_id, action, previous_status,
            new_status, organization_id, metadata
          ) values (
            v_row.id, v_run, auth.uid(), 'copy_blocked', v_row.status,
            'target_conflict', v_row.organization_id,
            jsonb_build_object(
              'error_code', case
                when v_target_deleted is not null then 'target_deleted'
                when v_target_hash <> v_source_hash then 'target_hash_conflict'
                else 'target_finalization_mismatch' end,
              'target_table', v_row.target_table
            )
          );
          continue;
        end if;
      end if;

      if v_row.target_table = 'patients' then
        select * into v_patient
          from app.legacy_ensure_patient(v_row.organization_id, v_source, true);
        if v_patient.out_target_id is null then
          raise exception 'legacy_patient_identity_missing';
        end if;
        if v_patient.out_hash <> v_source_hash then
          -- Uma inserção concorrente com a mesma chave, mas conteúdo diferente,
          -- desfaz esta subtransação. Na repetição, o pré-check acima registra
          -- o conflito sem adotar nem sobrescrever o paciente concorrente.
          raise exception 'legacy_patient_changed_during_copy';
        end if;
        v_target_id := v_patient.out_target_id;
        v_target_hash := v_patient.out_hash;
        v_target_version := v_patient.out_version;
        v_target_created := v_patient.out_created;
        insert into public.legacy_migration_targets(
          registry_id, run_id, target_role, organization_id, table_name,
          target_id, target_legacy_id, copied_hash, copied_version,
          created_by_migration
        ) values (
          v_row.id, v_run, 'primary', v_row.organization_id, 'patients',
          v_target_id, v_patient.out_legacy_id, v_target_hash,
          v_target_version, v_target_created
        )
        on conflict (registry_id, target_role) do update
          set run_id = excluded.run_id, organization_id = excluded.organization_id,
              table_name = excluded.table_name, target_id = excluded.target_id,
              target_legacy_id = excluded.target_legacy_id,
              copied_hash = excluded.copied_hash,
              copied_version = excluded.copied_version,
              created_by_migration = case
                when legacy_migration_targets.organization_id = excluded.organization_id
                 and legacy_migration_targets.table_name = excluded.table_name
                 and legacy_migration_targets.target_id = excluded.target_id
                  then legacy_migration_targets.created_by_migration or excluded.created_by_migration
                else excluded.created_by_migration
              end;
      else
        select * into v_patient
          from app.legacy_ensure_patient(v_row.organization_id, v_source, false);
        if v_patient.out_target_id is not null then
          insert into public.legacy_migration_targets(
            registry_id, run_id, target_role, organization_id, table_name,
            target_id, target_legacy_id, copied_hash, copied_version,
            created_by_migration
          ) values (
            v_row.id, v_run, 'patient', v_row.organization_id, 'patients',
            v_patient.out_target_id, v_patient.out_legacy_id,
            v_patient.out_hash, v_patient.out_version, v_patient.out_created
          )
          on conflict (registry_id, target_role) do update
            set run_id = excluded.run_id, organization_id = excluded.organization_id,
                table_name = excluded.table_name, target_id = excluded.target_id,
                target_legacy_id = excluded.target_legacy_id,
                copied_hash = excluded.copied_hash,
                copied_version = excluded.copied_version,
                created_by_migration = case
                  when legacy_migration_targets.organization_id = excluded.organization_id
                   and legacy_migration_targets.table_name = excluded.table_name
                   and legacy_migration_targets.target_id = excluded.target_id
                    then legacy_migration_targets.created_by_migration or excluded.created_by_migration
                  else excluded.created_by_migration
                end;

          select * into v_encounter
            from app.legacy_ensure_encounter(
              v_row.organization_id, v_patient.out_target_id, v_source
            );
          if v_encounter.out_target_id is not null then
            insert into public.legacy_migration_targets(
              registry_id, run_id, target_role, organization_id, table_name,
              target_id, target_legacy_id, copied_hash, copied_version,
              created_by_migration
            ) values (
              v_row.id, v_run, 'encounter', v_row.organization_id, 'encounters',
              v_encounter.out_target_id, v_encounter.out_legacy_id,
              v_encounter.out_hash, v_encounter.out_version, v_encounter.out_created
            )
            on conflict (registry_id, target_role) do update
              set run_id = excluded.run_id, organization_id = excluded.organization_id,
                  table_name = excluded.table_name, target_id = excluded.target_id,
                  target_legacy_id = excluded.target_legacy_id,
                  copied_hash = excluded.copied_hash,
                  copied_version = excluded.copied_version,
                  created_by_migration = case
                    when legacy_migration_targets.organization_id = excluded.organization_id
                     and legacy_migration_targets.table_name = excluded.table_name
                     and legacy_migration_targets.target_id = excluded.target_id
                      then legacy_migration_targets.created_by_migration or excluded.created_by_migration
                    else excluded.created_by_migration
                  end;
          end if;
        end if;

        execute format(
          'select id, data, version, deleted_at from public.%I '
          'where organization_id = $1 and legacy_id = $2 for update',
          v_row.target_table
        ) into v_target_id, v_target_data, v_target_version, v_target_deleted
          using v_row.organization_id, v_row.source_doc_id;

        if v_target_id is not null then
          v_target_hash := app.legacy_json_hash(v_target_data);
          if v_target_deleted is not null or v_target_hash <> v_source_hash then
            -- A linha surgiu entre o pré-check e esta leitura. Abortar a
            -- subtransação também desfaz auxiliares recém-criados; uma nova
            -- tentativa registrará `target_conflict` no pré-check.
            raise exception 'legacy_target_changed_during_copy';
          end if;
          if app.legacy_is_finalized(v_source)
             and v_row.target_table in (
               'preanesthetic_assessments','consultations','anesthesia_records',
               'recovery_records','risk_assessments','consents','prescriptions','documents'
             ) then
            execute format('select finalized_at from public.%I where id = $1', v_row.target_table)
              into v_target_finalized using v_target_id;
            if v_target_finalized is null then
              raise exception 'legacy_target_finalization_mismatch';
            end if;
          end if;
          v_target_created := false;
        else
          if v_row.target_table in (
            'preanesthetic_assessments','consultations','anesthesia_records',
            'recovery_records','risk_assessments','consents','prescriptions','documents'
          ) then
            execute format(
              'insert into public.%I('
              'organization_id, legacy_id, patient_id, encounter_id, data, '
              'status, finalized_at, content_hash'
              ') values ($1, $2, $3, $4, $5, $6, $7, $8) '
              'on conflict (organization_id, legacy_id) do nothing '
              'returning id, data, version, deleted_at, finalized_at',
              v_row.target_table
            ) into v_target_id, v_target_data, v_target_version,
                   v_target_deleted, v_target_finalized
              using v_row.organization_id, v_row.source_doc_id,
                    v_patient.out_target_id, v_encounter.out_target_id, v_source,
                    case when app.legacy_is_finalized(v_source) then 'finalized' else 'draft' end,
                    case when app.legacy_is_finalized(v_source)
                         then coalesce(
                           app.legacy_timestamp(v_source->>'_finalizadoEm'),
                           v_source_updated, clock_timestamp()
                         ) else null end,
                    v_source_hash;
          else
            execute format(
              'insert into public.%I('
              'organization_id, legacy_id, patient_id, encounter_id, data'
              ') values ($1, $2, $3, $4, $5) '
              'on conflict (organization_id, legacy_id) do nothing '
              'returning id, data, version, deleted_at',
              v_row.target_table
            ) into v_target_id, v_target_data, v_target_version, v_target_deleted
              using v_row.organization_id, v_row.source_doc_id,
                    v_patient.out_target_id, v_encounter.out_target_id, v_source;
          end if;
          get diagnostics v_changed = row_count;
          v_target_created := v_changed = 1;

          if v_target_id is null then
            execute format(
              'select id, data, version, deleted_at from public.%I '
              'where organization_id = $1 and legacy_id = $2 for update',
              v_row.target_table
            ) into v_target_id, v_target_data, v_target_version, v_target_deleted
              using v_row.organization_id, v_row.source_doc_id;
          end if;
          if v_target_id is null then raise exception 'legacy_target_missing_after_insert'; end if;
          v_target_hash := app.legacy_json_hash(v_target_data);
          if v_target_deleted is not null or v_target_hash <> v_source_hash then
            raise exception 'legacy_target_changed_during_copy';
          end if;
          if app.legacy_is_finalized(v_source)
             and v_row.target_table in (
               'preanesthetic_assessments','consultations','anesthesia_records',
               'recovery_records','risk_assessments','consents','prescriptions','documents'
             ) then
            if v_target_finalized is null then
              execute format('select finalized_at from public.%I where id = $1', v_row.target_table)
                into v_target_finalized using v_target_id;
            end if;
            if v_target_finalized is null then
              raise exception 'legacy_target_finalization_mismatch';
            end if;
          end if;
        end if;

        insert into public.legacy_migration_targets(
          registry_id, run_id, target_role, organization_id, table_name,
          target_id, target_legacy_id, copied_hash, copied_version,
          created_by_migration
        ) values (
          v_row.id, v_run, 'primary', v_row.organization_id, v_row.target_table,
          v_target_id, v_row.source_doc_id, v_target_hash,
          v_target_version, v_target_created
        )
        on conflict (registry_id, target_role) do update
          set run_id = excluded.run_id, organization_id = excluded.organization_id,
              table_name = excluded.table_name, target_id = excluded.target_id,
              target_legacy_id = excluded.target_legacy_id,
              copied_hash = excluded.copied_hash,
              copied_version = excluded.copied_version,
              created_by_migration = case
                when legacy_migration_targets.organization_id = excluded.organization_id
                 and legacy_migration_targets.table_name = excluded.table_name
                 and legacy_migration_targets.target_id = excluded.target_id
                  then legacy_migration_targets.created_by_migration or excluded.created_by_migration
                else excluded.created_by_migration
              end;
      end if;

      update public.legacy_document_registry
         set status = 'copied', target_id = v_target_id,
             target_legacy_id = case when v_row.target_table = 'patients'
                                     then v_patient.out_legacy_id
                                     else v_row.source_doc_id end,
             target_hash = v_target_hash, target_version = v_target_version,
             target_created = v_target_created,
             copied_by = auth.uid(), copied_at = clock_timestamp(),
             validated_by = null, validated_at = null,
             rollback_deadline = clock_timestamp() + make_interval(hours => v_hours),
             rolled_back_by = null, rolled_back_at = null,
             last_error_code = null, last_error_at = null
       where id = v_row.id;

      insert into public.legacy_migration_events(
        registry_id, run_id, programmer_id, action, previous_status,
        new_status, organization_id, metadata
      ) values (
        v_row.id, v_run, auth.uid(), 'copy', v_row.status, 'copied',
        v_row.organization_id,
        jsonb_build_object(
          'target_table', v_row.target_table,
          'created', v_target_created,
          'rollback_hours', v_hours
        )
      );
      v_ok := v_ok + 1;
    exception when others then
      v_code := 'copy_failed:' || sqlstate;
      update public.legacy_document_registry
         set last_error_code = v_code, last_error_at = clock_timestamp()
       where id = v_row.id;
      insert into public.legacy_migration_events(
        registry_id, run_id, programmer_id, action, previous_status,
        new_status, organization_id, metadata
      ) values (
        v_row.id, v_run, auth.uid(), 'copy_blocked', v_row.status,
        v_row.status, v_row.organization_id,
        jsonb_build_object('error_code', v_code)
      );
      v_failed := v_failed + 1;
    end;
  end loop;

  insert into public.legacy_access_logs(
    programmer_id, target_user_id, action, row_count, metadata
  )
  select auth.uid(), r.source_user_id, 'migrate', count(*)::integer,
         jsonb_build_object('run_id', v_run)
    from public.legacy_document_registry r
    join auth.users u on u.id = r.source_user_id
   where r.id = any(p_registry_ids)
   group by r.source_user_id;

  update public.legacy_migration_runs
     set status = case when v_blocked + v_failed > 0
                       then 'completed_with_blocks' else 'completed' end,
         succeeded_count = v_ok, blocked_count = v_blocked,
         failed_count = v_failed,
         report = jsonb_build_object(
           'copied', v_ok, 'blocked', v_blocked, 'failed', v_failed
         ),
         finished_at = clock_timestamp()
   where id = v_run;
  return jsonb_build_object(
    'run_id', v_run, 'copied', v_ok,
    'blocked', v_blocked, 'failed', v_failed
  );
end
$fn$;

-- 7) Validação: conteúdo, escopo e vínculos; retorna somente contagens --------
create or replace function public.prog_validate_legacy_documents(
  p_registry_ids uuid[]
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, app, auth
as $fn$
declare
  v_run uuid;
  v_requested integer;
  v_row record;
  v_source jsonb;
  v_source_hash text;
  v_target_data jsonb;
  v_target_hash text;
  v_target_org uuid;
  v_target_version integer;
  v_target_patient uuid;
  v_target_encounter uuid;
  v_target_legacy text;
  v_target_finalized timestamptz;
  v_expected_patient uuid;
  v_expected_encounter uuid;
  v_ok integer := 0;
  v_blocked integer := 0;
  v_code text;
begin
  if not app.eh_programador() then
    raise exception 'Apenas o programador pode validar a migração legada.'
      using errcode = 'insufficient_privilege';
  end if;
  select count(distinct x) into v_requested from unnest(coalesce(p_registry_ids, '{}')) x;
  if v_requested = 0 or v_requested > 250 then
    raise exception 'Selecione entre 1 e 250 linhas.' using errcode = 'invalid_parameter_value';
  end if;
  if (select count(*) from public.legacy_document_registry r where r.id = any(p_registry_ids)) <> v_requested then
    raise exception 'Uma ou mais linhas do inventário não existem.' using errcode = 'invalid_parameter_value';
  end if;

  insert into public.legacy_migration_runs(
    operation, programmer_id, requested_count
  ) values ('validate', auth.uid(), v_requested) returning id into v_run;

  for v_row in
    select r.* from public.legacy_document_registry r
     where r.id = any(p_registry_ids)
     order by r.id for update
  loop
    v_code := null; v_source := null; v_source_hash := null;
    v_target_data := null; v_target_hash := null; v_target_org := null;
    v_target_version := null;
    v_target_patient := null; v_target_encounter := null;
    v_target_legacy := null;
    v_expected_patient := null; v_expected_encounter := null;
    v_target_finalized := null;
    if v_row.status not in ('copied','validated') or v_row.target_id is null then
      v_code := 'not_copied';
    end if;

    if v_code is null then
      execute
        'select coalesce(dados::jsonb, ''{}''::jsonb), '
        '       app.legacy_json_hash(coalesce(dados::jsonb, ''{}''::jsonb)) '
        'from public.documentos '
        'where user_id::text = $1::text and modulo::text = $2 and doc_id::text = $3 limit 1'
        into v_source, v_source_hash
        using v_row.source_user_id, v_row.source_module, v_row.source_doc_id;
      if v_source_hash is null then v_code := 'source_missing';
      elsif v_source_hash <> v_row.source_hash then v_code := 'source_hash_changed';
      end if;
    end if;

    if v_code is null then
      if v_row.target_table = 'patients' then
        select p.organization_id, p.version, p.data,
               null::uuid, null::uuid, p.legacy_id
          into v_target_org, v_target_version, v_target_data,
               v_target_patient, v_target_encounter, v_target_legacy
          from public.patients p
         where p.id = v_row.target_id and p.deleted_at is null
         for share;
      else
        execute format(
          'select organization_id, version, data, patient_id, encounter_id, legacy_id '
          'from public.%I where id = $1 and deleted_at is null for share',
          v_row.target_table
        ) into v_target_org, v_target_version, v_target_data,
               v_target_patient, v_target_encounter, v_target_legacy
          using v_row.target_id;
      end if;
      if v_target_org is null then v_code := 'target_missing';
      elsif v_target_org <> v_row.organization_id then v_code := 'organization_mismatch';
      elsif v_target_legacy is distinct from v_row.target_legacy_id then v_code := 'legacy_id_mismatch';
      elsif v_target_version is distinct from v_row.target_version then v_code := 'target_version_changed';
      else
        v_target_hash := app.legacy_json_hash(v_target_data);
        if v_target_hash <> v_row.source_hash then v_code := 'target_hash_mismatch'; end if;
      end if;
    end if;

    if v_code is null and app.legacy_is_finalized(v_source)
       and v_row.target_table in (
         'preanesthetic_assessments','consultations','anesthesia_records',
         'recovery_records','risk_assessments','consents','prescriptions','documents'
       ) then
      execute format('select finalized_at from public.%I where id = $1', v_row.target_table)
        into v_target_finalized using v_row.target_id;
      if v_target_finalized is null then v_code := 'target_finalization_missing'; end if;
    end if;

    if v_code is null and v_row.target_table <> 'patients' then
      select t.target_id into v_expected_patient
        from public.legacy_migration_targets t
       where t.registry_id = v_row.id and t.target_role = 'patient';
      select t.target_id into v_expected_encounter
        from public.legacy_migration_targets t
       where t.registry_id = v_row.id and t.target_role = 'encounter';
      if app.legacy_patient_key(v_source) is null and v_row.source_module <> 'agenda' then
        v_code := 'patient_identity_missing';
      elsif app.legacy_patient_key(v_source) is not null and v_expected_patient is null then
        v_code := 'patient_mapping_missing';
      elsif v_expected_patient is not null and v_target_patient is distinct from v_expected_patient then
        v_code := 'patient_link_mismatch';
      elsif app.legacy_encounter_key(v_source) is not null and v_expected_encounter is null then
        v_code := 'encounter_mapping_missing';
      elsif v_expected_encounter is not null and v_target_encounter is distinct from v_expected_encounter then
        v_code := 'encounter_link_mismatch';
      end if;
    end if;

    if v_code is null then
      update public.legacy_document_registry
         set status = 'validated', validated_by = auth.uid(),
             validated_at = clock_timestamp(),
             last_error_code = null, last_error_at = null
       where id = v_row.id;
      insert into public.legacy_migration_events(
        registry_id, run_id, programmer_id, action, previous_status,
        new_status, organization_id,
        metadata
      ) values (
        v_row.id, v_run, auth.uid(), 'validate', v_row.status,
        'validated', v_row.organization_id,
        jsonb_build_object('target_table', v_row.target_table)
      );
      v_ok := v_ok + 1;
    else
      update public.legacy_document_registry
         set last_error_code = v_code, last_error_at = clock_timestamp(),
             status = case
               when v_code = 'source_missing' then 'source_missing'
               when v_code = 'source_hash_changed' then 'source_changed'
               else status
             end
       where id = v_row.id;
      insert into public.legacy_migration_events(
        registry_id, run_id, programmer_id, action, previous_status,
        new_status, organization_id, metadata
      ) values (
        v_row.id, v_run, auth.uid(), 'validate_blocked', v_row.status,
        case when v_code = 'source_missing' then 'source_missing'
             when v_code = 'source_hash_changed' then 'source_changed'
             else v_row.status end,
        v_row.organization_id, jsonb_build_object('error_code', v_code)
      );
      v_blocked := v_blocked + 1;
    end if;
  end loop;

  update public.legacy_migration_runs
     set status = case when v_blocked > 0 then 'completed_with_blocks' else 'completed' end,
         succeeded_count = v_ok, blocked_count = v_blocked,
         report = jsonb_build_object('validated', v_ok, 'blocked', v_blocked),
         finished_at = clock_timestamp()
   where id = v_run;
  return jsonb_build_object(
    'run_id', v_run, 'validated', v_ok, 'blocked', v_blocked
  );
end
$fn$;

-- 8) Reversão recuperável: soft-delete somente do que a migração criou e que
-- continua exatamente na versão/hash copiados. Fonte legada nunca é apagada.
create or replace function public.prog_rollback_legacy_documents(
  p_registry_ids uuid[],
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, app, auth
as $fn$
declare
  v_run uuid;
  v_requested integer;
  v_row record;
  v_map record;
  v_data jsonb;
  v_version integer;
  v_deleted timestamptz;
  v_finalized_at timestamptz;
  v_hash text;
  v_changed integer;
  v_ok integer := 0;
  v_blocked integer := 0;
  v_shared_primary_hidden integer := 0;
  v_shared_primary_retained integer := 0;
  v_support_hidden integer := 0;
  v_support_retained integer := 0;
  v_code text;
begin
  if not app.eh_programador() then
    raise exception 'Apenas o programador pode reverter a migração legada.'
      using errcode = 'insufficient_privilege';
  end if;
  if char_length(btrim(coalesce(p_reason, ''))) < 12 then
    raise exception 'Informe uma justificativa com pelo menos 12 caracteres.'
      using errcode = 'invalid_parameter_value';
  end if;
  select count(distinct x) into v_requested from unnest(coalesce(p_registry_ids, '{}')) x;
  if v_requested = 0 or v_requested > 250 then
    raise exception 'Selecione entre 1 e 250 linhas.' using errcode = 'invalid_parameter_value';
  end if;
  if (select count(*) from public.legacy_document_registry r where r.id = any(p_registry_ids)) <> v_requested then
    raise exception 'Uma ou mais linhas do inventário não existem.' using errcode = 'invalid_parameter_value';
  end if;

  insert into public.legacy_migration_runs(
    operation, programmer_id, requested_count
  ) values ('rollback', auth.uid(), v_requested) returning id into v_run;

  for v_row in
    select r.* from public.legacy_document_registry r
     where r.id = any(p_registry_ids)
     order by r.id for update
  loop
    v_code := null; v_changed := 0; v_finalized_at := null;
    if v_row.status not in ('copied','validated','rollback_blocked')
       or v_row.rollback_deadline is null
       or v_row.rollback_deadline < clock_timestamp() then
      v_code := case
        when v_row.rollback_deadline is null then 'not_copied'
        when v_row.rollback_deadline < clock_timestamp() then 'rollback_window_expired'
        else 'rollback_not_allowed'
      end;
    end if;

    select t.* into v_map
      from public.legacy_migration_targets t
     where t.registry_id = v_row.id and t.target_role = 'primary';
    if v_code is null and v_map.id is null then v_code := 'target_mapping_missing'; end if;

    if v_code is null and v_map.created_by_migration and exists (
      select 1
        from public.legacy_migration_targets x
        join public.legacy_document_registry r on r.id = x.registry_id
       where x.organization_id = v_map.organization_id
         and x.table_name = v_map.table_name
         and x.target_id = v_map.target_id
         and x.registry_id <> v_row.id
         and r.status <> 'rolled_back'
    ) then
      -- O alvo é compartilhado por outra linha ainda ativa. Esta associação
      -- pode ser revertida, mas o alvo só será ocultado quando a última sair.
      null;
    elsif v_code is null and v_map.created_by_migration then
      execute format(
        'select data, version, deleted_at from public.%I '
        'where id = $1 and organization_id = $2 for update',
        v_map.table_name
      ) into v_data, v_version, v_deleted
        using v_map.target_id, v_map.organization_id;
      if v_map.table_name in (
        'preanesthetic_assessments','consultations','anesthesia_records',
        'recovery_records','risk_assessments','consents','prescriptions','documents'
      ) then
        execute format('select finalized_at from public.%I where id = $1', v_map.table_name)
          into v_finalized_at using v_map.target_id;
      end if;
      if v_version is null then
        v_code := 'target_missing';
      elsif v_deleted is null then
        v_hash := app.legacy_json_hash(v_data);
        if v_hash <> v_map.copied_hash or v_version <> v_map.copied_version then
          v_code := 'target_changed_after_copy';
        elsif v_finalized_at is not null then
          v_code := 'target_finalized_immutable';
        elsif (
          (v_map.table_name in ('patients','encounters')
           and app.legacy_dependency_count(v_map.table_name, v_map.target_id) > 0)
          or
          (v_map.table_name not in ('patients','encounters')
           and app.legacy_primary_dependency_count(v_map.table_name, v_map.target_id) > 0)
        ) then
          v_code := 'target_has_dependents';
        else
          execute format(
            'update public.%I set deleted_at = clock_timestamp() '
            'where id = $1 and organization_id = $2 and version = $3 and deleted_at is null',
            v_map.table_name
          ) using v_map.target_id, v_map.organization_id, v_map.copied_version;
          get diagnostics v_changed = row_count;
          if v_changed <> 1 then v_code := 'target_changed_during_rollback'; end if;
          if v_code is null then
            execute format('select version from public.%I where id = $1', v_map.table_name)
              into v_version using v_map.target_id;
            update public.legacy_migration_targets
               set copied_version = v_version
             where id = v_map.id;
          end if;
        end if;
      end if;
    end if;

    if v_code is null then
      update public.legacy_document_registry
         set status = 'rolled_back', rolled_back_by = auth.uid(),
             rolled_back_at = clock_timestamp(),
             last_error_code = null, last_error_at = null
       where id = v_row.id;
      insert into public.legacy_migration_events(
        registry_id, run_id, programmer_id, action, previous_status,
        new_status, organization_id, reason,
        metadata
      ) values (
        v_row.id, v_run, auth.uid(), 'rollback', v_row.status,
        'rolled_back', v_row.organization_id, btrim(p_reason),
        jsonb_build_object(
          'target_table', v_map.table_name,
          'soft_deleted', v_changed = 1
        )
      );
      v_ok := v_ok + 1;
    else
      update public.legacy_document_registry
         set status = case when target_id is null then status else 'rollback_blocked' end,
             last_error_code = v_code, last_error_at = clock_timestamp()
       where id = v_row.id;
      insert into public.legacy_migration_events(
        registry_id, run_id, programmer_id, action, previous_status,
        new_status, organization_id, reason, metadata
      ) values (
        v_row.id, v_run, auth.uid(), 'rollback_blocked', v_row.status,
        case when v_row.target_id is null then v_row.status else 'rollback_blocked' end,
        v_row.organization_id, btrim(p_reason),
        jsonb_build_object('error_code', v_code)
      );
      v_blocked := v_blocked + 1;
    end if;
  end loop;

  -- Se o criador de um alvo compartilhado foi revertido numa execução anterior,
  -- a última associação pode não carregar `created_by_migration`. Localizamos
  -- o mapa criador e ocultamos o alvo somente depois que todas as associações
  -- estiverem revertidas.
  for v_map in
    select distinct on (creator.organization_id, creator.table_name, creator.target_id)
           creator.*
      from public.legacy_migration_targets selected
      join public.legacy_migration_targets creator
        on creator.organization_id = selected.organization_id
       and creator.table_name = selected.table_name
       and creator.target_id = selected.target_id
       and creator.created_by_migration
     where selected.registry_id = any(p_registry_ids)
       and selected.target_role = 'primary'
     order by creator.organization_id, creator.table_name,
              creator.target_id, creator.created_at
  loop
    v_finalized_at := null;
    if exists (
      select 1
        from public.legacy_migration_targets x
        join public.legacy_document_registry r on r.id = x.registry_id
       where x.organization_id = v_map.organization_id
         and x.table_name = v_map.table_name
         and x.target_id = v_map.target_id
         and r.status <> 'rolled_back'
    ) then
      v_shared_primary_retained := v_shared_primary_retained + 1;
      continue;
    end if;

    execute format(
      'select data, version, deleted_at from public.%I '
      'where id = $1 and organization_id = $2 for update',
      v_map.table_name
    ) into v_data, v_version, v_deleted
      using v_map.target_id, v_map.organization_id;
    if v_deleted is not null then continue; end if;
    if v_map.table_name in (
      'preanesthetic_assessments','consultations','anesthesia_records',
      'recovery_records','risk_assessments','consents','prescriptions','documents'
    ) then
      execute format('select finalized_at from public.%I where id = $1', v_map.table_name)
        into v_finalized_at using v_map.target_id;
    end if;
    if v_version is null
       or app.legacy_json_hash(v_data) <> v_map.copied_hash
       or v_version <> v_map.copied_version
       or v_finalized_at is not null
       or (
         (v_map.table_name in ('patients','encounters')
          and app.legacy_dependency_count(v_map.table_name, v_map.target_id) > 0)
         or
         (v_map.table_name not in ('patients','encounters')
          and app.legacy_primary_dependency_count(v_map.table_name, v_map.target_id) > 0)
       ) then
      v_shared_primary_retained := v_shared_primary_retained + 1;
      continue;
    end if;
    execute format(
      'update public.%I set deleted_at = clock_timestamp() '
      'where id = $1 and organization_id = $2 and version = $3 and deleted_at is null',
      v_map.table_name
    ) using v_map.target_id, v_map.organization_id, v_map.copied_version;
    get diagnostics v_changed = row_count;
    if v_changed = 1 then
      v_shared_primary_hidden := v_shared_primary_hidden + 1;
    else
      v_shared_primary_retained := v_shared_primary_retained + 1;
    end if;
  end loop;

  -- Pacientes/atendimentos auxiliares são ocultados apenas quando foram
  -- criados por este migrador, continuam imutáveis e nenhum registro ativo
  -- (migrado ou normal) depende deles. Se houver dúvida, permanecem intactos.
  for v_map in
    select distinct on (creator.organization_id, creator.table_name, creator.target_id)
           creator.*
      from public.legacy_migration_targets selected
      join public.legacy_migration_targets creator
        on creator.organization_id = selected.organization_id
       and creator.table_name = selected.table_name
       and creator.target_id = selected.target_id
       and creator.created_by_migration
     where selected.registry_id = any(p_registry_ids)
       and selected.target_role in ('patient','encounter')
     order by creator.organization_id, creator.table_name,
              creator.target_id, creator.created_at
  loop
    if exists (
      select 1
        from public.legacy_migration_targets x
        join public.legacy_document_registry r on r.id = x.registry_id
       where x.organization_id = v_map.organization_id
         and x.table_name = v_map.table_name
         and x.target_id = v_map.target_id
         and r.status <> 'rolled_back'
    ) or app.legacy_dependency_count(v_map.table_name, v_map.target_id) > 0 then
      v_support_retained := v_support_retained + 1;
      continue;
    end if;

    execute format(
      'select data, version, deleted_at from public.%I '
      'where id = $1 and organization_id = $2 for update',
      v_map.table_name
    ) into v_data, v_version, v_deleted
      using v_map.target_id, v_map.organization_id;
    if v_version is null or v_deleted is not null
       or app.legacy_json_hash(v_data) <> v_map.copied_hash
       or v_version <> v_map.copied_version then
      v_support_retained := v_support_retained + 1;
      continue;
    end if;

    execute format(
      'update public.%I set deleted_at = clock_timestamp() '
      'where id = $1 and organization_id = $2 and version = $3 and deleted_at is null',
      v_map.table_name
    ) using v_map.target_id, v_map.organization_id, v_map.copied_version;
    get diagnostics v_changed = row_count;
    if v_changed = 1 then
      v_support_hidden := v_support_hidden + 1;
    else
      v_support_retained := v_support_retained + 1;
    end if;
  end loop;

  update public.legacy_migration_runs
     set status = case
           when v_blocked + v_shared_primary_retained + v_support_retained > 0
             then 'completed_with_blocks' else 'completed' end,
         succeeded_count = v_ok,
         blocked_count = v_blocked + v_shared_primary_retained + v_support_retained,
         report = jsonb_build_object(
           'rolled_back', v_ok, 'blocked', v_blocked,
           'shared_primary_hidden', v_shared_primary_hidden,
           'shared_primary_retained', v_shared_primary_retained,
           'support_hidden', v_support_hidden,
           'support_retained', v_support_retained
         ),
         finished_at = clock_timestamp()
   where id = v_run;
  return jsonb_build_object(
    'run_id', v_run, 'rolled_back', v_ok, 'blocked', v_blocked,
    'shared_primary_hidden', v_shared_primary_hidden,
    'shared_primary_retained', v_shared_primary_retained,
    'support_hidden', v_support_hidden,
    'support_retained', v_support_retained
  );
end
$fn$;

-- Mudança do legado depois do freeze exige uma segunda decisão explícita. Só
-- é possível antes da cópia; o novo hash torna-se a nova baseline auditada.
create or replace function public.prog_ack_legacy_source_change(
  p_registry_id uuid,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, app, auth
as $fn$
declare
  v_row public.legacy_document_registry%rowtype;
  v_status text;
begin
  if not app.eh_programador() then
    raise exception 'Apenas o programador pode reconhecer mudança no legado.'
      using errcode = 'insufficient_privilege';
  end if;
  if char_length(btrim(coalesce(p_reason, ''))) < 12 then
    raise exception 'Informe uma justificativa com pelo menos 12 caracteres.'
      using errcode = 'invalid_parameter_value';
  end if;
  select * into v_row from public.legacy_document_registry
   where id = p_registry_id for update;
  if v_row.id is null or v_row.status <> 'source_changed' or v_row.target_id is not null then
    raise exception 'A linha não está disponível para reconhecer a mudança.'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  v_status := case when v_row.target_table is null then 'unsupported'
                   when v_row.organization_id is not null then 'classified'
                   else 'quarantined' end;
  update public.legacy_document_registry
     set source_hash = observed_hash,
         source_updated_at = observed_updated_at,
         source_bytes = observed_bytes,
         status = v_status,
         last_error_code = null, last_error_at = null
   where id = p_registry_id;
  insert into public.legacy_migration_events(
    registry_id, programmer_id, action, previous_status, new_status,
    organization_id, reason, metadata
  ) values (
    p_registry_id, auth.uid(), 'ack_source_change', v_row.status, v_status,
    v_row.organization_id, btrim(p_reason),
    jsonb_build_object('hash_rebased', true)
  );
  return jsonb_build_object('registry_id', p_registry_id, 'status', v_status);
end
$fn$;

-- 9) Privilégios dos RPCs ----------------------------------------------------
revoke all on function public.prog_inventory_legacy_documents() from public, anon;
revoke all on function public.prog_legacy_migration_summary() from public, anon;
revoke all on function public.prog_list_legacy_documents(uuid, text, text, integer, integer) from public, anon;
revoke all on function public.prog_classify_legacy_documents(uuid[], uuid, text) from public, anon;
revoke all on function public.prog_copy_legacy_documents(uuid[], integer) from public, anon;
revoke all on function public.prog_validate_legacy_documents(uuid[]) from public, anon;
revoke all on function public.prog_rollback_legacy_documents(uuid[], text) from public, anon;
revoke all on function public.prog_ack_legacy_source_change(uuid, text) from public, anon;

grant execute on function public.prog_inventory_legacy_documents() to authenticated;
grant execute on function public.prog_legacy_migration_summary() to authenticated;
grant execute on function public.prog_list_legacy_documents(uuid, text, text, integer, integer) to authenticated;
grant execute on function public.prog_classify_legacy_documents(uuid[], uuid, text) to authenticated;
grant execute on function public.prog_copy_legacy_documents(uuid[], integer) to authenticated;
grant execute on function public.prog_validate_legacy_documents(uuid[]) to authenticated;
grant execute on function public.prog_rollback_legacy_documents(uuid[], text) to authenticated;
grant execute on function public.prog_ack_legacy_source_change(uuid, text) to authenticated;

-- A leitura bruta criada na transição B1 deixa de ser uma API do navegador.
-- O objeto é preservado por compatibilidade/forense, mas somente o dono do
-- banco pode executá-lo; o fluxo B2 acima nunca devolve `dados` ao cliente.
do $block$
begin
  if to_regprocedure('public.prog_read_legacy_documents(uuid,integer,integer)') is not null then
    execute 'revoke all on function public.prog_read_legacy_documents(uuid, integer, integer) from public, anon, authenticated';
  end if;
end
$block$;

-- Reafirma o freeze. A migração lê a origem por SECURITY DEFINER, mas nenhum
-- navegador ganha acesso direto nem permissão de apagar/alterar a fonte.
do $block$
begin
  if to_regclass('public.documentos') is not null then
    execute 'revoke all on table public.documentos from public, anon, authenticated';
  end if;
end
$block$;

commit;
