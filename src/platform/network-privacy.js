'use strict';

// Cache HTTP também é persistência no aparelho. Respostas de Auth, prontuário,
// Storage e funções nunca podem usar o cache do navegador, mesmo online.
(() => {
  if (typeof globalThis.fetch !== 'function') return;
  const original = globalThis.fetch.bind(globalThis);
  globalThis.fetch = function(input, options) {
    const url = typeof input === 'string' || input instanceof URL ? String(input) : String(input?.url || '');
    if (/\/(?:rest|auth|storage|functions)\/v1(?:\/|$)/.test(url)) {
      return original(input, Object.assign({}, options || {}, { cache: 'no-store' }));
    }
    return original(input, options);
  };
})();
