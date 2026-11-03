'use strict';
/* The shell receives one document from its opener. It never stores clinical data. */
(() => {
  // A new popup receives an initial copy of the opener's sessionStorage.
  // Printing needs only the live opener lease; copied credentials must not survive here.
  try { sessionStorage.clear(); } catch (error) {}
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
  /* O BOTÃO IMPRIMIR É DESTA JANELA. No iPhone a impressão pedida pela aba
     de trás é bloqueada sem aviso, e o botão parecia morto. Aqui o toque chama
     a impressão desta própria janela; se o navegador não abrir o diálogo,
     a tela diz o caminho que sempre funciona: Compartilhar → Imprimir. */
  let abriuImpressao = false;
  window.addEventListener('beforeprint', () => { abriuImpressao = true; });
  const avisarCompartilhar = () => {
    if (document.getElementById('pp-aviso-imprimir')) return;
    const aviso = document.createElement('div');
    aviso.id = 'pp-aviso-imprimir';
    aviso.textContent = 'Seu navegador não abriu a impressão. Toque em Compartilhar (□↑) e escolha Imprimir — dali dá para a impressora ou para "Salvar em PDF".';
    Object.assign(aviso.style, { background: '#fff4e5', color: '#7a4b12', border: '1px solid #f0c890', borderRadius: '8px',
      padding: '10px 12px', margin: '10px 12px', fontSize: '15px', lineHeight: '1.4' });
    const barra = document.querySelector('.pp-voltar-bar');
    if (barra && barra.parentNode) barra.parentNode.insertBefore(aviso, barra.nextSibling);
    else document.body.insertBefore(aviso, document.body.firstChild);
  };
  const imprimirAqui = event => {
    if (event) { event.preventDefault(); event.stopImmediatePropagation(); }
    abriuImpressao = false;
    try { window.focus(); window.print(); } catch (error) { avisarCompartilhar(); return; }
    setTimeout(() => { if (!abriuImpressao) avisarCompartilhar(); }, 1500);
  };
  const ligarBotaoImprimir = () => {
    document.querySelectorAll('.pp-print-btn').forEach(btn => btn.addEventListener('click', imprimirAqui, true));
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
      ligarBotaoImprimir();
      await Promise.all(styles);
      if (!current()) { clear(); return; }
      window.softPrintRendered = true;
      send('soft-print-rendered');
    } catch (error) {
      /* o motivo volta para a tela: "falha ao montar" sozinho não é diagnóstico */
      try { owner.postMessage({type:'soft-print-failed',nonce,motivo:String((error && error.message) || '').slice(0, 160)}, targetOrigin); } catch (e) {}
      clear();
    }
  });
  // Não devolver um documento clínico antigo por restauração do BFCache.
  window.addEventListener('pagehide', clear);
  window.addEventListener('afterprint', () => setTimeout(() => window.close(), 400), {once:true});
  setInterval(() => { if (!window.opener || !current()) clear(); }, 500);
  send('soft-print-ready');
})();
