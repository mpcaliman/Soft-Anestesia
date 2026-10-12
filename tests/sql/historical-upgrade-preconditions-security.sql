-- LOCAL DISPOSABLE DATABASE ONLY. Not a production migration.
-- The verified replay executor extracts exactly one section per invocation:
-- SEED after empty-baseline/prerequisite comparison and before original0018;
-- VERIFY after all upgrades/signature hardening and before later SQL fixtures.
-- Separate transactions preserve original0026 CONCURRENTLY/autocommit.
-- Persisted rows are synthetic evidence; only the isolated project is removed.

-- BEGIN HISTORICAL SEED
begin;
set local statement_timeout = '30s';
do $guard$
begin
  if exists(select 1 from auth.users)
     or exists(select 1 from public.organizations)
     or exists(select 1 from storage.objects)
     or to_regnamespace('historical_upgrade_fixture') is not null
     or exists(select 1 from pg_attribute where attrelid='public.addenda'::regclass
        and attname='reason' and not attisdropped)
     or exists(select 1 from pg_trigger where tgrelid='public.preanesthetic_assessments'::regclass
        and tgname='trg_finalization_stamp' and not tgisinternal) then
    raise exception 'Historical fixture requires empty captured pre0018 baseline';
  end if;
end $guard$;
create schema historical_upgrade_fixture;
revoke all on schema historical_upgrade_fixture from public,anon,authenticated,service_role;
create table historical_upgrade_fixture.originals (
  table_name text not null, id uuid primary key, original jsonb not null,
  expected_finalized_at timestamptz not null, expected_finalized_by uuid,
  timestamp_case text not null
);
create table historical_upgrade_fixture.adenda(id uuid primary key, original jsonb not null);
create table historical_upgrade_fixture.signatures(id uuid primary key, original jsonb not null);
create table historical_upgrade_fixture.audit_before(id uuid primary key, original jsonb not null);
revoke all on all tables in schema historical_upgrade_fixture from public,anon,authenticated,service_role;
insert into auth.users(id,email) values
 ('fd110000-0000-4000-8000-000000000001','historical-creator@example.invalid'),
 ('fd110000-0000-4000-8000-000000000002','historical-updater@example.invalid'),
 ('fd110000-0000-4000-8000-000000000003','historical-signer@example.invalid');
insert into public.organizations(id,nome)
 values('fd220000-0000-4000-8000-000000000001','Synthetic historical upgrade');
insert into public.profiles(id,nome,email,ativo)
 select id,'Synthetic historical actor',email,true from auth.users;
insert into public.organization_users(organization_id,user_id,role,ativo)
 select 'fd220000-0000-4000-8000-000000000001',id,'gestor',true from auth.users;
select set_config('request.jwt.claim.sub','fd110000-0000-4000-8000-000000000002',true);
select set_config('request.jwt.claims','{"sub":"fd110000-0000-4000-8000-000000000002","role":"authenticated"}',true);
insert into public.patients(id,organization_id,nome,legacy_id,created_by)
 values('fd330000-0000-4000-8000-000000000001','fd220000-0000-4000-8000-000000000001',
 'Synthetic historical patient','historical-patient','fd110000-0000-4000-8000-000000000001');
insert into public.encounters(id,organization_id,patient_id,legacy_id,created_by)
 values('fd440000-0000-4000-8000-000000000001','fd220000-0000-4000-8000-000000000001',
 'fd330000-0000-4000-8000-000000000001','historical-encounter','fd110000-0000-4000-8000-000000000001');
do $seed$
declare r record; i integer; v_id uuid; v_data jsonb; v_row jsonb;
  v_historical timestamptz; v_updated timestamptz; v_finalized_by uuid; v_case text;
