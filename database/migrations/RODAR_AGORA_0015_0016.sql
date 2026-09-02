-- =============================================================================
-- Soft Anestesia — ARQUIVO ÚNICO: migrações 0015 + 0016
-- =============================================================================
-- Copie tudo, cole no SQL Editor do Supabase e rode de uma vez.
-- É seguro rodar de novo: nada aqui apaga dado nenhum, e rodar duas vezes dá
-- o mesmo resultado que rodar uma.
--
-- No fim aparece um quadro de conferência. É ele que responde se deu certo.
--
-- PARTE 1 (0015) — os três módulos que faltavam no tempo real
--   Consulta, risco e termo ainda chegavam só pelo ciclo de sincronização:
--   funcionavam, com minutos de atraso em vez de segundos. Passam a chegar na
--   hora, como os outros quatro.
--
-- PARTE 2 (0016) — o Ajustes passa a ser o único juiz do acesso
--   Leia o bloco de comentários da Parte 2: ele explica o defeito que segurou
--   a pré da Linalva e por que o financeiro da secretária vinha vazio.
-- =============================================================================


-- #############################################################################
-- PARTE 1 de 2 — tempo real para consulta, risco e termo (migração 0015)
-- #############################################################################
-- REPLICA IDENTITY FULL manda também a linha ANTERIOR na mudança. Custa um
-- pouco mais de WAL e é o que permite comparar versões num conflito, em vez de
-- só saber que "algo mudou".

do $$
declare
  t text;
  alvo text[] := array['consultations', 'risk_assessments', 'consents'];
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
  foreach t in array alvo loop
    -- a tabela pode não existir num projeto que parou numa migração anterior
    if not exists (select 1 from information_schema.tables
                   where table_schema = 'public' and table_name = t) then
      raise notice 'tabela public.% ainda não existe — pulando', t;
      continue;
    end if;
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
    execute format('alter table public.%I replica identity full', t);
  end loop;
end $$;


-- #############################################################################
-- PARTE 2 de 2 — o Ajustes passa a ser o único juiz do acesso (migração 0016)
-- #############################################################################
-- O QUE ESTAVA ERRADO
--   Havia duas fontes de verdade para permissão, e elas discordavam.
--
--   No app, o gestor abre "Equipe da nuvem -> Acesso" e marca, por pessoa e
--   por módulo: Sem acesso / Editar / Só impressão. Vai para
--   organization_users.permissoes (migração 0011) e o app obedece.
--
--   No banco, as policies nunca souberam desse campo. Decidem só pelo PAPEL:
--       can_write_clinical -> gestor, anestesiologista
--       fin_sel / fin_wr   -> gestor, financeiro, anestesiologista
--
--   O papel "auxiliar" -- o da secretária -- não está em nenhuma das duas.
--
--   A consequência é grave e explicou a semana inteira: o app tem um fluxo de
--   PRÉ-LANÇAMENTO desenhado para ela (preenche a pré, aperta "Enviar", o
--   médico confere numa fila) e o INSERT era recusado pelo RLS. Ela via
--   "enviado", o médico via fila vazia, e ninguém via erro -- a recusa acontece
--   no servidor e o app a tratava como falha de rede. Foi assim que uma pré
--   nunca chegou. No financeiro, o mesmo: conferir pendência de convênio é a
--   função dela, e o SELECT era negado.
--
-- A REGRA NOVA, E ELA É UMA SÓ
--   Configurou no Ajustes -> o Ajustes decide, sozinho. O papel não concede
--   nada por fora e não tira nada: marcar "Sem acesso" tira mesmo, inclusive
--   de um anestesiologista.
--   Não configurou (permissoes nulo) -> vale o padrão do papel, como sempre
--   valeu. É o que impede que alguém ainda não configurado -- inclusive o
--   próprio gestor -- fique trancado para fora no instante em que esta
--   migração roda.
--
--   "Só impressão" lê e não grava. É o que a tela promete, e agora o banco
--   cumpre.
--
-- O QUE NÃO MUDA, DE PROPÓSITO
--   Quem edita organization_users continua sendo só o gestor (policy ou_all,
--   da 0001). Sem isso, qualquer pessoa se concederia acesso e a tela de
--   Ajustes viraria enfeite.
--
--   Consequência que vale saber: dar o módulo "ajustes" a alguém é dar o poder
--   de mudar o acesso de todo mundo, porque a Equipe da nuvem mora lá dentro.
-- =============================================================================

begin;

-- 1) A ponte entre a tela e o banco -------------------------------------------
-- permissoes = { "perfil": "...", "modulos": [...], "soImpressao": [...] }

-- Esta pessoa foi configurada no Ajustes?
create or replace function app.tem_config(p_org uuid)
returns boolean
language sql stable security definer set search_path = public, app, auth as $$
  select exists (
    select 1 from public.organization_users ou
     where ou.user_id = auth.uid()
       and ou.organization_id = p_org
       and ou.ativo = true
       and ou.permissoes is not null
       and jsonb_typeof(ou.permissoes -> 'modulos') = 'array'
  )
