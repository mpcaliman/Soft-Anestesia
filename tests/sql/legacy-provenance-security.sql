-- LOCAL DISPOSABLE DATABASE ONLY. This fixture is not a remote migration.
-- Execute SEED immediately before0034, then VERIFY after0034. Seeded records
-- are fully synthetic; the entire isolated project is removed after evidence.
-- Never disable the ALWAYS source/provenance guards to make a fixture pass.

-- BEGIN LEGACY PROVENANCE SEED
begin;
set local statement_timeout = '30s';
do $guard$
begin
  if current_database()<>'postgres' or current_setting('server_version_num')::integer/10000<>17
    or exists(select 1 from public.documentos)
    or to_regnamespace('legacy_provenance_fixture') is not null
    or to_regprocedure('public.prog_bind_legacy_provenance(uuid,uuid,text,text,text,integer,text)') is not null then
    raise exception 'Legacy provenance fixture requires an empty isolated pre0034 source';
  end if;
end
$guard$;
create schema legacy_provenance_fixture;
revoke all on schema legacy_provenance_fixture from public,anon,authenticated,service_role;
create table legacy_provenance_fixture.source_originals as select * from public.documentos with no data;
create table legacy_provenance_fixture.destination_originals(table_name text,id uuid,original jsonb);
revoke all on all tables in schema legacy_provenance_fixture from public,anon,authenticated,service_role;
insert into auth.users(id,email) values
 ('fe110000-0000-4000-8000-000000000001','legacy-owner-a@example.invalid'),
 ('fe110000-0000-4000-8000-000000000002','legacy-owner-b@example.invalid'),
 ('fe110000-0000-4000-8000-000000000003','legacy-programmer@example.invalid'),
 ('fe110000-0000-4000-8000-000000000004','legacy-ordinary@example.invalid'),
 ('fe110000-0000-4000-8000-000000000005','legacy-programmer-b@example.invalid');
insert into public.app_programmers(user_id) values('fe110000-0000-4000-8000-000000000003'),('fe110000-0000-4000-8000-000000000005');
insert into public.organizations(id,nome) values
 ('fe220000-0000-4000-8000-000000000001','Synthetic legacy clinic A'),
 ('fe220000-0000-4000-8000-000000000002','Synthetic legacy clinic B');
insert into public.organization_users(organization_id,user_id,role,ativo) values
 ('fe220000-0000-4000-8000-000000000001','fe110000-0000-4000-8000-000000000001','gestor',true),
 ('fe220000-0000-4000-8000-000000000002','fe110000-0000-4000-8000-000000000002','gestor',true),
 ('fe220000-0000-4000-8000-000000000001','fe110000-0000-4000-8000-000000000004','gestor',true);
insert into public.patients(id,organization_id,nome,cpf,legacy_id,data,created_by) values
 ('fe330000-0000-4000-8000-000000000001','fe220000-0000-4000-8000-000000000001',
  'ExistingSynthetic','22222222222','existing-approved-patient','{"fixture":"canonical patient retained"}',
  'fe110000-0000-4000-8000-000000000001'),
 ('fe330000-0000-4000-8000-000000000003','fe220000-0000-4000-8000-000000000001',
  'HistoricalDuplicateOne','77777777777','historical-duplicate-one','{"fixture":"historical duplicate preserved"}',
  'fe110000-0000-4000-8000-000000000001'),
 ('fe330000-0000-4000-8000-000000000004','fe220000-0000-4000-8000-000000000001',
  'HistoricalDuplicateTwo','77777777777','historical-duplicate-two','{"fixture":"historical duplicate preserved"}',
  'fe110000-0000-4000-8000-000000000001'),
 ('fe330000-0000-4000-8000-000000000005','fe220000-0000-4000-8000-000000000001',
  'SyntheticNullLegacy',null,null,'{"fixture":"unkeyed patient preserved"}',
  'fe110000-0000-4000-8000-000000000001'),
 ('fe330000-0000-4000-8000-000000000002','fe220000-0000-4000-8000-000000000002',
  'ForeignSynthetic','33333333333','foreign-patient','{"fixture":"foreign canonical retained"}',
  'fe110000-0000-4000-8000-000000000002');
