#!/usr/bin/env node
/* ============================================================================
   Soft Anestesia — a base de medicamentos partida em pedaços coláveis
   ----------------------------------------------------------------------------
   O arquivo único tem 5,4 MB. Não cabe numa mensagem, e o editor de SQL do
   Supabase engasga com ele de uma vez. Aqui o mesmo conteúdo sai em partes
   numeradas, cada uma no tamanho de um "cola e roda".

   POR QUE AS TABELAS DE CARGA SÃO REAIS, E NÃO TEMPORÁRIAS
   Tabela temporária morre no fim da sessão. Como cada parte é uma execução
   separada do editor, uma tabela temporária criada na parte 2 não existiria
   mais na parte 3 — e a carga se perderia no meio. Por isso a carga usa
   tabelas comuns, que a última parte apaga depois de usar.

   ORDEM
     01  estrutura (tabelas, índices, funções de busca, RLS) + tabelas de carga
     02+ dicionário dos textos repetidos
     ..  as apresentações
     NN  monta tudo, atualiza o agrupamento, registra a versão e limpa a carga

   Rodar fora de ordem não estraga nada: a última parte confere se a carga
   está completa antes de gravar, e avisa se faltar pedaço.

   USO
     node scripts/gerar-sql-partes.mjs <arquivo.csv|.xlsx> [--versao AAAA-MM-DD] [--kb 700]
============================================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { lerBase } from './anvisa/ler-base.mjs';
import { registroDeLinha, norm } from './anvisa/normalizar.mjs';

const args = process.argv.slice(2);
const arquivo = args.find(a => !a.startsWith('--'));
const versao = (args.includes('--versao') ? args[args.indexOf('--versao') + 1] : '') || '2026-08-11';
const ALVO_KB = parseInt((args.includes('--kb') ? args[args.indexOf('--kb') + 1] : '700'), 10) || 700;
/* --essencial: carrega só UMA apresentação por item clínico, em vez das 26 mil
   linhas da CMED. O app consulta o agrupamento clínico e nada mais, então a
   busca fica idêntica — e o arquivo cabe num celular. A diferença é de
   rastreabilidade: some o registro por embalagem/EAN, que só interessa a
   auditoria de farmácia. */
const ESSENCIAL = args.includes('--essencial');
if (!arquivo) {
  console.error('uso: node scripts/gerar-sql-partes.mjs <arquivo.csv|.xlsx> [--versao AAAA-MM-DD] [--kb 700]');
  process.exit(2);
}

const raiz = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const migracao = fs.readFileSync(path.join(raiz, 'database', 'migrations', '0014_medicamentos_anvisa.sql'), 'utf8');

const porChave = new Map();
for (const l of lerBase(arquivo)) {
  const r = registroDeLinha(l);
  if (!r.ggrem) continue;
  if (!r.nome_comercial && !r.principio_ativo) continue;
  porChave.set(r.ggrem, r);
}
let dados = [...porChave.values()];
if (ESSENCIAL) {
  const grupos = new Map();
  for (const r of dados) {
    const k = [norm(r.nome_comercial), norm(r.principio_ativo), norm(r.concentracao),
               norm(r.forma_farmaceutica), norm(r.via_administracao), r.tipo_medicamento].join('|');
    const atual = grupos.get(k);
    /* o representante preferido é um que esteja comercializado */
    if (!atual || (!atual.comercializado && r.comercializado)) grupos.set(k, r);
  }
  dados = [...grupos.values()];
}

