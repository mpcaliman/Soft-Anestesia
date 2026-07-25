-- =============================================================================
-- Soft Anestesia — Migração 0008: visibilidade dos registros entre anestesistas
-- =============================================================================
-- Rode DEPOIS da 0001–0007. Idempotente.
--
-- O gestor escolhe no app (Ajustes → Equipe da nuvem) entre dois modos:
--   • 'equipe'   (padrão) — comportamento atual: anestesiologistas veem os
--                 registros da organização inteira.
--   • 'proprios' — cada anestesiologista vê SÓ os registros que ele criou.
--
-- Vale para: pré-anestésica, ficha de anestesia, SRPA, escore de risco e
-- financeiro. Regras que NÃO mudam em nenhum modo:
--   • gestor continua vendo tudo;
--   • cirurgião continua vendo só os atendimentos dele (surgeon_id);
--   • a secretária (auxiliar) mantém o acesso dela (policies da 0007), e o
--     que ELA cria (ex.: pré iniciada na secretaria) fica visível a todos os
--     anestesiologistas — senão o médico do caso não conseguiria continuar;
--   • termo, receituário e documentos seguem com a leitura da 0001/0007.
--
-- A escolha fica em organizations.settings (jsonb), que o gestor já pode
-- editar pela policy org_upd da 0001. A ESCRITA clínica não muda
-- (can_write_clinical); apenas a LEITURA é condicionada.
-- =============================================================================

begin;

-- 1) coluna de configurações da organização
alter table public.organizations
  add column if not exists settings jsonb not null default '{}'::jsonb;

-- 2) helpers ------------------------------------------------------------------

-- modo de visibilidade da org ('equipe' quando ausente)
create or replace function app.visibilidade_registros(p_org uuid)
returns text
language sql stable security definer set search_path = public, app, auth as $$
  select coalesce(
    (select settings->>'visibilidade_registros' from public.organizations where id = p_org),
    'equipe')
$$;

-- o usuário atual pode VER um registro criado por p_creator?
--   'equipe'  → sim (comportamento atual);
--   'proprios'→ só o próprio criador — mas registros criados por quem NÃO é
--               anestesiologista/gestor (ex.: secretária) são compartilhados.
create or replace function app.pode_ver_registro(p_org uuid, p_creator uuid)
returns boolean
language sql stable security definer set search_path = public, app, auth as $$
  select app.visibilidade_registros(p_org) = 'equipe'
      or p_creator is null
      or p_creator = auth.uid()
      or not exists (
           select 1 from public.organization_users ou
            where ou.organization_id = p_org
              and ou.user_id = p_creator
              and ou.ativo = true
              and ou.role in ('anestesiologista','gestor')
         )
$$;

-- 3) policies de LEITURA condicionadas (recria as _sel; escrita não muda) -----
do $$
declare t text;
begin
  foreach t in array array['preanesthetic_assessments','anesthesia_records',
                           'recovery_records','risk_assessments'] loop
    execute format('drop policy if exists %I_sel on public.%I', t, t);
    execute format($f$create policy %I_sel on public.%I for select
      using (organization_id in (select app.org_ids())
             and (
               app.has_role(organization_id, array['gestor'])
               or (app.has_role(organization_id, array['anestesiologista'])
                   and app.pode_ver_registro(organization_id, created_by))
               or exists (select 1 from public.encounters e
                          where e.id = %I.encounter_id
                            and e.surgeon_id = auth.uid())
             ))$f$, t, t, t);
  end loop;
end $$;

-- financeiro: gestor/financeiro sempre; anestesiologista conforme o modo
drop policy if exists fin_sel on public.finance_entries;
create policy fin_sel on public.finance_entries for select
  using (app.has_role(organization_id, array['gestor','financeiro'])
         or (app.has_role(organization_id, array['anestesiologista'])
             and app.pode_ver_registro(organization_id, created_by)));

commit;
