/** Regressão C3: anexos são Storage-first, idempotentes e nunca apagam cedo. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readAppSource } from './helpers/read-app-source.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..');
const rootArg = process.argv.find(arg => arg.startsWith('--app-root='));
const appRoot = rootArg ? resolve(process.cwd(), rootArg.slice('--app-root='.length)) : repo;
const source = await readAppSource(appRoot);
const migration = await readFile(resolve(repo, 'database/migrations/0021_safe_attachment_lifecycle.sql'), 'utf8');

const between = (text, start, end) => {
  const a = text.indexOf(start);
  const b = text.indexOf(end, a + start.length);
  assert.notEqual(a, -1, `início não encontrado: ${start}`);
  assert.notEqual(b, -1, `fim não encontrado: ${end}`);
  return text.slice(a, b);
};

// Banco: tenant no primeiro segmento, autor no segundo e nenhum DELETE cliente.
assert.match(migration, /create or replace function app\.attachment_path_owned/i);
assert.match(migration, /split_part\(coalesce\(p_name, ''\), '\/', 2\) = p_user::text/i);
assert.match(migration, /in \('anexos', 'backups-pdf'\)/i,
  'anexos clínicos e PDFs automáticos precisam do mesmo isolamento de caminho');
for (const policy of ['clin_att_sel', 'clin_att_ins', 'clin_att_upd', 'att_sel', 'att_ins']) {
  assert.match(migration, new RegExp(`create policy ${policy}[\\s\\S]*?to authenticated`, 'i'),
    `${policy} precisa declarar o papel authenticated`);
}
const storageUpdate = between(migration, 'create policy clin_att_upd', 'drop policy if exists clin_att_del');
assert.match(storageUpdate, /using\s*\([\s\S]*with check\s*\(/i,
  'upsert no Storage precisa proteger a linha antiga e o novo caminho');
assert.match(migration, /drop policy if exists clin_att_del on storage\.objects/i);
assert.doesNotMatch(migration, /create policy clin_att_del/i,
  'o navegador não pode excluir binário ainda referenciado por outro editor');
assert.match(migration, /alter table public\.attachments force row level security/i);
assert.match(migration, /before insert on public\.attachments[\s\S]*stamp_attachment_metadata/i);
assert.match(migration, /new\.uploaded_by\s*:=\s*v_uid/i);
assert.match(migration, /new\.uploaded_at\s*:=\s*now\(\)/i);
assert.match(migration, /from storage\.objects[\s\S]*bucket_id = 'clinical-attachments'[\s\S]*o\.name = new\.storage_path/i,
  'metadado não pode apontar para um objeto inexistente');
assert.match(migration, /revoke update, delete[\s\S]*public\.attachments from authenticated/i);
assert.match(migration, /grant select, insert on table public\.attachments to authenticated/i,
  'a tabela nova/alterada precisa de grants explícitos da Data API');

const prontuario = between(source, 'const prontuario = {', '\n\nconst pre = {');
assert.match(prontuario, /CAMPOS_ANEXO:\s*\['_docs', '_docs_troca', '_docsOrigem', 'anexos'\]/);
assert.match(prontuario, /crypto\.subtle\.digest\('SHA-256'/,
  'o conteúdo precisa de hash estável para integridade e retentativa');

const upload = between(prontuario, '  async _upload(', '\n\n  async _signedUrl(');
assert.match(upload, /ctx\.organizationId \+ '\/' \+ ctx\.userId \+ '\/' \+ pasta \+ '\/' \+ attachmentId/);
assert.match(upload, /'x-upsert': 'true'/);
assert.doesNotMatch(upload, /Date\.now\(\)/,
  'uma retentativa após resposta perdida precisa usar o mesmo caminho');
assert.ok(upload.indexOf('_contextoAindaAtivo(ctx)') < upload.indexOf('await fetch('));
assert.ok(upload.lastIndexOf('_contextoAindaAtivo(ctx)') > upload.indexOf('await fetch('),
  'troca de usuário/clínica durante o fetch deve invalidar o resultado');

const preparar = between(prontuario, '  async prepararParaNuvem(', '\n\n  sanitizarParaNuvem(');
assert.ok(preparar.indexOf('_persistirEstado(mod, item)') < preparar.indexOf('await prontuario._upload('),
  'a identidade idempotente deve sobreviver antes do primeiro envio');
assert.match(preparar, /anexo fora da clínica atual/);
assert.match(preparar, /anexo sem arquivo local nem referência na nuvem/,
  'o registro pai não pode subir apontando para conteúdo inexistente');
assert.doesNotMatch(prontuario, /\|\| destino\[indice\]/,
  'um upload antigo não pode ser aplicado ao novo arquivo que ocupou o mesmo índice');

const pendentes = between(prontuario, '  async subirPendentes(', '\n\n  _assinaturaLegada(');
assert.doesNotMatch(pendentes, /delete d\.dataurl/,
  'upload do objeto não basta: a cópia offline espera o recibo do registro pai');
const remover = between(prontuario, '  async remover(mod, i)', '\n\n  coletar(mod)');
assert.doesNotMatch(remover, /fetch\(|method:\s*'DELETE'/,
  'remover no formulário apenas desvincula; não destrói o objeto compartilhado');
const visualizar = between(prontuario, '  async ver(mod, i)', '\n\n  async remover(mod, i)');
assert.doesNotMatch(visualizar, /<img src="' \+ (?:url|d\.dataurl) \+ '"/,
  'URL de anexo não pode entrar crua no HTML da visualização');
assert.match(visualizar, /utils\.escapeAttr\(url\)/);
assert.match(visualizar, /utils\.escapeAttr\(d\.dataurl\)/);

const rel = between(source, 'const cloudRel = {', '/* FIM DA PERSISTÊNCIA RELACIONAL */');
const enviar = between(rel, '  async enviarRegistro(', '\n\n  /* ==========================================================================\n     CONFLITOS DURÁVEIS');
assert.ok(enviar.indexOf('prepararParaNuvem') < enviar.indexOf('_gravarAtomico'),
  'binários precisam chegar ao Storage antes do compare-and-swap do registro');
