-- =============================================================================
-- Soft Anestesia — Migração 0012: cadastros e configurações DA CLÍNICA
-- =============================================================================
-- Rode DEPOIS da 0001–0011. Idempotente.
--
-- PROBLEMA que esta migração resolve:
--   Registros clínicos já são da clínica (organization_id + RLS). Mas os
--   CADASTROS e as CONFIGURAÇÕES — anestesistas, cirurgiões, convênios,
--   hospitais, procedimentos, formas de pagamento, presets de medicação,
--   equipamentos, termo padrão, textos padrão, logomarca, tabela CBHPM
--   própria — viajavam pelo canal PESSOAL (documentos, por user_id). Ou seja:
--   cada usuário tinha a sua cópia. Cadastrar um cirurgião no computador do
--   médico não fazia ele aparecer para a secretária, e cada aparelho novo
--   começava vazio.
--
-- Solução: uma prateleira compartilhada por organização.
--   org_configs(organization_id, chave) → dados jsonb + updated_at
--   • lê: qualquer membro ativo da organização
--   • escreve: qualquer membro ativo (cadastro é do consultório, não de uma
--     pessoa); a auditoria fica em updated_by/updated_at
--   A junção no app é por CHAVE, pelo updated_at mais recente.
-- =============================================================================

begin;

create table if not exists public.org_configs (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  chave           text not null,
  dados           jsonb not null default '{}'::jsonb,
  updated_at      timestamptz not null default now(),
  updated_by      uuid,
  primary key (organization_id, chave)
);

comment on table public.org_configs is
  'Cadastros e configurações compartilhados da clínica (equipe, convênios, modelos, logomarca). Uma linha por chave.';

alter table public.org_configs enable row level security;

drop policy if exists oc_sel on public.org_configs;
create policy oc_sel on public.org_configs for select
  using (organization_id in (select app.org_ids()));

drop policy if exists oc_wr on public.org_configs;
create policy oc_wr on public.org_configs for all
  using (organization_id in (select app.org_ids()))
  with check (organization_id in (select app.org_ids()));

create index if not exists org_configs_org_idx on public.org_configs(organization_id);

do $$ begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant select, insert, update, delete on public.org_configs to authenticated';
  end if;
end $$;

commit;