insert into public.encounters(id,organization_id,patient_id,legacy_id,procedimento,data_prevista,data) values
 ('fe440000-0000-4000-8000-000000000001','fe220000-0000-4000-8000-000000000001',
  'fe330000-0000-4000-8000-000000000001',
  app.legacy_encounter_key('{"paciente_nome":"ExistingSynthetic","data":"2001-01-01","procedimento":"cirurgiafixture"}'),
  'cirurgiafixture','2001-01-01','{"fixture":"existing surgical case retained"}'),
 ('fe440000-0000-4000-8000-000000000002','fe220000-0000-4000-8000-000000000001',
  'fe330000-0000-4000-8000-000000000001',null,'unkeyedcase','2001-01-01','{"fixture":"unkeyed case preserved"}');
insert into public.preanesthetic_assessments(id,organization_id,legacy_id,patient_id,data) values
 ('fe550000-0000-4000-8000-000000000001','fe220000-0000-4000-8000-000000000001','legacy-divergent',
  'fe330000-0000-4000-8000-000000000001','{"fixture":"divergent canonical retained"}');
insert into public.documentos(user_id,modulo,doc_id,dados,atualizado_em) values
 ('fe110000-0000-4000-8000-000000000001','pacientes','legacy-new-patient',
  '{"nome":"ProvenanceSyntheticOne","cpf":"11111111111","nascimento":"1980-01-01"}','2000-01-01'),
 ('fe110000-0000-4000-8000-000000000001','pre','legacy-finalized',
  '{"paciente_nome":"HistoricalSynthetic","cpf":"44444444444","data":"2000-01-01","procedimento":"procedimentohistorico","_finalizado":true,"_finalizadoEm":"2000-01-01T12:00:00Z","_finalizadoPor":"synthetic historical claim"}','2000-01-02'),
 ('fe110000-0000-4000-8000-000000000001','pre','legacy-existing',
  '{"paciente_nome":"ExistingSynthetic","cpf":"22222222222","fixture":"explicit patient mapping"}','2000-01-01'),
 ('fe110000-0000-4000-8000-000000000001','pre','legacy-divergent',
  '{"paciente_nome":"ExistingSynthetic","fixture":"source differs from canonical"}','2000-01-01'),
 ('fe110000-0000-4000-8000-000000000001','pre','legacy-case-reuse',
  '{"paciente_nome":"ExistingSynthetic","data":"2001-01-01","procedimento":"cirurgiafixture","fixture":"explicit encounter mapping"}','2000-01-01'),
 ('fe110000-0000-4000-8000-000000000001','pre','legacy-race-a',
  '{"paciente_nome":"RaceSyntheticA","cpf":"66666666666","fixture":"concurrent legacy identity A"}','2000-01-01'),
 ('fe110000-0000-4000-8000-000000000001','pre','legacy-race-b',
  '{"paciente_nome":"RaceSyntheticB","cpf":"66666666666","fixture":"concurrent legacy identity B"}','2000-01-01'),
 ('fe110000-0000-4000-8000-000000000001','cad_clinicas','legacy-unsupported',
  '{"fixture":"unsupported retained"}','2000-01-01'),
 ('fe110000-0000-4000-8000-000000000001','pre@fe220000-0000-4000-8000-000000000001','legacy-stamped',
  '{"paciente_nome":"StampedSynthetic","_relOrg":"fe220000-0000-4000-8000-000000000001","fixture":"stamped source retained"}','2000-01-01'),
 ('fe110000-0000-4000-8000-000000000001','agenda','legacy-agenda',
  '{"_relOrg":"fe220000-0000-4000-8000-000000000001","fixture":"stamped appointment without patient"}','2000-01-01'),
 ('fe110000-0000-4000-8000-000000000001','pre@fe220000-0000-4000-8000-000000000002','legacy-other-clinic',
  '{"paciente_nome":"OtherClinicSynthetic","fixture":"different stamp retained"}','2000-01-01'),
 ('fe110000-0000-4000-8000-000000000002','pre','legacy-other-owner',
  '{"paciente_nome":"OtherOwnerSynthetic","fixture":"different owner retained"}','2000-01-01');
