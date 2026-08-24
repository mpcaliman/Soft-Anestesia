-- =============================================================================
-- Soft Anestesia — Migração 0014: base central de medicamentos (Anvisa/CMED)
-- =============================================================================
-- Rode DEPOIS da 0001–0013. Aditiva e idempotente: não altera nem apaga nada
-- do que já existe. Pode ser reexecutada à vontade.
--
-- PARA QUE SERVE
--   Uma base só de medicamentos para TODOS os módulos (pré-anestésica, ficha
--   de anestesia, prescrição). Antes cada módulo tinha a sua listinha e o nome
--   do remédio era texto livre: "Xarelto" na pré e "rivaroxabana" na
--   prescrição eram, para o sistema, duas coisas sem relação nenhuma.
--
--   Aqui a relação existe e é explícita:
--     marca <-> princípio ativo <-> apresentação <-> forma <-> via
--
-- O QUE ESTA BASE NÃO É
--   Não é tabela de preço. A CMED publica preço máximo; nada disso é
--   importado, porque o sistema não cobra medicamento por tabela CMED.
--   Não é fonte de posologia. A CMED não tem dose terapêutica e o sistema não
--   inventa nenhuma: dose, frequência e duração são decisão médica.
--
-- COMO CARREGAR OS DADOS
--   Esta migração cria a estrutura vazia. As 26.001 apresentações vêm de
--   database/seeds/medicamentos_anvisa.sql (gerado por
--   scripts/gerar-base-medicamentos.mjs) ou do importador incremental
--   scripts/import-anvisa-medications.mjs. Os dois fazem upsert por GGREM.
--   Depois do seed:  refresh materialized view public.medicamentos_clinicos;
--
-- COMO DESFAZER
--   drop function if exists public.buscar_medicamentos(text,text,integer,boolean);
--   drop function if exists public.apresentacoes_do_principio(text,text,integer);
--   drop materialized view if exists public.medicamentos_clinicos;
--   drop table if exists public.medicamentos_regras_anestesicas;
--   drop table if exists public.medicamentos_base_versao;
--   drop table if exists public.medicamentos;
--   (nada depende delas: o vínculo nos registros clínicos é por chave em texto
--    MAIS uma cópia dos campos dentro do próprio registro, de propósito, para
--    que prescrição antiga nunca fique órfã se a base for atualizada.)
-- =============================================================================

begin;

create extension if not exists unaccent;
create extension if not exists pg_trgm;

-- -----------------------------------------------------------------------------
-- Normalização para busca
-- unaccent() é STABLE (depende do dicionário carregado), e coluna gerada ou
-- índice exigem IMMUTABLE. A forma de dois argumentos, com o dicionário fixado,
-- é imutável — é essa que dá para indexar.
-- O resultado tem de ser IDÊNTICO ao de norm() em scripts/anvisa/normalizar.mjs,
-- senão a busca online e a offline divergem.
-- -----------------------------------------------------------------------------
create or replace function public.med_unaccent(text)
  returns text language sql immutable parallel safe strict as
$$ select public.unaccent('public.unaccent', $1) $$;

create or replace function public.med_normalizar(txt text)
  returns text language sql immutable parallel safe as
$$ select btrim(regexp_replace(lower(public.med_unaccent(coalesce(txt, ''))), '\s+', ' ', 'g')) $$;

comment on function public.med_normalizar(text) is
  'Minúsculo, sem acento, sem espaço dobrado. Espelha norm() em scripts/anvisa/normalizar.mjs.';

