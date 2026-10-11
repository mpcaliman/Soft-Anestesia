-- LOCAL DISPOSABLE DATABASE ONLY. Requires the twelve-row synthetic SEED and
--0034. Extract one marked section per invocation; never run the whole file.
-- PREPARE persists only synthetic fixture metadata. SessionsA/B are two
-- distinct authenticated programmers importing disjoint sources with the same
-- CPF and different names. A keeps its transaction open at the marker; startB,
-- prove it waits on an advisory lock, then COMMITA and awaitB.
-- SessionsC/D similarly exercise normal authenticated clinic writers.
-- The isolated project is removed afterwards; no clinical DELETE is used.

-- BEGIN LEGACY PROVENANCE RACE PREPARE
begin;
do $setup$
declare v_preview jsonb; v_ids uuid[];
begin
  if current_database()<>'postgres' or current_setting('server_version_num')::integer/10000<>17
    or (select count(*) from legacy_provenance_fixture.source_originals)<>12
    or exists(select 1 from public.patients where organization_id='fe220000-0000-4000-8000-000000000001'
      and regexp_replace(coalesce(cpf,''),'[^0-9]','','g') in ('66666666666','55555555555')) then
    raise exception 'Legacy identity race requires fresh isolated synthetic fixtures';
  end if;
  perform set_config('request.jwt.claim.sub','fe110000-0000-4000-8000-000000000003',true);
  perform set_config('request.jwt.claims','{"sub":"fe110000-0000-4000-8000-000000000003","role":"authenticated"}',true);
end
$setup$;
set local role authenticated;
do $setup$
declare v_preview jsonb; v_ids uuid[];
begin
  perform public.prog_inventory_legacy_documents();
  v_preview:=public.prog_legacy_provenance_preview('fe110000-0000-4000-8000-000000000001',
    'fe220000-0000-4000-8000-000000000001','unstamped_only');
  perform public.prog_bind_legacy_provenance('fe110000-0000-4000-8000-000000000001',
    'fe220000-0000-4000-8000-000000000001','unstamped_only','Synthetic race owner evidence',
    'synthetic-concurrency-review',(v_preview->>'source_count')::integer,v_preview->>'source_manifest_hash');
  select array_agg(id) into v_ids from public.legacy_document_registry where source_doc_id in ('legacy-race-a','legacy-race-b');
  perform public.prog_classify_legacy_documents(v_ids,'fe220000-0000-4000-8000-000000000001','Synthetic race owner evidence');
end
$setup$;
commit;
-- END LEGACY PROVENANCE RACE PREPARE

-- BEGIN LEGACY PROVENANCE RACE SESSION A
begin isolation level read committed;
set local statement_timeout='30s';
set local application_name='soft-as-legacy-identity-a';
do $identity$
begin
  perform set_config('request.jwt.claim.sub','fe110000-0000-4000-8000-000000000003',true);
  perform set_config('request.jwt.claims','{"sub":"fe110000-0000-4000-8000-000000000003","role":"authenticated"}',true);
end
$identity$;
set local role authenticated;
do $first$
declare v_id uuid; v_result jsonb;
begin
  select id into v_id from public.legacy_document_registry where source_doc_id='legacy-race-a';
  v_result:=public.prog_copy_legacy_documents(array[v_id],168);
  if (v_result->>'copied')::integer<>1 or (v_result->>'failed')::integer<>0 then
    raise exception 'First legacy identity importer did not create one safe target';
  end if;
end
$first$;
select 'LEGACY_IDENTITY_A_UNCOMMITTED';
-- Keep stdin/transaction open. The verified runner later writes COMMIT.
-- END LEGACY PROVENANCE RACE SESSION A

-- BEGIN LEGACY PROVENANCE RACE SESSION B
begin isolation level read committed;
set local statement_timeout='30s';
set local application_name='soft-as-legacy-identity-b';
do $identity$
begin
  perform set_config('request.jwt.claim.sub','fe110000-0000-4000-8000-000000000005',true);
  perform set_config('request.jwt.claims','{"sub":"fe110000-0000-4000-8000-000000000005","role":"authenticated"}',true);
end
$identity$;
set local role authenticated;
do $second$
declare v_id uuid; v_result jsonb;
begin
  select id into v_id from public.legacy_document_registry where source_doc_id='legacy-race-b';
  v_result:=public.prog_copy_legacy_documents(array[v_id],168);
  if (v_result->>'copied')::integer<>0 or (v_result->>'failed')::integer<>1 then
    raise exception 'Second legacy importer duplicated a concurrently created identity';
  end if;
end
$second$;
commit;
select 'LEGACY_IDENTITY_B_BLOCKED';
-- END LEGACY PROVENANCE RACE SESSION B