begin
  for r in select * from (values
    ('preanesthetic_assessments',92),('anesthesia_records',167),
    ('recovery_records',143),('consents',53)
  ) counts(table_name,row_count) loop
    for i in 1..r.row_count loop
      v_id:=gen_random_uuid();
      v_historical:='2000-01-01 12:00:00+00'::timestamptz + i*interval '1 second';
      v_updated:='2002-01-01 12:00:00+00'::timestamptz + i*interval '1 second';
      v_case:=case i%3 when 0 then 'valid_timestamp' when 1 then 'invalid_timestamp' else 'absent_timestamp' end;
      v_data:=jsonb_build_object('_finalizado',true,'memo','Synthetic historical '||r.table_name||' '||i);
      if i%3=0 then v_data:=v_data||jsonb_build_object('_finalizadoEm',v_historical);
      elsif i%3=1 then v_data:=v_data||'{"_finalizadoEm":"synthetic-invalid-timestamp"}'::jsonb; end if;
      -- Exercise priority existing finalized_by > updated_by > created_by.
      v_finalized_by:=case when i%4=0 then 'fd110000-0000-4000-8000-000000000003'::uuid else null end;
      perform set_config('request.jwt.claim.sub',case when i%4=1 then '' else 'fd110000-0000-4000-8000-000000000002' end,true);
      perform set_config('request.jwt.claims',case when i%4=1 then '{}' else '{"sub":"fd110000-0000-4000-8000-000000000002","role":"authenticated"}' end,true);
      execute format('insert into public.%I(id,organization_id,patient_id,encounter_id,legacy_id,status,data,version,created_by,finalized_by,created_at,updated_at) '
        'values($1,$2,$3,$4,$5,''draft'',$6,7,$7,$8,$9,$10) returning to_jsonb(%I.*)',r.table_name,r.table_name)
        into v_row using v_id,'fd220000-0000-4000-8000-000000000001'::uuid,
        'fd330000-0000-4000-8000-000000000001'::uuid,'fd440000-0000-4000-8000-000000000001'::uuid,
        'historical-'||r.table_name||'-'||i,v_data,'fd110000-0000-4000-8000-000000000001'::uuid,
        v_finalized_by,'2001-01-01 12:00:00+00'::timestamptz,v_updated;
      insert into historical_upgrade_fixture.originals values(r.table_name,v_id,v_row,
        case when i%3=0 then v_historical else v_updated end,
        coalesce((v_row->>'finalized_by')::uuid,(v_row->>'updated_by')::uuid,(v_row->>'created_by')::uuid),v_case);
    end loop;
  end loop;
  perform set_config('request.jwt.claim.sub','',true);
  perform set_config('request.jwt.claims','{}',true);
  insert into public.addenda(id,organization_id,parent_table,parent_id,patient_id,encounter_id,
      legacy_id,texto,data,created_by,created_at)
    select 'fd550000-0000-4000-8000-000000000001','fd220000-0000-4000-8000-000000000001',
      table_name,id,'fd330000-0000-4000-8000-000000000001','fd440000-0000-4000-8000-000000000001',
      ' historical-adendum ','Synthetic historical plain adendum','{"memo":"Synthetic historical evidence"}',
      'fd110000-0000-4000-8000-000000000001','2003-01-01 12:00:00+00'
    from historical_upgrade_fixture.originals where table_name='preanesthetic_assessments'
      and original->>'legacy_id'='historical-preanesthetic_assessments-1';
  insert into public.addenda(id,organization_id,parent_table,parent_id,patient_id,encounter_id,
      legacy_id,texto,data,created_by,created_at)
    select 'fd550000-0000-4000-8000-000000000002','fd220000-0000-4000-8000-000000000001',
      table_name,id,'fd330000-0000-4000-8000-000000000001','fd440000-0000-4000-8000-000000000001',
      null,'Synthetic old retification envelope',
      '{"retificacao":{"schema":1,"baseAdendoId":"","campos":{"memo":"Synthetic historical correction"},"status":"accepted","revisao":99}}',
      'fd110000-0000-4000-8000-000000000001','2003-01-01 12:00:01+00'
    from historical_upgrade_fixture.originals where table_name='preanesthetic_assessments'
      and original->>'legacy_id'='historical-preanesthetic_assessments-1';
  insert into historical_upgrade_fixture.adenda select id,to_jsonb(a) from public.addenda a;
  insert into public.assinaturas(id,codigo,modulo,doc_id,titulo,hash_doc,provedor,self_hash,assinado_em,criado_em)
    values('fd660000-0000-4000-8000-000000000001','AAAA-BBBB-CCCC','pre','historical-signature',
      'Synthetic historical signature',repeat('a',64),'Synthetic test provider',repeat('b',64),
      '2004-01-01 12:00:00+00','2004-01-01 12:00:01+00');
  insert into historical_upgrade_fixture.signatures select id,to_jsonb(s) from public.assinaturas s;
  insert into historical_upgrade_fixture.audit_before select id,to_jsonb(a) from public.audit_logs a;
  if (select count(*) from historical_upgrade_fixture.originals)<>455
     or (select count(*) from historical_upgrade_fixture.adenda)<>2
     or (select count(*) from historical_upgrade_fixture.signatures)<>1 then
    raise exception 'Historical seed cardinality mismatch';
  end if;
end $seed$;
commit;
-- END HISTORICAL SEED

