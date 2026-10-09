'use strict';
/** Compiled actions accept data, never source code. The registry is a same-origin external script. */
window.SoftActions = (() => {
  let templates = [], handlers = Object.create(null), buildToken;
  const bound = new WeakMap();
  let eventSelector = '[data-soft-onclick],[data-soft-onchange],[data-soft-oninput],[data-soft-onsubmit]';
  const escape = value => String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const decode = value => String(value).replace(/&quot;/g, '"').replace(/&#(?:39|x27);/gi, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  function html(index, values, expectedBuild) {
    if (expectedBuild !== buildToken) throw new Error('Arquivos de versões diferentes: recarregue o app antes de continuar');
    const template = templates[index];
    if (!template) throw new Error('Template de interface não registrado');
    return template.html.replace(/__SOFT_ARGS_(\d+)__|__SOFT_VALUE_(\d+)__/g, (_match, arg, value) => {
      if (value !== undefined) return String(values[Number(value)]);
      const action = template.args[Number(arg)];
      const data = action.indices.map((source, offset) => {
        const value = values[source];
        if (action.json[offset]) return JSON.parse(decode(value));
        if (action.literal?.[offset] && typeof value === 'string') {
          // Older templates emitted true/false/numbers as source text. Normalize data only.
          if (value === 'undefined') return null;
          try { return JSON.parse(decode(value)); }
          catch { throw new Error('Argumento de ação deve ser dado tipado, não código'); }
        }
        return value;
      });
      return escape(JSON.stringify(data));
    });
  }
  function sanitizeHTML(value) {
    const html = String(value).replace(/<style\b[^>]*>([\s\S]*?)<\/style>/gi,
      '<template data-soft-stylesheet>$1</template>');
    // Tokenize complete attributes, including quoted values. A patient value may contain
    // words such as onerror=; those words inside another attribute remain plain data.
    return html.replace(/<!--[\s\S]*?-->|<\/?[A-Za-z][^"'<>]*(?:(?:"[^"]*"|'[^']*')[^"'<>]*)*>/g, tag => {
      const head = tag.match(/^<[A-Za-z][\w:-]*/);
      if (!head) return tag;
      const attrs = /(\s+)([^\s=/>]+)(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?/gy;
      let cursor = head[0].length, result = head[0];
      attrs.lastIndex = cursor;
      for (;;) {
        const match = attrs.exec(tag);
        if (!match) break;
        const name = match[2].toLowerCase();
        if (name === 'style') result += match[0].replace(match[2], 'data-soft-style');
        else if (!/^on[a-z]+$/.test(name)) result += match[0];
        cursor = attrs.lastIndex;
      }
      return result + tag.slice(cursor);
    });
  }
  function writeDocument(win, value) {
    const doc = win.document;
    // Non-DOM writers are unit-test doubles; they never parse or execute HTML.
    if (doc.nodeType !== 9 || typeof doc.createElement !== 'function') { doc.write(sanitizeHTML(value)); return Promise.resolve(); }
    const parsed = new DOMParser().parseFromString(sanitizeHTML(value), 'text/html');
    // No script is parser-inserted by document.write. Clinical HTML cannot supply executable scripts.
    parsed.querySelectorAll('script').forEach(script => script.remove());
    parsed.querySelectorAll('link[href]').forEach(link => {
      link.setAttribute('href', new URL(link.getAttribute('href'), document.baseURI).href);
    });
    doc.write('<!DOCTYPE html>' + parsed.documentElement.outerHTML);
    const load = path => new Promise((resolve, reject) => {
      const script = doc.createElement('script');
      script.async = false;
      script.addEventListener('load', resolve, {once:true});
      script.addEventListener('error', () => reject(new Error('Falha ao carregar ações do documento')), {once:true});
      script.src = new URL(path, document.baseURI).href;
      doc.head.appendChild(script);
    });
    const ready = load('src/ui/strict-actions.js').then(() => load('src/ui/strict-actions.generated.js'));
    ready.catch(error => console.error('Documento de impressão não carregou', error));
    return ready;
  }
  function createStylesheet() {
    const holder = document.createElement('template');
    const sheet = new CSSStyleSheet();
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
    Object.defineProperty(holder, 'textContent', {
      get: () => [...sheet.cssRules].map(rule => rule.cssText).join('\n'),
      set: css => sheet.replaceSync(String(css || ''))
    });
    return holder;
  }
  function bindElement(element) {
    if (!element || element.nodeType !== 1) return;
    if (element.hasAttribute('data-soft-class')) {
      element.classList.add(...element.getAttribute('data-soft-class').split(/\s+/).filter(Boolean));
      element.removeAttribute('data-soft-class');
    }
    if (element.hasAttribute('data-soft-style')) {
      // CSSOM writes are authored by this external script and do not require inline style permission.
      element.style.cssText = element.getAttribute('data-soft-style');
      element.removeAttribute('data-soft-style');
    }
    if (element.tagName === 'TEMPLATE' && element.hasAttribute('data-soft-stylesheet')) {
      const css = element.content ? element.content.textContent : element.textContent;
      const sheet = new CSSStyleSheet(); sheet.replaceSync(css || '');
      element.ownerDocument.adoptedStyleSheets = [...element.ownerDocument.adoptedStyleSheets, sheet];
      element.remove(); return;
    }
    let events = bound.get(element);
    if (!events) { events = new Set(); bound.set(element, events); }
    for (const attribute of [...element.attributes]) {
      if (!attribute.name.startsWith('data-soft-on')) continue;
      const eventName = attribute.name.slice('data-soft-on'.length);
      if (element.getAttribute('data-soft-build') !== buildToken)
        throw new Error('Ação de outra versão: recarregue o app antes de continuar');
      if (!eventName || events.has(eventName)) continue;
      const handler = handlers[attribute.value];
      if (typeof handler !== 'function') throw new Error('Ação de interface desconhecida');
      events.add(eventName);
      const target = element.tagName === 'BODY' && eventName === 'load' ? element.ownerDocument.defaultView : element;
      target.addEventListener(eventName, function(event) {
        if (element.disabled) return;
        const encoded = element.getAttribute('data-soft-args-' + eventName);
        const data = encoded ? JSON.parse(encoded) : [];
        if (!Array.isArray(data)) throw new Error('Parâmetros de interface inválidos');
        const result = handler.call(this, event, data);
        if (result === false || element.hasAttribute('data-soft-prevent-default')) event.preventDefault();
      });
      // load events on an already parsed body do not bubble through delegation.
      if (eventName === 'load' && element.tagName === 'BODY' && document.readyState === 'complete') {
        queueMicrotask(() => handler.call(target, new Event('load'), []));
      }
    }
  }
  function scan(root) {
    if (!root) return;
    bindElement(root);
    if (root.querySelectorAll) root.querySelectorAll('[data-soft-class],[data-soft-style],[data-soft-stylesheet],' + eventSelector)
      .forEach(bindElement);
  }
  // Bind immediately after a trusted app rendering sink; same-turn .click() remains functional.
  for (const prototype of [Element.prototype, ShadowRoot.prototype]) {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, 'innerHTML');
    if (!descriptor || !descriptor.set) continue;
    Object.defineProperty(prototype, 'innerHTML', { ...descriptor, set(value) {
      descriptor.set.call(this, sanitizeHTML(value)); scan(this);
    }});
  }
  const outer = Object.getOwnPropertyDescriptor(Element.prototype, 'outerHTML');
  if (outer?.set) Object.defineProperty(Element.prototype, 'outerHTML', { ...outer, set(value) {
    const parent = this.parentNode;
    outer.set.call(this, sanitizeHTML(value)); scan(parent);
  }});
  const insert = Element.prototype.insertAdjacentHTML;
  Element.prototype.insertAdjacentHTML = function(position, html) {
    insert.call(this, position, sanitizeHTML(html)); scan(this.parentElement || this);
  };
  const observer = new MutationObserver(records => {
    for (const record of records) for (const node of record.addedNodes) scan(node);
  });
  observer.observe(document, {childList:true,subtree:true});
  document.addEventListener('DOMContentLoaded', () => scan(document), {once:true});
  return Object.freeze({install(nextTemplates, nextHandlers, events, token) {
    buildToken=token;
    templates=nextTemplates; handlers=nextHandlers;
    if (events) eventSelector=events.map(event => '[data-soft-on' + event + ']').join(',');
    scan(document);
  }, html, scan, createStylesheet, sanitizeHTML, writeDocument});
})();