assert.ok(enviar.indexOf('if (res && res.ok)') < enviar.indexOf('confirmarNaNuvem'),
  'a cópia offline só pode sair depois do recibo CAS do registro');
assert.ok(enviar.indexOf("contexto_trocado_apos_confirmacao") < enviar.indexOf('confirmarNaNuvem'),
  'troca de usuário durante o CAS não pode limpar o cache da sessão seguinte');
assert.match(enviar, /registrarAnexos\(mod, item/);

const sanitize = between(rel, '  _dadosParaNuvem(', '\n\n  _versao(');
assert.match(sanitize, /sanitizarParaNuvem/,
  'nenhum caminho secundário pode gravar base64 de anexo no Postgres');
const metadata = between(rel, '  async registrarAnexos(', '\n\n  /* Pull automático');
assert.match(metadata, /prontuario\._anexosDo\(item\)/);
assert.doesNotMatch(metadata, /prontuario\._docs/,
  'metadado deve refletir o registro confirmado, não outro formulário aberto');
assert.match(metadata, /resolution=ignore-duplicates,return=minimal/);

assert.match(source, /d\.storage_path && d\.cloud_confirmed_at && d\.dataurl/g,
  'limpeza local manual também precisa exigir recibo do registro pai');
assert.match(source, /attachment_id:\s*prontuario\._novoId\(\)[\s\S]*categoria:\s*'Comprovante'/,
  'comprovantes financeiros também entram no mesmo ciclo de anexos');
assert.match(source, /uploadCtx = await prontuario\._contextoUpload\(\)[\s\S]*contexto: uploadCtx/,
  'importação longa do Drive não pode trocar de usuário no meio');

const pdfQueue = between(source, 'const pdfFila = {', '\n};\ntry { window.pdfFila = pdfFila; }');
assert.match(pdfQueue, /organizationId:\s*dono\.organizationId/);
assert.match(pdfQueue, /cloudUserId:\s*dono\.cloudUserId/);
assert.match(pdfQueue, /todos\.filter\(x => pdfFila\._mesmoDono/,
  'fila IndexedDB não pode revelar PDF pendente de outra sessão');
assert.match(pdfQueue, /async removerAmbiente\(/,
  'descarte explícito ainda precisa conseguir selecionar a fila externa ao cofre');
assert.match(source, /PDF\(s\) de versão antiga estão bloqueados[\s\S]*classificação manual/,
  'fila legada sem dono deve ser visível como bloqueada, nunca adotada silenciosamente');
const pdfBackup = between(source, 'const pdfBackup = {', '\n\n/* ============================================================================\n   MÓDULO PRINCIPAL — ANESTESIA');
const supabasePdf = between(pdfBackup, '  async enviarSupabase(', '\n\n  /* ======================= GOOGLE DRIVE');
assert.match(supabasePdf, /_contextoUpload\(dono\.organizationId/);
assert.match(supabasePdf, /folder:\s*'backups-pdf'/);
assert.doesNotMatch(supabasePdf, /Date\.now\(\)/,
  'retentativa de PDF também deve convergir para o mesmo objeto');
const sharedCleanup = between(source, '  limparDadosLocais(org) {', '\n\n  /* ---------- troca de ambiente ----------');
assert.doesNotMatch(sharedCleanup, /pdfFila\.removerAmbiente/,
  'logout compartilhado não pode apagar PDF pendente do dono original');
assert.match(sharedCleanup, /pdfsPreservados:\s*true/,
  'fila PDF deve sobreviver até reconexão ou descarte explícito');

const historicoDoc = between(source, '  async _prontVerDoc(mod, id, i)', '\n\n  abrirItem(mod, id)');
assert.doesNotMatch(historicoDoc, /<img src="' \+ (?:url|d\.dataurl) \+ '"/,
  'histórico também precisa escapar a origem de imagens');
const financeiroOrigem = between(source, '  renderDocsOrigem(item)', '\n  async verDocOrigem(i)');
assert.match(financeiroOrigem, /utils\.escapeAttr\(d\.thumb \|\| d\.dataurl\)/,
  'miniatura herdada precisa ser segura ao compor o HTML');
const financeiroVerOrigem = between(source, '  async verDocOrigem(i)', '\n\n  \/\* ---------- LANÇAMENTO RÁPIDO');
assert.doesNotMatch(financeiroVerOrigem, /<img src="' \+ (?:url|d\.dataurl) \+ '"/,
  'visualização financeira também precisa escapar a origem de imagens');

console.log('  ✓ C3: anexos ficam isolados, idempotentes e preservados até o recibo do registro');