-- -----------------------------------------------------------------------------
-- Tabela central — uma linha por APRESENTAÇÃO da CMED
-- O agrupamento clínico (o que o médico vê como "um item") é a matview mais
-- abaixo; os registros originais ficam todos aqui.
-- -----------------------------------------------------------------------------
create table if not exists public.medicamentos (
  -- O GGREM é a chave da CMED: único nos 26.001 registros. O "ID apresentação"
  -- NÃO serve de chave — foi conferido, e há um caso em que dois GGREM
  -- diferentes carregam o mesmo ID. Usá-lo como chave perderia esse registro.
  ggrem                         text primary key,
  id_apresentacao               text not null default '',
  nome_comercial                text not null default '',
  nome_generico                 text not null default '',
  principio_ativo               text not null default '',
  -- Raiz do princípio: "pantoprazol" para PANTOPRAZOL, PANTOPRAZOL SÓDICO e
  -- PANTOPRAZOL SÓDICO SESQUI-HIDRATADO. É por ela que marca, genérico e
  -- similar do mesmo fármaco caem na mesma lista — e é a ela que a regra
  -- clínica se prende, nunca à marca.
  principio_base                text not null default '',
  concentracao                  text not null default '',
  forma_farmaceutica            text not null default '',
  -- Rótulo legível da via ('Oral', 'Intravenosa / Intramuscular'). VAZIO quando
  -- a CMED não determina a via — é o caso do injetável sem via na apresentação.
  via_administracao             text not null default '',
  vias                          text[] not null default '{}',
  via_definida                  boolean not null default false,
  -- true quando se sabe que é injetável e NADA MAIS. A tela mostra
  -- "Via a definir" e deixa o médico escolher; o sistema não chuta IV/IM/SC.
  injetavel_sem_via             boolean not null default false,
  origem_via                    text not null default '',
  apresentacao_original_anvisa  text not null default '',
  laboratorio                   text not null default '',
  -- referencia | generico | similar | biologico | especifico | fitoterapico |
  -- terapia_avancada | radiofarmaco
  -- ("Novo" da CMED é o que o médico chama de REFERÊNCIA.)
  tipo_medicamento              text not null default '',
  tipo_entrada                  text not null default '',
  registro_anvisa               text not null default '',
  ean                           text not null default '',
  ean2                          text not null default '',
  ean3                          text not null default '',
  classe_terapeutica            text not null default '',
  regime_preco                  text not null default '',
  comercializado                boolean not null default true,
  fonte                         text not null default '',
  ativo                         boolean not null default true,
  criado_em                     timestamptz not null default now(),
  atualizado_em                 timestamptz not null default now(),

  -- Colunas de busca: geradas, nunca preenchidas à mão, nunca fora de sincronia.
  nome_comercial_norm  text generated always as (public.med_normalizar(nome_comercial))  stored,
  nome_generico_norm   text generated always as (public.med_normalizar(nome_generico))   stored,
  principio_norm       text generated always as (public.med_normalizar(principio_ativo)) stored,
  busca_norm           text generated always as (
    public.med_normalizar(nome_comercial) || ' ' ||
    public.med_normalizar(principio_ativo) || ' ' ||
    public.med_normalizar(nome_generico)
  ) stored
);

comment on table public.medicamentos is
  'Base oficial Anvisa/CMED. Identificação, apresentação, forma e via. Não é tabela de preço nem de posologia.';
comment on column public.medicamentos.principio_base is
  'Raiz do princípio ativo, sem sal nem hidrato. É a chave clínica: regra de anticoagulante vale para a rivaroxabana, não para "Xarelto".';
comment on column public.medicamentos.injetavel_sem_via is
  'A CMED diz apenas "injetável". IV, IM ou SC seria invenção nossa — a tela pede a via ao médico.';
comment on column public.medicamentos.tipo_medicamento is
  'referencia (a CMED chama de "Novo"), generico, similar, biologico, especifico, fitoterapico, terapia_avancada, radiofarmaco.';

-- Prefixo ("panto" -> PANTOZOL, PANTOPRAZOL): btree com text_pattern_ops.
create index if not exists idx_med_nome_pref      on public.medicamentos (nome_comercial_norm text_pattern_ops);
create index if not exists idx_med_principio_pref on public.medicamentos (principio_norm      text_pattern_ops);
create index if not exists idx_med_generico_pref  on public.medicamentos (nome_generico_norm  text_pattern_ops);
-- Contido e aproximado: trigrama.
create index if not exists idx_med_busca_trgm     on public.medicamentos using gin (busca_norm gin_trgm_ops);
-- Agrupamentos, filtros e as chaves de atualização futura da base.
create index if not exists idx_med_base           on public.medicamentos (principio_base);
create index if not exists idx_med_tipo           on public.medicamentos (tipo_medicamento);
create index if not exists idx_med_registro       on public.medicamentos (registro_anvisa);
create index if not exists idx_med_idapres        on public.medicamentos (id_apresentacao);
create index if not exists idx_med_ean            on public.medicamentos (ean);

