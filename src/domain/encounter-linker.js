'use strict';

/* ============================================================================
   LINKER — vínculos entre documentos
============================================================================ */
/* ============================================================================
   RASCUNHOS — Múltiplas fichas simultâneas por módulo
   Cada módulo (pre, consulta, anestesia, recuperacao) pode ter N rascunhos
   abertos. O usuário alterna entre eles via abas. O auto-save guarda o estado
   do rascunho ativo. Salvar como ficha real remove o rascunho.
============================================================================ */
/* ============================================================================
   RASCUNHOS NA NUVEM
   Ficha começada no celular e terminada no computador: o rascunho precisa
   viajar. Ele NÃO é um registro finalizado, mas continua sendo informação
   clínica: usa `drafts`, sempre com organization_id e user_id.
   A junção é por rascunho, pelo `updatedAt`: cada aparelho fica com a versão
   mais nova de cada um, e nenhum apaga o rascunho do outro.
============================================================================ */
const rascunhosSync = {
  /* Rascunho é dado clínico em edição. Ele viaja pela tabela `drafts`, cuja
     chave contém organização + usuário + módulo + documento e cuja RLS exige
     vínculo com a clínica. */
  _modulo(mod) { return String(mod || ''); },
  _indisponivel(res, erro) {
    try { return persistenciaCloudFirst.indisponivel(res, erro); }
    catch (e) { return typeof navigator !== 'undefined' && navigator.onLine === false; }
  },
  _erroLeitura(code, mensagem, status, cause) {
    const erro = new Error(mensagem || code);
    erro.name = 'CloudReadError'; erro.code = code;
    if (Number.isFinite(Number(status)) && Number(status) > 0) erro.status = Number(status);
    if (cause) erro.cause = cause;
    return erro;
  },
  async _linhasDaResposta(rq) {
    let linhas;
    try { linhas = await rq.json(); }
    catch (erro) { throw rascunhosSync._erroLeitura('resposta_invalida', 'resposta_invalida', rq.status, erro); }
    if (!Array.isArray(linhas) || linhas.length > 1 ||
        linhas.some(linha => !linha || typeof linha !== 'object' || Array.isArray(linha))) {
      throw rascunhosSync._erroLeitura('resposta_invalida', 'resposta_invalida', rq.status);
    }
    return linhas;
  },
  async gravarUnico(mod, r, contextoEsperado) {
    const contexto = contextoEsperado || cloudRel._capturarContexto();
    if (!contexto || !cloudRel._contextoValido(contexto, contexto.organizationId)) return { ok: false, motivo: 'contexto' };
    if (rascunhosSync._indisponivel()) return { ok: false, indisponivel: true, motivo: 'offline' };
    try {
      if (!(await cloud._garantirToken())) return { ok: false, motivo: 'token',
        indisponivel: rascunhosSync._indisponivel({ motivo: 'token' }) };
      if (!cloudRel._contextoValido(contexto, contexto.organizationId)) return { ok: false, motivo: 'contexto' };
      const c = cloud.config(), org = contexto.organizationId;
      const atualizado = Number(r._draftVersion) > 0;
      const select = '&select=id,organization_id,user_id,module,doc_id,data,version,updated_by,updated_at';
      const filtro = atualizado
        ? '?organization_id=eq.' + encodeURIComponent(org) + '&user_id=eq.' + encodeURIComponent(contexto.userId) +
          '&module=eq.' + encodeURIComponent(mod) + '&doc_id=eq.' + encodeURIComponent(r.id) + '&version=eq.' + Number(r._draftVersion)
        : '?on_conflict=organization_id,user_id,module,doc_id';
      const row = { organization_id: org, user_id: contexto.userId, module: mod, doc_id: r.id, data: rascunhosSync._limpo(r) };
      const rq = await fetch(c.url + '/rest/v1/drafts' + filtro + select, {
        method: atualizado ? 'PATCH' : 'POST',
        headers: Object.assign({}, cloud._headers(true), { 'Content-Type': 'application/json',
          'Prefer': atualizado ? 'return=representation' : 'resolution=ignore-duplicates,return=representation' }),
        body: JSON.stringify(atualizado ? { data: row.data } : [row])
      });
      if (!cloudRel._contextoValido(contexto, org)) return { ok: false, motivo: 'contexto' };
      if (!rq.ok) return { ok: false, motivo: 'http_' + rq.status,
        indisponivel: rascunhosSync._indisponivel({ status: rq.status }) };
      const rows = await rascunhosSync._linhasDaResposta(rq);
      if (!cloudRel._contextoValido(contexto, org)) return { ok: false, motivo: 'contexto' };
      const linha = rows[0];
      if (linha && linha.organization_id === org && linha.user_id === contexto.userId &&
          linha.doc_id === r.id && linha.module === mod && Number(linha.version) > 0 &&
          rascunhosSync._iguais(r, rascunhosSync._daLinha(linha, org))) return { ok: true, remoteConfirmed: true, linha };
      const atual = await rascunhosSync._lerAtual(mod, r.id, org, contexto.userId, contexto);
      if (!cloudRel._contextoValido(contexto, org)) return { ok: false, motivo: 'contexto' };
      if (atual && rascunhosSync._iguais(r, rascunhosSync._daLinha(atual, org))) return { ok: true, remoteConfirmed: true, linha: atual };
      return { ok: false, motivo: atual ? 'conflict' : 'recibo_invalido', linha: atual };
    } catch (erro) {
      return { ok: false, motivo: erro && (erro.code || erro.message) || 'rede',
        code: erro && erro.code || null, status: erro && erro.status || null,
        indisponivel: rascunhosSync._indisponivel(null, erro) };
    }
  },
  _limpo(r) {
    const x = cloudRel._clone(r || {});
    ['_draftVersion','_draftUpdatedAt','_draftUpdatedBy','_draftOrg','_draftSyncedLocalAt'].forEach(k => { delete x[k]; });
    return x;
  },
  _daLinha(l, org) {
    const r = cloudRel._clone((l && l.data) || {});
    if (!r.id && l && l.doc_id) r.id = l.doc_id;
    r._draftVersion = Number(l && l.version) || 1;
    r._draftUpdatedAt = (l && l.updated_at) || '';
    r._draftUpdatedBy = (l && l.updated_by) || '';
    r._draftOrg = org || (l && l.organization_id) || '';
    r._draftSyncedLocalAt = r.updatedAt || '';
    return r;
  },
  _iguais(a, b) {
    try { return JSON.stringify(rascunhosSync._limpo(a)) === JSON.stringify(rascunhosSync._limpo(b)); }
    catch (e) { return false; }
  },
  /* null significa somente ausência confirmada em GET válido e escopado.
     Falha de rede/autorização jamais equivale a rascunho ausente. */
  async _lerAtual(mod, id, org, userId, contextoEsperado) {
    const contexto = contextoEsperado || cloudRel._capturarContexto();
    if (!contexto || contexto.userId !== userId || !cloudRel._contextoValido(contexto, org)) {
      throw rascunhosSync._erroLeitura('contexto_trocado', 'contexto_trocado');
    }
    const c = cloud.config();
    let rq;
    try {
      rq = await fetch(c.url + '/rest/v1/drafts?organization_id=eq.' + encodeURIComponent(org) +
        '&user_id=eq.' + encodeURIComponent(userId) +
        '&module=eq.' + encodeURIComponent(rascunhosSync._modulo(mod)) +
        '&doc_id=eq.' + encodeURIComponent(id) +
        '&select=id,organization_id,user_id,module,doc_id,data,version,updated_by,updated_at',
        { headers: cloud._headers(true) });
    } catch (erro) { throw rascunhosSync._erroLeitura('network', 'network', null, erro); }
    if (!rq.ok) throw rascunhosSync._erroLeitura('http_error', 'HTTP ' + rq.status, rq.status);
    if (typeof rq.status === 'number' && rq.status !== 200) {
      throw rascunhosSync._erroLeitura('resposta_invalida', 'resposta_invalida', rq.status);
    }
    const rows = await rascunhosSync._linhasDaResposta(rq);
    if (!cloudRel._contextoValido(contexto, org)) {
      throw rascunhosSync._erroLeitura('contexto_trocado', 'contexto_trocado');
    }
    const row = rows[0] || null;
    if (row && (row.organization_id !== org || row.user_id !== userId ||
        row.module !== rascunhosSync._modulo(mod) || row.doc_id !== id ||
        !Number.isInteger(Number(row.version)) || Number(row.version) < 1 ||
        !row.data || typeof row.data !== 'object' || Array.isArray(row.data))) {
      throw rascunhosSync._erroLeitura('resposta_invalida', 'resposta_invalida', rq.status);
    }
    return row;
  },
  _aplicarLinhaLocal(mod, id, linha, org) {
    const lista = rascunhos.list(mod); const i = lista.findIndex(x => x && x.id === id);
    if (i < 0 || !linha) return;
    const meta = rascunhosSync._daLinha(linha, org);
    ['_draftVersion','_draftUpdatedAt','_draftUpdatedBy','_draftOrg','_draftSyncedLocalAt'].forEach(k => { lista[i][k] = meta[k]; });
    rascunhos.setList(mod, lista);
  },
  _preservarConflito(mod, local, remoto, opts = {}) {
    const lista = opts.lista || rascunhos.list(mod);
    const atual = lista.find(x => x && x.id === local.id);
    if (!atual) return null;
    const marca = [local.id, local._draftVersion || '', remoto._draftVersion || '', cloudRel._hashConflito(local)].join('|');
    let copia = lista.find(x => x && x._draftConflictFingerprint === marca);
    if (!copia) {
      copia = rascunhosSync._limpo(local);
      copia.id = 'rasc_conflito_' + Date.now() + '_' + Math.floor(Math.random() * 10000);
      copia.label = ((local.label || 'Rascunho') + ' — edição preservada').slice(0, 60);
      copia.updatedAt = new Date().toISOString();
      copia._draftConflictFingerprint = marca;
      copia._draftConflictOf = local.id;
      lista.push(copia);
    }
    const i = lista.indexOf(atual);
    if (i >= 0) lista[i] = remoto;
    rascunhos.setList(mod, lista);
    const conflito = cloudRel.registrarConflito(mod, local, remoto, {
      tabela: 'drafts', legacyId: local.id, operation: opts.operation || 'draft_upsert',
      baseVersion: local._draftVersion || opts.baseVersion,
      serverVersion: remoto._draftVersion || opts.serverVersion,
      organizationId: remoto._draftOrg || local._draftOrg || opts.organizationId,
      motivo: opts.motivo || 'rascunho_editado_em_dois_aparelhos'
    });
    try { rascunhos.renderAbas(mod); } catch (e) {}
    return conflito;
  },
  async enviar(mod, contextoEsperado) {
    try {
      const contexto = contextoEsperado || cloudRel._capturarContexto();
      if (!contexto) return 0;
      try { await rascunhos.aguardarPersistencia(mod); }
      catch (erro) { if (rascunhosSync._indisponivel()) return 0; }
      if (!cloudRel._contextoValido(contexto, contexto.organizationId)) return 0;
      if (!(await cloud._garantirToken())) {
        if (rascunhosSync._indisponivel({ motivo: 'token' })) await rascunhos._persistirCifrado(mod, { indisponivel: true });
        return 0;
      }
      const c = cloud.config(); const s = cloud.session();
      const org = contexto.organizationId;
      if (!s || !s.user || s.user.id !== contexto.userId ||
          !cloudRel._contextoValido(contexto, org)) return 0;
      /* Retenta o que foi fechado aqui e ainda não saiu da nuvem — é isso que
         impedia o rascunho fechado de voltar na próxima sincronização. */
      try { await rascunhosSync._apagarPendentes(mod, contexto); } catch (e) {}
      if (!cloudRel._contextoValido(contexto, org)) return 0;
      /* Rascunho em branco não sobe: era assim que cada aparelho mandava o seu
         "Rascunho 1" vazio e todos acabavam com três abas iguais. */
      const lista = (rascunhos.list(mod) || [])
        .filter(r => r && r.id && r.dados && rascunhos.temConteudo(mod, r) && !rascunhos.fechadoAqui(mod, r.id));
      if (!lista.length) return 0;
      let enviados = 0;
      for (const r of lista) {
        if (!cloudRel._contextoValido(contexto, org)) return enviados;
        if (r._draftOrg && r._draftOrg !== org) continue;
        if (!rascunhos._pendente(r)) continue;
        const resultado = await rascunhosSync.gravarUnico(rascunhosSync._modulo(mod), r, contexto);
        if (!cloudRel._contextoValido(contexto, org)) return enviados;
        if (resultado.remoteConfirmed) {
          const atual = rascunhos.list(mod).find(x => x && x.id === r.id);
          /* O recibo desta revisão não confirma digitação posterior. */
          if (atual && rascunhosSync._iguais(atual, r)) {
            rascunhosSync._aplicarLinhaLocal(mod, r.id, resultado.linha, org);
            await rascunhos._confirmarSnapshot(mod, r.id); enviados++;
          }
          continue;
        }
        if (resultado.indisponivel) {
          await rascunhos._persistirCifrado(mod, { indisponivel: true });
          break;
        }
        if (resultado.linha) rascunhosSync._preservarConflito(mod, r,
          rascunhosSync._daLinha(resultado.linha, org), { organizationId: org });
      }
      return enviados;
    } catch (e) { return 0; }
  },
  async puxar(mod, contextoEsperado) {
    try {
      const contexto = contextoEsperado || cloudRel._capturarContexto();
      if (!contexto) return 0;
      if (!(await cloud._garantirToken())) return 0;
      const c = cloud.config(); const s = cloud.session();
      const org = contexto.organizationId;
      if (!s || !s.user || s.user.id !== contexto.userId ||
          !cloudRel._contextoValido(contexto, org)) return 0;
      const rq = await fetch(c.url + '/rest/v1/drafts?organization_id=eq.' + org +
        '&user_id=eq.' + contexto.userId +
        '&module=eq.' + encodeURIComponent(rascunhosSync._modulo(mod)) +
        '&select=id,organization_id,user_id,module,doc_id,data,version,updated_by,updated_at',
        { headers: cloud._headers(true) });
      if (!rq.ok) return 0;
      const linhas = await rq.json().catch(() => []);
      if (!cloudRel._contextoValido(contexto, org)) return 0;
      if (!Array.isArray(linhas) || !linhas.length) return 0;
      const locais = rascunhos.list(mod) || [];
      const porId = new Map(locais.map(r => [r.id, r]));
      let novos = 0, atualizados = 0, conflitos = 0;
      /* guarda o que chegou, para a tela poder ABRIR o rascunho trazido —
         antes ele entrava na lista em silêncio e o usuário não via */
      rascunhosSync._chegaram = [];
      const fechados = new Set(rascunhos.lapides(mod).map(x => x.id));
      linhas.filter(l => l && l.organization_id === org && l.user_id === contexto.userId).forEach(l => {
        const r = rascunhosSync._daLinha(l, org);
        if (!r || !r.id || !r.dados) return;
        if (fechados.has(r.id)) return;          /* fechado aqui: não volta */
        if (!rascunhos.temConteudo(mod, r)) return;   /* aba vazia de outro aparelho não vira aba aqui */
        const local = porId.get(r.id);
        if (!local) {
          locais.push(r); porId.set(r.id, r); novos++;
          rascunhosSync._chegaram.push({ id: r.id, label: r.label || '', updatedAt: r.updatedAt || '' });
          return;
        }
        const vr = Number(r._draftVersion) || 0, vl = Number(local._draftVersion) || 0;
        const sujo = vl > 0
          ? String(local.updatedAt || '') !== String(local._draftSyncedLocalAt || '')
          : !rascunhosSync._iguais(local, r);
        if (vr > vl && sujo) {
          rascunhosSync._preservarConflito(mod, local, r, { organizationId: org, lista: locais }); conflitos++;
          rascunhosSync._chegaram.push({ id: r.id, label: r.label || '', updatedAt: r.updatedAt || '' });
        } else if (vr > vl || (!vl && String(r.updatedAt || '') > String(local.updatedAt || ''))) {
          Object.keys(local).forEach(k => { delete local[k]; }); Object.assign(local, r); atualizados++;
          rascunhosSync._chegaram.push({ id: r.id, label: r.label || '', updatedAt: r.updatedAt || '' });
        } else if (vr === vl) {
          ['_draftVersion','_draftUpdatedAt','_draftUpdatedBy','_draftOrg'].forEach(k => { local[k] = r[k]; });
        }
      });
      if (!cloudRel._contextoValido(contexto, org)) return 0;
      rascunhosSync._chegaram.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
      if (novos || atualizados || conflitos) {
        rascunhos.setList(mod, locais);
        try { rascunhos.renderAbas(mod); } catch (e) {}
      }
      return novos + atualizados + conflitos;
    } catch (e) { return 0; }
  },
  /* Rascunho fechado some da nuvem também — senão o pull seguinte o traria
     de volta e o usuário teria que fechar duas vezes. */
  async apagar(mod, id, baseVersion, opts = {}) {
    const contextoDaOperacao = opts.contexto || cloudRel._capturarContexto();
    try {
      if (!id) return false;
      const contexto = contextoDaOperacao;
      if (!contexto) return false;
      await rascunhos.aguardarPersistencia(mod);
      if (!cloudRel._contextoValido(contexto, contexto.organizationId)) return false;
      if (!(await cloud._garantirToken())) return false;
      const c = cloud.config(); const s = cloud.session();
      const org = contexto.organizationId;
      if (opts.organizationId && opts.organizationId !== org) return false;
      if (!s || !s.user || s.user.id !== contexto.userId ||
          !cloudRel._contextoValido(contexto, org)) return false;
      const lapide = (rascunhos.lapides(mod) || []).find(x => x.id === id);
      const versao = Number(baseVersion || (lapide && lapide.version)) || 0;
      const atual = await rascunhosSync._lerAtual(mod, id, org, contexto.userId, contexto);
      if (!cloudRel._contextoValido(contexto, org)) return false;
      if (!atual) return true;
      if (!versao || Number(atual.version) !== versao) {
        if (opts.naoRegistrar) return false;
        const remoto = rascunhosSync._daLinha(atual, org);
        cloudRel.registrarConflito(mod,
          { id, _deleteRequested: true, _draftVersion: versao || null, _draftOrg: org }, remoto,
          { tabela: 'drafts', legacyId: id, operation: 'draft_delete', organizationId: org,
            baseVersion: versao || null, serverVersion: Number(atual.version), motivo: 'exclusao_de_rascunho_divergente' });
        return true; // transportado para a fila de decisão; não retenta em laço
      }
      const rq = await fetch(c.url + '/rest/v1/drafts?organization_id=eq.' + org +
        '&user_id=eq.' + contexto.userId +
        '&module=eq.' + encodeURIComponent(rascunhosSync._modulo(mod)) +
        '&doc_id=eq.' + encodeURIComponent(id) + '&version=eq.' + versao + '&select=id,version',
        { method: 'DELETE', headers: Object.assign({}, cloud._headers(true), { 'Prefer': 'return=representation' }) });
      if (!rq.ok) throw rascunhosSync._erroLeitura('http_error', 'HTTP ' + rq.status, rq.status);
      const rows = await rq.json().catch(() => []);
      if (!cloudRel._contextoValido(contexto, org)) return false;
      if (rows.length) return true;
      const mudou = await rascunhosSync._lerAtual(mod, id, org, contexto.userId, contexto);
      if (!cloudRel._contextoValido(contexto, org)) return false;
      if (!mudou) return true;
      if (opts.naoRegistrar) return false;
      const remoto = rascunhosSync._daLinha(mudou, org);
      cloudRel.registrarConflito(mod,
        { id, _deleteRequested: true, _draftVersion: versao, _draftOrg: org }, remoto,
        { tabela: 'drafts', legacyId: id, operation: 'draft_delete', organizationId: org,
          baseVersion: versao, serverVersion: Number(mudou.version), motivo: 'exclusao_de_rascunho_divergente' });
      return true;
    } catch (erro) {
      if (rascunhos.MODS.indexOf(mod) >= 0 && contextoDaOperacao &&
          cloudRel._contextoValido(contextoDaOperacao, contextoDaOperacao.organizationId) &&
          rascunhosSync._indisponivel(null, erro)) {
        await rascunhos._persistirCifrado(mod, { indisponivel: true });
      }
      return false;
    }
  },
  /* Rascunho fechado aqui e ainda vivo na nuvem: tenta apagar de novo. Sem
     isso, uma falha de rede no momento do fechamento fazia a aba voltar. */
  async _apagarPendentes(mod, contextoEsperado) {
    const contexto = contextoEsperado || cloudRel._capturarContexto();
    if (!contexto) return 0;
    const pendentes = rascunhos.pendentesDeApagar(mod);
    if (!pendentes.length) return 0;
    let n = 0;
    for (const id of pendentes.slice(0, 20)) {
      if (!cloudRel._contextoValido(contexto, contexto.organizationId)) return n;
      const ok = await rascunhosSync.apagar(mod, id, null, { contexto });
      if (!cloudRel._contextoValido(contexto, contexto.organizationId)) return n;
      if (ok) { rascunhos.marcarApagado(mod, id); n++; }
    }
    return n;
  },

  /* Sobe os rascunhos de todos os módulos (ao sair da tela/entrar em outra) */
  async enviarTodos() {
    const contexto = cloudRel._capturarContexto();
    if (!contexto) return 0;
    let n = 0;
    for (const mod of rascunhos.MODS) {
      if (!cloudRel._contextoValido(contexto, contexto.organizationId)) break;
      n += await rascunhosSync.enviar(mod, contexto);
    }
    return n;
  },
  async puxarTodos(opts = {}) {
    const contexto = cloudRel._capturarContexto();
    if (!contexto) return 0;
    let n = 0;
    for (const mod of rascunhos.MODS) {
      if (!cloudRel._contextoValido(contexto, contexto.organizationId)) break;
      n += await rascunhosSync.puxar(mod, contexto);
    }
    if (n && !opts.silent) toast('📝 ' + n + ' rascunho(s) trazido(s) de outro aparelho');
    return n;
  }
};

