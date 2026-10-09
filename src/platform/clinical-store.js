'use strict';

/* ============================================================================
   STORE — listas clínicas transitórias e leitura de legado
============================================================================ */
const store = {
  _confirmacoes: new WeakMap(),
  _confirmacoesPorId: new Map(),
  /* Registros e intenções novas vivem somente na memória da aba. Não existe
     cópia intermediária em claro: online, a confirmação vem do servidor;
     indisponibilidade autoriza apenas o WAL cifrado. Legado já existente é
     lido para migração e removido somente após proteção/recibo verificável. */
  _memoria: new Map(),
  _ownerKey: '',
  _pendentesLocais: new Set(),
  _protegidosCofre: new Set(),
  _auditoriaMemoria: [],
  _versoesMemoria: new Map(),
  _blobsMemoria: {},
  _clone(v) {
    try { return JSON.parse(JSON.stringify(v)); }
    catch (e) { return v; }
  },
  _contextoKey() {
    try {
      const c = contextoAba.atual();
      return [c.generation, c.userId, c.organizationId, c.tabId].join(':');
    } catch (e) { return 'sem-contexto'; }
  },
  _garantirContexto() {
    const atual = store._contextoKey();
    if (store._ownerKey === atual) return atual;
    store._ownerKey = atual;
    store._memoria.clear();
    store._pendentesLocais.clear();
    store._protegidosCofre.clear();
    store._confirmacoesPorId.clear();
    store._auditoriaMemoria = [];
    store._versoesMemoria.clear();
    store._blobsMemoria = {};
    return atual;
  },
  _cloudManaged(modKey) {
    return ['pacientes','agenda','pre','consulta','anestesia','recuperacao',
      'risco','termo','prescricao','documentos','financeiro','fin_fechamentos',
      'orcamento','orcamentos','assinaturas'].indexOf(modKey) >= 0;
  },
  cloudOnlyAtivo(modKey) {
    if (modKey && !store._cloudManaged(modKey)) return false;
    try {
      if (localStorage.getItem('medsys.v7.demo') === '1') return false;
      return contextoAba.operational();
    } catch (e) { return false; }
  },
  _chavePendente(modKey, id) { return String(modKey || '') + ':' + String(id || ''); },
  _marcarPendente(modKey, id) {
    if (!id || !store.cloudOnlyAtivo(modKey)) return;
    store._pendentesLocais.add(store._chavePendente(modKey, id));
  },
  temPendenteLocal(modKey, id) {
    store._garantirContexto();
    return store._pendentesLocais.has(store._chavePendente(modKey, id));
  },
  _lembrar(modKey, arr) {
    store._garantirContexto();
    store._memoria.set(modKey, store._clone(Array.isArray(arr) ? arr : []));
  },
  _semPersistenciaClinica(modKey) {
    if (modKey && !store._cloudManaged(modKey)) return false;
    try {
      if (localStorage.getItem('medsys.v7.demo') !== '1') return true;
      /* A flag isolada não transforma dados reais em demonstração. Somente
         o namespace demo criado no boot pode persistir amostras sintéticas. */
      const chaves = modKey ? [STORAGE[modKey]] : Object.keys(STORAGE)
        .filter(mod => store._cloudManaged(mod)).map(mod => STORAGE[mod]);
      return !chaves.length || !chaves.every(chave => typeof chave === 'string' && chave.indexOf('demo:') === 0);
    } catch (e) { return true; }
  },
  _duraveis(modKey, arr) {
    if (!Array.isArray(arr)) return arr;
    return store._semPersistenciaClinica(modKey) ? [] : arr.map(it => store._desidratar(it));
  },
  _persistirSomente(modKey, arr) {
    /* Não regrava nem amplia o legado: ele já existia antes desta versão e
       precisa sobreviver até migrar, mas nunca recebe uma intenção nova. */
    if (store._semPersistenciaClinica(modKey)) return true;
    const chave = STORAGE[modKey];
    if (!chave) return false;
    try { localStorage.setItem(chave, JSON.stringify(store._duraveis(modKey, arr))); return true; }
    catch (e) { store._ultimoErroPersistencia = e; return false; }
  },
  _retirarDuravel(modKey, id) {
    if (!id || !STORAGE[modKey]) return false;
    try {
      const arr = JSON.parse(localStorage.getItem(STORAGE[modKey]) || '[]');
      if (!Array.isArray(arr)) return false;
      const ficam = arr.filter(x => !x || String(x._id || '') !== String(id));
      if (ficam.length === arr.length) return true;
      if (ficam.length) localStorage.setItem(STORAGE[modKey], JSON.stringify(ficam));
      else localStorage.removeItem(STORAGE[modKey]);
      return true;
    } catch (e) { return false; }
  },
  protegidoNoCofre(modKey, id) {
    if (!id || !store.cloudOnlyAtivo(modKey)) return false;
    store._garantirContexto();
    store._protegidosCofre.add(store._chavePendente(modKey, id));
    return store._retirarDuravel(modKey, id);
  },
  confirmarRemoto(modKey, id) {
    if (!id) return false;
    store._garantirContexto();
    const chave = store._chavePendente(modKey, id);
    store._pendentesLocais.delete(chave);
    store._protegidosCofre.delete(chave);
    const retirou = store._retirarDuravel(modKey, id);
    try { if (typeof ui !== 'undefined') ui.repintarNuvemAtual(); } catch (e) {}
    return retirou;
  },
  restaurarDoCofre(ops) {
    store._garantirContexto();
    const proprias = (Array.isArray(ops) ? ops : []).filter(op => op && op.payload &&
      op.payload.transport === 'cloud-rel-v1' && store._cloudManaged(op.module));
    proprias.sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
    proprias.forEach(op => {
      const modKey = op.module;
      const id = String(op.entityId || (op.payload.item && op.payload.item._id) || '');
      if (!id) return;
      let lista = store._memoria.has(modKey) ? store._clone(store._memoria.get(modKey)) : [];
      const ix = lista.findIndex(x => x && String(x._id || '') === id);
      if (op.payload.action === 'delete') {
        if (ix >= 0) lista.splice(ix, 1);
      } else if (op.payload.item) {
        const item = store._clone(op.payload.item);
        if (ix >= 0) lista[ix] = item; else lista.unshift(item);
      }
      store._memoria.set(modKey, lista);
      const chave = store._chavePendente(modKey, id);
      store._pendentesLocais.add(chave);
      store._protegidosCofre.add(chave);
      store._retirarDuravel(modKey, id);
    });
    return proprias.length;
  },
  purgarConfirmadosDuraveis() {
    if (!store.cloudOnlyAtivo()) return 0;
    let removidos = 0;
    ['pacientes','agenda','pre','consulta','anestesia','recuperacao','risco','termo',
      'prescricao','documentos','financeiro','fin_fechamentos','orcamento'].forEach(modKey => {
      try {
        const chaveStorage = STORAGE[modKey];
        const arr = JSON.parse(localStorage.getItem(chaveStorage) || '[]');
        if (!Array.isArray(arr) || !arr.length) return;
        const ficam = arr.filter(it => {
          const chave = store._chavePendente(modKey, it && it._id);
          const manter = it && !store._protegidosCofre.has(chave) &&
            (store._pendentesLocais.has(chave) || !it._relUpdatedAt);
          if (!manter) removidos++;
          return manter;
        });
        if (ficam.length) localStorage.setItem(chaveStorage, JSON.stringify(ficam));
        else localStorage.removeItem(chaveStorage);
      } catch (e) {}
    });
    return removidos;
  },
  purgarArtefatosConfirmadosDuraveis() {
    if (!store.cloudOnlyAtivo()) return 0;
    let removidos = 0;
    /* Esses artefatos antigos contêm resumo, snapshot ou nome de paciente.
       No contrato cloud-only eles existem apenas em memória/servidor. */
    try {
      ['medsys.v7.audit', 'medsys.v7.arquivo.indice', 'medsys.v7.arquivo.auto']
        .forEach(k => { if (localStorage.getItem(k) != null) removidos++; localStorage.removeItem(k); });
    } catch (e) {}
    try {
      if (typeof disco !== 'undefined') {
        if (disco.get('medsys.v7.versions') != null) removidos++;
        disco.remove('medsys.v7.versions');
      }
    } catch (e) {}

    /* Blobs legados só permanecem se ainda forem referenciados por uma cópia
       sem recibo que não chegou ao WAL. Assim não se apaga a única imagem de
       uma operação antiga, mas também não sobra assinatura órfã no aparelho. */
    try {
      const refs = new Set();
      const visitar = valor => {
        if (typeof valor === 'string') { if (valor.indexOf('blob:') === 0) refs.add(valor); return; }
        if (Array.isArray(valor)) { valor.forEach(visitar); return; }
        if (valor && typeof valor === 'object') Object.keys(valor).forEach(k => visitar(valor[k]));
      };
      ['pacientes','agenda','pre','consulta','anestesia','recuperacao','risco','termo',
        'prescricao','documentos','financeiro','fin_fechamentos','orcamento'].forEach(modKey => {
        const raw = localStorage.getItem(STORAGE[modKey]);
        if (raw) { try { visitar(JSON.parse(raw)); } catch (e) {} }
      });
      if (typeof disco !== 'undefined') {
        const blobs = JSON.parse(disco.get(store.BLOBS_KEY) || '{}');
        const manter = {};
        Object.keys(blobs).forEach(ref => { if (refs.has(ref)) manter[ref] = blobs[ref]; else removidos++; });
        if (Object.keys(manter).length) disco.set(store.BLOBS_KEY, JSON.stringify(manter));
        else disco.remove(store.BLOBS_KEY);
      }
    } catch (e) {}
    return removidos;
  },
  _confirmacaoId(item) {
    if (!item || !item._id) return '';
    return store._contextoKey() + ':' + String(item._id);
  },
  _registrarConfirmacao(item, promessa) {
    if (!item || !promessa || typeof promessa.then !== 'function') return promessa;
    try {
      store._garantirContexto();
      const p = Promise.resolve(promessa);
      store._confirmacoes.set(item, p);
      const chave = store._confirmacaoId(item);
      if (chave) {
        store._confirmacoesPorId.delete(chave);
        store._confirmacoesPorId.set(chave, p);
        while (store._confirmacoesPorId.size > 1000) {
          store._confirmacoesPorId.delete(store._confirmacoesPorId.keys().next().value);
        }
      }
    } catch (e) {}
    return promessa;
  },
  aguardarNuvem(item) {
    try {
      return store._confirmacoes.get(item) || store._confirmacoesPorId.get(store._confirmacaoId(item)) ||
        Promise.resolve({ ok: false, motivo: 'sem_envio', durable: false });
    }
    catch (e) { return Promise.resolve({ ok: false, motivo: 'sem_envio', durable: false }); }
  },
  /* Um clique não é recibo. Este é o único texto de resultado usado pelos
     formulários clínicos: confirma nuvem, declara fila offline cifrada ou
     informa falha sem chamar nenhum desses estados de "salvo" antes da hora. */
  notificarNuvem(item, rotulo = 'Registro', opts = {}) {
    const contextoAviso = (() => { try { return contextoAba.capturar(); } catch (e) { return null; } })();
    const chaveAviso = store._contextoKey();
    const avisoAtual = () => {
      try { return contextoAviso ? contextoAba.corresponde(contextoAviso) : store._contextoKey() === chaveAviso; }
      catch (e) { return false; }
    };
    const hora = () => new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    try { if (typeof setSavedStatus === 'function') setSavedStatus('Enviando para a nuvem…'); } catch (e) {}
    if (!opts.silencioso) {
      try { toast('⏳ ' + rotulo + ': aguardando confirmação da nuvem', 'info'); } catch (e) {}
    }
    const confirmacao = store.aguardarNuvem(item);
    Promise.resolve(confirmacao).then(res => {
      if (!avisoAtual()) return res;
      if (res && (res.remoteConfirmed === true || res.ok === true)) {
        try { if (typeof setSavedStatus === 'function') setSavedStatus('Confirmado na nuvem às ' + hora()); } catch (e) {}
        if (!opts.silencioso) { try { toast('☁️ ' + rotulo + ' confirmado na nuvem', 'success'); } catch (e) {} }
        return res;
      }
      if (res && res.durable === true && (res.queued === true || res.motivo === 'offline')) {
        try { if (typeof setSavedStatus === 'function') setSavedStatus('Protegido offline às ' + hora()); } catch (e) {}
        if (!opts.silencioso) { try { toast('📴 ' + rotulo + ' protegido neste aparelho; envio automático quando a internet voltar', 'warn'); } catch (e) {} }
        return res;
      }
      if (res && res.durable === true) {
        try { if (typeof setSavedStatus === 'function') setSavedStatus('Protegido, envio pendente'); } catch (e) {}
        if (!opts.silencioso) { try { toast('⚠️ ' + rotulo + ' protegido, mas a nuvem ainda não confirmou. Veja o painel de sincronização.', 'warn'); } catch (e) {} }
        return res;
      }
      try { if (typeof setSavedStatus === 'function') setSavedStatus('Não confirmado'); } catch (e) {}
      if (!opts.silencioso) { try { toast('Não foi possível proteger nem confirmar ' + rotulo.toLowerCase() + '. Tente novamente.', 'error'); } catch (e) {} }
      return res;
    }).catch(() => {
      if (!avisoAtual()) return;
      try { if (typeof setSavedStatus === 'function') setSavedStatus('Não confirmado'); } catch (e) {}
      if (!opts.silencioso) { try { toast('A nuvem não confirmou ' + rotulo.toLowerCase() + '. Tente novamente.', 'error'); } catch (e) {} }
    });
    return confirmacao;
  },
  /* ===== AUDITORIA SIMULADA (módulo 8) =====
     Cada operação save/delete grava entry em medsys.v7.audit
     com timestamp, módulo, ação, _id e snapshot resumido. */
  _audit(acao, modKey, item) {
    try {
      if (store._semPersistenciaClinica(modKey)) {
        store._auditoriaMemoria.unshift({
          ts: new Date().toISOString(),
          usuario: localStorage.getItem('medsys.v7.usuario') || 'local',
          modulo: modKey, acao, _id: item ? item._id : null,
          resumo: store._resumoAuditoria(modKey, item)
        });
        if (store._auditoriaMemoria.length > 100) store._auditoriaMemoria.length = 100;
        return;
      }
      const key = 'medsys.v7.audit';
      const log = JSON.parse(localStorage.getItem(key) || '[]');
      const usuario = localStorage.getItem('medsys.v7.usuario') || 'local';
      log.unshift({
        ts: new Date().toISOString(),
        usuario,
        modulo: modKey,
        acao,
        _id: item ? item._id : null,
        resumo: store._resumoAuditoria(modKey, item)
      });
      if (log.length > 500) log.length = 500;
      localStorage.setItem(key, JSON.stringify(log));
    } catch (e) { /* silent — auditoria nunca quebra fluxo */ }
  },
  _resumoAuditoria(modKey, item) {
    if (!item) return '';
    if (modKey === 'anestesia') {
      const p = (item.paciente && item.paciente.nome) || '';
      const proc = (item.procedimento && item.procedimento.descricao) || '';
      return (p + ' · ' + proc).slice(0, 80);
    }
    return (item.nome || item.titulo || item.descricao || '').slice(0, 80);
  },
  /* ===== VERSIONAMENTO (módulo 8) =====
     Antes de sobrescrever, salva snapshot da versão anterior em
     medsys.v7.versions[modKey:_id] = [{ts, snapshot}, ...] */
  /* O histórico de versões serve para comparar CAMPOS, não binários.
     Assinaturas/fotos em base64 (dezenas/centenas de KB) multiplicadas por
     N versões estouram o localStorage do celular (~5 MB no iPhone). */
  _sanitizarSnapshot(obj) {
    const LIM = 2048;
    const walk = (o) => {
      if (Array.isArray(o)) { o.forEach(walk); return; }
      if (o && typeof o === 'object') {
        Object.keys(o).forEach(k => {
          const v = o[k];
          if (typeof v === 'string' && v.length > LIM && v.slice(0, 5) === 'data:') o[k] = '[binário removido do histórico de versões]';
          else if (v && typeof v === 'object') walk(v);
        });
      }
    };
    try { const clone = JSON.parse(JSON.stringify(obj)); walk(clone); return clone; }
    catch (e) { return obj; }
  },
  _saveVersion(modKey, prev) {
    if (!prev || !prev._id) return;
    try {
      if (store._semPersistenciaClinica(modKey)) {
        const k = modKey + ':' + prev._id;
        const lista = store._versoesMemoria.get(k) || [];
        lista.unshift({ ts: new Date().toISOString(), snapshot: store._sanitizarSnapshot(prev) });
        if (lista.length > 5) lista.length = 5;
        store._versoesMemoria.set(k, lista);
        return;
      }
      const key = 'medsys.v7.versions';
      const all = JSON.parse(disco.get(key) || '{}');
      const k = modKey + ':' + prev._id;
      all[k] = all[k] || [];
      all[k].unshift({
        ts: new Date().toISOString(),
        snapshot: store._sanitizarSnapshot(prev)
      });
      /* Mantém só as 5 versões mais recentes por documento */
      if (all[k].length > 5) all[k].length = 5;
      disco.set(key, JSON.stringify(all));
    } catch (e) { /* silent */ }
  },
  listVersions(modKey, id) {
    try {
      if (store._semPersistenciaClinica(modKey)) {
        return store._clone(store._versoesMemoria.get(modKey + ':' + id) || []);
      }
      const all = JSON.parse(disco.get('medsys.v7.versions') || '{}');
      return all[modKey + ':' + id] || [];
    } catch { return []; }
  },
  list(modKey) {
    try {
      store._garantirContexto();
      /* Cadastros também recebem escritas diretas de clinicaSync. Só os
         prontuários cloud-only usam a memória como fonte da lista. */
      if (store._semPersistenciaClinica(modKey) && store._memoria.has(modKey)) return store._clone(store._memoria.get(modKey));
      const arr = JSON.parse(localStorage.getItem(STORAGE[modKey]) || '[]');
      if (!Array.isArray(arr) || !arr.length) {
        store._lembrar(modKey, Array.isArray(arr) ? arr : []);
        return Array.isArray(arr) ? arr : [];
      }
      /* devolve as imagens guardadas uma vez só — o resto do app nem sabe */
      const b = store._blobs();
      if (Object.keys(b).length) arr.forEach(it => store._hidratar(it, b));
      store._lembrar(modKey, arr);
      return store._clone(arr);
    }
    catch { return []; }
  },
  /* ---- IMAGENS REPETIDAS GUARDADAS UMA VEZ SÓ -----------------------------
     O carimbo/assinatura do profissional é a MESMA imagem em toda ficha, e
     estava sendo copiado inteiro dentro de cada registro (~149 KB cada). Dez
     fichas assinadas = 1,5 MB do aparelho gastos com dez cópias do mesmo PNG.
     Agora a imagem é guardada uma vez, endereçada pelo conteúdo, e o registro
     leva só a referência. Como a chave é o próprio conteúdo, trocar o carimbo
     depois NÃO altera as fichas antigas — cada uma continua apontando para a
     imagem exata com que foi assinada.
     A troca é invisível: sai na gravação, volta na leitura. */
  BLOBS_KEY: 'medsys.v7.blobs',
  LIM_BLOB: 4096,                 /* abaixo disso não compensa referenciar */
  _blobs() {
    try {
      const antigos = JSON.parse(disco.get(store.BLOBS_KEY) || '{}');
      return store.cloudOnlyAtivo() ? Object.assign({}, antigos, store._blobsMemoria) : antigos;
    } catch (e) { return Object.assign({}, store._blobsMemoria); }
  },
  _refDe(s) {
    let h1 = 0, h2 = 0;
    for (let i = 0; i < s.length; i++) {
      h1 = ((h1 * 31) + s.charCodeAt(i)) | 0;
      h2 = ((h2 * 131) + s.charCodeAt(i)) | 0;
    }
    return 'blob:' + (h1 >>> 0).toString(36) + (h2 >>> 0).toString(36) + '.' + s.length;
  },
  _guardarBlob(dataurl) {
    if (store._semPersistenciaClinica()) {
      const refMemoria = store._refDe(dataurl);
      store._blobsMemoria[refMemoria] = dataurl;
      return refMemoria;
    }
    /* Janela do boot: o disco grande ainda está abrindo. Referenciar agora
       gravaria a imagem num lugar e a referência em outro — melhor deixar a
       imagem inteira dentro do registro e economizar na próxima gravação. */
    if (disco.suportado() && !disco._pronto) return null;
    const ref = store._refDe(dataurl);
    try {
      const b = store._blobs();
      if (!b[ref]) { b[ref] = dataurl; disco.set(store.BLOBS_KEY, JSON.stringify(b)); }
    } catch (e) { return null; }   /* sem espaço nem para o blob: mantém inteiro */
    return ref;
  },
  /* registro → guarda: troca imagens grandes por referência */
  _desidratar(obj) {
    if (!obj || typeof obj !== 'object') return obj;
    /* No modo cloud-only, imagens acompanham o registro apenas em memória ou
       dentro do WAL cifrado; nunca criam um segundo arquivo local em claro. */
    if (store._semPersistenciaClinica()) return store._clone(obj);
    const walk = (o) => {
      if (Array.isArray(o)) { o.forEach(walk); return; }
      if (o && typeof o === 'object') {
        Object.keys(o).forEach(k => {
          const v = o[k];
          if (typeof v === 'string' && v.length > store.LIM_BLOB && v.slice(0, 5) === 'data:') {
            const ref = store._guardarBlob(v);
            if (ref) o[k] = ref;
          } else if (v && typeof v === 'object') walk(v);
        });
      }
    };
    try { const clone = JSON.parse(JSON.stringify(obj)); walk(clone); return clone; }
    catch (e) { return obj; }
  },
  /* guarda → registro: devolve a imagem inteira, para o resto do app nem saber */
  _hidratar(obj, blobs) {
    if (!obj || typeof obj !== 'object') return obj;
    const b = blobs || store._blobs();
    const walk = (o) => {
      if (Array.isArray(o)) { o.forEach(walk); return; }
      if (o && typeof o === 'object') {
        Object.keys(o).forEach(k => {
          const v = o[k];
          if (typeof v === 'string' && v.slice(0, 5) === 'blob:') { if (b[v]) o[k] = b[v]; }
          else if (v && typeof v === 'object') walk(v);
        });
      }
    };
    try { walk(obj); } catch (e) {}
    return obj;
  },

  /* Escrita crua, sem socorro — usada pelas próprias rotinas de liberação de
     espaço, que não podem chamar o socorro de novo (recursão). */
  _escrever(modKey, arr) {
    try {
      store._lembrar(modKey, arr);
      return store._persistirSomente(modKey, arr);
    }
    catch (e) { return false; }
  },
  _ehCheio(e) {
    return !!(e && (e.name === 'QuotaExceededError' || e.code === 22 || e.code === 1014 || /quota/i.test(e.message || '')));
  },
  /* Devolve true quando gravou de verdade. Se o aparelho estiver cheio, libera
     espaço sozinho e refaz a gravação — em vez de engolir o erro e deixar a
     pessoa achando que salvou. */
  setList(modKey, arr) {
    store._lembrar(modKey, arr);
    const escrever = () => {
      store._ultimoErroPersistencia = null;
      const ok = store._persistirSomente(modKey, arr);
      if (!ok) escrever._erro = store._ultimoErroPersistencia;
      return ok;
    };
    if (escrever()) return true;
    const e = escrever._erro;
    if (!store._ehCheio(e)) {
      toast('Erro ao salvar: ' + (e && e.message || 'desconhecido'), 'error');
      return false;
    }
    try { return espaco.socorro(escrever); } catch (e2) { return false; }
  },
  /* Corta a lista local no teto, mas NUNCA derruba registro que ainda não
     está confirmado na nuvem (_relUpdatedAt vazio). Antes era um corte cego
     (`list.length = HISTORY_MAX`): o que estava só no aparelho e não coube
     virava perda de trabalho, não economia de espaço. O que já está na nuvem
     pode sair daqui à vontade — volta pela busca quando for preciso. */
  _podar(list) {
    if (!Array.isArray(list) || list.length <= HISTORY_MAX) return list;
    let excedente = list.length - HISTORY_MAX;
    for (let i = list.length - 1; i >= 0 && excedente > 0; i--) {
      const x = list[i];
      if (x && x._relUpdatedAt) { list.splice(i, 1); excedente--; }
    }
    return list;
  },
  /* Salva um item; se data._id existir, atualiza, senão adiciona */
  save(modKey, item) {
    const list = store.list(modKey);
    const isNew = !item._id;
    const prevExistente = isNew ? null : list.find(x => x._id === item._id);
    const finalizaveis = ['pre','consulta','anestesia','recuperacao','risco','termo','prescricao','documentos'];
    if (prevExistente && prevExistente._finalizado && finalizaveis.indexOf(modKey) >= 0) {
      /* Defesa central: mesmo um módulo que esqueça a checagem na própria tela
         não consegue substituir uma ficha finalizada no cache offline. */
      try {
        if (typeof adendos !== 'undefined') adendos.salvarComoCorrecao(modKey, prevExistente, item);
      } catch (e) { toast('Registro finalizado é imutável; use um adendo.', 'warn'); }
      return prevExistente;
    }
    if (isNew) {
      item._id = utils.uid();
      item._createdAt = new Date().toISOString();
      item._rev = 1;
    } else {
      /* Salva versão anterior antes de sobrescrever */
      const prev = prevExistente;
      if (prev) {
        store._saveVersion(modKey, prev);
        /* Preserva metadados internos que o formulário não carrega, mas que
           devem sobreviver ao save. O compare-and-swap depende da versão, do
           ambiente e do autor confirmados pelo banco — preservar só o horário
           faria uma ficha voltar a parecer "sem versão" a cada edição. */
        ['_relVersion','_relUpdatedAt','_relUpdatedBy','_relOrg'].forEach(k => {
          if (prev[k] != null && (item[k] == null || item[k] === '')) item[k] = prev[k];
        });
        /* Identidade e caso vazios podem ser uma limpeza intencional após a
           troca de paciente. Só herda quando o formulário legado nem sequer
           enviou o campo (undefined/null). */
        ['_patientKey','_patientRef','_caseId','_caseKey'].forEach(k => {
          if (prev[k] != null && item[k] == null) item[k] = prev[k];
        });
        if (prev._links && !item._links) item._links = prev._links;
        /* Revisão: número que incrementa a cada gravação (rastreabilidade). */
        item._rev = ((prev._rev || 1) + 1);
        if (prev._createdAt && !item._createdAt) item._createdAt = prev._createdAt;
        /* CARIMBO DE FINALIZAÇÃO — nunca se move.
           A produção conta pelo dia em que o trabalho foi FECHADO, não pelo dia
           em que o rascunho nasceu. E correção feita depois não pode mudar esse
           dia: o mês já contado não se reescreve porque alguém acrescentou uma
           linha na semana seguinte. */
        if (prev._finalizadoEm) item._finalizadoEm = prev._finalizadoEm;
      } else if (!item._rev) { item._rev = 1; }
    }
    /* Identidade local aditiva. Não altera legacy_id nem o contrato remoto:
       paciente/caso viajam dentro do próprio documento e permitem que os
       módulos novos se vinculem sem concluir que nomes iguais são a mesma
       pessoa. */
    try {
      /* Financeiro gerado a partir de um documento pertence ao caso da
         origem. Mesmo integrações antigas que informem apenas _origemId não
         recebem um novo caso independente. */
      if (modKey === 'financeiro' && item._origemId) {
        const permitidos = ['anestesia','pre','consulta','recuperacao'];
        const ordem = permitidos.indexOf(item._origemTipo) >= 0
          ? [item._origemTipo].concat(permitidos.filter(m => m !== item._origemTipo))
          : permitidos;
        let origem = null;
        for (const origemMod of ordem) {
          origem = store.getById(origemMod, item._origemId);
          if (origem) break;
        }
        if (origem) {
          if (!item._patientKey) item._patientKey = origem._patientKey || linker._chavePaciente(origem) || '';
          if (!item._patientRef) item._patientRef = origem._patientRef || '';
          if (!item._caseId) item._caseId = origem._caseId || '';
          if (!item._caseKey) item._caseKey = origem._caseKey || '';
        }
      }
      const identidade = window.SoftEncounterIdentity.fromRecord(item);
      const chaveCalculada = window.SoftEncounterIdentity.strongPatientKey(identidade) || '';
      if (modKey === 'pacientes') {
        item._patientKey = chaveCalculada;
        item._patientRef = item._id;
      } else {
        const modulosDeCaso = ['agenda','pre','consulta','anestesia','recuperacao','termo',
          'prescricao','documentos','risco','financeiro','orcamento'];
        if (modulosDeCaso.indexOf(modKey) >= 0) {
          if (chaveCalculada) item._patientKey = chaveCalculada;
          if (!item._caseId) item._caseId = 'caso_' + utils.uid();
          if (!item._caseKey) {
            item._caseKey = window.SoftEncounterIdentity.strongEncounterKey(
              Object.assign({}, identidade, { patientKey: item._patientKey || '' }), item
            ) || '';
          }
        }
      }
    } catch (e) {}
    /* Aqui, e não em cada módulo: são sete lugares que finalizam documento, e
       lista escrita à mão sempre atrasa em relação aos módulos (foi o que fez
       a pré-anestésica ficar de fora do "Meu dia"). */
    if (item._finalizado && !item._finalizadoEm) {
      /* Documento que JÁ ESTAVA finalizado antes deste carimbo existir não
         pode ganhar a data de hoje só por ser aberto e salvo de novo: ele
         pularia para o mês corrente e inflaria a produção do mês com trabalho
         de meses atrás. Para esses, o carimbo nasce onde o relatório já os
         contava — na data clínica. Só quem está sendo finalizado AGORA
         recebe o instante de agora. */
      const jaEraFinalizado = !!(prevExistente && prevExistente._finalizado);
      let base = '';
      if (jaEraFinalizado) {
        try { base = historico._dataItem(prevExistente) || ''; } catch (e) {}
        if (base && String(base).length === 10) base += 'T12:00:00.000Z';
        if (!base) base = prevExistente._createdAt || '';
      }
      item._finalizadoEm = base || new Date().toISOString();
    }
    item._updatedAt = new Date().toISOString();
    item._updatedBy = localStorage.getItem('medsys.v7.usuario') || 'local';
    store._marcarPendente(modKey, item._id);
    const idx = list.findIndex(x => x._id === item._id);
    if (idx >= 0) list[idx] = item;
    else list.unshift(item);
    store._podar(list);
    /* Estado do pré-lançamento tem que ser decidido ANTES de gravar */
    try {
      if (typeof preLanc !== 'undefined') {
        if (item._finalizado && preLanc.ehMedico()) preLanc.aoFinalizar(modKey, item);
        else preLanc.aoSalvar(modKey, item);
      }
    } catch (e) {}
    store.setList(modKey, list);
    store._audit(isNew ? 'create' : 'update', modKey, item);
    /* Sincronização em background pelo canal RELACIONAL da clínica. O antigo
       espelho pessoal, sem organization_id, foi encerrado: toda operação nova
       precisa ter um ambiente verificável ou permanecer na fila offline. */
    try {
      if (typeof cloudRel !== 'undefined' && cloudRel.mirror) {
        const envio = cloudRel.mirror(modKey, item);
        if (envio && typeof envio.then === 'function') {
          /* `esperarEnvio` acompanha também uma edição coalescida que começou
             enquanto a primeira ainda estava em voo. */
          const confirmacao = cloudRel.esperarEnvio(modKey, item._id);
          store._registrarConfirmacao(item, confirmacao);
          try {
            if (typeof edicaoViva !== 'undefined' && edicaoViva.confirmarSalvamento &&
                edicaoViva.MODS.indexOf(modKey) >= 0) {
              edicaoViva.confirmarSalvamento(modKey, item, confirmacao);
            }
          } catch (e) {}
        }
      }
    } catch (e) {}
    /* Clicou em Salvar: o RASCUNHO daquele módulo sobe na hora — é o que
       permite continuar em outro aparelho sem esperar nada. */
    try {
      if (typeof rascunhos !== 'undefined' && rascunhos.MODS.indexOf(modKey) >= 0) {
        rascunhos._agendarEnvio(modKey, { agora: true });
      }
    } catch (e) {}
    /* Escolheu "Substituir" na pergunta de duplicidade: agora que o novo está
       gravado, os anteriores do mesmo dia vão para a Lixeira. */
    try { if (typeof duplicados !== 'undefined') duplicados._consumir(modKey, item); } catch (e) {}
    /* Acabou de gravar: é o melhor momento para acertar as contas com a
       clínica — sem esperar o próximo minuto do ciclo. */
    try { if (typeof sincronia !== 'undefined') sincronia.agora(); } catch (e) {}
    return item;
  },
  delete(modKey, id) {
    const prev = store.getById(modKey, id);
    const contextoExclusao = (() => {
      try { return contextoAba.capturar(); } catch (e) { return null; }
    })();
    const mesmoContextoExclusao = () => {
      try { return contextoExclusao && contextoAba.corresponde(contextoExclusao); }
      catch (e) { return false; }
    };
    /* O mesmo limite do banco vale offline: excluir uma ficha finalizada seria
       alterar o prontuário canônico. Ela permanece e qualquer correção entra
       como adendo auditável. */
    if (prev && prev._finalizado && ['pre','consulta','anestesia','recuperacao','risco','termo','prescricao','documentos'].indexOf(modKey) >= 0) {
      toast('Registro finalizado é permanente. Use um adendo para corrigir.', 'warn');
      return false;
    }
    const list = store.list(modKey).filter(x => x._id !== id);
    store.setList(modKey, list);
    if (prev) {
      /* LIXEIRA: guarda o item por 30 dias antes da perda definitiva */
      try { lixeira.guardar(modKey, prev); } catch (e) {}
      store._saveVersion(modKey, prev);
      store._audit('delete', modKey, prev);
      try {
        if (typeof persistenciaCloudFirst !== 'undefined' && persistenciaCloudFirst.remover) {
          const exclusao = persistenciaCloudFirst.remover(modKey, prev);
          store._registrarConfirmacao(prev, exclusao);
          /* Se nem o IndexedDB cifrado conseguiu tornar a intenção durável,
             a exclusão local não pode ficar parecendo concluída. Restaura o
             registro (sem disparar novo save) e avisa; com WAL durável, a
             operação continua normalmente mesmo offline. */
          Promise.resolve(exclusao).then(res => {
            if (res && res.durable !== false) return;
            if (!mesmoContextoExclusao()) return;
            const atuais = store.list(modKey);
            if (!atuais.some(x => x && x._id === prev._id)) {
              atuais.unshift(prev);
              store.setList(modKey, atuais);
            }
            toast('A exclusão não foi confirmada pela nuvem nem protegida offline e foi desfeita.', 'error');
          }).catch(() => {
            if (!mesmoContextoExclusao()) return;
            const atuais = store.list(modKey);
            if (!atuais.some(x => x && x._id === prev._id)) {
              atuais.unshift(prev);
              store.setList(modKey, atuais);
            }
            toast('A exclusão não foi confirmada pela nuvem nem protegida offline e foi desfeita.', 'error');
          });
        } else if (typeof cloudRel !== 'undefined' && cloudRel.remover) {
          /* Compatibilidade somente durante a carga de uma versão antiga. */
          cloudRel.remover(modKey, prev);
        }
      } catch (e) { try { syncStatus.cloudState('error'); } catch (er) {} }
    }
    return true;
  },
  getById(modKey, id) {
    return store.list(modKey).find(x => x._id === id);
  },
  last(modKey) {
    return store.list(modKey)[0];
  }
};

try {
  contextoAba.aoMudar(() => store._garantirContexto());
  window.store = store;
} catch (e) {}

/* FIM DO ARMAZENAMENTO CLÍNICO EM MEMÓRIA E CACHE LOCAL */
