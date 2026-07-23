-- =============================================================================
-- Soft Anestesia — Migração 0004: índice único de anexos (idempotência)
-- =============================================================================
-- Rode DEPOIS da 0001–0003. Idempotente e aditiva.
--
-- Permite registrar os metadados dos anexos (que já vão para o Storage) na
-- tabela public.attachments de forma IDEMPOTENTE: um upsert por storage_path
-- não duplica se o mesmo anexo for registrado de novo ao salvar o registro.
-- =============================================================================

begin;

create unique index if not exists ux_attachments_org_path
  on public.attachments(organization_id, storage_path);

commit;