const rascunhos = {
  KEY_LIST: 'medsys.v7.rascunhos.',
  KEY_ATIVO: 'medsys.v7.rascunho_ativo.',
  MODS: ['pre', 'consulta', 'anestesia', 'recuperacao'],
  FORMS: { pre: 'form-pre', consulta: 'form-consulta', anestesia: 'form-anestesia', recuperacao: 'form-recuperacao' },
  _memList: new Map(),
  _memAtivo: new Map(),
  _memLapides: new Map(),
  _persistencias: new Map(),
  _erroPersistencia: new Map(),
  _ownerKey: '',
  _duraveis: new Map(),
  _clone(v) { try { return JSON.parse(JSON.stringify(v)); } catch (e) { return v; } },
  _contextoKey() {
    try {
      const c = contextoAba.atual();
      return [c.generation, c.userId, c.organizationId, c.tabId].join(':');
    } catch (e) { return 'sem-contexto'; }
  },
  _garantirContexto() {
    const atual = rascunhos._contextoKey();
    if (rascunhos._ownerKey === atual) return;
    rascunhos._ownerKey = atual;
    rascunhos._memList.clear();
    rascunhos._memAtivo.clear();
    rascunhos._memLapides.clear();
    rascunhos._persistencias.clear();
    rascunhos._erroPersistencia.clear();
    rascunhos._duraveis.clear();
  },
  _cloudOnly() {
    try { return typeof store !== 'undefined' && store.cloudOnlyAtivo(); }
    catch (e) { return false; }
  },
  _usuario(contexto) {
    try { return String((contexto || contextoAba.atual()).userId || ''); }
    catch (e) { return ''; }
  },
  _key(prefixo, mod, contexto) {
    const uid = rascunhos._usuario(contexto);
    return prefixo + mod + (uid ? '.u.' + uid.replace(/[^a-zA-Z0-9_-]/g, '_') : '');
  },
  _pendente(r) {
    return !!(r && r.id && String(r.updatedAt || '') !== String(r._draftSyncedLocalAt || ''));
  },
  _snapshot(mod) {
    const lista = rascunhos._clone(rascunhos._memList.get(mod) || [])
      .filter(r => rascunhos._pendente(r) && rascunhos.temConteudo(mod, r));
    return { lista, ativo: lista.some(r => r.id === rascunhos._memAtivo.get(mod)) ? rascunhos._memAtivo.get(mod) : null,
      lapides: rascunhos._clone(rascunhos._memLapides.get(mod) || []).filter(x => x && x.naNuvem !== false) };
  },
  async _confirmarSnapshot(mod, id) {
    const anterior = rascunhos._duraveis.get(mod);
    if (!anterior) return { ok: true, durable: false, remoteConfirmed: true };
    const restante = rascunhos._clone(anterior);
    restante.lista = (restante.lista || []).filter(r => r.id !== id);
    restante.lapides = (restante.lapides || []).filter(r => r.id !== id);
    if (restante.ativo === id) restante.ativo = null;
    return rascunhos._persistirCifrado(mod, { limpeza: restante });
  },
  _limparLegadoDoMesmoDono(mod) {
    [rascunhos.KEY_LIST, rascunhos.KEY_ATIVO, rascunhos.LAPIDES_KEY].forEach(prefixo => {
      try { localStorage.removeItem(rascunhos._key(prefixo, mod)); } catch (e) {}
    });
  },
  _persistirCifrado(mod, opts = {}) {
    if (!rascunhos._cloudOnly()) return Promise.resolve({ ok: true, durable: true, legacy: true });
    const offline = opts.indisponivel === true || rascunhosSync._indisponivel();
    if (!offline && !opts.limpeza) return Promise.resolve({ ok: true, durable: false, volatile: true });
    const snapshot = opts.limpeza || rascunhos._snapshot(mod);
    const vazio = !snapshot.lista.length && !snapshot.lapides.length;
    let escrita;
    try {
      if (typeof filaCifrada === 'undefined' || !filaCifrada.salvarSnapshot) {
        throw new Error('cofre cifrado indisponível');
      }
      /* A chamada captura o dono antes de devolver a Promise. */
      escrita = vazio ? filaCifrada.removerSnapshot('drafts', mod)
        : filaCifrada.salvarSnapshot('drafts', mod, snapshot);
      rascunhos._duraveis.set(mod, rascunhos._clone(snapshot));
    } catch (e) { escrita = Promise.reject(e); }
    const acompanhada = Promise.resolve(escrita).then(res => {
      if (!res || res.durable !== true) throw new Error('snapshot de rascunho não durável');
      if (rascunhos._persistencias.get(mod) === acompanhada) {
        rascunhos._erroPersistencia.delete(mod);
        rascunhos._limparLegadoDoMesmoDono(mod);
      }
      return res;
    }).catch(e => {
      if (rascunhos._persistencias.get(mod) === acompanhada) rascunhos._erroPersistencia.set(mod, e);
      return { ok: false, durable: false, erro: e };
    });
    rascunhos._persistencias.set(mod, acompanhada);
    return acompanhada;
  },
  async aguardarPersistencia(mod) {
    let vista = null;
    while (rascunhos._persistencias.get(mod) && rascunhos._persistencias.get(mod) !== vista) {
      vista = rascunhos._persistencias.get(mod);
      const res = await vista;
      if (!res || (res.durable !== true && res.volatile !== true)) {
        throw rascunhos._erroPersistencia.get(mod) || new Error('Rascunho não protegido no cofre cifrado.');
      }
    }
    if (rascunhos._erroPersistencia.has(mod)) throw rascunhos._erroPersistencia.get(mod);
    return true;
  },
  async restaurarCifrado() {
    if (!rascunhos._cloudOnly() || typeof filaCifrada === 'undefined' || !filaCifrada.listarSnapshots) return 0;
    const contexto = contextoAba.capturar();
    rascunhos._garantirContexto();
    const snapshots = await filaCifrada.listarSnapshots('drafts');
    if (!contextoAba.corresponde(contexto)) return 0;
    const encontrados = new Set();
    let restaurados = 0;
    for (const snap of snapshots || []) {
      const mod = snap && snap.key;
      if (rascunhos.MODS.indexOf(mod) < 0) continue;
      encontrados.add(mod);
      const bruto = snap.payload && typeof snap.payload === 'object' ? snap.payload : {};
      const dados = { lista: (bruto.lista || []).filter(r => rascunhos._pendente(r) && rascunhos.temConteudo(mod, r)),
        ativo: bruto.ativo || null, lapides: (bruto.lapides || []).filter(x => x && x.naNuvem !== false) };
      if (!dados.lista.some(r => r.id === dados.ativo)) dados.ativo = null;
      if (!rascunhos._memList.has(mod)) rascunhos._memList.set(mod, rascunhos._clone(dados.lista));
      if (!rascunhos._memAtivo.has(mod)) rascunhos._memAtivo.set(mod, dados.ativo);
      if (!rascunhos._memLapides.has(mod)) rascunhos._memLapides.set(mod, rascunhos._clone(dados.lapides));
      rascunhos._duraveis.set(mod, rascunhos._clone(dados));
      if (JSON.stringify(bruto) !== JSON.stringify(dados)) await rascunhos._persistirCifrado(mod, { limpeza: dados });
      if (!contextoAba.corresponde(contexto)) return 0;
      rascunhos._limparLegadoDoMesmoDono(mod);
      if (dados.lista.length || dados.lapides.length) restaurados++;
    }

    /* Migra somente chaves que já carregam o UID exato. A chave histórica
       sem usuário permanece em quarentena: não existe base segura para
       atribuí-la a quem acabou de entrar. */
    for (const mod of rascunhos.MODS) {
      if (encontrados.has(mod) || !contextoAba.corresponde(contexto)) continue;
      const listKey = rascunhos._key(rascunhos.KEY_LIST, mod, contexto);
      const activeKey = rascunhos._key(rascunhos.KEY_ATIVO, mod, contexto);
      const tombKey = rascunhos._key(rascunhos.LAPIDES_KEY, mod, contexto);
      const temLegado = [listKey, activeKey, tombKey].some(k => {
        try { return localStorage.getItem(k) != null; } catch (e) { return false; }
      });
      if (!temLegado) continue;
      try {
        const lista = JSON.parse(localStorage.getItem(listKey) || '[]');
        const lapides = JSON.parse(localStorage.getItem(tombKey) || '[]');
        rascunhos._memList.set(mod, Array.isArray(lista) ? rascunhos._clone(lista) : []);
        rascunhos._memAtivo.set(mod, localStorage.getItem(activeKey) || null);
        rascunhos._memLapides.set(mod, Array.isArray(lapides) ? rascunhos._clone(lapides) : []);
        /* Resgate de resíduo legado: cifras somente pendências, nunca confirmado. */
        const res = await rascunhos._persistirCifrado(mod, { limpeza: rascunhos._snapshot(mod) });
        if (res && res.durable === true) restaurados++;
      } catch (e) { rascunhos._erroPersistencia.set(mod, e); }
    }
    return restaurados;
  },

  list(mod) {
    rascunhos._garantirContexto();
    if (rascunhos._memList.has(mod)) return rascunhos._clone(rascunhos._memList.get(mod));
    if (rascunhos._cloudOnly()) {
      rascunhos._memList.set(mod, []);
      return [];
    }
    try {
      /* Mesmo dentro da mesma clínica, cada pessoa tem os próprios drafts no
         servidor. A chave local precisa repetir essa fronteira: uma gaveta
         apenas por organização deixava a secretária abrir o rascunho do
         médico ao usar o mesmo computador. O formato antigo sem usuário fica
         em quarentena; não há evidência suficiente para atribuí-lo. */
      const key = rascunhos._key(rascunhos.KEY_LIST, mod);
      const arr = JSON.parse(localStorage.getItem(key) || '[]');
      const lista = Array.isArray(arr) ? arr : [];
      rascunhos._memList.set(mod, rascunhos._clone(lista));
      return rascunhos._clone(lista);
    } catch (e) { return []; }
  },
  setList(mod, arr) {
    rascunhos._garantirContexto();
    const lista = Array.isArray(arr) ? arr : [];
    rascunhos._memList.set(mod, rascunhos._clone(lista));
    if (rascunhos._cloudOnly()) {
      rascunhos._persistirCifrado(mod);
      return;
    }
    try {
      const key = rascunhos._key(rascunhos.KEY_LIST, mod);
      if (lista.length) localStorage.setItem(key, JSON.stringify(lista));
      else localStorage.removeItem(key);
    }
    catch (e) { toast('Erro ao salvar rascunho: ' + e.message, 'error'); }
  },
  ativo(mod) {
    rascunhos._garantirContexto();
    if (rascunhos._memAtivo.has(mod)) return rascunhos._memAtivo.get(mod);
    if (rascunhos._cloudOnly()) {
      rascunhos._memAtivo.set(mod, null);
      return null;
    }
    const key = rascunhos._key(rascunhos.KEY_ATIVO, mod);
    const id = localStorage.getItem(key);
    rascunhos._memAtivo.set(mod, id || null);
    return id;
  },
  setAtivo(mod, id) {
    rascunhos._garantirContexto();
    rascunhos._memAtivo.set(mod, id || null);
    if (rascunhos._cloudOnly()) {
      rascunhos._persistirCifrado(mod);
      return;
    }
    const key = rascunhos._key(rascunhos.KEY_ATIVO, mod);
    if (id) localStorage.setItem(key, id);
    else localStorage.removeItem(key);
  },

  /* ---- LÁPIDES: rascunho fechado não pode voltar ----
     Fechar apagava na nuvem sem conferir o resultado. Se a exclusão falhasse
     (sem rede, sessão expirada, servidor fora), o pull seguinte trazia o
     rascunho de volta — e a aba reaparecia como se o fechar não funcionasse.
     Agora o fechamento fica registrado aqui: o pull ignora o que foi fechado
     e a exclusão é tentada de novo a cada sincronização, até dar certo. */
  LAPIDES_KEY: 'medsys.v7.rascunhos_fechados.',
  DIAS_LAPIDE: 60,
  lapides(mod) {
    rascunhos._garantirContexto();
    try {
      const arr = rascunhos._memLapides.has(mod)
        ? rascunhos._clone(rascunhos._memLapides.get(mod))
        : rascunhos._cloudOnly() ? []
          : JSON.parse(localStorage.getItem(rascunhos._key(rascunhos.LAPIDES_KEY, mod)) || '[]');
      if (!Array.isArray(arr)) return [];
      const limite = Date.now() - rascunhos.DIAS_LAPIDE * 24 * 3600 * 1000;
      const validas = arr.filter(x => x && x.id && (x.naNuvem !== false || !x.em || new Date(x.em).getTime() > limite));
      rascunhos._memLapides.set(mod, rascunhos._clone(validas));
      if (rascunhos._cloudOnly() && validas.length !== arr.length) rascunhos._persistirCifrado(mod);
      return validas;
    } catch (e) { return []; }
  },
  _gravarLapides(mod, arr) {
    const lista = (arr || []).slice();
    rascunhos._memLapides.set(mod, rascunhos._clone(lista));
    if (rascunhos._cloudOnly()) {
      rascunhos._persistirCifrado(mod);
      return;
    }
    /* A lápide não contém prontuário, só o id/version necessários para uma
       exclusão que ainda não recebeu confirmação. Confirmada, sai também. */
    const pendentes = lista.filter(x => x && x.naNuvem !== false);
    try {
      const key = rascunhos._key(rascunhos.LAPIDES_KEY, mod);
      if (pendentes.length) localStorage.setItem(key, JSON.stringify(pendentes));
      else localStorage.removeItem(key);
    } catch (e) {}
  },
  fechadoAqui(mod, id) {
    return rascunhos.lapides(mod).some(x => x.id === id);
  },
  marcarFechado(mod, id, rascunho) {
    if (!id) return;
    const arr = rascunhos.lapides(mod).filter(x => x.id !== id);
    arr.push({ id, em: new Date().toISOString(), naNuvem: true,
      version: Number(rascunho && rascunho._draftVersion) || null,
      organizationId: (rascunho && rascunho._draftOrg) || null });
    rascunhos._gravarLapides(mod, arr);
  },
  /* A exclusão na nuvem deu certo: a lápide continua (para o caso de outro
     aparelho ainda ter o rascunho), mas para de ser tentada. */
  marcarApagado(mod, id) {
    const arr = rascunhos.lapides(mod).map(x => x.id === id ? Object.assign({}, x, { naNuvem: false }) : x);
    rascunhos._gravarLapides(mod, arr);
    rascunhos._confirmarSnapshot(mod, id).catch(() => {});
  },
  pendentesDeApagar(mod) {
    return rascunhos.lapides(mod).filter(x => x.naNuvem !== false).map(x => x.id);
  },

  /* Rascunho vazio não é trabalho: não sobe para a nuvem, não vira aba em
     outro aparelho e não fica ocupando lugar. Um formulário recém-aberto já
     traz um ou dois campos preenchidos sozinho (a data de hoje), então o
     corte é conservador — na dúvida, o rascunho fica. */
  _contarPreenchidos(dados) {
    let n = 0;
    const ignorar = /^_|data|hora|versao|meta|^id$/i;
    const anda = (x, chave) => {
      if (x == null || n > 40) return;
      if (Array.isArray(x)) { x.forEach(v => anda(v, chave)); return; }
      if (typeof x === 'object') { Object.keys(x).forEach(k => anda(x[k], k)); return; }
      if (typeof x === 'boolean') { if (x) n++; return; }
      const s = String(x).trim();
      if (!s || ignorar.test(chave || '')) return;
      n++;
    };
    anda(dados, '');
    return n;
  },
  temConteudo(mod, r) {
    if (!r) return false;
    if (!r.dados) return false;
    if (rascunhos._extrairNomePaciente(mod, r.dados)) return true;
    return rascunhos._contarPreenchidos(r.dados) > 2;
  },
  /* Cria novo rascunho vazio e o torna ativo */
  novo(mod) {
    /* Salva o ativo antes de criar novo (se houver) */
    if (rascunhos.ativo(mod)) {
      rascunhos.salvarAtual(mod);
    }
    const id = 'rasc_' + Date.now() + '_' + Math.floor(Math.random() * 10000);
    const list = rascunhos.list(mod);
    /* maior número já usado + 1 — contar a lista dava "Rascunho 1" toda vez
       que ela estivesse vazia, e as abas ficavam todas com o mesmo nome */
    const n = list.reduce((mx, r) => {
      const m = String(r.label || '').match(/^Rascunho (\d+)$/);
      return m ? Math.max(mx, parseInt(m[1], 10)) : mx;
    }, 0) + 1;
    list.push({
      id,
      label: 'Rascunho ' + n,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      dados: null
    });
    rascunhos.setList(mod, list);
    rascunhos.setAtivo(mod, id);
    rascunhos._limpar(mod);
    rascunhos.renderAbas(mod);
    toast('Novo rascunho criado');
    return id;
  },

  /* O formulário atual corresponde a um registro FINALIZADO? (reaberto só
     para ver/imprimir — não pode virar rascunho nem auto-save: era assim que
     dados de um paciente vazavam para o "Rascunho 1" do próximo) */
  _formEhFinalizado(mod) {
    try {
      const f = document.getElementById(rascunhos.FORMS[mod]);
      const el = f && f.querySelector('[name="_id"]');
      const idReg = el ? el.value : '';
      if (!idReg) return false;
      const reg = store.getById(mod, idReg);
      return !!(reg && reg._finalizado);
    } catch (e) { return false; }
  },

  /* Coleta dados atuais do form e salva no rascunho ativo */
  salvarAtual(mod) {
    const id = rascunhos.ativo(mod);
    if (!id) return;
    if (rascunhos._formEhFinalizado(mod)) return;   /* finalizado NÃO vira rascunho */
    const list = rascunhos.list(mod);
    const r = list.find(x => x.id === id);
    if (!r) return;
    const dados = rascunhos._coletar(mod);
    if (JSON.stringify(r.dados || {}) === JSON.stringify(dados || {})) return;
    r.dados = dados;
    r.updatedAt = new Date().toISOString();
    /* Auto-renomeia com base no nome do paciente */
    const pacNome = rascunhos._extrairNomePaciente(mod, r.dados);
    if (pacNome) r.label = pacNome.slice(0, 32);
    rascunhos.setList(mod, list);
    /* sobe para a nuvem sem pressa (o rascunho precisa alcançar o outro
       aparelho — começar no celular e terminar no computador) */
    rascunhos._agendarEnvio(mod);
  },
  /* Junta as gravações seguidas num envio só, alguns segundos depois.
     opts.agora = clicou em Salvar: sobe na hora, sem esperar. */
  _agendarEnvio(mod, opts = {}) {
    try {
      rascunhos._timers = rascunhos._timers || {};
      clearTimeout(rascunhos._timers[mod]);
      if (opts.agora) { rascunhosSync.enviar(mod); return; }
      rascunhos._timers[mod] = setTimeout(() => {
        try { rascunhosSync.enviar(mod); } catch (e) {}
      }, 750);
    } catch (e) {}
  },

  _extrairNomePaciente(mod, dados) {
    if (!dados) return '';
    if (mod === 'anestesia') {
      return (dados.paciente && dados.paciente.nome) || dados.paciente_nome || '';
    }
    return dados.paciente_nome || dados.nome_paciente || dados.nome || '';
  },

  /* Renomeia a aba do rascunho ativo com o nome do paciente, na hora
     (chamado ao sair do campo Nome — sem esperar o auto-save). */
  renomearAba(mod) {
    try {
      const id = rascunhos.ativo(mod);
      if (!id) return;
      const list = rascunhos.list(mod);
      const r = list.find(x => x.id === id);
      if (!r) return;
      const nome = rascunhos._extrairNomePaciente(mod, rascunhos._coletar(mod));
      if (nome && nome.trim()) {
        r.label = nome.trim().slice(0, 32);
        rascunhos.setList(mod, list);
        rascunhos.renderAbas(mod);
      }
    } catch (e) {}
  },

  /* Ativa um rascunho — salva o atual, carrega o novo */
  ativar(mod, id) {
    const atual = rascunhos.ativo(mod);
    if (atual === id) return;
    if (atual) rascunhos.salvarAtual(mod);
    rascunhos.setAtivo(mod, id);
    const r = rascunhos.list(mod).find(x => x.id === id);
    if (r && r.dados) {
      rascunhos._restaurar(mod, r.dados);
    } else {
      rascunhos._limpar(mod);
    }
    rascunhos.renderAbas(mod);
    state.dirty = false;
  },

  /* A confirmação de exclusão pertence à gaveta que iniciou a operação. Uma
     resposta tardia nunca marca como apagado um rascunho da conta seguinte. */
  _apagarNaNuvem(mod, id) {
    const contexto = cloudRel._capturarContexto();
    if (!contexto) return;
    try {
      Promise.resolve(rascunhos.aguardarPersistencia(mod))
        .then(() => rascunhosSync.apagar(mod, id, null, { contexto }))
        .then(ok => {
          if (ok && cloudRel._contextoValido(contexto, contexto.organizationId)) {
            rascunhos.marcarApagado(mod, id);
          }
        }).catch(() => {});
    } catch (e) {}
  },

  /* Fecha um rascunho */
  fechar(mod, id) {
    /* Acha o rascunho para mostrar o nome na confirmação */
    const r = rascunhos.list(mod).find(x => x.id === id);
    const nome = r ? (r.label || 'Sem nome') : 'rascunho';

    const realizarFechamento = () => {
      const eraAtivo = rascunhos.ativo(mod) === id;
      /* Remove da lista */
      const list = rascunhos.list(mod).filter(x => x.id !== id);
      rascunhos.setList(mod, list);
      /* Fechado fica fechado: a lápide impede que o próximo pull o traga de
         volta, mesmo que a exclusão na nuvem falhe agora (ela é tentada de
         novo a cada sincronização). */
      rascunhos.marcarFechado(mod, id, r);
      rascunhos._apagarNaNuvem(mod, id);
      if (eraAtivo) {
        /* IMPORTANTE: limpa o ativo ANTES de chamar ativar() — senão o early-return
           em ativar() (if atual===id) impede de carregar dados do próximo */
        rascunhos.setAtivo(mod, null);
        if (list.length > 0) {
          rascunhos.ativar(mod, list[0].id);
        } else {
          /* Sem rascunhos restantes — limpa o form e cria um novo em branco */
          rascunhos._limpar(mod);
          rascunhos.novo(mod);
          return;  // novo() já chama renderAbas
        }
      }
      rascunhos.renderAbas(mod);
      toast('Rascunho "' + nome + '" fechado' +
        (rascunhos.list(mod).length === 1 && !rascunhos.temConteudo(mod, rascunhos.list(mod)[0])
          ? ' — a aba em branco que ficou é a ficha nova' : ''));
    };

    /* Modal customizado (não depende do confirm nativo, que pode ser bloqueado em alguns ambientes) */
    if (typeof modal !== 'undefined' && modal.open) {
      const html = `
        <div style="padding:6px 0">
          <p style="font-size:.95rem;margin-bottom:10px">Tem certeza que deseja fechar este rascunho?</p>
          <p style="font-size:.86rem;color:var(--text-soft);background:var(--surface-alt);padding:10px;border-radius:5px;margin-bottom:14px">
            <strong>📑 ${utils.escapeHTML(nome)}</strong><br>
            Os dados deste rascunho serão <strong>perdidos</strong>, a menos que você já tenha salvo a ficha definitivamente.
          </p>
          <div style="text-align:right;display:flex;gap:8px;justify-content:flex-end">
            <button class="btn" id="rasc-cancel-fechar">Cancelar</button>
            <button class="btn btn-danger" id="rasc-confirm-fechar">🗑 Sim, fechar</button>
          </div>
        </div>
      `;
      modal.open('Fechar rascunho?', html, '');
      setTimeout(() => {
        const btnCancel = document.getElementById('rasc-cancel-fechar');
        const btnConf = document.getElementById('rasc-confirm-fechar');
        if (btnCancel) btnCancel.addEventListener('click', () => modal.close());
        if (btnConf) btnConf.addEventListener('click', () => {
          modal.close();
          realizarFechamento();
        });
      }, 50);
    } else {
      /* Fallback caso modal não esteja disponível */
      if (confirm('Fechar rascunho "' + nome + '"?\n\nOs dados serão perdidos se não tiver salvado.')) {
        realizarFechamento();
      }
    }
  },

  /* Remove rascunho ativo (chamado quando a ficha é salva definitivamente) */
  removerAtivo(mod) {
    const id = rascunhos.ativo(mod);
    if (!id) return;
    const antes = rascunhos.list(mod);
    const removido = antes.find(x => x.id === id);
    const list = antes.filter(x => x.id !== id);
    rascunhos.setList(mod, list);
    rascunhos.marcarFechado(mod, id, removido);
    rascunhos._apagarNaNuvem(mod, id);
    /* IMPORTANTE: limpa o ativo antes de chamar ativar() */
    rascunhos.setAtivo(mod, null);
    if (list.length > 0) {
      rascunhos.ativar(mod, list[0].id);
    } else {
      rascunhos._limpar(mod);
    }
    rascunhos.renderAbas(mod);
  },

  /* Buscar rascunhos de outro aparelho, sob demanda (botão da barra).
     Além de trazer, ABRE o rascunho na tela: trazer em silêncio dava a
     impressão de que nada tinha acontecido. */
  async buscarNaNuvem(mod) {
    const contexto = cloudRel._capturarContexto();
    if (!contexto) { toast('Conecte-se à nuvem primeiro (Ajustes)', 'warn'); return; }
    try { rascunhos.salvarAtual(mod); } catch (e) {}
    await rascunhosSync.enviar(mod, contexto);       /* leva o daqui antes */
    if (!cloudRel._contextoValido(contexto, contexto.organizationId)) return;
    const n = await rascunhosSync.puxar(mod, contexto); /* e traz o de lá */
    if (!cloudRel._contextoValido(contexto, contexto.organizationId)) return;
    if (!n) { toast('Nenhum rascunho novo em outro aparelho'); return; }
    rascunhos.renderAbas(mod);
    const chegou = (rascunhosSync._chegaram || [])[0];
    if (chegou) {
      rascunhos.ativar(mod, chegou.id);
      const nome = chegou.label || 'rascunho';
      toast('📝 "' + nome + '" aberto — veio do outro aparelho' + (n > 1 ? ' (e mais ' + (n - 1) + ')' : ''));
      try {
        const wrap = document.getElementById('rasc-tabs-' + mod);
        if (wrap && wrap.scrollIntoView) wrap.scrollIntoView({ behavior: 'smooth', block: 'center' });
      } catch (e) {}
    } else {
      toast('📝 ' + n + ' rascunho(s) trazido(s) de outro aparelho');
    }
  },

  /* Abas em branco repetidas: sobra de sincronização (cada aparelho mandava
     o seu "Rascunho 1" vazio). Uma aba em branco é a ficha nova — várias são
     lixo. Fica a mais recente; as outras saem, com lápide, para não voltarem. */
  limparVazios(mod) {
    const list = rascunhos.list(mod);
    const ativo = rascunhos.ativo(mod);
    const vazios = list.filter(r => !rascunhos.temConteudo(mod, r));
    if (vazios.length < 2) return 0;
    /* preserva o que está aberto na tela; senão, o mais recente */
    const manter = vazios.find(r => r.id === ativo) ||
      vazios.slice().sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))[0];
    const remover = vazios.filter(r => r.id !== manter.id);
    if (!remover.length) return 0;
    rascunhos.setList(mod, list.filter(r => !remover.some(x => x.id === r.id)));
    remover.forEach(r => {
      rascunhos.marcarFechado(mod, r.id, r);
      rascunhos._apagarNaNuvem(mod, r.id);
    });
    return remover.length;
  },

  /* Garante que ao entrar no módulo, existe ao menos um rascunho ativo */
  garantirAtivo(mod) {
    try { rascunhos.limparVazios(mod); } catch (e) {}
    const list = rascunhos.list(mod);
    if (list.length === 0) {
      rascunhos.novo(mod);
    } else if (!rascunhos.ativo(mod)) {
      /* Limpa antes de ativar para forçar carregamento dos dados */
      rascunhos.setAtivo(mod, null);
      rascunhos.ativar(mod, list[0].id);
    } else {
      /* Já tem rascunho ativo — só re-renderiza as abas */
      rascunhos.renderAbas(mod);
    }
  },

  /* Renderiza as abas na UI */
  /* ==========================================================================
     DUAS ABAS, UMA FICHA

     Um rascunho guarda `dados`, e `dados._id` é a ficha salva a que ele
     pertence. Nada impedia dois rascunhos apontarem para a MESMA ficha — e
     acontece justamente quando o fluxo funciona: a secretária começa a pré no
     aparelho dela, o rascunho dela chega aqui pela sincronização, e este
     aparelho já tinha criado o seu ao abrir a mesma ficha. Resultado: duas
     abas com o nome do mesmo paciente, e a impressão de que uma "não fechou".

     Rascunho SEM `_id` nunca é juntado: duas fichas novas em branco são
     legitimamente duas. Só se funde o que aponta para o mesmo registro
     gravado — e fica o mais recente, com lápide no outro para o próximo pull
     não trazê-lo de volta.
  ========================================================================== */
  dedupPorFicha(mod) {
    if (rascunhos._dedupindo) return 0;
    let lista;
    try { lista = rascunhos.list(mod) || []; } catch (e) { return 0; }
    const porFicha = new Map();
    const sobra = [];
    lista.forEach(r => {
      const fid = r && r.dados && r.dados._id;
      if (!fid) { sobra.push(r); return; }          /* ainda não é ficha: fica */
      const anterior = porFicha.get(fid);
      if (!anterior) { porFicha.set(fid, r); return; }
      /* fica o mais recente; o outro é descartado */
      const maisNovo = String(r.updatedAt || '') > String(anterior.updatedAt || '') ? r : anterior;
      const velho = maisNovo === r ? anterior : r;
      porFicha.set(fid, maisNovo);
      sobra.push({ _remover: velho });
    });
    const remover = sobra.filter(x => x._remover).map(x => x._remover);
    if (!remover.length) return 0;
    rascunhos._dedupindo = true;
    try {
      const idsFora = new Set(remover.map(r => r.id));
      const nova = lista.filter(r => !idsFora.has(r.id));
      const ativoEra = rascunhos.ativo(mod);
      rascunhos.setList(mod, nova);
      remover.forEach(r => {
        try { rascunhos.marcarFechado(mod, r.id, r); } catch (e) {}
        rascunhos._apagarNaNuvem(mod, r.id);
      });
      /* a aba aberta era uma das descartadas: passa para a que ficou, em vez
         de deixar o formulário órfão */
      if (idsFora.has(ativoEra)) {
        const fid = (remover.find(r => r.id === ativoEra) || {}).dados;
        const sobrevivente = fid && fid._id ? porFicha.get(fid._id) : null;
        rascunhos.setAtivo(mod, null);
        if (sobrevivente) rascunhos.ativar(mod, sobrevivente.id);
        else if (nova.length) rascunhos.ativar(mod, nova[0].id);
      }
    } finally { rascunhos._dedupindo = false; }
    return remover.length;
  },

  renderAbas(mod) {
    /* Antes de desenhar: se sobraram duas abas da mesma ficha, uma sai. */
    try { rascunhos.dedupPorFicha(mod); } catch (e) {}
    const wrap = document.getElementById('rasc-tabs-' + mod);
    if (!wrap) return;
    const list = rascunhos.list(mod);
    const ativo = rascunhos.ativo(mod);
    const labels = { pre: 'Pré-anestésica', consulta: 'Consultas', anestesia: 'Anestesia', recuperacao: 'Recuperação' };
    let html = `<span class="rasc-label">📑 ${labels[mod] || mod}:</span>`;
    list.forEach((r, idx) => {
      const label = utils.escapeHTML(r.label || ('Rascunho ' + (idx + 1)));
      const cls = r.id === ativo ? 'rasc-tab active' : 'rasc-tab';
      const idAttr = utils.escapeAttr(r.id);
      html += `<span class="${cls}" data-action="ativar" data-id="${idAttr}" title="Abrir: ${label}">`;
      html += `<span class="rasc-tab-name">${label}</span>`;
      html += `<button type="button" class="rasc-tab-close" data-action="fechar" data-id="${idAttr}" title="Fechar rascunho" aria-label="Fechar">×</button>`;
      html += `</span>`;
    });
    html += `<button type="button" class="rasc-tab-new" data-action="novo" title="Criar novo rascunho em paralelo">+ Novo rascunho</button>`;
    html += `<button type="button" class="rasc-tab-new" data-action="nuvem" title="Traz os rascunhos começados em outro aparelho (celular ↔ computador)">☁️ Buscar de outro aparelho</button>`;
    if (list.length > 1) {
      html += `<span class="rasc-tab-count">${list.length} fichas em paralelo</span>`;
    }
    wrap.innerHTML = html;
    /* Liga handler único via delegation — mais confiável que onclick inline */
    if (!wrap.dataset.handlerLigado) {
      wrap.addEventListener('click', (ev) => {
        /* Botão fechar tem prioridade — verifica primeiro */
        const btnFechar = ev.target.closest('[data-action="fechar"]');
        if (btnFechar) {
          ev.preventDefault(); ev.stopPropagation();
          const id = btnFechar.dataset.id;
          rascunhos.fechar(mod, id);
          return;
        }
        const btnNovo = ev.target.closest('[data-action="novo"]');
        if (btnNovo) {
          ev.preventDefault(); ev.stopPropagation();
          rascunhos.novo(mod);
          return;
        }
        const btnNuvem = ev.target.closest('[data-action="nuvem"]');
        if (btnNuvem) {
          ev.preventDefault(); ev.stopPropagation();
          rascunhos.buscarNaNuvem(mod);
          return;
        }
        const tabAtivar = ev.target.closest('[data-action="ativar"]');
        if (tabAtivar) {
          ev.preventDefault();
          const id = tabAtivar.dataset.id;
          rascunhos.ativar(mod, id);
          return;
        }
      });
      wrap.dataset.handlerLigado = '1';
    }
  },

  /* === HELPERS de coleta/restauração genéricos === */
  _coletar(mod) {
    if (mod === 'anestesia') {
      try { return anestesia.coletarEstruturado(); }
      catch (e) { console.error(e); return {}; }
    }
    const f = document.getElementById(rascunhos.FORMS[mod]);
    if (!f) return {};
    const data = {};
    f.querySelectorAll('input, select, textarea').forEach(el => {
      if (!el.name || el.type === 'file') return;
      if (el.type === 'checkbox') {
        /* Checkboxes com [] viram array */
        if (el.name.endsWith('[]')) {
          if (!data[el.name]) data[el.name] = [];
          if (el.checked) data[el.name].push(el.value);
        } else {
          data[el.name] = el.checked;
        }
      } else if (el.type === 'radio') {
        if (el.checked) data[el.name] = el.value;
      } else {
        data[el.name] = el.value;
      }
    });
    return data;
  },

  _restaurar(mod, dados) {
    if (mod === 'anestesia') {
      try {
        if (anestesia.limparSilencioso) anestesia.limparSilencioso();
        anestesia.restaurarEstruturado(dados);
      } catch (e) { console.error('Erro ao restaurar rascunho de anestesia:', e); }
      return;
    }
    const formId = rascunhos.FORMS[mod];
    const f = document.getElementById(formId);
    if (!f) return;
    utils.clearForm(formId);
    Object.keys(dados).forEach(k => {
      const val = dados[k];
      if (k.endsWith('[]') && Array.isArray(val)) {
        f.querySelectorAll(`[name="${k}"]`).forEach(el => {
          el.checked = val.includes(el.value);
        });
      } else {
        const els = f.querySelectorAll(`[name="${k}"]`);
        els.forEach(el => {
          if (el.type === 'checkbox') el.checked = !!val;
          else if (el.type === 'radio') el.checked = (el.value === val);
          else el.value = val == null ? '' : val;
        });
      }
    });
  },

  _limpar(mod) {
    if (mod === 'anestesia') {
      try { if (anestesia.limparSilencioso) anestesia.limparSilencioso(); } catch (e) {}
      return;
    }
    const formId = rascunhos.FORMS[mod];
    if (formId) utils.clearForm(formId);
  }
};

