-- 0034 candidate: explicit legacy ownership, immutable stamps and historical provenance.
-- LOCAL REVIEW ONLY. No production identity is embedded in this DDL.
-- Original0024 is preserved byte for byte; its copy/validation implementations
-- below retain the original conflict, hash, linkage and no-overwrite contract.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';
set local check_function_bodies = off;


-- Stop existing legacy writers before inspecting their committed results.
-- EXCLUSIVE also conflicts with SELECT FOR UPDATE (ROW SHARE) in old RPCs.
lock table public.legacy_document_registry,public.legacy_migration_targets in exclusive mode;

-- Upgrade preflight: legacy copies already made under0024 need their own
-- provenance retrofit. Do not strand them behind new mandatory bindings.
do $preflight$
begin
  if exists(select 1 from public.legacy_document_registry
      where target_id is not null or status in ('copied','validated'))
    or exists(select 1 from public.legacy_migration_targets) then
    raise exception 'legacy_existing_import_requires_reviewed_provenance_retrofit' using errcode='55000';
  end if;
end
$preflight$;

-- Advisory locks serialize checks only when each later statement can see the
-- winner's committed row. Never silently promise this under a stale snapshot.
create or replace function app.assert_legacy_identity_isolation()
returns void language plpgsql security invoker
set search_path = pg_catalog
as $fn$
begin
  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'legacy_identity_requires_read_committed' using errcode = '0A000';
  end if;
end
$fn$;
revoke all on function app.assert_legacy_identity_isolation() from public,anon,authenticated,service_role;


create or replace function app.legacy_base_module(p_module text)
returns text language plpgsql immutable security invoker
set search_path = pg_catalog
as $fn$
begin
  if p_module is null then return null; end if;
  if position('@' in p_module) = 0 then return p_module; end if;
  if p_module !~ '^[^@]+@[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
    raise exception 'legacy_organization_stamp_invalid' using errcode = '22023';
  end if;
  return split_part(p_module, '@', 1);
end
$fn$;

create or replace function app.legacy_source_organization(p_module text, p_data jsonb)
returns uuid language plpgsql immutable security invoker
set search_path = pg_catalog, app
as $fn$
declare module_org uuid; data_org uuid; raw_org text;
begin
  perform app.legacy_base_module(p_module);
  if position('@' in coalesce(p_module,'')) > 0 then
    module_org := split_part(p_module,'@',2)::uuid;
  end if;
  raw_org := nullif(btrim(coalesce(p_data->>'_relOrg','')), '');
  if raw_org is not null then
    if raw_org !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
      raise exception 'legacy_organization_stamp_invalid' using errcode = '22023';
    end if;
    data_org := raw_org::uuid;
  end if;
  if module_org is not null and data_org is not null and module_org <> data_org then
    raise exception 'legacy_organization_stamps_disagree' using errcode = '23514';
  end if;
  return coalesce(module_org,data_org);
end
$fn$;

create or replace function app.legacy_target_table(p_module text)
returns text language sql immutable security invoker
set search_path = pg_catalog, app
as $fn$
  select case app.legacy_base_module(p_module)
    when 'pacientes' then 'patients' when 'agenda' then 'appointments'
    when 'pre' then 'preanesthetic_assessments' when 'consulta' then 'consultations'
    when 'anestesia' then 'anesthesia_records' when 'recuperacao' then 'recovery_records'
    when 'risco' then 'risk_assessments' when 'termo' then 'consents'
    when 'prescricao' then 'prescriptions' when 'documentos' then 'documents'
    when 'financeiro' then 'finance_entries' when 'orcamento' then 'quotes'
    else null end
$fn$;

create table public.legacy_provenance_bindings (
  id uuid primary key default gen_random_uuid(),
  source_user_id uuid not null references auth.users(id) on delete restrict,
  organization_id uuid not null references public.organizations(id) on delete restrict,
  source_scope text not null check(source_scope in ('unstamped_only','matching_stamp_only')),
  owner_statement text not null check(char_length(btrim(owner_statement)) between 12 and 500),
  evidence_reference text not null check(char_length(btrim(evidence_reference)) between 8 and 200),
  source_count integer not null check(source_count > 0),
  source_manifest_hash text not null check(source_manifest_hash ~ '^[0-9a-f]{64}$'),
  recorded_by uuid not null references auth.users(id) on delete restrict,
  recorded_at timestamptz not null default clock_timestamp()
);
alter table public.legacy_document_registry add column provenance_binding_id uuid
  references public.legacy_provenance_bindings(id) on delete restrict;

-- Existing patients are adopted only by an explicit per-source mapping.
-- Neither a matching name nor the source user's current memberships authorize it.
create table public.legacy_patient_bindings (
  registry_id uuid primary key references public.legacy_document_registry(id) on delete restrict,
  source_user_id uuid not null references auth.users(id) on delete restrict,
  organization_id uuid not null references public.organizations(id) on delete restrict,
  source_hash text not null check(source_hash ~ '^[0-9a-f]{64}$'),
  patient_id uuid not null references public.patients(id) on delete restrict,
  reason text not null check(char_length(btrim(reason)) between 12 and 500),
  recorded_by uuid not null references auth.users(id) on delete restrict,
  recorded_at timestamptz not null default clock_timestamp()
);

create table public.legacy_import_provenance (
  registry_id uuid primary key references public.legacy_document_registry(id) on delete restrict,
  binding_id uuid not null references public.legacy_provenance_bindings(id) on delete restrict,
  source_user_id uuid not null references auth.users(id) on delete restrict,
  organization_id uuid not null references public.organizations(id) on delete restrict,
  source_hash text not null check(source_hash ~ '^[0-9a-f]{64}$'),
  target_table text not null,
  target_id uuid not null,
  target_hash text not null check(target_hash ~ '^[0-9a-f]{64}$'),
  target_created_by_migration boolean not null,
  source_claims_finalized boolean not null,
  historical_finalized_at_claim timestamptz,
  historical_timestamp_present boolean not null,
  historical_timestamp_valid boolean not null,
  historical_author_claims_hash text not null check(historical_author_claims_hash ~ '^[0-9a-f]{64}$'),
  historical_claims_verified boolean not null default false check(historical_claims_verified = false),
  canonical_created_by uuid references auth.users(id) on delete restrict,
  canonical_finalized_by uuid references auth.users(id) on delete restrict,
  canonical_finalized_at timestamptz,
  canonical_stamp_kind text not null check(canonical_stamp_kind in ('import','pre_existing_destination')),
  imported_by uuid not null references auth.users(id) on delete restrict,
  imported_at timestamptz not null
);

