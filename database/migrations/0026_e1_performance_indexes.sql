-- =============================================================================
-- Soft Anestesia — 0026: índices E1 para FKs, RLS e joins observados no app
-- =============================================================================
-- Local/G1 somente. Não aplicar em Supabase remoto sem homologação e G3.
--
-- CONCURRENTLY evita bloquear escrita por toda a construção. Por isso este
-- arquivo propositalmente NÃO abre transação. Cada índice deve ser medido em
-- homologação (duração, tamanho, plano e locks) antes da produção.
-- Nenhum índice antigo é removido: a lista de "unused" exige observação real.
-- Os índices ux_<tabela>_legacy já começam por organization_id e atendem o
-- filtro RLS dessas tabelas; não são duplicados aqui com índices org-only.
-- =============================================================================

set lock_timeout = '5s';
set statement_timeout = '15min';

create index concurrently if not exists e1_organization_users_active_user_idx
  on public.organization_users(user_id, organization_id, role)
  include (permissoes) where ativo;
create index concurrently if not exists e1_org_shares_destination_idx
  on public.org_shares(org_destino, org_origem);

create index concurrently if not exists e1_hospitals_org_idx
  on public.hospitals(organization_id);
create index concurrently if not exists e1_rooms_org_idx
  on public.rooms(organization_id);
create index concurrently if not exists e1_rooms_hospital_idx
  on public.rooms(hospital_id);
create index concurrently if not exists e1_equipment_org_idx
  on public.equipment(organization_id);
create index concurrently if not exists e1_equipment_hospital_idx
  on public.equipment(hospital_id);
create index concurrently if not exists e1_profiles_hospital_idx
  on public.profiles(hospital_id);

create index concurrently if not exists e1_encounters_hospital_idx
  on public.encounters(hospital_id);
create index concurrently if not exists e1_encounters_room_idx
  on public.encounters(room_id);
create index concurrently if not exists e1_anesthesia_pre_idx
  on public.anesthesia_records(preanesthetic_assessment_id);

create index concurrently if not exists e1_recovery_patient_idx
  on public.recovery_records(patient_id);
create index concurrently if not exists e1_recovery_anesthesia_idx
  on public.recovery_records(anesthesia_record_id);
create index concurrently if not exists e1_risk_patient_idx
  on public.risk_assessments(patient_id);
create index concurrently if not exists e1_consents_patient_idx
  on public.consents(patient_id);
create index concurrently if not exists e1_prescriptions_encounter_idx
  on public.prescriptions(encounter_id);
create index concurrently if not exists e1_documents_encounter_idx
  on public.documents(encounter_id);
create index concurrently if not exists e1_finance_patient_idx
  on public.finance_entries(patient_id);

create index concurrently if not exists e1_timeline_encounter_idx
  on public.anesthesia_timeline_events(encounter_id);
create index concurrently if not exists e1_addenda_encounter_idx
  on public.addenda(encounter_id);
create index concurrently if not exists e1_addenda_patient_idx
  on public.addenda(patient_id);
create index concurrently if not exists e1_attachments_encounter_idx
  on public.attachments(encounter_id);
create index concurrently if not exists e1_standard_texts_org_idx
  on public.standard_texts(organization_id);
create index concurrently if not exists e1_standard_texts_owner_idx
  on public.standard_texts(owner_id);

create index concurrently if not exists e1_consultations_encounter_idx
  on public.consultations(encounter_id);
create index concurrently if not exists e1_quotes_encounter_idx
  on public.quotes(encounter_id);
create index concurrently if not exists e1_appointments_encounter_idx
  on public.appointments(encounter_id);

reset statement_timeout;
reset lock_timeout;