-- -----------------------------------------------------------------------------
-- Agrupamento clínico (§24)
-- Embalagem, quantidade de comprimidos e EAN não fazem de dois registros dois
-- itens diferentes para quem prescreve. A lista mostra um; o banco guarda
-- todos, e quantas_apresentacoes diz quantos são.
-- -----------------------------------------------------------------------------
drop materialized view if exists public.medicamentos_clinicos cascade;
create materialized view public.medicamentos_clinicos as
select
  min(m.ggrem)                                       as ggrem,
  min(m.id_apresentacao)                             as id_apresentacao,
  min(m.nome_comercial)                              as nome_comercial,
  min(m.nome_generico)                               as nome_generico,
  min(m.principio_ativo)                             as principio_ativo,
  min(m.principio_base)                              as principio_base,
  min(m.concentracao)                                as concentracao,
  min(m.forma_farmaceutica)                          as forma_farmaceutica,
  min(m.via_administracao)                           as via_administracao,
  max(m.via_definida::int)::boolean                  as via_definida,
  max(m.injetavel_sem_via::int)::boolean             as injetavel_sem_via,
  m.tipo_medicamento,
  min(m.laboratorio)                                 as laboratorio,
  min(m.registro_anvisa)                             as registro_anvisa,
  min(m.classe_terapeutica)                          as classe_terapeutica,
  max(m.comercializado::int)::boolean                as comercializado,
  count(*)                                           as quantas_apresentacoes,
  m.nome_comercial_norm,
  m.principio_norm,
  min(m.nome_generico_norm)                          as nome_generico_norm,
  m.nome_comercial_norm || ' ' || m.principio_norm || ' ' ||
    min(m.nome_generico_norm)                        as busca_norm
from public.medicamentos m
where m.ativo
-- Agrupa pelo texto NORMALIZADO, não pelo texto como veio: "PANTOZOL" e
-- "Pantozol" são a mesma coisa para quem prescreve, e a chave tem de ser
-- exatamente a mesma de chaveClinica() em scripts/anvisa/normalizar.mjs —
-- senão a lista online e a offline mostram itens diferentes.
group by
  m.nome_comercial_norm,
  m.principio_norm,
  public.med_normalizar(m.concentracao),
  public.med_normalizar(m.forma_farmaceutica),
  public.med_normalizar(m.via_administracao),
  m.tipo_medicamento;

comment on materialized view public.medicamentos_clinicos is
  'O que o médico enxerga como um item. Atualize com: refresh materialized view concurrently public.medicamentos_clinicos;';

create unique index if not exists idx_medclin_pk    on public.medicamentos_clinicos (ggrem);
create index if not exists idx_medclin_nome_pref    on public.medicamentos_clinicos (nome_comercial_norm text_pattern_ops);
create index if not exists idx_medclin_princ_pref   on public.medicamentos_clinicos (principio_norm      text_pattern_ops);
create index if not exists idx_medclin_gener_pref   on public.medicamentos_clinicos (nome_generico_norm  text_pattern_ops);
create index if not exists idx_medclin_busca_trgm   on public.medicamentos_clinicos using gin (busca_norm gin_trgm_ops);
-- A tolerância a erro de digitação compara com o nome e com o princípio
-- separadamente; sem estes dois, cada tecla custava 110 ms varrendo a matview
-- inteira — lento demais para uma lista que aparece enquanto se digita.
create index if not exists idx_medclin_nome_trgm    on public.medicamentos_clinicos using gin (nome_comercial_norm gin_trgm_ops);
create index if not exists idx_medclin_princ_trgm   on public.medicamentos_clinicos using gin (principio_norm      gin_trgm_ops);
create index if not exists idx_medclin_base         on public.medicamentos_clinicos (principio_base);
create index if not exists idx_medclin_tipo         on public.medicamentos_clinicos (tipo_medicamento);

-- -----------------------------------------------------------------------------
-- BUSCA
-- Ordem de relevância (§23): começo do nome comercial, começo do princípio,
-- começo do nome genérico, termo contido, e só então parecido. Correspondência
-- exata sempre ganha de aproximada — "xareuto" pode achar Xarelto, mas nunca
-- na frente de quem realmente começa com o que foi digitado.
--
-- `create or replace` não consegue mudar tipo de retorno: sem o drop, esta
-- migração pararia com "cannot change return type" em toda instalação que já
-- tivesse uma versão anterior da função. Reexecutável de verdade exige isto.
-- -----------------------------------------------------------------------------
drop function if exists public.buscar_medicamentos(text, text, integer, boolean);
create function public.buscar_medicamentos(
  p_termo              text,
  p_tipo               text    default null,   -- referencia | generico | similar | null (todos)
  p_limite             integer default 20,
  p_so_comercializados boolean default false
)
returns table (
  ggrem text, id_apresentacao text, nome_comercial text, nome_generico text,
  principio_ativo text, principio_base text, concentracao text,
  forma_farmaceutica text, via_administracao text, via_definida boolean,
  injetavel_sem_via boolean, tipo_medicamento text, laboratorio text,
  registro_anvisa text, classe_terapeutica text, comercializado boolean,
  quantas_apresentacoes bigint, relevancia integer
)
language plpgsql stable parallel safe
set search_path = public
as $fn$
declare
  t   text    := public.med_normalizar(p_termo);
  lim integer := greatest(1, least(coalesce(p_limite, 20), 100));