insert into legacy_provenance_fixture.source_originals select * from public.documentos;
insert into legacy_provenance_fixture.destination_originals
 select 'patients',id,to_jsonb(p) from public.patients p where id in
  ('fe330000-0000-4000-8000-000000000001','fe330000-0000-4000-8000-000000000002',
   'fe330000-0000-4000-8000-000000000003','fe330000-0000-4000-8000-000000000004','fe330000-0000-4000-8000-000000000005');
insert into legacy_provenance_fixture.destination_originals
 select 'encounters',id,to_jsonb(e) from public.encounters e where id in ('fe440000-0000-4000-8000-000000000001','fe440000-0000-4000-8000-000000000002');
insert into legacy_provenance_fixture.destination_originals
 select 'preanesthetic_assessments',id,to_jsonb(p) from public.preanesthetic_assessments p where id='fe550000-0000-4000-8000-000000000001';
commit;
-- END LEGACY PROVENANCE SEED

-- BEGIN LEGACY PROVENANCE VERIFY
begin;
set local statement_timeout = '60s';
do $guard$
declare t text;
begin
  if (select count(*) from legacy_provenance_fixture.source_originals)<>12 then
    raise exception 'Legacy fixture source inventory differs';
  end if;
  if not exists(select 1 from pg_trigger where tgrelid='public.documentos'::regclass
    and tgname='trg_legacy_source_frozen' and tgenabled='A' and tgtype=31)
    or not exists(select 1 from pg_trigger where tgrelid='public.documentos'::regclass
    and tgname='trg_legacy_source_no_truncate' and tgenabled='A' and tgtype=34) then
    raise exception 'Legacy source ALWAYS freeze contract missing';
  end if;
  foreach t in array array['legacy_provenance_bindings','legacy_patient_bindings','legacy_encounter_bindings','legacy_import_provenance'] loop
    if not exists(select 1 from pg_class where oid=to_regclass('public.'||t) and relrowsecurity and relforcerowsecurity)
      or has_table_privilege('anon','public.'||t,'SELECT')
      or has_table_privilege('authenticated','public.'||t,'INSERT')
      or has_table_privilege('service_role','public.'||t,'TRUNCATE') then
      raise exception 'Legacy provenance table privilege boundary missing';
    end if;
  end loop;
end
$guard$;
-- Simulate an old compiled0024 body attempting its final registry writes.
-- A NULL-binding row cannot become copied/validated or acquire a target.
do $old_body_guard$
declare v_id uuid;
begin
  insert into public.legacy_document_registry(source_user_id,source_module,source_doc_id,
    source_hash,observed_hash,target_table,status)
  values('fe110000-0000-4000-8000-000000000001','pre','old-compiled-body-test',
    repeat('0',64),repeat('0',64),'preanesthetic_assessments','quarantined') returning id into v_id;
  begin
    update public.legacy_document_registry set target_id='fe550000-0000-4000-8000-000000000001' where id=v_id;
    raise exception 'Old legacy body assigned a target without provenance';
  exception when object_not_in_prerequisite_state then null; end;
  begin
    update public.legacy_document_registry set status='copied' where id=v_id;
    raise exception 'Old legacy body published copied without provenance';
  exception when object_not_in_prerequisite_state then null; end;
  begin
    update public.legacy_document_registry set status='validated' where id=v_id;
    raise exception 'Old legacy body published validated without provenance';
  exception when object_not_in_prerequisite_state then null; end;
  delete from public.legacy_document_registry where id=v_id;
