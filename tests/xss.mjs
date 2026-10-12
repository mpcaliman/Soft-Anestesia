/**
 * Regressões de segurança para valores inseridos em HTML e handlers legados.
 *
 * Este teste não abre navegador nem acessa rede/Supabase. Ele valida que:
 * - atributos HTML usam escaping completo;
 * - argumentos de handlers inline legados fazem round-trip sem virar código;
 * - nenhum handler inline usa escaping de HTML como se fosse escaping de JS;
 * - as ações da lista de pacientes não carregam nomes em JavaScript inline.
 */
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readAppSource } from './helpers/read-app-source.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootArgument = process.argv.find(argument => argument.startsWith('--app-root='));
const appRoot = rootArgument
  ? resolve(process.cwd(), rootArgument.slice('--app-root='.length))
  : resolve(__dirname, '..');
const source = await readAppSource(appRoot);

function extractUtilsEscapers(html) {
  const start = html.indexOf('  escapeHTML(s) {');
  const end = html.indexOf('  formatarData(iso) {', start);
  assert.notEqual(start, -1, 'utils.escapeHTML não encontrado');
  assert.notEqual(end, -1, 'fim dos helpers de escaping não encontrado');
  const methods = html.slice(start, end);
  return Function(`"use strict"; const utils = {${methods}}; return utils;`)();
}

/* Aproxima o parsing de entidades que o navegador faz no valor do atributo
   antes de compilar um onclick. É suficiente para os escapes emitidos pelo app. */
function decodeHtmlAttribute(value) {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

const utils = extractUtilsEscapers(source);
const attrPayload = `&<>'"`;
assert.equal(
  utils.escapeAttr(attrPayload),
  utils.escapeHTML(attrPayload),
  'escapeAttr deve codificar &, <, >, aspas simples e duplas'
);
assert.equal(typeof utils.jsArg, 'function', 'utils.jsArg deve existir para handlers inline legados');

const payloads = [
  `Maria'); globalThis.__softAnestesiaXss = 1; //`,
  `João &quot;); globalThis.__softAnestesiaXss = 2; //`,
  `</button><script>globalThis.__softAnestesiaXss = 3</script>`,
  `linha\u2028separada\u2029fim`,
  `O'Connor & "Filhos" <teste>`
];

for (const payload of payloads) {
  delete globalThis.__softAnestesiaXss;
  let recebido;
  const handlerSource = `capture(${decodeHtmlAttribute(utils.jsArg(payload))});`;
  Function('capture', `"use strict"; ${handlerSource}`)(valor => { recebido = valor; });
  assert.equal(recebido, payload, 'o argumento deve chegar exatamente como foi armazenado');
  assert.equal(globalThis.__softAnestesiaXss, undefined, 'o conteúdo armazenado não pode executar código');
}

const handlerComEscapeErrado = /\bon[a-z]+="[^"\n]*utils\.(?:escapeAttr|escapeHTML)\(/gi;
assert.deepEqual(
  source.match(handlerComEscapeErrado) || [],
  [],
  'handlers inline não podem usar escapeAttr/escapeHTML para formar argumentos JavaScript'
);

const handlerComConcatDeString = /on[a-z]+="[^"\n]*\\'\s*\+/gi;
assert.deepEqual(
  source.match(handlerComConcatDeString) || [],
  [],
  'handlers inline não podem concatenar valores dentro de aspas JavaScript'
);
const handlerTemplateComAspa = /on[a-z]+="[^"\n]*'\$\{(?!utils\.jsArg)/gi;
assert.deepEqual(
  source.match(handlerTemplateComAspa) || [],
  [],
  'templates de handlers não podem interpolar valores crus dentro de aspas JavaScript'
);
assert.doesNotMatch(
  source,
  /setAttribute\(\s*['"]on[a-z]+['"]/i,
  'eventos criados por JavaScript devem usar addEventListener, não atributos on*'
);
assert.doesNotMatch(
  source,
  /\bon[a-z]+="'\s*\+/i,
  'o conteúdo inteiro de um handler não pode vir de um fragmento JavaScript concatenado'
);

assert.match(source, /data-pac-action="historico"/, 'Histórico deve usar ação delegada');
assert.match(source, /data-pac-action="resumo"/, 'Resumo deve usar ação delegada');
const pacientesRenderStart = source.indexOf('    pacientes._encherPlanos();');
const pacientesRenderEnd = source.indexOf('  exportar() {', pacientesRenderStart);
assert.notEqual(pacientesRenderStart, -1, 'render da lista de pacientes não encontrado');
assert.notEqual(pacientesRenderEnd, -1, 'fim do render da lista de pacientes não encontrado');
const pacientesRender = source.slice(pacientesRenderStart, pacientesRenderEnd);
assert.doesNotMatch(
  pacientesRender,
  /onclick="(?:historico\.prontuario|pacientes\.resumo)\(/,
  'nome do paciente não pode aparecer em onclick'
);

let scriptsCompilados = 0;
for (const match of source.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)) {
  scriptsCompilados++;
  assert.doesNotThrow(
    () => Function(match[1]),
    `script inline ${scriptsCompilados} deve continuar com sintaxe JavaScript válida`
  );
}
assert.ok(scriptsCompilados > 0, 'ao menos um script inline deveria ser validado');

console.log('  ✓ Contenção de XSS: escaping, argumentos legados e ações de pacientes');