begin
  if length(t) < 2 then return; end if;

  -- DOIS CAMINHOS, e não um `case` dentro do where: com o `case`, o planejador
  -- não consegue empurrar a condição para dentro do índice e toda tecla passava
  -- a varrer a matview inteira (130 ms medidos). Separados, cada um usa o
  -- índice que lhe cabe e a busca volta para a casa dos milissegundos.
  if length(t) < 3 then
    -- Duas letras: só começo de palavra. Trigrama precisa de três caracteres,
    -- e "di" no meio de um nome é ruído — ninguém digita duas letras
    -- procurando o miolo de uma palavra.
    return query
      select c.ggrem, c.id_apresentacao, c.nome_comercial, c.nome_generico,
             c.principio_ativo, c.principio_base, c.concentracao,
             c.forma_farmaceutica, c.via_administracao, c.via_definida,
             c.injetavel_sem_via, c.tipo_medicamento, c.laboratorio,
             c.registro_anvisa, c.classe_terapeutica, c.comercializado,
             c.quantas_apresentacoes,
             (case when c.nome_comercial_norm like t || '%' then 1
                   when c.principio_norm      like t || '%' then 2
                   else 3 end)::integer
        from public.medicamentos_clinicos c
       where (c.nome_comercial_norm   like t || '%'
              or c.principio_norm     like t || '%'
              or c.nome_generico_norm like t || '%')
         and (p_tipo is null or p_tipo = '' or c.tipo_medicamento = p_tipo)
         and (not p_so_comercializados or c.comercializado)
       order by 18,
                c.comercializado desc,
                case c.tipo_medicamento when 'referencia' then 1 when 'generico' then 2
                                        when 'similar' then 3 else 4 end,
                length(c.nome_comercial), c.nome_comercial, c.concentracao
       limit lim;
  else
    return query
      select c.ggrem, c.id_apresentacao, c.nome_comercial, c.nome_generico,
             c.principio_ativo, c.principio_base, c.concentracao,
             c.forma_farmaceutica, c.via_administracao, c.via_definida,
             c.injetavel_sem_via, c.tipo_medicamento, c.laboratorio,
             c.registro_anvisa, c.classe_terapeutica, c.comercializado,
             c.quantas_apresentacoes,
             (case
                when c.nome_comercial_norm like t || '%' then 1
                when c.principio_norm      like t || '%' then 2
                when c.nome_generico_norm  like t || '%' then 3
                when c.busca_norm          like '%' || t || '%' then 4
                else 5
              end)::integer
        from public.medicamentos_clinicos c
        -- Contido resolve o caso normal; o trigrama é só a tolerância a erro de
        -- digitação ("xareuto" -> Xarelto), comparada com o NOME e com o
        -- PRINCÍPIO e nunca com a frase inteira: diluído em "xarelto
        -- rivaroxabana", erro nenhum passa do limiar de semelhança e a
        -- tolerância não existiria na prática.
       where (c.busca_norm like '%' || t || '%'
              or c.nome_comercial_norm % t
              or c.principio_norm % t)
         and (p_tipo is null or p_tipo = '' or c.tipo_medicamento = p_tipo)
         and (not p_so_comercializados or c.comercializado)
       order by 18,
                -- comercializado antes de descontinuado: é o que o paciente
                -- acha na farmácia
                c.comercializado desc,
                -- Referência antes de genérico e de similar. Sem isto, pedir
                -- "panto" devolvia dez linhas de pantoprazol genérico e
                -- empurrava PANTOZOL, que é a marca que o paciente diz que
                -- toma, para fora da lista.
                case c.tipo_medicamento when 'referencia' then 1 when 'generico' then 2
                                        when 'similar' then 3 else 4 end,
                greatest(similarity(c.nome_comercial_norm, t),
                         similarity(c.principio_norm, t)) desc,
                length(c.nome_comercial), c.nome_comercial, c.concentracao
       limit lim;
  end if;
end;
$fn$;

comment on function public.buscar_medicamentos(text, text, integer, boolean) is
  'Autocomplete de medicamento. Busca simultânea em nome comercial, nome genérico e princípio ativo, sem acento e sem caixa.';