end
$old_body_guard$;
do $ordinary_identity$
begin
  perform set_config('request.jwt.claim.sub','fe110000-0000-4000-8000-000000000004',true);
  perform set_config('request.jwt.claims','{"sub":"fe110000-0000-4000-8000-000000000004","role":"authenticated"}',true);
end
$ordinary_identity$;
set local role authenticated;
do $ordinary$
begin
  begin
    perform public.prog_legacy_provenance_preview('fe110000-0000-4000-8000-000000000001','fe220000-0000-4000-8000-000000000001','unstamped_only');
    raise exception 'Ordinary member accessed legacy provenance preview';
  exception when insufficient_privilege then null; end;
  begin
    perform public.prog_check_legacy_scope(array['fe990000-0000-4000-8000-000000000001'::uuid],'fe990000-0000-4000-8000-000000000002'::uuid);
    raise exception 'Ordinary member accessed source-scope metadata';
  exception when insufficient_privilege then null; end;
  if exists(select 1 from public.legacy_provenance_bindings) then
    raise exception 'Ordinary member saw owner provenance evidence';
  end if;
end
$ordinary$;
reset role;
do $programmer_identity$
begin
  perform set_config('request.jwt.claim.sub','fe110000-0000-4000-8000-000000000003',true);
  perform set_config('request.jwt.claims','{"sub":"fe110000-0000-4000-8000-000000000003","role":"authenticated"}',true);
end
$programmer_identity$;
set local role authenticated;
do $programmer$
declare v_preview jsonb; v_result jsonb; v_ids uuid[]; v_id uuid; v_copied uuid[]; v_patient uuid;
  v_binding uuid; v_clinical_rows integer;
