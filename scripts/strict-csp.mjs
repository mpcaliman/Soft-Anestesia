/** Build-time compilation only. Patient values never become JavaScript source. */
import vm from 'node:vm';
const acornModule = { exports: {} };
vm.runInNewContext(process.binding('natives')['internal/deps/acorn/acorn/dist/acorn'],
  { exports: acornModule.exports, module: acornModule });
const acorn = acornModule.exports;
const marker = index => `__SOFT_VALUE_${index}__`;
const markers = /__SOFT_VALUE_(\d+)__/g;
const decode = text => text.replace(/&quot;/g, '"').replace(/&#(?:39|x27);/gi, "'")
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const escape = text => String(text).replace(/&/g, '&amp;').replace(/"/g, '&quot;')
  .replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/'/g, '&#39;');
const actionPattern = /\b(on[a-z]+)\s*=\s*(["'])([\s\S]*?)\2/gi;
const stylePattern = /\bstyle\s*=\s*(["'])([\s\S]*?)\1/gi;
const relevant = text => /\bon[a-z]+\s*=|\bstyle\s*=|<style\b|javascript:/i.test(text);
export const compiledAssetPaths = Object.freeze([
  'src/ui/strict-actions.js', 'src/ui/strict-actions.generated.js',
  ...Array.from({length:16}, (_, index) => `src/app/runtime-${String(index + 1).padStart(2, '0')}.js`),
  'src/styles/app-01.css', 'src/styles/app-02.css', 'src/styles/strict-generated.css'
]);

export function compileStrictAssets(sourceHtml, sources) {
  const actions = [], templates = [], styles = [];
  const events = new Set();
  const styleIds = new Map(), compiledSources = new Map(sources);
  const addStyle = css => {
    if (styleIds.has(css)) return styleIds.get(css);
    const id = `soft-s${styles.length}`;
    styles.push(`.${id}{${decode(css)}}`); styleIds.set(css, id); return id;
  };
  function compileHandler(code, valueExpressions, location) {
    const decoded = decode(code), indices = [...new Set([...decoded.matchAll(markers)].map(match => +match[1]))];
    let ast;
    try { ast = acorn.parse(`function handler(event, data) {${decoded}\n}`, {ecmaVersion:'latest'}); }
    catch (error) { throw new Error(`Handler não compilável (${location}): ${decoded.slice(0,180)}: ${error.message}`); }
    const replacements = [], literals = new Set();
    const bodyStart = 'function handler(event, data) {'.length;
    const argIndex = index => indices.indexOf(index);
    function walk(node) {
      if (!node || typeof node !== 'object') return;
      if (node.type === 'Literal' && typeof node.value === 'string' && markers.test(node.value)) {
        markers.lastIndex = 0;
        const chunks = [], matches = [...node.value.matchAll(markers)]; let cursor = 0;
        for (const match of matches) {
          if (match.index > cursor) chunks.push(JSON.stringify(node.value.slice(cursor, match.index)));
          chunks.push(`String(data[${argIndex(+match[1])}] == null ? '' : data[${argIndex(+match[1])}])`);
          cursor = match.index + match[0].length;
        }
        if (cursor < node.value.length) chunks.push(JSON.stringify(node.value.slice(cursor)));
        replacements.push({start:node.start-bodyStart,end:node.end-bodyStart,text:`(${chunks.join(' + ')})`}); return;
      }
      markers.lastIndex = 0;
      if (node.type === 'Identifier' && /^__SOFT_VALUE_\d+__$/.test(node.name)) {
        const index = +node.name.match(/\d+/)[0]; literals.add(index);
        replacements.push({start:node.start-bodyStart,end:node.end-bodyStart,text:`data[${argIndex(index)}]`}); return;
      }
      for (const value of Object.values(node)) {
        if (Array.isArray(value)) value.forEach(walk); else if (value && typeof value === 'object') walk(value);
      }
    }
    walk(ast.body[0].body);
    let body = decoded;
    for (const replacement of replacements.sort((a,b)=>b.start-a.start)) body = body.slice(0,replacement.start)+replacement.text+body.slice(replacement.end);
    if (/__SOFT_VALUE_\d+__/.test(body)) throw new Error(`Interpolação não tratada no handler ${location}: ${decoded}`);
    const id = `a${actions.length}`;
    const name = (decoded.match(/(?:window\.)?([a-zA-Z_$][\w$]*(?:\.[a-zA-Z_$][\w$]*)*)\s*\(/) || [])[1] || 'action';
    actions.push({id, body, name});
    return {id, name, indices, literal:indices.map(index => literals.has(index)), json:indices.map(index => /\b(?:utils\.)?jsArg\s*\(/.test(valueExpressions[index] || ''))};
  }
  function transformHtml(html, valueExpressions = [], location = 'HTML') {
    const args = [];
    let out = html.replace(actionPattern, (_all, attr, _quote, code) => {
      const action = compileHandler(code, valueExpressions, location);
      const event = attr.toLowerCase().slice(2), item = args.length; events.add(event);
      args.push({...action,event});
      return `data-soft-on${event}="${action.id}" data-soft-name-${event}="${escape(action.name)}"`
        + (action.indices.length ? ` data-soft-args-${event}="__SOFT_ARGS_${item}__"` : '');
    });
    out = out.replace(stylePattern, (_all,_quote,css) => {
      if (/__SOFT_VALUE_/.test(css)) return `data-soft-style="${css}"`;
      // A separate attribute lets the runtime merge a generated class into an existing class attribute.
      return `data-soft-class="${addStyle(css)}"`;
    });
    out = out.replace(/href\s*=\s*(["'])javascript:[\s\S]*?\1/gi, 'href="#" data-soft-prevent-default="true"');
    if (location !== 'HTML' && /<html\b/i.test(out)) out = out.replace(/<head>/i, '<head><meta charset="UTF-8"><link rel="stylesheet" href="src/styles/strict-generated.css"><script src="src/ui/strict-actions.js"></script><script src="src/ui/strict-actions.generated.js"></script>');
    out = out.replace(/<style\b[^>]*>([\s\S]*?)<\/style>/gi, (_all,css) => `<template data-soft-stylesheet>${css}</template>`);
    return {html:out,args};
  }
  const hasString = node => (node.type === 'Literal' && typeof node.value === 'string') || node.type === 'TemplateLiteral' || (node.type === 'BinaryExpression' && node.operator === '+' && (hasString(node.left) || hasString(node.right)));
  function flatten(node, text, literals=[], expressions=[]) {
    if (node.type === 'Literal' && typeof node.value === 'string') { literals.push(node.value); return; }
    if (node.type === 'TemplateLiteral') {
      for(let i=0;i<node.quasis.length;i++) {
        literals.push(node.quasis[i].value.cooked ?? node.quasis[i].value.raw);
        if(i<node.expressions.length) { literals.push(marker(expressions.length)); expressions.push(node.expressions[i]); }
      } return;
    }
    if (node.type === 'BinaryExpression' && node.operator === '+' && hasString(node)) { flatten(node.left,text,literals,expressions); flatten(node.right,text,literals,expressions); return; }
    literals.push(marker(expressions.length)); expressions.push(node);
  }
  function compileJs(text, path) {
    const ast = acorn.parse(text,{ecmaVersion:'latest',allowReturnOutsideFunction:false,allowAwaitOutsideFunction:true,sourceType:'script'}), replacements=[];
    function walk(node) {
      if(!node || typeof node !== 'object') return;
      if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression'
        && node.callee.object.name === 'document' && node.callee.property.name === 'createElement'
        && node.arguments[0]?.type === 'Literal' && node.arguments[0].value === 'style') {
        replacements.push({start:node.start,end:node.end,text:'SoftActions.createStylesheet()'}); return;
      }
      if(node.type==='Literal' || node.type==='TemplateLiteral' || (node.type==='BinaryExpression' && node.operator==='+')) {
        const literals=[], expressions=[]; flatten(node,text,literals,expressions);
        const html=literals.join('');
        if(relevant(html) && /<|\bon[a-z]+\s*=/.test(html)) {
          const values = expressions.map(expr=>text.slice(expr.start,expr.end));
          const compiledValues = values.map(value => compileJs(`(${value})`, path));
          const compiled=transformHtml(html,values,path);
          if(compiled.html!==html) {
            const id=templates.length; templates.push(compiled);
            replacements.push({start:node.start,end:node.end,text:`SoftActions.html(${id}, [${compiledValues.join(', ')}])`});
            // Expressions may contain their own HTML; compile them separately in another pass.
            return;
          }
        }
      }
      for(const value of Object.values(node)) {
        if(Array.isArray(value)) value.forEach(walk); else if(value && typeof value==='object') walk(value);
      }
    }
    walk(ast);
    let out=text;
    for(const replacement of replacements.sort((a,b)=>b.start-a.start)) out=out.slice(0,replacement.start)+replacement.text+out.slice(replacement.end);
    return out;
  }
  let inlineIndex=0, styleIndex=0;
  let html=sourceHtml.replace(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi, (all,attrs,body) => {
    if(/\bsrc\s*=/.test(attrs)) return all;
    const path=`src/app/runtime-${String(++inlineIndex).padStart(2,'0')}.js`;
    compiledSources.set(path,body); return `<script src="${path}"></script>`;
  });
  html=html.replace(/<style\b[^>]*>([\s\S]*?)<\/style>/gi, (_all, css) => {
    const path=`src/styles/app-${String(++styleIndex).padStart(2,'0')}.css`;
    compiledSources.set(path,css); return `<link rel="stylesheet" href="${path}">`;
  });
  if(inlineIndex!==16 || styleIndex!==2) throw new Error(`Composição inesperada: ${inlineIndex} scripts, ${styleIndex} folhas`);
  const staticHtml=transformHtml(html); html=staticHtml.html;
  if(staticHtml.args.some(item=>item.indices.length)) throw new Error('Argumento dinâmico fora de JavaScript');
  for(const [path,text] of compiledSources) {
    if(path.endsWith('.js') && !path.startsWith('vendor/') && path!=='src/ui/strict-actions.js' && path!=='sw.js') {
      try { compiledSources.set(path,compileJs(text,path)); }
      catch(error) { throw new Error(`${path}: ${error.message}`); }
    }
  }
  const registry = `'use strict';\nSoftActions.install(${JSON.stringify(templates)}, {\n`
    + actions.map(action=>`${JSON.stringify(action.id)}: function(event, data) {\n${action.body}\n}`).join(',\n')+`\n}, ${JSON.stringify([...events])});\n`;
  const safeRegistry = registry.replace(/<\/script/gi, '<\\/script');
  compiledSources.set('src/ui/strict-actions.generated.js',safeRegistry);
  compiledSources.set('src/styles/strict-generated.css',styles.join('\n'));
  const policy = "default-src 'self'; script-src 'self' https://accounts.google.com https://apis.google.com; style-src 'self' https://fonts.googleapis.com https://accounts.google.com; font-src 'self' https://fonts.gstatic.com data:; img-src 'self' data: blob: https:; connect-src 'self' https://*.supabase.co wss://*.supabase.co https://www.googleapis.com https://oauth2.googleapis.com https://accounts.google.com; frame-src 'self' blob: https://accounts.google.com; object-src 'none'; base-uri 'self'; form-action 'self'; worker-src 'self' blob:; manifest-src 'self' data:";
  html=html.replace(/<meta\s+charset=[^>]+>/i, '');
  html=html.replace(/<head>/i, `<head>\n<meta charset="UTF-8">\n<meta http-equiv="Content-Security-Policy" content="${escape(policy)}">\n<link rel="stylesheet" href="src/styles/strict-generated.css">\n<script src="src/ui/strict-actions.js"></script>\n<script src="src/ui/strict-actions.generated.js"></script>`);
  compiledSources.set('index.html',html);
  return {sources:compiledSources, statistics:{actions:actions.length,templates:templates.length,styles:styles.length}, policy};
}
