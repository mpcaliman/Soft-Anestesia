'use strict';

/* ============================================================================
   PERSISTÊNCIA CLOUD-FIRST — diário cifrado + confirmação verificável

   Cada mutação recebe um UUID e um checksum em memória. Online, ela é
   enviada ao servidor antes de qualquer persistência clínica no aparelho.
   Somente indisponibilidade confirmada autoriza o diário cifrado offline;
   erros de autorização, validação ou conflito continuam apenas em memória.
   Um recibo verificável remove a intenção offline após a reconexão.

   As filas antigas em localStorage são apenas fontes de migração para este
   diário; nenhuma gravação clínica nova cria uma cópia local em claro.
============================================================================ */
const persistenciaCloudFirst = {
  TRANSPORTE: 'cloud-rel-v1',
  TRANSPORTE_ADENDO: 'cloud-addendum-v1',
  _pendentes: new Set(),
  _ownerKey: '',
  _drenando: false,
  _acoesAtivas: new Map(),
  _relogioCausal: new Map(),
  _intencoesMemoria: new Map(),

  _chave(mod, id) { return String(mod || '') + ':' + String(id || ''); },
  _instanteCausal(mod, id, sugerido) {
    const chave = persistenciaCloudFirst._chaveExecucao(mod, id);
    const informado = Date.parse(sugerido || '');
    const anterior = Number(persistenciaCloudFirst._relogioCausal.get(chave)) || 0;
    /* Timestamp já persistido/importado faz parte do checksum idempotente e
       não pode mudar numa retentativa. A monotonicidade é aplicada às novas
       intenções, que não trazem instante preexistente. */
    if (Number.isFinite(informado)) {
      persistenciaCloudFirst._relogioCausal.set(chave, Math.max(anterior, informado));
      return new Date(informado).toISOString();
    }
    const base = Date.now();
    const proximo = Math.max(base, anterior + 1);
    persistenciaCloudFirst._relogioCausal.set(chave, proximo);
    return new Date(proximo).toISOString();
  },
  _chaveExecucao(mod, id) {
    const contexto = persistenciaCloudFirst._contexto();
    const dono = contexto ? filaCifrada._donoKey(contexto) : 'sem-contexto';
    return dono + ':' + persistenciaCloudFirst._chave(mod, id);
  },
  _encadear(mod, id, tarefa) {
    const chave = persistenciaCloudFirst._chaveExecucao(mod, id);
    const anterior = persistenciaCloudFirst._acoesAtivas.get(chave) || Promise.resolve();
    const atual = Promise.resolve(anterior).catch(() => null).then(tarefa);
    persistenciaCloudFirst._acoesAtivas.set(chave, atual);
    atual.then(() => {
      if (persistenciaCloudFirst._acoesAtivas.get(chave) === atual) persistenciaCloudFirst._acoesAtivas.delete(chave);
    }, () => {
      if (persistenciaCloudFirst._acoesAtivas.get(chave) === atual) persistenciaCloudFirst._acoesAtivas.delete(chave);
    });
    return atual;
  },
  temPendente(mod, id) { return persistenciaCloudFirst._pendentes.has(persistenciaCloudFirst._chave(mod, id)); },
  pendentesConhecidos() { return persistenciaCloudFirst._pendentes.size; },
  _clone(v) {
    try { return JSON.parse(JSON.stringify(v)); }
    catch (e) { throw filaCifrada._erro('payload_invalido', 'O registro não pôde ser preparado para a nuvem.', e); }
  },
  _transporta(op) {
    const t = op && op.payload && op.payload.transport;
    return t === persistenciaCloudFirst.TRANSPORTE || t === persistenciaCloudFirst.TRANSPORTE_ADENDO;
  },
  _uuid() {
    const id = filaCifrada._id();
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw filaCifrada._erro('operacao_invalida', 'Não foi possível identificar a gravação.');
    return id.toLowerCase();
  },
  async _uuidDeterministico(semente) {
    const h = (await filaCifrada._sha256(String(semente || ''))).slice(0, 32).split('');
    h[12] = '4'; h[16] = '8';
    const s = h.join('');
    return s.slice(0, 8) + '-' + s.slice(8, 12) + '-' + s.slice(12, 16) + '-' +
      s.slice(16, 20) + '-' + s.slice(20);
  },
  _online() {
    return typeof navigator === 'undefined' || navigator.onLine !== false;
  },
  _contexto() {
    try {
      const c = contextoAba.capturar();
      return c && c.verified && c.organizationId && c.userId ? c : null;
    } catch (e) { return null; }
  },
  _dependencias(mod, item) {
    const deps = [];
    try {
      if (mod !== 'pacientes') {
        const ident = migracaoFase4._ident(item || {});
        const pat = migracaoFase4._patKey(ident);
        if (pat) deps.push('patient:' + pat);
        const cfg = cloudRel.MODOS[mod];
        if (cfg && cfg.enc) {
          const enc = migracaoFase4._encKey(pat, item || {});
          if (enc) deps.push('encounter:' + enc);
        }
      }
    } catch (e) {}
    return deps;
  },
  async _montar(mod, item, opts = {}) {
    if (!cloudRel.suportaModulo(mod) || !item || !item._id) {
      throw filaCifrada._erro('operacao_invalida', 'Módulo e registro são obrigatórios para salvar na nuvem.');
    }
    const contexto = persistenciaCloudFirst._contexto();
    if (!contexto) throw filaCifrada._erro('contexto_nao_confirmado', 'A clínica desta aba ainda não foi confirmada.');
    if (item._relOrg && item._relOrg !== contexto.organizationId) {
      throw filaCifrada._erro('outra_clinica', 'O registro pertence a outra clínica.');
    }
    const operationId = opts.operationId || persistenciaCloudFirst._uuid();
    const baseVersion = cloudRel._versao(item);
    const createdAt = persistenciaCloudFirst._instanteCausal(mod, item._id, opts.createdAt);
    const payload = {
      transport: persistenciaCloudFirst.TRANSPORTE,
      module: mod,
      entityId: String(item._id),
      action: 'upsert',
      item: persistenciaCloudFirst._clone(item)
    };
    payload.requestChecksum = await filaCifrada._sha256(filaCifrada._estavel({
      operationId, organizationId: contexto.organizationId, userId: contexto.userId,
      module: mod, entityId: payload.entityId, action: payload.action,
      baseVersion: baseVersion, item: payload.item
    }));
    return {
      operationId, module: mod, entityId: payload.entityId, action: payload.action,
      baseVersion, dependsOn: persistenciaCloudFirst._dependencias(mod, item),
      createdAt, payload, contexto
    };
  },
  _modDaTabela(tabela) {
    if (tabela === 'patients') return 'pacientes';
    if (tabela === 'appointments') return 'agenda';
    try { return Object.keys(cloudRel.MODOS).find(m => cloudRel.MODOS[m].tabela === tabela) || ''; }
    catch (e) { return ''; }
  },
  async _montarDelete(mod, item, opts = {}) {
    const contexto = persistenciaCloudFirst._contexto();
    if (!contexto) throw filaCifrada._erro('contexto_nao_confirmado', 'A clínica desta aba ainda não foi confirmada.');
    const tabela = opts.tabela || cloudRel.tabelaDoModulo(mod);
    const legacyId = opts.legacyId || cloudRel.chaveLegada(mod, item);
    mod = mod || persistenciaCloudFirst._modDaTabela(tabela);
    if (!mod || !tabela || !legacyId) throw filaCifrada._erro('operacao_invalida', 'Exclusão sem destino verificável.');
    const organizationId = opts.organizationId || (item && item._relOrg) || contexto.organizationId;
    if (organizationId !== contexto.organizationId) throw filaCifrada._erro('outra_clinica', 'A exclusão pertence a outra clínica.');
    const operationId = opts.operationId || persistenciaCloudFirst._uuid();
    const baseVersion = opts.baseVersion != null ? opts.baseVersion : cloudRel._versao(item);
    const entityId = String((item && item._id) || legacyId);
    const createdAt = persistenciaCloudFirst._instanteCausal(mod, entityId, opts.createdAt);
    const payload = {
      transport: persistenciaCloudFirst.TRANSPORTE, module: mod, entityId,
      action: 'delete', table: tabela, legacyId: String(legacyId),
      item: persistenciaCloudFirst._clone(item || { _id: entityId, _relOrg: organizationId })
    };
    payload.requestChecksum = await filaCifrada._sha256(filaCifrada._estavel({
      operationId, organizationId, userId: contexto.userId, module: mod,
      entityId, action: payload.action, baseVersion, table: tabela, legacyId: payload.legacyId
    }));
    return {
      operationId, module: mod, entityId, action: 'delete', baseVersion,
      dependsOn: ['record:' + mod + ':' + entityId],
      createdAt, payload, contexto
    };
  },
  async _montarRestore(mod, item, opts = {}) {
    const contexto = persistenciaCloudFirst._contexto();
    if (!contexto) throw filaCifrada._erro('contexto_nao_confirmado', 'A clínica desta aba ainda não foi confirmada.');
    const tabela = opts.tabela || cloudRel.tabelaDoModulo(mod);
    const legacyId = opts.legacyId || cloudRel.chaveLegada(mod, item);
    mod = mod || persistenciaCloudFirst._modDaTabela(tabela);
    if (!mod || !tabela || !legacyId || !item) {
      throw filaCifrada._erro('operacao_invalida', 'Restauração sem snapshot ou destino verificável.');
    }
    const organizationId = opts.organizationId || item._relOrg || contexto.organizationId;
    if (organizationId !== contexto.organizationId) {
      throw filaCifrada._erro('outra_clinica', 'A restauração pertence a outra clínica.');
    }
    const operationId = opts.operationId || persistenciaCloudFirst._uuid();
    const baseVersion = opts.baseVersion != null ? opts.baseVersion : cloudRel._versao(item);
    const entityId = String(item._id || legacyId);
    const createdAt = persistenciaCloudFirst._instanteCausal(mod, entityId, opts.createdAt);
    const payload = {
      transport: persistenciaCloudFirst.TRANSPORTE, module: mod, entityId,
      action: 'restore', table: tabela, legacyId: String(legacyId),
      item: persistenciaCloudFirst._clone(item)
    };
    payload.requestChecksum = await filaCifrada._sha256(filaCifrada._estavel({
      operationId, organizationId, userId: contexto.userId, module: mod,
      entityId, action: payload.action, baseVersion, table: tabela,
      legacyId: payload.legacyId, item: payload.item
    }));
    return {
      operationId, module: mod, entityId, action: 'restore', baseVersion,
      dependsOn: ['record:' + mod + ':' + entityId], createdAt, payload, contexto
    };
  },
  async _montarAdendo(mod, rec, ad, tabela) {
    const contexto = persistenciaCloudFirst._contexto();
    if (!contexto) throw filaCifrada._erro('contexto_nao_confirmado', 'A clínica desta aba ainda não foi confirmada.');
    if (!mod || !rec || !rec._id || !ad || !ad.id || !tabela) {
      throw filaCifrada._erro('operacao_invalida', 'Adendo e registro pai são obrigatórios.');
    }
    if (rec._relOrg && rec._relOrg !== contexto.organizationId) {
      throw filaCifrada._erro('outra_clinica', 'O adendo pertence a outra clínica.');
    }
    const payload = {
      transport: persistenciaCloudFirst.TRANSPORTE_ADENDO,
      action: 'insert', parentModule: mod, parentTable: tabela,
      parentLegacyId: String(rec._id), adendo: persistenciaCloudFirst._clone(ad)
    };
    const seed = ['adendo', contexto.organizationId, contexto.userId, tabela,
      rec._id, ad.id].join(':');
    const operationId = await persistenciaCloudFirst._uuidDeterministico(seed);
    const createdAt = persistenciaCloudFirst._instanteCausal('__addenda__', ad.id,
      ad.data || new Date().toISOString());
    return {
      operationId, module: '__addenda__', entityId: String(ad.id), action: 'upsert',
      baseVersion: null, dependsOn: [], createdAt,
      payload, contexto
    };
  },
  async _reindexar() {
    const contexto = persistenciaCloudFirst._contexto();
    if (!contexto) { persistenciaCloudFirst._pendentes.clear(); persistenciaCloudFirst._ownerKey = ''; return []; }
    const ownerKey = filaCifrada._donoKey(contexto);
    const ops = await filaCifrada.listar();
    if (!contextoAba.corresponde(contexto)) return [];
    const set = new Set();
    ops.forEach(op => {
      if (persistenciaCloudFirst._transporta(op)) {
        set.add(persistenciaCloudFirst._chave(op.module, op.entityId));
      }
    });
    persistenciaCloudFirst._pendentes = set;
    persistenciaCloudFirst._ownerKey = ownerKey;
    try { if (typeof ui !== 'undefined') ui.repintarNuvemAtual(); } catch (e) {}
    try { syncStatus.refresh(); } catch (e) {}
    try { persistenciaCloudFirst.renderPainel(); } catch (e) {}
    return ops;
  },
  async aquecer() {
    const contexto = persistenciaCloudFirst._contexto();
    if (!contexto) return { ok: false, motivo: 'contexto' };
    await filaCifrada.preparar();
    let migracao = null;
    try { migracao = await persistenciaCloudFirst.migrarLegado(); } catch (e) {}
    const ops = await persistenciaCloudFirst._reindexar();
    try {
      if (typeof store !== 'undefined' && store.restaurarDoCofre) store.restaurarDoCofre(ops);
    } catch (e) {}
    try {
      if (typeof adendos !== 'undefined' && adendos.restaurarDoCofre) adendos.restaurarDoCofre(ops);
    } catch (e) {}
    try {
      if (typeof lixeira !== 'undefined' && lixeira.restaurarDoCofre) lixeira.restaurarDoCofre(ops);
    } catch (e) {}
    try {
      if (typeof edicaoViva !== 'undefined' && edicaoViva.restaurarCifrado) await edicaoViva.restaurarCifrado();
    } catch (e) {}
    try {
      if (typeof rascunhos !== 'undefined' && rascunhos.restaurarCifrado) await rascunhos.restaurarCifrado();
    } catch (e) {}
    return { ok: true, pendentes: ops.length, migracao };
  },
  async _estagiar(op) {
    if (!op || !op.contexto || !contextoAba.corresponde(op.contexto)) {
      throw filaCifrada._erro('contexto_trocado', 'O usuário mudou antes de a operação ficar protegida.');
    }
    const salvo = await filaCifrada.enfileirar({
      operationId: op.operationId, module: op.module, entityId: op.entityId,
      action: op.action, baseVersion: op.baseVersion, dependsOn: op.dependsOn,
      createdAt: op.createdAt, payload: op.payload
    });
    if (!salvo || salvo.durable !== true) {
      throw filaCifrada._erro('fila_indisponivel', 'A transação cifrada não confirmou a proteção offline.');
    }
    /* O commit pode terminar depois de a pessoa mudar de clínica. A cópia
       cifrada continua pertencendo ao dono capturado pelo WAL; não marque
       como protegido um registro de mesmo ID na nova sessão. */
    if (!contextoAba.corresponde(op.contexto)) {
      const erro = filaCifrada._erro('contexto_trocado', 'A operação ficou protegida para a conta anterior.');
      erro.durable = !!(salvo && salvo.durable);
      throw erro;
    }
    persistenciaCloudFirst._pendentes.add(persistenciaCloudFirst._chave(op.module, op.entityId));
    try { await filaCifrada.marcarEstado(op.operationId, 'staged'); } catch (e) {}
    if (!contextoAba.corresponde(op.contexto)) {
      const erro = filaCifrada._erro('contexto_trocado', 'A operação ficou protegida para a conta anterior.');
      erro.durable = !!(salvo && salvo.durable);
      throw erro;
    }
    try {
      if (typeof store !== 'undefined' && store.protegidoNoCofre) {
        store.protegidoNoCofre(op.module, op.entityId);
      }
    } catch (e) {}
    try { if (typeof ui !== 'undefined') ui.repintarNuvemAtual(); } catch (e) {}
    return salvo;
  },
  async _enviar(op, itemAtual, exec = {}) {
    if (!op || !op.contexto || !contextoAba.corresponde(op.contexto)) {
      return { ok: false, motivo: 'contexto_trocado' };
    }
    const p = op && op.payload;
    if (p && p.transport === persistenciaCloudFirst.TRANSPORTE_ADENDO) {
      if (typeof adendos === 'undefined' || !adendos.enviarOperacao) {
        return { ok: false, motivo: 'motor_adendo_indisponivel' };
      }
      return adendos.enviarOperacao(Object.assign({}, op, {
        contexto: op.contexto || persistenciaCloudFirst._contexto()
      }));
    }
    if (!p || p.transport !== persistenciaCloudFirst.TRANSPORTE || ['upsert','delete','restore'].indexOf(p.action) < 0) {
      return { ok: false, motivo: 'operacao_invalida' };
    }
    const opts = { operation: { id: op.operationId, checksum: p.requestChecksum } };
    if (p.action === 'delete') {
      return cloudRel.apagarNaClinica(p.table, p.legacyId, {
        baseVersion: exec.baseVersionOverride || op.baseVersion,
        organizationId: op.contexto && op.contexto.organizationId,
        mod: op.module, operation: opts.operation, semFilaLegada: true
      });
    }
    if (p.action === 'restore') {
      return cloudRel.restaurarNaClinica(p.table, p.legacyId, p.item, {
        baseVersion: exec.baseVersionOverride || op.baseVersion,
        organizationId: op.contexto && op.contexto.organizationId,
        mod: op.module, operation: opts.operation
      });
    }
    let item = itemAtual || p.item;
    if (exec.baseVersionOverride && cloudRel._versao(item) !== Number(exec.baseVersionOverride)) {
      item = persistenciaCloudFirst._clone(item);
      item._relVersion = Number(exec.baseVersionOverride);
    }
    if (op.module === 'pacientes') return cloudRel.enviarPaciente(item, opts);
    if (op.module === 'agenda') return cloudRel.enviarAgenda(item, opts);
    return cloudRel.enviarRegistro(op.module, item, opts);
  },
  _classeFalha(res, erro) {
    if (res && res.conflict) return 'conflict';
    const motivo = String((res && res.motivo) || (erro && (erro.code || erro.message)) || '').toLowerCase();
    const status = Number((res && (res.status || res.statusCode)) || (erro && erro.status)) ||
      Number((motivo.match(/http\s+(\d{3})\b/) || [])[1]) || 0;
    /* Falhas explícitas do servidor prevalecem sobre navigator.onLine. Uma
       resposta 403 não se torna "offline" se o sinal muda logo após o fetch. */
    if (/contexto_trocado|outra_clinica|contexto_nao_confirmado/.test(motivo)) return 'context';
    if (status === 401 || status === 403 || /unauthorized|forbidden|permissao|não autorizado|nao autorizado/.test(motivo)) return 'auth';
    if (status === 409 || /versao_divergente|conflict/.test(motivo)) return 'conflict';
    if (status >= 400 && status < 500 && [408,425,429].indexOf(status) < 0) return 'rejected';
    if ([408,425,429].indexOf(status) >= 0 || status >= 500 && status < 600) return 'outage';
    if (/token/.test(motivo)) {
      try { if (cloud.servidorFora()) return 'outage'; } catch (e) {}
      return 'auth';
    }
    if (/\b(rede|network|failed to fetch|load failed|timeout|timed out)\b/.test(motivo)) return 'outage';
    if (!persistenciaCloudFirst._online() && !erro &&
        (!res || /^offline$/.test(motivo))) return 'outage';
    if (!res && !persistenciaCloudFirst._online() && erro && erro.name === 'TypeError') return 'outage';
    return 'rejected';
  },
  indisponivel(res, erro) { return persistenciaCloudFirst._classeFalha(res, erro) === 'outage'; },
  _reciboValido(op, res) {
    if (!op || !res || !res.ok) return false;
    /* Excluir algo que comprovadamente não existe mais também é convergência.
       `apagarNaClinica` só produz `ausente` depois de uma leitura remota
       escopada pela organização e pelo legacy_id capturados na operação. */
    if (op.payload && op.payload.transport === persistenciaCloudFirst.TRANSPORTE &&
        op.payload.action === 'delete' && res.ausente === true) return true;
    if (!res.row) return false;
    const row = res.row;
    if (op.payload && op.payload.transport === persistenciaCloudFirst.TRANSPORTE_ADENDO) {
      const ad = op.payload.adendo || {};
      return String(row.organization_id || '') === String(op.contexto.organizationId || '') &&
        String(row.legacy_id || '') === String(ad.id || '') &&
        String(row.parent_legacy_id || '') === String(op.payload.parentLegacyId || '') &&
        String(row.texto || '') === String(ad.texto || '') &&
        String(row.reason || '') === String(ad.motivo || 'correcao') &&
        (ad._retificacao || (row.data && row.data.retificacao) != null
          ? typeof adendos !== 'undefined' && row.author_id === op.contexto.userId &&
            Number.isFinite(Date.parse(row.created_at)) && row.parent_table === op.payload.parentTable && !!row.parent_id &&
            adendos.propostaRetificacaoIgual(ad._retificacao, row.data && row.data.retificacao, row) : true);
    }
    const legacy = ['delete','restore'].indexOf(op.payload.action) >= 0
      ? op.payload.legacyId : cloudRel.chaveLegada(op.module, op.payload.item);
    const estadoCorreto = op.payload.action === 'delete' ? !!row.deleted_at :
      op.payload.action === 'restore' ? !row.deleted_at : true;
    return estadoCorreto && String(row.organization_id || '') === String(op.contexto.organizationId || '') &&
      String(row.legacy_id || '') === String(legacy || '') &&
      cloudRel._mesmoRecibo(row, { id: op.operationId, checksum: op.payload.requestChecksum });
  },
  _preservarConflito(op, res) {
    if (op && op.payload && op.payload.action === 'delete') return;
    try {
      const local = op.payload.item;
      if (op.module === 'pacientes') pacientes._resolverConflito(local, res.cloud, res.cloudUpdatedAt);
      else if (op.module === 'agenda') agenda._resolverConflito(local, res.cloud, res.cloudUpdatedAt);
      else cloudRel._resolverConflitoRegistro(op.module, local, res.cloud, res.cloudUpdatedAt);
    } catch (e) {
      try { cloudRel.registrarConflito(op.module, op.payload.item, res.cloud, {
        cloudUpdatedAt: res.cloudUpdatedAt, motivo: res.motivo || 'versao_divergente'
      }); } catch (er) {}
    }
  },
  async _protegerOffline(op, motivo, res) {
    let diario;
    try { diario = await persistenciaCloudFirst._estagiar(op); }
    catch (e) {
      if (contextoAba.corresponde(op.contexto)) {
        try { syncStatus.cloudState('error'); } catch (er) {}
      }
      return { ok: false, blocked: true, queued: false,
        motivo: e.code || e.message || 'fila_indisponivel', durable: e.durable === true,
        operationId: op.operationId };
    }
    try { await filaCifrada.marcarEstado(op.operationId, 'offline', motivo); } catch (e) {}
    if (contextoAba.corresponde(op.contexto)) {
      try { syncStatus.cloudState('offline'); } catch (e) {}
      if (op.payload.transport === persistenciaCloudFirst.TRANSPORTE_ADENDO) {
        try { store.protegidoNoCofre(op.payload.parentModule, op.payload.parentLegacyId); } catch (e) {}
      }
    }
    return Object.assign({}, res || {}, { ok: false, queued: true, durable: true,
      motivo, operationId: op.operationId, checksum: diario.checksum });
  },
  async _executar(op, item, exec = {}) {
    if (!op || !op.contexto || !contextoAba.corresponde(op.contexto)) {
      return { ok: false, motivo: 'contexto_trocado', durable: false };
    }
    const chave = persistenciaCloudFirst._chaveExecucao(op.module, op.entityId);
    persistenciaCloudFirst._intencoesMemoria.set(chave, op);
    if (!persistenciaCloudFirst._online()) {
      return persistenciaCloudFirst._protegerOffline(op, 'offline');
    }
    /* Primeiro resolve a história offline desta entidade. Uma edição online
       nova não pode ultrapassar uma intenção antiga ainda sem recibo. */
    if (persistenciaCloudFirst.temPendente(op.module, op.entityId)) {
      const drenagem = await persistenciaCloudFirst.drenar({ limite: Number.MAX_SAFE_INTEGER });
      if (!contextoAba.corresponde(op.contexto)) {
        return { ok: false, motivo: 'contexto_trocado', durable: false };
      }
      if (persistenciaCloudFirst.temPendente(op.module, op.entityId)) {
        if (drenagem && drenagem.indisponivel === true) {
          return persistenciaCloudFirst._protegerOffline(op, 'rede');
        }
        /* O NÓ DO CONFLITO. A gravação antiga ficou na fila marcada
           "conflito" e só sai quando o conflito estiver decidido; a decisão
           ("manter o meu" ou a regra da última edição) é esta gravação nova —
           que esperava a antiga sair. Uma esperava a outra para sempre.
           Quando a gravação nova É a decisão do conflito deste registro, ela
           passa na frente; as antigas presas em conflito só saem da fila
           DEPOIS do recibo do servidor para a nova, que as substitui (a
           evidência continua preservada no conflito). */
        exec = Object.assign({}, exec, {
          substituidas: exec.substituiConflito ? await persistenciaCloudFirst._presasEmConflito(op) : []
        });
        if (!exec.substituidas.length) {
          return { ok: false, blocked: true, durable: false, motivo: 'operacao_anterior_pendente',
            operationId: op.operationId };
        }
        if (!contextoAba.corresponde(op.contexto)) {
          return { ok: false, motivo: 'contexto_trocado', durable: false };
        }
      }
      const anterior = drenagem && drenagem.confirmados && drenagem.confirmados.find(x =>
        x.mod === op.module && x.id === op.entityId);
      if (anterior && Number.isInteger(anterior.version) && anterior.version > 0) {
        exec = Object.assign({}, exec, { baseVersionOverride: anterior.version });
      }
    }
    try { syncStatus.cloudSyncing(); } catch (e) {}
    let res = null, falha = null;
    try { res = await persistenciaCloudFirst._enviar(op, item, exec); }
    catch (e) { falha = e; }
    if (persistenciaCloudFirst._reciboValido(op, res)) {
      if (!contextoAba.corresponde(op.contexto)) {
        return Object.assign({}, res, { ok: false, durable: true, remoteConfirmed: true,
          motivo: 'contexto_trocado', operationId: op.operationId });
      }
      persistenciaCloudFirst._intencoesMemoria.delete(chave);
      if (exec.substituidas && exec.substituidas.length) {
        for (const velha of exec.substituidas) {
          try { await filaCifrada.confirmar(velha.operationId, { remoteConfirmed: true, checksum: velha.checksum }); } catch (e) {}
        }
        try { await persistenciaCloudFirst._reindexar(); } catch (e) {}
      }
      try {
        if (op.payload.transport === persistenciaCloudFirst.TRANSPORTE_ADENDO) {
          if (typeof adendos !== 'undefined') adendos.confirmarOperacao(op, res.row);
        } else if (!persistenciaCloudFirst.temPendente(op.module, op.entityId) &&
                   typeof store !== 'undefined' && store.confirmarRemoto) {
          store.confirmarRemoto(op.module, op.entityId);
        }
      } catch (e) {}
      try { syncStatus.cloudDone(true); } catch (e) {}
      return Object.assign({}, res, { durable: true, remoteConfirmed: true,
        operationId: op.operationId, checksum: op.payload.requestChecksum });
    }
    const classe = persistenciaCloudFirst._classeFalha(res, falha);
    if (classe === 'outage') {
      return persistenciaCloudFirst._protegerOffline(op,
        (res && res.motivo) || (falha && falha.message) || 'rede', res);
    }
    if (contextoAba.corresponde(op.contexto)) {
      if (classe === 'conflict' && res) persistenciaCloudFirst._preservarConflito(op, res);
      try { syncStatus.cloudDone(false); syncStatus.cloudState('error'); } catch (e) {}
    }
    return Object.assign({}, res || {}, { ok: false, queued: false, blocked: true,
      conflictPreserved: classe === 'conflict', durable: false,
      motivo: (res && res.motivo) || (falha && falha.message) || 'recibo_invalido',
      operationId: op.operationId, checksum: op.payload.requestChecksum });
  },
  async salvar(mod, item, opts = {}) {
    let op;
    try { op = await persistenciaCloudFirst._montar(mod, item); }
    catch (e) { return { ok: false, motivo: e.code || e.message || 'operacao_invalida', durable: false }; }
    return persistenciaCloudFirst._executar(op, item, { substituiConflito: opts.decisaoDeConflito === true });
  },
  /* gravações antigas DESTE registro, deste aparelho, que só estão na fila
     porque esbarraram num conflito (ou ficaram bloqueadas atrás dele) — nunca
     adendo, nunca exclusão, nunca de outro registro */
  async _presasEmConflito(op) {
    let todas = [];
    try { todas = await filaCifrada.listar(); } catch (e) { return []; }
    const chave = persistenciaCloudFirst._chave(op.module, op.entityId);
    const mesmas = todas.filter(o => o && o.operationId !== op.operationId &&
      persistenciaCloudFirst._chave(o.module, o.entityId) === chave);
    if (!mesmas.length) return [];
    const substituivel = o => o.payload && o.payload.action !== 'delete' &&
      o.payload.transport !== persistenciaCloudFirst.TRANSPORTE_ADENDO &&
      o.queue && (o.queue.state === 'conflict' || o.queue.state === 'blocked');
    return mesmas.every(substituivel) && mesmas.some(o => o.queue.state === 'conflict') ? mesmas : [];
  },
  async salvarAdendo(mod, rec, ad, tabela) {
    let op;
    try { op = await persistenciaCloudFirst._montarAdendo(mod, rec, ad, tabela); }
    catch (e) { return { ok: false, motivo: e.code || e.message || 'operacao_invalida', durable: false }; }
    return persistenciaCloudFirst._executar(op);
  },
  async _removerAgora(mod, item) {
    let op;
    try { op = await persistenciaCloudFirst._montarDelete(mod, item); }
    catch (e) { return { ok: false, motivo: e.code || e.message || 'operacao_invalida', durable: false }; }
    let baseVersionOverride = null;
    try {
      if (cloudRel._envioAtivo(mod, item && item._id)) {
        const anterior = await cloudRel.esperarEnvio(mod, item._id);
        const v = Number(anterior && anterior.row && anterior.row.version);
        if (Number.isInteger(v) && v > 0) baseVersionOverride = v;
      }
    } catch (e) {}
    return persistenciaCloudFirst._executar(op, null, { baseVersionOverride });
  },
  remover(mod, item) {
    const id = item && item._id;
    if (!id) return Promise.resolve({ ok: false, motivo: 'operacao_invalida', durable: false });
    return persistenciaCloudFirst._encadear(mod, id,
      () => persistenciaCloudFirst._removerAgora(mod, item));
  },
  async _restaurarAgora(mod, item) {
    let op;
    try { op = await persistenciaCloudFirst._montarRestore(mod, item); }
    catch (e) { return { ok: false, motivo: e.code || e.message || 'operacao_invalida', durable: false }; }
    return persistenciaCloudFirst._executar(op);
  },
  restaurar(mod, item) {
    const id = item && item._id;
    if (!id) return Promise.resolve({ ok: false, motivo: 'operacao_invalida', durable: false });
    return persistenciaCloudFirst._encadear(mod, id,
      () => persistenciaCloudFirst._restaurarAgora(mod, item));
  },
  _prioridade(op) {
    if (!op) return 99;
    if (op.action === 'delete') return 60;
    if (op.action === 'restore') return 70;
    if (op.module === 'pacientes') return 10;
    if (op.module === 'agenda') return 20;
    if (op.module === 'financeiro' || op.module === 'fin_fechamentos' || op.module === 'orcamento') return 50;
    if (op.module === '__addenda__') return 55;
    return 30;
  },
  _tokenPaciente(op) {
    try {
      if (!op || op.module !== 'pacientes' || !op.payload || !op.payload.item) return '';
      return 'patient:' + migracaoFase4._patKey(migracaoFase4._ident(op.payload.item));
    } catch (e) { return ''; }
  },
  _tokenEncounter(op) {
    try {
      if (!op || op.action === 'delete' || ['pacientes','agenda','financeiro','orcamento'].indexOf(op.module) >= 0 ||
          !cloudRel.MODOS[op.module] || !cloudRel.MODOS[op.module].enc) return '';
      return (op.dependsOn || []).find(x => String(x).indexOf('encounter:') === 0) || '';
    } catch (e) { return ''; }
  },
  _tokensProduzidos(op) {
    return [persistenciaCloudFirst._tokenPaciente(op), persistenciaCloudFirst._tokenEncounter(op)].filter(Boolean);
  },
  _ordenar(ops) {
    /* Prioridade organiza entidades diferentes (paciente antes do caso), mas
       nunca pode inverter a história da MESMA entidade. Cada grupo oferece
       somente sua cabeça causal; entre as cabeças escolhemos a prioridade. */
    const grupos = new Map();
    (ops || []).forEach(op => {
      const chave = persistenciaCloudFirst._chave(op && op.module, op && op.entityId);
      if (!grupos.has(chave)) grupos.set(chave, []);
      grupos.get(chave).push(op);
    });
    grupos.forEach(lista => lista.sort((a, b) =>
      String(a.createdAt || '').localeCompare(String(b.createdAt || '')) ||
      String(a.operationId || '').localeCompare(String(b.operationId || ''))));
    const saida = [];
    while (grupos.size) {
      let escolhida = null;
      grupos.forEach((lista, chave) => {
        const op = lista[0];
        if (!escolhida || persistenciaCloudFirst._prioridade(op) < persistenciaCloudFirst._prioridade(escolhida.op) ||
            (persistenciaCloudFirst._prioridade(op) === persistenciaCloudFirst._prioridade(escolhida.op) &&
             (String(op.createdAt || '').localeCompare(String(escolhida.op.createdAt || '')) < 0 ||
              (String(op.createdAt || '') === String(escolhida.op.createdAt || '') &&
               String(op.operationId || '').localeCompare(String(escolhida.op.operationId || '')) < 0)))) {
          escolhida = { chave, op };
        }
      });
      saida.push(escolhida.op);
      const lista = grupos.get(escolhida.chave);
      lista.shift();
      if (!lista.length) grupos.delete(escolhida.chave);
    }
    return saida;
  },
  async _importarUpsert(mod, item, semente, criadoEm) {
    const operationId = await persistenciaCloudFirst._uuidDeterministico(semente);
    const op = await persistenciaCloudFirst._montar(mod, item, {
      operationId, createdAt: criadoEm || new Date().toISOString()
    });
    return persistenciaCloudFirst._estagiar(op);
  },
  async _importarDelete(mod, item, opts, semente) {
    const operationId = await persistenciaCloudFirst._uuidDeterministico(semente);
    const op = await persistenciaCloudFirst._montarDelete(mod, item, Object.assign({}, opts, { operationId }));
    return persistenciaCloudFirst._estagiar(op);
  },
  async migrarLegado() {
    const contexto = persistenciaCloudFirst._contexto();
    if (!contexto) return { migradas: 0, restantes: 0, motivo: 'contexto' };
    await filaCifrada.preparar();
    const ownerSeed = [contexto.organizationId, contexto.userId, contexto.deviceId].join(':');
    let migradas = 0, falhas = 0;

    /* Fila relacional de upserts: o ID antigo aponta para o snapshot mais
       recente no cache. A entrada só sai do localStorage depois que esse
       snapshot está confirmado no IndexedDB cifrado. */
    const rel = cloudRel._filaLer();
    const relRestante = [];
    for (const it of rel) {
      let item = null;
      try { item = store.getById(it.mod, it.id); } catch (e) {}
      if (!item || !cloudRel.suportaModulo(it.mod)) { relRestante.push(it); falhas++; continue; }
      try {
        const marca = item._updatedAt || item._createdAt || it.ts || '';
        const conteudo = await filaCifrada._sha256(filaCifrada._estavel(item));
        await persistenciaCloudFirst._importarUpsert(it.mod, item,
          'rel:' + ownerSeed + ':' + it.mod + ':' + it.id + ':' + marca + ':' + conteudo,
          it.ts ? new Date(it.ts).toISOString() : null);
        migradas++;
      } catch (e) { relRestante.push(it); falhas++; }
    }
    if (relRestante.length !== rel.length && cloudRel._filaGravar(relRestante) === false) falhas++;

    /* Soft-deletes já não têm registro no cache; a fila antiga carrega toda a
       identidade/versionamento necessária para construir a operação cifrada. */
    const dels = cloudRel._filaDelLer();
    const delRestante = [];
    for (const it of dels) {
      const mod = it.mod || persistenciaCloudFirst._modDaTabela(it.tabela);
      if (!mod) { delRestante.push(it); falhas++; continue; }
      const item = { _id: it.id, _relVersion: it.baseVersion || null,
        _relOrg: it.organizationId || contexto.organizationId };
      try {
        await persistenciaCloudFirst._importarDelete(mod, item, {
          tabela: it.tabela, legacyId: it.id, baseVersion: it.baseVersion,
          organizationId: it.organizationId || contexto.organizationId,
          createdAt: it.em || new Date().toISOString()
        }, 'del:' + ownerSeed + ':' + it.tabela + ':' + it.id + ':' + (it.em || it.baseVersion || ''));
        migradas++;
      } catch (e) { delRestante.push(it); falhas++; }
    }
    if (delRestante.length !== dels.length && cloudRel._filaDelGravar(delRestante) === false) falhas++;

    /* Última fila pessoal de versões antigas. Ela nunca volta a fazer I/O: os
       payloads ainda existentes são copiados diretamente para o canal da
       organização e só então removidos da chave legada. */
    const pessoais = cloud._fila();
    const pessoaisRestantes = [];
    for (const it of pessoais) {
      if (!it || !it.modulo || !it.doc_id || !cloudRel.suportaModulo(it.modulo)) {
        pessoaisRestantes.push(it); falhas++; continue;
      }
      const item = persistenciaCloudFirst._clone(it.dados && typeof it.dados === 'object'
        ? it.dados : { _id: it.doc_id });
      if (!item._id) item._id = it.doc_id;
      try {
        const conteudo = await filaCifrada._sha256(filaCifrada._estavel(item));
        const seed = 'pessoal:' + ownerSeed + ':' + (it.operation_id || '') + ':' +
          it.modulo + ':' + it.doc_id + ':' + (it.ts || it.base_version || '') + ':' + conteudo;
        if (it.operacao === 'delete') {
          await persistenciaCloudFirst._importarDelete(it.modulo, item, {
            baseVersion: item._relVersion || null, organizationId: contexto.organizationId,
            createdAt: it.ts ? new Date(it.ts).toISOString() : null
          }, seed);
        } else {
          await persistenciaCloudFirst._importarUpsert(it.modulo, item, seed,
            it.ts ? new Date(it.ts).toISOString() : null);
        }
        migradas++;
      } catch (e) { pessoaisRestantes.push(it); falhas++; }
    }
    if (pessoaisRestantes.length !== pessoais.length) {
      try {
        const dono = cloud._donoFila();
        const outras = cloud._filaTodas().filter(x => !cloud._mesmoDonoFila(x, dono));
        localStorage.setItem(cloud.QUEUE_KEY, JSON.stringify(outras.concat(pessoaisRestantes)));
      } catch (e) { falhas++; }
    }

    await persistenciaCloudFirst._reindexar();
    return { migradas, falhas,
      /* Relê as chaves: quota ou bloqueio do localStorage pode ter impedido a
         remoção mesmo depois da cópia cifrada. Nesse caso a entrada continua
         segura e aparece como restante; a próxima abertura repete o mesmo
         UUID sem duplicar a operação. */
      restantes: cloudRel._filaLer().length + cloudRel._filaDelLer().length + cloud._fila().length };
  },
  async drenar(opts = {}) {
    if (persistenciaCloudFirst._drenando || !persistenciaCloudFirst._online()) return null;
    const contexto = persistenciaCloudFirst._contexto();
    if (!contexto || !cloudRel.disponivel()) return null;
    persistenciaCloudFirst._drenando = true;
    let enviados = 0, conflitos = 0, bloqueados = 0, liberadas = 0, indisponivel = false;
    const confirmados = new Map();
    try {
      const ops = await filaCifrada.listar();
      const proprias = persistenciaCloudFirst._ordenar(ops.filter(persistenciaCloudFirst._transporta));
      const produtores = new Set(proprias.flatMap(persistenciaCloudFirst._tokensProduzidos));
      const dependenciasFalhas = new Set();
      const entidadesFalhas = new Set();
      const versoesConfirmadas = new Map();
      const limite = Math.max(1, Number(opts.limite) || 40);
      for (const op of proprias.slice(0, limite)) {
        if (!contextoAba.corresponde(contexto)) break;
        const entidade = persistenciaCloudFirst._chave(op.module, op.entityId);
        const tokensProduzidos = persistenciaCloudFirst._tokensProduzidos(op);
        const dependenciaQueFalhou = (op.dependsOn || []).some(d => produtores.has(d) && dependenciasFalhas.has(d));
        if (entidadesFalhas.has(entidade) || dependenciaQueFalhou) {
          bloqueados++;
          try { await filaCifrada.marcarEstado(op.operationId, 'blocked', 'dependencia_pendente'); } catch (e) {}
          continue;
        }
        if (op.queue && op.queue.state === 'conflict') {
          let saida = null;
          try { saida = await persistenciaCloudFirst._conflitoJaResolvido(op, contexto); } catch (e) {}
          if (!contextoAba.corresponde(contexto)) break;
          if (saida === 'liberada') { liberadas++; continue; }
          if (saida === 'reenviar') {
            /* sem evidência do conflito no servidor: a gravação volta a ser
               tentada — nada se apaga sem prova; havendo divergência, vira um
               conflito novo, com a evidência guardada, e se decide uma vez */
            try { await filaCifrada.marcarEstado(op.operationId, 'staged', 'conflito_sem_evidencia_reenviado'); } catch (e) {}
          }
          conflitos++; entidadesFalhas.add(entidade);
          tokensProduzidos.forEach(x => dependenciasFalhas.add(x));
          continue;
        }
        try { await filaCifrada.marcarEstado(op.operationId, 'sending'); } catch (e) {}
        let res = null, falha = null;
        try { res = await persistenciaCloudFirst._enviar(Object.assign({}, op, { contexto }), null, {
          baseVersionOverride: versoesConfirmadas.get(entidade) || null
        }); }
        catch (e) { falha = e; }
        if (!contextoAba.corresponde(contexto)) break;
        if (persistenciaCloudFirst._reciboValido(Object.assign({}, op, { contexto }), res)) {
          try {
            const retirou = await filaCifrada.confirmar(op.operationId, {
              remoteConfirmed: true, checksum: op.checksum
            });
            if (!retirou) throw filaCifrada._erro('recibo_local_pendente',
              'O servidor confirmou, mas a intenção cifrada ainda não pôde ser removida.');
          } catch (e) {
            bloqueados++;
            try { await filaCifrada.registrarFalha(op.operationId, e); } catch (er) {}
            break;
          }
          if (!contextoAba.corresponde(contexto)) break;
          const chaveMemoria = persistenciaCloudFirst._chaveExecucao(op.module, op.entityId);
          const intencaoMemoria = persistenciaCloudFirst._intencoesMemoria.get(chaveMemoria);
          if (intencaoMemoria && intencaoMemoria.operationId === op.operationId) {
            persistenciaCloudFirst._intencoesMemoria.delete(chaveMemoria);
          }
          if (op.payload && op.payload.transport === persistenciaCloudFirst.TRANSPORTE_ADENDO) {
            try { if (typeof adendos !== 'undefined') adendos.confirmarOperacao(op, res.row); } catch (e) {}
          }
          const versao = Number(res && res.row && res.row.version);
          if (Number.isInteger(versao) && versao > 0) versoesConfirmadas.set(entidade, versao);
          confirmados.set(entidade, { mod: op.module, id: op.entityId, version: versao });
          enviados++;
          continue;
        }
        const classe = persistenciaCloudFirst._classeFalha(res, falha);
        let motivoPreso = '';
        if (op.payload && op.payload.transport === persistenciaCloudFirst.TRANSPORTE_ADENDO &&
            ['outage', 'auth', 'context'].indexOf(classe) < 0) {
          let saida = null;
          try { saida = await persistenciaCloudFirst._adendoPreso(op, contexto); } catch (e) {}
          if (!contextoAba.corresponde(contexto)) break;
          if (saida && saida.preso) motivoPreso = saida.preso;
          else if (saida) { liberadas++; continue; }
        }
        entidadesFalhas.add(entidade);
        tokensProduzidos.forEach(x => dependenciasFalhas.add(x));
        if (classe === 'conflict' && res) {
          persistenciaCloudFirst._preservarConflito(Object.assign({}, op, { contexto }), res);
          conflitos++;
        } else bloqueados++;
        try { await filaCifrada.marcarEstado(op.operationId,
          classe === 'conflict' ? 'conflict' : classe === 'outage' ? 'offline' : 'blocked',
          motivoPreso || (res && res.motivo) || (falha && falha.message) || (res && res.ok ? 'recibo_divergente' : classe)); } catch (e) {}
        try { await filaCifrada.registrarFalha(op.operationId,
          motivoPreso || (res && res.motivo) || falha || (res && res.ok ? 'recibo_divergente' : classe)); } catch (e) {}
        if (classe === 'outage') { indisponivel = true; break; }
      }
      if (!contextoAba.corresponde(contexto)) {
        return { enviados, conflitos, bloqueados, motivo: 'contexto_trocado', confirmados: [] };
      }
      await persistenciaCloudFirst._reindexar();
      if (!contextoAba.corresponde(contexto)) {
        return { enviados, conflitos, bloqueados, motivo: 'contexto_trocado', confirmados: [] };
      }
      confirmados.forEach(alvo => {
        try {
          if (!persistenciaCloudFirst.temPendente(alvo.mod, alvo.id) &&
              typeof store !== 'undefined' && store.confirmarRemoto) {
            store.confirmarRemoto(alvo.mod, alvo.id);
          }
        } catch (e) {}
      });
      try { syncStatus.cloudState(persistenciaCloudFirst._pendentes.size ? 'queued' : 'synced'); } catch (e) {}
      return { enviados, conflitos, bloqueados, liberadas, indisponivel,
        confirmados: Array.from(confirmados.values()), restantes: persistenciaCloudFirst._pendentes.size };
    } finally { persistenciaCloudFirst._drenando = false; }
  },
  /* A GRAVAÇÃO QUE ESPERAVA UM CONFLITO QUE JÁ FOI DECIDIDO.
     Quando o envio esbarra numa versão mais nova, a gravação fica na fila
     marcada "conflito" e a sua cópia vai, como evidência, para o conflito
     preservado (sync_conflicts). Decidir o conflito — escolher a nuvem, ou
     escolher este aparelho, que regrava como uma operação NOVA — nunca
     retirava a operação antiga da fila. Ela ficava ali para sempre: segurava
     o aviso "aguardam recibo" e bloqueava as gravações seguintes do mesmo
     atendimento, que na drenagem vêm depois dela.
     A fila só apaga com prova do servidor, e continua assim. A prova aqui é o
     próprio servidor dizendo que os conflitos deste registro existem e estão
     todos resolvidos: a evidência está lá, e a decisão também. Enquanto houver
     conflito pendente (aqui ou lá), a operação espera. Sem nenhum registro do
     conflito no servidor, ela não é apagada: volta a ser enviada.
     Consulta no máximo uma vez a cada 10 minutos por operação. */
  _consultasConflito: new Map(),
  async _conflitoJaResolvido(op, contexto) {
    /* a chave com que o conflito foi registrado (paciente usa a identidade) */
    let id = '';
    try { id = String(cloudRel.chaveLegada(op.module, op.payload && op.payload.item) || ''); } catch (e) {}
    if (!id) id = String(op.entityId || '');
    if (!id) return null;
    const ultima = persistenciaCloudFirst._consultasConflito.get(op.operationId) || 0;
    if (Date.now() - ultima < 600000) return null;
    persistenciaCloudFirst._consultasConflito.set(op.operationId, Date.now());
    /* decisão ainda não confirmada no servidor: espera */
    const local = (cloudRel._conflitosLer() || []).some(x => x && x.status === 'pending' &&
      String(x.legacyId) === id);
    if (local) return null;
    if (!(await cloud._garantirToken())) return null;
    const org = contexto.organizationId;
    if (!contextoAba.corresponde(contexto)) return null;
    const c = cloud.config();
    const r = await fetch(c.url + '/rest/v1/sync_conflicts?organization_id=eq.' + encodeURIComponent(org) +
      '&record_legacy_id=eq.' + encodeURIComponent(id) + '&select=status', { headers: cloud._headers(true) });
    if (!r.ok || !contextoAba.corresponde(contexto)) return null;
    const rows = await r.json().catch(() => null);
    if (!Array.isArray(rows)) return null;
    if (!rows.length) return 'reenviar';
    if (rows.some(x => x && x.status === 'pending')) return null;
    const ok = await filaCifrada.confirmar(op.operationId, { remoteConfirmed: true, checksum: op.checksum });
    return ok ? 'liberada' : null;
  },
  /* O ADENDO QUE NUNCA SAÍA DA FILA.
     Retificações gravadas antes de a nuvem carimbar a versão (status/revisão)
     voltam sem esse carimbo: o recibo nunca bate e a operação era reenviada
     para sempre — 250 tentativas, "esperando outra gravação". A nuvem não
     deixa o mesmo identificador guardar outra proposta, então a linha com o
     identificador, o pai e o autor desta operação É a prova de que ela está
     lá: a operação sai e a linha da nuvem é adotada.
     Sem linha na nuvem, olha o pai. Pai finalizado: a falha é outra e fica à
     vista. Pai ainda não finalizado (ou ausente) na nuvem:
       • finalizado aqui → a finalização deste aparelho sobe primeiro e o
         adendo vai na rodada seguinte;
       • não finalizado aqui (pré-lançamento, ficha aberta) → não é caso de
         adendo: a correção entra no próprio registro, como edição comum, e a
         operação só sai depois do recibo dessa edição.
     Consulta no máximo uma vez a cada 10 minutos por operação. */
  _consultasAdendo: new Map(),
  async _adendoPreso(op, contexto) {
    const p = op && op.payload;
    if (!p || p.transport !== persistenciaCloudFirst.TRANSPORTE_ADENDO || !p.adendo || !p.adendo.id ||
        typeof adendos === 'undefined' || !adendos.MODS[p.parentModule]) return null;
    /* o motivo de continuar presa vai para o painel "o que falta?" — e
       continua lá entre uma consulta e outra */
    const memo = persistenciaCloudFirst._motivosAdendo || (persistenciaCloudFirst._motivosAdendo = new Map());
    const ultima = persistenciaCloudFirst._consultasAdendo.get(op.operationId) || 0;
    if (Date.now() - ultima < 600000) return memo.get(op.operationId) || null;
    persistenciaCloudFirst._consultasAdendo.set(op.operationId, Date.now());
    const preso = m => { const x = { preso: 'adendo preso: ' + m }; memo.set(op.operationId, x); return x; };
    if (!(await cloud._garantirToken()) || !contextoAba.corresponde(contexto)) return null;
    const org = contexto.organizationId, c = cloud.config();
    const sel = 'id,organization_id,legacy_id,reason,texto,data,author_id,created_at,parent_table,parent_id,parent_legacy_id,retification_revision';
    const r = await fetch(c.url + '/rest/v1/addenda?organization_id=eq.' + encodeURIComponent(org) +
      '&legacy_id=eq.' + encodeURIComponent(p.adendo.id) + '&select=' + sel, { headers: cloud._headers(true) });
    if (!contextoAba.corresponde(contexto)) return null;
    if (!r.ok) return preso('consulta à nuvem falhou (http ' + r.status + ')');
    const rows = await r.json().catch(() => null);
    if (!Array.isArray(rows)) return preso('resposta da nuvem ilegível');
    const comContexto = Object.assign({}, op, { contexto });
    const row = rows[0];
    if (row) {
      if (row.organization_id !== org) return preso('a linha da nuvem é de outra clínica');
      if (row.parent_table !== p.parentTable || String(row.parent_legacy_id || '') !== String(p.parentLegacyId)) {
        return preso('a linha da nuvem pertence a outro documento');
      }
      /* O MESMO ADENDO JÁ ESTÁ NA NUVEM, gravado por outra conta da clínica
         (o mesmo documento, o mesmo id). Com este id não há mais o que subir —
         a nuvem não troca linha de adendo. A linha da nuvem é adotada; se o
         conteúdo daqui é outro, ele sobe como um adendo novo deste usuário,
         por cima: a última edição não se perde e nada fica preso. */
      if (String(row.author_id || '') !== String(contexto.userId)) {
        /* linha sem carimbo de versão: a própria adoção já reaplica a proposta daqui */
        const valida = !!adendos._normalizarRetificacao(row.data && row.data.retificacao, row);
        const reemitir = valida && !adendos._mesmoConteudoAdendo(p.adendo, row);
        try { adendos.adotarDaNuvem(comContexto, row); } catch (e) {}
        if (reemitir && !adendos.reemitirComoNovo(comContexto)) {
          return preso('a nuvem já tem este adendo (outro usuário) com conteúdo diferente, e não foi possível reenviá-lo como novo');
        }
        const ok = await filaCifrada.confirmar(op.operationId, { remoteConfirmed: true, checksum: op.checksum });
        return ok ? 'liberada' : null;
      }
      const ok = await filaCifrada.confirmar(op.operationId, { remoteConfirmed: true, checksum: op.checksum });
      if (!ok || !contextoAba.corresponde(contexto)) return ok ? 'liberada' : null;
      try { adendos.adotarDaNuvem(comContexto, row); } catch (e) {}
      return 'liberada';
    }
    const pai = await cloudRel._lerAtualTab(p.parentTable, org, p.parentLegacyId, 'id,finalized_at');
    if (!contextoAba.corresponde(contexto)) return null;
    if (pai && pai.finalized_at) return preso('documento finalizado na nuvem, mas a nuvem recusa o adendo (' + persistenciaCloudFirst._motivoOriginal(op) + ')');
    const rec = store.getById(p.parentModule, p.parentLegacyId);
    if (!rec) return preso('o documento deste adendo não está neste aparelho');
    if (rec._finalizado) {
      try { await persistenciaCloudFirst.salvar(p.parentModule, rec); } catch (e) {}
      return null;
    }
    const novo = adendos.converterEmEdicao(comContexto);
    if (!novo) return preso('adendo só de texto num documento não finalizado na nuvem');
    const res = await persistenciaCloudFirst.salvar(p.parentModule, novo);
    if (!contextoAba.corresponde(contexto)) return null;
    if (!res || res.remoteConfirmed !== true) return preso('a correção virou edição comum, mas a nuvem ainda não confirmou (' + String(res && res.motivo || '') + ')');
    const ok = await filaCifrada.confirmar(op.operationId, { remoteConfirmed: true, checksum: op.checksum });
    return ok ? 'convertida' : null;
  },
  /* o erro de envio sem o "adendo preso: …" de consultas anteriores */
  _motivoOriginal(op) {
    let m = String(op && op.queue && op.queue.lastError || '');
    for (let i = 0; i < 20 && /^adendo preso: .*\((.*)\)$/.test(m); i++) m = m.replace(/^adendo preso: .*?\((.*)\)$/, '$1');
    return m || 'sem motivo';
  },
  async listarFila() {
    try {
      const ops = await filaCifrada.listar();
      return ops.filter(persistenciaCloudFirst._transporta).map(op => ({
        mod: op.module, id: op.entityId,
        acao: (op.payload && (op.payload.transport === persistenciaCloudFirst.TRANSPORTE_ADENDO ? 'adendo' : op.payload.action)) || 'gravação',
        estado: (op.queue && op.queue.state) || 'staged',
        tentativas: (op.queue && op.queue.attempts) || 0,
        erro: (op.queue && op.queue.lastError) || '',
        quando: op.createdAt || ''
      }));
    } catch (e) { return []; }
  },
  _tempoDesde(iso) {
    const ms = Date.now() - Date.parse(iso || '');
    if (!Number.isFinite(ms) || ms < 0) return '—';
    const min = Math.floor(ms / 60000);
    if (min < 1) return 'agora';
    if (min < 60) return min + ' min';
    const h = Math.floor(min / 60);
    if (h < 48) return h + ' h';
    return Math.floor(h / 24) + ' d';
  },
  _dataHora(iso) {
    try { return iso ? new Date(iso).toLocaleString('pt-BR') : 'ainda não houve'; }
    catch (e) { return '—'; }
  },
  async renderPainel() {
    if (typeof document === 'undefined') return;
    const el = document.getElementById('fila-cifrada-painel');
    if (!el) return;
    const contexto = persistenciaCloudFirst._contexto();
    if (!contexto) {
      el.textContent = '🔒 Fila offline fechada — entre na clínica para ver as pendências desta conta.';
      return;
    }
    try {
      const resumo = await filaCifrada.resumo();
      if (!contextoAba.corresponde(contexto)) return;
      const partes = [
        '<b>Diário cifrado:</b> ' + resumo.total + (resumo.total === 1 ? ' operação' : ' operações'),
        'mais antiga: ' + (resumo.maisAntiga ? persistenciaCloudFirst._tempoDesde(resumo.maisAntiga) : '—'),
        'tentativas: ' + resumo.tentativas,
        'com erro: ' + resumo.comErro,
        'última confirmação: ' + utils.escapeHTML(persistenciaCloudFirst._dataHora(resumo.ultimaConfirmacao))
      ];
      const erro = resumo.ultimoErro
        ? '<div style="margin-top:4px;color:#9a4f00">Último erro: ' + utils.escapeHTML(String(resumo.ultimoErro)) + '</div>' : '';
      el.innerHTML = partes.join(' · ') + erro;
    } catch (e) {
      if (contextoAba.corresponde(contexto)) {
        el.textContent = '⚠️ Não foi possível abrir o resumo cifrado desta conta.';
      }
    }
  },
  bloquear() {
    persistenciaCloudFirst._pendentes.clear();
    persistenciaCloudFirst._ownerKey = '';
    persistenciaCloudFirst._intencoesMemoria.clear();
    try { persistenciaCloudFirst.renderPainel(); } catch (e) {}
  }
};
try {
  contextoAba.aoMudar(() => persistenciaCloudFirst.bloquear());
  window.persistenciaCloudFirst = persistenciaCloudFirst;
} catch (e) {}

/* FIM DA PERSISTÊNCIA CLOUD-FIRST */
