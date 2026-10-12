'use strict';

/* Administrative legacy migration. Only metadata enters this view; server RPCs
   decide permissions, organization, provenance, identity and conflicts. */
(function (root) {
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const HASH = /^[0-9a-f]{64}$/;
  const SCOPES = new Set(['unstamped_only', 'matching_stamp_only']);
  const fail = message => { throw new Error(message); };
  const uuid = (value, label) => {
    const result = String(value || '').trim().toLowerCase();
    if (!UUID.test(result)) fail('Informe o identificador exato de ' + label + '.');
    return result;
  };
  const text = (value, min, max, label) => {
    const result = String(value || '').trim();
    if (result.length < min || result.length > max) fail(label + ': use entre ' + min + ' e ' + max + ' caracteres.');
    return result;
  };
  const object = value => {
    const result = Array.isArray(value) && value.length === 1 ? value[0] : value;
    if (!result || typeof result !== 'object' || Array.isArray(result)) fail('O servidor não confirmou esta operação. Atualize o relatório.');
    return result;
  };
  const selection = value => {
    const result = {
      sourceUser: uuid(value.sourceUser, 'conta de origem'),
      organization: uuid(value.organization, 'clínica confirmada'),
      scope: String(value.scope || '')
    };
    if (!SCOPES.has(result.scope)) fail('Escolha explicitamente o escopo de carimbos.');
    return Object.freeze(result);
  };
  const sameSelection = (a, b) => !!a && !!b && a.sourceUser === b.sourceUser &&
    a.organization === b.organization && a.scope === b.scope;

  function createWorkflow(deps) {
    let revision = 0, busy = false, preview = null, binding = null;
    const reset = () => { revision++; preview = null; binding = null; };
    const current = operation => {
      if (revision !== operation.revision || !deps.isCurrent(operation.auth)) {
        reset(); fail('A conta, a clínica ou o escopo mudou. Faça uma nova conferência antes de continuar.');
      }
    };
    async function run(task) {
      if (busy) fail('Aguarde a confirmação da operação em andamento.');
      busy = true;
      try {
        const auth = deps.captureAuth();
        if (!auth || !UUID.test(String(auth.userId || ''))) fail('Entre com a conta programadora na nuvem.');
        const operation = { auth, revision };
        const rows = await deps.request('app_programmers?select=user_id&user_id=eq.' + encodeURIComponent(auth.userId));
        current(operation);
        if (!Array.isArray(rows) || rows.length !== 1 || rows[0].user_id !== auth.userId) {
          reset(); fail('O servidor não reconhece esta conta como programador.');
        }
        const rpc = async (name, args) => {
          current(operation);
          const result = object(await deps.rpc(name, args));
          current(operation);
          return result;
        };
        return await task(operation, rpc);
      } finally { busy = false; }
    }
    function approved(value, operation) {
      const picked = selection(value);
      if (!binding || !preview || !sameSelection(picked, preview.selection) ||
        !deps.isCurrent(preview.auth) || preview.auth.userId !== operation.auth.userId) {
        fail('Confira o lote e registre a declaração do proprietário antes desta operação.');
      }
      return picked;
    }
    async function selected(ids, picked, statuses, requireOrganization, rpc) {
      const keys = [...new Set((Array.isArray(ids) ? ids : []).map(id => uuid(id, 'linha do inventário')))];
      if (!keys.length || keys.length > 250) fail('Selecione entre 1 e 250 linhas visíveis do inventário.');
      const visible = deps.rows();
      keys.forEach(id => {
        const row = visible.find(item => item.registry_id === id);
        if (!row || row.source_user_id !== picked.sourceUser) fail('Todas as linhas precisam pertencer à conta de origem conferida e estar visíveis.');
        if (!row.target_table || !statuses.includes(row.status)) fail('O estado desta linha não permite esta etapa. Atualize o relatório.');
        if ((requireOrganization || row.organization_id) && row.organization_id !== picked.organization) fail('A linha está em outra clínica ou ainda não foi classificada.');
        const module = String(row.source_module || '');
        if (module.includes('@')) {
          const parts = module.split('@');
          if (parts.length !== 2 || !UUID.test(parts[1]) || parts[1].toLowerCase() !== picked.organization || picked.scope !== 'matching_stamp_only') {
            fail('O carimbo de clínica desta linha não pertence ao escopo conferido.');
          }
        }
      });
      const scopeCheck = await rpc('prog_check_legacy_scope', { p_registry_ids: keys, p_binding_id: binding.id });
      if (scopeCheck.binding_id !== binding.id || scopeCheck.selected_count !== keys.length || scopeCheck.scope_confirmed !== true) {
        fail('O servidor não confirmou a conta, a clínica e os carimbos de todas as linhas selecionadas.');
      }
      return keys;
    }
    const counter = (result, field) => {
      if (!Number.isInteger(result[field]) || result[field] < 0) fail('O servidor retornou uma contagem inválida. Atualize o relatório.');
      return result[field];
    };
    return Object.freeze({
      reset,
      invalidateEvidence: () => { revision++; binding = null; },
      state: () => ({ busy, preview, binding }),
      async preview(value) {
        if (busy) fail('Aguarde a confirmação da operação em andamento.');
        const picked = selection(value); reset();
        return run(async (operation, rpc) => {
          const result = await rpc('prog_legacy_provenance_preview', {
            p_source_user: picked.sourceUser, p_org: picked.organization, p_scope: picked.scope
          });
          if (!Number.isInteger(result.source_count) || result.source_count < 0 || !HASH.test(result.source_manifest_hash) || result.source_scope !== picked.scope) {
            fail('O servidor não confirmou a contagem, o escopo e o manifesto do lote.');
          }
          preview = Object.freeze({ selection: picked, count: result.source_count,
            hash: result.source_manifest_hash, auth: operation.auth });
          return preview;
        });
      },
      async bind(value, proof) {
        const picked = selection(value);
        const statement = text(proof.statement, 12, 500, 'Declaração do proprietário');
        const reference = text(proof.reference, 8, 200, 'Referência da evidência');
        if (proof.reviewed !== true) fail('Confirme que verificou a conta, a clínica, o escopo, a contagem e o manifesto.');
        return run(async (operation, rpc) => {
          if (!preview || !sameSelection(picked, preview.selection) || !deps.isCurrent(preview.auth) ||
            preview.auth.userId !== operation.auth.userId || preview.count < 1) fail('Confira novamente o lote exato antes de registrar a declaração.');
          binding = null;
          const reviewed = preview;
          const result = await rpc('prog_bind_legacy_provenance', {
            p_source_user: picked.sourceUser, p_org: picked.organization, p_scope: picked.scope,
            p_owner_statement: statement, p_evidence_reference: reference,
            p_expected_source_count: reviewed.count, p_expected_manifest_hash: reviewed.hash
          });
          const id = uuid(result.binding_id, 'vínculo confirmado pelo servidor');
          if (result.source_count !== reviewed.count) fail('O servidor não confirmou o tamanho do lote revisado.');
          const rows = await deps.request('legacy_provenance_bindings?id=eq.' + encodeURIComponent(id) +
            '&select=id,source_user_id,organization_id,source_scope,source_count,source_manifest_hash,recorded_by,owner_statement,evidence_reference');
          current(operation);
          const row = Array.isArray(rows) && rows.length === 1 ? rows[0] : null;
          if (!row || row.id !== id || row.source_user_id !== picked.sourceUser || row.organization_id !== picked.organization ||
            row.source_scope !== picked.scope || row.source_count !== reviewed.count || row.source_manifest_hash !== reviewed.hash ||
            row.recorded_by !== operation.auth.userId || row.owner_statement !== statement || row.evidence_reference !== reference) {
            fail('Não foi possível conferir o vínculo persistido na nuvem. Não classifique; confira novamente o relatório.');
          }
          binding = Object.freeze({ id, count: reviewed.count, hash: reviewed.hash });
          return binding;
        });
      },
      async classify(value, ids, reason) {
        const justification = text(reason, 12, 500, 'Justificativa operacional');
        return run(async (operation, rpc) => {
          const picked = approved(value, operation);
          const keys = await selected(ids, picked, ['quarantined', 'classified', 'target_conflict'], false, rpc);
          const result = await rpc('prog_classify_legacy_documents', { p_registry_ids: keys, p_org: picked.organization, p_reason: justification });
          if (counter(result, 'classified') !== keys.length) fail('A classificação não foi confirmada integralmente. Atualize o relatório.');
          return { classified: result.classified };
        });
      },
      async map(value, ids, kind, destination, reason) {
        const target = uuid(destination, kind === 'patient' ? 'paciente confirmado' : 'atendimento confirmado');
        const justification = text(reason, 12, 500, 'Justificativa da correspondência');
        if (!['patient', 'encounter'].includes(kind)) fail('Escolha paciente ou atendimento.');
        return run(async (operation, rpc) => {
          const picked = approved(value, operation);
          const keys = await selected(ids, picked, ['classified', 'target_conflict'], true, rpc);
          if (keys.length !== 1) fail('A correspondência explícita exige exatamente uma linha selecionada.');
          const isPatient = kind === 'patient';
          const args = { p_registry: keys[0], p_reason: justification };
          args[isPatient ? 'p_patient' : 'p_encounter'] = target;
          const result = await rpc(isPatient ? 'prog_bind_legacy_patient' : 'prog_bind_legacy_encounter', args);
          const field = isPatient ? 'patient_mapping_recorded' : 'encounter_mapping_recorded';
          if (result.registry_id !== keys[0] || result[field] !== true) fail('O servidor não confirmou a correspondência.');
          return { [field]: true, registry_id: keys[0] };
        });
      },
      async copy(value, ids) {
        return run(async (operation, rpc) => {
          const keys = await selected(ids, approved(value, operation), ['classified', 'target_conflict', 'copied', 'validated'], true, rpc);
          const result = await rpc('prog_copy_legacy_documents', { p_registry_ids: keys, p_rollback_hours: 168 });
          const counts = { copied: counter(result, 'copied'), blocked: counter(result, 'blocked'), failed: counter(result, 'failed') };
          if (counts.copied + counts.blocked + counts.failed !== keys.length) fail('O servidor não confirmou o resultado de todas as linhas. Atualize o relatório.');
          return counts;
        });
      },
      async validate(value, ids) {
        return run(async (operation, rpc) => {
          const keys = await selected(ids, approved(value, operation), ['copied', 'validated'], true, rpc);
          const result = await rpc('prog_validate_legacy_documents', { p_registry_ids: keys });
          const counts = { validated: counter(result, 'validated'), blocked: counter(result, 'blocked') };
          if (counts.validated + counts.blocked !== keys.length) fail('O servidor não confirmou a validação de todas as linhas. Atualize o relatório.');
          return counts;
        });
      }
    });
  }

  let mounted = null, observingContext = false;
  function mount(deps) {
    const doc = deps.document || root.document;
    const host = doc.getElementById('prog-legado-proveniencia');
    if (!host) return;
    if (mounted) mounted.workflow.reset();
    const admin = deps.programador;
    if (!observingContext && typeof deps.contextoAba.aoMudar === 'function') {
      observingContext = true;
      deps.contextoAba.aoMudar((next, previous) => {
        if (!previous || next.userId !== previous.userId || next.generation !== previous.generation) clear();
      });
    }
    const workflow = createWorkflow({
      captureAuth: () => {
        const session = deps.cloud.session();
        if (!session || !session.access_token || !session.user || !admin.souProgramador()) return null;
        return { userId: session.user.id, context: deps.contextoAba.capturar() };
      },
      isCurrent: auth => {
        const session = deps.cloud.session();
        return !!auth && !!session && !!session.access_token && !!session.user && admin.souProgramador() &&
          session.user.id === auth.userId && auth.context.userId === auth.userId && deps.contextoAba.mesmaGeracao(auth.context);
      },
      request: path => admin._req(path), rpc: (name, args) => admin._rpc(name, args), rows: () => admin._legacyItems || []
    });
    const node = (tag, content) => {
      const el = doc.createElement(tag); if (content !== undefined) el.textContent = content; return el;
    };
    const field = (label, input) => {
      const wrap = node('label'); wrap.className = 'field'; wrap.appendChild(node('span', label)); wrap.appendChild(input); host.appendChild(wrap); return input;
    };
    host.replaceChildren();
    host.appendChild(node('p', 'Primeiro selecione uma conta de origem e a clínica confirmada. A declaração e a referência serão auditadas pelo servidor. Autoria histórica permanece não verificada.'));
    const scope = node('select'); scope.id = 'prog-legado-scope';
    [['', '— escolha o escopo —'], ['unstamped_only', 'Somente registros sem carimbo'], ['matching_stamp_only', 'Somente carimbos desta clínica']].forEach(([value, label]) => {
      const option = node('option', label); option.value = value; scope.appendChild(option);
    });
    field('Escopo revisado', scope);
    const report = node('p', 'Nenhum lote conferido.'); report.id = 'prog-legado-manifesto'; report.setAttribute('aria-live', 'polite'); host.appendChild(report);
    const statement = node('textarea'); statement.id = 'prog-legado-owner-statement'; statement.maxLength = 500;
    field('Declaração do proprietário (sem conteúdo clínico)', statement);
    const reference = node('input'); reference.id = 'prog-legado-evidence-reference'; reference.maxLength = 200;
    field('Referência da autorização ou evidência do proprietário', reference);
    const reviewed = node('input'); reviewed.type = 'checkbox'; reviewed.id = 'prog-legado-proof-reviewed';
    field('Conferi a conta exata, a clínica, o escopo, a contagem e o manifesto com a evidência do proprietário.', reviewed);
    const buttons = node('div'); host.appendChild(buttons);
    const status = node('p'); status.id = 'prog-legado-proveniencia-estado'; status.setAttribute('aria-live', 'polite'); host.appendChild(status);
    const inputValue = id => String((doc.getElementById(id) || {}).value || '');
    const values = () => ({ sourceUser: inputValue('prog-legado-user'), organization: inputValue('prog-legado-org'), scope: scope.value });
    const destination = node('input'); destination.id = 'prog-legado-mapping-target'; destination.placeholder = 'UUID confirmado do paciente ou atendimento';
    const mappingReason = node('input'); mappingReason.id = 'prog-legado-mapping-reason'; mappingReason.maxLength = 500;
    const mapping = node('div'); host.appendChild(mapping);
    mapping.appendChild(node('p', 'Para uma colisão, selecione exatamente uma linha classificada e informe o identificador de paciente já conferido por acesso autorizado. Se precisar reutilizar atendimento, registre primeiro o paciente, depois o atendimento. Nenhum conteúdo clínico é exibido aqui.'));
    mapping.appendChild(destination); mapping.appendChild(mappingReason); mappingReason.placeholder = 'Justificativa da correspondência, sem dados clínicos';
    const controls = [];
    const renderProof = () => {
      const state = workflow.state();
      if (!state.preview) report.textContent = 'Nenhum lote conferido.';
      else report.textContent = 'Conta: ' + state.preview.selection.sourceUser + ' | Clínica: ' + admin._nomeOrg(state.preview.selection.organization) +
        ' (' + state.preview.selection.organization + ') | Escopo: ' + (state.preview.selection.scope === 'unstamped_only' ? 'sem carimbo' : 'carimbos desta clínica') +
        ' | Registros: ' + state.preview.count + ' | Manifesto SHA-256: ' + state.preview.hash +
        (state.binding ? ' | Vínculo confirmado na nuvem: ' + state.binding.id : ' | Declaração ainda não registrada.');
    };
    async function act(name) {
      if (workflow.state().busy) return;
      controls.forEach(button => { button.disabled = true; }); status.textContent = 'Aguardando confirmação do servidor…';
      try {
        const picked = values(); const ids = admin._legacySelecionados(); let result;
        if (name === 'preview') { result = await workflow.preview(picked); reviewed.checked = false; }
        else if (name === 'bind') {
          const p = workflow.state().preview;
          if (!p || !sameSelection(selection(picked), p.selection)) fail('Confira primeiro o lote exato.');
          if (!reviewed.checked) fail('Marque a conferência da evidência antes de registrar.');
          if (!deps.confirm('Registrar a declaração do proprietário para a conta ' + p.selection.sourceUser + '\nClínica: ' + admin._nomeOrg(p.selection.organization) + ' (' + p.selection.organization + ')\nEscopo: ' + p.selection.scope + '\nRegistros: ' + p.count + '\nManifesto: ' + p.hash + '\nDeclaração: ' + statement.value + '\nReferência: ' + reference.value + '\n\nA autoria histórica continuará não verificada.')) { status.textContent = 'Registro cancelado.'; return; }
          result = await workflow.bind(picked, { statement: statement.value, reference: reference.value, reviewed: reviewed.checked });
        } else if (name === 'classify') {
          if (!deps.confirm('Classificar as ' + ids.length + ' linhas selecionadas para ' + admin._nomeOrg(picked.organization) + ' (' + picked.organization + ')? A origem ficará intacta e a decisão será auditada.')) { status.textContent = 'Classificação cancelada.'; return; }
          result = await workflow.classify(picked, ids, admin._legacyJustificativa());
        } else if (name === 'patient' || name === 'encounter') {
          if (!deps.confirm('Registrar correspondência explícita da linha selecionada com ' + (name === 'patient' ? 'paciente ' : 'atendimento ') + destination.value + ' na clínica ' + admin._nomeOrg(picked.organization) + '? Nenhum destino será alterado.')) { status.textContent = 'Correspondência cancelada.'; return; }
          result = await workflow.map(picked, ids, name, destination.value, mappingReason.value);
        } else if (name === 'copy') {
          if (!deps.confirm('Copiar ' + ids.length + ' linhas selecionadas para ' + admin._nomeOrg(picked.organization) + '? Destinos divergentes serão preservados e bloqueados.')) { status.textContent = 'Cópia cancelada.'; return; }
          result = await workflow.copy(picked, ids);
        } else if (name === 'validate') result = await workflow.validate(picked, ids);
        else fail('Etapa desconhecida.');
        renderProof();
        if (name === 'preview') status.textContent = 'Contagem e manifesto recebidos do servidor. Revise a evidência antes de registrar.';
        else if (name === 'bind') status.textContent = 'Declaração e vínculo conferidos na nuvem. A classificação foi liberada para este escopo.';
        else {
          const partial = Number(result.blocked || 0) + Number(result.failed || 0);
          status.textContent = partial ? 'Servidor confirmou o lote com ' + partial + ' bloqueio(s) ou falha(s). Confira os códigos de cada linha.' : 'Etapa confirmada pelo servidor.';
          admin._legacyResultado(partial ? 'Lote confirmado com pendências' : 'Etapa confirmada na nuvem', result);
          await admin.carregarResumoLegado(true); await admin.carregarItensLegado(admin._legacyOffset);
        }
      } catch (error) {
        renderProof(); status.textContent = String(error.message || 'Não houve confirmação do servidor.');
        admin._legacyErro(status.textContent);
      } finally { controls.forEach(button => { button.disabled = false; }); }
    }
    function button(parent, label, action) {
      const el = node('button', label); el.type = 'button'; el.className = 'btn btn-sm';
      el.addEventListener('click', () => { void act(action); }); parent.appendChild(el); controls.push(el);
    }
    button(buttons, '1. Conferir conta, clínica e manifesto', 'preview');
    button(buttons, '2. Registrar declaração revisada', 'bind');
    button(mapping, 'Vincular paciente confirmado', 'patient');
    button(mapping, 'Vincular atendimento confirmado', 'encounter');
    const invalidate = () => { workflow.reset(); reviewed.checked = false; renderProof(); status.textContent = 'Conta, clínica ou escopo mudou. Faça uma nova conferência.'; };
    ['prog-legado-user', 'prog-legado-org', 'prog-legado-scope'].forEach(id => {
      const input = doc.getElementById(id); if (input) input.addEventListener('change', invalidate);
    });
    const evidenceChanged = () => {
      workflow.invalidateEvidence(); renderProof();
      status.textContent = 'A declaração ou sua conferência mudou. Registre novamente a evidência revisada.';
    };
    [statement, reference].forEach(input => input.addEventListener('input', () => {
      reviewed.checked = false; evidenceChanged();
    }));
    reviewed.addEventListener('change', evidenceChanged);
    mounted = { workflow, act, invalidate };
    renderProof();
  }
  const clear = () => {
    if (mounted) mounted.invalidate();
    mounted = null;
    const host = root.document && root.document.getElementById('prog-legado-proveniencia');
    if (host) host.replaceChildren();
  };
  if (root.addEventListener) {
    root.addEventListener('medsys:auth-event', clear);
    root.addEventListener('pagehide', clear);
  }
  root.SoftLegacyProvenance = Object.freeze({ createWorkflow, mount, clear,
    perform: name => mounted ? mounted.act(name) : Promise.reject(new Error('Abra novamente a área Programador para conferir a proveniência.')) });
})(window);
