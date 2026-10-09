'use strict';
/** Compiled actions accept data, never source code. The registry is a same-origin external script. */
window.SoftActions = (() => {
  let templates = [], handlers = Object.create(null);
  const bound = new WeakMap();
  let eventSelector = '[data-soft-onclick],[data-soft-onchange],[data-soft-oninput],[data-soft-onsubmit]';
  const escape = value => String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const decode = value => String(value).replace(/&quot;/g, '"').replace(/&#(?:39|x27);/gi, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  function html(index, values) {
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
      if (!eventName || events.has(eventName)) continue;
      const handler = handlers[attribute.value];
      if (typeof handler !== 'function') throw new Error('Ação de interface desconhecida');
      events.add(eventName);
      element.addEventListener(eventName, function(event) {
        if (this.disabled) return;
        const encoded = this.getAttribute('data-soft-args-' + eventName);
        const data = encoded ? JSON.parse(encoded) : [];
        if (!Array.isArray(data)) throw new Error('Parâmetros de interface inválidos');
        const result = handler.call(this, event, data);
        if (result === false || this.hasAttribute('data-soft-prevent-default')) event.preventDefault();
      });
      // load events on an already parsed body do not bubble through delegation.
      if (eventName === 'load' && element.tagName === 'BODY' && document.readyState === 'complete') {
        queueMicrotask(() => handler.call(element, new Event('load'), []));
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
      descriptor.set.call(this, value); scan(this);
    }});
  }
  const insert = Element.prototype.insertAdjacentHTML;
  Element.prototype.insertAdjacentHTML = function(position, html) {
    insert.call(this, position, html); scan(this.parentElement || this);
  };
  const observer = new MutationObserver(records => {
    for (const record of records) for (const node of record.addedNodes) scan(node);
  });
  observer.observe(document, {childList:true,subtree:true});
  document.addEventListener('DOMContentLoaded', () => scan(document), {once:true});
  return Object.freeze({install(nextTemplates, nextHandlers, events) {
    templates=nextTemplates; handlers=nextHandlers;
    if (events) eventSelector=events.map(event => '[data-soft-on' + event + ']').join(',');
    scan(document);
  }, html, scan, createStylesheet});
})();
