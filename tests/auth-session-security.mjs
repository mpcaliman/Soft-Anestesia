/** Regressões A2–A4: identidade única, sessão por aba e dependência segura. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readAppSource } from './helpers/read-app-source.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const rootArg = process.argv.find(arg => arg.startsWith('--app-root='));
const root = rootArg ? resolve(process.cwd(), rootArg.slice('--app-root='.length)) : resolve(here, '..');
const source = await readAppSource(root);
const vendor = await readFile(resolve(root, 'vendor/jspdf.umd.min.js'), 'utf8');

const between = (start, end) => {
  const a = source.indexOf(start);
  const b = source.indexOf(end, a + start.length);
  assert.notEqual(a, -1, `início não encontrado: ${start}`);
  assert.notEqual(b, -1, `fim não encontrado: ${end}`);
  return source.slice(a, b);
};

const login = between('  async tentarLoginNuvem() {', '  async _garantirNuvemDaConta');
assert.doesNotMatch(login, /_lerUsuarios\(\).*senhaHash|auth\._hash|desbloqueio offline/i,
  'login principal não pode autenticar por verificador local');
assert.match(login, /cloud\.login\(id, senha\)/, 'Supabase deve autenticar a entrada');
assert.match(login, /Sem internet não é possível iniciar uma nova sessão/,
  'nova sessão offline deve ser bloqueada');

const mirror = between('  async _espelharUsuarioNuvem(', '  /* O e-mail é o do programador?');
assert.match(mirror, /_espelharUsuarioNuvem\(email, perfilNuvem\)/,
  'espelho deve receber somente identidade e perfil');
assert.doesNotMatch(mirror, /senhaHash\s*:|senhaKdf\s*:|passwordHash\s*:/,
  'espelho não pode persistir verificador de senha');
assert.match(source, /delete limpo\.senhaHash/, 'credenciais legadas devem ser removidas');
assert.match(source, /delete limpo\.senhaKdf/, 'KDF legado deve ser removido');

const cloudSession = between('  session() {', '  estaLogado() {');
assert.doesNotMatch(cloudSession, /\|\|\s*localStorage\.getItem\(cloud\.SESSION_KEY\)/,
  'modo compartilhado não pode cair em token persistente antigo');
const saveCloudSession = between('  _gravarSessao(sess) {', '\n\n  session() {');
assert.doesNotMatch(saveCloudSession, /localStorage\.setItem\(cloud\.SESSION_KEY/,
  'refresh token nunca pode persistir fora da aba');
assert.match(source, /_refreshPromise/, 'renovação do refresh token deve ser serializada');
const dailyRestore = between('  _restaurarSessaoDiaria() {', '\n  definirTimeout(min) {');
assert.doesNotMatch(dailyRestore, /sessionStorage\.setItem/,
  'marcador diário legado nunca pode autenticar uma nova aba');
assert.match(dailyRestore, /removeItem\(auth\.DIA_KEY\)/,
  'marcador diário legado deve ser removido');
const timeoutUi = between('id="seg-timeout"', '</select>');
assert.doesNotMatch(timeoutUi, /option value="(?:0|-1)"/,
  'bloqueio automático não pode oferecer Nunca nem login diário');
assert.match(mirror, /PERFIS\.sem_clinica[\s\S]*modulos:\s*base\.modulos\.slice\(\)/,
  'conta sem organization_id deve acessar apenas o fluxo de vínculo em Ajustes');

const driveToken = between("  TOKEN_KEY: 'medsys.v7.pdfbk.token'", '  async _obterToken');
assert.match(driveToken, /sessionStorage\.setItem\(pdfBackup\.TOKEN_KEY/,
  'token do Drive deve viver somente na sessão da aba');
assert.doesNotMatch(driveToken, /localStorage\.setItem\(pdfBackup\.TOKEN_KEY/,
  'token do Drive não pode ser persistido entre usuários');

assert.doesNotMatch(source, /armazenadas de forma criptografada.*conformidade com/i,
  'interface não pode alegar criptografia/LGPD sem comprovação');
assert.match(source, /src="vendor\/jspdf\.umd\.min\.js"/,
  'jsPDF deve ser dependência versionada, não bundle antigo embutido');
assert.doesNotMatch(source, /Version 2\.5\.1/, 'jsPDF 2.5.1 não pode permanecer no app');
assert.match(vendor.slice(0, 500), /Version 4\.2\.1/, 'vendor deve ser jsPDF 4.2.1');

console.log('  ✓ A2–A4: senha não espelhada, sessão por aba e jsPDF corrigido');