try { contextoAba.aoMudar(() => rascunhos._garantirContexto()); } catch (e) {}

/* ============================================================================
   LINKER — vínculos entre documentos
============================================================================ */
const linker = {
  /* Cria/atualiza vínculo bidirecional entre dois registros */
  link(srcMod, srcId, dstMod, dstId) {
    if (!srcId || !dstId) return;
    const srcList = store.list(srcMod);
    const src = srcList.find(x => x._id === srcId);
    if (src) {
      src._links = src._links || {};
      src._links[dstMod + '_id'] = dstId;
      store.setList(srcMod, srcList);
    }
    const dstList = store.list(dstMod);
    const dst = dstList.find(x => x._id === dstId);
    if (dst) {
      dst._links = dst._links || {};
      dst._links[srcMod + '_id'] = srcId;
      store.setList(dstMod, dstList);
    }
  },
  /* Retorna documentos vinculados a um item */
  getLinks(item) {
    const links = item && item._links;
    if (!links) return [];
    const out = [];
    Object.entries(links).forEach(([k, v]) => {
      const mod = k.replace(/_id$/, '');
      if (!STORAGE[mod]) return;
      const dst = store.getById(mod, v);
      if (dst) out.push({ mod, item: dst });
    });
    return out;
  },

  /* === BUSCA POR NOME (normaliza acentos/caixa) === */
  _normNome(s) {
    return window.SoftEncounterIdentity.normalizeName(s);
  },

  _FORM_IDS: {
    anestesia: 'form-anestesia', pre: 'form-pre', consulta: 'form-consulta',
    recuperacao: 'form-recuperacao', termo: 'form-termo',
    prescricao: 'form-prescricao', documentos: 'form-documentos',
    risco: 'form-risco', financeiro: 'form-financeiro', agenda: 'form-agenda',
    orcamento: 'form-orcamento'
  },

  _form(mod) {
    const id = linker._FORM_IDS[mod];
    return id ? document.getElementById(id) : null;
  },

  _chavePaciente(item) {
    if (!item) return null;
    if (item._patientKey) return String(item._patientKey);
    return window.SoftEncounterIdentity.strongPatientKey(
      window.SoftEncounterIdentity.fromRecord(item)
    );
  },

  contextoPaciente(mod) {
    const form = linker._form(mod);
    if (!form) return { identityKey: '', patientRef: '' };
    const key = form.querySelector('[name="_patientKey"]');
    const ref = form.querySelector('[name="_patientRef"]');
    return {
      identityKey: key ? String(key.value || '') : '',
      patientRef: ref ? String(ref.value || '') : ''
    };
  },

  contextoCaso(mod) {
    const form = linker._form(mod);
    if (!form) return { caseId: '', caseKey: '' };
    const id = form.querySelector('[name="_caseId"]');
    const key = form.querySelector('[name="_caseKey"]');
    return {
      caseId: id ? String(id.value || '') : '',
      caseKey: key ? String(key.value || '') : ''
    };
  },

  aplicarContextoCaso(mod, source, opts = {}) {
    const form = linker._form(mod);
    if (!form || !source) return null;
    const caseId = opts.caseId || source._caseId || '';
    const identidade = Object.assign({}, window.SoftEncounterIdentity.fromRecord(source), {
      patientKey: source._patientKey || opts.identityKey || ''
    });
    const caseKey = opts.caseKey || source._caseKey ||
      window.SoftEncounterIdentity.strongEncounterKey(
        identidade, source
      ) || '';
    if (!caseId && !caseKey) return null;
    const ensure = (name, value) => {
      let input = form.querySelector('[name="' + name + '"]');
      if (!input) {
        input = document.createElement('input');
        input.type = 'hidden'; input.name = name; form.appendChild(input);
      }
      input.value = value || '';
    };
    ensure('_caseId', caseId);
    ensure('_caseKey', caseKey);
    return { caseId, caseKey };
  },

  aplicarContextoPaciente(mod, source, opts = {}) {
    const form = linker._form(mod);
    if (!form || !source) return null;
    const identityKey = opts.identityKey || source._patientKey || linker._chavePaciente(source);
    const patientRef = opts.patientRef || source._patientRef || '';
    if (!identityKey && !patientRef) return null;
    const ensure = (name, value) => {
      let input = form.querySelector('[name="' + name + '"]');
      if (!input) {
        input = document.createElement('input');
        input.type = 'hidden'; input.name = name;
        form.appendChild(input);
      }
      input.value = value || '';
    };
    ensure('_patientKey', identityKey || '');
    ensure('_patientRef', patientRef);
    const nome = window.SoftEncounterIdentity.fromRecord(source).nome;
    const nomeInput = form.querySelector('[name="paciente_nome"], [name="nome"], [name="paciente"]');
    if (nomeInput && nome) {
      nomeInput.dataset.patientSelectedName = nome;
      nomeInput.dataset.patientKey = identityKey || '';
    }
    return identityKey || ('ref:' + patientRef);
  },

  limparContextoCaso(mod) {
    const form = linker._form(mod);
    if (!form) return;
    ['_caseId', '_caseKey'].forEach(name => {
      const input = form.querySelector('[name="' + name + '"]');
      if (input) input.value = '';
    });
  },

  limparContextoPaciente(mod) {
    const form = linker._form(mod);
    if (!form) return;
    /* Trocar a pessoa também encerra o vínculo com o atendimento anterior.
       O próximo save criará um caso novo, salvo quando um fluxo explícito
       reaplicar o caso de origem logo depois. */
    linker.limparContextoCaso(mod);
    ['_patientKey', '_patientRef'].forEach(name => {
      const input = form.querySelector('[name="' + name + '"]');
      if (input) input.value = '';
    });
    const nomeInput = form.querySelector('[name="paciente_nome"], [name="nome"], [name="paciente"]');
    if (nomeInput) {
      delete nomeInput.dataset.patientSelectedName;
      delete nomeInput.dataset.patientKey;
    }
  },

  /* Calcula idade ("NN anos") a partir de uma data de nascimento (ISO YYYY-MM-DD) */
  _idadeDeNascimento(nasc) {
    if (!nasc) return '';
    const d = new Date(nasc);
    if (isNaN(d)) return '';
    const hoje = new Date();
    let anos = hoje.getFullYear() - d.getFullYear();
    const m = hoje.getMonth() - d.getMonth();
    if (m < 0 || (m === 0 && hoje.getDate() < d.getDate())) anos--;
    return (anos >= 0 && anos < 130) ? anos + ' anos' : '';
  },

  /* Busca o registro MAIS RECENTE sem atravessar identidades homônimas. */
  ultimoPorNome(mod, nome, opts = {}) {
    const alvo = linker._normNome(nome);
    if (!alvo || alvo.length < 3) return null;
    const lista = store.list(mod);
    let candidatos = lista.filter(it => {
      const pacNome = (it.paciente && it.paciente.nome) || it.paciente_nome || it.nome || it.paciente || '';
      return linker._normNome(pacNome) === alvo;
    });
    if (candidatos.length === 0) return null;
    if (opts.caseId) candidatos = candidatos.filter(it => it && it._caseId === opts.caseId);
    if (candidatos.length === 0) return null;
    const escolhida = opts.identityKey || '';
    const refEscolhida = opts.patientRef || '';
    const fortes = new Set(candidatos.map(linker._chavePaciente).filter(Boolean));
    const refs = new Set(candidatos.map(it => it && it._patientRef).filter(Boolean));
    if (escolhida) candidatos = candidatos.filter(it => linker._chavePaciente(it) === escolhida);
    else if (refEscolhida) candidatos = candidatos.filter(it => it && it._patientRef === refEscolhida);
    else if (fortes.size > 1) return null;
    else if (fortes.size === 1) {
      const unica = Array.from(fortes)[0];
      candidatos = candidatos.filter(it => linker._chavePaciente(it) === unica);
    } else if (refs.size > 1) return null;
    else if (refs.size === 1) {
      const unica = Array.from(refs)[0];
      candidatos = candidatos.filter(it => it && it._patientRef === unica);
    } else if (candidatos.length > 1) return null;
    if (!candidatos.length) return null;
    candidatos.sort((a, b) => new Date(b._updatedAt || 0) - new Date(a._updatedAt || 0));
    return candidatos[0];
  },

  /* === AUTO-PREENCHIMENTO DE DADOS DO PACIENTE ===
     Quando o usuário começa qualquer registro, para CADA campo do paciente
     busca o valor MAIS RECENTE daquele paciente entre TODOS os registros de
     TODOS os módulos + cadastro central. Cada campo é preenchido a partir da
     fonte mais recente que tenha aquele dado (não de um único registro).
     Não sobrescreve campos que já tenham valor. */
  autoPreencherDadosPaciente(nome, modAtual, opts = {}) {
    if (!nome || !modAtual) return;
    const alvo = linker._normNome(nome);
    if (alvo.length < 3) return;

    /* Mapa por-campo com o valor mais recente do paciente (todos os módulos) */
    if (opts.patient) linker.aplicarContextoPaciente(modAtual, opts.patient, opts);
    const contexto = linker.contextoPaciente(modAtual);
    const identityKey = opts.identityKey || contexto.identityKey || '';
    const patientRef = opts.patientRef || contexto.patientRef || '';
    const info = linker._dadosMaisRecentes(nome, modAtual, { identityKey, patientRef });
    if (info.ambiguous) {
      toast('⚠️ Há pacientes homônimos. Selecione o paciente correto na lista antes de preencher os dados.', 'warn');
      return false;
    }
    const dados = info.dados;
    if (Object.keys(dados).length === 0) return;

    /* Aplica no form do módulo atual (mapeando campo certo) */
    const form = linker._form(modAtual);
    if (!form) return;

    const mapa = linker._mapaCamposPaciente(modAtual);
    let preenchidos = 0;
    Object.entries(mapa).forEach(([chaveDados, nomeCampo]) => {
      const valor = dados[chaveDados];
      if (valor == null || valor === '') return;
      const candidatos = Array.isArray(nomeCampo) ? nomeCampo : [nomeCampo];
      let el = null;
      for (const n of candidatos) { el = form.querySelector('[name="' + n + '"]'); if (el) break; }
      if (!el) return;
      if (el.value && el.value.trim() !== '') return;   /* não sobrescreve */
      if (linker._setCampo(el, valor)) preenchidos++;
    });

    if (preenchidos > 0) {
      toast(`👤 ${preenchidos} dado(s) do paciente preenchido(s) — valor mais recente`);
      /* Recalcula derivados na Anestesia (IMC, idade) */
      if (modAtual === 'anestesia') {
        try { anestesia.calc.imc(); } catch (e) {}
        try { anestesia.calc.idade(); } catch (e) {}
      }
      if (modAtual === 'pre') {
        try { pre.calcIdade(); } catch (e) {}   /* nascimento chegou: idade sai dele */
        try { pre._calcIMC(); } catch (e) {}
        try { pre.labs.marcar(); } catch (e) {} /* sexo importado muda as faixas */
      }
    }
    return preenchidos > 0;
  },

  /* Todos os módulos que podem conter dados de paciente */
  _MODS_PACIENTE: ['anestesia', 'pre', 'consulta', 'recuperacao', 'termo', 'prescricao', 'risco', 'financeiro', 'orcamento'],

  /* Campos de paciente rastreados no per-campo-mais-recente */
  _CAMPOS_PACIENTE: ['nome', 'nascimento', 'idade', 'sexo', 'peso', 'altura', 'imc',
    'cpf', 'rg', 'prontuario', 'convenio', 'plano', 'matricula', 'carteirinha',
    'telefone', 'email', 'endereco', 'acomodacao'],

  /* === PER-CAMPO MAIS RECENTE ===
     Reúne TODOS os registros do paciente (todos os módulos + cadastro),
     ordena por data de atualização decrescente e, para CADA campo, usa o
     valor da fonte mais recente que o tenha preenchido.
     Retorna { dados: {campo: valor}, fontes: {campo: rótulo} }. */
  _dadosMaisRecentes(nome, modAtual, opts = {}) {
    const alvo = linker._normNome(nome);
    const dados = {}, fontes = {};
    if (alvo.length < 3) return { dados, fontes };

    /* 1. Reúne fontes: cada registro vira { ts, label, dados } */
    const fontesList = [];

    /* Cadastro central de pacientes */
    store.list('pacientes').forEach(p => {
      if (linker._normNome(p.nome) !== alvo) return;
      fontesList.push({
        ts: new Date(p._updatedAt || p._createdAt || 0).getTime(),
        label: 'cadastro de pacientes',
        identityKey: linker._chavePaciente(p),
        patientRef: p._id || p._patientRef || '',
        dados: linker._normalizarCadastro(p)
      });
    });

    /* Registros de cada módulo */
    linker._MODS_PACIENTE.forEach(m => {
      store.list(m).forEach(it => {
        const pacNome = (it.paciente && it.paciente.nome) || it.paciente_nome || it.nome || it.paciente || '';
        if (linker._normNome(pacNome) !== alvo) return;
        fontesList.push({
          ts: new Date(it._updatedAt || it._createdAt || 0).getTime(),
          label: linker._LABEL_MOD[m] || m,
          identityKey: linker._chavePaciente(it),
          patientRef: it._patientRef || '',
          dados: linker._extrairDadosPaciente(m, it)
        });
      });
    });

    if (fontesList.length === 0) return { dados, fontes, ambiguous: false };

    const strongKeys = Array.from(new Set(fontesList.map(x => x.identityKey).filter(Boolean)));
    const patientRefs = Array.from(new Set(fontesList.map(x => x.patientRef).filter(Boolean)));
    const selectedKey = String(opts.identityKey || '');
    const selectedRef = String(opts.patientRef || '');
    let fontesSeguras = fontesList;
    if (selectedKey) fontesSeguras = fontesList.filter(x => x.identityKey === selectedKey);
    else if (selectedRef) fontesSeguras = fontesList.filter(x => x.patientRef === selectedRef);
    else if (strongKeys.length > 1) {
      return { dados, fontes, ambiguous: true, identityKeys: strongKeys };
    } else if (strongKeys.length === 1) {
      /* Registros fracos, apenas por nome, não são misturados a uma pessoa já
         identificada: podem pertencer a um homônimo antigo. */
      fontesSeguras = fontesList.filter(x => x.identityKey === strongKeys[0]);
    } else if (patientRefs.length > 1) {
      return { dados, fontes, ambiguous: true, patientRefs };
    } else if (patientRefs.length === 1) {
      fontesSeguras = fontesList.filter(x => x.patientRef === patientRefs[0]);
    } else if (fontesList.length > 1) {
      /* Mais de um documento conhecido apenas pelo nome continua ambíguo:
         quantidade de ocorrências não transforma nome em identificador. */
      return { dados, fontes, ambiguous: true };
    }

    if (!fontesSeguras.length) return { dados, fontes, ambiguous: false };

    /* 2. Ordena da mais recente para a mais antiga */
    fontesSeguras.sort((a, b) => b.ts - a.ts);

    /* 3. Para cada campo, pega o valor da fonte mais recente que o tenha */
    linker._CAMPOS_PACIENTE.forEach(campo => {
      for (const f of fontesSeguras) {
        const v = f.dados ? f.dados[campo] : null;
        if (v != null && String(v).trim() !== '') {
          dados[campo] = v;
          fontes[campo] = f.label;
          break;
        }
      }
    });

    /* Idade derivada do nascimento mais recente, se ausente */
    if ((!dados.idade || dados.idade === '') && dados.nascimento) {
      const id = linker._idadeDeNascimento(dados.nascimento);
      if (id) { dados.idade = id; fontes.idade = 'derivado (nascimento)'; }
    }
    /* convenio/plano e matricula/carteirinha são sinônimos — espelha */
    if (!dados.convenio && dados.plano) dados.convenio = dados.plano;
    if (!dados.plano && dados.convenio) dados.plano = dados.convenio;
    if (!dados.matricula && dados.carteirinha) dados.matricula = dados.carteirinha;
    if (!dados.carteirinha && dados.matricula) dados.carteirinha = dados.matricula;

    return {
      dados, fontes, ambiguous: false,
      identityKey: selectedKey || strongKeys[0] || '',
      patientRef: selectedRef || patientRefs[0] || ''
    };
  },

  /* Define o valor de um campo respeitando <select> (com casamento tolerante,
     ex.: sexo "M" ↔ "Masculino"). Retorna true se conseguiu aplicar. */
  _setCampo(el, valor) {
    valor = String(valor);
    if (el.tagName === 'SELECT') {
      const opts = Array.from(el.options);
      const norm = s => linker._normNome(s);
      const alvo = norm(valor);
      /* casamento direto por value ou texto */
      let opt = opts.find(o => norm(o.value) === alvo || norm(o.textContent) === alvo);
      /* sexo: M/F/Masculino/Feminino/Outro — só quando o select é claramente de sexo */
      if (!opt) {
        const SEXO_SET = ['m', 'f', 'o', 'masculino', 'feminino', 'outro'];
        const ehSexo = opts.every(o => {
          const ov = norm(o.value);
          return ov === '' || SEXO_SET.includes(ov);
        });
        const inicial = alvo.charAt(0);
        if (ehSexo && (inicial === 'm' || inicial === 'f')) {
          opt = opts.find(o => {
            const ov = norm(o.value) || norm(o.textContent);
            return ov && ov.charAt(0) === inicial;
          });
        }
      }
      if (!opt) return false;
      el.value = opt.value;
      return true;
    }
    el.value = valor;
    return true;
  },

  _LABEL_MOD: {
    anestesia: 'Ficha de Anestesia', pre: 'Pré-anestésica', consulta: 'Consulta',
    recuperacao: 'Recuperação SRPA', termo: 'Termo de Consentimento',
    prescricao: 'Receituário', documentos: 'Documentos', risco: 'Risco Cirúrgico',
    financeiro: 'Financeiro', orcamento: 'Orçamento'
  },

  /* Normaliza um registro do cadastro central para as chaves de _CAMPOS_PACIENTE */
  _normalizarCadastro(p) {
    return {
      nome: p.nome, nascimento: p.nascimento, idade: p.idade, sexo: p.sexo,
      peso: p.peso, altura: p.altura, imc: p.imc, cpf: p.cpf, rg: p.rg,
      prontuario: p.prontuario, endereco: p.endereco,
      convenio: p.convenio || p.plano, plano: p.plano || p.convenio,
      matricula: p.matricula || p.carteirinha, carteirinha: p.carteirinha || p.matricula,
      telefone: p.telefone, email: p.email,
      /* No cadastro a acomodação são duas caixas (apartamento / enfermaria);
         aqui vira um dado só, do jeito que os formulários esperam. */
      acomodacao: linker._acomodacaoDoCadastro(p)
    };
  },

  /* 'apartamento' | 'enfermaria' | '' a partir das caixas do cadastro */
  _acomodacaoDoCadastro(p) {
    const marcado = v => v === true || v === '1' || v === 1 || v === 'true';
    if (!p) return '';
    if (marcado(p.apartamento)) return 'apartamento';
    if (marcado(p.enfermaria)) return 'enfermaria';
    return p.acomodacao || '';
  },

  /* Extrai estrutura normalizada de dados do paciente a partir de QUALQUER módulo */
  _extrairDadosPaciente(mod, item) {
    const o = {};
    const src = (mod === 'anestesia' && item.paciente) ? item.paciente : item;
    Object.assign(o, {
      nome: src.nome, nascimento: src.nascimento || src.nasc, idade: src.idade,
      sexo: src.sexo, peso: src.peso, altura: src.altura, imc: src.imc,
      cpf: src.cpf, rg: src.rg, prontuario: src.prontuario, endereco: src.endereco,
      convenio: src.convenio, plano: src.plano,
      matricula: src.matricula, carteirinha: src.carteirinha,
      telefone: src.telefone, email: src.email,
      acomodacao: src.acomodacao || item.acomodacao || item.origem
    });
    return o;
  },

  /* Mapa: { chave_dado_normalizado: nome_campo_form } por módulo de destino */
  _mapaCamposPaciente(mod) {
    if (mod === 'anestesia') {
      return {
        nome: 'paciente_nome', nascimento: 'paciente_nasc', idade: 'paciente_idade',
        sexo: 'paciente_sexo', peso: 'paciente_peso', altura: 'paciente_altura',
        cpf: 'paciente_cpf', prontuario: 'paciente_prontuario',
        convenio: 'paciente_convenio', plano: 'paciente_plano', matricula: 'paciente_matricula',
        /* a carteirinha estava fora do mapa: existe no cadastro e no formulário,
           mas nunca era trazida — e é ela que vai na guia */
        carteirinha: ['paciente_carteirinha', 'carteirinha'],
        /* apartamento/enfermaria do cadastro → "Procedência / origem" da ficha */
        acomodacao: ['origem', 'acomodacao'],
        telefone: 'paciente_telefone', email: 'paciente_email'
      };
    }
    if (mod === 'termo') {
      return {
        nome: 'nome', nascimento: 'nascimento', idade: 'idade',
        sexo: 'sexo', convenio: 'convenio', cirurgia: 'procedimento', procedimento: 'procedimento',
        /* O TCLE TEM campo "Documento (RG/CPF)" desde sempre, e ele nunca era
           preenchido: o mapa não o citava. Num termo de consentimento o
           documento não é enfeite — é o que identifica quem assinou. */
        cpf: ['documento', 'cpf'], rg: ['documento', 'rg']
      };
    }
    /* pre, consulta, recuperacao, prescricao usam mesmos nomes simples.
       O nascimento é o caso que quebrou: a pré chama o campo de `nasc` e este
       mapa procurava `nascimento` — nunca achava, e a data de nascimento
       simplesmente não vinha do cadastro. Agora o mapa aceita ALTERNATIVAS,
       para um apelido diferente num formulário não derrubar o preenchimento. */
    return {
      nome: 'nome', nascimento: ['nascimento', 'nasc', 'data_nascimento'], idade: 'idade',
      sexo: 'sexo', peso: 'peso', altura: 'altura',
      /* `prescricao` e `documentos` chamam o campo de `documento`; `pre` e
         `consulta` chamam de `cpf`. Aceitar os dois apelidos é o que faz o
         dado do cadastro chegar nos três. */
      cpf: ['cpf', 'documento'], prontuario: 'prontuario',
      convenio: 'convenio', plano: 'plano', matricula: 'matricula',
      carteirinha: 'carteirinha',
      acomodacao: ['acomodacao', 'origem'],
      telefone: 'telefone', email: 'email', endereco: 'endereco'
    };
  },

  /* === IMPORTAÇÃO Pré → Anestesia ===
     Quando o usuário inicia/edita ficha de anestesia, verifica se há Pré
     do mesmo paciente e oferece importar o procedimento. */
  /* Monta um resumo compacto dos exames relevantes da Pré-anestésica
     (laboratoriais principais + ECG + ECO + outros), para preencher o campo
     "Exames relevantes" da Ficha quando houver Pré. */
  _resumoExamesPre(pre) {
    if (!pre) return '';
    const partes = [];
    const labs = [
      ['Hb', pre.lab_hb], ['Ht', pre.lab_ht], ['Plaq', pre.lab_plt],
      ['INR', pre.lab_inr], ['TTPa', pre.lab_ttpa], ['Ur', pre.lab_ureia],
      ['Creat', pre.lab_creat], ['Na', pre.lab_na], ['K', pre.lab_k],
      ['Glic', pre.lab_glicemia], ['HbA1c', pre.lab_hba1c]
    ].filter(([, v]) => v != null && String(v).trim() !== '')
     .map(([k, v]) => k + ' ' + String(v).trim());
    if (labs.length) partes.push(labs.join(', '));
    if (pre.lab_ecg) partes.push('ECG: ' + String(pre.lab_ecg).trim());
    if (pre.lab_eco) partes.push('ECO: ' + String(pre.lab_eco).trim());
    if (pre.exames_compl) partes.push(String(pre.exames_compl).trim());
    return partes.join('. ');
  },

  /* Nomes para os quais já tentamos buscar a pré na nuvem nesta sessão —
     evita repetir a ida ao servidor a cada blur do campo de nome. */
  _preBuscadaNaNuvem: {},

  /* A pré pode existir só na nuvem (feita em outro aparelho). Sem isto, o
     médico digitava o nome, nada acontecia, e não havia como saber por quê. */
  _buscarPreNaNuvem(nomePaciente, opts) {
    try {
      opts = opts || {};
      const contextoAoBuscar = contextoAba.capturar();
      if (!contextoAba.corresponde(contextoAoBuscar)) return;
      const chave = contextoAoBuscar.organizationId + '|' + contextoAoBuscar.userId + '|' +
        contextoAoBuscar.generation + '|' + (opts.identityKey || '') + '|' + (opts.patientRef || '') + '|' +
        (opts.caseId || '') + '|' + linker._normNome(nomePaciente);
      if (!chave || linker._preBuscadaNaNuvem[chave]) return;
      if (typeof cloudRel === 'undefined' || !cloudRel.autoPullModulo || !cloudRel.disponivel || !cloudRel.disponivel()) return;
      /* O nome pode continuar igual quando a pessoa troca para um homônimo,
         e o atendimento pode mudar sem trocar de paciente. A resposta só
         pode preencher o mesmo contexto do formulário que pediu a busca. */
      const pacienteAoBuscar = linker.contextoPaciente('anestesia');
      const casoAoBuscar = linker.contextoCaso('anestesia');
      linker._preBuscadaNaNuvem[chave] = true;
      /* o pull do módulo só roda uma vez por sessão; aqui queremos de fato ir
         buscar, senão a chamada volta vazia sem tocar no servidor */
      try { cloudRel._puxados['pre'] = false; } catch (e) {}
      Promise.resolve(cloudRel.autoPullModulo('pre')).then(() => {
        if (!contextoAba.corresponde(contextoAoBuscar)) return;
        if (!linker.ultimoPorNome('pre', nomePaciente, opts)) return;
        /* o médico pode ter trocado de paciente enquanto a nuvem respondia */
        const f = document.getElementById('form-anestesia');
        const atual = f ? (f.querySelector('[name="paciente_nome"]') || {}).value : '';
        if (linker._normNome(atual) !== linker._normNome(nomePaciente)) return;
        const pacienteAtual = linker.contextoPaciente('anestesia');
        const casoAtual = linker.contextoCaso('anestesia');
        if (pacienteAtual.identityKey !== pacienteAoBuscar.identityKey ||
            pacienteAtual.patientRef !== pacienteAoBuscar.patientRef ||
            casoAtual.caseId !== casoAoBuscar.caseId ||
            casoAtual.caseKey !== casoAoBuscar.caseKey) return;
        linker.importarPreParaAnestesia(nomePaciente, Object.assign({}, opts, { _semNuvem: true }));
      }).catch(() => {});
    } catch (e) {}
  },

  importarPreParaAnestesia(nomePaciente, opts = {}) {
    if (!nomePaciente) return false;
    const contexto = linker.contextoPaciente('anestesia');
    const caso = linker.contextoCaso('anestesia');
    const registroKey = opts.registro ? linker._chavePaciente(opts.registro) : '';
    const identityKey = opts.identityKey || registroKey || contexto.identityKey || '';
    const patientRef = opts.patientRef || (opts.registro && opts.registro._patientRef) || contexto.patientRef || '';
    opts = Object.assign({}, opts, {
      identityKey, patientRef,
      caseId: opts.caseId || caso.caseId || '', caseKey: opts.caseKey || caso.caseKey || ''
    });
    /* opts.registro: a pré exata escolhida pelo usuário (importação manual),
       em vez da mais recente daquele nome */
    const pre = opts.registro || linker.ultimoPorNome('pre', nomePaciente, opts);
    if (!pre) {
      if (!opts._semNuvem) linker._buscarPreNaNuvem(nomePaciente, opts);
      return false;
    }

    const form = document.getElementById('form-anestesia');
    if (!form) return false;
    linker.aplicarContextoPaciente('anestesia', pre, {
      identityKey: identityKey || linker._chavePaciente(pre),
      patientRef: patientRef || pre._patientRef || ''
    });
    linker.aplicarContextoCaso('anestesia', pre, {
      caseId: opts.caseId || pre._caseId || '', caseKey: opts.caseKey || pre._caseKey || ''
    });

    /* Preenche apenas campos vazios da ficha (não sobrescreve o que já há) */
    const setSe = (name, val) => {
      if (val == null || val === '') return;
      const el = form.querySelector('[name="' + name + '"]');
      /* _setCampo em vez de el.value = val: convênio e sexo são <select> e
         atribuição crua não casa "Unimed"/"Masculino" com a opção certa. */
      if (el && !el.value) linker._setCampo(el, val);
    };
    /* Dados do paciente e clínicos vindos da Pré-anestésica */
    setSe('paciente_nasc', pre.nasc || pre.nascimento);
    setSe('paciente_sexo', pre.sexo);
    setSe('paciente_peso', pre.peso);
    setSe('paciente_altura', pre.altura);
    /* Estes quatro estavam na pré e não vinham para a ficha — o médico
       redigitava convênio, senha, cirurgião e hospital a cada ficha. */
    setSe('paciente_convenio', pre.convenio);
    setSe('paciente_senha', pre.senha);
    setSe('paciente_prontuario', pre.prontuario);
    setSe('cirurgiao', pre.cirurgiao);
    setSe('local_hospital', pre.hospital || pre.local);
    /* A CIRURGIA VEM DA PRÉ — e era justamente o campo que não vinha. O
       médico redigitava o procedimento a cada ficha, e o lado nem existia
       para ser redigitado. Código, descrição, quantidade e lateralidade
       atravessam juntos; `setSe` só preenche o que está vazio, então o que
       foi REALIZADO continua podendo ser corrigido na ficha. */
    try {
      const cirs = cirurgia.daPreDoc(pre);
      if (cirs.length) {
        setSe('procedimento', cirs[0].descricao || cirs[0].codigo);
        setSe('lateralidade', cirs[0].lateralidade);
        const jaTem = new Set();
        document.querySelectorAll('[name="cir_extra_proc[]"]').forEach(el => jaTem.add(String(el.value || '').toLowerCase().trim()));
        const principal = String(cirs[0].descricao || cirs[0].codigo || '').toLowerCase().trim();
        cirs.slice(1).forEach(c => {
          const txt = String(c.descricao || c.codigo || '').toLowerCase().trim();
          if (!txt || txt === principal || jaTem.has(txt)) return;
          anestesia.cirurgias.add({ procedimento: c.descricao || c.codigo, lateralidade: c.lateralidade, quantidade: c.quantidade, grau: '50' }, { mesmaEquipe: true });
          jaTem.add(txt);
        });
      }
    } catch (e) {}
    setSe('pre_diagnostico', pre.cirurgia);
    setSe('pre_comorbidades', pre.comorbidades);
    setSe('pre_alergias', pre.alergias);
    setSe('pre_medicacoes', pre.medicacoes);
    setSe('pre_asa', pre.asa);
    setSe('pre_jejum', pre.jejum);
    setSe('pre_medicacao', pre.medicacao_pre);
    setSe('pre_via_aerea', pre.via_aerea || pre.via_aerea_resumo);
    setSe('pre_glicemia', pre.lab_glicemia);
    setSe('pre_exames', linker._resumoExamesPre(pre));
    setSe('pre_observacoes', pre.risco_resumo || pre.conclusao || pre.antecedentes);

    /* Procedimento principal (respeita o já digitado, salvo force=true) */
    const procEl = form.querySelector('[name="procedimento"]');
    if (procEl && pre.cirurgia && (!procEl.value || opts.force)) procEl.value = pre.cirurgia;

    /* Recalcula IMC/idade primeiro (a idade vem do nascimento, quando houver) */
    try { anestesia.calc.idade(); anestesia.calc.imc(); } catch (e) {}
    /* Se não veio nascimento, usa a idade registrada na Pré */
    setSe('paciente_idade', pre.idade);
    try { comorbidades.syncRapidas(); } catch (e) {}

    /* Marca o vínculo para salvar depois */
    if (window.anestesia) {
      anestesia._linkPendente = { mod: 'pre', id: pre._id };
    }
    if (!opts.silent) {
      toast('📋 Dados importados da Avaliação pré-anestésica' + (pre.cirurgia ? ': ' + pre.cirurgia.slice(0, 40) : ''));
    }
    return true;
  },

  /* === IMPORTAÇÃO Anestesia → Financeiro ===
     Quando o usuário inicia novo registro financeiro, busca Anestesia
     do mesmo paciente e importa procedimento principal + cirurgias combinadas
     como linhas na tabela de códigos TUSS. */
  importarAnestesiaParaFinanceiro(nomePaciente, opts = {}) {
    if (!nomePaciente) return false;
    const contexto = linker.contextoPaciente('financeiro');
    const caso = linker.contextoCaso('financeiro');
    const identityKey = opts.identityKey || contexto.identityKey || '';
    const patientRef = opts.patientRef || contexto.patientRef || '';
    opts = Object.assign({}, opts, {
      identityKey, patientRef,
      caseId: opts.caseId || caso.caseId || '', caseKey: opts.caseKey || caso.caseKey || ''
    });
    const a = linker.ultimoPorNome('anestesia', nomePaciente, opts);
    if (!a) return false;

    const form = document.getElementById('form-financeiro');
    if (!form) return false;
    linker.aplicarContextoPaciente('financeiro', a, {
      identityKey: identityKey || linker._chavePaciente(a),
      patientRef: patientRef || a._patientRef || ''
    });
    linker.aplicarContextoCaso('financeiro', a, {
      caseId: opts.caseId || a._caseId || '', caseKey: opts.caseKey || a._caseKey || ''
    });

    /* Preenche o procedimento principal se vazio */
    const procEl = form.querySelector('[name="procedimento"]');
    if (procEl && !procEl.value) {
      const procPrincipal = (a.procedimento && a.procedimento.descricao) || a.procedimento || '';
      if (procPrincipal) procEl.value = procPrincipal;
    }

    /* Preenche cirurgião / hospital se vazios */
    const setIfEmpty = (name, value) => {
      const el = form.querySelector(`[name="${name}"]`);
      if (el && !el.value && value) el.value = value;
    };
    setIfEmpty('cirurgiao', (a.procedimento && a.procedimento.cirurgiao) || a.cirurgiao);
    setIfEmpty('hospital',  (a.procedimento && a.procedimento.hospital) || a.local_hospital);
    setIfEmpty('convenio',  (a.paciente && a.paciente.convenio) || a.convenio);
    setIfEmpty('data_proc', (a.procedimento && a.procedimento.data) || a.data_anestesia || a.data);

    /* Coleta TODOS os procedimentos: principal (100%) + cirurgias combinadas
       (com o GRAU marcado na ficha; padrão 70%). Obs.: a ficha salva a
       descrição em c.procedimento — c.descricao é só legado. */
    const procs = [];
    const principal = (a.procedimento && a.procedimento.descricao) || a.procedimento;
    if (principal && typeof principal === 'string') procs.push({ desc: principal, grau: '100' });
    const extras = (a.procedimento && a.procedimento.cirurgias_extra) || a.cirurgias_extra || [];
    extras.forEach(c => {
      const d = c.procedimento || c.descricao;
      if (d) procs.push({ desc: d, grau: String(c.grau || '50') });
    });

    /* Limpa tabela de códigos antes de importar (apenas se vazia) */
    const tbody = document.getElementById('fin-codigos-body');
    const jaTinha = tbody && tbody.children.length > 0;
    if (jaTinha && !opts.force) {
      /* Não importa por cima — apenas mostra aviso */
      if (!opts.silent) toast('Códigos já presentes — importação automática pulada', 'warn');
      return false;
    }

    /* Para cada procedimento, busca código TUSS na CBHPM e adiciona linha */
    let nImp = 0;
    procs.forEach(p => {
      const desc = p.desc;
      /* Busca match exato primeiro, depois parcial */
      let match = cbhpm.tabela().find(c => c[1].toLowerCase() === desc.toLowerCase());
      if (!match) {
        const candidatos = cbhpm.tabela().filter(c => c[1].toLowerCase().includes(desc.toLowerCase()));
        if (candidatos.length === 1) match = candidatos[0];
      }
      if (window.financeiro && financeiro.codigos) {
        financeiro.codigos.add({
          codigo: match ? match[0] : '',
          descricao: match ? match[1] : desc,
          porte:    match ? match[2] : '',
          grau:     p.grau,
          status: 'aguardando'
        });
        nImp++;
      }
    });
    /* Hierarquia automática: maior porte 100%, demais 50% (70% manual preservado) */
    if (nImp > 1) { try { financeiro.codigos.classificarGrau({ silent: true }); } catch (e) {} }

    /* Também importa procedimentos extras da Pré-anestésica do mesmo paciente */
    try {
      const p = linker.ultimoPorNome('pre', nomePaciente, opts);
      if (p && Array.isArray(p._procsExtra)) {
        p._procsExtra.forEach(pe => {
          if (!pe.descricao && !pe.codigo) return;
          let match = pe.codigo ? cbhpm.tabela().find(c => c[0] === pe.codigo) : null;
          if (!match && pe.descricao) {
            const cand = cbhpm.tabela().filter(c => c[1].toLowerCase().includes(pe.descricao.toLowerCase()));
            if (cand.length === 1) match = cand[0];
          }
          if (window.financeiro && financeiro.codigos) {
            financeiro.codigos.add({
              codigo: pe.codigo || (match ? match[0] : ''),
              descricao: pe.descricao || (match ? match[1] : ''),
              porte: match ? match[2] : '',
              status: 'aguardando'
            });
            nImp++;
          }
        });
      }
    } catch (e) {}

    /* Acomodação vinda do cadastro do paciente (apartamento OU enfermaria).
       Enfermaria não gera adicional, mas precisa constar no lançamento. */
    try {
      const acEl0 = form.querySelector('[name="acomodacao"]');
      const nomePac = (a.paciente && a.paciente.nome) || a.paciente_nome || '';
      /* o que está na ficha vale mais que o cadastro: é o desta internação */
      const daFicha = ((a.paciente && a.paciente.acomodacao) || '').toLowerCase();
      const acom = (daFicha === 'apartamento' || daFicha === 'enfermaria')
        ? daFicha : anestesia.adicionais.acomodacaoDoPaciente(nomePac, opts);
      if (acEl0 && !acEl0.value && acom) {
        acEl0.value = acom;
        try { financeiro.fatores.onAcomodacao(acom); } catch (e) {}
      }
    } catch (e) {}

    /* Registra adicionais da anestesia (apartamento, urgência, FDS...) —
       agora ATIVA os fatores de cobrança em vez de só anotar */
    try {
      if (a.adicionais && a.adicionais.itens && a.adicionais.itens.length) {
        const itens = a.adicionais.itens;
        /* Apartamento → acomodação + fator (regra do convênio se houver) */
        if (itens.includes('apartamento')) {
          const acEl = form.querySelector('[name="acomodacao"]');
          if (acEl) acEl.value = 'apartamento';
          try { financeiro.fatores.onAcomodacao('apartamento'); } catch (e) {}
        }
        /* Urgência / FDS / noturno → checkbox de urgência */
        if (itens.includes('urgencia') || itens.includes('fim_semana') || itens.includes('periodo_noturno')) {
          const uEl = form.querySelector('[name="urgencia"]');
          if (uEl) uEl.checked = true;
        }
        const LABELS = { apartamento: 'Apartamento', urgencia: 'Urgência', fim_semana: 'FDS/Feriado', periodo_noturno: 'Noturno', porte_anestesico: 'Porte anestésico', via_dupla: 'Dupla via', multiplos_proc: 'Múltiplos proc.', acompanhamento: 'Acompanhamento' };
        const nomes = a.adicionais.itens.map(k => LABELS[k] || k).join(', ');
        const obsEl = form.querySelector('[name="observacoes"]');
        if (obsEl) {
          const txtAdic = 'Adicionais: ' + nomes + (a.adicionais.obs ? ' — ' + a.adicionais.obs : '');
          if (!obsEl.value.includes('Adicionais:')) {
            obsEl.value = (obsEl.value ? obsEl.value + '\n' : '') + txtAdic;
          }
        }
      }
    } catch (e) {}

    /* Marca vínculo para salvar depois */
    if (window.financeiro) {
      financeiro._linkPendente = { mod: 'anestesia', id: a._id };
    }

    if (nImp > 0 && !opts.silent) {
      toast(`💰 ${nImp} código(s) importado(s) da ficha de anestesia`);
      /* Recalcula totais */
      try { financeiro.codigos.recalcular(); } catch (e) {}
    }
    return nImp > 0;
  }
};

/* FIM DO LINKER DE ATENDIMENTOS */