-- BEGIN HISTORICAL VERIFY
begin;
set local statement_timeout = '30s';
do $verify$
declare r record; v_row jsonb; denied boolean;
begin
  if (select count(*) from historical_upgrade_fixture.originals)<>455 then
    raise exception 'Historical upgrade evidence missing';
  end if;
  for r in select * from historical_upgrade_fixture.originals loop
    execute format('select to_jsonb(p) from public.%I p where id=$1',r.table_name) into v_row using r.id;
    if v_row is null
       or (v_row - array['status','version','finalized_at','finalized_by','updated_at',
                        'last_operation_id','last_operation_checksum']) is distinct from
          (r.original - array['status','version','finalized_at','finalized_by','updated_at'])
       or v_row->>'status' is distinct from 'finalized'
       or (v_row->>'finalized_at')::timestamptz is distinct from r.expected_finalized_at
       or (v_row->>'finalized_by')::uuid is distinct from r.expected_finalized_by
       or (v_row->>'version')::integer is distinct from (r.original->>'version')::integer+1
       or (v_row->>'updated_at')::timestamptz <= (r.original->>'updated_at')::timestamptz
       or v_row->>'last_operation_id' is not null or v_row->>'last_operation_checksum' is not null then
      raise exception 'Historical original payload, provenance, timestamp or permitted metadata diverged';
    end if;
    if not exists(select 1 from public.audit_logs a where a.record_id=r.id and a.module=r.table_name
       and a.action='finalize' and a.user_id is null
       and a.new_value->'data'=r.original->'data'
       and (a.new_value->>'finalized_at')::timestamptz=r.expected_finalized_at) then
      raise exception 'Historical backfill finalization lacked administrative audit';
    end if;
  end loop;
  if (select count(*) from public.audit_logs a join historical_upgrade_fixture.originals p
      on a.record_id=p.id and a.module=p.table_name where a.action='finalize') <>455 then
    raise exception 'Historical backfill finalization audit cardinality mismatch';
  end if;
  if exists(select 1 from historical_upgrade_fixture.audit_before b left join public.audit_logs a on a.id=b.id
    where to_jsonb(a) is distinct from b.original) then
    raise exception 'Historical upgrade removed or changed earlier audit';
  end if;
  for r in select * from historical_upgrade_fixture.adenda loop
    select to_jsonb(a) into v_row from public.addenda a where a.id=r.id;
    if v_row is null
       or (v_row - array['legacy_id','reason','author_id','parent_legacy_id','retification_revision'])
          is distinct from (r.original - 'legacy_id')
       or v_row->>'legacy_id' is distinct from coalesce(nullif(btrim(r.original->>'legacy_id'),''),r.id::text)
       or v_row->>'reason' is distinct from 'historical_addendum'
       or v_row->>'author_id' is distinct from r.original->>'created_by'
       or v_row->>'parent_legacy_id' is distinct from (
          select p.original->>'legacy_id' from historical_upgrade_fixture.originals p
           where p.id=(r.original->>'parent_id')::uuid)
       or v_row->>'retification_revision' is not null then
      raise exception 'Historical adendum payload or permitted backfill diverged';
    end if;
    begin
      update public.addenda set texto='Synthetic forbidden replacement' where id=r.id;
      raise exception 'Historical adendum UPDATE allowed';
    exception when check_violation then null; end;
    begin
      delete from public.addenda where id=r.id;
      raise exception 'Historical adendum DELETE allowed';
    exception when check_violation then null; end;
  end loop;
  for r in select * from historical_upgrade_fixture.signatures loop
    select to_jsonb(s) into v_row from public.assinaturas s where s.id=r.id;
    if v_row is null or (v_row-array['organization_id','signed_by']) is distinct from r.original
       or v_row->>'organization_id' is not null or v_row->>'signed_by' is not null then
      raise exception 'Historical immutable signature changed or was assigned presumed provenance';
    end if;
    denied:=false;
    begin
      update public.assinaturas set titulo='Synthetic forbidden replacement' where id=r.id;
    exception when raise_exception then
      if sqlerrm is distinct from 'Registro de assinatura é imutável (append-only).' then raise; end if;
      denied:=true;
    end;
    if not denied then raise exception 'Historical signature UPDATE allowed'; end if;
    denied:=false;
    begin
      delete from public.assinaturas where id=r.id;
    exception when raise_exception then
      if sqlerrm is distinct from 'Registro de assinatura é imutável (append-only).' then raise; end if;
      denied:=true;
    end;
    if not denied then raise exception 'Historical signature DELETE allowed'; end if;
  end loop;
  -- Representative originals remain protected in administrative and replica
  -- execution; the full455 payload/provenance comparison is performed above.
  for r in select distinct on(table_name) table_name,id from historical_upgrade_fixture.originals order by table_name,id loop
    begin
      execute format('update public.%I set deleted_at=clock_timestamp() where id=$1',r.table_name) using r.id;
      raise exception 'Historical finalized soft-delete allowed';
    exception when check_violation then null; end;
    begin
      execute format('delete from public.%I where id=$1',r.table_name) using r.id;
      raise exception 'Historical finalized DELETE allowed';
    exception when check_violation then null; end;
  end loop;
