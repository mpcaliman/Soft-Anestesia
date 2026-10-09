'use strict';
/* The shell receives one document from its opener. It never stores clinical data. */
(() => {
  const owner = window.opener, origin = location.origin;
  const targetOrigin = origin;
  const nonce = location.hash.slice(1);
  let rendered = false;
  if (!owner || origin === 'null' || !/^[0-9a-f-]{36}$/i.test(nonce)) return;
  history.replaceState(null, '', location.pathname + location.search);
  const send = type => owner.postMessage({type,nonce}, targetOrigin);
  const clear = () => {
    document.body.replaceChildren(); document.adoptedStyleSheets = [];
    document.title = 'Impressão encerrada'; window.softPrintRendered = false;
    window.close();
  };
  const current = () => {
    try { return !owner.closed && !!owner.SoftActions?.isPrintCurrent(window, nonce); }
    catch (error) { return false; }
  };
  window.addEventListener('message', async event => {
    const data = event.data;
    if (event.source !== owner || event.origin !== origin || !data || data.nonce !== nonce) return;
    if (data.type === 'soft-print-invalidate') { clear(); return; }
    if (data.type !== 'soft-print-document' || rendered || typeof data.html !== 'string') return;
    if (!current()) { clear(); return; }
    rendered = true;
    try {
      if (!SoftActions.isBuild(data.build)) throw new Error('Arquivos de impressão de versões diferentes');
      const parsed = new DOMParser().parseFromString(SoftActions.sanitizeHTML(data.html), 'text/html');
      parsed.querySelectorAll('script,base,meta[http-equiv]').forEach(node => node.remove());
      document.title = parsed.title || 'Documento';
      const styles = [];
      for (const node of parsed.head.children) {
        if (node.matches('template[data-soft-stylesheet]')) document.head.appendChild(document.importNode(node, true));
        else if (node.matches('link[rel="stylesheet"][href]')) {
          const href = new URL(node.getAttribute('href'), location.href);
          if (href.origin === origin) {
            const link = document.importNode(node, true); link.href = href.href;
            styles.push(new Promise((resolve, reject) => {
              link.addEventListener('load', resolve, {once:true});
              link.addEventListener('error', () => reject(new Error('Folha de impressão indisponível')), {once:true});
            }));
            document.head.appendChild(link);
          }
        }
      }
      document.body.replaceWith(document.importNode(parsed.body, true));
      SoftActions.scan(document);
      await Promise.all(styles);
      if (!current()) { clear(); return; }
      window.softPrintRendered = true;
      send('soft-print-rendered');
    } catch (error) { clear(); send('soft-print-failed'); }
  });
  // Não devolver um documento clínico antigo por restauração do BFCache.
  window.addEventListener('pagehide', clear);
  window.addEventListener('afterprint', () => setTimeout(() => window.close(), 400), {once:true});
  setInterval(() => { if (!window.opener || !current()) clear(); }, 500);
  send('soft-print-ready');
})();