begin
  begin
    insert into public.patients(organization_id,nome,cpf,legacy_id) values
      ('fe220000-0000-4000-8000-000000000001','Synthetic denied existing CPF','22222222222','denied-existing-CPF');
    raise exception 'Programmer without membership inserted a clinical patient';
  exception when insufficient_privilege then null; end;
  begin
    insert into public.patients(organization_id,nome,cpf,legacy_id) values
      ('fe220000-0000-4000-8000-000000000001','Synthetic denied absent CPF','99999999999','denied-absent-CPF');
    raise exception 'Programmer without membership bypassed patient RLS';
  exception when insufficient_privilege then null; end;
  perform public.prog_inventory_legacy_documents();
  select id into v_id from public.legacy_document_registry where source_doc_id='legacy-finalized';
  begin
    perform public.prog_classify_legacy_documents(array[v_id],'fe220000-0000-4000-8000-000000000001','Synthetic explicit classification');
    raise exception 'Classification succeeded without owner statement binding';
  exception when object_not_in_prerequisite_state then null; end;
  v_preview := public.prog_legacy_provenance_preview('fe110000-0000-4000-8000-000000000001','fe220000-0000-4000-8000-000000000001','unstamped_only');
  if (v_preview->>'source_count')::integer<>8 or v_preview - array['source_count','source_manifest_hash','source_scope'] <> '{}'::jsonb then
    raise exception 'Owner scoped preview returned wrong cohort or extra data';
  end if;
  begin
    perform public.prog_bind_legacy_provenance('fe110000-0000-4000-8000-000000000001','fe220000-0000-4000-8000-000000000001',
      'unstamped_only','Synthetic owner confirms one historical clinic','synthetic-review-2026-10-11',999,v_preview->>'source_manifest_hash');
    raise exception 'Binding accepted a changed reviewed source count';
  exception when serialization_failure then null; end;
  v_result := public.prog_bind_legacy_provenance('fe110000-0000-4000-8000-000000000001','fe220000-0000-4000-8000-000000000001',
    'unstamped_only','Synthetic owner confirms one historical clinic','synthetic-review-2026-10-11',
    (v_preview->>'source_count')::integer,v_preview->>'source_manifest_hash');
  v_binding := (v_result->>'binding_id')::uuid;
  begin
    perform public.prog_bind_legacy_provenance('fe110000-0000-4000-8000-000000000001','fe220000-0000-4000-8000-000000000002',
      'unstamped_only','Synthetic contradictory clinic rejected','synthetic-conflicting-review-2026-10-11',
      (v_preview->>'source_count')::integer,v_preview->>'source_manifest_hash');
    raise exception 'Same owner cohort accepted contradictory clinic provenance';
  exception when check_violation then null; end;
  select id into v_id from public.legacy_document_registry where source_doc_id='legacy-other-owner';
  begin
    perform public.prog_classify_legacy_documents(array[v_id],'fe220000-0000-4000-8000-000000000001','Synthetic explicit classification');
    raise exception 'Owner statement was applied to another source account';
  exception when object_not_in_prerequisite_state then null; end;
  select id into v_id from public.legacy_document_registry where source_doc_id='legacy-other-clinic';
  begin
    perform public.prog_classify_legacy_documents(array[v_id],'fe220000-0000-4000-8000-000000000001','Synthetic explicit classification');
    raise exception 'Classification moved a stamped source to another clinic';
  exception when check_violation then null; end;
  select array_agg(id) into v_ids from public.legacy_document_registry where source_doc_id in ('legacy-new-patient','legacy-other-owner');
  begin
    perform public.prog_classify_legacy_documents(v_ids,'fe220000-0000-4000-8000-000000000001','Synthetic mixed owner batch rejected');
    raise exception 'Mixed batch accepted another unbound owner';
  exception when object_not_in_prerequisite_state then null; end;
  if exists(select 1 from public.legacy_document_registry where source_doc_id='legacy-new-patient' and organization_id is not null) then
    raise exception 'Failed mixed batch partially classified a source';
  end if;
  select array_agg(id) into v_ids from public.legacy_document_registry where source_doc_id in
    ('legacy-new-patient','legacy-finalized','legacy-existing','legacy-divergent','legacy-case-reuse');
  v_result := public.prog_classify_legacy_documents(v_ids,'fe220000-0000-4000-8000-000000000001','Synthetic owner confirmed historical source');
  if (v_result->>'classified')::integer<>5 then raise exception 'Owner scoped classification count differs'; end if;
  select id into v_id from public.legacy_document_registry where source_doc_id='legacy-finalized';
  begin
    perform public.prog_classify_legacy_documents(array[v_id],'fe220000-0000-4000-8000-000000000002','Synthetic cross clinic reassignment');
    raise exception 'Classified registry organization was changed';
  exception when check_violation then null; end;
  select array_agg(id) into v_ids from public.legacy_document_registry where source_doc_id in ('legacy-new-patient','legacy-finalized');
  v_result := public.prog_copy_legacy_documents(v_ids,168);
  if (v_result->>'copied')::integer<>2 or (v_result->>'failed')::integer<>0 or (v_result->>'blocked')::integer<>0 then
    raise exception 'New patient and historical finalized copy failed';
  end if;
  select id into v_id from public.legacy_document_registry where source_doc_id='legacy-divergent';
  v_result := public.prog_copy_legacy_documents(array[v_id],168);
  if (v_result->>'blocked')::integer<>1 or (v_result->>'copied')::integer<>0
    or not exists(select 1 from public.legacy_document_registry where id=v_id and status='target_conflict' and last_error_code='target_hash_conflict') then
    raise exception 'Divergent canonical target was not preserved as a conflict';
  end if;
  select id into v_id from public.legacy_document_registry where source_doc_id='legacy-existing';
  v_result := public.prog_copy_legacy_documents(array[v_id],168);
  if (v_result->>'failed')::integer<>1 or (v_result->>'copied')::integer<>0 then
    raise exception 'Patient was reused solely by normalized name';
  end if;
  begin
    perform public.prog_bind_legacy_patient(v_id,'fe330000-0000-4000-8000-000000000002','Synthetic explicit foreign mapping rejected');
    raise exception 'Patient mapping crossed organizations';
  exception when check_violation then null; end;
  begin
    perform public.prog_bind_legacy_patient(v_id,'fe330000-0000-4000-8000-000000000005','Synthetic unkeyed patient mapping rejected');
    raise exception 'Mapping accepted an unkeyed existing patient';
  exception when object_not_in_prerequisite_state then null; end;
  perform public.prog_bind_legacy_patient(v_id,'fe330000-0000-4000-8000-000000000001','Synthetic reviewed existing patient identity');
  v_result := public.prog_copy_legacy_documents(array[v_id],168);
  if (v_result->>'copied')::integer<>1 or (v_result->>'failed')::integer<>0 then
    raise exception 'Explicit patient mapping did not allow safe copy';
  end if;
  select id into v_id from public.legacy_document_registry where source_doc_id='legacy-case-reuse';
  perform public.prog_bind_legacy_patient(v_id,'fe330000-0000-4000-8000-000000000001','Synthetic reviewed existing patient identity');
  v_result := public.prog_copy_legacy_documents(array[v_id],168);
  if (v_result->>'failed')::integer<>1 or (v_result->>'copied')::integer<>0 then
    raise exception 'Surgical case was reused solely by date and procedure';
  end if;
  begin
    perform public.prog_bind_legacy_encounter(v_id,'fe440000-0000-4000-8000-000000000002','Synthetic unkeyed case mapping rejected');
    raise exception 'Mapping accepted an unkeyed existing surgical case';
  exception when object_not_in_prerequisite_state then null; end;
  perform public.prog_bind_legacy_encounter(v_id,'fe440000-0000-4000-8000-000000000001','Synthetic reviewed same surgical case');
  v_result := public.prog_copy_legacy_documents(array[v_id],168);
  if (v_result->>'copied')::integer<>1 or (v_result->>'failed')::integer<>0 then
    raise exception 'Explicit surgical case mapping did not allow safe copy';
  end if;
  v_preview := public.prog_legacy_provenance_preview('fe110000-0000-4000-8000-000000000001','fe220000-0000-4000-8000-000000000001','matching_stamp_only');
  if (v_preview->>'source_count')::integer<>2 then raise exception 'Stamped owner cohort differs'; end if;
  v_result := public.prog_bind_legacy_provenance('fe110000-0000-4000-8000-000000000001','fe220000-0000-4000-8000-000000000001',
    'matching_stamp_only','Synthetic original clinic stamps preserved','synthetic-stamp-review-2026-10-11',
    (v_preview->>'source_count')::integer,v_preview->>'source_manifest_hash');
  select id into v_id from public.legacy_document_registry where source_doc_id='legacy-agenda';
  -- A matching-stamp binding exists, but cannot substitute for a reviewed
  -- unstamped binding when the module is plain and _relOrg lives in payload.
  begin
    perform public.prog_check_legacy_scope(array[v_id],v_binding);
    raise exception 'Plain module _relOrg source passed an unstamped reviewed binding';
  exception when check_violation then null; end;
  v_result := public.prog_check_legacy_scope(array[v_id],(v_result->>'binding_id')::uuid);
  if (v_result->>'scope_confirmed')::boolean is distinct from true or (v_result->>'selected_count')::integer<>1 then
    raise exception 'Matching-stamp binding did not confirm plain-module source scope';
  end if;

  select array_agg(id) into v_ids from public.legacy_document_registry where source_doc_id in ('legacy-stamped','legacy-agenda');
  perform public.prog_classify_legacy_documents(v_ids,'fe220000-0000-4000-8000-000000000001','Synthetic original clinic stamps preserved');
  v_result := public.prog_copy_legacy_documents(v_ids,168);
  if (v_result->>'copied')::integer<>2 or (v_result->>'failed')::integer<>0 then
    raise exception 'Stamped modules or patientless agenda failed';
  end if;
  select array_agg(id) into v_copied from public.legacy_document_registry where status='copied';
  if cardinality(v_copied)<>6 then raise exception 'Legacy successful cohort differs'; end if;
  v_result := public.prog_validate_legacy_documents(v_copied);
  if (v_result->>'validated')::integer<>6 or (v_result->>'blocked')::integer<>0 then
    raise exception 'Provenance and relational linkage validation failed';
  end if;
  v_clinical_rows := (select count(*) from public.preanesthetic_assessments where organization_id='fe220000-0000-4000-8000-000000000001');
  v_result := public.prog_copy_legacy_documents(v_copied,168);
  if (v_result->>'copied')::integer<>6 or v_clinical_rows <>
    (select count(*) from public.preanesthetic_assessments where organization_id='fe220000-0000-4000-8000-000000000001') then
    raise exception 'Repeated copy duplicated or changed canonical targets';
  end if;
