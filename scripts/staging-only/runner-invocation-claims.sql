-- Infraestrutura exclusiva da homologação yqqrfgbvoexricjdxpis.
-- NÃO incluir nas migrações/apply_all de produção e NÃO executar em produção.
-- O operador verifica o project_id e a branch antes de aplicar este arquivo.
-- Guarda hashes/UUIDs e horários de execução, sem token ou dado clínico.
-- Claims permanecem como evidência: nem a Edge Function pode removê-los.
CREATE TABLE public.staging_audit_run_claims (
  capability_sha256 text PRIMARY KEY
    CHECK (capability_sha256 ~ '^[a-f0-9]{64}$'),
  run_id uuid NOT NULL UNIQUE,
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  claimed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (expires_at > issued_at AND expires_at <= issued_at + interval '15 minutes'),
  CHECK (claimed_at >= issued_at AND claimed_at < expires_at)
);
ALTER TABLE public.staging_audit_run_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.staging_audit_run_claims FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.staging_audit_run_claims FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT ON TABLE public.staging_audit_run_claims TO service_role;
COMMENT ON TABLE public.staging_audit_run_claims IS
  'Stage-only one-time capability claims; retain evidence; never grant anon/authenticated access';
