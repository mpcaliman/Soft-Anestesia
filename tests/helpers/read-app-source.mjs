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
      source += `\n/* app-source:${relativePath} */\n${script}\n`;
    } else {
      source += match[0];
    }
    cursor = match.index + match[0].length;
  }

  return source + html.slice(cursor);
}
