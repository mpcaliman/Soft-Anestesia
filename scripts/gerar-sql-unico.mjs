#!/usr/bin/env node
/* ============================================================================
   Soft Anestesia — gera UM arquivo SQL só, para rodar de uma vez
   ----------------------------------------------------------------------------
   Junta num arquivo: a migração 0014 (estrutura, índices, funções, RLS), as
   26.001 apresentações da Anvisa/CMED, o refresh do agrupamento clínico e o
   registro de auditoria da versão da base. Roda inteiro numa transação: ou
   entra tudo, ou não entra nada.

   POR QUE COM DICIONÁRIO
   Em SQL cru, os mesmos textos se repetem 26 mil vezes: a URL da fonte oficial
   é idêntica em todas as linhas (2 MB só dela), a classe terapêutica tem 541
   valores distintos, o laboratório 258, a forma farmacêutica 56. Escrever isso
   linha a linha dá 12,8 MB — grande demais para colar num editor de SQL.
   Aqui cada texto repetido aparece UMA vez, numa tabela temporária, e as
   linhas guardam o índice. O banco recompõe tudo no insert final.

   USO
     node scripts/gerar-sql-unico.mjs <arquivo.csv|.xlsx> [--versao 2026-08-11]
============================================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { lerBase } from './anvisa/ler-base.mjs';
import { registroDeLinha } from './anvisa/normalizar.mjs';

const args = process.argv.slice(2);
const arquivo = args.find(a => !a.startsWith('--'));
const versao = (args.includes('--versao') ? args[args.indexOf('--versao') + 1] : '') || '2026-08-11';
if (!arquivo) {
  console.error('uso: node scripts/gerar-sql-unico.mjs <arquivo.csv|.xlsx> [--versao AAAA-MM-DD]');
  process.exit(2);
}

const raiz = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const migracao = fs.readFileSync(path.join(raiz, 'database', 'migrations', '0014_medicamentos_anvisa.sql'), 'utf8');

const linhas = lerBase(arquivo);
const registros = [];
for (const l of linhas) {
  const r = registroDeLinha(l);
  if (!r.ggrem) continue;
  if (!r.nome_comercial && !r.principio_ativo) continue;
  registros.push(r);
}
/* GGREM repetido no arquivo faria o upsert falhar inteiro ("cannot affect row
   a second time"): fica o último. */
const porChave = new Map();
registros.forEach(r => porChave.set(r.ggrem, r));
const dados = [...porChave.values()];