create or replace function app.guard_legacy_provenance_append_only()
returns trigger language plpgsql security invoker
set search_path = pg_catalog
as $fn$
begin
  raise exception 'legacy_provenance_is_append_only' using errcode = '23514';
end
$fn$;
do $block$
declare t text;
begin
  foreach t in array array['legacy_provenance_bindings','legacy_patient_bindings','legacy_import_provenance'] loop
    execute format('alter table public.%I enable row level security',t);
    execute format('alter table public.%I force row level security',t);
    execute format('revoke all on table public.%I from public,anon,authenticated,service_role',t);
    execute format('grant select on table public.%I to authenticated',t);
    execute format('create policy %I on public.%I for select to authenticated using (app.eh_programador())',t||'_prog_sel',t);
    execute format('create trigger trg_provenance_append_only before update or delete on public.%I for each row execute function app.guard_legacy_provenance_append_only()',t);
    execute format('alter table public.%I enable always trigger trg_provenance_append_only',t);
    execute format('create trigger trg_provenance_no_truncate before truncate on public.%I for each statement execute function app.guard_legacy_provenance_append_only()',t);
    execute format('alter table public.%I enable always trigger trg_provenance_no_truncate',t);
  end loop;
end
$block$;

create or replace function app.legacy_scope_fingerprint(p_source_user uuid,p_org uuid,p_scope text)
returns table(source_count integer,source_manifest_hash text)
language plpgsql stable security invoker
set search_path = pg_catalog,public,app
as $fn$
begin
  if p_scope not in ('unstamped_only','matching_stamp_only') or p_source_user is null or p_org is null then
    raise exception 'legacy_provenance_scope_invalid' using errcode = '22023';
  end if;
  return query
    select count(*)::integer,
      encode(extensions.digest(convert_to(coalesce(string_agg(app.legacy_json_hash(jsonb_build_array(
          d.user_id::text,d.modulo::text,d.doc_id::text,app.legacy_json_hash(coalesce(d.dados::jsonb,'{}'::jsonb))
        )), E'\n' order by d.modulo::text,d.doc_id::text),''),'UTF8'),'sha256'),'hex')
    from public.documentos d
    where d.user_id = p_source_user and (
      (p_scope='unstamped_only' and app.legacy_source_organization(d.modulo::text,d.dados::jsonb) is null)
      or (p_scope='matching_stamp_only' and app.legacy_source_organization(d.modulo::text,d.dados::jsonb)=p_org)
    );
end
$fn$;

