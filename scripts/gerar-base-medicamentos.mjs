#!/usr/bin/env node
/* ============================================================================
   Soft Anestesia — gera os artefatos da base de medicamentos
   ----------------------------------------------------------------------------
   A partir do arquivo oficial da Anvisa/CMED produz DOIS artefatos, dos mesmos
   dados e da mesma normalização:

     1. database/seeds/medicamentos_anvisa.sql
        as 26 mil apresentações para o Supabase (upsert por GGREM).

     2. medicamentos-base.js
        o índice CLÍNICO AGRUPADO que o navegador usa. É o mesmo conteúdo,
        reduzido ao que diferencia um item para quem prescreve (§24: embalagem,
        quantidade e EAN não entram) e sem os campos que só interessam ao banco.

   POR QUE OS DOIS
   O centro cirúrgico não tem internet garantida. Uma busca de medicamento que
   só funciona online é uma busca que falha na hora em que o anestesista mais
   precisa dela. O Supabase é a fonte oficial e sempre atual; o índice local é
   o que responde quando a rede não responde. Ambos saem do mesmo gerador,
   então não divergem.

   USO
     node scripts/gerar-base-medicamentos.mjs <arquivo.csv|arquivo.xlsx> [--versao 2026-08-11]
============================================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { lerBase } from './anvisa/ler-base.mjs';
import { registroDeLinha, chaveClinica, norm } from './anvisa/normalizar.mjs';

const args = process.argv.slice(2);
const arquivo = args.find(a => !a.startsWith('--'));
const versao = (args.includes('--versao') ? args[args.indexOf('--versao') + 1] : '') || '2026-08-11';
if (!arquivo) {
  console.error('uso: node scripts/gerar-base-medicamentos.mjs <arquivo.csv|.xlsx> [--versao AAAA-MM-DD]');
  process.exit(2);
}

const raiz = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const linhas = lerBase(arquivo);
console.log('Lidas ' + linhas.length + ' linhas de ' + path.basename(arquivo));

const registros = [];
const problemas = [];
for (const l of linhas) {
  const r = registroDeLinha(l);
  if (!r.ggrem) { problemas.push('linha sem código GGREM (é a chave): ' + JSON.stringify(l).slice(0, 120)); continue; }
  if (!r.nome_comercial && !r.principio_ativo) { problemas.push('linha sem nome nem princípio: ' + r.id_apresentacao); continue; }
  registros.push(r);
}

/* ---------------------------------------------------------------------------
   1) SEED SQL — todas as apresentações, como vieram
--------------------------------------------------------------------------- */
/* Campo vazio vira string vazia, NÃO null: as colunas são `not null default ''`
   de propósito — "sem laboratório informado" e "nulo" não são coisas
   diferentes aqui, e null obrigaria todo `like` a tratar o caso à parte. */
