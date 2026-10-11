'use strict';

/* Feedback efêmero de apresentação. A mensagem é sempre escapada antes de
   entrar no DOM; este componente não persiste nem transmite conteúdo. */
function toast(msg, tipo = 'success') {
  const wrap = document.getElementById('toast-wrap');
  if (!wrap) { console.log('[toast]', tipo + ':', msg); return; }
  const el = document.createElement('div');
  el.className = 'toast ' + tipo;
  const icon = { success: '✓', error: '✕', warn: '⚠', info: 'ℹ' }[tipo] || 'ℹ';
  el.innerHTML = '<span class="toast-icon">' + icon + '</span><span>' + utils.escapeHTML(msg) + '</span>';
  wrap.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 300);
  }, 2800);
}

/* FIM DO FEEDBACK DE APRESENTAÇÃO */
