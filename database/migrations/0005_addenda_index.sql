-- =============================================================================
-- Soft Anestesia — Migração 0005: idempotência de adendos
-- =============================================================================
-- Rode DEPOIS da 0001–0004. Idempotente e aditiva.
--
-- Adendos (correções em registros finalizados) são APPEND-ONLY. Para o app
-- poder reenviar sem duplicar (offline/multi-aparelho), cada adendo carrega um
-- legacy_id (UUID gerado no app) com índice único. O envio usa
-- ON CONFLICT DO NOTHING (Prefer: resolution=ignore-duplicates), compatível
-- com a policy de INSERT-only da tabela.
-- =============================================================================

begin;

alter table public.addenda add column if not exists legacy_id text;
create unique index if not exists ux_addenda_org_legacy
  on public.addenda(organization_id, legacy_id);

commit;
