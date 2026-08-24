#!/usr/bin/env node
/* ============================================================================
   Soft Anestesia — importador da base Anvisa/CMED para o Supabase
   ----------------------------------------------------------------------------
   Carrega (ou ATUALIZA) a tabela public.medicamentos a partir do arquivo
   oficial da CMED, em CSV ou XLSX.

   POR QUE UPSERT E NÃO "APAGA E CARREGA DE NOVO"
   A base da Anvisa é republicada periodicamente. Recarregar do zero mudaria a
   chave de todo registro, e prescrição antiga que aponta para um medicamento
   passaria a apontar para nada. O upsert é por GGREM — o identificador que a
   CMED mantém entre publicações — então o que já existia continua existindo,
   com o mesmo endereço, e só o conteúdo é atualizado.

   (Ainda assim, cada registro clínico guarda uma CÓPIA dos campos do
   medicamento no momento em que foi escolhido. Se a Anvisa retirar uma
   apresentação do ar, a prescrição de dois anos atrás continua legível.)

   USO
     export SUPABASE_URL=https://xxxx.supabase.co
     export SUPABASE_SERVICE_KEY=eyJ...        # chave de SERVIÇO, não a anon
     node scripts/import-anvisa-medications.mjs <arquivo.csv|.xlsx> [opções]

   OPÇÕES
     --versao AAAA-MM-DD   data da base (vai para a auditoria; padrão: hoje)
     --lote N              registros por requisição (padrão 500)
     --dry-run             lê, valida e relata SEM escrever nada
     --so-conferir         compara com o que já está no banco e lista as
                           diferenças, sem gravar

   A chave de serviço é obrigatória para escrever: a RLS da 0014 dá leitura a
   quem está autenticado e escrita a mais ninguém. Um usuário comum não
   consegue — e não deve conseguir — alterar a base oficial.
============================================================================ */
import path from 'node:path';
import { lerBase } from './anvisa/ler-base.mjs';
import { registroDeLinha } from './anvisa/normalizar.mjs';

const args = process.argv.slice(2);
const opcao = (nome, padrao) => {
  const i = args.indexOf('--' + nome);
  return i >= 0 ? (args[i + 1] || padrao) : padrao;
};
const tem = nome => args.includes('--' + nome);

const arquivo = args.find(a => !a.startsWith('--') && !args[args.indexOf(a) - 1]?.startsWith('--'));
const dryRun = tem('dry-run');
const soConferir = tem('so-conferir');
const LOTE = Math.max(1, Math.min(1000, parseInt(opcao('lote', '500'), 10) || 500));
const versao = opcao('versao', new Date().toISOString().slice(0, 10));

if (!arquivo) {
  console.error('uso: node scripts/import-anvisa-medications.mjs <arquivo.csv|.xlsx> [--versao AAAA-MM-DD] [--lote N] [--dry-run] [--so-conferir]');
  process.exit(2);
}

const URL_BASE = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const CHAVE = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const precisaRede = !dryRun;
if (precisaRede && (!URL_BASE || !CHAVE)) {
  console.error('Faltam SUPABASE_URL e SUPABASE_SERVICE_KEY no ambiente.');
  console.error('(--dry-run funciona sem elas: lê, valida e relata sem escrever.)');
  process.exit(2);
}

const cab = {
  'apikey': CHAVE,
  'Authorization': 'Bearer ' + CHAVE,
  'Content-Type': 'application/json'
};

async function rest(caminho, opts = {}) {
  const r = await fetch(URL_BASE + '/rest/v1/' + caminho, { ...opts, headers: { ...cab, ...(opts.headers || {}) } });
  if (!r.ok) {
    const txt = await r.text().catch(() => '');
    throw new Error('HTTP ' + r.status + ' em ' + caminho + ': ' + txt.slice(0, 400));
  }
  return r;
}

