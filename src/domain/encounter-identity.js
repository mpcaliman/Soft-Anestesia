'use strict';

window.SoftEncounterIdentity = (function () {
  function normalizeName(value) {
    return (value || '').toString()
      .toLowerCase().trim()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/\s+/g, ' ');
  }

  function digits(value) {
    return (value || '').toString().replace(/\D+/g, '');
  }

  function isoDate(value) {
    const date = (value || '').toString().slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null;
  }

  function validCpf(value) {
    const cpf = digits(value);
    if (cpf.length !== 11 || /^(\d)\1{10}$/.test(cpf)) return false;
    const check = length => {
      let sum = 0;
      for (let i = 0; i < length; i++) sum += Number(cpf[i]) * (length + 1 - i);
      const remainder = (sum * 10) % 11;
      return (remainder === 10 ? 0 : remainder) === Number(cpf[length]);
    };
    return check(9) && check(10);
  }

  function fromRecord(item) {
    const source = item || {};
    const patient = source.paciente && typeof source.paciente === 'object' ? source.paciente : {};
    const name = source.paciente_nome || source.nome || patient.nome ||
      (typeof source.paciente === 'string' ? source.paciente : '') || '';
    const birthDate = isoDate(source.paciente_nasc || source.nascimento || source.nasc ||
      patient.nascimento || patient.nasc || '');
    const cpf = digits(source.cpf || source.paciente_cpf || patient.cpf || '');
    return {
      nome: String(name || '').trim(),
      nasc: birthDate || '',
      cpf: cpf.length >= 11 ? cpf : '',
      convenio: source.convenio || source.paciente_convenio || patient.convenio || '',
      prontuario: source.prontuario || patient.prontuario || '',
      telefone: source.telefone || patient.telefone || '',
      sexo: source.sexo || patient.sexo || ''
    };
  }

  /* Compatibilidade com os legacy_id já gravados. Não usar esta chave para
     decidir automaticamente se dois novos prontuários pertencem à mesma
     pessoa: homônimos compartilham o mesmo valor. */
  function legacyPatientKey(identity) {
    const value = identity || {};
    const name = normalizeName(value.nome);
    if (name && name.length >= 3) return 'nome:' + name;
    return value.cpf ? 'cpf:' + digits(value.cpf) : null;
  }

  /* Identidade forte para fluxos novos. Nome isolado nunca autoriza união. */
  function strongPatientKey(identity) {
    const value = identity || {};
    const cpf = digits(value.cpf);
    if (validCpf(cpf)) return 'cpf:' + cpf;
    const name = normalizeName(value.nome);
    const birthDate = isoDate(value.nasc || value.nascimento || '');
    if (name.length >= 3 && birthDate) return 'nome_nasc:' + name + '|' + birthDate;
    return null;
  }

  function procedureText(item) {
    const value = item || {};
    const procedure = value.procedimento;
    if (procedure && typeof procedure === 'object') {
      return procedure.descricao || procedure.nome || procedure.codigo || '';
    }
    return procedure || value.cirurgia || '';
  }

  /* Reproduz exatamente a chave histórica para impedir duplicação remota. */
  function legacyEncounterKey(patientKey, item) {
    if (!patientKey) return null;
    const value = item || {};
    const procedure = normalizeName(value.procedimento || value.cirurgia || '');
    if (!procedure) return null;
    const date = isoDate(value.data) || '';
    return patientKey + '|' + date + '|' + procedure;
  }

  /* Um caso novo só é inferido quando pessoa, data e procedimento são fortes. */
  function strongEncounterKey(identity, item) {
    const patientKey = (identity && identity.patientKey) || strongPatientKey(identity);
    const value = item || {};
    const date = isoDate(value.data || value.data_anestesia || value.data_atendimento ||
      value.data_proc || value.data_prevista || '');
    const procedure = normalizeName(procedureText(value));
    if (!patientKey || !date || !procedure) return null;
    return patientKey + '|' + date + '|' + procedure;
  }

  function scopedKey(organizationId, key) {
    const organization = String(organizationId || '').trim();
    return organization && key ? organization + '|' + key : null;
  }

  return Object.freeze({
    normalizeName,
    digits,
    isoDate,
    validCpf,
    fromRecord,
    legacyPatientKey,
    strongPatientKey,
    procedureText,
    legacyEncounterKey,
    strongEncounterKey,
    scopedKey
  });
})();