const q = s => "'" + String(s == null ? '' : s).replace(/'/g, "''") + "'";

/* --- dicionário ----------------------------------------------------------- */
const DICS = ['nome', 'generico', 'principio', 'base', 'conc', 'forma', 'via',
              'origem', 'apres', 'lab', 'tipo', 'entrada', 'classe', 'regime', 'fonte'];
const dic = {}, mapa = {};
DICS.forEach(d => { dic[d] = []; mapa[d] = new Map(); });
const ix = (d, v) => {
  const s = v == null ? '' : String(v);
  if (mapa[d].has(s)) return mapa[d].get(s);
  const i = dic[d].length; dic[d].push(s); mapa[d].set(s, i); return i;
};

/* registro_anvisa é o mesmo número de id_apresentacao nesta base (conferido
   registro a registro): não vai duas vezes — são 390 KB de dígitos repetidos. */
const linhasDados = dados.map(r => '(' + [
  q(r.ggrem), q(r.id_apresentacao),
  ix('nome', r.nome_comercial), ix('generico', r.nome_generico),
  ix('principio', r.principio_ativo), ix('base', r.principio_base),
  ix('conc', r.concentracao), ix('forma', r.forma_farmaceutica),
  ix('via', r.via_administracao),
  "'{" + r.vias.join(',') + "}'",
  r.via_definida ? 'true' : 'false',
  r.injetavel_sem_via ? 'true' : 'false',
  ix('origem', r.origem_via),
  /* A embalagem completa da CMED ("CT BL AL PLAS INC X 30") é o maior texto de
     cada linha e serve só a auditoria de farmácia — na versão de celular ela
     fica de fora, e o campo entra vazio. */
  ESSENCIAL ? -1 : ix('apres', r.apresentacao_original_anvisa),
  ix('lab', r.laboratorio), ix('tipo', r.tipo_medicamento),
  ix('entrada', r.tipo_entrada),
  q(r.ean), q(r.ean2), q(r.ean3),
  ix('classe', r.classe_terapeutica), ix('regime', r.regime_preco),
  r.comercializado ? 'true' : 'false',
  ix('fonte', r.fonte)
].join(',') + ')');

/* --- corta uma lista de valores em blocos de ~ALVO_KB ---------------------- */
function blocos(valores, prefixo) {
  const out = [];
  let atual = [], tam = 0;
  const LIM = ALVO_KB * 1024;
  for (const v of valores) {
    if (tam + v.length > LIM && atual.length) {
      out.push(prefixo + '\n' + atual.join(',\n') + ';\n');
      atual = []; tam = 0;
    }
    atual.push(v); tam += v.length + 2;
  }
  if (atual.length) out.push(prefixo + '\n' + atual.join(',\n') + ';\n');
  return out;
}

const valoresDic = [];
DICS.forEach(d => dic[d].forEach((v, i) => valoresDic.push('(' + q(d) + ',' + i + ',' + q(v) + ')')));

const blocosDic = blocos(valoresDic, 'insert into public._carga_dic values');
const blocosMed = blocos(linhasDados, 'insert into public._carga_med values');

/* --- monta as partes ------------------------------------------------------ */
const partes = [];
const TOTAL_PREVISTO = { dic: valoresDic.length, med: linhasDados.length };

partes.push({
  nome: 'estrutura',
  titulo: 'Cria tudo: tabelas, índices, funções de busca, RLS e as tabelas de carga',
  sql: migracao + `

-- =============================================================================
-- TABELAS DE CARGA
-- Comuns, e não temporárias, de propósito: cada parte é uma execução separada
-- do editor, e tabela temporária não sobrevive de uma para a outra. A última
-- parte apaga as duas depois de usar.
-- =============================================================================
drop table if exists public._carga_dic;
drop table if exists public._carga_med;

create table public._carga_dic (campo text, i int, v text, primary key (campo, i));

create table public._carga_med (
  ggrem text primary key, idap text, i_nome int, i_generico int, i_principio int,
  i_base int, i_conc int, i_forma int, i_via int, vias text[],
  via_def boolean, inj_sem_via boolean, i_origem int, i_apres int, i_lab int,
  i_tipo int, i_entrada int, ean text, ean2 text, ean3 text,
  i_classe int, i_regime int, comercializado boolean, i_fonte int
);
`
});

blocosDic.forEach((b, i) => partes.push({
  nome: 'dicionario-' + (i + 1),
  titulo: 'Dicionário dos textos que se repetem — bloco ' + (i + 1) + ' de ' + blocosDic.length,
  sql: b
}));

blocosMed.forEach((b, i) => partes.push({
  nome: 'medicamentos-' + (i + 1),
  titulo: 'As apresentações — bloco ' + (i + 1) + ' de ' + blocosMed.length,
  sql: b
}));

partes.push({
  nome: 'final',
  titulo: 'Monta tudo, atualiza o agrupamento clínico, registra a versão e limpa a carga',
  sql: `-- Confere se a carga chegou inteira ANTES de gravar. Faltando pedaço, para
-- aqui e diz qual — melhor do que carregar uma base pela metade em silêncio.
do $conferir$
declare n_dic int; n_med int;
begin
  select count(*) into n_dic from public._carga_dic;
  select count(*) into n_med from public._carga_med;
  if n_dic <> ${TOTAL_PREVISTO.dic} or n_med <> ${TOTAL_PREVISTO.med} then
    raise exception E'Carga incompleta.\\n  dicionário: % de ${TOTAL_PREVISTO.dic}\\n  apresentações: % de ${TOTAL_PREVISTO.med}\\nRode as partes que faltam e execute esta de novo.', n_dic, n_med;
  end if;
end $conferir$;

begin;

insert into public.medicamentos (
  ggrem, id_apresentacao, nome_comercial, nome_generico, principio_ativo,
  principio_base, concentracao, forma_farmaceutica, via_administracao, vias,
  via_definida, injetavel_sem_via, origem_via, apresentacao_original_anvisa,
  laboratorio, tipo_medicamento, tipo_entrada, registro_anvisa, ean, ean2, ean3,
  classe_terapeutica, regime_preco, comercializado, fonte
)
select
  m.ggrem, m.idap, dn.v, dg.v, dp.v, db.v, dc.v, df.v, dv.v, m.vias,
  m.via_def, m.inj_sem_via, do_.v, coalesce(da.v, ''), dl.v, dt.v, de.v,
  -- registro_anvisa é o mesmo número do id_apresentacao nesta base
  m.idap,
  m.ean, m.ean2, m.ean3, dk.v, dr.v, m.comercializado, dfo.v
from public._carga_med m
  join public._carga_dic dn  on dn.campo  = 'nome'      and dn.i  = m.i_nome
  join public._carga_dic dg  on dg.campo  = 'generico'  and dg.i  = m.i_generico
  join public._carga_dic dp  on dp.campo  = 'principio' and dp.i  = m.i_principio
  join public._carga_dic db  on db.campo  = 'base'      and db.i  = m.i_base
  join public._carga_dic dc  on dc.campo  = 'conc'      and dc.i  = m.i_conc
  join public._carga_dic df  on df.campo  = 'forma'     and df.i  = m.i_forma
  join public._carga_dic dv  on dv.campo  = 'via'       and dv.i  = m.i_via
  join public._carga_dic do_ on do_.campo = 'origem'    and do_.i = m.i_origem
  left join public._carga_dic da on da.campo = 'apres'    and da.i  = m.i_apres
  join public._carga_dic dl  on dl.campo  = 'lab'       and dl.i  = m.i_lab
  join public._carga_dic dt  on dt.campo  = 'tipo'      and dt.i  = m.i_tipo
  join public._carga_dic de  on de.campo  = 'entrada'   and de.i  = m.i_entrada
  join public._carga_dic dk  on dk.campo  = 'classe'    and dk.i  = m.i_classe
  join public._carga_dic dr  on dr.campo  = 'regime'    and dr.i  = m.i_regime
  join public._carga_dic dfo on dfo.campo = 'fonte'     and dfo.i = m.i_fonte
on conflict (ggrem) do update set
  id_apresentacao = excluded.id_apresentacao, nome_comercial = excluded.nome_comercial,
  nome_generico = excluded.nome_generico, principio_ativo = excluded.principio_ativo,
  principio_base = excluded.principio_base, concentracao = excluded.concentracao,
  forma_farmaceutica = excluded.forma_farmaceutica, via_administracao = excluded.via_administracao,
  vias = excluded.vias, via_definida = excluded.via_definida,
  injetavel_sem_via = excluded.injetavel_sem_via, origem_via = excluded.origem_via,
  apresentacao_original_anvisa = excluded.apresentacao_original_anvisa,
  laboratorio = excluded.laboratorio, tipo_medicamento = excluded.tipo_medicamento,
  tipo_entrada = excluded.tipo_entrada, registro_anvisa = excluded.registro_anvisa,
  ean = excluded.ean, ean2 = excluded.ean2, ean3 = excluded.ean3,
  classe_terapeutica = excluded.classe_terapeutica, regime_preco = excluded.regime_preco,
  comercializado = excluded.comercializado, fonte = excluded.fonte,
  atualizado_em = now();

insert into public.medicamentos_base_versao
  (fonte, versao, data_base, quantidade_registros, arquivo_origem, observacoes)
values
  ('ANVISA / CMED', ${q(versao)}, ${q(versao)}::date, ${dados.length},
   ${q(path.basename(arquivo))},
   'Carga em partes pelo editor SQL. Preços da CMED não são importados: o sistema não cobra por tabela CMED.')
on conflict (fonte, versao) do update set
  quantidade_registros = excluded.quantidade_registros,
  arquivo_origem = excluded.arquivo_origem, importado_em = now();

drop table public._carga_dic;
drop table public._carga_med;

commit;

-- Fora da transação: refresh de matview não convive com o insert no mesmo bloco.
refresh materialized view public.medicamentos_clinicos;
analyze public.medicamentos;

-- CONFERÊNCIA — o esperado está ao lado de cada número
select
  (select count(*) from public.medicamentos)                      as apresentacoes,  -- ${dados.length}
  (select count(*) from public.medicamentos_clinicos)             as itens_clinicos, -- 10898
  (select count(distinct principio_base) from public.medicamentos) as principios;     -- 2140

-- Um teste de que a busca está de pé (PANTOZOL tem de vir primeiro):
select nome_comercial, principio_ativo, concentracao,
       coalesce(nullif(via_administracao, ''), '>> via a definir <<') as via,
       tipo_medicamento
  from public.buscar_medicamentos('panto', null, 5);
`
});

/* --- grava ---------------------------------------------------------------- */
const dir = path.join(raiz, 'database', ESSENCIAL ? 'partes-celular' : 'partes');
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });

const N = partes.length;
partes.forEach((p, i) => {
  const n = String(i + 1).padStart(2, '0');
  const cabecalho = `-- =============================================================================
-- Soft Anestesia — base de medicamentos Anvisa/CMED
-- PARTE ${i + 1} DE ${N} — ${p.titulo}
-- =============================================================================
-- Cole no SQL Editor do Supabase e rode. Depois passe para a parte ${i + 2 > N ? '— acabou' : i + 2}.
-- As partes são independentes e podem ser rodadas de novo sem estragar nada.
-- =============================================================================

`;
  fs.writeFileSync(path.join(dir, n + '-' + p.nome + '.sql'), cabecalho + p.sql);
});

console.log('Partes → database/' + (ESSENCIAL ? 'partes-celular' : 'partes') + '/  (' + N + ' arquivos)');
let total = 0;
fs.readdirSync(dir).sort().forEach(f => {
  const kb = fs.statSync(path.join(dir, f)).size / 1024;
  total += kb;
  console.log('  ' + f.padEnd(28) + String(Math.round(kb)).padStart(5) + ' KB');
});
console.log('  ' + 'TOTAL'.padEnd(28) + String(Math.round(total)).padStart(5) + ' KB');
