-- =============================================================================
-- Soft Anestesia — Migração 0011: permissões personalizadas por usuário
-- =============================================================================
-- Rode DEPOIS da 0001–0010. Idempotente.
--
-- PROBLEMA que esta migração resolve:
--   O papel (gestor/auxiliar/…) define um conjunto PADRÃO de módulos. Quando o
--   gestor ajustava esse conjunto para uma pessoa (ex.: tirar o Dashboard da
--   secretária), a mudança ficava guardada só no aparelho do gestor — no
--   aparelho dela o app recalculava tudo pelo papel e devolvia o acesso.
--
-- Solução: a personalização passa a morar no vínculo com a clínica, em
--   organization_users.permissoes (jsonb):
--     { "perfil": "secretaria",
--       "modulos": ["pacientes","agenda","financeiro"],
--       "soImpressao": ["pre"] }
--   • quem escreve: apenas o gestor da organização (policy ou_all, já existente)
--   • quem lê: o próprio usuário e o gestor (policy ou_sel, já existente)
--   Nulo = usa o padrão do papel (comportamento antigo).
-- =============================================================================

begin;

alter table public.organization_users
  add column if not exists permissoes jsonb;

comment on column public.organization_users.permissoes is
  'Permissões personalizadas pelo gestor: {perfil, modulos[], soImpressao[]}. Nulo = padrão do papel.';

commit;
