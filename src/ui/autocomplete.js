'use strict';

/* Autocomplete canônico da interface. Mantém o contrato global usado pelos
   handlers legados; identidade e caso continuam delegados ao linker. */
/* ============================================================================
   AUTOCOMPLETE — anexa autocomplete genérico a um input
============================================================================ */
const autocomplete = {
  /* attach(input, getList, onPick, onCreateNew?)
     - getList: função que retorna array de itens {value, label, meta?}
     - onPick: callback quando item é escolhido
     - onCreateNew (opcional): callback para "+ Novo paciente" */
  attach(input, getList, onPick, onCreateNew) {
    if (!input || input.dataset.acAttached) return;
    input.dataset.acAttached = '1';
    /* DUAS CAIXAS NO MESMO CAMPO, UMA POR CIMA DA OUTRA.
       O campo "procedimento cirúrgico" recebe as duas ligações: esta, do
       cadastro + histórico ("usado antes"), e a da tabela CBHPM. Cada uma se
       achava dona da tela e desenhava a sua lista no mesmo lugar. Acontecia em
       todo campo que é das duas coisas — não só na ficha.
       Agora quem desenha é UMA lista só, a da CBHPM, com as duas origens
       separadas por título. Este módulo passa a emprestar a sua lista e a sua
       escolha em vez de abrir caixa própria. */
    input._acLista = getList;
    input._acEscolher = onPick;
    input._acCriarNovo = onCreateNew;
    const wrap = document.createElement('div');
    wrap.className = 'autocomplete-wrap';
    input.parentNode.insertBefore(wrap, input);
    wrap.appendChild(input);
    const list = document.createElement('div');
    list.className = 'autocomplete-list';
    wrap.appendChild(list);

    let items = [];
    let activeIdx = -1;
    const renderList = () => {
      const q = (input.value || '').toLowerCase();
      const all = getList() || [];
      /* sem acento, sem ç, sem maiúscula: "joao" acha "João" */
      items = all.filter(it => q.length === 0 || utils.contem(it.label + ' ' + (it.meta || ''), q)).slice(0, 10);
      let html = items.map((it, i) => `
        <div class="autocomplete-item ${i === activeIdx ? 'active' : ''}" data-idx="${i}">
          <span>${utils.escapeHTML(it.label)}</span>
          ${it.meta ? `<span class="ac-meta">${utils.escapeHTML(it.meta)}</span>` : ''}
        </div>
      `).join('');
      if (onCreateNew && q.length >= 2) {
        html += `<div class="autocomplete-item create-new" data-idx="-1">+ Cadastrar novo "${utils.escapeHTML(input.value)}"</div>`;
      }
      list.innerHTML = html;
      /* Campo que também é CBHPM: quem mostra é a lista unificada de lá. */
      if (input._cbhpmLigado) { mostrar(false); try { cbhpm._abrir(input); } catch (e) {} return; }
      mostrar(items.length > 0 || (onCreateNew && q.length >= 2));
    };
    /* O CARTÃO RECORTAVA A LISTA.
       `.card` tem `overflow: hidden` (por causa do canto arredondado), e o
       dropdown é absoluto: passando da borda do cartão, ele era CORTADO — e o
       pedaço que sobrava ficava atrás dos campos do cartão seguinte, que
       roubavam o clique. Medido: lista de 8 nomes, 7 inalcançáveis.
       Enquanto a lista está aberta o cartão deixa de recortar; ao fechar,
       volta a recortar (senão o cabeçalho colorido vaza dos cantos). */
    const mostrar = (on) => {
      list.classList.toggle('show', !!on);
      const card = input.closest('.card');
      if (card) card.classList.toggle('ac-aberto', !!on);
    };
    const escolher = idx => {
      if (idx === -1 && onCreateNew) {
        mostrar(false);
        onCreateNew(input.value);
        return;
      }
      const it = items[idx];
      if (!it) return;
      input.value = it.label;
      mostrar(false);
      if (onPick) onPick(it);
      input.dispatchEvent(new Event('change'));
    };
    input.addEventListener('focus', () => { activeIdx = -1; renderList(); });
    input.addEventListener('input', () => { activeIdx = -1; renderList(); });
    input.addEventListener('keydown', e => {
      if (!list.classList.contains('show')) return;
      const cells = list.querySelectorAll('.autocomplete-item');
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        activeIdx = Math.min(cells.length - 1, activeIdx + 1);
        renderList();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        activeIdx = Math.max(-1, activeIdx - 1);
        renderList();
      } else if (e.key === 'Enter' && activeIdx >= 0) {
        e.preventDefault();
        const idx = parseInt(cells[activeIdx].dataset.idx);
        escolher(idx);
      } else if (e.key === 'Escape') {
        mostrar(false);
      }
    });
    list.addEventListener('mousedown', e => {
      const cell = e.target.closest('.autocomplete-item');
      if (!cell) return;
      e.preventDefault();
      escolher(parseInt(cell.dataset.idx));
    });
    document.addEventListener('click', e => {
      if (!wrap.contains(e.target)) mostrar(false);
    });
  },

  /* Todo mundo que este aparelho já conhece como paciente.

     Só o cadastro central não basta: nada registra o paciente lá
     automaticamente, então quem só tem ficha, pré ou consulta não aparecia na
     lista — e a pessoa que atendeu ontem parecia não existir. Aqui o cadastro
     vem primeiro (é o registro completo) e os nomes vistos nos módulos
     clínicos completam, sem repetir. */
  _MODS_NOME: ['anestesia', 'pre', 'consulta', 'recuperacao', 'termo', 'prescricao', 'documentos', 'risco'],
  _modPorForm(formId) {
    return {
      'form-anestesia': 'anestesia', 'form-pre': 'pre',
      'form-consulta': 'consulta', 'form-recuperacao': 'recuperacao',
      'form-documentos': 'documentos', 'form-prescricao': 'prescricao',
      'form-termo': 'termo', 'form-risco': 'risco',
      'form-orcamento': 'orcamento', 'form-financeiro': 'financeiro',
      'form-agenda': 'agenda'
    }[formId] || '';
  },
  listaPacientes() {
    const norm = s => { try { return linker._normNome(s); } catch (e) { return String(s || '').toLowerCase().trim(); } };
    const mapa = new Map();
    const detalhe = (identidade, extras) => {
      const meta = [];
      if (identidade.nasc) {
        try { meta.push(new Date(identidade.nasc + 'T00:00:00').toLocaleDateString('pt-BR')); }
        catch (e) { meta.push(identidade.nasc); }
      }
      if (window.SoftEncounterIdentity.validCpf(identidade.cpf)) meta.push('CPF •••' + identidade.cpf.slice(-4));
      return meta.concat(extras || []).filter(Boolean).join(' · ');
    };
    try {
      pacientes.list().forEach(p => {
        const nomeNormal = norm(p.nome);
        if (!nomeNormal) return;
        const identidade = window.SoftEncounterIdentity.fromRecord(p);
        const identityKey = p._patientKey || window.SoftEncounterIdentity.strongPatientKey(identidade) || '';
        const patientRef = p._id || p._patientRef || '';
        const k = identityKey ? 'forte:' + identityKey
          : patientRef ? 'ref:' + patientRef : 'fraca:' + nomeNormal;
        mapa.set(k, {
          value: patientRef, label: p.nome,
          meta: detalhe(identidade, [p.plano || p.convenio, p.carteirinha]),
          identityKey, patientRef,
          data: Object.assign({}, p, { _patientKey: identityKey, _patientRef: patientRef })
        });
      });
    } catch (e) {}
    /* conhecidos só pelos registros clínicos */
    const ROT = { anestesia: 'ficha', pre: 'pré-anestésica', consulta: 'consulta',
                  recuperacao: 'SRPA', termo: 'termo', prescricao: 'receituário',
                  documentos: 'documento', risco: 'risco' };
    autocomplete._MODS_NOME.forEach(mod => {
      let lst = [];
      try { lst = store.list(mod) || []; } catch (e) { return; }
      lst.forEach(it => {
        const nome = (it.paciente && it.paciente.nome) || it.paciente_nome || it.nome ||
                     (typeof it.paciente === 'string' ? it.paciente : '');
        const nomeNormal = norm(nome);
        if (!nomeNormal) return;
        const identidade = window.SoftEncounterIdentity.fromRecord(it);
        const identityKey = it._patientKey || window.SoftEncounterIdentity.strongPatientKey(identidade) || '';
        const patientRef = it._patientRef || '';
        const k = identityKey ? 'forte:' + identityKey
          : patientRef ? 'ref:' + patientRef : 'fraca:' + nomeNormal;
        if (mapa.has(k)) return;
        if (!identityKey && !patientRef && Array.from(mapa.values()).some(x => norm(x.label) === nomeNormal && (x.identityKey || x.patientRef))) return;
        const pac = (it.paciente && typeof it.paciente === 'object') ? it.paciente : it;
        mapa.set(k, {
          value: '', label: nome,
          meta: detalhe(identidade, [pac.convenio || pac.plano, 'de ' + (ROT[mod] || mod)]),
          identityKey, patientRef,
          /* sem _id: não é registro do cadastro, e gravar esse id no vínculo
             apontaria para o documento, não para o paciente */
          data: { nome, sexo: pac.sexo, nascimento: pac.nascimento || pac.nasc,
                  cpf: pac.cpf,
                  plano: pac.convenio || pac.plano, carteirinha: pac.carteirinha,
                  prontuario: pac.prontuario, _semCadastro: true,
                  _patientKey: identityKey, _patientRef: patientRef }
        });
      });
    });
    return Array.from(mapa.values());
  },

  /* Configurações por campo */
  attachPacientes(input, formId) {
    const mod = autocomplete._modPorForm(formId);
    if (!input.dataset.patientIdentityWatch) {
      input.dataset.patientIdentityWatch = '1';
      input.addEventListener('input', () => {
        const selecionado = input.dataset.patientSelectedName || '';
        if (selecionado && linker._normNome(selecionado) !== linker._normNome(input.value)) {
          try { linker.limparContextoPaciente(mod); } catch (e) {}
        }
      });
    }
    autocomplete.attach(
      input,
      () => autocomplete.listaPacientes(),
      (it) => autocomplete._aplicarPaciente(formId, it.data),
      (textoAtual) => {
        pacientes.modalNovoPaciente({ nome: textoAtual }, (saved) => {
          autocomplete._aplicarPaciente(formId, saved);
        });
      }
    );
  },
  /* Aplica paciente selecionado em um form */
  /* O QUE O CADASTRO TEM E O FORMULÁRIO PEDE.
     Escolher o paciente preenchia uma lista CURTA e escrita à mão, diferente
     em cada módulo: a ficha levava seis campos, todos os outros levavam três.
     Nascimento, CPF, telefone, endereço, carteirinha, filiação, responsável
     legal e acomodação ficavam para trás — gravados no cadastro e redigitados
     a cada documento, que é como o mesmo paciente acaba com dois endereços e
     duas datas de nascimento.
     Aqui a regra é uma só, para todos os módulos: para cada dado do cadastro,
     procura-se no formulário o campo que o recebe, pelos nomes que os módulos
     de fato usam. Campo que o módulo não tem é ignorado; campo já preenchido
     NUNCA é sobrescrito — o que está na tela é do usuário. */
  _CAMPOS_DO_CADASTRO: [
    ['nascimento', ['nascimento', 'paciente_nasc', 'data_nascimento', 'nasc']],
    ['sexo', ['sexo', 'paciente_sexo']],
    ['peso', ['peso', 'paciente_peso']],
    ['altura', ['altura', 'paciente_altura']],
    ['cpf', ['cpf', 'paciente_cpf']],
    ['rg', ['rg', 'paciente_rg']],
    ['prontuario', ['prontuario', 'paciente_prontuario']],
    ['convenio', ['convenio', 'paciente_convenio', 'plano']],
    ['carteirinha', ['carteirinha', 'paciente_carteirinha', 'matricula']],
    ['telefone', ['telefone', 'paciente_telefone', 'celular']],
    ['email', ['email', 'paciente_email']],
    ['endereco', ['endereco', 'paciente_endereco']],
    ['nome_mae', ['nome_mae', 'paciente_mae', 'mae']],
    ['nome_pai', ['nome_pai', 'paciente_pai', 'pai']],
    ['responsavel_legal', ['responsavel_legal', 'responsavel_nome']],
    ['responsavel_parentesco', ['responsavel_parentesco', 'parentesco']],
    ['acomodacao', ['acomodacao', 'paciente_acomodacao']]
  ],
  _valorDoPaciente(p, campo) {
    if (!p) return '';
    if (campo === 'convenio') return p.plano || p.convenio || '';
    if (campo === 'carteirinha') return p.carteirinha || p.matricula || '';
    if (campo === 'nascimento') return p.nascimento || p.nasc || '';
    if (campo === 'acomodacao') {
      try { return linker._acomodacaoDoCadastro(p) || p.acomodacao || ''; }
      catch (e) { return p.acomodacao || ''; }
    }
    const v = p[campo];
    return (v === undefined || v === null) ? '' : v;
  },
  _preencherDoPaciente(f, p) {
    if (!f || !p) return 0;
    let n = 0;
    autocomplete._CAMPOS_DO_CADASTRO.forEach(([campo, nomes]) => {
      const v = autocomplete._valorDoPaciente(p, campo);
      if (v === '' || v == null) return;
      for (const nome of nomes) {
        const el = f.querySelector('[name="' + nome + '"]');
        if (!el) continue;
        if (el.value) return;            /* o que está na tela é dele */
        if (!autocomplete._definirValor(el, v)) continue;
        n++;
        return;
      }
    });
    return n;
  },
  /* O CAMPO RECUSAVA CALADO.
     Campo de data só aceita aaaa-mm-dd: um nascimento guardado "15/03/1980"
     virava campo vazio, sem erro. Lista fechada só aceita uma das opções: um
     plano "Unimed Vitória" virava "—". Aqui o valor é convertido para o que o
     campo entende, e na lista fechada que não tem a opção ela é acrescentada.
     Devolve se o valor de fato ficou no campo. */
  _definirValor(el, v) {
    let val = String(v == null ? '' : v).trim();
    if (!val) return false;
    if (el.type === 'date') {
      const br = val.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
      if (br) val = br[3] + '-' + br[2].padStart(2, '0') + '-' + br[1].padStart(2, '0');
      else if (/^\d{4}-\d{2}-\d{2}/.test(val)) val = val.slice(0, 10);
    }
    if (el.tagName === 'SELECT') {
      const norm = x => String(x || '').trim().toLowerCase();
      const op = Array.from(el.options).find(o => norm(o.value) === norm(val) || norm(o.text) === norm(val));
      if (op) val = op.value;
      else { const o = document.createElement('option'); o.value = val; o.textContent = val; el.appendChild(o); }
    }
    el.value = val;
    if (String(el.value) !== val) return false;
    try { el.dispatchEvent(new Event('input', { bubbles: true })); } catch (e) {}
    try { el.dispatchEvent(new Event('change', { bubbles: true })); } catch (e) {}
    return true;
  },
  _aplicarPaciente(formId, p) {
    if (!p) return;
    const f = document.getElementById(formId);
    if (!f) return;
    const MOD = autocomplete._modPorForm(formId);
    const campoNome = f.querySelector('[name="nome"]') || f.querySelector('[name="paciente"]')
                   || f.querySelector('[name="paciente_nome"]');
    const identityKey = p._patientKey || linker._chavePaciente(p) || '';
    const patientRef = p._patientRef || ((p._id && !p._semCadastro) ? p._id : '');
    if (MOD) {
      const atual = linker.contextoPaciente(MOD);
      const mesmaIdentidade = !!(identityKey && atual.identityKey === identityKey);
      const mesmaReferencia = !!(patientRef && atual.patientRef === patientRef);
      if (!mesmaIdentidade && !mesmaReferencia) linker.limparContextoPaciente(MOD);
      linker.aplicarContextoPaciente(MOD, p, { identityKey, patientRef });
    }
    if (campoNome) {
      campoNome.dataset.patientSelectedName = p.nome || '';
      campoNome.dataset.patientKey = identityKey;
    }
    const guardarCadastro = () => {
      let h = f.querySelector('[name="_paciente_id"]');
      if (!h && patientRef) {
        h = document.createElement('input'); h.type = 'hidden'; h.name = '_paciente_id'; f.appendChild(h);
      }
      if (h) h.value = patientRef;
    };
    if (formId === 'form-agenda') {
      /* Agenda: campos paciente + convenio */
      const setIfEmpty = (n, v) => { const el = f.querySelector(`[name="${n}"]`); if (el && !el.value && v) el.value = v; };
      f.querySelector('[name="paciente"]').value = p.nome || '';
      setIfEmpty('convenio', p.plano || p.convenio);
      /* Guarda _id do paciente para vínculo */
      guardarCadastro();
      return;
    }
    if (formId === 'form-anestesia') {
      f.querySelector('[name="paciente_nome"]').value = p.nome || '';
      autocomplete._preencherDoPaciente(f, p);
      anestesia.calc.idade();
      /* Guarda _id do paciente para vínculo futuro */
      guardarCadastro();
    } else {
      /* todos os demais: pré, consulta, SRPA, termo, receituário, risco,
         documentos, orçamento e financeiro. O campo do nome não se chama
         igual em todos — supor "nome" deixava orçamento e financeiro de fora
         e quebrava calado. */
      const setIfEmpty = (n, v) => { const el = f.querySelector(`[name="${n}"]`); if (el && !el.value && v) el.value = v; };
      if (!campoNome) return;
      campoNome.value = p.nome || '';
      autocomplete._preencherDoPaciente(f, p);
      const nascimento = p.nascimento || p.nasc;
      if (nascimento && f.querySelector('[name="idade"]')) {
        const d = new Date(nascimento);
        if (!isNaN(d)) {
          const hoje = new Date();
          let anos = hoje.getFullYear() - d.getFullYear();
          const m = hoje.getMonth() - d.getMonth();
          if (m < 0 || (m === 0 && hoje.getDate() < d.getDate())) anos--;
          if (anos >= 0) setIfEmpty('idade', anos + ' anos');
        }
      }
      /* Paciente conhecido só por um registro clínico não tem id de cadastro:
         gravar o id do DOCUMENTO aqui criaria um vínculo para a coisa errada. */
      guardarCadastro();
    }
    toast('Paciente "' + p.nome + '" carregado');
    /* AQUI ESTAVA A FALHA DA IMPORTAÇÃO DA PRÉ: escolher o paciente na lista
       preenchia só os campos do cadastro. Quem chama o linker é o onblur do
       campo de nome — e o clique na sugestão dá preventDefault no mousedown,
       de propósito, para não fechar a lista: o campo NÃO perde o foco e o
       onblur não dispara. A pré só entraria se o médico depois clicasse em
       outro campo; indo direto para salvar, imprimir ou outro módulo, não
       entrava nunca. Agora a importação roda na hora da escolha. */
    try {
      if (MOD && p.nome) {
        const opts = { patient: p, identityKey, patientRef };
        linker.autoPreencherDadosPaciente(p.nome, MOD, opts);
        if (MOD === 'anestesia') linker.importarPreParaAnestesia(p.nome, opts);
        try { rascunhos.renomearAba(MOD); } catch (e) {}
      }
    } catch (e) {}
  },
  /* Anexa autocomplete simples baseado em uma categoria de cadastro */
  attachSimples(input, catKey) {
    const fieldName = input.getAttribute('name');
    autocomplete.attach(
      input,
      () => {
        const cadastros = ajustes.list(catKey).map(x => ({
          value: x._id, label: x.nome,
          meta: [x.crm, x.especialidade, x.codigo, x.porte].filter(Boolean).join(' · '),
          data: x
        }));
        /* Acrescenta valores já digitados antes neste campo (histórico que cresce
           sozinho), sem repetir os que já estão no cadastro. */
        let hist = [];
        try {
          if (fieldName && typeof histAutocomplete !== 'undefined') {
            /* "Unimed", "UNIMED" e "Unimed " são um nome só: fica a grafia mais usada */
            const jaTem = new Set(cadastros.map(c => utils.semAcento(c.label)));
            hist = utils.grafiasUnicas(histAutocomplete._coletar(fieldName))
              .filter(v => !jaTem.has(utils.semAcento(v)))
              .map(v => ({ value: v, label: v, meta: 'usado antes' }));
          }
        } catch (e) {}
        /* convênio: os planos de sempre continuam sugeridos, como na lista antiga */
        const padrao = catKey === 'cad_convenios'
          ? ['Particular', 'SUS', 'Unimed', 'Bradesco Saúde', 'Amil', 'SulAmérica', 'Notredame Intermédica', 'Hapvida']
            .filter(v => !cadastros.concat(hist).some(c => utils.semAcento(c.label) === utils.semAcento(v)))
            .map(v => ({ value: v, label: v, meta: '' }))
          : [];
        return [...cadastros, ...hist, ...padrao];
      },
      (it) => { input.value = it.label; }
    );
  },
  /* Liga autocompletes a todos os campos relevantes do sistema */
  ligarTudo() {
    /* Pacientes — campos de nome */
    const inpNomeAnest = document.querySelector('#form-anestesia [name="paciente_nome"]');
    if (inpNomeAnest) autocomplete.attachPacientes(inpNomeAnest, 'form-anestesia');
    const inpNomePre = document.querySelector('#form-pre [name="nome"]');
    if (inpNomePre) autocomplete.attachPacientes(inpNomePre, 'form-pre');
    const inpNomeCons = document.querySelector('#form-consulta [name="nome"]');
    if (inpNomeCons) autocomplete.attachPacientes(inpNomeCons, 'form-consulta');
    const inpNomeRec = document.querySelector('#form-recuperacao [name="nome"]');
    if (inpNomeRec) autocomplete.attachPacientes(inpNomeRec, 'form-recuperacao');
    /* Agenda também tem campo paciente — autocomplete + auto-preenchimento */
    const inpNomeAg = document.querySelector('#form-agenda [name="paciente"]');
    if (inpNomeAg) autocomplete.attachPacientes(inpNomeAg, 'form-agenda');
    /* Documentos (atestado, declaração, laudo), receituário, termo e risco
       ficaram de fora desta lista quando ela foi escrita — e são justamente os
       que se faz DEPOIS, para um paciente que já existe. Quem ia emitir um
       atestado digitava o nome inteiro e o sistema agia como se não a
       conhecesse. */
    /* A lista completa dos formulários com campo de paciente. Orçamento e
       Financeiro ficaram de fora por último — e são os dois em que redigitar o
       nome custa mais caro: nome digitado diferente do cadastro é registro que
       não aparece no histórico daquele paciente nem casa com a cobrança. */
    [['#form-documentos [name="nome"]', 'form-documentos'],
     ['#form-prescricao [name="nome"]', 'form-prescricao'],
     ['#form-termo [name="nome"]', 'form-termo'],
     ['#form-risco [name="nome"]', 'form-risco'],
     ['#form-orcamento [name="paciente"]', 'form-orcamento'],
     ['#form-financeiro [name="paciente"]', 'form-financeiro']
    ].forEach(([sel, formId]) => {
      const el = document.querySelector(sel);
      if (el) autocomplete.attachPacientes(el, formId);
    });

    /* Cirurgião */
    document.querySelectorAll('[name="cirurgiao"], [name="cirurgiao2"]').forEach(el => autocomplete.attachSimples(el, 'cad_cirurgioes'));
    /* Hospital/clínica */
    document.querySelectorAll('[name="hospital"], [name="local_hospital"], [name="local"]').forEach(el => autocomplete.attachSimples(el, 'cad_clinicas'));
    /* Helper unificado: ao escolher profissional do autocomplete, preenche CRM e _profissional_id */
    const aplicarProfissional = (inputEl, profissional) => {
      if (!profissional) return;
      inputEl.value = profissional.nome || '';
      const f = inputEl.closest('form');
      if (!f) return;
      /* CRM */
      const crmEl = f.querySelector('[name="crm"]') || f.querySelector('[name="registro"]');
      if (crmEl && !crmEl.value && profissional.crm) crmEl.value = profissional.crm;
      /* _profissional_id (hidden) — usado na impressão para puxar o carimbo */
      let hidden = f.querySelector('[name="_profissional_id"]');
      if (!hidden) {
        hidden = document.createElement('input');
        hidden.type = 'hidden';
        hidden.name = '_profissional_id';
        f.appendChild(hidden);
      }
      hidden.value = profissional._id || '';
      /* Toast informativo se há carimbo */
      if (profissional.carimbo) {
        toast('✓ ' + profissional.nome + ' (com carimbo)', 'success');
      }
    };

    /* Anestesiologista */
    document.querySelectorAll('[name="anestesiologista"], [name="anestesiologista2"]').forEach(el => {
      autocomplete.attach(
        el,
        () => ajustes.list('cad_anestesistas').map(x => ({
          value: x._id, label: x.nome,
          meta: (x.crm ? utils.rotuloCrm(x.crm) : '') + (x.rqe ? ' · RQE ' + x.rqe : '') + (x.carimbo ? ' · ✓ carimbo' : ''),
          data: x
        })),
        (it) => aplicarProfissional(el, it.data)
      );
    });
    /* Profissional (consulta) — sugere de anestesistas + cirurgiões */
    document.querySelectorAll('[name="profissional"]').forEach(el => {
      autocomplete.attach(
        el,
        () => {
          const an = ajustes.list('cad_anestesistas').map(x => ({
            value: x._id, label: x.nome,
            meta: 'Anestesista' + (x.crm ? ' · CRM ' + x.crm : '') + (x.carimbo ? ' · ✓ carimbo' : ''),
            data: x
          }));
          const ci = ajustes.list('cad_cirurgioes').map(x => ({
            value: x._id, label: x.nome,
            meta: 'Cirurgião' + (x.especialidade ? ' · ' + x.especialidade : '') + (x.crm ? ' · CRM ' + x.crm : '') + (x.carimbo ? ' · ✓ carimbo' : ''),
            data: x
          }));
          /* A mesma pessoa pode estar nas duas vistas (anestesista e
             cirurgião). Repetida, vira duas linhas iguais na tela. */
          return autocomplete._umaPessoaUmaLinha([...an, ...ci]);
        },
        (it) => aplicarProfissional(el, it.data)
      );
    });
    /* Responsável (recuperação) — sugere de anestesistas */
    document.querySelectorAll('[name="responsavel"]').forEach(el => {
      autocomplete.attach(
        el,
        () => autocomplete._umaPessoaUmaLinha(ajustes.list('cad_anestesistas').map(x => ({
          value: x._id, label: x.nome,
          meta: (x.crm ? utils.rotuloCrm(x.crm) : '') + (x.carimbo ? ' · ✓ carimbo' : ''),
          data: x
        }))),
        (it) => aplicarProfissional(el, it.data)
      );
    });
    /* Procedimento */
    document.querySelectorAll('[name="procedimento"], [name="cirurgia"]').forEach(el => autocomplete.attachSimples(el, 'cad_procedimentos'));
    /* Convênio (textbox livre em alguns lugares) */
    document.querySelectorAll('[name="convenio"], [name="paciente_convenio"]').forEach(el => {
      if (el.tagName === 'INPUT') autocomplete.attachSimples(el, 'cad_convenios');
    });
  },

  /* UMA PESSOA, UMA LINHA — por quem a pessoa é, não por qual cadastro é.
     Nome normalizado + registro definem a pessoa. Entre repetições fica a
     ficha mais completa, porque é dela que sai o carimbo: primeiro quem tem
     carimbo, depois quem está marcado como "meu perfil", depois quem tem CRM.
     Usada por todos os seletores de profissional, para que a mesma pessoa não
     apareça duas vezes num lugar e uma noutro. */
  _umaPessoaUmaLinha(itens) {
    const norm = s => {
      try { return linker._normNome(s); }
      catch (e) { return String(s || '').trim().toLowerCase(); }
    };
    const peso = (x) => {
      const d = (x && x.data) || {};
      return (d.carimbo ? 4 : 0) +
        ((d.responsavel === true || d.responsavel === 'true') ? 2 : 0) +
        (d.crm ? 1 : 0);
    };
    const porPessoa = new Map();
    (itens || []).forEach(x => {
      if (!x || !x.label) return;
      const d = x.data || {};
      const chave = norm(x.label) + '|' + String(d.crm || '').replace(/\D+/g, '');
      const anterior = porPessoa.get(chave);
      if (!anterior || peso(x) > peso(anterior)) porPessoa.set(chave, x);
    });
    return [...porPessoa.values()];
  },

  /* Liga autocomplete de profissional a UM input específico (usado nos blocos de
     assinatura inseridos dinamicamente). Sugere de anestesistas + cirurgiões + perfil. */
  ligarProfissionalEm(el) {
    if (!el || el.dataset.profAuto) return;
    el.dataset.profAuto = '1';
    const aplicar = (inputEl, prof) => {
      if (!prof) return;
      inputEl.value = prof.nome || prof.nomeProfissional || '';
      const f = inputEl.closest('form');
      if (!f) return;
      const crmEl = f.querySelector('[name="crm"]') || f.querySelector('[name="registro"]') || f.querySelector('[name="crm2"]');
      if (crmEl && !crmEl.value && prof.crm) crmEl.value = prof.crm;
      let hidden = f.querySelector('[name="_profissional_id"]');
      if (hidden && prof._id) hidden.value = prof._id;
      /* aplica carimbo automaticamente pelo nome */
      try {
        const pref = el.closest('[id$="-body"]') ? el.closest('[id$="-body"]').id.replace('-body', '') : null;
        if (pref) assinatura.aplicarCarimboPorNome(pref, prof.nome || prof.nomeProfissional, f.id);
      } catch (e) {}
      if (prof.carimbo) toast('✓ ' + (prof.nome || prof.nomeProfissional) + ' (com carimbo)', 'success');
    };
    autocomplete.attach(
      el,
      () => {
        /* UMA PESSOA, UMA LINHA. As três listas viraram vistas sobre o mesmo
           cadastro, e quem é o responsável E anestesiologista aparecia duas
           vezes — mesmo nome, mesmo CRM, escolhas idênticas. Antes eram
           cadastros separados e a repetição não existia; foi a unificação que
           a criou. A lista sai do cadastro único, e as vistas só entram
           enquanto ele estiver vazio (aparelho ainda não migrado). */
        const daLista = (x) => {
          const nome = x.nomeProfissional || x.nome;
          const partes = [];
          if (x.responsavel === true || x.responsavel === 'true') partes.push('Meu perfil');
          if (x.especialidade) partes.push(x.especialidade);
          if (x.crm) partes.push(utils.rotuloCrm(x.crm));
          if (x.carimbo) partes.push('✓ carimbo');
          return { value: x._id, label: nome, meta: partes.join(' · '), data: Object.assign({}, x, { nome }) };
        };
        const unico = ajustes.list('cad_profissionais');
        let itens;
        if (unico.length) itens = unico.map(daLista);
        else {
          itens = [].concat(
            ajustes.list('cad_assinaturas').map(daLista),
            ajustes.list('cad_anestesistas').map(daLista),
            ajustes.list('cad_cirurgioes').map(daLista));
        }
        /* A REDE DE SEGURANÇA ESTAVA PRESA NA CHAVE ERRADA.
           Ela deduplicava por `_id` — e o problema é exatamente dois CADASTROS
           com ids diferentes para a MESMA pessoa, herdados da unificação das
           três listas antigas. Por id, os dois são distintos; para quem olha a
           tela, são a mesma linha repetida: mesmo nome, mesmo CRM, mesmo
           carimbo. Escolher entre eles não é escolha nenhuma, e ainda deixa o
           carimbo dependendo de qual dos dois a pessoa acertou.
           A identidade de um profissional é o nome (sem acento e sem caixa)
           mais o registro. Havendo repetição, fica a ficha mais completa: a
           que tem carimbo, e entre essas a marcada como "meu perfil" — é a que
           carrega a assinatura que vai sair no papel. */
        return autocomplete._umaPessoaUmaLinha(itens);
      },
      (it) => aplicar(el, it.data)
    );
  }
};

/* FIM DO AUTOCOMPLETE DE APRESENTAÇÃO */
