-- =============================================================================
-- Soft Anestesia — Migração 0007: secretária (auxiliar) no fluxo clínico dela
-- =============================================================================
-- Rode DEPOIS da 0001–0006. Idempotente e ADITIVA (só cria policies novas;
-- não altera nenhuma existente).
--
-- Motivo: o app permite à secretária (papel `auxiliar`) preencher a parte
-- administrativa da PRÉ-ANESTÉSICA (comorbidades, medicações em uso, exames)
-- e emitir TERMO (consents) e DOCUMENTOS (atestado/declaração). Mas a RLS da
-- fundação restringia a escrita clínica a gestor/anestesiologista — então o
-- que a secretária fazia num aparelho NÃO chegava aos outros pela nuvem.
--
-- Esta migração adiciona policies PERMISSIVAS (somam-se às existentes) dando
-- ao papel `auxiliar` leitura e escrita APENAS nas 3 tabelas do fluxo dela:
--   • preanesthetic_assessments  (pré-anestésica)
--   • consents                   (termo de consentimento)
--   • documents                  (atestado / declaração / laudo)
-- Ficha de anestesia, SRPA, risco e receituário continuam fora do alcance.
-- Registros finalizados continuam imutáveis (trigger guard_finalized).
-- =============================================================================

begin;

do $$
declare t text;
begin
  foreach t in array array['preanesthetic_assessments','consents','documents'] loop
    execute format('drop policy if exists %I_aux_sel on public.%I', t, t);
    execute format($f$create policy %I_aux_sel on public.%I for select
      using (app.has_role(organization_id, array['auxiliar']))$f$, t, t);

    execute format('drop policy if exists %I_aux_wr on public.%I', t, t);
    execute format($f$create policy %I_aux_wr on public.%I for all
      using (app.has_role(organization_id, array['auxiliar']))
      with check (app.has_role(organization_id, array['auxiliar']))$f$, t, t);
  end loop;
end $$;

commit;