$$;

-- Padrão do papel — vale SÓ para quem ainda não foi configurado no Ajustes.
-- Espelha auth.ROLE_PERMS do app; se um papel novo surgir lá, acrescente aqui.
create or replace function app.modulos_do_papel(p_org uuid)
returns text[]
language sql stable security definer set search_path = public, app, auth as $$
  select case (select ou.role from public.organization_users ou
                where ou.user_id = auth.uid() and ou.organization_id = p_org and ou.ativo)
    when 'gestor'           then array['dashboard','pacientes','agenda','consulta','pre','termo','prescricao','documentos','risco','anestesia','recuperacao','financeiro','orcamento','doses','ajustes']
    when 'anestesiologista' then array['dashboard','pacientes','agenda','consulta','pre','termo','prescricao','documentos','risco','anestesia','recuperacao','financeiro','orcamento','doses']
    when 'auxiliar'         then array['dashboard','pacientes','agenda','pre','termo','prescricao','documentos','financeiro','orcamento']
    when 'financeiro'       then array['dashboard','pacientes','agenda','financeiro','orcamento']
    when 'empresa'          then array['dashboard','financeiro','orcamento']
    when 'cirurgiao'        then array['dashboard','pacientes','agenda','consulta','pre','termo','documentos','risco']
    else array[]::text[]
  end
$$;

-- A REGRA, e é uma só: configurou no Ajustes -> o Ajustes decide sozinho;
-- não configurou -> padrão do papel.
create or replace function app.pode_modulo(p_org uuid, p_modulo text)
returns boolean
language sql stable security definer set search_path = public, app, auth as $$
  select case
    when app.tem_config(p_org) then exists (
      select 1 from public.organization_users ou
       where ou.user_id = auth.uid() and ou.organization_id = p_org and ou.ativo = true
         and ou.permissoes -> 'modulos' @> to_jsonb(p_modulo))
    else p_modulo = any (app.modulos_do_papel(p_org))
  end
$$;

-- Escrever exige o módulo E não estar em "só impressão".
create or replace function app.pode_editar_modulo(p_org uuid, p_modulo text)
returns boolean
language sql stable security definer set search_path = public, app, auth as $$
  select app.pode_modulo(p_org, p_modulo)
     and not coalesce((
       select ou.permissoes -> 'soImpressao' @> to_jsonb(p_modulo)
         from public.organization_users ou
        where ou.user_id = auth.uid() and ou.organization_id = p_org and ou.ativo = true
          and ou.permissoes is not null), false)
$$;

-- 2) Tabelas clínicas ---------------------------------------------------------
-- Cada tabela conhece o seu módulo: quem tem "Pré-anestésica: Editar" não
-- ganha a ficha de anestesia junto.
--
-- A visibilidade "próprios" (0008) continua valendo POR CIMA do módulo: ter o
-- módulo diz QUE TIPO de registro se vê; a visibilidade diz DE QUEM. São
-- perguntas diferentes e as duas continuam sendo feitas.
--
-- Um furo antigo fecha aqui: a policy de escrita nasceu "for all" (0001), e no
-- Postgres o "for all" também vale para o SELECT. Como só a _sel recebeu a
-- visibilidade na 0008, quem podia escrever voltava a ver o registro do colega
-- pela porta dos fundos — o modo "próprios" não segurava nada entre
-- anestesiologistas. Agora o USING da escrita faz a mesma pergunta: para
-- alterar ou apagar, é preciso poder enxergar. O WITH CHECK (criar) não leva a
-- condição, senão ninguém criaria o próprio primeiro registro.

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

    execute format('drop policy if exists %I_sel on public.%I', t, t);
    execute format($f$create policy %I_sel on public.%I for select
      using (organization_id in (select app.org_ids())
             and app.pode_modulo(organization_id, %L)
             and (
               not app.has_role(organization_id, array['anestesiologista'])
               or app.pode_ver_registro(organization_id, created_by)
             ))$f$, t, t, m);

    execute format('drop policy if exists %I_wr on public.%I', t, t);
    execute format($f$create policy %I_wr on public.%I for all
      using (app.pode_editar_modulo(organization_id, %L)
             and (not app.has_role(organization_id, array['anestesiologista'])
                  or app.pode_ver_registro(organization_id, created_by)))
      with check (app.pode_editar_modulo(organization_id, %L))$f$, t, t, m, m);
  end loop;
end $$;

-- 3) Financeiro ---------------------------------------------------------------
drop policy if exists fin_sel on public.finance_entries;
create policy fin_sel on public.finance_entries for select
  using (organization_id in (select app.org_ids())
         and app.pode_modulo(organization_id, 'financeiro')
         and (not app.has_role(organization_id, array['anestesiologista'])
              or app.pode_ver_registro(organization_id, created_by)));