create or replace function public.prog_legacy_provenance_preview(p_source_user uuid,p_org uuid,p_scope text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog,public,app,auth
as $fn$
declare v_count integer; v_hash text;
begin
  if auth.uid() is null or not app.eh_programador() then
    raise exception 'legacy_programmer_required' using errcode = '42501';
  end if;
  if not exists(select 1 from auth.users where id=p_source_user)
    or not exists(select 1 from public.organizations where id=p_org and ativo) then
    raise exception 'legacy_provenance_identity_invalid' using errcode = '22023';
  end if;
  select f.source_count,f.source_manifest_hash into v_count,v_hash
    from app.legacy_scope_fingerprint(p_source_user,p_org,p_scope) f;
  return jsonb_build_object('source_count',v_count,'source_manifest_hash',v_hash,'source_scope',p_scope);
end
$fn$;

create or replace function public.prog_bind_legacy_provenance(
  p_source_user uuid,p_org uuid,p_scope text,p_owner_statement text,p_evidence_reference text,
  p_expected_source_count integer,p_expected_manifest_hash text
)
returns jsonb language plpgsql security definer
set search_path = pg_catalog,public,app,auth
as $fn$
declare v_preview jsonb; v_id uuid;
begin
  if auth.uid() is null or not app.eh_programador() then
    raise exception 'legacy_programmer_required' using errcode = '42501';
  end if;
  if char_length(btrim(coalesce(p_owner_statement,''))) not between 12 and 500
    or char_length(btrim(coalesce(p_evidence_reference,''))) not between 8 and 200
    or p_expected_source_count is null or p_expected_source_count < 1
    or coalesce(p_expected_manifest_hash,'') !~ '^[0-9a-f]{64}$' then
    raise exception 'legacy_provenance_evidence_invalid' using errcode = '22023';
  end if;
  perform app.assert_legacy_identity_isolation();
  perform pg_advisory_xact_lock(hashtextextended('soft-anestesia:legacy-provenance:'||p_source_user::text||':'||p_scope,0));
  v_preview := public.prog_legacy_provenance_preview(p_source_user,p_org,p_scope);
  if (v_preview->>'source_count')::integer is distinct from p_expected_source_count
    or v_preview->>'source_manifest_hash' is distinct from p_expected_manifest_hash then
    raise exception 'legacy_provenance_snapshot_changed' using errcode = '40001';
  end if;
  if p_scope='unstamped_only' and exists(select 1 from public.legacy_provenance_bindings
    where source_user_id=p_source_user and source_scope=p_scope
      and source_manifest_hash=p_expected_manifest_hash and source_count=p_expected_source_count and organization_id<>p_org) then
    raise exception 'legacy_provenance_conflicting_organization' using errcode = '23514';
  end if;
  insert into public.legacy_provenance_bindings(source_user_id,organization_id,source_scope,
    owner_statement,evidence_reference,source_count,source_manifest_hash,recorded_by)
  values(p_source_user,p_org,p_scope,btrim(p_owner_statement),btrim(p_evidence_reference),
    p_expected_source_count,p_expected_manifest_hash,auth.uid()) returning id into v_id;
  insert into public.legacy_migration_events(programmer_id,action,organization_id,reason,metadata)
  values(auth.uid(),'classify',p_org,'Owner provenance evidence recorded',jsonb_build_object(
    'binding_id',v_id,'source_user_id',p_source_user,'source_scope',p_scope,
    'source_count',p_expected_source_count,'source_manifest_hash',p_expected_manifest_hash));
  return jsonb_build_object('binding_id',v_id,'source_count',p_expected_source_count);
end
$fn$;

-- Every subsequent operation rechecks the exact owner, immutable org stamp,
-- source hash and reviewed cohort. It never treats a binding as a global grant.
create or replace function app.legacy_assert_provenance(p_registry uuid,p_org uuid)
returns uuid language plpgsql security invoker
set search_path = pg_catalog,public,app,auth
as $fn$
declare r public.legacy_document_registry%rowtype; b public.legacy_provenance_bindings%rowtype;
  v_data jsonb; v_stamp uuid; v_count integer; v_hash text;
begin
  select * into r from public.legacy_document_registry where id=p_registry;
  if r.id is null or r.organization_id is distinct from p_org or r.provenance_binding_id is null then
    raise exception 'legacy_provenance_binding_required' using errcode = '55000';
  end if;
  select * into b from public.legacy_provenance_bindings where id=r.provenance_binding_id;
  if b.id is null or b.source_user_id is distinct from r.source_user_id or b.organization_id is distinct from p_org then
    raise exception 'legacy_provenance_scope_mismatch' using errcode = '23514';
  end if;
  select coalesce(dados::jsonb,'{}'::jsonb) into v_data from public.documentos
    where user_id=r.source_user_id and modulo=r.source_module and doc_id=r.source_doc_id;
  if v_data is null or app.legacy_json_hash(v_data) is distinct from r.source_hash then
    raise exception 'legacy_provenance_source_changed' using errcode = '40001';
  end if;
  v_stamp := app.legacy_source_organization(r.source_module,v_data);
  if (v_stamp is not null and v_stamp is distinct from p_org)
    or (b.source_scope='unstamped_only' and v_stamp is not null)
    or (b.source_scope='matching_stamp_only' and v_stamp is distinct from p_org) then
    raise exception 'legacy_organization_stamp_mismatch' using errcode = '23514';
  end if;
  return b.id;
end
$fn$;


create or replace function app.legacy_assert_binding_snapshot(p_binding uuid)
returns void language plpgsql security invoker
set search_path = pg_catalog,public,app
as $fn$
declare b public.legacy_provenance_bindings%rowtype; v_count integer; v_hash text;
begin
  select * into b from public.legacy_provenance_bindings where id=p_binding;
  if b.id is null then raise exception 'legacy_provenance_binding_required' using errcode = '55000'; end if;
  select f.source_count,f.source_manifest_hash into v_count,v_hash
    from app.legacy_scope_fingerprint(b.source_user_id,b.organization_id,b.source_scope) f;
  if v_count is distinct from b.source_count or v_hash is distinct from b.source_manifest_hash then
    raise exception 'legacy_provenance_snapshot_changed' using errcode = '40001';
  end if;
end
$fn$;

create or replace function app.guard_legacy_registry_provenance()
returns trigger language plpgsql security invoker
set search_path = pg_catalog,public,app,auth
as $fn$
begin
  if old.organization_id is not null and new.organization_id is distinct from old.organization_id then
    raise exception 'legacy_classified_organization_immutable' using errcode = '23514';
  end if;
  if old.provenance_binding_id is not null and new.provenance_binding_id is distinct from old.provenance_binding_id then
    raise exception 'legacy_classification_evidence_immutable' using errcode = '23514';
  end if;
  if (new.organization_id is distinct from old.organization_id or new.provenance_binding_id is distinct from old.provenance_binding_id)
    and (auth.uid() is null or not app.eh_programador() or new.provenance_binding_id is null) then
    raise exception 'legacy_programmer_provenance_required' using errcode = '42501';
  end if;
  -- An old0024 body compiled before this migration may resume afterwards.
  -- Its transaction must not publish copied targets without the new evidence.
  if new.target_id is not null or new.status in ('copied','validated') then
    if new.provenance_binding_id is null then
      raise exception 'legacy_provenance_binding_required' using errcode='55000';
    end if;
    perform app.legacy_assert_provenance(old.id,new.organization_id);
  end if;
  return new;
end
$fn$;
create trigger trg_legacy_registry_provenance before update
  on public.legacy_document_registry for each row execute function app.guard_legacy_registry_provenance();
alter table public.legacy_document_registry enable always trigger trg_legacy_registry_provenance;

create or replace function public.prog_classify_legacy_documents(p_registry_ids uuid[],p_org uuid,p_reason text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog,public,app,auth
as $fn$
declare r record; b record; v_run uuid; v_requested integer; v_stamp uuid; v_data jsonb; v_scope text; v_binding uuid;
begin
  if auth.uid() is null or not app.eh_programador() then
    raise exception 'legacy_programmer_required' using errcode = '42501';
  end if;
  if not exists(select 1 from public.organizations where id=p_org and ativo)
    or char_length(btrim(coalesce(p_reason,''))) not between 12 and 500 then
    raise exception 'legacy_classification_request_invalid' using errcode = '22023';
  end if;
  select count(distinct x) into v_requested from unnest(coalesce(p_registry_ids,'{}'::uuid[])) x;
  if v_requested not between 1 and 250 or
    (select count(*) from public.legacy_document_registry where id=any(p_registry_ids)) <> v_requested then
    raise exception 'legacy_registry_selection_invalid' using errcode = '22023';
  end if;
  insert into public.legacy_migration_runs(operation,programmer_id,requested_count,filters)
  values('classify',auth.uid(),v_requested,jsonb_build_object('organization_id',p_org)) returning id into v_run;
  for r in select * from public.legacy_document_registry where id=any(p_registry_ids) order by id for update loop
    if r.target_table is null or r.status not in ('quarantined','classified','target_conflict')
      or (r.target_id is not null and r.status <> 'target_conflict') then
      raise exception 'legacy_registry_not_classifiable' using errcode = '55000';
    end if;
    if r.organization_id is not null and r.organization_id <> p_org then
      raise exception 'legacy_classified_organization_immutable' using errcode = '23514';
    end if;
    select coalesce(dados::jsonb,'{}'::jsonb) into v_data from public.documentos
      where user_id=r.source_user_id and modulo=r.source_module and doc_id=r.source_doc_id;
    if v_data is null or app.legacy_json_hash(v_data) is distinct from r.source_hash then
      raise exception 'legacy_provenance_source_changed' using errcode = '40001';
    end if;
    v_stamp := app.legacy_source_organization(r.source_module,v_data);
    if v_stamp is not null and v_stamp <> p_org then
      raise exception 'legacy_organization_stamp_mismatch' using errcode = '23514';
    end if;
    v_scope := case when v_stamp is null then 'unstamped_only' else 'matching_stamp_only' end;
    v_binding := r.provenance_binding_id;
    if v_binding is null then
      select id into v_binding from public.legacy_provenance_bindings
       where source_user_id=r.source_user_id and organization_id=p_org and source_scope=v_scope
       order by recorded_at desc,id desc limit 1;
    end if;
    if v_binding is null then raise exception 'legacy_provenance_binding_required' using errcode = '55000'; end if;
    update public.legacy_document_registry set organization_id=p_org,provenance_binding_id=v_binding,
      classification_reason=btrim(p_reason),classified_by=auth.uid(),classified_at=clock_timestamp(),status='classified',
      target_id=null,target_legacy_id=null,target_hash=null,target_version=null,target_created=null,
      copied_by=null,copied_at=null,validated_by=null,validated_at=null,rollback_deadline=null,
      rolled_back_by=null,rolled_back_at=null,last_error_code=null,last_error_at=null where id=r.id;
    perform app.legacy_assert_provenance(r.id,p_org);
    insert into public.legacy_migration_events(registry_id,run_id,programmer_id,action,previous_status,
      new_status,organization_id,reason,metadata)
    values(r.id,v_run,auth.uid(),'classify',r.status,'classified',p_org,btrim(p_reason),
      jsonb_build_object('binding_id',v_binding,'source_user_id',r.source_user_id,'source_scope',v_scope));
  end loop;
  for b in select distinct on (p.source_user_id,p.organization_id,p.source_scope,p.source_count,p.source_manifest_hash) p.id
    from public.legacy_provenance_bindings p join public.legacy_document_registry registry_row on registry_row.provenance_binding_id=p.id
    where registry_row.id=any(p_registry_ids)
    order by p.source_user_id,p.organization_id,p.source_scope,p.source_count,p.source_manifest_hash,p.id loop
    perform app.legacy_assert_binding_snapshot(b.id);
  end loop;
  update public.legacy_migration_runs set status='completed',succeeded_count=v_requested,
    report=jsonb_build_object('classified',v_requested),finished_at=clock_timestamp() where id=v_run;
  insert into public.legacy_access_logs(programmer_id,target_user_id,action,row_count,metadata)
    select auth.uid(),source_user_id,'assign',count(*)::integer,jsonb_build_object('run_id',v_run,'organization_id',p_org)
    from public.legacy_document_registry where id=any(p_registry_ids) group by source_user_id;
  return jsonb_build_object('run_id',v_run,'classified',v_requested);
end
$fn$;

create or replace function public.prog_bind_legacy_patient(p_registry uuid,p_patient uuid,p_reason text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog,public,app,auth
as $fn$
declare r public.legacy_document_registry%rowtype;
begin
  if auth.uid() is null or not app.eh_programador() then
    raise exception 'legacy_programmer_required' using errcode = '42501';
  end if;
  select * into r from public.legacy_document_registry where id=p_registry for update;
  if r.id is null or r.status not in ('classified','target_conflict') or r.organization_id is null
    or char_length(btrim(coalesce(p_reason,''))) not between 12 and 500 then
    raise exception 'legacy_patient_mapping_request_invalid' using errcode = '22023';
  end if;
  perform app.legacy_assert_provenance(r.id,r.organization_id);
  if not exists(select 1 from public.patients where id=p_patient and organization_id=r.organization_id and deleted_at is null) then
    raise exception 'legacy_patient_mapping_cross_organization' using errcode = '23514';
  end if;
  if exists(select 1 from public.patients where id=p_patient and nullif(btrim(legacy_id),'') is null) then
    raise exception 'legacy_patient_mapping_key_unavailable' using errcode = '55000';
  end if;
  insert into public.legacy_patient_bindings(registry_id,source_user_id,organization_id,source_hash,patient_id,reason,recorded_by)
  values(r.id,r.source_user_id,r.organization_id,r.source_hash,p_patient,btrim(p_reason),auth.uid());
  insert into public.legacy_migration_events(registry_id,programmer_id,action,organization_id,reason,metadata)
  values(r.id,auth.uid(),'classify',r.organization_id,btrim(p_reason),jsonb_build_object('patient_mapping',true,'patient_id',p_patient));
  return jsonb_build_object('registry_id',r.id,'patient_mapping_recorded',true);
end
$fn$;

create or replace function app.legacy_patient_lookup_key(p_registry uuid,p_org uuid,p_data jsonb)
returns text language plpgsql stable security invoker
set search_path = pg_catalog,public,app
as $fn$
declare v_key text;
begin
  select p.legacy_id into v_key from public.legacy_patient_bindings b join public.patients p on p.id=b.patient_id
    join public.legacy_document_registry r on r.id=b.registry_id
    where b.registry_id=p_registry and b.organization_id=p_org and p.organization_id=p_org and p.deleted_at is null
      and b.source_user_id=r.source_user_id and b.source_hash=app.legacy_json_hash(p_data);
  if found then
    if nullif(btrim(v_key),'') is null then raise exception 'legacy_patient_mapping_key_unavailable' using errcode = '55000'; end if;
    return v_key;
  end if;
  return app.legacy_patient_key(p_data);
end
$fn$;

create or replace function app.legacy_ensure_bound_patient(p_registry uuid,p_org uuid,p_data jsonb,p_primary boolean)
returns table(out_target_id uuid,out_legacy_id text,out_hash text,out_version integer,out_created boolean)
language plpgsql security invoker
set search_path = pg_catalog,public,app,auth
as $fn$
declare v_row record; v_key text; v_name text; v_cpf text; v_prontuario text;
begin
  perform app.legacy_assert_provenance(p_registry,p_org);
  select p.id,p.legacy_id,app.legacy_json_hash(p.data) as data_hash,p.version into v_row
    from public.legacy_patient_bindings b join public.patients p on p.id=b.patient_id
    join public.legacy_document_registry r on r.id=b.registry_id
    where b.registry_id=p_registry and b.organization_id=p_org and p.organization_id=p_org and p.deleted_at is null
      and b.source_user_id=r.source_user_id and b.source_hash=app.legacy_json_hash(p_data) for share of p;
  if found then
    if nullif(btrim(v_row.legacy_id),'') is null then raise exception 'legacy_patient_mapping_key_unavailable' using errcode = '55000'; end if;
    return query select v_row.id,v_row.legacy_id,v_row.data_hash,v_row.version,false;
    return;
  end if;
  if exists(select 1 from public.legacy_patient_bindings where registry_id=p_registry) then
    raise exception 'legacy_patient_mapping_stale' using errcode = '55000';
  end if;
  -- Serialize legacy importers before reading any candidate patient. Different
  -- names with the same CPF cannot both observe an empty set and then insert.
  perform pg_advisory_xact_lock(hashtextextended('soft-anestesia:patient-identity:'||p_org::text,0));
  v_key := app.legacy_patient_key(p_data);
  if v_key is null then return; end if;
  v_name := public.med_normalizar(app.legacy_patient_name(p_data));
  v_cpf := regexp_replace(coalesce(p_data->>'cpf',p_data->>'paciente_cpf',p_data#>>'{paciente,cpf}',''),'[^0-9]','','g');
  v_prontuario := coalesce(nullif(btrim(p_data->>'prontuario'),''),nullif(btrim(p_data#>>'{paciente,prontuario}'),''));
  if exists(select 1 from public.patients p where p.organization_id=p_org and (
    p.legacy_id=v_key or (v_name<>'' and public.med_normalizar(p.nome)=v_name)
    or (char_length(v_cpf)>=11 and regexp_replace(coalesce(p.cpf,''),'[^0-9]','','g')=v_cpf)
    or (v_prontuario is not null and btrim(p.prontuario)=v_prontuario)
  )) then
    raise exception 'legacy_patient_mapping_required' using errcode = '55000';
  end if;
  select * into v_row from app.legacy_ensure_patient(p_org,p_data,p_primary);
  if v_row.out_target_id is null then return; end if;
  if not v_row.out_created then
    raise exception 'legacy_patient_mapping_required' using errcode = '55000';
  end if;
  return query select v_row.out_target_id,v_row.out_legacy_id,v_row.out_hash,v_row.out_version,true;
end
$fn$;


-- An index on(organization_id,cpf) is not UNIQUE. Serialize the constraint-like
-- check for every normal writer and the importer, then re-read after the lock.
-- Existing patients/CPF values are preserved; only new conflicting assignments
-- are rejected. The normalized eleven-digit identity is not a CPF validity claim.
create or replace function app.guard_patient_identity_assignment()
returns trigger language plpgsql security definer
set search_path = pg_catalog,public,app,auth
as $fn$
declare v_cpf text;
begin
  -- AFTER ROW runs only after RLS accepts the requested assignment.
  -- It neither grants data access nor reveals a foreign CPF through an
  -- earlier uniqueness exception. Existing unchanged historical duplicates
  -- may still receive ordinary metadata updates/upserts.
  v_cpf := regexp_replace(coalesce(new.cpf,''),'[^0-9]','','g');
  if tg_op='UPDATE' and v_cpf=regexp_replace(coalesce(old.cpf,''),'[^0-9]','','g') then return new; end if;
  if char_length(v_cpf)<>11 then return new; end if;
  perform app.assert_legacy_identity_isolation();
  perform pg_advisory_xact_lock(hashtextextended('soft-anestesia:patient-identity:'||new.organization_id::text,0));
  if exists(select 1 from public.patients p
    where p.organization_id=new.organization_id and p.id is distinct from new.id
      and regexp_replace(coalesce(p.cpf,''),'[^0-9]','','g')=v_cpf) then
    raise exception 'patient_identity_already_registered' using errcode = '23505';
  end if;
  return new;
end
$fn$;
create trigger trg_patient_identity_assignment after insert or update of cpf on public.patients
  for each row execute function app.guard_patient_identity_assignment();
alter table public.patients enable always trigger trg_patient_identity_assignment;
revoke all on function app.guard_patient_identity_assignment() from public,anon,authenticated,service_role;


-- Freeze is an actual database contract, including privileged service writers.
-- Original clinical bytes remain untouched. No writer is exempted by role.
create or replace function app.guard_legacy_frozen_source()
returns trigger language plpgsql security invoker
set search_path = pg_catalog
as $fn$
begin
  raise exception 'legacy_source_frozen' using errcode = '23514';
end
$fn$;
create trigger trg_legacy_source_frozen before insert or update or delete on public.documentos
  for each row execute function app.guard_legacy_frozen_source();
alter table public.documentos enable always trigger trg_legacy_source_frozen;
create trigger trg_legacy_source_no_truncate before truncate on public.documentos
  for each statement execute function app.guard_legacy_frozen_source();
alter table public.documentos enable always trigger trg_legacy_source_no_truncate;
revoke insert,update,delete,truncate,references,trigger on table public.documentos
  from public,anon,authenticated,service_role;
revoke all on function app.guard_legacy_frozen_source() from public,anon,authenticated,service_role;
revoke all on function app.legacy_ensure_patient(uuid,jsonb,boolean) from public,anon,authenticated,service_role;
revoke all on function app.legacy_ensure_encounter(uuid,uuid,jsonb) from public,anon,authenticated,service_role;


-- A date/procedure/name collision cannot merge different surgical cases.
create table public.legacy_encounter_bindings (
  registry_id uuid primary key references public.legacy_document_registry(id) on delete restrict,
  source_user_id uuid not null references auth.users(id) on delete restrict,
  organization_id uuid not null references public.organizations(id) on delete restrict,
  source_hash text not null check(source_hash ~ '^[0-9a-f]{64}$'),
  encounter_id uuid not null references public.encounters(id) on delete restrict,
  reason text not null check(char_length(btrim(reason)) between 12 and 500),
  recorded_by uuid not null references auth.users(id) on delete restrict,
  recorded_at timestamptz not null default clock_timestamp()
);
alter table public.legacy_encounter_bindings enable row level security;
alter table public.legacy_encounter_bindings force row level security;
revoke all on table public.legacy_encounter_bindings from public,anon,authenticated,service_role;
grant select on table public.legacy_encounter_bindings to authenticated;
create policy legacy_encounter_bindings_prog_sel on public.legacy_encounter_bindings
  for select to authenticated using(app.eh_programador());
create trigger trg_provenance_append_only before update or delete on public.legacy_encounter_bindings
  for each row execute function app.guard_legacy_provenance_append_only();
alter table public.legacy_encounter_bindings enable always trigger trg_provenance_append_only;
create trigger trg_provenance_no_truncate before truncate on public.legacy_encounter_bindings
  for each statement execute function app.guard_legacy_provenance_append_only();
alter table public.legacy_encounter_bindings enable always trigger trg_provenance_no_truncate;

create or replace function public.prog_bind_legacy_encounter(p_registry uuid,p_encounter uuid,p_reason text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog,public,app,auth
as $fn$
declare r public.legacy_document_registry%rowtype;
begin
  if auth.uid() is null or not app.eh_programador() then
    raise exception 'legacy_programmer_required' using errcode = '42501';
  end if;
  select * into r from public.legacy_document_registry where id=p_registry for update;
  if r.id is null or r.status not in ('classified','target_conflict') or r.organization_id is null
    or char_length(btrim(coalesce(p_reason,''))) not between 12 and 500 then
    raise exception 'legacy_encounter_mapping_request_invalid' using errcode = '22023';
  end if;
  perform app.legacy_assert_provenance(r.id,r.organization_id);
  if not exists(select 1 from public.encounters e join public.legacy_patient_bindings b
    on b.registry_id=r.id and b.patient_id=e.patient_id
    where e.id=p_encounter and e.organization_id=r.organization_id and e.deleted_at is null
      and b.organization_id=r.organization_id and b.source_user_id=r.source_user_id and b.source_hash=r.source_hash) then
    raise exception 'legacy_encounter_mapping_patient_or_organization_mismatch' using errcode = '23514';
  end if;
  if exists(select 1 from public.encounters where id=p_encounter and nullif(btrim(legacy_id),'') is null) then
    raise exception 'legacy_encounter_mapping_key_unavailable' using errcode = '55000';
  end if;
  insert into public.legacy_encounter_bindings(registry_id,source_user_id,organization_id,source_hash,
    encounter_id,reason,recorded_by)
  values(r.id,r.source_user_id,r.organization_id,r.source_hash,p_encounter,btrim(p_reason),auth.uid());
  insert into public.legacy_migration_events(registry_id,programmer_id,action,organization_id,reason,metadata)
  values(r.id,auth.uid(),'classify',r.organization_id,btrim(p_reason),jsonb_build_object('encounter_mapping',true,'encounter_id',p_encounter));
  return jsonb_build_object('registry_id',r.id,'encounter_mapping_recorded',true);
end
$fn$;

create or replace function app.legacy_ensure_bound_encounter(p_registry uuid,p_org uuid,p_patient uuid,p_data jsonb)
returns table(out_target_id uuid,out_legacy_id text,out_hash text,out_version integer,out_created boolean)
language plpgsql security invoker
set search_path = pg_catalog,public,app,auth
as $fn$
declare v_row record; v_key text;
begin
  perform app.legacy_assert_provenance(p_registry,p_org);
  select e.id,e.legacy_id,app.legacy_json_hash(e.data) as data_hash,e.version into v_row
    from public.legacy_encounter_bindings b join public.encounters e on e.id=b.encounter_id
    join public.legacy_document_registry r on r.id=b.registry_id
    where b.registry_id=p_registry and b.organization_id=p_org and e.organization_id=p_org and e.deleted_at is null
      and e.patient_id=p_patient and b.source_user_id=r.source_user_id and b.source_hash=app.legacy_json_hash(p_data) for share of e;
  if found then
    if nullif(btrim(v_row.legacy_id),'') is null then raise exception 'legacy_encounter_mapping_key_unavailable' using errcode = '55000'; end if;
    return query select v_row.id,v_row.legacy_id,v_row.data_hash,v_row.version,false;
    return;
  end if;
  if exists(select 1 from public.legacy_encounter_bindings where registry_id=p_registry) then
    raise exception 'legacy_encounter_mapping_stale' using errcode = '55000';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('soft-anestesia:legacy-encounter:'||p_org::text,0));
  v_key := app.legacy_encounter_key(p_data);
  if v_key is null or p_patient is null then return; end if;
  if exists(select 1 from public.encounters where organization_id=p_org and legacy_id=v_key) then
    raise exception 'legacy_encounter_mapping_required' using errcode = '55000';
  end if;
  select * into v_row from app.legacy_ensure_encounter(p_org,p_patient,p_data);
  if v_row.out_target_id is null then return; end if;
  if not v_row.out_created then
    raise exception 'legacy_encounter_mapping_required' using errcode = '55000';
  end if;
  if not exists(select 1 from public.encounters where id=v_row.out_target_id
    and organization_id=p_org and patient_id=p_patient and deleted_at is null) then
    raise exception 'legacy_encounter_patient_or_organization_mismatch' using errcode = '23514';
  end if;
  return query select v_row.out_target_id,v_row.out_legacy_id,v_row.out_hash,v_row.out_version,true;
end
$fn$;
revoke all on function public.prog_bind_legacy_encounter(uuid,uuid,text) from public,anon,authenticated,service_role;
grant execute on function public.prog_bind_legacy_encounter(uuid,uuid,text) to authenticated;
revoke all on function app.legacy_ensure_bound_encounter(uuid,uuid,uuid,jsonb) from public,anon,authenticated,service_role;


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
              when legacy_document_registry.status = 'unsupported' and excluded.target_table is not null then 'quarantined'
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

create or replace function app.legacy_copy_with_bound_identity(
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
        perform app.legacy_capture_import_provenance(v_row.id);
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
         and app.legacy_base_module(v_row.source_module) <> 'agenda'
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
                              then app.legacy_patient_lookup_key(v_row.id, v_row.organization_id, v_source)
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
          from app.legacy_ensure_bound_patient(v_row.id, v_row.organization_id, v_source, true);
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
          from app.legacy_ensure_bound_patient(v_row.id, v_row.organization_id, v_source, false);
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
            from app.legacy_ensure_bound_encounter(
              v_row.id, v_row.organization_id, v_patient.out_target_id, v_source
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
      perform app.legacy_capture_import_provenance(v_row.id);
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

create or replace function app.legacy_validate_original_contract(
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
    elsif not exists(select 1 from public.legacy_import_provenance i where i.registry_id=v_row.id
      and i.binding_id=v_row.provenance_binding_id and i.source_user_id=v_row.source_user_id
      and i.organization_id=v_row.organization_id and i.source_hash=v_row.source_hash
      and i.target_table=v_row.target_table and i.target_id=v_row.target_id and i.target_hash=v_row.target_hash
      and i.imported_by=v_row.copied_by and i.imported_at=v_row.copied_at and not i.historical_claims_verified) then
      v_code := 'import_provenance_mismatch';
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
      if app.legacy_patient_key(v_source) is null and app.legacy_base_module(v_row.source_module) <> 'agenda' then
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


-- The retained0024 implementation cannot be invoked by clients. Only these
-- wrappers can enter it after the source/organization/provenance checks.
create or replace function app.legacy_capture_import_provenance(p_registry uuid)
returns void language plpgsql security invoker
set search_path = pg_catalog,public,app,auth
as $fn$
declare r public.legacy_document_registry%rowtype; v_source jsonb; v_target jsonb;
  v_created_by uuid; v_finalized_by uuid; v_finalized_at timestamptz; v_date timestamptz;
  v_historical_present boolean; v_author_hash text; v_existing public.legacy_import_provenance%rowtype;
begin
  select * into r from public.legacy_document_registry where id=p_registry for update;
  if r.id is null or r.status not in ('copied','validated') or r.target_id is null or r.copied_by is null or r.copied_at is null then
    raise exception 'legacy_import_receipt_incomplete' using errcode = '55000';
  end if;
  perform app.legacy_assert_provenance(r.id,r.organization_id);
  select coalesce(dados::jsonb,'{}'::jsonb) into v_source from public.documentos
    where user_id=r.source_user_id and modulo=r.source_module and doc_id=r.source_doc_id;
  if r.target_table not in ('patients','appointments','preanesthetic_assessments','consultations',
    'anesthesia_records','recovery_records','risk_assessments','consents','prescriptions',
    'documents','finance_entries','quotes') then
    raise exception 'legacy_import_target_invalid' using errcode = '23514';
  end if;
  execute format('select to_jsonb(t) from public.%I t where id=$1 and organization_id=$2 and deleted_at is null for share',r.target_table)
    into v_target using r.target_id,r.organization_id;
  if v_target is null or app.legacy_json_hash(v_target->'data') is distinct from r.source_hash
    or r.target_hash is distinct from r.source_hash or (v_target->>'version')::integer is distinct from r.target_version then
    raise exception 'legacy_import_target_evidence_mismatch' using errcode = '23514';
  end if;
  v_created_by := (v_target->>'created_by')::uuid;
  v_finalized_by := (v_target->>'finalized_by')::uuid;
  v_finalized_at := (v_target->>'finalized_at')::timestamptz;
  v_historical_present := nullif(btrim(coalesce(v_source->>'_finalizadoEm','')),'') is not null;
  v_date := app.legacy_timestamp(v_source->>'_finalizadoEm');
  v_author_hash := app.legacy_json_hash(jsonb_strip_nulls(jsonb_build_object(
    '_finalizadoPor',v_source->'_finalizadoPor','_relCreatedBy',v_source->'_relCreatedBy',
    '_relUpdatedBy',v_source->'_relUpdatedBy')));
  insert into public.legacy_import_provenance(registry_id,binding_id,source_user_id,organization_id,
    source_hash,target_table,target_id,target_hash,target_created_by_migration,source_claims_finalized,
    historical_finalized_at_claim,historical_timestamp_present,historical_timestamp_valid,
    historical_author_claims_hash,historical_claims_verified,canonical_created_by,canonical_finalized_by,
    canonical_finalized_at,canonical_stamp_kind,imported_by,imported_at)
  values(r.id,r.provenance_binding_id,r.source_user_id,r.organization_id,r.source_hash,r.target_table,
    r.target_id,r.target_hash,coalesce(r.target_created,false),app.legacy_is_finalized(v_source),v_date,
    v_historical_present,v_date is not null,v_author_hash,false,v_created_by,v_finalized_by,v_finalized_at,
    case when r.target_created then 'import' else 'pre_existing_destination' end,r.copied_by,r.copied_at)
  on conflict (registry_id) do nothing;
  select * into v_existing from public.legacy_import_provenance where registry_id=r.id;
  if v_existing.binding_id is distinct from r.provenance_binding_id
    or v_existing.source_user_id is distinct from r.source_user_id
    or v_existing.organization_id is distinct from r.organization_id
    or v_existing.source_hash is distinct from r.source_hash
    or v_existing.target_table is distinct from r.target_table
    or v_existing.target_id is distinct from r.target_id
    or v_existing.target_hash is distinct from r.target_hash
    or v_existing.target_created_by_migration is distinct from coalesce(r.target_created,false)
    or v_existing.source_claims_finalized is distinct from app.legacy_is_finalized(v_source)
    or v_existing.historical_finalized_at_claim is distinct from v_date
    or v_existing.historical_timestamp_present is distinct from v_historical_present
    or v_existing.historical_timestamp_valid is distinct from (v_date is not null)
    or v_existing.historical_author_claims_hash is distinct from v_author_hash
    or v_existing.historical_claims_verified
    or v_existing.canonical_created_by is distinct from v_created_by
    or v_existing.canonical_finalized_by is distinct from v_finalized_by
    or v_existing.canonical_finalized_at is distinct from v_finalized_at
    or v_existing.canonical_stamp_kind is distinct from
      (case when r.target_created then 'import' else 'pre_existing_destination' end)
    or v_existing.imported_by is distinct from r.copied_by or v_existing.imported_at is distinct from r.copied_at then
    raise exception 'legacy_import_provenance_changed' using errcode = '23514';
  end if;
end
$fn$;

create or replace function public.prog_copy_legacy_documents(p_registry_ids uuid[],p_rollback_hours integer)
returns jsonb language plpgsql security definer
set search_path = pg_catalog,public,app,auth
as $fn$
declare r record; b record; v_result jsonb; v_requested integer;
begin
  if auth.uid() is null or not app.eh_programador() then
    raise exception 'legacy_programmer_required' using errcode = '42501';
  end if;
  select count(distinct x) into v_requested from unnest(coalesce(p_registry_ids,'{}'::uuid[])) x;
  if v_requested not between 1 and 250 or
    (select count(*) from public.legacy_document_registry where id=any(p_registry_ids)) <> v_requested then
    raise exception 'legacy_registry_selection_invalid' using errcode = '22023';
  end if;
  perform app.assert_legacy_identity_isolation();
  -- Acquire per-organization identity locks in a deterministic order before
  -- touching individual rows, including batches spanning several clinics.
  for r in select distinct organization_id from public.legacy_document_registry
    where id=any(p_registry_ids) and organization_id is not null order by organization_id loop
    perform pg_advisory_xact_lock(hashtextextended('soft-anestesia:patient-identity:'||r.organization_id::text,0));
    perform pg_advisory_xact_lock(hashtextextended('soft-anestesia:legacy-encounter:'||r.organization_id::text,0));
  end loop;
  for r in select id,organization_id from public.legacy_document_registry where id=any(p_registry_ids) order by id for update loop
    perform app.legacy_assert_provenance(r.id,r.organization_id);
  end loop;
  for b in select distinct on (p.source_user_id,p.organization_id,p.source_scope,p.source_count,p.source_manifest_hash) p.id
    from public.legacy_provenance_bindings p join public.legacy_document_registry registry_row on registry_row.provenance_binding_id=p.id
    where registry_row.id=any(p_registry_ids)
    order by p.source_user_id,p.organization_id,p.source_scope,p.source_count,p.source_manifest_hash,p.id loop
    perform app.legacy_assert_binding_snapshot(b.id);
  end loop;
  v_result := app.legacy_copy_with_bound_identity(p_registry_ids,p_rollback_hours);
  return v_result;
end
$fn$;

create or replace function public.prog_validate_legacy_documents(p_registry_ids uuid[])
returns jsonb language plpgsql security definer
set search_path = pg_catalog,public,app,auth
as $fn$
declare r record; b record; v_requested integer; v_result jsonb;
begin
  if auth.uid() is null or not app.eh_programador() then
    raise exception 'legacy_programmer_required' using errcode = '42501';
  end if;
  select count(distinct x) into v_requested from unnest(coalesce(p_registry_ids,'{}'::uuid[])) x;
  if v_requested not between 1 and 250 or
    (select count(*) from public.legacy_document_registry where id=any(p_registry_ids)) <> v_requested then
    raise exception 'legacy_registry_selection_invalid' using errcode = '22023';
  end if;
  for r in select id,organization_id,status from public.legacy_document_registry where id=any(p_registry_ids) order by id for update loop
    perform app.legacy_assert_provenance(r.id,r.organization_id);
  end loop;
  for b in select distinct on (p.source_user_id,p.organization_id,p.source_scope,p.source_count,p.source_manifest_hash) p.id
    from public.legacy_provenance_bindings p join public.legacy_document_registry registry_row on registry_row.provenance_binding_id=p.id
    where registry_row.id=any(p_registry_ids)
    order by p.source_user_id,p.organization_id,p.source_scope,p.source_count,p.source_manifest_hash,p.id loop
    perform app.legacy_assert_binding_snapshot(b.id);
  end loop;
  v_result := app.legacy_validate_original_contract(p_registry_ids);
  for r in select id from public.legacy_document_registry where id=any(p_registry_ids)
    and status='validated' and last_error_code is null order by id loop
    perform app.legacy_capture_import_provenance(r.id);
  end loop;
  return v_result;
end
$fn$;

-- Operational UI scope check: a plain module may still carry _relOrg.
-- Compare every selected source to the exact reviewed immutable binding.
create or replace function public.prog_check_legacy_scope(p_registry_ids uuid[],p_binding_id uuid)
returns jsonb language plpgsql security definer
set search_path=pg_catalog,public,app,auth
as $fn$
declare r public.legacy_document_registry%rowtype; b public.legacy_provenance_bindings%rowtype;
  v_data jsonb; v_stamp uuid; v_requested integer;
begin
  if auth.uid() is null or not app.eh_programador() then
    raise exception 'legacy_programmer_required' using errcode='42501';
  end if;
  select * into b from public.legacy_provenance_bindings where id=p_binding_id;
  if b.id is null then raise exception 'legacy_provenance_binding_required' using errcode='55000'; end if;
  perform app.legacy_assert_binding_snapshot(b.id);
  select count(distinct x) into v_requested from unnest(coalesce(p_registry_ids,'{}'::uuid[])) x;
  if v_requested not between 1 and 250 or
    (select count(*) from public.legacy_document_registry registry_row where registry_row.id=any(p_registry_ids))<>v_requested then
    raise exception 'legacy_registry_selection_invalid' using errcode='22023';
  end if;
  for r in select * from public.legacy_document_registry registry_row where registry_row.id=any(p_registry_ids) order by registry_row.id loop
    if r.source_user_id is distinct from b.source_user_id or
      (r.organization_id is not null and r.organization_id is distinct from b.organization_id) then
      raise exception 'legacy_provenance_scope_mismatch' using errcode='23514';
    end if;
    select coalesce(d.dados::jsonb,'{}'::jsonb) into v_data from public.documentos d
      where d.user_id=r.source_user_id and d.modulo=r.source_module and d.doc_id=r.source_doc_id;
    if v_data is null or app.legacy_json_hash(v_data) is distinct from r.source_hash then
      raise exception 'legacy_provenance_source_changed' using errcode='40001';
    end if;
    v_stamp:=app.legacy_source_organization(r.source_module,v_data);
    if (b.source_scope='unstamped_only' and v_stamp is not null) or
      (b.source_scope='matching_stamp_only' and v_stamp is distinct from b.organization_id) then
      raise exception 'legacy_organization_stamp_mismatch' using errcode='23514';
    end if;
  end loop;
  insert into public.legacy_migration_events(programmer_id,action,metadata)
    values(auth.uid(),'list',jsonb_build_object('view','source_scope','binding_id',b.id,'row_count',v_requested));
  return jsonb_build_object('binding_id',b.id,'selected_count',v_requested,'scope_confirmed',true);
end
$fn$;

-- No raw payload, author claim, patient identity or owner token is returned by
-- a new RPC. Every new public RPC verifies auth.uid and the programmer table.
revoke all on function app.legacy_base_module(text) from public,anon,authenticated,service_role;
revoke all on function app.legacy_source_organization(text,jsonb) from public,anon,authenticated,service_role;
revoke all on function app.legacy_target_table(text) from public,anon,authenticated,service_role;
revoke all on function app.guard_legacy_provenance_append_only() from public,anon,authenticated,service_role;
revoke all on function app.legacy_scope_fingerprint(uuid,uuid,text) from public,anon,authenticated,service_role;
revoke all on function app.legacy_assert_binding_snapshot(uuid) from public,anon,authenticated,service_role;
revoke all on function app.legacy_assert_provenance(uuid,uuid) from public,anon,authenticated,service_role;
revoke all on function app.guard_legacy_registry_provenance() from public,anon,authenticated,service_role;
revoke all on function app.legacy_patient_lookup_key(uuid,uuid,jsonb) from public,anon,authenticated,service_role;
revoke all on function app.legacy_ensure_bound_patient(uuid,uuid,jsonb,boolean) from public,anon,authenticated,service_role;
revoke all on function app.legacy_copy_with_bound_identity(uuid[],integer) from public,anon,authenticated,service_role;
revoke all on function app.legacy_validate_original_contract(uuid[]) from public,anon,authenticated,service_role;
revoke all on function app.legacy_capture_import_provenance(uuid) from public,anon,authenticated,service_role;
revoke all on function public.prog_legacy_provenance_preview(uuid,uuid,text) from public,anon,authenticated,service_role;
revoke all on function public.prog_bind_legacy_provenance(uuid,uuid,text,text,text,integer,text) from public,anon,authenticated,service_role;
revoke all on function public.prog_bind_legacy_patient(uuid,uuid,text) from public,anon,authenticated,service_role;
revoke all on function public.prog_classify_legacy_documents(uuid[],uuid,text) from public,anon,authenticated,service_role;
revoke all on function public.prog_copy_legacy_documents(uuid[],integer) from public,anon,authenticated,service_role;
revoke all on function public.prog_validate_legacy_documents(uuid[]) from public,anon,authenticated,service_role;
revoke all on function public.prog_check_legacy_scope(uuid[],uuid) from public,anon,authenticated,service_role;
grant execute on function public.prog_check_legacy_scope(uuid[],uuid) to authenticated;
grant execute on function public.prog_legacy_provenance_preview(uuid,uuid,text) to authenticated;
grant execute on function public.prog_bind_legacy_provenance(uuid,uuid,text,text,text,integer,text) to authenticated;
grant execute on function public.prog_bind_legacy_patient(uuid,uuid,text) to authenticated;
grant execute on function public.prog_classify_legacy_documents(uuid[],uuid,text) to authenticated;
grant execute on function public.prog_copy_legacy_documents(uuid[],integer) to authenticated;
grant execute on function public.prog_validate_legacy_documents(uuid[]) to authenticated;
commit;
