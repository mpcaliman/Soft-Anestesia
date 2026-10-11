'use strict';

/* Fronteira clínica do carimbo rápido de evento.
   A apresentação solicita o registro; somente este adaptador escolhe a ficha
   aberta e chama o método clínico que inclui o evento na fonte canônica. */
const anesthesiaEventCommands = {
  registrarCarimbo(modulo) {
    const contexto = modulo === 'recuperacao' ? 'recuperacao' : 'anestesia';
    try { anestesia.graficoUI._contexto = contexto; } catch (e) {}
    const hora = utils.horaAtual();
    const tr = contexto === 'recuperacao'
      ? recuperacao.grafico.addEvento({ hora })
      : anestesia.eventos.add({ hora });
    return { contexto, hora, tr };
  }
};

/* FIM DOS COMANDOS CLÍNICOS DE EVENTO DA ANESTESIA */