drop policy if exists fin_wr on public.finance_entries;
create policy fin_wr on public.finance_entries for all
  using (app.pode_editar_modulo(organization_id, 'financeiro')
         and (not app.has_role(organization_id, array['anestesiologista'])
              or app.pode_ver_registro(organization_id, created_by)))
  with check (app.pode_editar_modulo(organization_id, 'financeiro'));

-- 4) Orçamentos ---------------------------------------------------------------
do $$
begin
  if exists (select 1 from information_schema.tables
             where table_schema = 'public' and table_name = 'quotes') then
    execute 'drop policy if exists quotes_sel on public.quotes';
    execute $f$create policy quotes_sel on public.quotes for select
      using (organization_id in (select app.org_ids())
             and app.pode_modulo(organization_id, 'orcamento'))$f$;
    execute 'drop policy if exists quotes_wr on public.quotes';
    execute $f$create policy quotes_wr on public.quotes for all
      using (app.pode_editar_modulo(organization_id, 'orcamento'))
      with check (app.pode_editar_modulo(organization_id, 'orcamento'))$f$;
  end if;
end $$;

-- 5) Pacientes, agenda e encontros --------------------------------------------
-- Paciente e agenda são o alicerce: sem eles, ter "pré" não serve de nada.
-- O encounter é onde a pré e a ficha penduram — sem poder lê-lo, a secretária
-- grava a pré e não consegue reabri-la, e meio caminho é pior que nenhum.

drop policy if exists patients_sel on public.patients;
create policy patients_sel on public.patients for select
  using (organization_id in (select app.org_ids())
         and app.pode_modulo(organization_id, 'pacientes'));
drop policy if exists patients_wr on public.patients;
create policy patients_wr on public.patients for all
  using (app.pode_editar_modulo(organization_id, 'pacientes'))
  with check (app.pode_editar_modulo(organization_id, 'pacientes'));

drop policy if exists enc_sel on public.encounters;
create policy enc_sel on public.encounters for select
  using (organization_id in (select app.org_ids())
         and (app.pode_modulo(organization_id, 'pre')
              or app.pode_modulo(organization_id, 'anestesia')
              or app.pode_modulo(organization_id, 'recuperacao')
              or app.pode_modulo(organization_id, 'financeiro')));
drop policy if exists enc_wr on public.encounters;
create policy enc_wr on public.encounters for all
  using (app.pode_editar_modulo(organization_id, 'pre')
         or app.pode_editar_modulo(organization_id, 'anestesia')
         or app.pode_editar_modulo(organization_id, 'recuperacao'))
  with check (app.pode_editar_modulo(organization_id, 'pre')
              or app.pode_editar_modulo(organization_id, 'anestesia')
              or app.pode_editar_modulo(organization_id, 'recuperacao'));

do $$
begin
  if exists (select 1 from information_schema.tables
             where table_schema = 'public' and table_name = 'appointments') then
    execute 'drop policy if exists appt_sel on public.appointments';
    execute $f$create policy appt_sel on public.appointments for select
      using (organization_id in (select app.org_ids())
             and app.pode_modulo(organization_id, 'agenda'))$f$;
    execute 'drop policy if exists appt_wr on public.appointments';
    execute $f$create policy appt_wr on public.appointments for all
      using (app.pode_editar_modulo(organization_id, 'agenda'))
      with check (app.pode_editar_modulo(organization_id, 'agenda'))$f$;
  end if;
end $$;

commit;

-- #############################################################################
-- CONFERÊNCIA — é este quadro que diz se deu certo
-- #############################################################################

-- 1) Tempo real: as SETE tabelas dos módulos têm de aparecer aqui
--    (anesthesia_records, consents, consultations, finance_entries,
--     preanesthetic_assessments, recovery_records, risk_assessments — e mais
--     pacientes/encontros, que já vinham da 0002).
select 'tempo real' as parte, tablename as item, '' as detalhe
  from pg_publication_tables
 where pubname = 'supabase_realtime' and schemaname = 'public'

union all

-- 2) Quem está configurado no Ajustes e quem ainda segue o padrão do papel.
--    A secretária tem de aparecer com "financeiro" na lista de módulos.
select 'acesso' as parte,
       coalesce(u.email, ou.user_id::text) || '  ·  ' || ou.role
         || case when ou.ativo then '' else '  (INATIVO)' end as item,
       case when ou.permissoes -> 'modulos' is null
            then '— segue o padrão do papel —'
            else 'Ajustes: ' || (ou.permissoes ->> 'modulos')
                 || coalesce('   só impressão: ' || (ou.permissoes ->> 'soImpressao'), '')
       end as detalhe
  from public.organization_users ou
  left join auth.users u on u.id = ou.user_id

order by 1, 2;
