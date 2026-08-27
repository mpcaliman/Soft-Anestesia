-- =============================================================================
-- Soft Anestesia — Migração 0016: o banco passa a honrar a permissão por módulo
-- =============================================================================
-- Rode DEPOIS da 0011. Aditiva e idempotente: NENHUM acesso existente é
-- removido — só se acrescenta o que o gestor já concedeu na tela.
--
-- O QUE ESTAVA ERRADO
--   Havia duas fontes de verdade para permissão, e elas discordavam.
--
--   No app, o gestor abre "Equipe da nuvem → ✏️ Acesso" e marca, por pessoa e
--   por módulo: Sem acesso / Editar / Só impressão. Isso é gravado em
--   organization_users.permissoes (migração 0011) e o app obedece.
--
--   No banco, as policies nunca souberam desse campo. Elas decidem só pelo
--   PAPEL:
--       can_write_clinical → gestor, anestesiologista
--       fin_sel/fin_wr     → gestor, financeiro, anestesiologista
--
--   O papel "auxiliar" (secretária) não está em nenhuma das duas.
--
--   Consequência prática, e ela é grave: o app tem um fluxo inteiro de
--   PRÉ-LANÇAMENTO desenhado para a secretária — ela preenche a pré, aperta
--   "Enviar pré-lançamento", e o médico confere numa fila. Só que o INSERT era
--   recusado pelo RLS. Ela via "enviado", o médico via fila vazia, e ninguém
--   via erro: a recusa acontece no servidor e o app tratava como falha de rede.
--
--   O mesmo no financeiro: a secretária lança convênio e confere pendências —
--   é a função dela — e o SELECT era negado. Painel vazio, pendências vazias,
--   e nenhuma explicação.
--
-- A CORREÇÃO
--   Uma função nova, app.pode_modulo(org, modulo), que lê o que o gestor
--   marcou na tela. As policies passam a aceitar OU o papel (como hoje) OU a
--   permissão explícita daquela pessoa naquele módulo.
--
--   Estritamente aditivo: quem já podia continua podendo, com as mesmas
--   regras. Ninguém ganha acesso por acidente — só quem o gestor marcou.
--
--   "Só impressão" NÃO dá escrita: quem está em soImpressao pode ler e não
--   pode gravar. É o que a tela promete.
-- =============================================================================

begin;

-- 1) A ponte entre a tela e o banco -------------------------------------------
-- permissoes = { "perfil": "...", "modulos": [...], "soImpressao": [...] }
-- Nulo = o gestor não personalizou: vale só o padrão do papel, como antes.

create or replace function app.pode_modulo(p_org uuid, p_modulo text)
returns boolean
language sql stable security definer set search_path = public, app, auth as $$
  select exists (
    select 1 from public.organization_users ou
     where ou.user_id = auth.uid()
       and ou.organization_id = p_org
       and ou.ativo = true
       and ou.permissoes is not null
       and ou.permissoes -> 'modulos' @> to_jsonb(p_modulo)
  )
$$;

-- Escrita exige o módulo E não estar em "só impressão".
create or replace function app.pode_editar_modulo(p_org uuid, p_modulo text)
returns boolean
language sql stable security definer set search_path = public, app, auth as $$
  select exists (
    select 1 from public.organization_users ou
     where ou.user_id = auth.uid()
       and ou.organization_id = p_org
       and ou.ativo = true
       and ou.permissoes is not null
       and ou.permissoes -> 'modulos' @> to_jsonb(p_modulo)
       and not coalesce(ou.permissoes -> 'soImpressao' @> to_jsonb(p_modulo), false)
  )
$$;

-- 2) Tabelas clínicas ---------------------------------------------------------
-- Cada tabela conhece o seu módulo, para a permissão ser conferida no módulo
-- certo — quem tem "Pré-anestésica: Editar" não ganha a ficha de anestesia.

do $$
declare
  r record;
  mapa jsonb := '{
    "preanesthetic_assessments": "pre",
    "anesthesia_records":        "anestesia",
    "recovery_records":          "recuperacao",
    "risk_assessments":          "risco",
    "consents":                  "termo",
    "prescriptions":             "prescricao",
    "documents":                 "documentos"
  }'::jsonb;
  t text; m text;
