/* Feedback visual transitório nos botões de ação (Salvar/Atualizar/Recalcular).
   Não declara sucesso: a confirmação real continua no estado canônico da
   nuvem, depois do recibo, ou no aviso explícito de trabalho offline. */
(function () {
  const PADRAO_ONCLICK = /\.(salvar|salvarComoNovo|atualizar|recalcular)\b/i;
  const PADRAO_TEXTO = /\b(salvar|atualizar|recalcular)\b/i;

  function flash(btn, label) {
    if (!btn || btn._flashAtivo) return;
    btn._flashAtivo = true;
    const origHTML = btn.innerHTML;
    const w = Math.ceil(btn.getBoundingClientRect().width);
    if (w) btn.style.minWidth = w + 'px';   /* evita "pulo" de largura */
    btn.classList.add('btn-acao-processando');
    btn.innerHTML = label || 'Processando…';
    setTimeout(function () {
      btn.classList.remove('btn-acao-processando');
      btn.innerHTML = origHTML;
      btn.style.minWidth = '';
      btn._flashAtivo = false;
    }, 1150);
  }

  /* Fase de bolha: roda DEPOIS do onclick do botão (ação já executada). */
  document.addEventListener('click', function (e) {
    const btn = e.target && e.target.closest ? e.target.closest('button') : null;
    if (!btn || btn.disabled || btn._flashAtivo) return;
    const oc = btn.getAttribute('data-soft-name-click') || btn.getAttribute('onclick') || '';
    const txt = (btn.textContent || '').toLowerCase();
    if (!(PADRAO_ONCLICK.test(oc) || PADRAO_TEXTO.test(txt))) return;
    const salvar = /salvar/i.test(oc) || /\bsalv/i.test(txt);
    flash(btn, salvar ? 'Salvando…' : 'Processando…');
  }, false);
})();

/* FIM DO FEEDBACK VISUAL DE AÇÕES */