-- BEGIN NORMAL PATIENT RACE SESSION C
begin isolation level read committed;
set local statement_timeout='30s';
set local application_name='soft-as-normal-identity-c';
do $identity$
begin
  perform set_config('request.jwt.claim.sub','fe110000-0000-4000-8000-000000000001',true);
  perform set_config('request.jwt.claims','{"sub":"fe110000-0000-4000-8000-000000000001","role":"authenticated"}',true);
end
$identity$;
set local role authenticated;
insert into public.patients(organization_id,nome,cpf,legacy_id)
 values('fe220000-0000-4000-8000-000000000001','NormalRaceSyntheticC','55555555555','normal-race-c');
select 'NORMAL_IDENTITY_C_UNCOMMITTED';
-- Keep stdin/transaction open. The verified runner later writes COMMIT.
-- END NORMAL PATIENT RACE SESSION C

-- BEGIN NORMAL PATIENT RACE SESSION D
begin isolation level read committed;
set local statement_timeout='30s';
set local application_name='soft-as-normal-identity-d';
do $identity$
begin
  perform set_config('request.jwt.claim.sub','fe110000-0000-4000-8000-000000000004',true);
  perform set_config('request.jwt.claims','{"sub":"fe110000-0000-4000-8000-000000000004","role":"authenticated"}',true);
end
$identity$;
set local role authenticated;
do $second$
declare v_rejected boolean:=false;
begin
  begin
    insert into public.patients(organization_id,nome,cpf,legacy_id)
      values('fe220000-0000-4000-8000-000000000001','NormalRaceSyntheticD','55555555555','normal-race-d');
  exception when unique_violation then v_rejected:=true; end;
  if not v_rejected then raise exception 'Second normal writer duplicated a concurrent patient identity'; end if;
end
$second$;
commit;
select 'NORMAL_IDENTITY_D_BLOCKED';
-- END NORMAL PATIENT RACE SESSION D

-- BEGIN OWNER PROVENANCE RACE SESSION E
begin isolation level read committed;
set local statement_timeout='30s';
set local application_name='soft-as-owner-provenance-e';
do $identity$
begin
  perform set_config('request.jwt.claim.sub','fe110000-0000-4000-8000-000000000003',true);
  perform set_config('request.jwt.claims','{"sub":"fe110000-0000-4000-8000-000000000003","role":"authenticated"}',true);
end
$identity$;
set local role authenticated;
do $first$
declare p jsonb;
begin
  p:=public.prog_legacy_provenance_preview('fe110000-0000-4000-8000-000000000002',
    'fe220000-0000-4000-8000-000000000001','unstamped_only');
  perform public.prog_bind_legacy_provenance('fe110000-0000-4000-8000-000000000002',
    'fe220000-0000-4000-8000-000000000001','unstamped_only','Synthetic first historical evidence',
    'synthetic-owner-e-review',(p->>'source_count')::integer,p->>'source_manifest_hash');
end
$first$;
select 'OWNER_PROVENANCE_E_UNCOMMITTED';
-- Keep stdin/transaction open. The verified runner later writes COMMIT.
-- END OWNER PROVENANCE RACE SESSION E

-- BEGIN OWNER PROVENANCE RACE SESSION F
begin isolation level read committed;
set local statement_timeout='30s';
set local application_name='soft-as-owner-provenance-f';
do $identity$
begin
  perform set_config('request.jwt.claim.sub','fe110000-0000-4000-8000-000000000005',true);
  perform set_config('request.jwt.claims','{"sub":"fe110000-0000-4000-8000-000000000005","role":"authenticated"}',true);
end
$identity$;
set local role authenticated;
do $second$
declare p jsonb; v_rejected boolean:=false;
begin
  p:=public.prog_legacy_provenance_preview('fe110000-0000-4000-8000-000000000002',
    'fe220000-0000-4000-8000-000000000002','unstamped_only');
  begin
    perform public.prog_bind_legacy_provenance('fe110000-0000-4000-8000-000000000002',
      'fe220000-0000-4000-8000-000000000002','unstamped_only','Synthetic contradictory historical evidence',
      'synthetic-owner-f-review',(p->>'source_count')::integer,p->>'source_manifest_hash');
  exception when check_violation then v_rejected:=true; end;
  if not v_rejected then raise exception 'Concurrent statements assigned one owner cohort to different clinics'; end if;
end
$second$;
commit;
select 'OWNER_PROVENANCE_F_BLOCKED';
-- END OWNER PROVENANCE RACE SESSION F

-- BEGIN LEGACY PROVENANCE REPEATABLE READ VERIFY
begin isolation level repeatable read;
do $identity$
begin
  perform set_config('request.jwt.claim.sub','fe110000-0000-4000-8000-000000000003',true);
  perform set_config('request.jwt.claims','{"sub":"fe110000-0000-4000-8000-000000000003","role":"authenticated"}',true);