begin
  for r in select key, value from jsonb_each_text(mapa) loop
    t := r.key; m := r.value;
    if not exists (select 1 from information_schema.tables
                   where table_schema = 'public' and table_name = t) then
      raise notice 'tabela public.% não existe — pulando', t;
      continue;
    end if;

    -- LEITURA: mantém a regra da 0008 (gestor, anestesiologista conforme a
    -- visibilidade, cirurgião do próprio caso) e ACRESCENTA quem tem o módulo.
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
               or app.pode_modulo(organization_id, %L)
             ))$f$, t, t, t, m);

    -- ESCRITA: papel como hoje, MAIS quem o gestor autorizou a editar.
    execute format('drop policy if exists %I_wr on public.%I', t, t);
    execute format($f$create policy %I_wr on public.%I for all
      using (app.can_write_clinical(organization_id)
             or app.pode_editar_modulo(organization_id, %L))
      with check (app.can_write_clinical(organization_id)
                  or app.pode_editar_modulo(organization_id, %L))$f$, t, t, m, m);
  end loop;
end $$;

-- 3) Financeiro ---------------------------------------------------------------
-- Conferir pendência de convênio é trabalho de secretária. O papel continua
-- valendo; quem tem o módulo marcado entra junto.

drop policy if exists fin_sel on public.finance_entries;
create policy fin_sel on public.finance_entries for select
  using (app.has_role(organization_id, array['gestor','financeiro'])
         or (app.has_role(organization_id, array['anestesiologista'])
             and app.pode_ver_registro(organization_id, created_by))
         or app.pode_modulo(organization_id, 'financeiro'));

drop policy if exists fin_wr on public.finance_entries;
create policy fin_wr on public.finance_entries for all
  using (app.has_role(organization_id, array['gestor','financeiro','anestesiologista'])
         or app.pode_editar_modulo(organization_id, 'financeiro'))
  with check (app.has_role(organization_id, array['gestor','financeiro','anestesiologista'])
              or app.pode_editar_modulo(organization_id, 'financeiro'));

-- 4) Encontros ----------------------------------------------------------------
-- A pré e a ficha penduram num encounter. Sem poder LER o encounter, a
-- secretária grava a pré e não consegue reabri-la: meio caminho é pior que
-- caminho nenhum.

drop policy if exists enc_sel on public.encounters;
create policy enc_sel on public.encounters for select
  using (organization_id in (select app.org_ids())
         and (app.can_read_clinical(organization_id, surgeon_id)
              or app.pode_modulo(organization_id, 'pre')
              or app.pode_modulo(organization_id, 'anestesia')
              or app.pode_modulo(organization_id, 'financeiro')));

-- 5) Orçamentos ---------------------------------------------------------------
do $$
begin
  if exists (select 1 from information_schema.tables
             where table_schema = 'public' and table_name = 'quotes') then
    execute 'drop policy if exists quotes_sel on public.quotes';
    execute $f$create policy quotes_sel on public.quotes for select
      using (organization_id in (select app.org_ids())
             and (app.has_role(organization_id, array['gestor','financeiro','anestesiologista'])
                  or app.pode_modulo(organization_id, 'orcamento')))$f$;
    execute 'drop policy if exists quotes_wr on public.quotes';
    execute $f$create policy quotes_wr on public.quotes for all
      using (app.has_role(organization_id, array['gestor','financeiro','anestesiologista'])
             or app.pode_editar_modulo(organization_id, 'orcamento'))
      with check (app.has_role(organization_id, array['gestor','financeiro','anestesiologista'])
                  or app.pode_editar_modulo(organization_id, 'orcamento'))$f$;
  end if;
end $$;

commit;

-- =============================================================================
-- CONFERÊNCIA
-- Rode logado como a pessoa em questão (ou confira o vínculo dela abaixo).
-- Os módulos marcados pelo gestor têm de aparecer aqui:
-- =============================================================================
select ou.user_id,
       u.email,
       ou.role,
       ou.ativo,
       ou.permissoes -> 'modulos'     as modulos_marcados,
       ou.permissoes -> 'soImpressao' as so_impressao
  from public.organization_users ou
  left join auth.users u on u.id = ou.user_id
 order by u.email;
