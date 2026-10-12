import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const LOCAL_APP_SCRIPT = /^src\//;
const SCRIPT_TAG = /<script\b[^>]*\bsrc=(['"])([^'"]+)\1[^>]*>\s*<\/script>/gi;

/**
 * Recompõe, somente para inspeção estática, os scripts próprios no ponto em
 * que o navegador os executa. Assim os testes de contrato continuam seguindo
 * as fronteiras de segurança quando uma implementação sai do HTML.
 */
export async function readAppSource(appRoot) {
  const html = await readFile(resolve(appRoot, 'index.html'), 'utf8');
  let source = '';
  let cursor = 0;

  for (const match of html.matchAll(SCRIPT_TAG)) {
    source += html.slice(cursor, match.index);
    const relativePath = match[2];
    if (LOCAL_APP_SCRIPT.test(relativePath)) {
      const script = await readFile(resolve(appRoot, relativePath), 'utf8');
      source += `<script>\n/* app-source:${relativePath} */\n${script}\n</script>`;
    } else {
      source += match[0];
    }
    cursor = match.index + match[0].length;
  }

  return source + html.slice(cursor);
}

/** Recompose only extracted monolith fragments while retaining explicit module references. */
export async function readRuntimeComposition(appRoot) {
  const html = await readFile(resolve(appRoot, 'index.html'), 'utf8');
  let result = '', cursor = 0;
  for (const match of html.matchAll(SCRIPT_TAG)) {
    result += html.slice(cursor, match.index);
    if (/^src\/app\/runtime-\d+\.js$/.test(match[2])) {
      result += `<script>${await readFile(resolve(appRoot, match[2]), 'utf8')}</script>`;
    } else result += match[0];
    cursor = match.index + match[0].length;
  }
  return result + html.slice(cursor);
}

/** Load the production parameter encoder for isolated VM tests of compiled views. */
export async function readCompiledActions(appRoot) {
  let registry;
  try { registry = await readFile(resolve(appRoot, 'src/ui/strict-actions.generated.js'), 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
  const runtime = await readFile(resolve(appRoot, 'src/ui/strict-actions.js'), 'utf8');
  const document = { nodeType:9, addEventListener() {} };
  class Element {}
  class ShadowRoot {}
  class MutationObserver { observe() {} }
  const context = vm.createContext({window:{},document,Element,ShadowRoot,MutationObserver});
  vm.runInContext(runtime,context,{filename:'strict-actions.js'});
  context.SoftActions = context.window.SoftActions;
  vm.runInContext(registry,context,{filename:'strict-actions.generated.js'});
  return context.SoftActions;
}
