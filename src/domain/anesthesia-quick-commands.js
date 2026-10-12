'use strict';

/* Fronteira clínica dos atalhos da ficha de anestesia.
   A apresentação escolhe valores; somente este adaptador altera a ficha aberta,
   marca o documento como editado e solicita a atualização do gráfico. */
const anesthesiaQuickCommands = {
  registrarDose(dose) {
    const valor = dose && Number(dose.dose);
    if (!dose || !String(dose.nome || '').trim() || !Number.isFinite(valor) || valor <= 0) {
      throw new Error('Dose rápida inválida');
    }
    const item = {
      hora: utils.horaAtual(),
      nome: String(dose.nome),
      dose: String(dose.dose),
      unidade: String(dose.unidade || ''),
      via: String(dose.via || 'EV')
    };
    anestesia.meds.add(item);
    if (typeof markDirty === 'function') markDirty();
    return item;
  },

  lerUltimosVitais() {
    return anestesia.vitais._lerUltima();
  },

  registrarVitais(valores) {
    const obrigatorios = ['pas', 'pad', 'fc', 'fr', 'spo2'];
    if (!valores || obrigatorios.some(campo => !Number.isFinite(Number(valores[campo])))) {
      throw new Error('Sinais vitais inválidos');
    }
    let pam = '';
    try { pam = anestesia.vitais._calcPAM(valores.pas, valores.pad); } catch (e) {}
    const item = {
      hora: utils.horaAtual(),
      pas: String(valores.pas),
      pad: String(valores.pad),
      pam: String(pam || ''),
      fc: String(valores.fc),
      fr: String(valores.fr),
      spo2: String(valores.spo2),
      ritmo: String(valores.ritmo || 'Sinusal')
    };
    anestesia.vitais.add(false, item);
    if (typeof markDirty === 'function') markDirty();
    try { anestesia.grafico.render(); } catch (e) {}
    return item;
  }
};

/* FIM DOS COMANDOS CLÍNICOS RÁPIDOS DA ANESTESIA */