end $verify$;
set local session_replication_role='replica';
do $replica$
declare r record;
begin
  for r in select distinct on(table_name) table_name,id from historical_upgrade_fixture.originals order by table_name,id loop
    begin
      execute format('update public.%I set deleted_at=clock_timestamp() where id=$1',r.table_name) using r.id;
      raise exception 'Replica historical finalized soft-delete allowed';
    exception when check_violation then null; end;
    begin
      execute format('delete from public.%I where id=$1',r.table_name) using r.id;
      raise exception 'Replica historical finalized DELETE allowed';
    exception when check_violation then null; end;
  end loop;
end $replica$;
set local session_replication_role='origin';
-- A migrated historical parent remains correctable through authenticated
-- append-only insertion. Old JSON claiming revision99 does not become CAS head.
-- This savepoint removes only the new test proposals, never the retained seed.
savepoint historical_adendum_write;
create temporary table historical_parent_after_upgrade as
 select p.id,to_jsonb(p) original from public.preanesthetic_assessments p
 where p.legacy_id='historical-preanesthetic_assessments-1';
grant select on table historical_parent_after_upgrade to authenticated;
do $identity$
begin
  perform set_config('request.jwt.claim.sub','fd110000-0000-4000-8000-000000000001',true);
  perform set_config('request.jwt.claims','{"sub":"fd110000-0000-4000-8000-000000000001","role":"authenticated"}',true);
end $identity$;
set local role authenticated;
do $append$
declare parent_snapshot record; correction public.addenda%rowtype; persisted jsonb;
begin
  select * into parent_snapshot from historical_parent_after_upgrade;
  if parent_snapshot.id is null then raise exception 'Migrated historical parent unavailable'; end if;
  insert into public.addenda(organization_id,parent_table,parent_id,legacy_id,texto,reason,data)
    values('fd220000-0000-4000-8000-000000000001','preanesthetic_assessments',parent_snapshot.id,
      'historical-new-retification','Synthetic reviewed historical correction','correcao',
      '{"retificacao":{"schema":1,"baseAdendoId":"","campos":{"memo":"Synthetic corrected current projection"}}}')
    returning * into correction;
  if correction.retification_revision is distinct from 1
     or correction.data#>>'{retificacao,status}' is distinct from 'accepted'
     or correction.author_id is distinct from auth.uid()
     or correction.parent_legacy_id is distinct from 'historical-preanesthetic_assessments-1' then
    raise exception 'Historical parent correction unavailable or old JSON became CAS head';
  end if;
  select to_jsonb(p) into persisted from public.preanesthetic_assessments p where p.id=parent_snapshot.id;
  if persisted is distinct from parent_snapshot.original then
    raise exception 'Correction mutated migrated historical original';
  end if;
end $append$;
reset role;
rollback to savepoint historical_adendum_write;
release savepoint historical_adendum_write;
select jsonb_build_object(
  'verified',true,
  'historicalOriginals', (select count(*) from historical_upgrade_fixture.originals),
  'historicalAdenda', (select count(*) from historical_upgrade_fixture.adenda),
  'historicalSignatures', (select count(*) from historical_upgrade_fixture.signatures),
  'authRows', (select count(*) from auth.users),
  'patientRows', (select count(*) from public.patients),
  'encounterRows', (select count(*) from public.encounters),
  'addendaRows', (select count(*) from public.addenda),
  'signatureRows', (select count(*) from public.assinaturas),
  'clinicalRows', (select count(*) from public.patients)+(select count(*) from public.encounters)
    +(select count(*) from historical_upgrade_fixture.originals)+(select count(*) from public.addenda),
  'backfillFinalizationAuditRows', (select count(*) from public.audit_logs a join historical_upgrade_fixture.originals p
    on a.record_id=p.id and a.module=p.table_name where a.action='finalize'),
  'priorAuditRowsRetained', (select count(*) from historical_upgrade_fixture.audit_before),
  'sourceDistribution', (select jsonb_object_agg(table_name,n) from (
    select table_name,count(*) n from historical_upgrade_fixture.originals group by table_name) q),
  'timestampCases', (select jsonb_object_agg(timestamp_case,n) from (
    select timestamp_case,count(*) n from historical_upgrade_fixture.originals group by timestamp_case) q),
  'payloadAndLinksPreserved',true,'historicalTimestampAndAuthorPreserved',true,
  'historicalAdendaNotCasHeads',true,'historicalSignaturesUnassignedAndImmutable',true,
  'migratedHistoricalParentCorrectable',true,
  'administrativeFinalizedDeletionDenied',true,'replicaFinalizedDeletionDenied',true,'productionMutated',false
);
rollback;
-- END HISTORICAL VERIFY