end
$identity$;
set local role authenticated;
do $test$
declare p jsonb; v_ids uuid[];
begin
  p:=public.prog_legacy_provenance_preview('fe110000-0000-4000-8000-000000000001',
    'fe220000-0000-4000-8000-000000000001','unstamped_only');
  begin
    perform public.prog_bind_legacy_provenance('fe110000-0000-4000-8000-000000000001',
      'fe220000-0000-4000-8000-000000000001','unstamped_only','Synthetic stale snapshot rejected',
      'synthetic-repeatable-read-review',(p->>'source_count')::integer,p->>'source_manifest_hash');
    raise exception 'Owner binding accepted a stale transaction isolation';
  exception when feature_not_supported then null; end;
  select array_agg(id) into v_ids from public.legacy_document_registry where source_doc_id in ('legacy-race-a','legacy-race-b');
  begin
    perform public.prog_copy_legacy_documents(v_ids,168);
    raise exception 'Legacy identity copy accepted a stale transaction isolation';
  exception when feature_not_supported then null; end;
end
$test$;
reset role;
do $identity$
begin
  perform set_config('request.jwt.claim.sub','fe110000-0000-4000-8000-000000000004',true);
  perform set_config('request.jwt.claims','{"sub":"fe110000-0000-4000-8000-000000000004","role":"authenticated"}',true);
end
$identity$;
set local role authenticated;
do $test$
begin
  begin
    insert into public.patients(organization_id,nome,cpf,legacy_id)
      values('fe220000-0000-4000-8000-000000000001','Synthetic stale normal writer','88888888888','stale-normal-writer');
    raise exception 'Normal identity assignment accepted a stale transaction isolation';
  exception when feature_not_supported then null; end;
  -- An unchanged historical identity remains compatible even in this mode.
  update public.patients set cpf=cpf where id='fe330000-0000-4000-8000-000000000003';
end
$test$;
rollback;
select jsonb_build_object('legacyIdentityIsolation',jsonb_build_object('repeatableReadRejected',true,'unchangedHistoricalIdentityPreserved',true));
-- END LEGACY PROVENANCE REPEATABLE READ VERIFY

-- BEGIN LEGACY PROVENANCE RACE VERIFY
do $verify$
begin
  if (select count(*) from public.patients where organization_id='fe220000-0000-4000-8000-000000000001'
    and regexp_replace(coalesce(cpf,''),'[^0-9]','','g')='66666666666')<>1
    or (select count(*) from public.preanesthetic_assessments where organization_id='fe220000-0000-4000-8000-000000000001'
      and legacy_id in ('legacy-race-a','legacy-race-b'))<>1
    or not exists(select 1 from public.legacy_document_registry where source_doc_id='legacy-race-a' and status='copied')
    or not exists(select 1 from public.legacy_document_registry where source_doc_id='legacy-race-b'
      and status='classified' and target_id is null and last_error_code='copy_failed:55000')
    or (select count(*) from public.legacy_import_provenance)<>1 then
    raise exception 'Concurrent legacy import did not preserve one winner and one blocked source';
  end if;
  if (select count(*) from public.patients where organization_id='fe220000-0000-4000-8000-000000000001'
    and regexp_replace(coalesce(cpf,''),'[^0-9]','','g')='55555555555')<>1
    or not exists(select 1 from public.patients where legacy_id='normal-race-c')
    or exists(select 1 from public.patients where legacy_id='normal-race-d') then
    raise exception 'Concurrent normal patient creation did not commit exactly one identity';
  end if;
  if exists((select * from public.documentos except select * from legacy_provenance_fixture.source_originals))
    or exists((select * from legacy_provenance_fixture.source_originals except select * from public.documentos)) then
    raise exception 'Legacy race changed frozen source bytes';
  end if;
  if (select count(*) from public.legacy_provenance_bindings where source_user_id='fe110000-0000-4000-8000-000000000002'
    and source_scope='unstamped_only')<>1 or not exists(select 1 from public.legacy_provenance_bindings
    where source_user_id='fe110000-0000-4000-8000-000000000002' and source_scope='unstamped_only'
      and organization_id='fe220000-0000-4000-8000-000000000001') then
    raise exception 'Contradictory concurrent owner bindings did not preserve exactly one clinic';
  end if;
end
$verify$;
select jsonb_build_object('legacyIdentityRace',jsonb_build_object('passed',true,
  'twoAuthenticatedProgrammers',true,'legacyIdentityCommitted',1,'legacySourceBlocked',1,
  'twoAuthenticatedNormalWriters',true,'normalIdentityCommitted',1,'normalWriterRejected',1,
  'twoConcurrentOwnerStatements',true,'ownerCohortsAccepted',1,'contradictoryOwnerCohortsRejected',1,
  'originalSourcesPreserved',true));
-- END LEGACY PROVENANCE RACE VERIFY