-- Apresentações de um mesmo fármaco (§13): depois de escolher o princípio, a
-- tela oferece SÓ o que existe para ele — o médico não redigita concentração.
drop function if exists public.apresentacoes_do_principio(text, text, integer);
create function public.apresentacoes_do_principio(
  p_principio_base text,
  p_tipo           text    default null,
  p_limite         integer default 100
)
returns table (
  ggrem text, id_apresentacao text, nome_comercial text, principio_ativo text,
  concentracao text, forma_farmaceutica text, via_administracao text,
  via_definida boolean, injetavel_sem_via boolean, tipo_medicamento text,
  laboratorio text, registro_anvisa text, comercializado boolean
)
language sql stable parallel safe
set search_path = public
as $$
  select c.ggrem, c.id_apresentacao, c.nome_comercial, c.principio_ativo,
         c.concentracao, c.forma_farmaceutica, c.via_administracao,
         c.via_definida, c.injetavel_sem_via, c.tipo_medicamento,
         c.laboratorio, c.registro_anvisa, c.comercializado
    from public.medicamentos_clinicos c
    -- Aceita a raiz ('pantoprazol') ou o princípio como escrito na CMED
    -- ('PANTOPRAZOL SÓDICO SESQUI-HIDRATADO'): quem chama não deveria ter de
    -- saber qual das duas formas tem em mãos.
   where (c.principio_base    = public.med_normalizar(p_principio_base)
          or c.principio_norm = public.med_normalizar(p_principio_base))
     and (p_tipo is null or p_tipo = '' or c.tipo_medicamento = p_tipo)
   order by c.comercializado desc,
            -- referência primeiro, depois genérico, depois similar
            case c.tipo_medicamento when 'referencia' then 1 when 'generico' then 2
                                    when 'similar' then 3 else 4 end,
            c.forma_farmaceutica, c.concentracao, c.nome_comercial
   limit greatest(1, least(coalesce(p_limite, 100), 500));
$$;

comment on function public.apresentacoes_do_principio(text, text, integer) is
  'Apresentações existentes de um princípio ativo, referência antes de genérico e similar.';

-- O importador precisa atualizar o agrupamento clínico depois de gravar; sem
-- isto a busca continuaria respondendo a base ANTERIOR, porque a matview não é
-- uma consulta ao vivo. É SECURITY DEFINER de propósito e só o papel de
-- serviço executa: é manutenção da base oficial, não coisa de usuário.
create or replace function public.refresh_medicamentos_clinicos()
  returns void language plpgsql security definer
  set search_path = public as
$$ begin refresh materialized view public.medicamentos_clinicos; end $$;

revoke all on function public.refresh_medicamentos_clinicos() from public;
do $r$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.refresh_medicamentos_clinicos() to service_role';
  end if;
end $r$;

-- -----------------------------------------------------------------------------
-- REGRAS ANESTÉSICAS — arquitetura preparada, sem conteúdo clínico
-- Presas ao PRINCÍPIO ATIVO (§21). Uma regra de rivaroxabana vale para Xarelto
-- e para todos os genéricos e similares, sem recadastrar marca por marca.
-- Esta migração NÃO insere regra nenhuma: regra clínica entra revisada, pelo
-- médico, e não vem de palpite de importação.
-- -----------------------------------------------------------------------------
create table if not exists public.medicamentos_regras_anestesicas (
  id                    uuid primary key default gen_random_uuid(),
  principio_base        text not null,
  categoria             text not null default '',
  impacto_anestesico    text not null default '',
  orientacao_suspensao  text not null default '',
  dias_suspensao        text not null default '',
  orientacao_reinicio   text not null default '',
  alerta                text not null default '',
  gravidade             text not null default 'informativo',   -- informativo | atencao | critico
  fonte                 text not null default '',
  ultima_revisao        date,
  revisado_por          text not null default '',
  ativo                 boolean not null default true,
  organization_id       uuid,      -- null = regra global; preenchida = regra da clínica
  criado_em             timestamptz not null default now(),
  atualizado_em         timestamptz not null default now(),
  unique (principio_base, organization_id, categoria)
);

comment on table public.medicamentos_regras_anestesicas is
  'Conduta peri-operatória por princípio ativo. Vazia de propósito: conteúdo clínico entra revisado, não por importação.';
comment on column public.medicamentos_regras_anestesicas.principio_base is
  'Casa com medicamentos.principio_base. Nunca com nome comercial — senão a mesma regra teria de ser repetida para cada marca.';