end
$programmer$;
reset role;
do $receipt_and_preservation$
declare v_target jsonb; v_original record; p public.legacy_import_provenance%rowtype; v_finalized uuid;
begin
  if exists((select * from public.documentos except select * from legacy_provenance_fixture.source_originals))
    or exists((select * from legacy_provenance_fixture.source_originals except select * from public.documentos)) then
    raise exception 'Legacy source bytes or metadata changed';
  end if;
  for v_original in select * from legacy_provenance_fixture.destination_originals loop
    execute format('select to_jsonb(t) from public.%I t where id=$1',v_original.table_name) into v_target using v_original.id;
    if v_target is distinct from v_original.original then raise exception 'Existing canonical target changed during legacy copy'; end if;
  end loop;
  select i.* into p from public.legacy_import_provenance i join public.legacy_document_registry r on r.id=i.registry_id
    where r.source_doc_id='legacy-finalized';
  if p.registry_id is null or p.historical_finalized_at_claim is distinct from '2000-01-01T12:00:00Z'::timestamptz
    or p.historical_claims_verified or not p.historical_timestamp_present or not p.historical_timestamp_valid
    or not p.source_claims_finalized or p.canonical_stamp_kind<>'import'
    or p.source_user_id<>'fe110000-0000-4000-8000-000000000001'
    or p.imported_by<>'fe110000-0000-4000-8000-000000000003'
    or p.canonical_created_by is distinct from p.imported_by or p.canonical_finalized_by is distinct from p.imported_by
    or p.canonical_finalized_at is null or p.canonical_finalized_at = p.historical_finalized_at_claim then
    raise exception 'Historical owner/claim was confused with import authorship or date';
  end if;
  v_finalized := p.target_id;
  begin
    update public.preanesthetic_assessments set data='{}'::jsonb where id=v_finalized;
    raise exception 'Imported finalized original could be rewritten';
  exception when check_violation then null; end;
  begin
    delete from public.preanesthetic_assessments where id=v_finalized;
    raise exception 'Imported finalized original could be deleted';
  exception when check_violation then null; end;
  begin
    update public.legacy_provenance_bindings set owner_statement='Synthetic changed evidence';
    raise exception 'Owner provenance evidence was mutable';
  exception when check_violation then null; end;
  begin
    delete from public.legacy_import_provenance;
    raise exception 'Import receipt could be deleted';
  exception when check_violation then null; end;
  begin
    update public.documentos set dados='{}'::jsonb;
    raise exception 'Frozen source could be rewritten by database owner';
  exception when check_violation then null; end;
  begin
    delete from public.documentos;
    raise exception 'Frozen source could be deleted by database owner';
  exception when check_violation then null; end;
  begin
    truncate public.documentos;
    raise exception 'Frozen source could be truncated by database owner';
  exception when check_violation then null; end;
  begin
    perform app.legacy_source_organization('pre@fe220000-0000-4000-8000-000000000001',
      '{"_relOrg":"fe220000-0000-4000-8000-000000000002"}');
    raise exception 'Disagreeing organization stamps were ignored';
  exception when check_violation then null; end;
  begin
    perform app.legacy_source_organization('pre@invalid-org','{}');
    raise exception 'Malformed organization suffix was ignored';
  exception when invalid_parameter_value then null; end;
  if (select count(*) from public.legacy_import_provenance)<>6 then
    raise exception 'Import receipt count differs or repeated copy duplicated receipts';
  end if;
  select r.target_id into v_finalized from public.legacy_document_registry r where source_doc_id='legacy-existing';
  update public.preanesthetic_assessments set data=data||'{"fixtureLegitimateEdit":true}'::jsonb where id=v_finalized;
