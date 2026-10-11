'use strict';

/* Modal genérico de apresentação. Mantém o contrato global `modal` usado
   pelos handlers legados e não decide autorização, persistência ou clínica. */
const modal = {
  open(title, bodyHTML, footerHTML = '') {
    document.getElementById('modal-title').textContent = title;
    document.getElementById('modal-body').innerHTML = bodyHTML;
    document.getElementById('modal-footer').innerHTML = footerHTML;
    document.getElementById('modal-backdrop').classList.add('show');
    /* esconde FABs/barras flutuantes enquanto o modal está aberto */
    document.body.classList.add('tem-modal');
  },
  close() {
    document.getElementById('modal-backdrop').classList.remove('show');
    document.body.classList.remove('tem-modal');
  }
};

/* Fechar com clique fora. */
document.addEventListener('click', e => {
  const bd = document.getElementById('modal-backdrop');
  if (bd && e.target === bd) modal.close();
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
  modal.close();
});

/* FIM DO MODAL DE APRESENTAÇÃO */
