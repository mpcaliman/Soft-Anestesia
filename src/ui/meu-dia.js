'use strict';

/* Painel operacional de leitura. A coleta não grava prontuários; ações
   explícitas continuam delegadas aos módulos clínico e financeiro. */
/* ============================================================================
   MEU DIA — visão do plantão: cruza agenda, fichas de anestesia, SRPA e
   financeiro DE HOJE pelo caso explícito. Nome é só rótulo; nunca é usado
   para unir homônimos. Cada linha mostra o estado das etapas e abre com um toque.
   Read-only sobre os dados — não cria nem altera nada sozinho.
============================================================================ */
const meuDia = {
  _norm(s) { return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim(); },

  _patientToken(item) {
    if (!item) return '';
    const forte = linker._chavePaciente(item);
    if (forte) return 'forte:' + forte;
    const ref = item._patientRef || item._paciente_id || '';
    return ref ? 'ref:' + ref : '';
  },

  _origemFinanceira(item) {
    if (!item || !item._origemId) return null;
    const mods = ['anestesia','pre','consulta','recuperacao'];
    const ordem = mods.indexOf(item._origemTipo) >= 0
      ? [item._origemTipo].concat(mods.filter(m => m !== item._origemTipo))
      : mods;
    for (const mod of ordem) {
      const doc = store.getById(mod, item._origemId);
      if (doc) return { mod, doc };
    }
    return null;
  },

  _caseToken(mod, item) {
    if (!item) return '';
    /* Uma cobrança acompanha exatamente o documento que a originou, inclusive
       registros criados antes de _caseId existir. */
    if (mod === 'financeiro' && item._origemId) {
      const origem = meuDia._origemFinanceira(item);
      if (origem) return meuDia._caseToken(origem.mod, origem.doc);
      const tipo = item._origemTipo || 'documento';
      return 'origem:' + tipo + ':' + item._origemId + '|' + (meuDia._patientToken(item) || 'sem-identidade');
    }
    const paciente = meuDia._patientToken(item) || 'sem-identidade';
    if (item._caseId) return 'caso:' + item._caseId + '|' + paciente;
    if (item._caseKey) return 'chave:' + item._caseKey;
    /* Registro legado sem vínculo fica isolado. A coincidência de nome/data
       pode ser um homônimo e não cria relação automática. */
    return item._id ? 'registro:' + mod + ':' + item._id : '';
  },

  coletar() {
    const hoje = utils.hojeISO();
    const casos = {};   /* token explícito do caso → linha */
    let semId = 0;
    const caso = (nome, item, mod) => {
      if (!meuDia._norm(nome)) return null;
      const k = meuDia._caseToken(mod, item) || ('isolado:' + mod + ':' + (++semId));
      if (!casos[k]) casos[k] = { nome, _caseToken: k, hora: '', procedimento: '', agenda: null, ficha: null, srpa: null, fin: null, fins: [], consulta: null, pre: null };
      return casos[k];
    };
    /* Data e nome saem dos MESMOS auxiliares que o resto do sistema usa
       (historico._dataItem / arquivo._nomeDe). Ler campo a campo aqui foi o
       que fez a pré-anestésica ficar de fora e a ficha aparecer sem nome: cada
       módulo grava com um formato, e a lista escrita à mão sempre atrasa. */
    const dataDe = (x) => { try { return String(historico._dataItem(x) || '').slice(0, 10); } catch (e) { return ''; } };
    const nomeDe = (x) => { try { const n = arquivo._nomeDe(x); return n === '(sem nome)' ? '' : n; } catch (e) { return ''; } };
    store.list('agenda').filter(x => x.data === hoje).forEach(x => {
      const c = caso(x.paciente, x, 'agenda'); if (!c) return;
      c.agenda = x;
      if (!c.hora) c.hora = x.hora || '';
      if (!c.procedimento) c.procedimento = x.procedimento || x.tipo || '';
    });
    /* A ficha é salva ESTRUTURADA ({paciente:{nome}, procedimento:{data,…}}).
       Ler os campos rasos aqui fazia a ficha NUNCA aparecer no Meu dia: o caso
       constava só pela SRPA (que é rasa) e o chip ficava em "— ficha". */
    store.list('anestesia').forEach(x => {
      const pr = (x.procedimento && typeof x.procedimento === 'object') ? x.procedimento : {};
      if (dataDe(x) !== hoje) return;
      const c = caso(nomeDe(x), x, 'anestesia'); if (!c) return;
      c.ficha = x;
      if (!c.hora) c.hora = pr.hora_sala_entrada || pr.hora_inicio || x.hora_sala_entrada || x.hora_inicio || '';
      if (!c.procedimento) c.procedimento = pr.descricao || (typeof x.procedimento === 'string' ? x.procedimento : '') || '';
    });
    /* CONSULTA. Estava fora, e era o buraco: uma consulta de hoje só chegava
       aqui se já tivesse virado lançamento financeiro — e chegava como caso
       "sem ficha", cobrando uma ficha de anestesia que consulta nenhuma tem.
       Quem atende no consultório via o dia inteiro acusado de pendência. */
    store.list('consulta').forEach(x => {
      if (dataDe(x) !== hoje) return;
      const c = caso(nomeDe(x), x, 'consulta'); if (!c) return;
      c.consulta = x;
      if (!c.hora) c.hora = x.hora || '';
      if (!c.procedimento) c.procedimento = x.motivo || (typeof x.procedimento === 'string' ? x.procedimento : '') || 'Consulta';
    });
    /* PRÉ-ANESTÉSICA. Faltava — e para quem avalia no consultório é o dia
       inteiro. A pré não aparecia em lugar nenhum do "Meu dia": o caso só
       existia se ela já tivesse virado lançamento financeiro, e chegava aí
       como um caso anônimo cobrando ficha de anestesia e SRPA que uma
       avaliação pré-anestésica nunca vai ter. */
    store.list('pre').forEach(x => {
      if (dataDe(x) !== hoje) return;
      const c = caso(nomeDe(x), x, 'pre'); if (!c) return;
      c.pre = x;
      if (!c.hora) c.hora = x.hora || '';
      if (!c.procedimento) c.procedimento = x.cirurgia || x.procedimento_proposto || 'Avaliação pré-anestésica';
    });
    store.list('recuperacao').forEach(x => {
      if (dataDe(x) !== hoje) return;
      const c = caso(nomeDe(x), x, 'recuperacao'); if (!c) return;
      c.srpa = x;
      if (!c.procedimento) c.procedimento = x.procedimento || '';
    });
    store.list('financeiro').filter(x => x.data_proc === hoje).forEach(x => {
      const c = caso(x.paciente, x, 'financeiro'); if (!c) return;
      /* UM ATENDIMENTO PODE TER VÁRIAS LINHAS de cobrança (procedimentos
         extras da ficha, procedimentos feitos na consulta). Guardar só a
         última escondia os demais códigos — e é o conjunto deles que responde
         "o que foi executado". O principal segue sendo o da linha-mãe. */
      c.fins.push(x);
      if (!c.fin || (x._origemLinhaId === '' && c.fin._origemLinhaId !== '')) c.fin = x;
      if (!c.procedimento) c.procedimento = x.procedimento || '';
    });
    return Object.values(casos).sort((a, b) => (a.hora || '99:99').localeCompare(b.hora || '99:99'));
  },

  /* O CÓDIGO DO QUE FOI EXECUTADO, na linha do paciente.

     Olhar o plantão e não saber sob qual código cada atendimento está sendo
     cobrado é o que faz a conferência virar uma segunda passada por todos os
     registros. Duas fontes, nesta ordem:

     1) há lançamento → o código DELE, que é o que vai ser cobrado de fato;
     2) não há → o que SERIA cobrado, pela mesmíssima função que gera a
        cobrança (`fin.linhasDe`), marcado como `previsto`. Usar outra regra
        aqui criaria uma segunda verdade sobre cobrança, que é exatamente o
        tipo de divergência que ninguém descobre a tempo. */
  _codigos(c) {
    const vistos = new Set();
    const out = [];
    const add = (cod, desc, previsto) => {
      const k = String(cod || '').trim();
      if (!k || vistos.has(k)) return;
      vistos.add(k);
      out.push({ codigo: k, descricao: desc || '', previsto: !!previsto });
    };
    const fins = (c.fins && c.fins.length) ? c.fins : (c.fin ? [c.fin] : []);
    fins.forEach(f => add(f.cbhpm_codigo, f.cbhpm_descricao || f.procedimento, false));
    if (out.length) return out;
    const fonte = c.ficha ? ['anestesia', c.ficha]
                : c.pre ? ['pre', c.pre]
                : c.consulta ? ['consulta', c.consulta] : null;
    if (!fonte) return out;
    let linhas = [];
    try { linhas = fin.linhasDe(fonte[0], fonte[1]) || []; } catch (e) { linhas = []; }
    linhas.forEach(l => add(l.cbhpm_codigo, l.cbhpm_descricao, true));
    return out;
  },
  _linhaCodigos(c) {
    const cods = meuDia._codigos(c);
    if (!cods.length) return '';
    const E = utils.escapeHTML, A = utils.escapeAttr;
    return '<span class="md-cods">' + cods.map(x =>
      '<span class="md-cod' + (x.previsto ? ' md-cod-prev' : '') + '" title="' +
      A((x.descricao || 'Sem descrição') + (x.previsto
        ? ' — PREVISTO: este código ainda não virou lançamento financeiro'
        : ' — já lançado no financeiro')) + '">🏷 ' + E(x.codigo) +
      (x.descricao ? ' <span class="md-cod-d">' + E(x.descricao) + '</span>' : '') +
      (x.previsto ? ' <span class="md-cod-p">previsto</span>' : '') + '</span>').join('') + '</span>';
  },

  /* Chips de etapa: cor/ação conforme o estado */
  /* Consulta é atendimento completo por si: tem o próprio estado, e não
     precisa de ficha de anestesia nem de SRPA. */
  /* Atendimento CLÍNICO — consulta ou pré-anestésica — é completo por si:
     tem o próprio estado e não deve ficha de anestesia nem SRPA.

     A regra antiga era `tem consulta E não tem agenda`: bastava o atendimento
     estar agendado, ou ter virado lançamento no financeiro sem o documento
     clínico ter sido lido aqui, para ele voltar a ser cobrado de ficha e de
     SRPA. Agora a pergunta é a certa — há alguma evidência de que isto é um
     caso cirúrgico? — e a resposta vem de quem sabe: a ficha, a SRPA, o tipo
     do compromisso na agenda e o tipo de atendimento do lançamento. */
  _ehClinico(c) {
    if (c.ficha || c.srpa) return false;
    if (c.consulta || c.pre) return true;
    const t = meuDia._norm((c.agenda && c.agenda.tipo) || '');
    if (t === 'consulta' || t === 'pre-anestesico') return true;
    if (/^consulta/.test(String((c.fin && c.fin.tipo_atendimento) || ''))) return true;
    return false;
  },
  /* nome antigo, mantido: havia chamadas espalhadas */
  _ehSoConsulta(c) { return meuDia._ehClinico(c); },
  _chipPre(c) {
    if (!c.pre) return '';
    /* Finalizada MAS sem liberar o paciente não é caso resolvido: o
       atendimento fechou (e foi cobrado), o clínico não. Verde puro aqui
       esconderia o que ainda falta. */
    if (c.pre._finalizado && typeof pre !== 'undefined' && pre.ehPendente && pre.ehPendente(c.pre)) {
      const rot = (pre.DESFECHOS[pre.desfechoDe(c.pre)] || {}).rot || 'em aberto';
      return '<button type="button" class="md-chip md-meio" onclick="dashboard._abrirFicha(\'pre\',' + utils.jsArg(c.pre._id) + ')" ' +
        'title="Atendimento concluído e cobrado — mas o paciente não está liberado: ' + utils.escapeAttr(rot) + '">' +
        '🫀 Pré ✓ · ' + utils.escapeHTML(rot.toLowerCase()) + '</button>';
    }
    const ok = !!c.pre._finalizado;
    return '<button type="button" class="md-chip ' + (ok ? 'md-ok' : 'md-meio') + '" onclick="dashboard._abrirFicha(\'pre\',' + utils.jsArg(c.pre._id) + ')" title="' + (ok ? 'Pré-anestésica finalizada — abrir' : 'Pré-anestésica em rascunho — continuar') + '">🫀 ' + (ok ? 'Pré ✓' : 'Pré…') + '</button>';
  },
  _chipConsulta(c) {
    if (!c.consulta) return '';
    const ok = !!c.consulta._finalizado;
    return '<button type="button" class="md-chip ' + (ok ? 'md-ok' : 'md-meio') + '" onclick="dashboard._abrirFicha(\'consulta\',' + utils.jsArg(c.consulta._id) + ')" title="' + (ok ? 'Consulta finalizada — abrir' : 'Consulta em rascunho — continuar') + '">🩺 ' + (ok ? 'Consulta ✓' : 'Consulta…') + '</button>';
  },
  _chipFicha(c) {
    /* nada de cobrar ficha de anestesia de quem veio para uma consulta */
    if (meuDia._ehSoConsulta(c)) return '';
    if (c.ficha) {
      const ok = !!c.ficha._finalizado;
      return '<button type="button" class="md-chip ' + (ok ? 'md-ok' : 'md-meio') + '" onclick="dashboard._abrirFicha(\'anestesia\',' + utils.jsArg(c.ficha._id) + ')" title="' + (ok ? 'Ficha finalizada — abrir' : 'Ficha em rascunho — continuar') + '">📋 ' + (ok ? 'Ficha ✓' : 'Ficha…') + '</button>';
    }
    if (c.agenda) return '<button type="button" class="md-chip md-falta" onclick="agenda.atender(' + utils.jsArg(c.agenda._id) + ')" title="Iniciar atendimento pré-preenchido da agenda">▶ Iniciar</button>';
    return '<span class="md-chip md-nada">— ficha</span>';
  },
  _chipSrpa(c) {
    if (meuDia._ehSoConsulta(c)) return '';
    if (!c.srpa) return '<span class="md-chip md-nada">— SRPA</span>';
    const ok = !!c.srpa._finalizado;
    return '<button type="button" class="md-chip ' + (ok ? 'md-ok' : 'md-meio') + '" onclick="dashboard._abrirFicha(\'recuperacao\',' + utils.jsArg(c.srpa._id) + ')" title="' + (ok ? 'SRPA finalizada — abrir' : 'SRPA em andamento — continuar') + '">🏥 ' + (ok ? 'SRPA ✓' : 'SRPA…') + '</button>';
  },
  _chipFin(c) {
    if (!c.fin) {
      /* "— financeiro" sozinho não explica nada, e a explicação estava só num
         title — invisível no celular e fácil de não ver no computador. Daí a
         pergunta certa de quem olha a tela: "por que este não gerou
         financeiro?". Quando dá para saber o motivo, ele vai escrito ao lado:
         o lançamento nasce na FINALIZAÇÃO, e documento em rascunho ainda não
         chegou lá. */
      const rascunho = (c.pre && !c.pre._finalizado) || (c.consulta && !c.consulta._finalizado)
                    || (c.ficha && !c.ficha._finalizado);
      if (rascunho) {
        return '<span class="md-chip md-nada" style="color:#7a4b12" ' +
          'title="O lançamento financeiro é criado ao FINALIZAR o documento. Este ainda está em rascunho.">' +
          '— financeiro · falta finalizar</span>';
      }
      /* DOCUMENTO FINALIZADO E SEM LANÇAMENTO é outra coisa, e era aqui que a
         tela mentia por omissão: dizia que "o Finalizar cria automaticamente"
         para um atendimento que JÁ foi finalizado e não gerou nada. A janela
         da cobrança pode não ter chegado a abrir (havia outra janela por cima)
         ou ter sido fechada sem escolha — e aí o atendimento fica sem cobrança
         sem ninguém ficar sabendo. Agora o chip diz isso e GERA num clique. */
      const fonte = (c.ficha && c.ficha._finalizado) ? ['anestesia', c.ficha]
                  : (c.pre && c.pre._finalizado) ? ['pre', c.pre]
                  : (c.consulta && c.consulta._finalizado) ? ['consulta', c.consulta] : null;
      if (fonte) {
        return '<button type="button" class="md-chip md-falta" onclick="meuDia.gerarFinanceiro(' + utils.jsArg(fonte[0]) + ',' + utils.jsArg(fonte[1]._id) + ')" ' +
          'title="Finalizado, mas sem lançamento financeiro. Clique para abrir a janela da cobrança deste atendimento.">💰 gerar financeiro</button>';
      }
      return '<span class="md-chip md-nada" title="Nenhum lançamento financeiro hoje — o Finalizar do documento cria automaticamente">— financeiro</span>';
    }
    const ok = !!c.fin.pago || c.fin.status === 'recebido' || c.fin.status === 'finalizado';
    return '<button type="button" class="md-chip ' + (ok ? 'md-ok' : 'md-meio') + '" onclick="dashboard._abrirFicha(\'financeiro\',' + utils.jsArg(c.fin._id) + ')" title="' + (ok ? 'Financeiro ok — abrir' : 'Financeiro pendente — abrir') + '">💰 ' + (ok ? 'Fin ✓' : 'Fin…') + '</button>';
  },

  /* Abre a MESMA janela de finalização, depois do fato. O caminho normal é no
     Finalizar; isto é a rede embaixo dele, para o atendimento que passou. */
  gerarFinanceiro(mod, id) {
    let doc = null;
    try { doc = store.getById(mod, id); } catch (e) {}
    if (!doc) { toast('Não achei o documento deste atendimento', 'error'); return; }
    let jaTem = false;
    try { jaTem = (store.list('financeiro') || []).some(x => x._origemId === id); } catch (e) {}
    if (jaTem) { toast('Este atendimento já tem lançamento financeiro'); try { meuDia.render(); } catch (e) {} return; }
    try {
      fin.finalizacao.abrirQuandoLivre(mod, doc, () => { try { meuDia.render(); } catch (e) {} });
    } catch (e) { toast('Não consegui abrir a janela do financeiro: ' + e.message, 'error'); }
  },

  /* ---- Ver só o que foi finalizado ----
     "Meu dia" é duas coisas ao mesmo tempo: a lista do que FALTA fazer no
     plantão e o retrato do que foi produzido. Some as duas e nenhuma fica
     boa. Filtrar de vez esconderia justamente o que cobra ser terminado —
     então é um interruptor, e a escolha fica lembrada.

     Produção, aqui como no painel: o que foi FINALIZADO. Um caso conta quando
     tem ao menos um documento finalizado; lançamento financeiro sozinho não
     é documento, e compromisso de agenda menos ainda. */
  SO_FIN_KEY: 'medsys.v7.meudia.so_finalizados',
  soFinalizados() { try { return localStorage.getItem(meuDia.SO_FIN_KEY) === '1'; } catch (e) { return false; } },
  alternarSoFinalizados(lig) {
    try { localStorage.setItem(meuDia.SO_FIN_KEY, lig ? '1' : '0'); } catch (e) {}
    meuDia.render();
    toast(lig ? '✅ Mostrando só o que foi finalizado' : '📋 Mostrando o dia inteiro, inclusive o que falta terminar');
  },
  _temFinalizado(c) {
    return !!((c.ficha && c.ficha._finalizado) || (c.pre && c.pre._finalizado)
           || (c.consulta && c.consulta._finalizado) || (c.srpa && c.srpa._finalizado));
  },

  render() {
    const host = document.getElementById('meu-dia-lista');
    const res = document.getElementById('meu-dia-resumo');
    if (!host) return;
    const todos = meuDia.coletar();
    const so = meuDia.soFinalizados();
    const casos = so ? todos.filter(meuDia._temFinalizado) : todos;
    /* o interruptor mora no cartão, e diz quantos ficaram de fora */
    const alt = document.getElementById('meu-dia-filtro');
    if (alt) {
      const escondidos = todos.length - casos.length;
      alt.innerHTML =
        '<label style="display:inline-flex;align-items:center;gap:6px;font-size:.78rem;cursor:pointer;color:var(--text-soft)">' +
        '<input type="checkbox" ' + (so ? 'checked' : '') + ' onchange="meuDia.alternarSoFinalizados(this.checked)"> ' +
        'só finalizados</label>' +
        (so && escondidos
          ? '<span style="font-size:.76rem;color:#7a4b12;margin-left:8px">' + escondidos + ' por finalizar fora da lista</span>'
          : '');
    }
    if (so && !casos.length && todos.length) {
      host.innerHTML = '<p style="font-size:.84rem;color:var(--text-mute);margin:0">Nada finalizado hoje ainda — ' +
        todos.length + ' caso(s) em andamento. Desmarque "só finalizados" para vê-los.</p>';
      if (res) res.style.display = 'none';
      return;
    }
    if (!casos.length) {
      host.innerHTML = '<p style="font-size:.84rem;color:var(--text-mute);margin:0">Nenhum caso registrado para hoje ainda. Os compromissos da Agenda e as fichas de hoje aparecem aqui automaticamente.</p>';
      if (res) res.style.display = 'none';
      return;
    }
    host.innerHTML = casos.map(c => `
      <div class="md-linha">
        <div class="md-info">
          <span class="md-hora">${utils.escapeHTML(c.hora || '—')}</span>
          <span class="md-nome">${utils.escapeHTML(c.nome)}</span>
          <span class="md-proc">${utils.escapeHTML(c.procedimento || '')}</span>
          ${meuDia._linhaCodigos(c)}
        </div>
        <div class="md-chips">${meuDia._chipPre(c)}${meuDia._chipConsulta(c)}${meuDia._chipFicha(c)}${meuDia._chipSrpa(c)}${meuDia._chipFin(c)}</div>
      </div>`).join('');
    if (res) {
      const clinicos = casos.filter(c => meuDia._ehClinico(c));
      /* "Sem ficha" é um ALARME, e alarme que toca sozinho todo dia deixa de
         ser lido. Ele acusava as consultas de não terem ficha de anestesia —
         quatro falsos por dia em quem atende no consultório. Consulta sai da
         conta: o que falta a ela é ser finalizada, e isso tem chip próprio. */
      const cirurgicos = casos.filter(c => !meuDia._ehClinico(c));
      const fichasOk = casos.filter(c => c.ficha && c.ficha._finalizado).length;
      const fichasRasc = casos.filter(c => c.ficha && !c.ficha._finalizado).length;
      const semFicha = cirurgicos.filter(c => !c.ficha).length;
      /* um atendimento clínico pode ser consulta OU pré — e um lançamento
         financeiro sozinho não é documento nenhum, então não conta como
         "por finalizar": não há o que finalizar nele */
      const clinicosAbertos = clinicos.filter(c =>
        (c.consulta && !c.consulta._finalizado) || (c.pre && !c.pre._finalizado)).length;
      const finPend = casos.filter(c => c.fin && !(c.fin.pago || c.fin.status === 'recebido' || c.fin.status === 'finalizado')).length;
      const semFin = casos.filter(c => c.ficha && c.ficha._finalizado && !c.fin).length;
      const chips = [
        { i: '🗓', l: 'Casos hoje', v: casos.length },
        { i: '✅', l: 'Fichas finalizadas', v: fichasOk },
        { i: '✏️', l: 'Em rascunho', v: fichasRasc, neg: fichasRasc > 0 },
        { i: '⚠️', l: 'Sem ficha', v: semFicha, neg: semFicha > 0 },
        { i: '💰', l: 'Fin. pendente', v: finPend, neg: finPend > 0 }
      ];
      /* consulta/pré só entram na conta quando existe atendimento clínico no dia */
      if (clinicos.length) {
        chips.splice(2, 0, { i: '🩺', l: 'Consultas/pré por finalizar', v: clinicosAbertos, neg: clinicosAbertos > 0 });
      }
      if (semFin) chips.push({ i: '❗', l: 'Finalizada sem financeiro', v: semFin, neg: true });
      res.innerHTML = chips.map(ch =>
        '<span class="fr-chip' + (ch.neg ? ' fr-neg' : '') + '"><span>' + ch.i + '</span><span class="fr-l">' + ch.l + '</span><b>' + ch.v + '</b></span>').join('');
      res.style.display = 'flex';
    }
  }
};

/* FIM DO PAINEL MEU DIA */