/* --------------------------------------------------------------------------
   1) Ler e validar
-------------------------------------------------------------------------- */
console.log('Lendo ' + path.basename(arquivo) + ' …');
let linhas;
try {
  linhas = lerBase(arquivo);
} catch (e) {
  console.error('\nERRO na leitura: ' + e.message);
  process.exit(1);
}
console.log('  ' + linhas.length + ' linhas, colunas conferidas.');

/* --------------------------------------------------------------------------
   2) Normalizar, e detectar duplicidade DENTRO do arquivo
   Duas linhas com o mesmo GGREM no mesmo lote fazem o upsert do Postgres
   falhar inteiro ("cannot affect row a second time"). Melhor descobrir aqui,
   dizendo qual é, do que ver 26 mil registros não entrarem por causa de um.
-------------------------------------------------------------------------- */
const porChave = new Map();
const ignorados = [];
const erros = [];
for (const l of linhas) {
  let r;
  try { r = registroDeLinha(l); }
  catch (e) { erros.push('linha ilegível: ' + e.message); continue; }
  if (!r.ggrem) { ignorados.push('sem GGREM (é a chave): ' + (r.nome_comercial || '?')); continue; }
  if (!r.nome_comercial && !r.principio_ativo) { ignorados.push('sem nome nem princípio: ' + r.ggrem); continue; }
  if (porChave.has(r.ggrem)) {
    ignorados.push('GGREM repetido no arquivo (fica o último): ' + r.ggrem + ' — ' + r.nome_comercial);
  }
  porChave.set(r.ggrem, r);
}
const registros = [...porChave.values()];
console.log('  ' + registros.length + ' registros válidos, ' + ignorados.length + ' ignorados, ' + erros.length + ' com erro.');

/* --------------------------------------------------------------------------
   3) O que já existe no banco (para o relatório dizer novos × atualizados)
-------------------------------------------------------------------------- */
let existentes = new Set();
if (!dryRun) {
  process.stdout.write('Lendo as chaves que já existem no banco … ');
  let de = 0;
  const PAGINA = 1000;
  for (;;) {
    const r = await rest('medicamentos?select=ggrem&order=ggrem.asc', {
      headers: { 'Range-Unit': 'items', 'Range': de + '-' + (de + PAGINA - 1) }
    });
    const lote = await r.json();
    lote.forEach(x => existentes.add(x.ggrem));
    if (lote.length < PAGINA) break;
    de += PAGINA;
  }
  console.log(existentes.size + '.');
}

const novos = registros.filter(r => !existentes.has(r.ggrem)).length;
const atualizados = registros.length - novos;

if (soConferir) {
  const sumindo = [...existentes].filter(k => !porChave.has(k));
  console.log('\n=== CONFERÊNCIA (nada foi gravado) ===');
  console.log('  entrariam como novos ....... ' + novos);
  console.log('  seriam atualizados ......... ' + atualizados);
  console.log('  estão no banco e não no arquivo: ' + sumindo.length);
  if (sumindo.length) {
    console.log('    (o importador NÃO apaga: apresentação retirada do ar continua');
    console.log('     no banco, senão prescrição antiga perderia a referência.');
    console.log('     Para escondê-la da busca, marque ativo = false.)');
    sumindo.slice(0, 10).forEach(k => console.log('      ' + k));
  }
  process.exit(0);
}

/* --------------------------------------------------------------------------
   4) Gravar
-------------------------------------------------------------------------- */
const CAMPOS = [
  'ggrem', 'id_apresentacao', 'nome_comercial', 'nome_generico', 'principio_ativo',
  'principio_base', 'concentracao', 'forma_farmaceutica', 'via_administracao',
  'vias', 'via_definida', 'injetavel_sem_via', 'origem_via',
  'apresentacao_original_anvisa', 'laboratorio', 'tipo_medicamento', 'tipo_entrada',
  'registro_anvisa', 'ean', 'ean2', 'ean3', 'classe_terapeutica', 'regime_preco',
  'comercializado', 'fonte'
];
const paraBanco = r => {
  const o = {};
  CAMPOS.forEach(c => { o[c] = r[c]; });
  o.atualizado_em = new Date().toISOString();
  return o;
};