const q = s => "'" + String(s == null ? '' : s).replace(/'/g, "''") + "'";
const b = v => v ? 'true' : 'false';

/* GGREM primeiro: é a chave. O "ID apresentação" entra como dado — foi
   conferido que ele repete num par de registros e por isso não serve de PK. */
const colunas = [
  'ggrem', 'id_apresentacao', 'nome_comercial', 'nome_generico', 'principio_ativo', 'principio_base',
  'concentracao', 'forma_farmaceutica', 'via_administracao', 'vias', 'via_definida',
  'injetavel_sem_via', 'origem_via', 'apresentacao_original_anvisa', 'laboratorio',
  'tipo_medicamento', 'tipo_entrada', 'registro_anvisa', 'ean', 'ean2', 'ean3',
  'classe_terapeutica', 'regime_preco', 'comercializado', 'fonte'
];
const valorSQL = (r, c) => {
  if (c === 'vias') return "'{" + r.vias.join(',') + "}'";
  if (c === 'via_definida' || c === 'injetavel_sem_via' || c === 'comercializado') return b(r[c]);
  return q(r[c]);
};

let sql = `-- =============================================================================
-- Soft Anestesia — seed da base de medicamentos Anvisa/CMED
-- GERADO POR scripts/gerar-base-medicamentos.mjs — não editar à mão.
-- Fonte: Anvisa/CMED, base de ${versao}. ${registros.length} apresentações.
-- Rode DEPOIS de migrations/0014_medicamentos_anvisa.sql.
-- Reexecutável: é insert ... on conflict do update por GGREM.
-- =============================================================================
begin;
`;
const LOTE = 500;
for (let i = 0; i < registros.length; i += LOTE) {
  const lote = registros.slice(i, i + LOTE);
  sql += '\ninsert into public.medicamentos (' + colunas.join(', ') + ') values\n';
  sql += lote.map(r => '  (' + colunas.map(c => valorSQL(r, c)).join(',') + ')').join(',\n');
  sql += '\non conflict (ggrem) do update set\n  ' +
    colunas.filter(c => c !== 'ggrem').map(c => c + ' = excluded.' + c).join(',\n  ') +
    ',\n  atualizado_em = now();\n';
}
sql += `
insert into public.medicamentos_base_versao
  (fonte, versao, data_base, quantidade_registros, arquivo_origem, observacoes)
values
  ('ANVISA / CMED', ${q(versao)}, ${q(versao)}::date, ${registros.length},
   ${q(path.basename(arquivo))},
   'Carga pelo seed gerado. Preços da CMED não são importados: o sistema não cobra por tabela CMED.')
on conflict (fonte, versao) do update set
  quantidade_registros = excluded.quantidade_registros,
  arquivo_origem       = excluded.arquivo_origem,
  importado_em         = now();

commit;
`;
const destinoSQL = path.join(raiz, 'database', 'seeds', 'medicamentos_anvisa.sql');
fs.mkdirSync(path.dirname(destinoSQL), { recursive: true });
fs.writeFileSync(destinoSQL, sql);
console.log('SQL   → database/seeds/medicamentos_anvisa.sql  (' + (sql.length / 1e6).toFixed(1) + ' MB)');

/* ---------------------------------------------------------------------------
   2) ÍNDICE LOCAL — agrupamento clínico (§24)
   Guarda o registro/id de UM representante do grupo: é o que liga a escolha
   feita offline ao registro oficial no banco quando a rede voltar.
--------------------------------------------------------------------------- */
const grupos = new Map();
for (const r of registros) {
  const k = chaveClinica(r);
  const g = grupos.get(k);
  if (!g) {
    grupos.set(k, {
      nome: r.nome_comercial,
      principio: r.principio_ativo,
      base: r.principio_base,
      conc: r.concentracao,
      forma: r.forma_farmaceutica,
      via: r.via_administracao,
      vias: r.vias,
      injetavel: r.injetavel_sem_via,
      tipo: r.tipo_medicamento,
      lab: r.laboratorio,
      reg: r.registro_anvisa,
      ggrem: r.ggrem,
      classe: r.classe_terapeutica,
      com: r.comercializado ? 1 : 0,
      n: 1
    });
  } else {
    g.n++;
    /* o representante preferido é um que esteja comercializado */
    if (!g.com && r.comercializado) {
      g.com = 1; g.reg = r.registro_anvisa; g.ggrem = r.ggrem; g.lab = r.laboratorio;
    }
  }
}
const lista = [...grupos.values()].sort((a, b2) =>
  norm(a.principio).localeCompare(norm(b2.principio)) || norm(a.nome).localeCompare(norm(b2.nome)));

/* Codificação por dicionário: forma farmacêutica, via, laboratório, classe e
   concentração se repetem milhares de vezes cada. Guardar o texto em cada
   linha triplicaria o arquivo para não dizer nada de novo — as linhas guardam
   o índice, e o texto aparece uma vez só no dicionário.
   (Registro Anvisa e ID da apresentação são o mesmo número nesta base — foi
    conferido registro a registro; vai um campo só, mais o GGREM, que é a
    chave estável e o que liga a escolha feita offline ao registro do banco.) */
const dic = { conc: [], forma: [], via: [], lab: [], classe: [], tipo: [] };
const mapa = { conc: new Map(), forma: new Map(), via: new Map(), lab: new Map(), classe: new Map(), tipo: new Map() };
const idx = (campo, valor, extra) => {
  const v = valor == null ? '' : String(valor);
  if (mapa[campo].has(v)) return mapa[campo].get(v);
  const i = dic[campo].length;
  dic[campo].push(extra === undefined ? v : [v, extra]);
  mapa[campo].set(v, i);
  return i;
};

const COLS = ['nome', 'principio', 'base', 'conc', 'forma', 'via', 'injetavel',
              'tipo', 'lab', 'registro', 'ggrem', 'classe', 'com'];
const compacto = lista.map(g => [
  g.nome, g.principio,
  g.base === norm(g.principio) ? '' : g.base,      /* só quando difere: economia real */
  idx('conc', g.conc),
  idx('forma', g.forma),
  idx('via', g.via, g.vias.join(',')),             /* rótulo + chaves padronizadas */
  g.injetavel ? 1 : 0,
  idx('tipo', g.tipo),
  idx('lab', g.lab),
  g.reg,
  g.ggrem,
  idx('classe', g.classe),
  g.com
]);

const js = `/* ============================================================================
   Soft Anestesia — índice local de medicamentos (Anvisa/CMED ${versao})
   GERADO POR scripts/gerar-base-medicamentos.mjs — não editar à mão.

   ${lista.length} apresentações clínicas, agrupadas a partir de ${registros.length}
   registros da CMED: embalagem, quantidade de comprimidos e EAN não separam
   itens aqui, porque não separam nada para quem prescreve.

   Este arquivo é o que faz a busca de medicamento funcionar SEM INTERNET. O
   Supabase continua sendo a fonte oficial e é consultado quando há rede; isto
   aqui é o que responde no centro cirúrgico quando não há.

   Vetores posicionais e dicionário, não objetos com texto repetido: nome de
   campo e valor repetido em onze mil registros custariam três vezes o tamanho
   do arquivo sem dizer nada de novo. A ordem das colunas está em
   MED_ANVISA_COLUNAS; os campos numéricos são índices em MED_ANVISA_DIC.
============================================================================ */
window.MED_ANVISA_VERSAO = ${JSON.stringify('ANVISA/CMED ' + versao)};
window.MED_ANVISA_COLUNAS = ${JSON.stringify(COLS)};
window.MED_ANVISA_TOTAL_CMED = ${registros.length};
window.MED_ANVISA_DIC = ${JSON.stringify(dic)};
window.MED_ANVISA_DADOS = ${JSON.stringify(compacto)};
`;
const destinoJS = path.join(raiz, 'medicamentos-base.js');
fs.writeFileSync(destinoJS, js);

console.log('Índice → medicamentos-base.js  (' + (js.length / 1e6).toFixed(2) + ' MB, ' + lista.length + ' apresentações clínicas)');
console.log('');
console.log('  registros CMED lidos ....... ' + linhas.length);
console.log('  registros válidos .......... ' + registros.length);
console.log('  apresentações clínicas ..... ' + lista.length);
console.log('  princípios ativos (raiz) ... ' + new Set(registros.map(r => r.principio_base)).size);
console.log('  nomes comerciais ........... ' + new Set(registros.map(r => norm(r.nome_comercial))).size);
console.log('  sem via determinada ........ ' + registros.filter(r => !r.via_definida).length);
if (problemas.length) {
  console.log('  linhas ignoradas ........... ' + problemas.length);
  problemas.slice(0, 5).forEach(p => console.log('      ' + p));
}
