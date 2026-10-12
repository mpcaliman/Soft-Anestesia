-- PROPOSED READONLY AGGREGATES. Not executed here. SELECT statements only.
-- Replace both NULL::uuid parameters with the EXACT verified source account
-- and approved clinic. Never assign all unstamped rows from a global count.
-- These queries read payload/stamp fields inside PostgreSQL, return counts only,
-- and do not return clinical content, names, doc_ids, person IDs or row hashes.
-- Run using an approved read-only connection; no auth claims are impersonated.
-- Missing parameters fail closed: scoped payload inspection returns no rows.

-- A) Global inventory and the precise owner/clinic scope.
with parameters as (
  select NULL::uuid as source_user_id, NULL::uuid as organization_id
), raw as (
  select d.user_id,d.modulo::text as module,coalesce(d.dados::jsonb,'{}'::jsonb) as payload,
    p.source_user_id,p.organization_id,
    nullif(btrim(coalesce(d.dados::jsonb->>'_relOrg','')),'') as data_stamp,
    position('@' in d.modulo::text)>0 as has_module_stamp
  from public.documentos d cross join parameters p
), parsed as (
  select *,
    case when module ~ '^[^@]+@[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
      then split_part(module,'@',2)::uuid end as module_org,
    case when data_stamp ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
      then data_stamp::uuid end as data_org,
    (has_module_stamp and module !~ '^[^@]+@[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$')
      or (data_stamp is not null and data_stamp !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$') as malformed_stamp
  from raw
), scoped as (
  select *,coalesce(module_org,data_org) as stamped_org,
    module_org is not null and data_org is not null and module_org<>data_org as disagreeing_stamps,
    not malformed_stamp and module_org is null and data_org is null as unstamped,
    split_part(module,'@',1) in ('pacientes','agenda','pre','consulta','anestesia','recuperacao',
      'risco','termo','prescricao','documentos','financeiro','orcamento') as supported_module
  from parsed
)
select jsonb_build_object(
  'parametersProvided',(select source_user_id is not null and organization_id is not null from parameters),
  'globalTotal',count(*),'globalDistinctOwners',count(distinct user_id),
  'globalUnstamped',count(*) filter(where unstamped),
  'globalValidStamped',count(*) filter(where not malformed_stamp and not disagreeing_stamps and stamped_org is not null),
  'globalMalformedStamps',count(*) filter(where malformed_stamp),
  'globalDisagreeingStamps',count(*) filter(where disagreeing_stamps),
  'ownerTotal',count(*) filter(where user_id=source_user_id and organization_id is not null),
  'ownerUnstamped',count(*) filter(where user_id=source_user_id and organization_id is not null and unstamped),
  'ownerUnstampedSupported',count(*) filter(where user_id=source_user_id and organization_id is not null and unstamped and supported_module),
  'ownerMatchingStamp',count(*) filter(where user_id=source_user_id and not malformed_stamp and not disagreeing_stamps and stamped_org=organization_id),
  'ownerOtherStampPreserved',count(*) filter(where user_id=source_user_id and organization_id is not null and not malformed_stamp and not disagreeing_stamps and stamped_org is not null and stamped_org<>organization_id),
  'otherOwnersUnstampedExcluded',count(*) filter(where source_user_id is not null and organization_id is not null and user_id<>source_user_id and unstamped),
  'ownerMalformedOrDisagreeingQuarantined',count(*) filter(where user_id=source_user_id and organization_id is not null and (malformed_stamp or disagreeing_stamps))
) as aggregate_report
from scoped;

-- B) JSONB equivalence and identity collision candidates, entirely in-database.
-- Membership/owner_account/current created_by are not historical authorship.
-- Same document ID alone does not establish same content, patient or case.
with parameters as (
  select NULL::uuid as source_user_id, NULL::uuid as organization_id
), source_rows as (
  select d.modulo::text as module,d.doc_id::text as source_doc_id,
    coalesce(d.dados::jsonb,'{}'::jsonb) as payload,p.organization_id,p.source_user_id
  from public.documentos d cross join parameters p
  where p.source_user_id is not null and p.organization_id is not null and d.user_id=p.source_user_id
), stamps as (
  select *,split_part(module,'@',1) as base_module,
    nullif(btrim(coalesce(payload->>'_relOrg','')),'') as data_stamp,
    case when module ~ '^[^@]+@[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
      then split_part(module,'@',2)::uuid end as module_org,
    (position('@' in module)>0 and module !~ '^[^@]+@[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$') as malformed_module
  from source_rows
), parsed as (
  select *,case when data_stamp ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
      then data_stamp::uuid end as data_org,
    data_stamp is not null and data_stamp !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' as malformed_data
  from stamps
), approved_scope as (
  select *,case base_module
    when 'pacientes' then 'patients' when 'agenda' then 'appointments'
    when 'pre' then 'preanesthetic_assessments' when 'consulta' then 'consultations'
    when 'anestesia' then 'anesthesia_records' when 'recuperacao' then 'recovery_records'
    when 'risco' then 'risk_assessments' when 'termo' then 'consents'
    when 'prescricao' then 'prescriptions' when 'documentos' then 'documents'
    when 'financeiro' then 'finance_entries' when 'orcamento' then 'quotes' end as target_table,
    public.med_normalizar(coalesce(nullif(btrim(payload->>'paciente_nome'),''),
      nullif(btrim(payload->>'nome'),''),nullif(btrim(payload#>>'{paciente,nome}'),''),
      case when jsonb_typeof(payload->'paciente')='string' then nullif(btrim(payload->>'paciente'),'') end,'')) as patient_name,
    regexp_replace(coalesce(payload->>'cpf',payload->>'paciente_cpf',payload#>>'{paciente,cpf}',''),'[^0-9]','','g') as patient_cpf,
    coalesce(nullif(payload->>'prontuario',''),nullif(payload#>>'{paciente,prontuario}','')) as patient_chart
  from parsed where not malformed_module and not malformed_data
    and not (module_org is not null and data_org is not null and module_org<>data_org)
    and (coalesce(module_org,data_org) is null or coalesce(module_org,data_org)=organization_id)
), keyed as (
  select *,case when length(patient_name)>=3 then 'nome:'||patient_name
      when length(patient_cpf)>=11 then 'cpf:'||patient_cpf end as patient_key
  from approved_scope
), canonical as (
  select 'patients'::text as target_table,t.organization_id,t.legacy_id,to_jsonb(t) as row_data
  from public.patients t cross join parameters p where p.organization_id is not null and t.organization_id=p.organization_id
  union all
  select 'appointments'::text as target_table,t.organization_id,t.legacy_id,to_jsonb(t) as row_data
  from public.appointments t cross join parameters p where p.organization_id is not null and t.organization_id=p.organization_id
  union all
  select 'preanesthetic_assessments'::text as target_table,t.organization_id,t.legacy_id,to_jsonb(t) as row_data
  from public.preanesthetic_assessments t cross join parameters p where p.organization_id is not null and t.organization_id=p.organization_id
  union all
  select 'consultations'::text as target_table,t.organization_id,t.legacy_id,to_jsonb(t) as row_data
  from public.consultations t cross join parameters p where p.organization_id is not null and t.organization_id=p.organization_id
  union all
  select 'anesthesia_records'::text as target_table,t.organization_id,t.legacy_id,to_jsonb(t) as row_data
  from public.anesthesia_records t cross join parameters p where p.organization_id is not null and t.organization_id=p.organization_id
  union all
  select 'recovery_records'::text as target_table,t.organization_id,t.legacy_id,to_jsonb(t) as row_data
  from public.recovery_records t cross join parameters p where p.organization_id is not null and t.organization_id=p.organization_id
  union all
  select 'risk_assessments'::text as target_table,t.organization_id,t.legacy_id,to_jsonb(t) as row_data
  from public.risk_assessments t cross join parameters p where p.organization_id is not null and t.organization_id=p.organization_id
  union all
  select 'consents'::text as target_table,t.organization_id,t.legacy_id,to_jsonb(t) as row_data
  from public.consents t cross join parameters p where p.organization_id is not null and t.organization_id=p.organization_id
  union all
  select 'prescriptions'::text as target_table,t.organization_id,t.legacy_id,to_jsonb(t) as row_data
  from public.prescriptions t cross join parameters p where p.organization_id is not null and t.organization_id=p.organization_id
  union all
  select 'documents'::text as target_table,t.organization_id,t.legacy_id,to_jsonb(t) as row_data
  from public.documents t cross join parameters p where p.organization_id is not null and t.organization_id=p.organization_id
  union all
  select 'finance_entries'::text as target_table,t.organization_id,t.legacy_id,to_jsonb(t) as row_data
  from public.finance_entries t cross join parameters p where p.organization_id is not null and t.organization_id=p.organization_id
  union all
  select 'quotes'::text as target_table,t.organization_id,t.legacy_id,to_jsonb(t) as row_data
  from public.quotes t cross join parameters p where p.organization_id is not null and t.organization_id=p.organization_id
), measured as (
  select s.*,coalesce(targets.target_count,0) as target_count,
    coalesce(targets.exact_count,0) as exact_count,coalesce(targets.divergent_count,0) as divergent_count,
    coalesce(targets.deleted_count,0) as deleted_count,
    coalesce(targets.creator_not_backup_owner_count,0) as creator_not_backup_owner_count,
    coalesce(targets.finalization_missing_count,0) as finalization_missing_count,
    coalesce(collisions.candidate_count,0) as patient_candidates,
    coalesce(collisions.unkeyed_count,0) as unkeyed_patients
  from keyed s
  left join lateral (
    select count(*) as target_count,
      count(*) filter(where coalesce(c.row_data->'data','{}'::jsonb)=s.payload) as exact_count,
      count(*) filter(where coalesce(c.row_data->'data','{}'::jsonb)<>s.payload) as divergent_count,
      count(*) filter(where nullif(c.row_data->>'deleted_at','') is not null) as deleted_count,
      count(*) filter(where c.row_data->>'created_by' is distinct from s.source_user_id::text) as creator_not_backup_owner_count,
      count(*) filter(where lower(coalesce(s.payload->>'_finalizado','false')) in ('true','1','yes','sim')
        and (nullif(c.row_data->>'finalized_at','') is null or nullif(c.row_data->>'finalized_by','') is null)) as finalization_missing_count
    from canonical c where c.target_table=s.target_table and c.organization_id=s.organization_id
      and c.legacy_id=case when s.target_table='patients' then s.patient_key else s.source_doc_id end
  ) targets on true
  left join lateral (
    select count(*) as candidate_count,
      count(*) filter(where nullif(btrim(p.legacy_id),'') is null) as unkeyed_count
    from public.patients p where p.organization_id=s.organization_id
      and (p.legacy_id=s.patient_key
        or (length(s.patient_name)>=3 and public.med_normalizar(p.nome)=s.patient_name)
        or (length(s.patient_cpf)>=11 and regexp_replace(coalesce(p.cpf,''),'[^0-9]','','g')=s.patient_cpf)
        or (s.patient_chart is not null and p.prontuario=s.patient_chart))
  ) collisions on true
)
select jsonb_build_object(
  'parametersProvided',(select source_user_id is not null and organization_id is not null from parameters),
  'ownerApprovedScopeRows',count(*),
  'supportedRows',count(*) filter(where target_table is not null),
  'unsupportedRowsRetained',count(*) filter(where target_table is null),
  'sameKeyMissingTarget',count(*) filter(where target_table is not null and target_count=0),
  'sameKeyExactPayload',count(*) filter(where target_count=1 and exact_count=1 and deleted_count=0),
  'sameKeyDivergentPayload',count(*) filter(where divergent_count>0),
  'sameKeyMultipleDestinations',count(*) filter(where target_count>1),
  'sameKeyDeletedDestination',count(*) filter(where deleted_count>0),
  'sameKeyCreatorDiffersFromBackupOwner',count(*) filter(where creator_not_backup_owner_count>0),
  'sameKeySourceClaimsFinalizedButCanonicalStampMissing',count(*) filter(where finalization_missing_count>0),
  'sourcesWithExistingPatientCandidates',count(*) filter(where patient_candidates>0),
  'sourcesWithMultiplePatientCandidates',count(*) filter(where patient_candidates>1),
  'sourcesWithUnkeyedPatientCandidate',count(*) filter(where unkeyed_patients>0),
  'sourcesWithNoPatientKey',count(*) filter(where patient_key is null),
  'historicalAuthorshipVerified',false
) as aggregate_report from measured;