end
$receipt_and_preservation$;
set local role authenticated;
do $mixed_validation$
declare v_ids uuid[]; v_result jsonb;
begin
  select array_agg(id) into v_ids from public.legacy_document_registry where source_doc_id in ('legacy-existing','legacy-finalized');
  v_result:=public.prog_validate_legacy_documents(v_ids);
  if (v_result->>'validated')::integer<>1 or (v_result->>'blocked')::integer<>1
    or not exists(select 1 from public.legacy_document_registry where source_doc_id='legacy-existing' and last_error_code='target_version_changed') then
    raise exception 'Edited draft aborted a mixed batch or was falsely validated';
  end if;
  v_result:=public.prog_copy_legacy_documents(v_ids,168);
  if (v_result->>'copied')::integer<>1 or (v_result->>'failed')::integer<>1 then
    raise exception 'Edited copied target aborted a mixed retry or overwrote a legitimate edit';
  end if;
end
$mixed_validation$;
reset role;
do $ordinary_identity_again$
begin
  perform set_config('request.jwt.claim.sub','fe110000-0000-4000-8000-000000000004',true);
  perform set_config('request.jwt.claims','{"sub":"fe110000-0000-4000-8000-000000000004","role":"authenticated"}',true);
end
$ordinary_identity_again$;
set local role authenticated;
do $normal_patient_guard$
begin
  update public.patients set cpf='777.777.777-77' where id='fe330000-0000-4000-8000-000000000003';
  insert into public.patients(id,organization_id,nome,cpf,legacy_id)
    values('fe330000-0000-4000-8000-000000000003','fe220000-0000-4000-8000-000000000001',
      'HistoricalDuplicateOne','77777777777','historical-duplicate-one')
    on conflict(id) do update set cpf=excluded.cpf;
  begin
    insert into public.patients(organization_id,nome,cpf,legacy_id) values
      ('fe220000-0000-4000-8000-000000000001','Synthetic new conflicting CPF','22222222222','normal-duplicate-CPF');
    raise exception 'Normal authorized writer assigned an existing CPF to another patient';
  exception when unique_violation then null; end;
  begin
    update public.patients set cpf='22222222222' where id='fe330000-0000-4000-8000-000000000003';
    raise exception 'Normal authorized writer reassigned CPF to a different patient';
  exception when unique_violation then null; end;
end
$normal_patient_guard$;
reset role;
select jsonb_build_object('legacyProvenanceFixture',jsonb_build_object(
  'passed',true,'syntheticSourceRows',12,'validatedSources',6,'divergentTargetPreserved',true,
  'sourceFrozenAndPreserved',true,'ownerAndStampIsolation',true,'explicitPatientAndCaseMapping',true,
  'historicalClaimsSeparatedFromImportAudit',true,'repeatedCopyIdempotent',true,'verificationRolledBack',true));
rollback;
-- END LEGACY PROVENANCE VERIFY
