'use strict';

/* Modal genérico de apresentação. Mantém o contrato global `modal` usado
   pelos handlers legados e não decide autorização, persistência ou clínica. */
const modal = {
  /* JANELA QUE NÃO PODE SUMIR CALADA. Algumas janelas pedem uma resposta que
     não pode se perder — a da cobrança ao finalizar é a principal: fechada
     por um clique fora, um Esc ou outra janela abrindo por cima, o atendimento
     ficava finalizado SEM lançamento e sem ninguém saber. Quem abre uma janela
     assim registra uma guarda:
       aoDispensar  — clique fora / Esc: em vez de fechar, a guarda decide;
       aoSubstituir — outra janela vai ocupar o lugar: a guarda é avisada antes
                      (para reabrir depois, quando o lugar vagar).
     Fechar pelos botões da própria janela (modal.close) desarma a guarda. */
  _guarda: null,
  proteger(guarda) { modal._guarda = guarda || null; },
  open(title, bodyHTML, footerHTML = '') {
    const anterior = modal._guarda;
    modal._guarda = null;
    if (anterior && typeof anterior.aoSubstituir === 'function') { try { anterior.aoSubstituir(); } catch (e) {} }
    try { window.dispatchEvent(new Event('soft:modal-open')); } catch (e) {}
    document.getElementById('modal-title').textContent = title;
    document.getElementById('modal-body').innerHTML = bodyHTML;
    document.getElementById('modal-footer').innerHTML = footerHTML;
    document.getElementById('modal-backdrop').classList.add('show');
    /* esconde FABs/barras flutuantes enquanto o modal está aberto */
    document.body.classList.add('tem-modal');
  },
  close() {
    modal._guarda = null;
    try { window.dispatchEvent(new Event('soft:modal-close')); } catch (e) {}
    document.getElementById('modal-backdrop').classList.remove('show');
    document.body.classList.remove('tem-modal');
  },
  /* clique fora / Esc */
  dispensar() {
    const g = modal._guarda;
    if (g && typeof g.aoDispensar === 'function') { try { g.aoDispensar(); } catch (e) {} return; }
    modal.close();
  }
};

/* Fechar com clique fora. */
document.addEventListener('click', e => {
  const bd = document.getElementById('modal-backdrop');
  if (bd && e.target === bd) modal.dispensar();
});

document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  /* Os quadros de detalhe da ficha (bloqueio, via aérea, acessos) não são o
     modal comum — os campos precisam continuar dentro do formulário —, mas
     fecham pelo mesmo Esc. */
  try {
    if (document.querySelector('.bloq-janela')) {
      anestesia.tecnicaDet.fecharJanela();
      return;
    }
  } catch (er) {}
  if (!document.getElementById('modal-backdrop')?.classList.contains('show')) return;
  modal.dispensar();
});

/* FIM DO MODAL DE APRESENTAÇÃO */
