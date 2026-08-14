-- =============================================================================
-- Soft Anestesia — Migração 0013: tabela oficial da CBHPM 2022
-- =============================================================================
-- Rode DEPOIS da 0001–0012. Idempotente e aditiva: não altera nem apaga dado
-- nenhum já existente.
--
-- PARA QUE SERVE
--   O aplicativo já traz a CBHPM 2022 embutida (funciona offline, que é o
--   requisito do centro cirúrgico). Esta tabela é a mesma lista no banco, para
--   o que o navegador não faz: conferência em massa, relatório por capítulo/
--   grupo, cruzamento de glosa por código, auditoria de faturamento.
--
--   Ela é REFERÊNCIA, não preço. porte_medico, porte_anestesico e o custo
--   operacional (UCO) são classificação da CBHPM. A precificação continua onde
--   sempre esteve: na configuração do próprio sistema. Nada aqui redefine
--   valor cobrado.
--
-- COMO CARREGAR OS DADOS
--   Esta migração cria a estrutura vazia. Os 5.219 códigos vêm do arquivo
--   database/seeds/cbhpm_2022.sql — rode-o depois desta migração (ele é um
--   insert ... on conflict do update, então pode ser reexecutado à vontade).
--
-- COMO DESFAZER
--   drop table if exists public.cbhpm_codigos;
--   (nenhuma outra tabela depende dela — o vínculo do financeiro é por código
--    em texto, de propósito, para que registro antigo nunca fique órfão.)
-- =============================================================================

begin;

create table if not exists public.cbhpm_codigos (
  codigo                            text primary key,
  codigo_numerico                   text not null unique,
  descricao                         text not null,
  tipo_registro                     text not null,          -- PROCEDIMENTO | GRUPO | OBSERVACAO | REFERENCIA_*
  selecionavel                      boolean not null default false,
  capitulo                          text,
  grupo                             text,
  grupo_codigo                      text,
  subgrupo                          text,
  subgrupo_codigo                   text,
  porte_medico                      text,
  custo_operacional_uco_raw         text,
  custo_operacional_uco             numeric,
  numero_auxiliares                 smallint,
  porte_anestesico                  smallint,
  filme_documentacao                text,
  ur                                text,
  codigo_anestesico_correspondente  text,
  porte_anestesico_correspondente   smallint,
  regra_anestesia                   text,
  pagina                            integer,
  versao_fonte                      text not null default 'CBHPM 2022 - agosto/2023',
  updated_at                        timestamptz not null default now()
);

comment on table public.cbhpm_codigos is
  'CBHPM 2022 (agosto/2023). Referência de código, descrição e classificação. Não é tabela de preço.';
comment on column public.cbhpm_codigos.selecionavel is
  'Só true pode ser oferecido para escolha. Grupo, observação e referência de texto/TUSS existem para rastreabilidade e nunca são procedimento.';
comment on column public.cbhpm_codigos.porte_anestesico is
  'AN 0–8. AN 0 = anestesia local / sem participação do anestesiologista: não gera honorário anestésico.';
comment on column public.cbhpm_codigos.codigo_anestesico_correspondente is
  'Quando a CBHPM prevê código anestésico próprio para o ato (endoscopia, imagem, radioterapia), é este o que vale para a anestesia.';

create index if not exists idx_cbhpm_descricao_lower on public.cbhpm_codigos (lower(descricao));
create index if not exists idx_cbhpm_codigo_numerico on public.cbhpm_codigos (codigo_numerico);
create index if not exists idx_cbhpm_selecionavel    on public.cbhpm_codigos (selecionavel, tipo_registro);

-- A tabela é a mesma para todo mundo: leitura liberada a quem está autenticado,
-- escrita não (quem atualiza a versão da CBHPM é a migração, não o app).
alter table public.cbhpm_codigos enable row level security;

drop policy if exists cbhpm_sel on public.cbhpm_codigos;
create policy cbhpm_sel on public.cbhpm_codigos for select
  to authenticated using (true);

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant select on public.cbhpm_codigos to authenticated';
  end if;
end $$;

-- Rastreabilidade do financeiro ----------------------------------------------
-- Cada lançamento criado automaticamente carrega, dentro de data:
--   _origemTipo (módulo), _origemId (registro), _origemLinhaId (linha),
--   cbhpm_codigo, cbhpm_versao, quantidade, fracao, valor_base, valor_final,
--   tipo_honorario.
-- O índice abaixo é o que torna barato responder "que linhas vieram deste
-- atendimento?" — a pergunta da conciliação e a que impede linha órfã.
create index if not exists idx_fin_origem
  on public.finance_entries ((data->>'_origemTipo'), (data->>'_origemId'), (data->>'_origemLinhaId'));
create index if not exists idx_fin_cbhpm
  on public.finance_entries ((data->>'cbhpm_codigo'));

commit;
