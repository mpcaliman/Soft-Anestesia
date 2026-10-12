-- READ ONLY: aggregate candidate counts. No legacy payload, identity values, or patient names returned.
-- Matching keys are candidates for programmer review, not authority to classify a clinical record.
set local search_path=pg_catalog;
with targets as (select 'pacientes'::text as module,legacy_id,organization_id,created_by from public.patients where legacy_id is not null
union all
select 'pre'::text as module,legacy_id,organization_id,created_by from public.preanesthetic_assessments where legacy_id is not null
union all
select 'termo'::text as module,legacy_id,organization_id,created_by from public.consents where legacy_id is not null
union all
select 'anestesia'::text as module,legacy_id,organization_id,created_by from public.anesthesia_records where legacy_id is not null
union all
select 'recuperacao'::text as module,legacy_id,organization_id,created_by from public.recovery_records where legacy_id is not null
union all
select 'financeiro'::text as module,legacy_id,organization_id,created_by from public.finance_entries where legacy_id is not null
union all
select 'orcamento'::text as module,legacy_id,organization_id,created_by from public.quotes where legacy_id is not null
union all
select 'consulta'::text as module,legacy_id,organization_id,created_by from public.consultations where legacy_id is not null
union all
select 'documentos'::text as module,legacy_id,organization_id,created_by from public.documents where legacy_id is not null
union all
select 'prescricao'::text as module,legacy_id,organization_id,created_by from public.prescriptions where legacy_id is not null
union all
select 'risco'::text as module,legacy_id,organization_id,created_by from public.risk_assessments where legacy_id is not null
union all
select 'agenda'::text as module,legacy_id,organization_id,created_by from public.appointments where legacy_id is not null),
 source as(select id,user_id,split_part(modulo,'@',1) as module,doc_id from public.documentos),
 matches as(select s.id,s.module,count(t.legacy_id) as matching_records,count(distinct t.organization_id) as candidate_organizations,count(t.legacy_id) filter(where t.created_by=s.user_id) as matching_creator_records from source s left join targets t on t.module=s.module and t.legacy_id=s.doc_id group by s.id,s.module),
 summary as(select module,count(*) as source_rows,count(*) filter(where matching_records=0) as no_relational_match,count(*) filter(where candidate_organizations=1) as one_candidate_organization,count(*) filter(where candidate_organizations>1) as multiple_candidate_organizations,count(*) filter(where matching_records>1) as multiple_records,count(*) filter(where candidate_organizations=1 and matching_creator_records>0) as unique_candidate_with_matching_creator,count(*) filter(where candidate_organizations=1 and matching_creator_records=0) as unique_candidate_without_matching_creator from matches group by module)
 select module,source_rows,no_relational_match,one_candidate_organization,multiple_candidate_organizations,multiple_records,unique_candidate_with_matching_creator,unique_candidate_without_matching_creator from summary order by module;