const q = s => "'" + String(s == null ? '' : s).replace(/'/g, "''") + "'";

/* --- dicionários dos campos que se repetem -------------------------------- */
const DICS = ['nome', 'generico', 'principio', 'base', 'conc', 'forma', 'via',
              'origem', 'apres', 'lab', 'tipo', 'entrada', 'classe', 'regime', 'fonte'];
const dic = {}, mapa = {};
DICS.forEach(d => { dic[d] = []; mapa[d] = new Map(); });
const ix = (d, v) => {
  const s = v == null ? '' : String(v);
  if (mapa[d].has(s)) return mapa[d].get(s);
  const i = dic[d].length;
  dic[d].push(s); mapa[d].set(s, i);
  return i;
};

const linhasDados = dados.map(r => {
  /* registro_anvisa e id_apresentacao são o mesmo número nesta base (conferido
     registro a registro): vai um campo só, e o insert duplica. */
  const vias = "'{" + r.vias.join(',') + "}'";
  return '(' + [
    q(r.ggrem),
    q(r.id_apresentacao),
    ix('nome', r.nome_comercial),
    ix('generico', r.nome_generico),
    ix('principio', r.principio_ativo),
    ix('base', r.principio_base),
    ix('conc', r.concentracao),
    ix('forma', r.forma_farmaceutica),
    ix('via', r.via_administracao),
    vias,
    r.via_definida ? 'true' : 'false',
    r.injetavel_sem_via ? 'true' : 'false',
    ix('origem', r.origem_via),
    ix('apres', r.apresentacao_original_anvisa),
    ix('lab', r.laboratorio),
    ix('tipo', r.tipo_medicamento),
    ix('entrada', r.tipo_entrada),
    q(r.registro_anvisa),
    q(r.ean), q(r.ean2), q(r.ean3),
    ix('classe', r.classe_terapeutica),
    ix('regime', r.regime_preco),
    r.comercializado ? 'true' : 'false',
    ix('fonte', r.fonte)
  ].join(',') + ')';
});

/* --- monta o arquivo ------------------------------------------------------ */
const dicSQL = DICS.map(d =>
  'insert into _dic values ' +
  dic[d].map((v, i) => "(" + q(d) + "," + i + "," + q(v) + ")").join(',') + ';'
).join('\n');

const LOTE = 1000;
let insercoes = '';
for (let i = 0; i < linhasDados.length; i += LOTE) {
  insercoes += 'insert into _med values\n' + linhasDados.slice(i, i + LOTE).join(',\n') + ';\n';
}

const cabecalho = `-- =============================================================================
-- Soft Anestesia — base de medicamentos Anvisa/CMED — ARQUIVO ÚNICO
-- =============================================================================
-- GERADO POR scripts/gerar-sql-unico.mjs — não editar à mão.
-- Fonte: Anvisa/CMED, base de ${versao}. ${dados.length} apresentações.
--
-- COMO RODAR
--   Cole no SQL Editor do Supabase e execute UMA vez. Faz tudo:
--     1. cria a estrutura (tabelas, índices, funções de busca, RLS);
--     2. carrega as ${dados.length} apresentações;
--     3. atualiza o agrupamento clínico;
--     4. registra qual versão da base entrou.
--
--   Roda inteiro numa transação: ou entra tudo, ou não entra nada. E pode ser
--   reexecutado à vontade — o carregamento é upsert por GGREM, então rodar de
--   novo atualiza o que mudou em vez de duplicar.
--
-- SOBRE O TAMANHO
--   Os textos que se repetem (a URL da fonte é idêntica nas 26 mil linhas, a
--   classe terapêutica tem 541 valores distintos, o laboratório 258) aparecem
--   UMA vez, numa tabela temporária, e as linhas guardam o índice. Sem isso o
--   arquivo teria 12,8 MB em vez destes poucos megabytes.
--
-- O QUE ESTA BASE NÃO É
--   Não é tabela de preço: a CMED publica preço máximo e nada disso é
--   importado. Não é fonte de posologia: dose, frequência e duração continuam
--   sendo decisão médica.
-- =============================================================================

`;

const parte2 = `

-- =============================================================================
-- PARTE 2 — OS DADOS
-- =============================================================================
begin;

-- Dicionário dos textos repetidos. Temporário: some sozinho ao fim da sessão.
create temp table _dic (campo text, i int, v text, primary key (campo, i)) on commit drop;

${dicSQL}

create temp table _med (
  ggrem text, idap text, i_nome int, i_generico int, i_principio int, i_base int,
  i_conc int, i_forma int, i_via int, vias text[], via_def boolean, inj_sem_via boolean,
  i_origem int, i_apres int, i_lab int, i_tipo int, i_entrada int,
  registro text, ean text, ean2 text, ean3 text,
  i_classe int, i_regime int, comercializado boolean, i_fonte int
) on commit drop;

${insercoes}
-- Recompõe e grava. Upsert por GGREM: reexecutar atualiza, nunca duplica.
insert into public.medicamentos (
  ggrem, id_apresentacao, nome_comercial, nome_generico, principio_ativo,
  principio_base, concentracao, forma_farmaceutica, via_administracao, vias,
  via_definida, injetavel_sem_via, origem_via, apresentacao_original_anvisa,
  laboratorio, tipo_medicamento, tipo_entrada, registro_anvisa, ean, ean2, ean3,
  classe_terapeutica, regime_preco, comercializado, fonte
)
select
  m.ggrem, m.idap,
  dn.v, dg.v, dp.v, db.v, dc.v, df.v, dv.v, m.vias,
  m.via_def, m.inj_sem_via, do_.v, da.v, dl.v, dt.v, de.v,
  m.registro, m.ean, m.ean2, m.ean3, dk.v, dr.v, m.comercializado, dfo.v
from _med m
  join _dic dn  on dn.campo  = 'nome'      and dn.i  = m.i_nome
  join _dic dg  on dg.campo  = 'generico'  and dg.i  = m.i_generico
  join _dic dp  on dp.campo  = 'principio' and dp.i  = m.i_principio
  join _dic db  on db.campo  = 'base'      and db.i  = m.i_base
  join _dic dc  on dc.campo  = 'conc'      and dc.i  = m.i_conc
  join _dic df  on df.campo  = 'forma'     and df.i  = m.i_forma
  join _dic dv  on dv.campo  = 'via'       and dv.i  = m.i_via
  join _dic do_ on do_.campo = 'origem'    and do_.i = m.i_origem
  join _dic da  on da.campo  = 'apres'     and da.i  = m.i_apres
  join _dic dl  on dl.campo  = 'lab'       and dl.i  = m.i_lab
  join _dic dt  on dt.campo  = 'tipo'      and dt.i  = m.i_tipo
  join _dic de  on de.campo  = 'entrada'   and de.i  = m.i_entrada
  join _dic dk  on dk.campo  = 'classe'    and dk.i  = m.i_classe
  join _dic dr  on dr.campo  = 'regime'    and dr.i  = m.i_regime
  join _dic dfo on dfo.campo = 'fonte'     and dfo.i = m.i_fonte
on conflict (ggrem) do update set
  id_apresentacao = excluded.id_apresentacao,
  nome_comercial = excluded.nome_comercial,
  nome_generico = excluded.nome_generico,
  principio_ativo = excluded.principio_ativo,
  principio_base = excluded.principio_base,
  concentracao = excluded.concentracao,
  forma_farmaceutica = excluded.forma_farmaceutica,
  via_administracao = excluded.via_administracao,
  vias = excluded.vias,
  via_definida = excluded.via_definida,
  injetavel_sem_via = excluded.injetavel_sem_via,
  origem_via = excluded.origem_via,
  apresentacao_original_anvisa = excluded.apresentacao_original_anvisa,
  laboratorio = excluded.laboratorio,
  tipo_medicamento = excluded.tipo_medicamento,
  tipo_entrada = excluded.tipo_entrada,
  registro_anvisa = excluded.registro_anvisa,
  ean = excluded.ean, ean2 = excluded.ean2, ean3 = excluded.ean3,
  classe_terapeutica = excluded.classe_terapeutica,
  regime_preco = excluded.regime_preco,
  comercializado = excluded.comercializado,
  fonte = excluded.fonte,
  atualizado_em = now();

-- Auditoria: que versão da base está carregada (§32).
insert into public.medicamentos_base_versao
  (fonte, versao, data_base, quantidade_registros, arquivo_origem, observacoes)
values
  ('ANVISA / CMED', ${q(versao)}, ${q(versao)}::date, ${dados.length},
   ${q(path.basename(arquivo))},
   'Carga pelo arquivo único. Preços da CMED não são importados: o sistema não cobra por tabela CMED.')
on conflict (fonte, versao) do update set
  quantidade_registros = excluded.quantidade_registros,
  arquivo_origem       = excluded.arquivo_origem,
  importado_em         = now();

commit;

-- =============================================================================
-- PARTE 3 — O AGRUPAMENTO CLÍNICO
-- Fora da transação de propósito: refresh de matview não convive com o insert
-- no mesmo bloco. Sem isto a busca continuaria respondendo a base anterior.
-- =============================================================================
refresh materialized view public.medicamentos_clinicos;
analyze public.medicamentos;

-- =============================================================================
-- CONFERÊNCIA — o resultado esperado está ao lado de cada número
-- =============================================================================
select
  (select count(*) from public.medicamentos)                     as apresentacoes_cmed,   -- ${dados.length}
  (select count(*) from public.medicamentos_clinicos)            as itens_clinicos,       -- 10898
  (select count(distinct principio_base) from public.medicamentos) as principios_ativos,  -- 2140
  (select versao from public.medicamentos_base_versao
    order by importado_em desc limit 1)                          as versao_carregada;

-- Um teste rápido de que a busca está de pé (deve trazer PANTOZOL primeiro):
select nome_comercial, principio_ativo, concentracao, forma_farmaceutica,
       coalesce(nullif(via_administracao, ''), '>> via a definir <<') as via,
       tipo_medicamento
  from public.buscar_medicamentos('panto', null, 5);
`;

const conteudo = cabecalho +
  '-- =============================================================================\n' +
  '-- PARTE 1 — A ESTRUTURA (migração 0014)\n' +
  '-- =============================================================================\n' +
  migracao + parte2;

const destino = path.join(raiz, 'database', 'medicamentos_anvisa_completo.sql');
fs.writeFileSync(destino, conteudo);

const mb = (conteudo.length / 1e6).toFixed(2);
console.log('Arquivo único → database/medicamentos_anvisa_completo.sql');
console.log('  apresentações .......... ' + dados.length);
console.log('  tamanho ................ ' + mb + ' MB');
DICS.forEach(d => {
  const bruto = dados.length;
  console.log('  dicionário ' + d.padEnd(10) + ' ' + String(dic[d].length).padStart(6) + ' valores distintos (em ' + bruto + ' linhas)');
});