if (dryRun) {
  console.log('\n=== DRY-RUN (nada foi gravado) ===');
  console.log('  registros processados ...... ' + linhas.length);
  console.log('  válidos .................... ' + registros.length);
  console.log('  ignorados .................. ' + ignorados.length);
  console.log('  erros ...................... ' + erros.length);
  ignorados.slice(0, 5).forEach(x => console.log('      ignorado: ' + x));
  erros.slice(0, 5).forEach(x => console.log('      erro: ' + x));
  console.log('\n  amostra do primeiro registro:');
  console.log(JSON.stringify(paraBanco(registros[0]), null, 2).split('\n').map(l => '    ' + l).join('\n'));
  process.exit(0);
}

let gravados = 0;
const falhas = [];
for (let i = 0; i < registros.length; i += LOTE) {
  const lote = registros.slice(i, i + LOTE).map(paraBanco);
  try {
    await rest('medicamentos?on_conflict=ggrem', {
      method: 'POST',
      headers: { 'Prefer': 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(lote)
    });
    gravados += lote.length;
  } catch (e) {
    falhas.push('lote ' + (i / LOTE + 1) + ': ' + e.message);
  }
  const pct = Math.round(Math.min(i + LOTE, registros.length) / registros.length * 100);
  process.stdout.write('\r  gravando … ' + pct + '%  (' + gravados + '/' + registros.length + ')');
}
console.log('');

/* Sem este refresh a busca continua respondendo a base ANTERIOR — o
   agrupamento clínico é uma matview, não uma consulta ao vivo. */
process.stdout.write('Atualizando o agrupamento clínico … ');
try {
  await rest('rpc/refresh_medicamentos_clinicos', { method: 'POST', body: '{}' });
  console.log('ok.');
} catch (e) {
  console.log('não foi.');
  console.log('  Rode no editor SQL do Supabase:');
  console.log('    refresh materialized view public.medicamentos_clinicos;');
}

/* Auditoria (§32) */
try {
  await rest('medicamentos_base_versao?on_conflict=fonte,versao', {
    method: 'POST',
    headers: { 'Prefer': 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify([{
      fonte: 'ANVISA / CMED',
      versao: versao,
      data_base: /^\d{4}-\d{2}-\d{2}$/.test(versao) ? versao : null,
      quantidade_registros: registros.length,
      arquivo_origem: path.basename(arquivo),
      novos, atualizados,
      ignorados: ignorados.length,
      erros: erros.length + falhas.length,
      importado_em: new Date().toISOString(),
      importado_por: process.env.USER || '',
      observacoes: 'Importado por scripts/import-anvisa-medications.mjs. Preços da CMED não são importados.'
    }])
  });
} catch (e) {
  console.log('Aviso: não deu para registrar a versão da base — ' + e.message);
}

console.log('');
console.log('=== RELATÓRIO ===');
console.log('  registros processados ...... ' + linhas.length);
console.log('  novos ...................... ' + novos);
console.log('  atualizados ................ ' + atualizados);
console.log('  ignorados .................. ' + ignorados.length);
console.log('  erros ...................... ' + (erros.length + falhas.length));
ignorados.slice(0, 5).forEach(x => console.log('      ignorado: ' + x));
erros.slice(0, 5).forEach(x => console.log('      erro: ' + x));
falhas.forEach(x => console.log('      FALHA: ' + x));
console.log('');
console.log('  Depois de trocar a base, gere também o índice offline:');
console.log('    node scripts/gerar-base-medicamentos.mjs ' + arquivo + ' --versao ' + versao);
console.log('  (senão o app continua buscando na base antiga quando estiver sem rede.)');

process.exit(falhas.length ? 1 : 0);
