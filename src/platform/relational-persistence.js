'use strict';

/* ============================================================================
   CLOUD RELACIONAL (Fase 6) — leitura/escrita direta nas tabelas relacionais.
   Piloto: módulo Pacientes. Usa a MESMA identidade (patKey por nome) da
   migração, então salvar um paciente ATUALIZA a linha migrada em vez de
   duplicar. Offline/sem org → no-op honesto; o localStorage segue como cache.
============================================================================ */
const cloudRel = {
  /* Compatibilidade nominal: estas chaves existiam antes do contexto por aba,
     mas não são mais autoridade para nenhuma operação. */
  ORG_KEY: 'medsys.v7.cloud.org_id',
  _orgLembrada() { try { return contextoAba.organizationId() || null; } catch (e) { return null; } },
  /* "Não tem clínica" e "ainda não perguntei" eram a mesma coisa: a chave
     ausente. Sem separar os dois, ou o app cala sobre uma conta solta, ou
     acusa toda conta recém-aberta de estar solta. Esta marca só é gravada
     quando o SERVIDOR responde que não há vínculo. */
  SEM_ORG_KEY: 'medsys.v7.cloud.sem_clinica',
  _semClinicaConfirmado() {
    try { return contextoAba.semOrganizacaoConfirmada(); } catch (e) { return false; }
  },
  _marcarSemClinica(b) {
    /* Somente `contextoAba.vincular`, alimentado por buscarPerfil(), pode
       confirmar esse estado. Esta função antiga não cria autoridade. */
    return b ? contextoAba.semOrganizacaoConfirmada() : true;
  },
  _lembrarOrg(org) {
    /* Mantida para chamadas legadas somente como verificação, nunca escrita. */
    return String(org || '') === String(contextoAba.organizationId() || '');
  },
  _org() {
    try { return contextoAba.organizationId() || null; } catch (e) { return null; }
  },
  async _orgAsync() {
    let org = cloudRel._org();
    if (org) return org;
    if (cloudRel._semClinicaConfirmado()) return null;
    try {
      const contextoInicial = contextoAba.capturar();
      const sessaoInicial = cloud.session();
      const uidInicial = sessaoInicial && sessaoInicial.user && sessaoInicial.user.id;
      if (!uidInicial) return null;
      const p = await cloud.buscarPerfil();
      const s = cloud.session();
      const uid = s && s.user && s.user.id;
      if (!p || !uid || uid !== uidInicial || p.uid !== uid ||
          !contextoAba.mesmaGeracao(contextoInicial)) return null;
      if (p.organization_id) {
        await ambiente.aoEntrar(p.organization_id, '', p);
        return cloudRel._org();
      }
      /* resposta clara do servidor: a conta realmente não tem clínica */
      if (p.semVinculo) await ambiente.aoEntrarSemClinica(p);
    } catch (e) {}
    return null;
  },
  disponivel() {
    try {
      /* app e nuvem em contas diferentes → nada entra nem sai (senão os dados
         iriam para a clínica da outra conta) */
      if (cloud.divergencia()) return false;
      return cloud.estaConfigurado() && cloud.estaLogado()
        && contextoAba.operational()
        && contextoAba.compativelComSessoes(cloud.session(), auth.usuarioAtual())
        && (typeof navigator === 'undefined' || navigator.onLine !== false);
    } catch (e) { return false; }
  },
  _capturarContexto() {
    try { return cloudRel.disponivel() ? contextoAba.capturar() : null; }
    catch (e) { return null; }
  },
  _contextoValido(contexto, org) {
    try {
      return contextoAba.corresponde(contexto) &&
        (!org || contexto.organizationId === org) &&
        contextoAba.compativelComSessoes(cloud.session(), auth.usuarioAtual());
    } catch (e) { return false; }
  },

  /* Reconstrói o item local a partir de uma linha relacional de patients.
     Usa o item completo salvo em data, ou as colunas (linhas migradas). */
  _rowParaItem(row, org) {
    const d = row.data;
    const base = (d && typeof d === 'object' && (d._id || d.nome)) ? Object.assign({}, d) : {};
    base.nome = base.nome || row.nome || '';
    /* Saneia linhas antigas em que a coluna nome recebeu o objeto serializado */
    const rep = utils.pacienteDeJSON(base.nome);
    if (rep) {
      base.nome = rep.nome.trim();
      if (!base.nascimento && rep.nascimento) base.nascimento = rep.nascimento;
      if (!base.sexo && rep.sexo) base.sexo = rep.sexo;
      if (!base.prontuario && rep.prontuario) base.prontuario = rep.prontuario;
    }
    if (!base.cpf && row.cpf) base.cpf = row.cpf;
    if (!base.nascimento && row.nascimento) base.nascimento = row.nascimento;
    if (!base.prontuario && row.prontuario) base.prontuario = row.prontuario;
    if (!base.plano && !base.convenio && row.convenio) base.plano = row.convenio;
    if (!base.telefone && row.telefone) base.telefone = row.telefone;
    if (!base.email && row.email) base.email = row.email;
    if (!base.sexo && row.sexo) base.sexo = row.sexo;
    if (!base._id) base._id = 'rel_' + (row.id || '').toString().slice(0, 8) + utils.uid().slice(-4);
    if (row.updated_at) base._relUpdatedAt = row.updated_at;
    if (row.version != null) base._relVersion = Number(row.version);
    if (row.updated_by) base._relUpdatedBy = row.updated_by;
    if (org || row.organization_id) base._relOrg = org || row.organization_id;
    return base;
  },
  _SELECT: 'id,organization_id,nome,cpf,nascimento,prontuario,convenio,telefone,email,sexo,data,legacy_id,version,updated_by,updated_at,deleted_at,last_operation_id,last_operation_checksum',

  /* Puxa os pacientes da org (tabela relacional). Retorna [{_patKey,item}] ou null. */
  async puxarPacientes() {
    const contexto = cloudRel._capturarContexto(); if (!contexto) return null;
    if (!(await cloud._garantirToken())) return null;
    const org = contexto.organizationId;
    if (!cloudRel._contextoValido(contexto, org)) return null;
    const c = cloud.config();
    try {
      const r = await fetch(c.url + '/rest/v1/patients?organization_id=eq.' + org +
        '&deleted_at=is.null&select=' + cloudRel._SELECT + '&order=nome.asc',
        { headers: cloud._headers(true) });
      if (!r.ok) return null;
      const rows = await r.json();
      if (!cloudRel._contextoValido(contexto, org)) return null;
      return rows.map(row => {
        const item = cloudRel._rowParaItem(row, org);
        return { _patKey: migracaoFase4._patKey(migracaoFase4._ident(item)), item };
      });
    } catch (e) { return null; }
  },

  _erroLeitura(code, message, status, cause) {
    const erro = new Error(message || code);
    erro.name = 'CloudReadError'; erro.code = code;
    if (Number.isFinite(Number(status)) && Number(status) > 0) erro.status = Number(status);
    if (cause) erro.cause = cause;
    return erro;
  },
  _falhaTipada(erro) {
    return { ok: false, motivo: erro && (erro.message || erro.code) || 'rede',
      code: erro && erro.code || null, status: erro && erro.status || null };
  },
  async _linhasValidas(r) {
    let linhas;
    try { linhas = await r.json(); }
    catch (e) { throw cloudRel._erroLeitura('resposta_invalida', 'resposta_invalida', r.status, e); }
    if (!Array.isArray(linhas) || linhas.length > 1 ||
        linhas.some(linha => !linha || typeof linha !== 'object' || Array.isArray(linha))) {
      throw cloudRel._erroLeitura('resposta_invalida', 'resposta_invalida', r.status);
    }
    return linhas;
  },
  /* null significa SOMENTE um GET bem-sucedido, válido e escopado com []:
     HTTP negado, falha de rede, JSON inválido e contexto trocado são erros.
     Confundir indisponibilidade com ausência apagaria a única cópia do WAL. */
  async _lerAtualTab(tabela, org, key, select) {
    const contexto = cloudRel._capturarContexto();
    if (!contexto || !cloudRel._contextoValido(contexto, org)) {
      throw cloudRel._erroLeitura('contexto_trocado', 'contexto_trocado');
    }
    const c = cloud.config();
    const r = await fetch(c.url + '/rest/v1/' + tabela + '?organization_id=eq.' + encodeURIComponent(org) +
      '&legacy_id=eq.' + encodeURIComponent(key) + '&select=' + select,
      { headers: cloud._headers(true) });
    if (!r.ok) throw cloudRel._erroLeitura('http_error', 'http ' + r.status, r.status);
    if (typeof r.status === 'number' && r.status !== 200) {
      throw cloudRel._erroLeitura('resposta_invalida', 'resposta_invalida', r.status);
    }
    const linhas = await cloudRel._linhasValidas(r);
    if (!cloudRel._contextoValido(contexto, org)) {
      throw cloudRel._erroLeitura('contexto_trocado', 'contexto_trocado');
    }
    const atual = linhas[0] || null;
    if (atual && (atual.organization_id != null && String(atual.organization_id) !== String(org) ||
        atual.legacy_id != null && String(atual.legacy_id) !== String(key))) {
      throw cloudRel._erroLeitura('resposta_invalida', 'resposta_invalida', r.status);
    }
    return atual;
  },
  _lerAtual(org, key) { return cloudRel._lerAtualTab('patients', org, key, cloudRel._SELECT); },

  /* Remove metadados locais antes de persistir o JSON clínico. A versão que
     controla concorrência vive em coluna própria e é incrementada pelo banco. */
  _dadosParaNuvem(item) {
    let dados;
    try { dados = JSON.parse(JSON.stringify(item || {})); }
    catch (e) { dados = Object.assign({}, item || {}); }
    /* Binário de anexo pertence ao Storage, nunca ao JSON relacional. Esta é
       a última barreira defensiva; enviarRegistro faz o upload obrigatório
       antes de chegar aqui. */
    try { if (typeof prontuario !== 'undefined') dados = prontuario.sanitizarParaNuvem(dados); } catch (e) {}
    ['_relVersion','_relUpdatedAt','_relUpdatedBy','_relOrg','_relId','_relEncounterId',
      'last_operation_id','last_operation_checksum'].forEach(k => { delete dados[k]; });
    return dados;
  },

  _versao(item) {
    const n = Number(item && item._relVersion);
    return Number.isInteger(n) && n > 0 ? n : null;
  },

  /* INSERT que nunca atualiza uma linha já existente. Usado para dependências
     (paciente/encounter) e para a primeira gravação de um documento. */
  async _inserirSemSobrescrever(tabela, org, legacy, row, select) {
    const contexto = cloudRel._capturarContexto();
    if (!contexto || !cloudRel._contextoValido(contexto, org)) return { ok: false, motivo: 'contexto_trocado' };
    const c = cloud.config();
    try {
      const r = await fetch(c.url + '/rest/v1/' + tabela +
        '?on_conflict=organization_id,legacy_id&select=' + select, {
        method: 'POST',
        headers: Object.assign({}, cloud._headers(true), {
          'Content-Type': 'application/json',
          'Prefer': 'resolution=ignore-duplicates,return=representation'
        }),
        body: JSON.stringify([row])
      });
      if (!r.ok) {
        const t = await r.text().catch(() => '');
        return { ok: false, motivo: 'http ' + r.status + (t ? ' — ' + t.slice(0, 180) : '') };
      }
      const rows = await r.json().catch(() => []);
      if (!cloudRel._contextoValido(contexto, org)) return { ok: false, motivo: 'contexto_trocado' };
      if (rows && rows[0]) return { ok: true, row: rows[0], inserted: true };
      const atual = await cloudRel._lerAtualTab(tabela, org, legacy, select);
      return atual ? { ok: true, row: atual, inserted: false } : { ok: false, motivo: 'nao_encontrado_ou_sem_acesso' };
    } catch (e) { return cloudRel._falhaTipada(e); }
  },

  /* UPDATE condicional em UMA instrução SQL. Não há janela entre "ler" e
     "gravar": se outra pessoa avançou version, o PATCH afeta zero linhas. */
  _normalizarOperacao(operacao) {
    const id = String(operacao && operacao.id || '').toLowerCase();
    const checksum = String(operacao && operacao.checksum || '').toLowerCase();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id) ||
        !/^[0-9a-f]{64}$/.test(checksum)) return null;
    return { id, checksum };
  },
  _mesmoRecibo(row, operacao) {
    const op = cloudRel._normalizarOperacao(operacao);
    return !!(row && op && String(row.last_operation_id || '').toLowerCase() === op.id &&
      String(row.last_operation_checksum || '').toLowerCase() === op.checksum);
  },

  async _gravarAtomico(tabela, org, legacy, row, baseVersion, select, converter, operacao) {
    const contexto = cloudRel._capturarContexto();
    if (!contexto || !cloudRel._contextoValido(contexto, org)) return { ok: false, motivo: 'contexto_trocado' };
    const c = cloud.config();
    const versao = Number(baseVersion);
    const recibo = cloudRel._normalizarOperacao(operacao);
    row = Object.assign({}, row);
    if (recibo) {
      row.last_operation_id = recibo.id;
      row.last_operation_checksum = recibo.checksum;
    }
    if (!Number.isInteger(versao) || versao < 1) {
      const ins = await cloudRel._inserirSemSobrescrever(tabela, org, legacy, row, select);
      if (!cloudRel._contextoValido(contexto, org)) return { ok: false, motivo: 'contexto_trocado' };
      if (!ins.ok) return ins;
      if (ins.inserted) return { ok: true, row: ins.row };
      if (cloudRel._mesmoRecibo(ins.row, recibo)) {
        return { ok: true, row: ins.row, replayed: true };
      }
      return {
        ok: false, conflict: true,
        cloud: converter(ins.row),
        cloudVersion: Number(ins.row.version),
        cloudUpdatedAt: ins.row.updated_at,
        motivo: 'versao_base_ausente'
      };
    }

    const corpo = Object.assign({}, row);
    delete corpo.organization_id;
    delete corpo.legacy_id;
    delete corpo.version;
    try {
      const r = await fetch(c.url + '/rest/v1/' + tabela +
        '?organization_id=eq.' + encodeURIComponent(org) +
        '&legacy_id=eq.' + encodeURIComponent(legacy) +
        '&version=eq.' + versao + '&select=' + select, {
        method: 'PATCH',
        headers: Object.assign({}, cloud._headers(true), {
          'Content-Type': 'application/json', 'Prefer': 'return=representation'
        }),
        body: JSON.stringify(corpo)
      });
      if (!r.ok) {
        const t = await r.text().catch(() => '');
        /* Um registro pode ter sido finalizado entre a abertura e o save. O
           guard do banco responde 400; isso não é falha transitória para
           retentar eternamente. Releia a linha e transforme em conflito — a
           escolha local poderá virar adendo, sem reabrir o original. */
        if ([400, 409, 412].includes(r.status)) {
          const atual = await cloudRel._lerAtualTab(tabela, org, legacy, select);
          if (cloudRel._mesmoRecibo(atual, recibo)) {
            return { ok: true, row: atual, replayed: true };
          }
          if (atual) return {
            ok: false, conflict: true, cloud: converter(atual),
            cloudVersion: Number(atual.version), cloudUpdatedAt: atual.updated_at,
            motivo: atual.finalized_at ? 'registro_finalizado' : 'gravacao_rejeitada'
          };
        }
        return { ok: false, motivo: 'http ' + r.status + (t ? ' — ' + t.slice(0, 180) : '') };
      }
      const rows = await r.json().catch(() => []);
      if (!cloudRel._contextoValido(contexto, org)) return { ok: false, motivo: 'contexto_trocado' };
      if (rows && rows[0]) return { ok: true, row: rows[0] };

      const atual = await cloudRel._lerAtualTab(tabela, org, legacy, select);
      if (!atual) return { ok: false, motivo: 'nao_encontrado_ou_sem_acesso' };
      if (cloudRel._mesmoRecibo(atual, recibo)) {
        return { ok: true, row: atual, replayed: true };
      }
      return {
        ok: false, conflict: true,
        cloud: converter(atual),
        cloudVersion: Number(atual.version),
        cloudUpdatedAt: atual.updated_at,
        motivo: 'versao_divergente'
      };
    } catch (e) { return cloudRel._falhaTipada(e); }
  },

  _aplicarMetaLocal(mod, item, row, org) {
    if (!item || !row) return;
    if (org && org !== cloudRel._org()) return;
    const meta = {};
    if (row.id) meta._relId = row.id;
    if (row.encounter_id) meta._relEncounterId = row.encounter_id;
    const versao = Number(row.version);
    if (Number.isInteger(versao) && versao > 0) meta._relVersion = versao;
    if (row.updated_at) meta._relUpdatedAt = row.updated_at;
    if (row.updated_by) meta._relUpdatedBy = row.updated_by;
    if (org || row.organization_id) meta._relOrg = org || row.organization_id;
    Object.assign(item, meta);
    try {
      const lista = store.list(mod);
      const ix = lista.findIndex(x => x && x._id === item._id);
      if (ix >= 0) { Object.assign(lista[ix], meta); store.setList(mod, lista); }
    } catch (e) {}
  },

  /* Cache de ids resolvidos nesta sessão (evita GETs repetidos em auto-saves) */
  _cachePac: {}, _cacheEnc: {},

  _erroDependencia(res, dependencia) {
    const e = new Error((res && res.motivo) || dependencia + '_nao_confirmada');
    e.code = (res && res.code) || 'dependencia_nao_confirmada';
    e.status = Number(res && (res.status || res.statusCode)) ||
      Number((e.message.match(/http\s+(\d{3})\b/i) || [])[1]) || 0;
    return e;
  },
  _falhaDeEnvio(e, fallback) {
    return { ok: false, motivo: [e && e.code, e && e.message].filter(Boolean).join(' — ') || fallback,
      status: Number(e && e.status) || 0 };
  },

  /* id (uuid) de um paciente na nuvem pela chave de nome; cria minimamente se
     ainda não existir (para o agendamento/registro poder referenciá-lo). */
  async _garantirPaciente(org, item) {
    const id = migracaoFase4._ident(item);
    const key = migracaoFase4._patKey(id);
    if (!key) return null;
    const cacheKey = org + ':' + key;
    if (cloudRel._cachePac[cacheKey]) return cloudRel._cachePac[cacheKey];
    const existente = await cloudRel._lerAtualTab('patients', org, key, 'id,legacy_id,version');
    if (existente && existente.id) { cloudRel._cachePac[cacheKey] = existente.id; return existente.id; }
    /* id.nome extrai o NOME (texto) de qualquer módulo — na ficha de anestesia
       item.paciente é o OBJETO inteiro e não pode ir para a coluna nome. */
    const row = { organization_id: org, legacy_id: key, nome: id.nome || 'Sem nome',
      cpf: id.cpf || null, convenio: id.convenio || item.convenio || null, data: { origem: 'auto' } };
    const ret = await cloudRel._inserirSemSobrescrever('patients', org, key, row, 'id,legacy_id,version');
    const pid = ret && ret.ok && ret.row ? ret.row.id : null;
    if (!pid) throw cloudRel._erroDependencia(ret, 'paciente');
    if (org === cloudRel._org()) cloudRel._cachePac[cacheKey] = pid;
    return pid;
  },

  /* Grava paciente com compare-and-swap por version. */
  async enviarPaciente(item, opts = {}) {
    const contexto = cloudRel._capturarContexto();
    if (!contexto || !item) return { ok: false, motivo: 'offline' };
    if (!(await cloud._garantirToken())) return { ok: false, motivo: 'token' };
    const org = contexto.organizationId;
    if (!cloudRel._contextoValido(contexto, org)) return { ok: false, motivo: 'contexto_trocado' };
    if (item._relOrg && item._relOrg !== org) return { ok: false, motivo: 'outra_clinica', outraClinica: item._relOrg };
    const id = migracaoFase4._ident(item);
    const key = migracaoFase4._patKey(id);
    if (!key) return { ok: false, motivo: 'sem_nome' };

    const row = {
      organization_id: org, legacy_id: key,
      nome: item.nome || id.nome || 'Sem nome',
      cpf: id.cpf || item.cpf || null,
      nascimento: migracaoFase4._dataISO(item.nascimento),
      prontuario: item.prontuario || null,
      convenio: item.plano || item.convenio || null,
      telefone: item.telefone || null, email: item.email || null, sexo: item.sexo || null,
      data: cloudRel._dadosParaNuvem(item)
    };
    const res = await cloudRel._gravarAtomico('patients', org, key, row,
      cloudRel._versao(item), cloudRel._SELECT, r => cloudRel._rowParaItem(r, org), opts.operation);
    if (!cloudRel._contextoValido(contexto, org)) return { ok: false, motivo: 'contexto_trocado', remotoConfirmado: !!(res && res.ok) };
    if (res && res.ok) cloudRel._aplicarMetaLocal('pacientes', item, res.row, org);
    return res;
  },

  /* ---- AGENDA (appointments) — mesmo padrão, legacy_id = _id do compromisso ---- */
  _AG_SELECT: 'id,organization_id,legacy_id,status,scheduled_at,data,version,updated_by,updated_at,deleted_at,last_operation_id,last_operation_checksum',
  _rowParaAgenda(row, org) {
    const d = row.data;
    const base = (d && typeof d === 'object' && (d._id || d.paciente)) ? Object.assign({}, d) : {};
    if (!base._id) base._id = row.legacy_id || ('rel_ag_' + (row.id || '').toString().slice(0, 8));
    if (!base.status && row.status) base.status = row.status;
    if (!base.data && row.scheduled_at) base.data = String(row.scheduled_at).slice(0, 10);
    if (!base.hora && row.scheduled_at && String(row.scheduled_at).length >= 16) base.hora = String(row.scheduled_at).slice(11, 16);
    if (row.updated_at) base._relUpdatedAt = row.updated_at;
    if (row.version != null) base._relVersion = Number(row.version);
    if (row.updated_by) base._relUpdatedBy = row.updated_by;
    if (org || row.organization_id) base._relOrg = org || row.organization_id;
    return base;
  },
  async puxarAgenda() {
    const contexto = cloudRel._capturarContexto(); if (!contexto) return null;
    if (!(await cloud._garantirToken())) return null;
    const org = contexto.organizationId;
    if (!cloudRel._contextoValido(contexto, org)) return null;
    const c = cloud.config();
    try {
      const r = await fetch(c.url + '/rest/v1/appointments?organization_id=eq.' + org +
        '&deleted_at=is.null&select=' + cloudRel._AG_SELECT + '&order=scheduled_at.desc.nullslast',
        { headers: cloud._headers(true) });
      if (!r.ok) return null;
      const rows = await r.json();
      if (!cloudRel._contextoValido(contexto, org)) return null;
      return rows.map(row => cloudRel._rowParaAgenda(row, org));
    } catch (e) { return null; }
  },
  async enviarAgenda(item, opts = {}) {
    const contexto = cloudRel._capturarContexto();
    if (!contexto || !item || !item._id) return { ok: false, motivo: 'offline' };
    if (!(await cloud._garantirToken())) return { ok: false, motivo: 'token' };
    const org = contexto.organizationId;
    if (!cloudRel._contextoValido(contexto, org)) return { ok: false, motivo: 'contexto_trocado' };
    if (item._relOrg && item._relOrg !== org) return { ok: false, motivo: 'outra_clinica', outraClinica: item._relOrg };
    const legacy = item._id;
    let patientId;
    try { patientId = await cloudRel._garantirPaciente(org, item); }
    catch (e) { return cloudRel._falhaDeEnvio(e, 'paciente_nao_confirmado'); }
    if (!cloudRel._contextoValido(contexto, org)) return { ok: false, motivo: 'contexto_trocado' };
    const hora = (item.hora && /^\d{1,2}:\d{2}/.test(item.hora)) ? item.hora : '09:00';
    const sched = migracaoFase4._dataISO(item.data) ? (item.data + 'T' + hora + ':00') : null;
    const row = {
      organization_id: org, legacy_id: legacy, patient_id: patientId,
      scheduled_at: sched, status: item.status || 'agendado', data: cloudRel._dadosParaNuvem(item)
    };
    const res = await cloudRel._gravarAtomico('appointments', org, legacy, row,
      cloudRel._versao(item), cloudRel._AG_SELECT, r => cloudRel._rowParaAgenda(r, org), opts.operation);
    if (!cloudRel._contextoValido(contexto, org)) return { ok: false, motivo: 'contexto_trocado', remotoConfirmado: !!(res && res.ok) };
    if (res && res.ok) cloudRel._aplicarMetaLocal('agenda', item, res.row, org);
    return res;
  },

  /* ===========================================================================
     MOTOR GENÉRICO DE REGISTROS (Fase 6) — demais módulos.
     legacy_id = _id do registro; identidade de paciente/encounter reaproveita
     EXATAMENTE a extração da migração, então um save ATUALIZA a mesma linha
     que a migração criou (idempotente, sem duplicar).
  =========================================================================== */
  MODOS: {
    pre:         { tabela: 'preanesthetic_assessments', enc: true,  finalizavel: true },
    consulta:    { tabela: 'consultations',             enc: true,  finalizavel: true },
    anestesia:   { tabela: 'anesthesia_records',        enc: true,  finalizavel: true },
    recuperacao: { tabela: 'recovery_records',          enc: true,  finalizavel: true },
    risco:       { tabela: 'risk_assessments',          enc: true,  finalizavel: true },
    termo:       { tabela: 'consents',                  enc: true,  finalizavel: true },
    prescricao:  { tabela: 'prescriptions',             enc: false, finalizavel: true },
    documentos:  { tabela: 'documents',                 enc: false, finalizavel: true },
    financeiro:  { tabela: 'finance_entries',           enc: true },
    fin_fechamentos: { tabela: 'cash_closings',          enc: false },
    orcamento:   { tabela: 'quotes',                    enc: false }
  },
  ehModuloRegistro(mod) { return !!cloudRel.MODOS[mod]; },
  suportaModulo(mod) { return mod === 'pacientes' || mod === 'agenda' || !!cloudRel.MODOS[mod]; },
  tabelaDoModulo(mod) {
    if (mod === 'pacientes') return 'patients';
    if (mod === 'agenda') return 'appointments';
    return cloudRel.MODOS[mod] ? cloudRel.MODOS[mod].tabela : null;
  },
  chaveLegada(mod, item) {
    if (!item) return '';
    if (mod === 'pacientes') {
      try { return migracaoFase4._patKey(migracaoFase4._ident(item)); } catch (e) { return ''; }
    }
    return item._id || '';
  },
  _REG_SELECT: 'id,organization_id,legacy_id,encounter_id,status,finalized_at,finalized_by,data,version,updated_by,updated_at,deleted_at,last_operation_id,last_operation_checksum',
  /* O MESMO registro SEM o campo `data` — que é o registro inteiro, com as
     imagens em base64 dentro. Ler só isto custa ~60 bytes por linha em vez de
     alguns KB, e é o que permite descobrir o que mudou sem baixar nada. */
  _REG_SELECT_LEVE: 'id,legacy_id,version,updated_by,updated_at',
  /* Quantos ids cabem num `id=in.(...)`. Uuid tem 36 caracteres; 80 deles dão
     uma URL de ~3 KB, folgada para qualquer servidor. */
  _LOTE_IDS: 80,

  /* Garante o encounter (paciente + data + procedimento) e devolve o uuid. */
  async _garantirEncounter(org, patientId, item) {
    const id = migracaoFase4._ident(item);
    const patKey = migracaoFase4._patKey(id);
    const encKey = migracaoFase4._encKey(patKey, item);
    if (!encKey) return null;
    const cacheKey = org + ':' + encKey;
    if (cloudRel._cacheEnc[cacheKey]) return cloudRel._cacheEnc[cacheKey];
    const ex = await cloudRel._lerAtualTab('encounters', org, encKey, 'id,legacy_id,version');
    if (ex && ex.id) { cloudRel._cacheEnc[cacheKey] = ex.id; return ex.id; }
    const row = {
      organization_id: org, legacy_id: encKey, patient_id: patientId || null,
      procedimento: (typeof item.procedimento === 'string' ? item.procedimento : (item.cirurgia || null)) || null,
      convenio: item.convenio || id.convenio || null,
      data_prevista: migracaoFase4._dataISO(item.data),
      status: 'ativo', data: { origem: 'fase6' }
    };
    const ret = await cloudRel._inserirSemSobrescrever('encounters', org, encKey, row, 'id,legacy_id,version');
    const eid = ret && ret.ok && ret.row ? ret.row.id : null;
    if (!eid) throw cloudRel._erroDependencia(ret, 'atendimento');
    if (org === cloudRel._org()) cloudRel._cacheEnc[cacheKey] = eid;
    return eid;
  },

  /* `org` carimba de QUAL CLÍNICA o registro veio. Sem isso, o registro é um
     órfão: o sistema só sabe que ele existe na nuvem, não em qual banco — e
     salvá-lo com outra clínica aberta o grava na clínica errada, no servidor.
     Ver a trava em `enviarRegistro`. */
  _rowParaRegistro(row, org) {
    const d = row.data;
    const base = (d && typeof d === 'object' && (d._id || d.nome || d.paciente || d.paciente_nome)) ? Object.assign({}, d) : {};
    if (!base._id) base._id = row.legacy_id || ('rel_' + (row.id || '').toString().slice(0, 8));
    if (row.id) base._relId = row.id;
    if (row.encounter_id) base._relEncounterId = row.encounter_id;
    if (row.finalized_at) {
      base._finalizado = true;
      base._finalizadoEm = base._finalizadoEm || row.finalized_at;
      if (row.finalized_by) base._finalizadoPor = row.finalized_by;
    }
    if (row.updated_at) base._relUpdatedAt = row.updated_at;
    if (row.version != null) base._relVersion = Number(row.version);
    if (row.updated_by) base._relUpdatedBy = row.updated_by;
    if (org) base._relOrg = org;
    else if (row.organization_id) base._relOrg = row.organization_id;
    return base;
  },

  /* MESCLA o que veio da nuvem com o que já existe no aparelho.
     Antes isto era só inserção: o registro que JÁ EXISTIA aqui era descartado,
     por mais novo que estivesse lá. Era por isso que o pré-lançamento não
     atravessava — o aparelho do médico já tinha a versão "rascunho" dela, e o
     "enviado" chegava e era jogado fora. O mesmo valia para qualquer correção
     feita no outro aparelho.
     Regra: vence o mais recente. Nunca sobrescreve um registro ABERTO na tela
     (seria puxar o tapete de quem está digitando). */
  _quando(x) {
    if (!x) return '';
    return String(x._relUpdatedAt || x._updatedAt || x.atualizado_em || x._createdAt || '');
  },
  /* Adiar a mesclagem só faz sentido para o que está SENDO EDITADO agora —
     sobrescrever o que a pessoa tem na tela seria apagar o que ela digitou.
     A varredura pegava `form [name="_id"]` da página inteira, e no app TODOS
     os módulos ficam no DOM o tempo todo, apenas escondidos. Bastava alguém
     ter aberto um registro uma vez para o id continuar no campo escondido
     daquele formulário — e daí em diante toda atualização vinda da clínica
     era adiada para sempre, calada. Era assim que um pré-lançamento enviado
     não chegava: chegava e era descartado na porta. */
  _abertoNaTela(id, mod) {
    try {
      if (!id) return false;
      const atual = (typeof state !== 'undefined' && state.currentModule) || '';
      if (mod && atual !== mod) return false;      /* módulo fechado não edita nada */
      const form = document.getElementById('form-' + (mod || atual));
      if (!form) return false;
      const el = form.querySelector('[name="_id"]');
      return !!el && el.value === id;
    } catch (e) { return false; }
  },
  mesclarLocal(mod, remotos) {
    const res = { novos: 0, atualizados: 0, iguais: 0, adiados: 0, naoCouberam: 0, gravou: true };
    if (!Array.isArray(remotos) || !remotos.length) return res;
    const orgAtiva = cloudRel._org();
    if (!orgAtiva || !contextoAba.operational()) { res.gravou = false; return res; }
    remotos = remotos.filter(x => x && x._relOrg === orgAtiva);
    if (!remotos.length) { res.gravou = false; return res; }
    if (typeof STORAGE !== 'undefined' && !STORAGE[mod]) return res;
    const locais = store.list(mod) || [];
    const ix = new Map();
    locais.forEach((x, i) => { if (x && x._id) ix.set(x._id, i); });
    const entraram = [];
    /* O que chega novo entra NA FRENTE. store.save corta a lista em
       HISTORY_MAX a partir do fim — jogado no fim, o que acabou de chegar da
       clínica seria justamente o primeiro a ser cortado na gravação seguinte. */
    const novos = [];
    remotos.forEach(item => {
      if (!item || !item._id) return;
      if (!ix.has(item._id)) { novos.push(item); entraram.push(item._id); res.novos++; return; }
      const i = ix.get(item._id);
      const local = locais[i];
      const vr = cloudRel._versao(item);
      const vl = cloudRel._versao(local);
      const remotoMaisNovo = vr && vl ? vr > vl
        : vr && !vl ? true
          : cloudRel._quando(item) > cloudRel._quando(local);
      if (!remotoMaisNovo) { res.iguais++; return; }
      /* Nunca apaga uma edição local ainda não confirmada. A versão remota
         será tratada como conflito; C2 a preserva também no servidor. */
      const localSemBase = !vl && !local._relUpdatedAt;
      if (cloudRel._abertoNaTela(item._id, mod) || cloudRel._temPendente(mod, item._id) || localSemBase) {
        cloudRel.registrarConflito(mod, local, item, { motivo: 'pull_com_edicao_local' });
        res.adiados++;
        return;
      }
      locais[i] = item; entraram.push(item._id); res.atualizados++;
    });
    if (!res.novos && !res.atualizados) return res;
    const final = novos.concat(locais);
    res.gravou = store.setList(mod, final) !== false;
    /* Confere o que ficou de fato gravado: sem espaço, o socorro poda a lista
       e o registro some sem ninguém avisar. Melhor contar do que supor. */
    try {
      const agora = new Set((store.list(mod) || []).map(x => x && x._id).filter(Boolean));
      res.naoCouberam = entraram.filter(id => !agora.has(id)).length;
    } catch (e) {}
    return res;
  },

  async puxarModulo(mod, opts = {}) {
    const cfg = cloudRel.MODOS[mod]; if (!cfg) return null;
    const contexto = cloudRel._capturarContexto(); if (!contexto) return null;
    if (!(await cloud._garantirToken())) return null;
    const org = contexto.organizationId;
    if (!cloudRel._contextoValido(contexto, org)) return null;
    const c = cloud.config();
    try {
      /* `desde` transforma a leitura periódica em algo barato: só o que mudou
         depois da última passada. É o que permite sincronizar sozinho, de
         minuto em minuto, sem pesar na rede nem no aparelho. */
      const filtroData = opts.desde ? '&updated_at=gt.' + encodeURIComponent(opts.desde) : '';
      const r = await fetch(c.url + '/rest/v1/' + cfg.tabela + '?organization_id=eq.' + org +
        '&deleted_at=is.null' + filtroData + '&select=' + cloudRel._REG_SELECT + '&order=updated_at.desc',
        { headers: cloud._headers(true) });
      if (!r.ok) return null;
      const rows = await r.json();
      if (!cloudRel._contextoValido(contexto, org)) return null;
      return rows.map(row => cloudRel._rowParaRegistro(row, org));
    } catch (e) { return null; }
  },

  /* Mesclar um módulo GASTANDO SÓ O QUE MUDOU.

     `puxarModulo(mod)` sem `desde` baixa o módulo INTEIRO — cada registro com
     o campo `data`, e é lá dentro que moram as imagens em base64. Servia para
     quem chama uma vez e vai embora; virou problema quando passou a rodar de
     novo e de novo: a fila de pré-lançamento roda a cada visita ao Painel, e
     `anestesia` é o módulo mais gordo do sistema. Cada visita pagava o acervo
     completo só para descobrir que nada tinha mudado.

     Aqui o índice vem primeiro (id, legacy_id, updated_at — alguns bytes por
     registro) e o conteúdo só dos que este aparelho não tem nesta versão.
     Passagem sem novidade custa o índice e nada mais.

     Devolve null quando a leitura falhou — meia mesclagem parece sucesso e
     esconde registro. */
  async puxarModuloIncremental(mod) {
    const cfg = cloudRel.MODOS[mod]; if (!cfg) return null;
    const contexto = cloudRel._capturarContexto(); if (!contexto) return null;
    const indice = await cloudRel.puxarIndiceModulo(mod);
    if (!indice || !cloudRel._contextoValido(contexto, contexto.organizationId)) return null;

    /* `_relUpdatedAt` é o carimbo da versão que veio da nuvem. Bate com o de
       lá: a cópia daqui É aquela versão. Edição local mexe em `_updatedAt`,
       não neste — trabalho daqui não faz rebaixar o que já se tinha. */
    const carimbo = new Map();
    try {
      (store.list(mod) || []).forEach(x => { if (x && x._id) carimbo.set(x._id, x._relUpdatedAt || ''); });
    } catch (e) {}
    /* ARQUIVADO aqui não desce de novo. Sem este filtro, tudo o que a pessoa
       tirou do aparelho para liberar espaço voltava a ser baixado em cada
       passagem — e descartado na chegada. O índice devolvido segue completo:
       quem precisa saber o que existe na clínica continua sabendo. */
    const precisam = indice
      .filter(r => carimbo.get(r._idLocal) !== r.updated_at)
      .filter(r => { try { return typeof arquivo === 'undefined' || !arquivo.estaArquivado(mod, r._idLocal); } catch (e) { return true; } })
      .map(r => r.id);

    let remotos = [];
    if (precisam.length) {
      remotos = await cloudRel.puxarPorIds(mod, precisam);
      if (!remotos || !cloudRel._contextoValido(contexto, contexto.organizationId)) return null;
    }
    const m = cloudRel.mesclarLocal(mod, remotos);
    return { indice, baixados: precisam.length, novos: m.novos, atualizados: m.atualizados, iguais: m.iguais, naoCouberam: m.naoCouberam };
  },

  /* O registro local que uma linha do índice representa. O índice não lê
     `data`, então a ponte é por id — e um registro antigo pode estar gravado
     aqui com o legacy ou com o `rel_` derivado do id do banco. */
  localDoIndice(mod, linha) {
    try {
      const ids = (linha && linha._idsPossiveis) || [linha && linha._idLocal];
      const lista = store.list(mod) || [];
      for (const id of ids) { if (!id) continue; const achou = lista.find(x => x && x._id === id); if (achou) return achou; }
    } catch (e) {}
    return null;
  },

  /* ==========================================================================
     LEITURA INCREMENTAL — o índice primeiro, o conteúdo só do que mudou

     Até esta versão, cada passagem baixava TODOS os registros do módulo POR
     INTEIRO — inclusive as imagens em base64 gravadas dentro deles. E isso
     roda a cada 10 minutos com o app aberto, a cada volta de foco, a cada
     login. Com quatro pessoas trabalhando, um acervo de 2 MB era baixado umas
     190 vezes por dia: ~420 MB/dia, ~8 GB/mês. O plano gratuito dá 5 GB.

     Agora são duas etapas. Primeiro o ÍNDICE (id, legacy_id, updated_at),
     que é minúsculo e diz exatamente o que existe e em que versão. Depois o
     CONTEÚDO, e só dos que mudaram. Sincronização com nada novo passa a
     custar alguns KB em vez de alguns MB.

     Por que não usar só o filtro `desde`, que já existia: porque duas coisas
     dependem de conhecer a lista COMPLETA do que está na nuvem — a remoção do
     que deixou de ser visível (visibilidade 'proprios') e a conferência do que
     foi arquivado. Com `desde` puro essas duas deixariam de funcionar em
     silêncio. O índice dá a lista completa e continua sendo barato.
  ========================================================================== */

  /* O _id local que uma linha da nuvem representa — a MESMA regra de
     _rowParaRegistro, mas sem precisar do `data`. Se as duas divergirem, o
     incremental deixa de reconhecer registros e volta a baixar tudo; por isso
     há teste amarrando as duas. */
  /* ==========================================================================
     ETAPA 4 — "VAZIO" E "NÃO CARREGADO" SÃO COISAS DIFERENTES

     O objetivo da etapa era tirar do cache local o posto de fonte da verdade.
     Reescrever as 159 leituras para irem à nuvem seria caro, arriscado num
     sistema em uso clínico — e, depois do Realtime e da escrita contínua,
     quase sem ganho: o cache já é mantido em dia por empurrão.

     O que SOBRAVA de perigoso no cache era outra coisa, e essa a gente viu
     acontecer: um aparelho que nunca sincronizou mostra tela vazia, e tela
     vazia é indistinguível de "não há nada". Foi assim que o painel da
     secretária pareceu funcionar enquanto nada chegava.

     Então o cache continua servindo de leitura — mas passa a saber DIZER que
     nunca falou com a clínica. É a diferença entre uma lista vazia e uma
     lista vazia que se explica.
  ========================================================================== */
  PUXOU_KEY: 'medsys.v7.rel.puxou',

  _puxouMapa() {
    try { return JSON.parse(localStorage.getItem(cloudRel.PUXOU_KEY) || '{}'); }
    catch (e) { return {}; }
  },
  marcarPuxado(mod) {
    try {
      const m = cloudRel._puxouMapa();
      m[mod] = new Date().toISOString();
      localStorage.setItem(cloudRel.PUXOU_KEY, JSON.stringify(m));
    } catch (e) {}
  },
  jaPuxou(mod) { return !!cloudRel._puxouMapa()[mod]; },
  quandoPuxou(mod) { return cloudRel._puxouMapa()[mod] || ''; },

  /* Texto para a tela quando a lista está vazia. Devolve '' quando o vazio é
     legítimo — nem toda lista vazia merece explicação, só a que pode estar
     mentindo. */
  porQueVazio(mod) {
    try {
      if (typeof demo !== 'undefined' && demo.ativo()) return '';
      if (!cloud.estaConfigurado()) return '';
      if (cloudRel.jaPuxou(mod)) return '';           /* falou com a clínica: vazio é vazio */
      const d = cloud.divergencia();
      if (d) return 'Este aparelho está no app como ' + d.app + ' e na nuvem como ' + d.nuvem +
                    ' — enquanto estiver assim nada é carregado.';
      if (!cloud.estaLogado()) return 'Este aparelho ainda não entrou na nuvem — o que a equipe lançou não chegou aqui.';
      if (!cloudRel._org() && cloudRel._semClinicaConfirmado())
        return 'Esta conta não está ligada a nenhuma clínica — nada sincroniza. O gestor resolve em Ajustes → Equipe da nuvem.';
      return 'Ainda não carreguei este módulo da clínica. Pode não estar vazio de verdade.';
    } catch (e) { return ''; }
  },

  _idLocalDaLinha(row) {
    if (!row) return '';
    return row.legacy_id || ('rel_' + String(row.id || '').slice(0, 8));
  },

  /* TODOS os _id que uma linha da nuvem pode representar.
     `_rowParaRegistro` usa `data._id` quando ele existe e só então cai no
     legacy_id — e o índice não lê `data`, justamente para ser barato. No
     caminho normal os dois coincidem (`enviarRegistro` grava
     `legacy_id = item._id`), mas basta uma linha com legacy_id nulo para
     divergirem. E divergir aqui não é detalhe: a limpeza de visibilidade
     apagaria do aparelho um registro que existe na nuvem.
     Por isso o conjunto guarda as duas formas. Errar para o lado de NÃO
     apagar custa uma passagem de convergência; errar para o outro custa o
     registro. */
  _idsPossiveisDaLinha(row) {
    if (!row) return [];
    const ids = [];
    if (row.legacy_id) ids.push(row.legacy_id);
    if (row.id) ids.push('rel_' + String(row.id).slice(0, 8));
    return ids;
  },

  async puxarIndiceModulo(mod) {
    const cfg = cloudRel.MODOS[mod]; if (!cfg) return null;
    const contexto = cloudRel._capturarContexto(); if (!contexto) return null;
    if (!(await cloud._garantirToken())) return null;
    const org = contexto.organizationId;
    if (!cloudRel._contextoValido(contexto, org)) return null;
    const c = cloud.config();
    /* PAGINADO, e não é detalhe: o PostgREST corta a resposta em `max-rows`
       (mil, por padrão) e o resto some calado. Um índice truncado diria que
       registros existentes não estão na nuvem desta clínica — e quem usa esse
       índice para decidir o que NÃO é daqui apagaria do aparelho tudo o que
       ficou além do corte. Índice incompleto é pior que índice nenhum, então
       ou vem inteiro, ou devolve null. */
    const PASSO = 1000;
    const out = [];
    try {
      for (let de = 0; ; de += PASSO) {
        const r = await fetch(c.url + '/rest/v1/' + cfg.tabela + '?organization_id=eq.' + org +
          '&deleted_at=is.null&select=' + cloudRel._REG_SELECT_LEVE +
          '&order=updated_at.desc&limit=' + PASSO + '&offset=' + de,
          { headers: cloud._headers(true) });
        if (!r.ok) return null;
        const rows = await r.json();
        if (!cloudRel._contextoValido(contexto, org)) return null;
        if (!Array.isArray(rows)) return null;
        rows.forEach(row => out.push({
          id: row.id, legacy_id: row.legacy_id, updated_at: row.updated_at,
          _idLocal: cloudRel._idLocalDaLinha(row),
          _idsPossiveis: cloudRel._idsPossiveisDaLinha(row)
        }));
        if (rows.length < PASSO) break;
        /* trava de segurança: acervo absurdo não vira laço infinito */
        if (de > 200000) return null;
      }
      return out;
    } catch (e) { return null; }
  },

  /* Conteúdo de ids específicos, em lotes. Devolve null se QUALQUER lote
     falhar: meia lista parece sincronização bem-sucedida e some registro sem
     ninguém perceber — prefiro não mesclar nada e tentar de novo depois. */
  /* Busca por LEGACY_ID — o `_id` que o aparelho conhece. `puxarPorIds` usa a
     chave do banco, que só quem leu o índice tem em mãos; quem parte de um
     registro daqui parte do legacy. */
  async puxarPorLegacy(mod, legacyIds) {
    const cfg = cloudRel.MODOS[mod]; if (!cfg) return null;
    if (!Array.isArray(legacyIds) || !legacyIds.length) return [];
    const contexto = cloudRel._capturarContexto(); if (!contexto) return null;
    if (!(await cloud._garantirToken())) return null;
    const org = contexto.organizationId;
    if (!cloudRel._contextoValido(contexto, org)) return null;
    const c = cloud.config();
    const out = [];
    for (let i = 0; i < legacyIds.length; i += cloudRel._LOTE_IDS) {
      const lote = legacyIds.slice(i, i + cloudRel._LOTE_IDS);
      try {
        const r = await fetch(c.url + '/rest/v1/' + cfg.tabela + '?organization_id=eq.' + org +
          '&deleted_at=is.null&legacy_id=in.(' + lote.map(encodeURIComponent).join(',') + ')' +
          '&select=' + cloudRel._REG_SELECT,
          { headers: cloud._headers(true) });
        if (!r.ok) return null;
        const rows = await r.json();
        if (!cloudRel._contextoValido(contexto, org)) return null;
        if (!Array.isArray(rows)) return null;
        rows.forEach(row => out.push(cloudRel._rowParaRegistro(row, org)));
      } catch (e) { return null; }
    }
    return out;
  },

  async puxarPorIds(mod, ids) {
    const cfg = cloudRel.MODOS[mod]; if (!cfg) return null;
    if (!Array.isArray(ids) || !ids.length) return [];
    const contexto = cloudRel._capturarContexto(); if (!contexto) return null;
    if (!(await cloud._garantirToken())) return null;
    const org = contexto.organizationId;
    if (!cloudRel._contextoValido(contexto, org)) return null;
    const c = cloud.config();
    const out = [];
    for (let i = 0; i < ids.length; i += cloudRel._LOTE_IDS) {
      const lote = ids.slice(i, i + cloudRel._LOTE_IDS);
      try {
        const r = await fetch(c.url + '/rest/v1/' + cfg.tabela + '?organization_id=eq.' + org +
          '&deleted_at=is.null&id=in.(' + lote.map(encodeURIComponent).join(',') + ')' +
          '&select=' + cloudRel._REG_SELECT,
          { headers: cloud._headers(true) });
        if (!r.ok) return null;
        const rows = await r.json();
        if (!cloudRel._contextoValido(contexto, org)) return null;
        if (!Array.isArray(rows)) return null;
        rows.forEach(row => out.push(cloudRel._rowParaRegistro(row, org)));
      } catch (e) { return null; }
    }
    return out;
  },

  /* ---- EMPURRÃO AUTOMÁTICO DOS PENDENTES ----
     Registro criado enquanto o aparelho NÃO conhecia a clínica (conta ainda
     não vinculada, rede fora, sessão vencida) fica só no aparelho: o espelho
     relacional só acontece no momento do salvar. Era por isso que o que a
     secretária salvava não aparecia para o gestor em outro computador — os
     dados nunca chegaram na clínica.
     Aqui, a cada entrada, o que nunca subiu é enviado em lotes pequenos,
     em silêncio. `_relUpdatedAt` é a marca de "já está na clínica". */
  async empurrarPendentes(opts = {}) {
    const contexto = cloudRel._capturarContexto(); if (!contexto) return null;
    if (!(await cloud._garantirToken())) return null;
    const org = contexto.organizationId;
    if (!cloudRel._contextoValido(contexto, org)) return null;
    const limite = opts.limite || 25;
    let enviados = 0, falhas = 0, restantes = 0;

    const pendentesDe = (lista) => (lista || []).filter(x => x && x._id && !x._relUpdatedAt);

    for (const p of pendentesDe(store.list('pacientes'))) {
      if (!cloudRel._contextoValido(contexto, org)) return { enviados, falhas, restantes, interrompido: true };
      if (enviados + falhas >= limite) { restantes++; continue; }
      if (cloudRel._envioAtivo('pacientes', p._id)) { restantes++; continue; }
      try {
        const r = await cloudRel.enviarPaciente(p);
        if (!cloudRel._contextoValido(contexto, org)) return { enviados, falhas, restantes, interrompido: true };
        if (r && r.ok) { cloudRel._filaTirar('pacientes', p._id); enviados++; }
        else { cloudRel._filaPor('pacientes', p._id, (r && r.motivo) || 'rede'); falhas++; }
      }
      catch (e) { falhas++; }
    }
    for (const a of pendentesDe(store.list('agenda'))) {
      if (!cloudRel._contextoValido(contexto, org)) return { enviados, falhas, restantes, interrompido: true };
      if (enviados + falhas >= limite) { restantes++; continue; }
      if (cloudRel._envioAtivo('agenda', a._id)) { restantes++; continue; }
      try {
        const r = await cloudRel.enviarAgenda(a);
        if (!cloudRel._contextoValido(contexto, org)) return { enviados, falhas, restantes, interrompido: true };
        if (r && r.ok) { cloudRel._filaTirar('agenda', a._id); enviados++; }
        else { cloudRel._filaPor('agenda', a._id, (r && r.motivo) || 'rede'); falhas++; }
      } catch (e) { falhas++; }
    }
    for (const mod of Object.keys(cloudRel.MODOS)) {
      for (const it of pendentesDe(store.list(mod))) {
        if (!cloudRel._contextoValido(contexto, org)) return { enviados, falhas, restantes, interrompido: true };
        if (enviados + falhas >= limite) { restantes++; continue; }
        if (cloudRel._envioAtivo(mod, it._id)) { restantes++; continue; }
        try { const r = await cloudRel.enviarRegistro(mod, it); (r && r.ok) ? enviados++ : falhas++; }
        catch (e) { falhas++; }
      }
    }
    if (enviados && !opts.silent) toast('☁️ ' + enviados + ' registro(s) que faltavam foram para a clínica');
    return { enviados, falhas, restantes };
  },

  /* ---- TRANSFERIR TUDO PARA A CLÍNICA (organização) ----
     Envia todos os registros carregados nesta sessão para a organização atual, em
     lote. Serve para "mudar o banco de casa": ao criar/entrar numa clínica,
     leva o histórico junto. É idempotente (upsert por legacy_id) e não apaga
     nada — o que já estiver lá é atualizado. */
  async enviarTudoParaClinica(opts = {}) {
    const contexto = cloudRel._capturarContexto();
    if (!contexto) { toast('Conecte-se à nuvem primeiro', 'warn'); return null; }
    if (!(await cloud._garantirToken())) { toast(cloud.motivoSemToken(), 'warn'); return null; }
    const org = contexto.organizationId;
    if (!cloudRel._contextoValido(contexto, org)) return null;
    const mods = Object.keys(cloudRel.MODOS);
    const total = mods.reduce((s, m) => s + (store.list(m) || []).length, 0) + (store.list('pacientes') || []).length;
    if (!total) { toast('Não há registros carregados nesta sessão para enviar.', 'warn'); return null; }
    if (!opts.silent && !confirm('Enviar ' + total + ' registro(s) carregado(s) nesta sessão para a sua clínica na nuvem?\n\nNada é apagado e versões remotas mais novas não são sobrescritas silenciosamente.')) return null;
    const prog = (t) => { const el = document.getElementById('clinica-envio-prog'); if (el) el.textContent = t; };
    let ok = 0, falhou = 0, feitos = 0;
    /* pacientes primeiro (os registros se penduram neles) */
    for (const p of (store.list('pacientes') || [])) {
      if (!cloudRel._contextoValido(contexto, org)) return { ok, falhou, interrompido: true };
      feitos++; prog('⏳ ' + feitos + '/' + total + ' — pacientes');
      try { const r = await cloudRel.enviarPaciente(p); (r && r.ok) ? ok++ : falhou++; } catch (e) { falhou++; }
    }
    for (const mod of mods) {
      const lst = store.list(mod) || [];
      for (const item of lst) {
        if (!cloudRel._contextoValido(contexto, org)) return { ok, falhou, interrompido: true };
        feitos++; prog('⏳ ' + feitos + '/' + total + ' — ' + mod);
        if (!item || !item._id) { falhou++; continue; }
        try { const r = await cloudRel.enviarRegistro(mod, item); (r && r.ok) ? ok++ : falhou++; } catch (e) { falhou++; }
      }
    }
    prog('');
    toast('🏥 Transferência concluída — ' + ok + ' registro(s) na clínica' + (falhou ? ' · ' + falhou + ' falhou(aram)' : ''), falhou ? 'warn' : 'success');
    return { ok, falhou };
  },

  async enviarRegistro(mod, item, opts = {}) {
    const cfg = cloudRel.MODOS[mod];
    if (!cfg) return { ok: false, motivo: 'mod' };
    const contexto = cloudRel._capturarContexto();
    if (!contexto || !item || !item._id) return { ok: false, motivo: 'offline' };
    if (!(await cloud._garantirToken())) return { ok: false, motivo: 'token' };
    const org = contexto.organizationId;
    if (!cloudRel._contextoValido(contexto, org)) return { ok: false, motivo: 'contexto_trocado' };
    /* O REGISTRO NÃO MUDA DE CLÍNICA.

       `organization_id` da linha era sempre a clínica ABERTA AGORA, nunca a do
       registro. Um registro da clínica A que estivesse no aparelho ia para a
       clínica B no servidor no instante em que alguém o salvasse com B aberta.
       Não é um problema de gaveta: a gaveta protege a tela, e isto escreve no
       banco. O prontuário de um paciente de uma clínica passava a existir
       dentro de outra.

       Com o carimbo `_relOrg`, o registro diz de onde é, e a gravação recusa.
       Registro criado aqui (sem carimbo) é desta clínica e segue normalmente —
       é ele que recebe o carimbo ao subir pela primeira vez. */
    if (item._relOrg && item._relOrg !== org) {
      return { ok: false, motivo: 'outra_clinica', outraClinica: item._relOrg };
    }
    let preparo = null;
    try {
      preparo = await prontuario.prepararParaNuvem(mod, item, { organizationId: org });
    } catch (e) {
      return Object.assign(cloudRel._falhaDeEnvio(e, 'anexo'), {
        detalhe: e && e.message || 'falha ao preparar anexo'
      });
    }
    if (!cloudRel._contextoValido(contexto, org)) return { ok: false, motivo: 'contexto_trocado' };
    const legacy = item._id;
    let patientId, encounterId = null;
    try {
      patientId = await cloudRel._garantirPaciente(org, item);
      if (!cloudRel._contextoValido(contexto, org)) return { ok: false, motivo: 'contexto_trocado' };
      if (cfg.enc) encounterId = await cloudRel._garantirEncounter(org, patientId, item);
    } catch (e) { return cloudRel._falhaDeEnvio(e, 'dependencia_nao_confirmada'); }
    if (!cloudRel._contextoValido(contexto, org)) return { ok: false, motivo: 'contexto_trocado' };
    if (preparo.contexto && !prontuario._contextoAindaAtivo(preparo.contexto)) {
      return { ok: false, motivo: 'contexto_trocado' };
    }
    const row = { organization_id: org, legacy_id: legacy, patient_id: patientId,
      data: preparo.dados };
    if (cfg.tabela !== 'quotes') row.encounter_id = encounterId;   // quotes não usa encounter aqui
    /* O carimbo canônico de finalização vive em colunas do banco. Sem isto o
       trigger via apenas data._finalizado e uma edição posterior ainda podia
       atravessar como se a linha continuasse rascunho. */
    if (cfg.finalizavel) {
      row.status = item._finalizado ? 'finalized' : (item.status || 'draft');
      if (item._finalizado) row.finalized_at = item._finalizadoEm || new Date().toISOString();
    }
    const res = await cloudRel._gravarAtomico(cfg.tabela, org, legacy, row,
      cloudRel._versao(item), cloudRel._REG_SELECT, r => cloudRel._rowParaRegistro(r, org), opts.operation);
    if (!cloudRel._contextoValido(contexto, org)) {
      return { ok: false, motivo: 'contexto_trocado_apos_confirmacao', remotoConfirmado: !!(res && res.ok) };
    }
    if (res && res.ok) {
      /* A gravação pode ter terminado exatamente enquanto alguém saiu e outra
         pessoa entrou neste computador. O servidor recebeu a identidade
         original; o cache da sessão nova não recebe nem o recibo nem a
         limpeza do binário da anterior. */
      if (preparo.contexto && !prontuario._contextoAindaAtivo(preparo.contexto)) {
        return { ok: false, motivo: 'contexto_trocado_apos_confirmacao', remotoConfirmado: true };
      }
      cloudRel._aplicarMetaLocal(mod, item, res.row, org);
      prontuario.confirmarNaNuvem(mod, item, preparo);
      try {
        await cloudRel.registrarAnexos(mod, item, {
          contexto: preparo.contexto, organizationId: org, patientId, encounterId
        });
      } catch (e) {}
    }
    return res;
  },

  /* ==========================================================================
     CONFLITOS DURÁVEIS

     O modal não é armazenamento. Antes, "Decidir depois" fechava a única
     cópia organizada do conflito e um reload apagava o contexto. Agora os dois
     lados ficam em memória e em `sync_conflicts`; só a decisão muda o status.
     Indisponibilidade confirmada permite um snapshot cifrado do conflito
     ainda não recebido pelo servidor. O recibo remove essa cópia offline.
  ========================================================================== */
  CONFLITOS_KEY: 'medsys.v7.rel.conflitos',
  _conflitosMemoria: [], _contextoConflitos: null,
  _persistenciasConflitos: new Map(),
  _clone(v) {
    try { return JSON.parse(JSON.stringify(v == null ? {} : v)); }
    catch (e) { return Object.assign({}, v || {}); }
  },
  _donoConflitos() {
    try { const s = cloud.session(); return (s && s.user && s.user.id) || ''; }
    catch (e) { return ''; }
  },
  _conflitosTodos() {
    if (!contextoAba.operational()) { cloudRel._limparConflitosMemoria(); return []; }
    if (!contextoAba.corresponde(cloudRel._contextoConflitos)) {
      cloudRel._limparConflitosMemoria(); cloudRel._contextoConflitos = contextoAba.capturar();
    }
    return cloudRel._conflitosMemoria;
  },
  _conflitosGravar(a) {
    cloudRel._conflitosTodos();
    if (!contextoAba.corresponde(cloudRel._contextoConflitos)) return false;
    cloudRel._conflitosMemoria = (a || []).filter(x => x && x.organizationId === cloudRel._org());
    return true;
  },
  _limparConflitosMemoria() {
    cloudRel._conflitosMemoria = []; cloudRel._contextoConflitos = null;
    cloudRel._persistenciasConflitos.clear();
  },
  _persistirConflitoOffline(entry, contexto, opts = {}) {
    if (!entry || (entry.synced && !opts.resolutionOnly) || !contextoAba.corresponde(contexto)) return Promise.resolve(false);
    /* Uma decisão ainda não confirmada é uma intenção; as versões clínicas
       já recebidas pelo servidor não precisam ser copiadas de volta ao disco. */
    const payload = opts.resolutionOnly ? {
      clientId: entry.clientId, ownerId: entry.ownerId, organizationId: entry.organizationId,
      mod: entry.mod, tabela: entry.tabela, legacyId: entry.legacyId, operation: entry.operation,
      status: 'pending', synced: true, serverId: entry.serverId,
      resolutionRequested: cloudRel._clone(entry.resolutionRequested), snapshotType: 'resolution'
    } : cloudRel._clone(entry);
    let escrita;
    try { escrita = filaCifrada.salvarSnapshot('conflicts', entry.clientId, payload); }
    catch (e) { escrita = Promise.reject(e); }
    const tarefa = Promise.resolve(escrita).then(res => {
      if (contextoAba.corresponde(contexto)) entry.offlineDurable = !!(res && res.durable);
      return !!(res && res.durable);
    }).catch(() => {
      if (contextoAba.corresponde(contexto)) {
        entry.offlineDurable = false;
        try { toast('O conflito está apenas em memória: o cofre offline não confirmou proteção.', 'warn'); } catch (e) {}
      }
      return false;
    });
    cloudRel._persistenciasConflitos.set(entry.clientId, tarefa);
    return tarefa;
  },
  async _removerConflitoOffline(clientId, contexto) {
    if (!contextoAba.corresponde(contexto)) return false;
    try {
      /* Tombstone monotônico impede uma cifragem em voo de recriar o payload
         depois do recibo. A evidência canônica já pertence ao servidor. */
      await filaCifrada.removerSnapshot('conflicts', clientId);
      if (!contextoAba.corresponde(contexto)) return false;
      cloudRel._persistenciasConflitos.delete(clientId);
      return true;
    } catch (e) { return false; }
  },
  async restaurarConflitosOffline() {
    if (!contextoAba.operational()) return 0;
    const contexto = contextoAba.capturar();
    cloudRel._conflitosTodos();
    const snapshots = await filaCifrada.listarSnapshots('conflicts');
    if (!contextoAba.corresponde(contexto)) return 0;
    let restaurados = 0;
    for (const snap of snapshots || []) {
      const entry = snap && snap.payload;
      if (!entry || entry.clientId !== snap.key || entry.organizationId !== contexto.organizationId ||
          entry.ownerId !== contexto.userId) continue;
      const lista = cloudRel._conflitosTodos();
      if (lista.some(x => x.clientId === entry.clientId)) continue;
      entry.offlineDurable = true; lista.push(entry); restaurados++;
    }
    try { nuvemEstado.renderMenu(); } catch (e) {}
    return restaurados;
  },
  _conflitosLer() {
    const dono = cloudRel._donoConflitos();
    /* Computador compartilhado: sem uma sessão Supabase identificável, não
       mostramos nem permitimos decidir conflito algum. O gestor pode ver os
       conflitos da organização porque a própria RLS lhe dá esse papel; os
       demais veem somente os que criaram. */
    if (!dono) return [];
    let gestor = false;
    try { gestor = (auth.usuarioAtual() || {}).role === 'gestor'; } catch (e) {}
    return cloudRel._conflitosTodos().filter(x => x && (x.ownerId === dono || (gestor && x.serverVisible)));
  },
  conflitosPendentes() { return cloudRel._conflitosLer().filter(x => x.status === 'pending').length; },
  _conflitoSalvar(entry) {
    const a = cloudRel._conflitosTodos();
    const i = a.findIndex(x => x && x.clientId === entry.clientId);
    if (i >= 0) a[i] = entry; else a.push(entry);
    cloudRel._conflitosGravar(a);
    if (!entry.synced && typeof navigator !== 'undefined' && navigator.onLine === false) {
      cloudRel._persistirConflitoOffline(entry, contextoAba.capturar());
    } else if (entry.resolutionRequested && typeof navigator !== 'undefined' && navigator.onLine === false) {
      cloudRel._persistirConflitoOffline(entry, contextoAba.capturar(), { resolutionOnly: true });
    }
    try { nuvemEstado.renderMenu(); } catch (e) {}
    try { syncStatus.refresh(); } catch (e) {}
  },
  _conflitoRemover(clientId) {
    cloudRel._conflitosGravar(cloudRel._conflitosTodos().filter(x => x && x.clientId !== clientId));
    cloudRel._removerConflitoOffline(clientId, contextoAba.capturar());
    try { nuvemEstado.renderMenu(); } catch (e) {}
  },
  _hashConflito(v) {
    let s = ''; try { s = JSON.stringify(v || {}); } catch (e) { s = String(v || ''); }
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return (h >>> 0).toString(36) + ':' + s.length;
  },
  registrarConflito(mod, local, nuvem, opts = {}) {
    try {
      const tabela = opts.tabela || cloudRel.tabelaDoModulo(mod) || 'drafts';
      const legacy = opts.legacyId || cloudRel.chaveLegada(mod, local) || (local && (local.id || local._id));
      if (!mod || !tabela || !legacy) return null;
      const ownerId = cloudRel._donoConflitos();
      const baseVersion = opts.baseVersion || (tabela === 'drafts' && local && local._draftVersion) || cloudRel._versao(local) || null;
      const serverVersion = opts.serverVersion || (tabela === 'drafts' && nuvem && nuvem._draftVersion) || cloudRel._versao(nuvem) || null;
      const operation = opts.operation || 'upsert';
      const fingerprint = [mod, tabela, legacy, operation, baseVersion || '', serverVersion || '',
        cloudRel._hashConflito(local), cloudRel._hashConflito(nuvem)].join('|');
      const existente = cloudRel._conflitosLer().find(x => x.status === 'pending' && x.fingerprint === fingerprint);
      if (existente) { cloudRel._enviarConflito(existente); return existente; }
      const changedFields = Array.from(new Set(Object.keys(local || {}).concat(Object.keys(nuvem || {}))))
        .filter(k => k[0] !== '_' && JSON.stringify(local && local[k]) !== JSON.stringify(nuvem && nuvem[k]));
      const entry = {
        clientId: utils.uid(), ownerId,
        organizationId: opts.organizationId || (local && local._relOrg) || (nuvem && nuvem._relOrg) || cloudRel._org() || null,
        mod, tabela, legacyId: String(legacy), operation,
        baseVersion, serverVersion,
        proposed: cloudRel._clone(local), canonical: cloudRel._clone(nuvem),
        metadata: { cloudUpdatedAt: opts.cloudUpdatedAt || (nuvem && nuvem._relUpdatedAt) || null,
          motivo: opts.motivo || 'versao_divergente',
          proposedBy: ownerId, canonicalBy: (nuvem && nuvem._relUpdatedBy) || null,
          receivedAt: new Date().toISOString(), changedFields,
          draftModule: tabela === 'drafts' ? (opts.draftModule || (String(legacy).startsWith('live_') ? 'live:' + mod : mod)) : null,
          /* `cash_closings` usa a permissão pública `financeiro` no banco,
             mas conserva a chave técnica local para repintar a coleção certa. */
          clientModule: mod === 'fin_fechamentos' ? mod : null },
        status: 'pending', createdAt: new Date().toISOString(), synced: false,
        fingerprint
      };
      cloudRel._conflitoSalvar(entry);       // memória primeiro; servidor é a evidência online
      cloudRel._enviarConflito(entry);
      return entry;
    } catch (e) { return null; }
  },
  async _enviarConflito(entry) {
    if (!entry || !cloudRel.disponivel()) return false;
    const contexto = cloudRel._capturarContexto();
    if (!contexto) return false;
    if (!(await cloud._garantirToken())) return false;
    const org = contexto.organizationId;
    if (!cloudRel._contextoValido(contexto, org)) return false;
    if (!org || (entry.organizationId && entry.organizationId !== org)) return false;
    entry.organizationId = org;
    const c = cloud.config();
    const row = {
      organization_id: org,
      client_conflict_id: entry.clientId,
      module: entry.tabela === 'cash_closings' ? 'financeiro' : entry.mod,
      table_name: entry.tabela,
      record_legacy_id: entry.legacyId,
      operation: entry.operation,
      base_version: entry.baseVersion,
      server_version: entry.serverVersion,
      proposed_data: cloudRel._dadosParaNuvem(entry.proposed),
      canonical_data: cloudRel._dadosParaNuvem(entry.canonical),
      metadata: entry.metadata || {}
    };
    try {
      const r = await fetch(c.url + '/rest/v1/sync_conflicts?on_conflict=organization_id,client_conflict_id&select=id,status', {
        method: 'POST',
        headers: Object.assign({}, cloud._headers(true), {
          'Content-Type': 'application/json', 'Prefer': 'resolution=ignore-duplicates,return=representation'
        }),
        body: JSON.stringify([row])
      });
      if (!r.ok) {
        if (persistenciaCloudFirst.indisponivel({ status: r.status })) {
          await cloudRel._persistirConflitoOffline(entry, contexto);
        }
        return false;
      }
      const rows = await r.json().catch(() => []);
      if (!cloudRel._contextoValido(contexto, org)) return false;
      let confirmado = rows && rows[0] ? rows[0] : null;
      /* `ignore-duplicates` devolve lista vazia quando a primeira tentativa
         chegou ao banco, mas a resposta se perdeu. Antes isso era marcado
         como sincronizado sem confirmar que a evidência realmente existia.
         A releitura transforma a retentativa em recibo idempotente. */
      if (!confirmado) {
        const q = await fetch(c.url + '/rest/v1/sync_conflicts?organization_id=eq.' + encodeURIComponent(org) +
          '&client_conflict_id=eq.' + encodeURIComponent(entry.clientId) + '&select=id,status',
          { headers: cloud._headers(true) });
        if (!q.ok) {
          if (persistenciaCloudFirst.indisponivel({ status: q.status })) {
            await cloudRel._persistirConflitoOffline(entry, contexto);
          }
          return false;
        }
        const existentes = await q.json().catch(() => []);
        if (!cloudRel._contextoValido(contexto, org)) return false;
        confirmado = existentes && existentes[0] ? existentes[0] : null;
      }
      if (!confirmado) return false;
      entry.synced = true;
      entry.serverId = confirmado.id;
      await cloudRel._removerConflitoOffline(entry.clientId, contexto);
      if (!cloudRel._contextoValido(contexto, org)) return false;
      if (confirmado.status && confirmado.status !== 'pending') {
        cloudRel._conflitoRemover(entry.clientId);
        return true;
      }
      cloudRel._conflitoSalvar(entry);
      if (entry.resolutionRequested || entry.status !== 'pending') return cloudRel._resolverConflitoServidor(entry);
      return true;
    } catch (e) {
      if (persistenciaCloudFirst.indisponivel(null, e)) await cloudRel._persistirConflitoOffline(entry, contexto);
      return false;
    }
  },
  async _resolverConflitoServidor(entry) {
    if (!entry || !entry.synced || (!entry.resolutionRequested && entry.status === 'pending') || !cloudRel.disponivel()) return false;
    const contexto = cloudRel._capturarContexto();
    if (!contexto) return false;
    if (!(await cloud._garantirToken())) return false;
    const org = contexto.organizationId;
    if (!cloudRel._contextoValido(contexto, org) || entry.organizationId !== org) return false;
    const decisao = entry.resolutionRequested || { status: entry.status, resolution: entry.resolution || {} };
    const c = cloud.config();
    try {
      const r = await fetch(c.url + '/rest/v1/sync_conflicts?organization_id=eq.' + encodeURIComponent(org) +
        '&client_conflict_id=eq.' + encodeURIComponent(entry.clientId) + '&status=eq.pending&select=id,status', {
        method: 'PATCH',
        headers: Object.assign({}, cloud._headers(true), { 'Content-Type': 'application/json', 'Prefer': 'return=representation' }),
        body: JSON.stringify({ status: decisao.status, resolution: decisao.resolution || {} })
      });
      if (!r.ok) {
        if (persistenciaCloudFirst.indisponivel({ status: r.status })) {
          await cloudRel._persistirConflitoOffline(entry, contexto, { resolutionOnly: true });
        }
        return false;
      }
      const alteradas = await r.json().catch(() => []);
      if (!cloudRel._contextoValido(contexto, org)) return false;
      let confirmado = !!(alteradas && alteradas[0] && alteradas[0].status !== 'pending');
      /* Zero linhas pode significar que outro aparelho já resolveu. Só
         removemos a cópia local depois de confirmar que a evidência existe no
         servidor e já não está pendente. Falha/RLS nunca vira perda local. */
      if (!confirmado) {
        const q = await fetch(c.url + '/rest/v1/sync_conflicts?organization_id=eq.' + encodeURIComponent(org) +
          '&client_conflict_id=eq.' + encodeURIComponent(entry.clientId) + '&select=id,status',
          { headers: cloud._headers(true) });
        if (q.ok) {
          const rows = await q.json().catch(() => []);
          if (!cloudRel._contextoValido(contexto, org)) return false;
          confirmado = !!(rows && rows[0] && rows[0].status !== 'pending');
        } else if (persistenciaCloudFirst.indisponivel({ status: q.status })) {
          await cloudRel._persistirConflitoOffline(entry, contexto, { resolutionOnly: true });
        }
      }
      if (!confirmado) return false;
      cloudRel._conflitoRemover(entry.clientId); // evidência permanece no servidor
      return true;
    } catch (e) {
      if (persistenciaCloudFirst.indisponivel(null, e)) {
        await cloudRel._persistirConflitoOffline(entry, contexto, { resolutionOnly: true });
      }
      return false;
    }
  },
  resolverConflito(clientId, escolha, dados) {
    const entry = cloudRel._conflitosLer().find(x => x && x.clientId === clientId);
    const org = contextoAba.organizationId();
    if (!entry || !org || entry.organizationId !== org) return false;
    const mapa = { local: 'resolved_local', remote: 'resolved_remote', merged: 'resolved_merged' };
    entry.resolutionRequested = {
      status: mapa[escolha] || escolha || 'resolved_merged',
      resolution: { escolha: escolha || 'merged', dados: cloudRel._clone(dados || {}), em: new Date().toISOString() }
    };
    cloudRel._conflitoSalvar(entry);
    if (entry.synced) cloudRel._resolverConflitoServidor(entry);
    else cloudRel._enviarConflito(entry);
    return true;
  },
  _conflitoDaLinha(row) {
    if (!row || !row.client_conflict_id) return null;
    const metadata = cloudRel._clone(row.metadata);
    const modCliente = row.table_name === 'cash_closings' && metadata.clientModule === 'fin_fechamentos'
      ? 'fin_fechamentos' : row.module;
    return {
      clientId: row.client_conflict_id, ownerId: row.created_by || '',
      organizationId: row.organization_id, mod: modCliente,
      tabela: row.table_name, legacyId: row.record_legacy_id,
      operation: row.operation || 'upsert', baseVersion: row.base_version,
      serverVersion: row.server_version,
      proposed: cloudRel._clone(row.proposed_data), canonical: cloudRel._clone(row.canonical_data),
      metadata, status: row.status || 'pending',
      resolution: cloudRel._clone(row.resolution), createdAt: row.created_at,
      synced: true, serverId: row.id, serverVisible: true,
      fingerprint: [row.module, row.table_name, row.record_legacy_id, row.operation || 'upsert',
        row.base_version || '', row.server_version || '', cloudRel._hashConflito(row.proposed_data),
        cloudRel._hashConflito(row.canonical_data)].join('|')
    };
  },
  receberConflitoLinha(row) {
    const entry = cloudRel._conflitoDaLinha(row);
    if (!entry) return false;
    const org = cloudRel._org();
    if (!org || entry.organizationId !== org) return false;
    if (entry.status !== 'pending') {
      cloudRel._conflitoRemover(entry.clientId);
      return true;
    }
    const local = cloudRel._conflitosTodos().find(x => x.clientId === entry.clientId);
    if (local && local.resolutionRequested) entry.resolutionRequested = local.resolutionRequested;
    cloudRel._conflitoSalvar(entry);
    if (!entry.resolutionRequested) cloudRel._removerConflitoOffline(entry.clientId, contextoAba.capturar());
    return true;
  },
  async puxarConflitos() {
    if (!cloudRel.disponivel()) return 0;
    const contexto = cloudRel._capturarContexto();
    if (!contexto) return 0;
    if (!(await cloud._garantirToken())) return 0;
    const org = contexto.organizationId;
    if (!cloudRel._contextoValido(contexto, org)) return 0;
    const c = cloud.config();
    try {
      /* A RLS entrega somente os conflitos do próprio usuário ou, para o
         gestor, os da organização. Não há filtro apenas local que possa
         ampliar esse alcance. */
      const r = await fetch(c.url + '/rest/v1/sync_conflicts?organization_id=eq.' + encodeURIComponent(org) +
        '&status=eq.pending&select=id,organization_id,client_conflict_id,module,table_name,record_legacy_id,' +
        'operation,base_version,server_version,proposed_data,canonical_data,metadata,status,resolution,' +
        'created_by,created_at&order=created_at.asc&limit=1000', { headers: cloud._headers(true) });
      if (!r.ok) return 0;
      const rows = await r.json().catch(() => []);
      if (!cloudRel._contextoValido(contexto, org)) return 0;
      let recebidos = 0;
      (Array.isArray(rows) ? rows : []).filter(row => row && row.organization_id === org)
        .forEach(row => { if (cloudRel.receberConflitoLinha(row)) recebidos++; });
      return recebidos;
    } catch (e) { return 0; }
  },
  async drenarConflitos() {
    if (!cloudRel.disponivel()) return null;
    const contexto = cloudRel._capturarContexto();
    if (!contexto) return null;
    try { await cloudRel.restaurarConflitosOffline(); } catch (e) {}
    if (!cloudRel._contextoValido(contexto, contexto.organizationId)) return null;
    let enviados = 0;
    for (const entry of cloudRel._conflitosLer().slice(0, 40)) {
      if (!cloudRel._contextoValido(contexto, contexto.organizationId)) return null;
      const ok = entry.synced
        ? (entry.status === 'pending' ? true : await cloudRel._resolverConflitoServidor(entry))
        : await cloudRel._enviarConflito(entry);
      if (ok) enviados++;
    }
    if (!cloudRel._contextoValido(contexto, contexto.organizationId)) return null;
    const recebidos = await cloudRel.puxarConflitos();
    if (!cloudRel._contextoValido(contexto, contexto.organizationId)) return null;
    return { enviados, recebidos, pendentes: cloudRel.conflitosPendentes() };
  },
  abrirConflitosPendentes() {
    const lista = cloudRel._conflitosLer().filter(x => x.status === 'pending');
    if (!lista.length) { toast('Não há conflitos pendentes.'); return; }
    const corpo = '<p style="font-size:.86rem;color:var(--text-soft)">As duas versões estão preservadas. Abra cada item e escolha com calma.</p>' +
      '<div style="max-height:55vh;overflow:auto">' + lista.map(x =>
        '<button class="btn" style="display:flex;width:100%;justify-content:space-between;margin:5px 0" onclick="cloudRel._abrirConflito(' + utils.jsArg(x.clientId) + ')">' +
        '<span>⚠️ ' + utils.escapeHTML(x.mod) + ' · ' + utils.escapeHTML(x.operation === 'delete' || x.operation === 'draft_delete' ? 'exclusão' : 'edição') + '</span>' +
        '<small>' + utils.escapeHTML(utils.formatarDataHora(x.createdAt)) + '</small></button>').join('') + '</div>';
    modal.open('Conflitos preservados (' + lista.length + ')', corpo, '<button class="btn" onclick="modal.close()">Fechar</button>');
  },
  _abrirConflito(clientId) {
    const e = cloudRel._conflitosLer().find(x => x.clientId === clientId && x.status === 'pending');
    if (!e) { cloudRel.abrirConflitosPendentes(); return; }
    if (e.operation === 'delete' || e.operation === 'draft_delete') {
      const permanente = e.operation === 'delete' && e.canonical && e.canonical._finalizado;
      modal.open('⚠️ Conflito de exclusão',
        '<p>' + (permanente
          ? 'A versão da nuvem foi finalizada e agora é permanente. Ela não pode ser excluída; correções devem ser feitas por adendo.'
          : 'O item mudou na nuvem depois que este aparelho pediu a exclusão. A versão atual foi preservada.') + '</p>',
        (permanente ? '' : '<button class="btn btn-danger" onclick="cloudRel._conflitoConfirmarExclusao(' + utils.jsArg(e.clientId) + ')">Excluir a versão atual</button>') +
        '<button class="btn" onclick="cloudRel._conflitoCancelarExclusao(' + utils.jsArg(e.clientId) + ')">Manter a versão da nuvem</button>' +
        '<button class="btn btn-ghost" onclick="modal.close()">Decidir depois</button>');
      return;
    }
    if (e.tabela === 'drafts') {
      if (e.metadata && String(e.metadata.draftModule || '').startsWith('live:')) {
        cloudRel._abrirConflitoEdicaoViva(e); return;
      }
      modal.open('📝 Conflito de rascunho preservado',
        '<p>As duas versões foram mantidas em abas separadas; nenhuma digitação foi descartada.</p>',
        '<button class="btn btn-primary" onclick="cloudRel.resolverConflito(' + utils.jsArg(e.clientId) + ',\'merged\');modal.close()">Entendi</button>');
      return;
    }
    modal.close();
    if (e.mod === 'pacientes') pacientes._resolverConflito(e.proposed, e.canonical, e.metadata.cloudUpdatedAt, e.clientId);
    else if (e.mod === 'agenda') agenda._resolverConflito(e.proposed, e.canonical, e.metadata.cloudUpdatedAt, e.clientId);
    else cloudRel._resolverConflitoRegistro(e.mod, e.proposed, e.canonical, e.metadata.cloudUpdatedAt, e.clientId);
  },
  _abrirConflitoEdicaoViva(entry) {
    const contexto = contextoAba.capturar();
    if (!contextoAba.corresponde(contexto) || entry.organizationId !== contexto.organizationId) return;
    modal.open('⚠️ Duas edições do formulário preservadas',
      '<div id="live-draft-conflict-review"></div>', '');
    const corpo = document.getElementById('live-draft-conflict-review');
    if (!corpo) return;
    const texto = document.createElement('p');
    texto.textContent = 'Escolha a versão de recuperação. A digitação posterior continua protegida, e a decisão só termina após confirmação da nuvem.';
    corpo.appendChild(texto);
    for (const [titulo, dados] of [['Sua edição', entry.proposed], ['Versão da nuvem', entry.canonical]]) {
      const label = document.createElement('strong'); label.textContent = titulo; corpo.appendChild(label);
      const detalhe = document.createElement('pre'); detalhe.style.whiteSpace = 'pre-wrap';
      detalhe.textContent = JSON.stringify((dados && dados.dados) || {}, null, 2); corpo.appendChild(detalhe);
    }
    for (const [escolha, titulo] of [['local', 'Preservar minha edição na nuvem'], ['remote', 'Usar a versão da nuvem']]) {
      const btn = document.createElement('button'); btn.type = 'button'; btn.className = 'btn'; btn.textContent = titulo;
      btn.addEventListener('click', async () => {
        if (!contextoAba.corresponde(contexto)) return;
        btn.disabled = true;
        try {
          const ok = await cloudRel._resolverConflitoEdicaoViva(entry.clientId, escolha, contexto);
          if (ok && contextoAba.corresponde(contexto)) modal.close();
        } catch (e) {
          if (contextoAba.corresponde(contexto)) {
            toast('A nuvem não confirmou a escolha; as versões continuam preservadas.', 'warn');
          }
        } finally { if (contextoAba.corresponde(contexto)) btn.disabled = false; }
      });
      corpo.appendChild(btn);
    }
  },
  async _resolverConflitoEdicaoViva(clientId, escolha, contextoEsperado) {
    const contexto = contextoEsperado || cloudRel._capturarContexto();
    const entry = cloudRel._conflitosLer().find(x => x.clientId === clientId && x.status === 'pending');
    if (!entry || !contexto || !cloudRel._contextoValido(contexto, entry.organizationId) ||
        entry.ownerId !== contexto.userId || !entry.metadata ||
        entry.metadata.draftModule !== 'live:' + entry.mod ||
        !Number.isInteger(Number(entry.serverVersion)) || Number(entry.serverVersion) < 1) return false;
    if (escolha !== 'local' && escolha !== 'remote') return false;
    let escolhida;
    if (escolha === 'local') {
      const payload = Object.assign({}, cloudRel._clone(entry.proposed), {
        id: entry.legacyId, _draftVersion: Number(entry.serverVersion), _draftOrg: contexto.organizationId
      });
      const res = await rascunhosSync.gravarUnico(entry.metadata.draftModule, payload, contexto);
      if (!cloudRel._contextoValido(contexto, entry.organizationId)) return false;
      if (!res || !res.remoteConfirmed) {
        if (res && res.linha) {
          const novo = cloudRel.registrarConflito(entry.mod, payload, rascunhosSync._daLinha(res.linha, contexto.organizationId),
            { tabela: 'drafts', legacyId: entry.legacyId, draftModule: entry.metadata.draftModule,
              operation: 'draft_upsert', motivo: 'rascunho_mudou_durante_resolucao' });
          try { realtime._avisarConflito(entry.mod, novo, contexto); } catch (e) {}
        }
        return false;
      }
      escolhida = rascunhosSync._daLinha(res.linha, contexto.organizationId);
    } else {
      const linha = await rascunhosSync._lerAtual(entry.metadata.draftModule, entry.legacyId,
        contexto.organizationId, contexto.userId, contexto);
      if (!cloudRel._contextoValido(contexto, entry.organizationId) || !linha) return false;
      escolhida = rascunhosSync._daLinha(linha, contexto.organizationId);
    }
    const adotada = await edicaoViva.adotarVersaoConflito(entry.mod, escolhida, contexto, { proposto: entry.proposed });
    if (!cloudRel._contextoValido(contexto, entry.organizationId) || !adotada || !adotada.ok) return false;
    if (!adotada.laterEditingPreserved) {
      await edicaoViva.aguardarPersistencia(entry.mod);
      if (!cloudRel._contextoValido(contexto, entry.organizationId)) return false;
    }
    return cloudRel.resolverConflito(clientId, escolha, { version: escolhida._draftVersion,
      preservedLaterEditing: !!adotada.laterEditingPreserved });
  },
  async _conflitoConfirmarExclusao(clientId) {
    const e = cloudRel._conflitosLer().find(x => x.clientId === clientId);
    if (!e) return;
    const contexto = cloudRel._capturarContexto();
    if (!contexto || (e.organizationId && e.organizationId !== contexto.organizationId)) {
      toast('A clínica mudou. Reabra o conflito na clínica correta.', 'warn'); return;
    }
    modal.close();
    if (e.tabela === 'drafts') {
      const ok = await rascunhosSync.apagar(e.mod, e.legacyId, e.serverVersion,
        { naoRegistrar: true, contexto, organizationId: e.organizationId });
      if (!cloudRel._contextoValido(contexto, contexto.organizationId)) return;
      if (ok) { cloudRel.resolverConflito(clientId, 'local'); toast('Rascunho excluído da nuvem'); }
      else toast('A exclusão mudou novamente; o conflito continua preservado.', 'warn');
      return;
    }
    const r = await cloudRel.apagarNaClinica(e.tabela, e.legacyId, {
      baseVersion: e.serverVersion, organizationId: e.organizationId, mod: e.mod,
      parentConflictClientId: clientId
    });
    if (r && r.ok) { cloudRel.resolverConflito(clientId, 'local'); toast('Exclusão confirmada na nuvem'); }
    else if (r && r.conflict && r.conflictClientId && r.conflictClientId !== clientId) {
      cloudRel.resolverConflito(clientId, 'local', { novoConflito: r.conflictClientId });
      toast('O registro mudou novamente; um novo conflito foi preservado.', 'warn');
    } else toast('O registro mudou novamente; o conflito continua preservado.', 'warn');
  },
  _conflitoCancelarExclusao(clientId) {
    const e = cloudRel._conflitosLer().find(x => x.clientId === clientId);
    if (!e) return;
    modal.close();
    if (e.tabela !== 'drafts' && e.canonical && e.mod) {
      const lista = store.list(e.mod); const i = lista.findIndex(x => x && x._id === e.canonical._id);
      if (i >= 0) lista[i] = e.canonical; else lista.unshift(e.canonical);
      store.setList(e.mod, lista);
    }
    cloudRel.resolverConflito(clientId, 'remote');
    toast('Versão da nuvem mantida');
  },

  /* Espelho chamado pelo store.save (best-effort, em segundo plano) */
  /* ==========================================================================
     FILA DURÁVEL DO CANAL RELACIONAL

     Havia dois caminhos para a nuvem e só um era confiável. O `cloud` (backup
     pessoal, tabela `documentos`) sempre teve fila com dedup e retentativa. O
     `cloudRel` — que é o canal que COMPARTILHA entre os aparelhos da clínica —
     disparava e esquecia:

         cloudRel.enviarRegistro(mod, item).then(...).catch(() => {});

     Sem org, sem rede, com token vencido ou com o RLS recusando, a promessa
     morria no catch vazio. O registro ficava no aparelho sem `_relUpdatedAt` e
     ninguém sabia. Era assim que um pré-lançamento "enviado" nunca chegava ao
     médico: o canal confiável era o que não compartilha.

     A fila guarda o ID, não o registro. Na hora de drenar, relê do `store` —
     assim o que sobe é sempre a versão mais nova, e a fila cabe em poucos KB
     mesmo com centenas de itens pendentes.
  ========================================================================== */
  FILA_KEY: 'medsys.v7.rel.fila',
  MAX_FILA: 2000,

  _donoFila() { try { return contextoAba.donoFila(); } catch (e) { return null; } },
  _mesmoDonoFila(item, dono) {
    return !!item && !!dono && item.organizationId === dono.organizationId &&
      item.userId === dono.userId && item.deviceId === dono.deviceId;
  },
  _filaTodas(chave) {
    try {
      const q = JSON.parse(localStorage.getItem(chave) || '[]');
      return Array.isArray(q) ? q : [];
    } catch (e) { return []; }
  },
  _filaMesclarDono(chave, q, ordemInicio) {
    const dono = cloudRel._donoFila();
    if (!dono) return false;
    const outras = cloudRel._filaTodas(chave).filter(x => !cloudRel._mesmoDonoFila(x, dono));
    const proprias = (Array.isArray(q) ? q : []).map(x => Object.assign({}, x, {
      organizationId: dono.organizationId, userId: dono.userId,
      deviceId: dono.deviceId, tabId: x.tabId || dono.tabId
    }));
    /* O limite vale por dono; nunca descarte a fila de outra pessoa para
       caber a desta. */
    const limitadas = ordemInicio ? proprias.slice(0, cloudRel.MAX_FILA) : proprias.slice(-cloudRel.MAX_FILA);
    try { localStorage.setItem(chave, JSON.stringify(outras.concat(limitadas))); return true; } catch (e) { return false; }
  },
  _filaLer() {
    const dono = cloudRel._donoFila();
    if (!dono) return [];
    return cloudRel._filaTodas(cloudRel.FILA_KEY).filter(x => cloudRel._mesmoDonoFila(x, dono));
  },
  _filaGravar(q) {
    return cloudRel._filaMesclarDono(cloudRel.FILA_KEY, q, false);
  },
  filaBloqueadas() {
    const dono = cloudRel._donoFila();
    return cloudRel._filaTodas(cloudRel.FILA_KEY).filter(x => !cloudRel._mesmoDonoFila(x, dono)).length;
  },
  filaPendentes() { return cloudRel._filaLer().length; },

  /* Uma entrada por documento: o que importa é que ELE suba, não quantas vezes
     foi editado enquanto estava offline. */
  _filaPor(mod, id, motivo) {
    if (!mod || !id) return;
    const dono = cloudRel._donoFila();
    if (!dono) { cloudRel._ultimoMotivo = 'contexto não confirmado'; return; }
    const q = cloudRel._filaLer().filter(x => !(x.mod === mod && x.id === id));
    const antes = cloudRel._filaLer().find(x => x.mod === mod && x.id === id);
    q.push({ mod: mod, id: id, ts: Date.now(),
             tentativas: ((antes && antes.tentativas) || 0) + 1, motivo: motivo || '',
             organizationId: dono.organizationId, userId: dono.userId,
             deviceId: dono.deviceId, tabId: dono.tabId });
    cloudRel._filaGravar(q);
    /* O motivo vale desde a PRIMEIRA falha, não só depois de drenar: é ele que
       transforma "1 registro aguardando envio" em "1 registro aguardando envio
       · org" — a diferença entre um número e uma explicação. */
    if (motivo) cloudRel._ultimoMotivo = motivo;
    try { ui.repintarNuvemAtual(); } catch (e) {}
    try { syncStatus.refresh(); } catch (e) {}
  },
  _filaTirar(mod, id) {
    cloudRel._filaGravar(cloudRel._filaLer().filter(x => !(x.mod === mod && x.id === id)));
    try { syncStatus.refresh(); } catch (e) {}
    try { ui.repintarNuvemAtual(); } catch (e) {}
  },

  /* Drena a fila. Só uma execução por vez; falha mantém na fila e conta a
     tentativa, com o motivo, para a tela poder dizer por que parou. */
  async drenarFila(opts = {}) {
    if (cloudRel._drenando) return null;
    const contexto = cloudRel._capturarContexto();
    if (!contexto) return null;
    const q = cloudRel._filaLer();
    if (!q.length) return { enviados: 0, restantes: 0 };
    cloudRel._drenando = true;
    let enviados = 0, ultimoMotivo = '';
    try {
      if (!(await cloud._garantirToken())) { cloudRel._ultimoMotivo = 'token'; return null; }
      const limite = opts.limite || 40;
      for (const it of q.slice(0, limite)) {
        if (!cloudRel._contextoValido(contexto, contexto.organizationId)) break;
        if (cloudRel._envioAtivo(it.mod, it.id)) continue;
        let rec = null;
        try { rec = store.getById(it.mod, it.id); } catch (e) {}
        /* Sumiu do aparelho (apagado, arquivado): não há o que subir. */
        if (!rec) { cloudRel._filaTirar(it.mod, it.id); continue; }
        let r = null;
        /* A agenda tem envio próprio: além do `data`, ela grava as colunas
           scheduled_at e status, que são o que ordena e filtra a lista do
           lado do servidor. Usar enviarRegistro aqui as deixaria em branco. */
        try {
          r = it.mod === 'agenda'
            ? await cloudRel.enviarAgenda(rec)
            : it.mod === 'pacientes'
              ? await cloudRel.enviarPaciente(rec)
              : await cloudRel.enviarRegistro(it.mod, rec);
        } catch (e) { r = null; }
        if (!cloudRel._contextoValido(contexto, contexto.organizationId)) break;
        if (r && r.ok) {
          cloudRel._filaTirar(it.mod, it.id);
          enviados++;
        } else if (r && r.conflict) {
          /* Conflito não é falha de entrega: sai da fila e vira decisão de
             quem está na frente do aparelho. */
          cloudRel._filaTirar(it.mod, it.id);
          try {
            if (it.mod === 'agenda') agenda._resolverConflito(rec, r.cloud, r.cloudUpdatedAt);
            else if (it.mod === 'pacientes') pacientes._resolverConflito(rec, r.cloud, r.cloudUpdatedAt);
            else cloudRel._resolverConflitoRegistro(it.mod, rec, r.cloud, r.cloudUpdatedAt);
          } catch (e) {}
        } else {
          ultimoMotivo = (r && r.motivo) || 'rede';
          cloudRel._filaPor(it.mod, it.id, ultimoMotivo);
        }
      }
    } finally {
      cloudRel._drenando = false;
      if (ultimoMotivo) cloudRel._ultimoMotivo = ultimoMotivo;
      else if (enviados) cloudRel._ultimoMotivo = '';
    }
    return { enviados: enviados, restantes: cloudRel.filaPendentes() };
  },

  /* ---- APAGAR NA CLÍNICA ----
     Excluir era um ato só local: `store.delete` e pronto. O registro
     continuava na clínica, e o próximo aparelho a sincronizar o trazia de
     volta — um compromisso cancelado reaparecendo na agenda do outro. O
     banco já tem `deleted_at` e todas as leituras filtram por ele; faltava
     alguém escrever.

     A exclusão não cabe na fila normal: ela relê o registro do aparelho para
     subir a versão mais nova, e um registro apagado não está mais lá. Por
     isso uma fila própria, que guarda só a chave. */
  FILA_DEL_KEY: 'medsys.v7.rel.fila_del',
  _filaDelLer() {
    const dono = cloudRel._donoFila();
    if (!dono) return [];
    return cloudRel._filaTodas(cloudRel.FILA_DEL_KEY).filter(x => cloudRel._mesmoDonoFila(x, dono));
  },
  _filaDelGravar(q) { return cloudRel._filaMesclarDono(cloudRel.FILA_DEL_KEY, q, true); },
  _filaDelPor(tabela, id, ctx = {}) {
    if (!tabela || !id) return;
    const dono = cloudRel._donoFila();
    if (!dono) { cloudRel._ultimoMotivo = 'contexto não confirmado'; return; }
    const orgPedido = ctx.organizationId || ctx._relOrg || null;
    if (orgPedido && orgPedido !== dono.organizationId) { cloudRel._ultimoMotivo = 'outra_clinica'; return; }
    const anterior = cloudRel._filaDelLer().find(x => x.tabela === tabela && x.id === id);
    const q = cloudRel._filaDelLer().filter(x => !(x.tabela === tabela && x.id === id));
    q.push({
      tabela, id,
      baseVersion: cloudRel._versao({ _relVersion: ctx.baseVersion || ctx._relVersion }) ||
        (anterior && anterior.baseVersion) || null,
      organizationId: dono.organizationId,
      userId: dono.userId,
      deviceId: dono.deviceId,
      tabId: dono.tabId,
      mod: ctx.mod || (anterior && anterior.mod) || null,
      parentConflictClientId: ctx.parentConflictClientId || (anterior && anterior.parentConflictClientId) || null,
      tentativas: ((anterior && anterior.tentativas) || 0) + 1,
      em: new Date().toISOString()
    });
    cloudRel._filaDelGravar(q);
  },
  _filaDelTirar(tabela, id) {
    cloudRel._filaDelGravar(cloudRel._filaDelLer().filter(x => !(x.tabela === tabela && x.id === id)));
  },
  _selectConflito(mod) {
    if (mod === 'pacientes') return cloudRel._SELECT;
    if (mod === 'agenda') return cloudRel._AG_SELECT;
    if (cloudRel.MODOS[mod]) return cloudRel._REG_SELECT;
    return 'id,organization_id,legacy_id,data,version,updated_by,updated_at,deleted_at,last_operation_id,last_operation_checksum';
  },
  _itemDaLinha(mod, row, org) {
    if (!row) return null;
    if (mod === 'pacientes') return cloudRel._rowParaItem(row, org);
    if (mod === 'agenda') return cloudRel._rowParaAgenda(row, org);
    if (cloudRel.MODOS[mod]) return cloudRel._rowParaRegistro(row, org);
    return row;
  },
  async apagarNaClinica(tabela, legacyId, ctx = {}) {
    if (!tabela || !legacyId) return { ok: false, motivo: 'chave' };
    const contexto = cloudRel._capturarContexto();
    const filaLegada = () => { if (!ctx.semFilaLegada) cloudRel._filaDelPor(tabela, legacyId, ctx); };
    if (!contexto) { filaLegada(); return { ok: false, motivo: 'offline' }; }
    const org = contexto.organizationId;
    /* Toda retentativa conserva o destino capturado. Se a aba trocar enquanto
       a requisição está em voo, `_filaDelPor` recusa gravá-la na nova clínica. */
    const filaCtx = Object.assign({}, ctx, {
      organizationId: ctx.organizationId || ctx._relOrg || org
    });
    if (!cloudRel.disponivel()) { if (!ctx.semFilaLegada) cloudRel._filaDelPor(tabela, legacyId, filaCtx); return { ok: false, motivo: 'offline' }; }
    if (!(await cloud._garantirToken())) { if (!ctx.semFilaLegada) cloudRel._filaDelPor(tabela, legacyId, filaCtx); return { ok: false, motivo: 'token' }; }
    if (!cloudRel._contextoValido(contexto, org)) return { ok: false, motivo: 'contexto_trocado' };
    if ((ctx.organizationId || ctx._relOrg) && (ctx.organizationId || ctx._relOrg) !== org) {
      filaLegada();
      return { ok: false, motivo: 'outra_clinica' };
    }
    const baseVersion = cloudRel._versao({ _relVersion: ctx.baseVersion || ctx._relVersion });
    const sel = cloudRel._selectConflito(ctx.mod);
    const recibo = cloudRel._normalizarOperacao(ctx.operation);
    const jaConfirmada = atual => !!(atual && atual.deleted_at && cloudRel._mesmoRecibo(atual, recibo));
    const conflitoDe = (atual, motivo) => {
      const canonical = cloudRel._itemDaLinha(ctx.mod, atual, org) || atual;
      let salvo = null;
      if (!ctx.naoRegistrar) {
        const modConflito = ctx.mod || (tabela === 'patients' ? 'pacientes' : tabela === 'appointments' ? 'agenda' :
          Object.keys(cloudRel.MODOS).find(m => cloudRel.MODOS[m].tabela === tabela));
        salvo = cloudRel.registrarConflito(modConflito, {
          _id: legacyId, _deleteRequested: true, _relVersion: baseVersion, _relOrg: org
        }, canonical, {
          tabela, legacyId, organizationId: org, operation: 'delete',
          baseVersion, serverVersion: atual && atual.version, motivo
        });
        /* O pedido sai da fila de transporte e passa para a fila de decisão.
           Repeti-lo a cada minuto só recriaria o mesmo conflito. */
        cloudRel._filaDelTirar(tabela, legacyId);
      }
      return { ok: false, conflict: true, cloud: canonical,
        cloudVersion: atual && Number(atual.version),
        conflictClientId: salvo && salvo.clientId, motivo };
    };
    try {
      const c = cloud.config();
      /* Sem versão-base não há autorização para apagar uma linha já existente:
         ela pode ter sido criada/alterada noutro aparelho. Ausência remota,
         porém, significa que o delete local já convergiu. */
      if (!baseVersion) {
        const atualSemBase = await cloudRel._lerAtualTab(tabela, org, legacyId, sel);
        if (!cloudRel._contextoValido(contexto, org)) return { ok: false, motivo: 'contexto_trocado' };
        if (!atualSemBase) { cloudRel._filaDelTirar(tabela, legacyId); return { ok: true, ausente: true }; }
        if (jaConfirmada(atualSemBase)) {
          cloudRel._filaDelTirar(tabela, legacyId);
          return { ok: true, row: atualSemBase, replayed: true };
        }
        return conflitoDe(atualSemBase, 'versao_base_ausente');
      }
      const corpo = { deleted_at: new Date().toISOString() };
      if (recibo) {
        corpo.last_operation_id = recibo.id;
        corpo.last_operation_checksum = recibo.checksum;
      }
      const r = await fetch(c.url + '/rest/v1/' + tabela + '?organization_id=eq.' + org +
        '&legacy_id=eq.' + encodeURIComponent(legacyId) + '&version=eq.' + baseVersion + '&select=' + sel,
        { method: 'PATCH',
          headers: Object.assign({}, cloud._headers(true), { 'Content-Type': 'application/json', 'Prefer': 'return=representation' }),
          body: JSON.stringify(corpo) });
      if (!r.ok) {
        /* Imutabilidade e outra rejeição concorrente não melhoram com retry
           cego. Se a linha ainda existe, preserva-se como conflito. */
        if ([400, 409, 412].includes(r.status)) {
          const rejeitado = await cloudRel._lerAtualTab(tabela, org, legacyId, sel);
          if (!cloudRel._contextoValido(contexto, org)) return { ok: false, motivo: 'contexto_trocado' };
          if (jaConfirmada(rejeitado)) {
            cloudRel._filaDelTirar(tabela, legacyId);
            return { ok: true, row: rejeitado, replayed: true };
          }
          if (rejeitado) return conflitoDe(rejeitado,
            rejeitado.finalized_at ? 'registro_finalizado' : 'exclusao_rejeitada');
        }
        if (!ctx.semFilaLegada) cloudRel._filaDelPor(tabela, legacyId, filaCtx);
        return { ok: false, motivo: 'http ' + r.status };
      }
      const rows = await cloudRel._linhasValidas(r);
      if (!cloudRel._contextoValido(contexto, org)) return { ok: false, motivo: 'contexto_trocado', remotoConfirmado: !!(rows && rows[0]) };
      if (rows && rows[0]) { cloudRel._filaDelTirar(tabela, legacyId); return { ok: true, row: rows[0] }; }
      const atual = await cloudRel._lerAtualTab(tabela, org, legacyId, sel);
      if (!cloudRel._contextoValido(contexto, org)) return { ok: false, motivo: 'contexto_trocado' };
      if (!atual) { cloudRel._filaDelTirar(tabela, legacyId); return { ok: true, ausente: true }; }
      if (jaConfirmada(atual)) {
        cloudRel._filaDelTirar(tabela, legacyId);
        return { ok: true, row: atual, replayed: true };
      }
      return conflitoDe(atual, 'versao_divergente');
    } catch (e) {
      if (!ctx.semFilaLegada) cloudRel._filaDelPor(tabela, legacyId, filaCtx);
      return cloudRel._falhaTipada(e);
    }
  },
  async restaurarNaClinica(tabela, legacyId, item, ctx = {}) {
    if (!tabela || !legacyId || !item) return { ok: false, motivo: 'chave' };
    const contexto = cloudRel._capturarContexto();
    if (!contexto) return { ok: false, motivo: 'offline' };
    const org = contexto.organizationId;
    if ((ctx.organizationId || item._relOrg) && (ctx.organizationId || item._relOrg) !== org) {
      return { ok: false, motivo: 'outra_clinica' };
    }
    if (!cloudRel.disponivel()) return { ok: false, motivo: 'offline' };
    if (!(await cloud._garantirToken())) return { ok: false, motivo: 'token' };
    if (!cloudRel._contextoValido(contexto, org)) return { ok: false, motivo: 'contexto_trocado' };
    const mod = ctx.mod || (tabela === 'patients' ? 'pacientes' : tabela === 'appointments' ? 'agenda' :
      Object.keys(cloudRel.MODOS).find(m => cloudRel.MODOS[m].tabela === tabela));
    if (!mod || !cloudRel.suportaModulo(mod)) return { ok: false, motivo: 'mod' };
    const sel = cloudRel._selectConflito(mod);
    const recibo = cloudRel._normalizarOperacao(ctx.operation);
    const baseVersion = cloudRel._versao({ _relVersion: ctx.baseVersion || item._relVersion });
    const conflitoDe = (atual, motivo) => {
      const canonical = cloudRel._itemDaLinha(mod, atual, org) || atual;
      const salvo = cloudRel.registrarConflito(mod,
        Object.assign({}, item, { _restoreRequested: true, _relVersion: baseVersion, _relOrg: org }),
        canonical, {
          tabela, legacyId, organizationId: org, operation: 'restore',
          baseVersion, serverVersion: atual && atual.version, motivo
        });
      return { ok: false, conflict: true, cloud: canonical,
        cloudVersion: atual && Number(atual.version),
        conflictClientId: salvo && salvo.clientId, motivo };
    };
    try {
      const atual = await cloudRel._lerAtualTab(tabela, org, legacyId, sel);
      if (!cloudRel._contextoValido(contexto, org)) return { ok: false, motivo: 'contexto_trocado' };

      /* Um registro criado e apagado antes do primeiro recibo pode nunca ter
         existido remotamente. Nesse caso restaurar significa inserir o
         snapshot, ainda com CAS/idempotência do caminho normal. */
      if (!atual) {
        const novo = cloudRel._clone(item);
        delete novo._relVersion; delete novo._relUpdatedAt; delete novo._relUpdatedBy;
        novo._relOrg = org;
        const opts = { operation: ctx.operation };
        let criado;
        if (mod === 'pacientes') criado = await cloudRel.enviarPaciente(novo, opts);
        else if (mod === 'agenda') criado = await cloudRel.enviarAgenda(novo, opts);
        else criado = await cloudRel.enviarRegistro(mod, novo, opts);
        return criado;
      }
      if (!atual.deleted_at) {
        if (cloudRel._mesmoRecibo(atual, recibo)) return { ok: true, row: atual, replayed: true };
        return conflitoDe(atual, 'registro_ja_ativo');
      }
      if (!baseVersion) return conflitoDe(atual, 'versao_base_ausente');

      const corpo = { deleted_at: null };
      if (recibo) {
        corpo.last_operation_id = recibo.id;
        corpo.last_operation_checksum = recibo.checksum;
      }
      const c = cloud.config();
      const r = await fetch(c.url + '/rest/v1/' + tabela +
        '?organization_id=eq.' + encodeURIComponent(org) +
        '&legacy_id=eq.' + encodeURIComponent(legacyId) +
        '&version=eq.' + baseVersion + '&deleted_at=not.is.null&select=' + sel, {
        method: 'PATCH',
        headers: Object.assign({}, cloud._headers(true), {
          'Content-Type': 'application/json', 'Prefer': 'return=representation'
        }),
        body: JSON.stringify(corpo)
      });
      if (!r.ok) {
        if ([400, 409, 412].includes(r.status)) {
          const rejeitado = await cloudRel._lerAtualTab(tabela, org, legacyId, sel);
          if (!cloudRel._contextoValido(contexto, org)) return { ok: false, motivo: 'contexto_trocado' };
          if (rejeitado && !rejeitado.deleted_at && cloudRel._mesmoRecibo(rejeitado, recibo)) {
            return { ok: true, row: rejeitado, replayed: true };
          }
          if (rejeitado) return conflitoDe(rejeitado, 'restauracao_rejeitada');
        }
        return { ok: false, motivo: 'http ' + r.status };
      }
      const rows = await cloudRel._linhasValidas(r);
      if (!cloudRel._contextoValido(contexto, org)) {
        return { ok: false, motivo: 'contexto_trocado', remotoConfirmado: !!(rows && rows[0]) };
      }
      if (rows && rows[0]) {
        cloudRel._aplicarMetaLocal(mod, item, rows[0], org);
        return { ok: true, row: rows[0] };
      }
      const mudou = await cloudRel._lerAtualTab(tabela, org, legacyId, sel);
      if (!cloudRel._contextoValido(contexto, org)) return { ok: false, motivo: 'contexto_trocado' };
      if (mudou && !mudou.deleted_at && cloudRel._mesmoRecibo(mudou, recibo)) {
        cloudRel._aplicarMetaLocal(mod, item, mudou, org);
        return { ok: true, row: mudou, replayed: true };
      }
      return mudou ? conflitoDe(mudou, 'versao_divergente') : { ok: false, motivo: 'nao_encontrado_ou_sem_acesso' };
    } catch (e) { return cloudRel._falhaTipada(e); }
  },
  async drenarFilaDel() {
    const contexto = cloudRel._capturarContexto();
    if (!contexto) return null;
    const q = cloudRel._filaDelLer();
    if (!q.length) return { enviados: 0 };
    let n = 0;
    for (const it of q.slice(0, 40)) {
      if (!cloudRel._contextoValido(contexto, contexto.organizationId)) break;
      const r = await cloudRel.apagarNaClinica(it.tabela, it.id, it);
      if (!cloudRel._contextoValido(contexto, contexto.organizationId)) break;
      if (r && r.ok) {
        n++;
        if (it.parentConflictClientId) cloudRel.resolverConflito(it.parentConflictClientId, 'local', { filaOffline: true });
      } else if (r && r.conflict) {
        if (it.parentConflictClientId && r.conflictClientId && r.conflictClientId !== it.parentConflictClientId) {
          cloudRel.resolverConflito(it.parentConflictClientId, 'local', { novoConflito: r.conflictClientId });
        }
        cloudRel._ultimoMotivo = 'conflito de exclusão';
      }
    }
    return { enviados: n, restantes: cloudRel._filaDelLer().length };
  },

  /* Um mesmo formulário pode salvar por clique, autosave e mudança de estado
     quase ao mesmo tempo. Serializar por registro evita que o próprio aparelho
     crie dois INSERTs concorrentes e interprete o segundo como conflito. */
  _enviosAtivos: Object.create(null),
  _reenvios: Object.create(null),
  _chaveEnvio(mod, id) {
    const d = cloudRel._donoFila() || {};
    return [d.organizationId || '-', d.userId || '-', d.deviceId || '-', d.tabId || '-', mod || '', id || ''].join(':');
  },
  _envioAtivo(mod, id) { return cloudRel._enviosAtivos[cloudRel._chaveEnvio(mod, id)] || null; },
  _temPendente(mod, id) {
    const cifrada = (() => {
      try { return typeof persistenciaCloudFirst !== 'undefined' && persistenciaCloudFirst.temPendente(mod, id); }
      catch (e) { return false; }
    })();
    return !!cloudRel._envioAtivo(mod, id) || cifrada ||
      cloudRel._filaLer().some(x => x.mod === mod && x.id === id);
  },
  async esperarEnvio(mod, id) {
    const chave = cloudRel._chaveEnvio(mod, id);
    let ultimo = null;
    /* O finally pode iniciar uma rodada coalescida; acompanha até estabilizar. */
    while (cloudRel._enviosAtivos[chave]) {
      const atual = cloudRel._enviosAtivos[chave];
      try { ultimo = await atual; } catch (e) { ultimo = { ok: false, motivo: e.message || 'rede' }; }
      if (cloudRel._enviosAtivos[chave] === atual) break;
    }
    return ultimo;
  },

  /* Ponto único usado pelo store: qualquer módulo compartilhado entra na
     fila relacional quando a confirmação não chega. */
  mirror(mod, item) {
    if (!cloudRel.suportaModulo(mod) || !item || !item._id) return;
    const contexto = (() => { try { return contextoAba.capturar(); } catch (e) { return null; } })();
    if (!contexto || !contextoAba.operational()) return;
    const id = item._id;
    const chave = cloudRel._chaveEnvio(mod, id);
    if (cloudRel._enviosAtivos[chave]) {
      cloudRel._reenvios[chave] = true;
      return cloudRel._enviosAtivos[chave];
    }
    let envio;
    try {
      envio = persistenciaCloudFirst.salvar(mod, item);
      const acompanhado = Promise.resolve(envio).then(res => {
        if (!contextoAba.corresponde(contexto)) return { ok: false, motivo: 'contexto_trocado', remotoConfirmado: !!(res && res.ok) };
        const temReenvio = !!cloudRel._reenvios[chave];
        if (res && res.conflict) {
          if (!temReenvio && !res.conflictPreserved) {
            cloudRel._filaTirar(mod, id);
            const localAtual = store.getById(mod, id) || item;
            if (mod === 'pacientes') pacientes._resolverConflito(localAtual, res.cloud, res.cloudUpdatedAt);
            else if (mod === 'agenda') agenda._resolverConflito(localAtual, res.cloud, res.cloudUpdatedAt);
            else cloudRel._resolverConflitoRegistro(mod, localAtual, res.cloud, res.cloudUpdatedAt);
          }
        } else if (res && res.ok) {
          if (!temReenvio) cloudRel._filaTirar(mod, id); // limpa somente legado
        }
        return res;
      }).catch(e => {
        if (!contextoAba.corresponde(contexto)) return { ok: false, motivo: 'contexto_trocado' };
        try { syncStatus.cloudState('error'); } catch (er) {}
        return { ok: false, motivo: (e && e.message) || 'rede' };
      }).finally(() => {
        delete cloudRel._enviosAtivos[chave];
        const reenvio = !!cloudRel._reenvios[chave];
        delete cloudRel._reenvios[chave];
        if (reenvio && contextoAba.corresponde(contexto)) {
          const maisNovo = store.getById(mod, id);
          if (maisNovo) cloudRel.mirror(mod, maisNovo);
        }
      });
      cloudRel._enviosAtivos[chave] = acompanhado;
      return acompanhado;
    } catch (e) {
      try { syncStatus.cloudState('error'); } catch (er) {}
      return Promise.resolve({ ok: false, motivo: (e && e.message) || 'motor_indisponivel', durable: false });
    }
  },

  async remover(mod, item, opts = {}) {
    if (!cloudRel.suportaModulo(mod) || !item) return { ok: false, motivo: 'mod' };
    const tabela = cloudRel.tabelaDoModulo(mod);
    const legacy = cloudRel.chaveLegada(mod, item);
    if (!tabela || !legacy) return { ok: false, motivo: 'chave' };
    const donoInicial = cloudRel._donoFila();
    const orgInicial = item._relOrg || (donoInicial && donoInicial.organizationId) || null;
    const filaInicial = {
      baseVersion: cloudRel._versao(item), organizationId: orgInicial, mod
    };
    /* O pedido de exclusão nasce durável ANTES do primeiro await. Se a pessoa
       sair ou trocar de clínica enquanto o PATCH está em voo, a intenção não
       desaparece junto com a sessão; sucesso/conflicto é quem a retira. */
    cloudRel._filaDelPor(tabela, legacy, filaInicial);
    if (opts.somenteFila) {
      return { ok: false, motivo: 'fila' };
    }
    /* Salvar e apagar em seguida é comum na agenda. Aguarda o INSERT/PATCH já
       em voo para não concluir "ausente" e deixar aquela gravação ressuscitar
       o registro logo depois. */
    const envio = cloudRel._envioAtivo(mod, item._id);
    let confirmado = null;
    if (envio) confirmado = await cloudRel.esperarEnvio(mod, item._id);
    const row = confirmado && confirmado.row;
    const filaFinal = {
      baseVersion: cloudRel._versao(item) || (row && row.version),
      organizationId: orgInicial || (row && row.organization_id), mod
    };
    /* Se o save em voo acabou de devolver a versão inicial, atualiza a fila
       antes do PATCH. Sem isso uma queda neste ponto transformaria o delete
       válido em conflito por "versão-base ausente" na próxima abertura. */
    cloudRel._filaDelPor(tabela, legacy, filaFinal);
    return cloudRel.apagarNaClinica(tabela, legacy, filaFinal);
  },

  mirrorRegistro(mod, item) {
    return cloudRel.mirror(mod, item);
  },

  /* Metadados vêm do REGISTRO confirmado, nunca do formulário global que pode
     já estar exibindo outro paciente. INSERT-only e idempotente: uma resposta
     perdida não duplica nem altera a autoria do upload original. */
  async registrarAnexos(mod, item, opts = {}) {
    try {
      if (typeof prontuario === 'undefined' || !item) return false;
      const docs = prontuario._anexosDo(item).map(x => x.doc).filter(d => d && d.storage_path);
      if (!docs.length || !cloudRel.disponivel()) return false;
      const org = opts.organizationId || item._relOrg || await cloudRel._orgAsync();
      const ctx = opts.contexto || await prontuario._contextoUpload(org);
      if (!org || org !== ctx.organizationId || !prontuario._contextoAindaAtivo(ctx)) return false;
      /* Só o autor do caminho registra o metadado. Referências herdadas de
         outro usuário já foram registradas por quem fez o upload. */
      const proprios = docs.filter(d => prontuario._pathValido(d.storage_path, ctx, true));
      if (!proprios.length) return true;
      const patientId = opts.patientId !== undefined ? opts.patientId : await cloudRel._garantirPaciente(org, item);
      let encId = opts.encounterId !== undefined ? opts.encounterId : null;
      const cfg = cloudRel.MODOS[mod];
      if (opts.encounterId === undefined && cfg && cfg.enc) {
        try { encId = await cloudRel._garantirEncounter(org, patientId, item); } catch (e) {}
      }
      if (!prontuario._contextoAindaAtivo(ctx)) return false;
      const rows = proprios.map(d => ({
        organization_id: org, patient_id: patientId || null, encounter_id: encId || null,
        module: mod, storage_path: d.storage_path,
        filename: d.nome || null, mime_type: prontuario._mime(d),
        size: d.tamanho || null, hash: d.hash || null
      }));
      const r = await fetch(ctx.url + '/rest/v1/attachments?on_conflict=organization_id,storage_path', {
        method: 'POST',
        headers: Object.assign({}, prontuario._headersContexto(ctx), {
          'Prefer': 'resolution=ignore-duplicates,return=minimal'
        }),
        body: JSON.stringify(rows)
      });
      return !!(r.ok && prontuario._contextoAindaAtivo(ctx));
    } catch (e) { return false; }
  },

  /* Pull automático 1x/sessão por módulo, ao abrir */
  _puxados: {},
  async autoPullModulo(mod) {
    if (!cloudRel.MODOS[mod] || cloudRel._puxados[mod]) return;
    const contexto = cloudRel._capturarContexto(); if (!contexto) return;
    cloudRel._puxados[mod] = true;

    /* ETAPA 1 — o índice. Barato, e diz tudo o que existe lá. */
    const indiceCompleto = await cloudRel.puxarIndiceModulo(mod);
    if (!indiceCompleto || !cloudRel._contextoValido(contexto, contexto.organizationId)) {
      cloudRel._puxados[mod] = false; return;
    }
    /* A lista COMPLETA do que a nuvem devolve, guardada antes de qualquer
       filtro: é ela que diz o que continua visível para este usuário. Usar a
       lista filtrada aqui apagaria do aparelho tudo o que não foi baixado
       nesta passagem — ou seja, quase tudo. */
    const idsRemotos = new Set();
    indiceCompleto.forEach(r => (r._idsPossiveis || [r._idLocal]).forEach(id => { if (id) idsRemotos.add(id); }));
    /* O índice não lê `data`, e é de lá que sai o _id quando o registro tem um
       (`_rowParaRegistro` só cai no legacy_id se `data._id` não existir). No
       caminho normal os dois são o mesmo — `enviarRegistro` grava
       `legacy_id = item._id`. Mas se UMA linha vier sem legacy_id, o índice
       deixa de conseguir afirmar qual registro do aparelho ela representa.
       Nesse caso a limpeza de visibilidade não roda: convergir um pouco mais
       tarde custa nada, apagar um registro que existe na nuvem custa o
       registro. */
    const indicePodeIdentificarTudo = indiceCompleto.every(r => !!r.legacy_id);
    /* registros ARQUIVADOS neste aparelho não voltam pelo pull. Filtrar AQUI,
       e não depois, é o que evita baixar de novo o que seria descartado — era
       assim que os 80 arquivados desta conta vinham junto em toda passagem. */
    let indice = indiceCompleto;
    try {
      if (typeof arquivo !== 'undefined') indice = indice.filter(r => !arquivo.estaArquivado(mod, r._idLocal));
    } catch (e) {}

    /* ETAPA 2 — o conteúdo, só do que este aparelho ainda não tem nesta
       versão. `_relUpdatedAt` é o carimbo da versão que veio da nuvem: se ele
       bate com o de lá, a cópia daqui É aquela versão e não há o que baixar.
       Editar o registro aqui mexe em `_updatedAt`, não neste — então trabalho
       local não faz o aparelho rebaixar o que já tinha. */
    const carimboLocal = new Map();
    try {
      (store.list(mod) || []).forEach(x => {
        if (x && x._id) carimboLocal.set(x._id, x._relUpdatedAt || '');
      });
    } catch (e) {}
    const precisam = indice
      .filter(r => carimboLocal.get(r._idLocal) !== r.updated_at)
      .map(r => r.id);

    let remotos = [];
    if (precisam.length) {
      remotos = await cloudRel.puxarPorIds(mod, precisam);
      /* Falhou o conteúdo: não mescla nada e não reconcilia nada. Sair aqui
         mantém o aparelho na versão anterior, que é íntegra — meia
         sincronização seria pior que nenhuma. */
      if (!remotos || !cloudRel._contextoValido(contexto, contexto.organizationId)) { cloudRel._puxados[mod] = false; return; }
      try { if (typeof arquivo !== 'undefined') remotos = remotos.filter(r => !arquivo.estaArquivado(mod, r._id)); } catch (e) {}
    }
    /* Aqui morava a falha do pré-lançamento: quando o registro JÁ EXISTIA neste
       aparelho, só o carimbo _relUpdatedAt era copiado e o conteúdo da nuvem ia
       fora. Ou seja: o aparelho do médico tinha a versão "rascunho" dela, o
       "enviado" chegava e era descartado — e nenhum botão de atualizar
       resolvia, porque todo caminho passava por aqui. */
    if (!cloudRel._contextoValido(contexto, contexto.organizationId)) { cloudRel._puxados[mod] = false; return; }
    const m = cloudRel.mesclarLocal(mod, remotos);
    const locais = store.list(mod);
    const novos = m.novos + m.atualizados;
    /* Visibilidade 'proprios' (migração 0008): a RLS já devolve só o que este
       usuário pode ver — então o que veio da nuvem um dia (_relUpdatedAt) e
       NÃO voltou agora deixou de ser visível (registro de outro anestesista
       puxado antes da mudança). Remove do aparelho para convergir. Itens
       criados aqui e ainda não espelhados (sem _relUpdatedAt) ficam. */
    /* REGISTRO QUE DIZ ESTAR NA NUVEM, MAS NÃO ESTÁ NA NUVEM DESTA CLÍNICA.

       `_relUpdatedAt` é o carimbo de que o registro foi espelhado no banco.
       Se ele existe e o registro NÃO aparece no índice desta organização, uma
       de duas: ou ele foi removido de lá, ou ele nunca foi daqui — foi
       espelhado na clínica de outra pessoa e veio parar nesta gaveta.

       O segundo caso é justamente o estrago que a migração antiga fez ao
       adivinhar de quem era o acervo do aparelho. Não basta parar de
       adivinhar: o que já foi carimbado errado continua aqui, aparecendo como
       se fosse desta clínica — e, pior, uma edição o empurraria para dentro
       dela na nuvem.

       Sai da gaveta. Não é perda: o registro continua inteiro na nuvem da
       clínica dele. O que foi criado aqui e ainda não subiu não tem
       `_relUpdatedAt` e nunca é tocado — trabalho não sincronizado jamais é
       apagado por esta regra. */
    let removidos = 0;
    try {
      if (indicePodeIdentificarTudo) {
        /* idsRemotos vem do ÍNDICE COMPLETO, não do que foi baixado agora.
           Com a leitura incremental, `remotos` traz só o que mudou — usá-lo
           aqui apagaria do aparelho todo registro que continuou igual. */
        for (let i = locais.length - 1; i >= 0; i--) {
          const x = locais[i];
          if (x && x._relUpdatedAt && x._id && !idsRemotos.has(x._id) && !cloudRel._temPendente(mod, x._id)) {
            locais.splice(i, 1); removidos++;
          }
        }
      }
    } catch (e) {}
    if (removidos) {
      try { toast('🧹 ' + removidos + ' registro(s) que não são desta clínica saíram deste aparelho (continuam na clínica de origem)', 'warn'); } catch (e) {}
    }
    if (removidos) store.setList(mod, locais);      /* a mescla já gravou o que trouxe */
    /* Chegou até aqui: a clínica respondeu por este módulo. É o carimbo que
       separa "não tem registro" de "ainda não carregou" — ver `jaPuxou`. */
    cloudRel.marcarPuxado(mod);
    if (novos) {
      /* trouxe coisa nova: o que está na tela precisa refletir isso */
      try { if (typeof preLanc !== 'undefined' && preLanc.MODS.indexOf(mod) >= 0) preLanc.renderFila(); } catch (e) {}
    }
  },

  /* Conflito genérico de registro (modal comparando campos simples) */
  _repintarAposConflito(mod) {
    try {
      /* Fechamentos são uma coleção própria na nuvem, mas aparecem dentro do
         Financeiro. A chave técnica nunca deve ser passada a `ui.navegar`. */
      if (mod === 'fin_fechamentos') {
        if (state.currentModule === 'financeiro' && typeof financeiro !== 'undefined') financeiro.render();
        return;
      }
      if (state.currentModule === mod) ui.navegar(mod);
    } catch (e) {}
  },
  _resolverConflitoRegistro(mod, local, nuvem, cloudUpdatedAt, conflictClientId) {
    const simples = (o) => Object.keys(o || {}).filter(k => k[0] !== '_' && (o[k] == null || typeof o[k] !== 'object'));
    const chaves = Array.from(new Set(simples(local).concat(simples(nuvem))));
    const val = (o, k) => (o && o[k] != null ? String(o[k]) : '');
    const linhas = chaves.filter(k => val(local, k) !== val(nuvem, k)).slice(0, 12)
      .map(k => '<tr><td>' + utils.escapeHTML(k) + '</td><td>' + utils.escapeHTML(val(local, k) || '—') +
        '</td><td>' + utils.escapeHTML(val(nuvem, k) || '—') + '</td></tr>').join('');
    const salvo = conflictClientId ? { clientId: conflictClientId }
      : cloudRel.registrarConflito(mod, local, nuvem, { cloudUpdatedAt });
    cloudRel._conflito = { mod, local, nuvem, cloudUpdatedAt,
      conflictClientId: salvo && salvo.clientId };
    const finalizado = !!(nuvem && nuvem._finalizado);
    const rotuloModulo = mod === 'fin_fechamentos' ? 'fechamento de caixa' : mod;
    modal.open('⚠️ Conflito de edição — ' + rotuloModulo,
      '<p style="margin:0 0 10px;font-size:.88rem">' + (finalizado
        ? 'Este registro foi <strong>finalizado na nuvem</strong> enquanto você editava. O original agora é permanente; suas mudanças podem ser preservadas como adendo.'
        : 'Este registro foi <strong>alterado na nuvem</strong> por outra pessoa/aparelho enquanto você editava. Nada foi sobrescrito ainda.') + '</p>' +
      (linhas ? '<table class="fase4-tab"><thead><tr><th>Campo</th><th>O seu</th><th>Da nuvem</th></tr></thead><tbody>' + linhas + '</tbody></table>'
              : '<p style="font-size:.82rem;color:var(--text-mute)">As diferenças estão em campos internos.</p>'),
      '<button class="btn btn-primary" onclick="cloudRel._conflitoManter()">' + (finalizado ? 'Salvar minhas mudanças como adendo' : 'Manter o meu') + '</button>' +
      '<button class="btn" onclick="cloudRel._conflitoUsarNuvem()">Usar o da nuvem</button>' +
      '<button class="btn btn-ghost" onclick="modal.close()">Decidir depois</button>');
  },
  _conflitoManter() {
    const cf = cloudRel._conflito; if (!cf) { modal.close(); return; } modal.close();
    const contexto = cloudRel._capturarContexto();
    if (!contexto || (cf.local && cf.local._relOrg && cf.local._relOrg !== contexto.organizationId)) {
      cloudRel._conflito = null; return;
    }
    if (cf.nuvem && cf.nuvem._finalizado) {
      /* Finalização ganha da edição concorrente, mas não apaga o que a outra
         pessoa digitou: primeiro restaura o canônico, depois anexa o diff. */
      const lst = store.list(cf.mod); const ix = lst.findIndex(x => x._id === cf.local._id);
      const original = Object.assign({}, cf.nuvem, { _id: cf.local._id });
      const porAdendo = new Map();
      ((cf.nuvem && cf.nuvem._adendos) || []).concat((cf.local && cf.local._adendos) || [])
        .forEach(a => { if (a && a.id) porAdendo.set(a.id, a); });
      if (porAdendo.size) original._adendos = Array.from(porAdendo.values());
      if (ix >= 0) lst[ix] = original; else lst.unshift(original);
      store.setList(cf.mod, lst);
      adendos.salvarComoCorrecao(cf.mod, original, cf.local);
      if (cf.conflictClientId) cloudRel.resolverConflito(cf.conflictClientId, 'merged', { como: 'adendo' });
      cloudRel._repintarAposConflito(cf.mod);
      cloudRel._conflito = null;
      return;
    }
    cf.local._relVersion = cf.nuvem._relVersion;
    cf.local._relUpdatedAt = cf.nuvem._relUpdatedAt || cf.cloudUpdatedAt;
    cf.local._relUpdatedBy = cf.nuvem._relUpdatedBy || '';
    cf.local._relOrg = cf.nuvem._relOrg || cf.local._relOrg;
    const lst = store.list(cf.mod); const ix = lst.findIndex(x => x._id === cf.local._id);
    if (ix >= 0) {
      Object.assign(lst[ix], {
        _relVersion: cf.local._relVersion, _relUpdatedAt: cf.local._relUpdatedAt,
        _relUpdatedBy: cf.local._relUpdatedBy, _relOrg: cf.local._relOrg
      });
      store.setList(cf.mod, lst);
    }
    persistenciaCloudFirst.salvar(cf.mod, cf.local).then(r => {
      if (!cloudRel._contextoValido(contexto, contexto.organizationId)) return;
      if (r && r.ok) {
        if (cf.conflictClientId) cloudRel.resolverConflito(cf.conflictClientId, 'local', { version: r.row && r.row.version });
        toast('✅ Sua versão foi mantida na nuvem');
      }
      else if (r && r.conflict && !r.conflictPreserved) {
        if (cf.conflictClientId) cloudRel.resolverConflito(cf.conflictClientId, 'local', { novoConflito: true });
        cloudRel._resolverConflitoRegistro(cf.mod, cf.local, r.cloud, r.cloudUpdatedAt);
      }
      else if (r && r.queued) toast('Sem conexão — sua escolha ficou protegida e será enviada automaticamente.', 'warn');
      else toast('A escolha ficou preservada, mas exige revisão antes de chegar à nuvem.', 'warn');
    });
    cloudRel._repintarAposConflito(cf.mod);
    cloudRel._conflito = null;
  },
  _conflitoUsarNuvem() {
    const cf = cloudRel._conflito; if (!cf) { modal.close(); return; } modal.close();
    const lst = store.list(cf.mod); const ix = lst.findIndex(x => x._id === cf.local._id);
    const item = Object.assign({}, cf.nuvem, { _id: cf.local._id });
    if (ix >= 0) lst[ix] = item; else lst.unshift(item);
    store.setList(cf.mod, lst);
    if (cf.conflictClientId) cloudRel.resolverConflito(cf.conflictClientId, 'remote', { version: cf.nuvem._relVersion });
    cloudRel._repintarAposConflito(cf.mod);
    toast('Versão da nuvem adotada nesta sessão');
    cloudRel._conflito = null;
  }
};

/* As chaves destes índices incluem identidade do paciente/caso. A memória
   também pertence à sessão, inclusive quando outro usuário entra na mesma
   clínica sem recarregar o documento. */
try {
  contextoAba.aoMudar(() => {
    cloudRel._cachePac = {};
    cloudRel._cacheEnc = {};
  });
} catch (e) {}

/* FIM DA PERSISTÊNCIA RELACIONAL */