create index if not exists idx_medregra_base on public.medicamentos_regras_anestesicas (principio_base) where ativo;
create index if not exists idx_medregra_org  on public.medicamentos_regras_anestesicas (organization_id) where ativo;

-- -----------------------------------------------------------------------------
-- AUDITORIA DA BASE — que versão da Anvisa está carregada
-- -----------------------------------------------------------------------------
create table if not exists public.medicamentos_base_versao (
  id                    uuid primary key default gen_random_uuid(),
  fonte                 text not null,
  versao                text not null,
  data_base             date,
  quantidade_registros  integer not null default 0,
  arquivo_origem        text not null default '',
  novos                 integer,
  atualizados           integer,
  ignorados             integer,
  erros                 integer,
  importado_em          timestamptz not null default now(),
  importado_por         text not null default '',
  observacoes           text not null default '',
  unique (fonte, versao)
);

comment on table public.medicamentos_base_versao is
  'Qual base oficial está carregada e quando entrou. Sem isto não há como responder "esta prescrição foi feita sobre que versão da Anvisa?".';

-- -----------------------------------------------------------------------------
-- RLS
-- A base é a mesma para todo mundo: quem está autenticado lê; ninguém escreve
-- pelo app. Quem atualiza a base oficial é o importador, com a chave de
-- serviço — não um usuário comum, nem por engano.
-- -----------------------------------------------------------------------------
alter table public.medicamentos                    enable row level security;
alter table public.medicamentos_regras_anestesicas enable row level security;
alter table public.medicamentos_base_versao        enable row level security;

drop policy if exists medicamentos_sel on public.medicamentos;
create policy medicamentos_sel on public.medicamentos for select to authenticated using (true);

drop policy if exists medicamentos_sel_anon on public.medicamentos;
create policy medicamentos_sel_anon on public.medicamentos for select to anon using (true);

drop policy if exists medregras_sel on public.medicamentos_regras_anestesicas;
create policy medregras_sel on public.medicamentos_regras_anestesicas for select
  to authenticated using (
    ativo and (
      organization_id is null
      or exists (select 1 from public.organization_users ou
                  where ou.user_id = auth.uid()
                    and ou.organization_id = medicamentos_regras_anestesicas.organization_id
                    and ou.ativo)
    )
  );

-- A clínica pode manter as SUAS regras (nunca as globais).
drop policy if exists medregras_ins on public.medicamentos_regras_anestesicas;
create policy medregras_ins on public.medicamentos_regras_anestesicas for insert
  to authenticated with check (
    organization_id is not null
    and exists (select 1 from public.organization_users ou
                 where ou.user_id = auth.uid()
                   and ou.organization_id = medicamentos_regras_anestesicas.organization_id
                   and ou.ativo and ou.role in ('gestor', 'anestesiologista'))
  );

drop policy if exists medregras_upd on public.medicamentos_regras_anestesicas;
create policy medregras_upd on public.medicamentos_regras_anestesicas for update
  to authenticated using (
    organization_id is not null
    and exists (select 1 from public.organization_users ou
                 where ou.user_id = auth.uid()
                   and ou.organization_id = medicamentos_regras_anestesicas.organization_id
                   and ou.ativo and ou.role in ('gestor', 'anestesiologista'))
  );

drop policy if exists medversao_sel on public.medicamentos_base_versao;
create policy medversao_sel on public.medicamentos_base_versao for select to authenticated using (true);

do $grants$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant select on public.medicamentos to authenticated';
    execute 'grant select on public.medicamentos_clinicos to authenticated';
    execute 'grant select on public.medicamentos_regras_anestesicas to authenticated';
    execute 'grant insert, update on public.medicamentos_regras_anestesicas to authenticated';
    execute 'grant select on public.medicamentos_base_versao to authenticated';
    execute 'grant execute on function public.buscar_medicamentos(text, text, integer, boolean) to authenticated';
    execute 'grant execute on function public.apresentacoes_do_principio(text, text, integer) to authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    -- o app pode consultar a base antes do login (a prescrição abre sem sessão)
    execute 'grant select on public.medicamentos_clinicos to anon';
    execute 'grant execute on function public.buscar_medicamentos(text, text, integer, boolean) to anon';
    execute 'grant execute on function public.apresentacoes_do_principio(text, text, integer) to anon';
  end if;
end $grants$;

commit;

-- Depois do seed, atualize o agrupamento clínico:
--   refresh materialized view public.medicamentos_clinicos;
