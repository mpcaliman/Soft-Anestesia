'use strict';

/* Camada central de impressão. Mantém o contrato global `printPreview` para
   os handlers legados e nunca grava o prontuário que está renderizando. */
/* ============================================================================
   PRINT PREVIEW — pré-visualização de impressão
============================================================================ */
const printPreview = {
  abrir() {
    try {
      printPreview._nomeArquivoOverride = null;
      const mod = state.currentModule;
      const builders = {
        pre: printPreview._buildPre,
        consulta: printPreview._buildConsulta,
        anestesia: printPreview._buildAnestesia,
        recuperacao: printPreview._buildRecuperacao,
        termo: printPreview._buildTermo,
        prescricao: printPreview._buildPrescricao,
        documentos: printPreview._buildDocumento,
        risco: printPreview._buildRisco,
        financeiro: printPreview._buildFinanceiro,
        agenda: printPreview._buildAgenda,
        dashboard: printPreview._buildDashboard
      };
      const builder = builders[mod];
      if (!builder) { toast('Pré-visualização não disponível neste módulo', 'warn'); return; }

      /* Contexto de versão p/ o carimbo do rodapé (só módulos de documento). */
      const formMapVer = { pre: 'form-pre', consulta: 'form-consulta', anestesia: 'form-anestesia', recuperacao: 'form-recuperacao', termo: 'form-termo', prescricao: 'form-prescricao', risco: 'form-risco' };
      printPreview._verCtx = formMapVer[mod] ? { mod, formId: formMapVer[mod] } : null;

      const html = builder();
      const ppp = document.getElementById('ppp');
      if (!ppp) { toast('Erro: container de preview não encontrado', 'error'); return; }
      ppp.innerHTML = html;

      /* Popula dropdown de carimbos a partir dos profissionais cadastrados que tenham carimbo */
      const sel = document.getElementById('ppt-signature-select');
      const profissionais = [
        ...ajustes.list('cad_anestesistas').filter(p => p.carimbo).map(p => ({ ...p, _tipo: 'Anestesista' })),
        ...ajustes.list('cad_cirurgioes').filter(p => p.carimbo).map(p => ({ ...p, _tipo: 'Cirurgião' }))
      ];
      /* Tenta detectar profissional do form atual pelo _profissional_id ou pelo nome */
      let profissionalAtual = null;
      const formMap = { pre: 'form-pre', consulta: 'form-consulta', anestesia: 'form-anestesia', recuperacao: 'form-recuperacao', termo: 'form-termo', prescricao: 'form-prescricao' };
      const formId = formMap[mod];
      if (formId) {
        const formEl = document.getElementById(formId);
        if (formEl) {
          const idEl = formEl.querySelector('[name="_profissional_id"]');
          if (idEl && idEl.value) {
            profissionalAtual = profissionais.find(p => p._id === idEl.value);
          }
          if (!profissionalAtual) {
            /* Tenta pelo nome do campo profissional/anestesiologista/responsavel */
            const nomeProf = (formEl.querySelector('[name="anestesiologista"]') || formEl.querySelector('[name="profissional"]') || formEl.querySelector('[name="responsavel"]'))?.value;
            if (nomeProf) {
              const key = nomeProf.trim().toLowerCase();
              profissionalAtual = profissionais.find(p => (p.nome || '').trim().toLowerCase() === key);
            }
          }
        }
      }
      sel.innerHTML = '<option value="">— sem carimbo —</option>' +
        profissionais.map(p => `<option value="${p._id}" ${profissionalAtual && profissionalAtual._id === p._id ? 'selected' : ''}>${utils.escapeHTML(p.nome)} (${p._tipo})</option>`).join('');

      document.getElementById('ppt-info').textContent = printPreview._infoLabel(mod);
      /* Mostra nome de arquivo sugerido */
      const filenameEl = document.getElementById('ppt-filename');
      if (filenameEl) filenameEl.textContent = '📁 ' + printPreview._gerarNomeArquivo();
      document.getElementById('print-preview-overlay').classList.add('show');
      /* Atualiza carimbo inicial */
      printPreview.refreshSignature();
    } catch (e) {
      console.error('Erro ao abrir preview:', e);
      toast('Erro ao abrir preview: ' + (e.message || ''), 'error');
    }
  },
  fechar() {
    document.getElementById('print-preview-overlay').classList.remove('show');
    document.body.classList.remove('printing-preview');
    /* Impressão pós-finalização: a ficha foi RECARREGADA no formulário só para
       montar o arquivo único — ao fechar o preview, ZERA tudo. Nada de um
       paciente pode sobrar para o próximo. */
    if (printPreview._zerarFichaAoFechar) {
      printPreview._zerarFichaAoFechar = false;
      try { anestesia.limparSilencioso(); } catch (e) {}
      try {
        utils.clearForm('form-recuperacao');
        ['srpa-vitais-body', 'srpa-eventos-body', 'srpa-medicacoes-body'].forEach(i => {
          const el = document.getElementById(i); if (el) el.innerHTML = '';
        });
      } catch (e) {}
      try { markClean(); } catch (e) {}
      try { rascunhos.renderAbas('anestesia'); } catch (e) {}
    }
  },

  /* ARQUIVO ÚNICO: ficha de anestesia + SRPA (quebra de página entre elas).
     Lê os dois formulários — quem chama garante que ambos estão carregados. */
  /* ARQUIVO ÚNICO: avaliação pré-anestésica + termo de consentimento.
     São dois papéis que andam juntos na consulta — o paciente leva um só
     documento e a secretária imprime uma vez. O termo começa em página nova.
     Vale a partir da PRÉ ou do TERMO: o que não estiver no formulário aberto
     é buscado no mesmo paciente/caso, nunca apenas pelo nome. */
  abrirPreTermo() {
    try {
      const ppp = document.getElementById('ppp');
      if (!ppp) { toast('Erro: container de preview não encontrado', 'error'); return; }
      const fPre = document.getElementById('form-pre');
      const fTermo = document.getElementById('form-termo');
      const nomeDe = (f) => (f && f.querySelector('[name="nome"]') || {}).value || '';
      let nome = nomeDe(fPre) || nomeDe(fTermo);
      if (!nome) { toast('Preencha o nome do paciente antes de imprimir o conjunto', 'warn'); return; }
      const ctxPre = linker.contextoPaciente('pre');
      const ctxTermo = linker.contextoPaciente('termo');
      const casoPre = linker.contextoCaso('pre');
      const casoTermo = linker.contextoCaso('termo');
      const identidadeConflita = (ctxPre.identityKey && ctxTermo.identityKey && ctxPre.identityKey !== ctxTermo.identityKey) ||
        (ctxPre.patientRef && ctxTermo.patientRef && ctxPre.patientRef !== ctxTermo.patientRef);
      const casoConflita = (casoPre.caseId && casoTermo.caseId && casoPre.caseId !== casoTermo.caseId) ||
        (casoPre.caseKey && casoTermo.caseKey && casoPre.caseKey !== casoTermo.caseKey);
      if (identidadeConflita || casoConflita) {
        toast('A pré e o termo abertos pertencem a pacientes ou atendimentos diferentes. Revise antes de imprimir.', 'warn'); return;
      }
      const mesmoVinculo = (casoPre.caseId && casoPre.caseId === casoTermo.caseId) ||
        (casoPre.caseKey && casoPre.caseKey === casoTermo.caseKey) ||
        (ctxPre.identityKey && ctxPre.identityKey === ctxTermo.identityKey) ||
        (ctxPre.patientRef && ctxPre.patientRef === ctxTermo.patientRef);
      if (nomeDe(fPre) && nomeDe(fTermo) && !mesmoVinculo) {
        toast('Não é seguro juntar pré e termo apenas pelo nome. Abra o registro vinculado ou selecione o paciente.', 'warn'); return;
      }
      const contexto = Object.assign({},
        (ctxPre.identityKey || ctxPre.patientRef) ? ctxPre : ctxTermo,
        (casoPre.caseId || casoPre.caseKey) ? casoPre : casoTermo);

      /* completa o formulário vazio com o registro mais recente do paciente */
      const carregarSePreciso = (mod, form) => {
        if (nomeDe(form)) return true;
        if (!contexto.identityKey && !contexto.patientRef) return false;
        try {
          const doc = linker.ultimoPorNome(mod, nome, contexto);
          if (!doc) return false;
          utils.fillForm(form.id, doc);
          return true;
        } catch (e) { return false; }
      };
      const temPre = carregarSePreciso('pre', fPre);
      const temTermo = carregarSePreciso('termo', fTermo);
      if (!temPre && !temTermo) { toast('Nada para imprimir', 'warn'); return; }

      const partes = [];
      if (temPre) partes.push(printPreview._buildPre());
      if (temTermo) {
        if (partes.length) {
          partes.push('<div class="pp-quebra" style="page-break-before:always;break-before:page"></div>');
          partes.push('<div class="pp-capitulo" style="margin:0 0 12px;padding:9px 14px;background:#eef2f7;border-left:5px solid #3b5b7e;font-weight:700;font-size:13pt;color:#22384f">2ª parte — Termo de consentimento (TCLE)</div>');
        }
        partes.push(printPreview._buildTermo());
      }
      ppp.innerHTML = partes.join('');
      printPreview._verCtx = { mod: temPre ? 'pre' : 'termo', formId: temPre ? 'form-pre' : 'form-termo' };
      printPreview._nomeArquivoOverride = printPreview._sanitizarPaciente(nome) +
        (temPre && temTermo ? '_Pre-Anestesica+Termo_' : (temPre ? '_Pre-Anestesica_' : '_Termo_')) +
        printPreview._dataCriacao();
      const info = document.getElementById('ppt-info');
      if (info) info.textContent = temPre && temTermo ? 'Pré-anestésica + Termo (arquivo único)' : (temPre ? 'Pré-anestésica' : 'Termo de consentimento');
      const filenameEl = document.getElementById('ppt-filename');
      if (filenameEl) filenameEl.textContent = '📁 ' + printPreview._gerarNomeArquivo();
      document.getElementById('print-preview-overlay').classList.add('show');
      printPreview.refreshSignature();
      if (!temTermo) toast('Não achei termo deste paciente — imprimindo só a pré', 'warn');
      else if (!temPre) toast('Não achei pré-anestésica deste paciente — imprimindo só o termo', 'warn');
    } catch (e) {
      console.error('Erro no preview pré+termo:', e);
      toast('Erro ao montar pré + termo: ' + (e.message || ''), 'error');
    }
  },

  abrirConjunto() {
    try {
      const fAna = document.getElementById('form-anestesia');
      const fSrpa = document.getElementById('form-recuperacao');
      const nomeAna = (fAna && fAna.querySelector('[name="paciente_nome"]') || {}).value || '';
      const nomeSrpa = (fSrpa && fSrpa.querySelector('[name="nome"]') || {}).value || '';
      if (nomeAna && nomeSrpa) {
        const pacAna = linker.contextoPaciente('anestesia');
        const pacSrpa = linker.contextoPaciente('recuperacao');
        const casoAna = linker.contextoCaso('anestesia');
        const casoSrpa = linker.contextoCaso('recuperacao');
        const conflita =
          (pacAna.identityKey && pacSrpa.identityKey && pacAna.identityKey !== pacSrpa.identityKey) ||
          (pacAna.patientRef && pacSrpa.patientRef && pacAna.patientRef !== pacSrpa.patientRef) ||
          (casoAna.caseId && casoSrpa.caseId && casoAna.caseId !== casoSrpa.caseId) ||
          (casoAna.caseKey && casoSrpa.caseKey && casoAna.caseKey !== casoSrpa.caseKey);
        const mesmoVinculo = (casoAna.caseId && casoAna.caseId === casoSrpa.caseId) ||
          (casoAna.caseKey && casoAna.caseKey === casoSrpa.caseKey);
        if (conflita || !mesmoVinculo) {
          toast('Não é seguro juntar ficha e SRPA sem o mesmo atendimento vinculado. Importe a SRPA a partir da ficha correta.', 'warn');
          return;
        }
      }
      const htmlFicha = printPreview._buildAnestesia();
      const htmlSrpa = printPreview._buildRecuperacao();
      printPreview._verCtx = { mod: 'anestesia', formId: 'form-anestesia' };
      const ppp = document.getElementById('ppp');
      if (!ppp) { toast('Erro: container de preview não encontrado', 'error'); return; }
      /* Ficha e SRPA são o mesmo ato: a SRPA entra logo abaixo, na mesma
         página, com a faixa de capítulo separando. Forçar página nova aqui
         gastava uma folha por caso — e a SRPA costuma ocupar meia página.
         A faixa não fica sozinha no pé da folha (page-break-after: avoid). */
      ppp.innerHTML = htmlFicha +
        '<div class="pp-capitulo" style="margin:14px 0 12px;padding:9px 14px;background:#eef2f7;border-left:5px solid #3b5b7e;font-weight:700;font-size:13pt;color:#22384f;break-inside:avoid;page-break-inside:avoid;page-break-after:avoid;break-after:avoid">2ª parte — Recuperação pós-anestésica (SRPA)</div>' +
        htmlSrpa;
      /* Nome do arquivo: Paciente_Ficha-Anestesia+SRPA_data de criação (hoje) */
      let paciente = '';
      try {
        const d = anestesia.coletarEstruturado();
        paciente = (d.paciente && d.paciente.nome) || '';
      } catch (e) {}
      printPreview._nomeArquivoOverride = printPreview._sanitizarPaciente(paciente) + '_Ficha-Anestesia+SRPA_' + printPreview._dataCriacao();
      /* Dropdown de carimbos (mesma lógica do abrir normal) */
      const sel = document.getElementById('ppt-signature-select');
      if (sel) {
        const profissionais = [
          ...ajustes.list('cad_anestesistas').filter(p => p.carimbo).map(p => ({ ...p, _tipo: 'Anestesista' })),
          ...ajustes.list('cad_cirurgioes').filter(p => p.carimbo).map(p => ({ ...p, _tipo: 'Cirurgião' }))
        ];
        const nomeProf = (document.querySelector('#form-anestesia [name="anestesiologista"]') || {}).value || '';
        const key = nomeProf.trim().toLowerCase();
        const atual = profissionais.find(p => (p.nome || '').trim().toLowerCase() === key);
        sel.innerHTML = '<option value="">— sem carimbo —</option>' +
          profissionais.map(p => `<option value="${p._id}" ${atual && atual._id === p._id ? 'selected' : ''}>${utils.escapeHTML(p.nome)} (${p._tipo})</option>`).join('');
      }
      const info = document.getElementById('ppt-info');
      if (info) info.textContent = 'Ficha de anestesia + SRPA (arquivo único)';
      const filenameEl = document.getElementById('ppt-filename');
      if (filenameEl) filenameEl.textContent = '📁 ' + printPreview._gerarNomeArquivo();
      document.getElementById('print-preview-overlay').classList.add('show');
      printPreview.refreshSignature();
    } catch (e) {
      console.error('Erro no preview conjunto:', e);
      toast('Erro ao montar ficha + SRPA: ' + (e.message || ''), 'error');
    }
  },
  imprimir() {
    try {
      const overlay = document.getElementById('print-preview-overlay');
      if (!overlay || !overlay.classList.contains('show')) {
        toast('Abra a pré-visualização primeiro', 'warn');
        return;
      }
      const ppp = document.getElementById('ppp');
      if (!ppp) { toast('Conteúdo de preview não encontrado', 'error'); return; }

      const titulo = printPreview._gerarNomeArquivo();
      const contentHTML = ppp.innerHTML;

      const css = `
        /* margem vertical = 0 remove o cabeçalho/rodapé automático do navegador
           (URL, data, "Página X de Y"); o espaçamento vem do padding do body.
           Margem lateral fica no @page para se repetir em todas as páginas. */
        @page { size: A4; margin: 0 11mm; }
        * { box-sizing: border-box; }
        body { margin: 0; padding: 12mm 0 12mm 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; font-size: 11pt; color: #000; line-height: 1.35; -webkit-text-size-adjust: 100%; text-size-adjust: 100%; }
        img { max-width: 100%; height: auto; }
        /* Arquivo único ficha + SRPA: capítulo novo em página nova */
        .pp-quebra { page-break-before: always; break-before: page; }
        .pp-capitulo { margin: 0 0 12px; padding: 9px 14px; background: #eef2f7; border-left: 5px solid #3b5b7e; font-weight: 700; font-size: 13pt; color: #22384f; }
        .pp-compacto { --pp-esc: .8; --pp-logo: .62; }
        /* Receita: ver o comentário longo na folha de estilo da visualização */
        .pp-receita { --pp-logo: .68; }
        .pp-receita .pp-header { margin-bottom: 14px; }
        .pp-receita h2 { margin: 15px 0 7px; }
        .pp-receita .pp-ident { grid-template-columns: 2.2fr 1fr 1fr; }
        .pp-receita .pp-med { padding: 6px 0 7px; border-bottom: 1px dotted #c8ccd2; }
        .pp-receita .pp-med:last-child { border-bottom: none; }
        .pp-receita .pp-med-linha { display: flex; align-items: baseline; justify-content: space-between; gap: 14px; }
        .pp-receita .pp-med-nome { font-size: calc(11.5pt * var(--pp-esc, 1)); font-weight: 700; color: #1a2332; letter-spacing: .1px; }
        .pp-receita .pp-med-apres { font-weight: 500; color: #3a4450; }
        .pp-receita .pp-med-qtd { font-size: calc(10.5pt * var(--pp-esc, 1)); font-weight: 600; color: #2a3441; white-space: nowrap; flex-shrink: 0; }
        .pp-receita .pp-med-pos { font-size: calc(10.5pt * var(--pp-esc, 1)); color: #3a4450; margin-top: 3px; }
        .pp-receita .pp-med-vazio { font-size: calc(10.5pt * var(--pp-esc, 1)); color: #8a93a0; }
        .pp-receita .pp-validade { font-size: calc(9.5pt * var(--pp-esc, 1)); color: #5a6472; margin-top: 8px; }
        .pp-receita .pp-orient { font-size: calc(10.5pt * var(--pp-esc, 1)); margin: 0; }
        .pp-header { margin-bottom: 10px; }
        .pp-header-top { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding-bottom: 5px; border-bottom: 1px solid #d0d4da; }
        .pp-logo { height: calc(96px * var(--pp-logo, 1)); width: auto; max-width: calc(440px * var(--pp-logo, 1)); object-fit: contain; flex-shrink: 0; }
        .pp-prof { text-align: right; line-height: 1.22; min-width: 0; }
        .pp-prof-nome { font-size: calc(11pt * var(--pp-esc, 1)); font-weight: 700; color: #1a2332; letter-spacing: .2px; }
        .pp-prof-reg { font-size: calc(8.5pt * var(--pp-esc, 1)); color: #5a6472; margin-top: 1px; text-transform: uppercase; letter-spacing: .3px; }
        .pp-prof-end { font-size: calc(8.5pt * var(--pp-esc, 1)); color: #8a93a0; margin-top: 1px; }
        .pp-doc-title { text-align: center; margin-top: 7px; }
        .pp-doc-title h1 { font-size: calc(13.5pt * var(--pp-esc, 1)); font-weight: 700; letter-spacing: 1px; color: #1a2332; margin: 0; text-transform: uppercase; }
        .pp-doc-meta { font-size: calc(9.5pt * var(--pp-esc, 1)); color: #8a93a0; margin-top: 2px; line-height: 1.25; }
        .pp-doc-meta strong { font-weight: 600; color: #5a6472; }
        h2 { font-size: calc(10pt * var(--pp-esc, 1)); font-weight: 700; letter-spacing: .5px; text-transform: uppercase; color: #2a3441; margin: 9px 0 4px; padding: 0 0 2px 0; background: none; border: none; border-bottom: 1px solid #b5bcc6; page-break-after: avoid; }
        .pp-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 3px 16px; margin-bottom: 6px; font-size: calc(10.5pt * var(--pp-esc, 1)); }
        .pp-grid > .pp-field:only-child, .pp-grid > .pp-block:only-child { grid-column: 1 / -1; }
        .pp-grid.cols-3 { grid-template-columns: repeat(3, 1fr); }
        .pp-grid.cols-1 { grid-template-columns: 1fr; }
        .pp-field { display: flex; gap: 5px; align-items: baseline; padding: 0; }
        .pp-field .pp-label { font-weight: 600; color: #8a93a0; text-transform: uppercase; font-size: calc(8pt * var(--pp-esc, 1)); letter-spacing: .3px; white-space: nowrap; }
        .pp-field .pp-value { flex: 1; font-size: calc(10.5pt * var(--pp-esc, 1)); color: #1a2332; }
        .pp-block { margin-bottom: 6px; padding: 1px 0; font-size: calc(10.5pt * var(--pp-esc, 1)); }
        .pp-block .pp-label { font-weight: 600; color: #8a93a0; text-transform: uppercase; font-size: calc(8pt * var(--pp-esc, 1)); letter-spacing: .3px; display: block; margin-bottom: 2px; }
        .pp-block .pp-value { white-space: pre-wrap; color: #1a2332; line-height: 1.35; }
        .pp-lab-grid { display: grid; grid-template-columns: repeat(6, 1fr); gap: 2px 6px; border: 1px solid #d0d5db; border-radius: 4px; padding: 4px 6px; }
        .pp-lab-item { font-size: calc(9.5pt * var(--pp-esc, 1)); white-space: nowrap; }
        .pp-lab-k { color: #8a93a0; font-weight: 600; }
        .pp-lab-v { color: #1a2332; font-weight: 600; }
        .pp-table { width: 100%; border-collapse: collapse; font-size: calc(10pt * var(--pp-esc, 1)); margin-bottom: 6px; page-break-inside: auto; }
        .pp-table tr { page-break-inside: avoid; }
        .pp-table th, .pp-table td { border: 1px solid #c5cad2; padding: 2px 4px; text-align: left; }
        .pp-table th { background: #f2f4f7; font-size: 8.5pt; text-transform: uppercase; letter-spacing: .4px; color: #5a6472; }
        .pp-checks { display: flex; flex-wrap: wrap; gap: 3px 8px; font-size: 10pt; margin-bottom: 5px; }
        .pp-check { background: #2a3441; color: #fff; padding: 1px 7px; border-radius: 10px; font-size: 10pt; }
        .pp-signature-area { margin-top: 18px; display: flex; gap: 20px; justify-content: center; page-break-inside: avoid; flex-wrap: wrap; }
        .pp-signature { text-align: center; min-width: 45%; max-width: 48%; border-top: 1px solid #1a2332; padding-top: 3px; font-size: 10pt; }
        .pp-signature-img-slot { min-height: 50px; display: flex; align-items: flex-end; justify-content: center; margin-bottom: 3px; }
        .pp-signature img { max-height: 55px; max-width: 190px; display: block; }
        .pp-footer { margin-top: 10px; padding-top: 4px; border-top: 1px solid #d0d4da; font-size: 8.5pt; color: #5a6472; text-align: center; }
        .pp-footer-credit { display: block; font-size: 7.5pt; color: #b0b6bf; margin-top: 1px; letter-spacing: .2px; }
        @media print {
          h2 { background: none !important; }
          .pp-table th { background: #f2f4f7 !important; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
          .pp-check { background: #444 !important; color: #fff !important; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
          .pp-voltar-bar { display: none !important; }
        }
        .pp-voltar-bar { position: sticky; top: 0; z-index: 9999; background: #1a2332; padding: 10px 12px; display: flex; gap: 10px; justify-content: center; box-shadow: 0 2px 8px rgba(0,0,0,.25); }
        .pp-voltar-bar button { font-size: 15px; padding: 10px 16px; border-radius: 8px; border: 0; cursor: pointer; font-family: inherit; }
        .pp-voltar-btn { background: #fff; color: #1a2332; font-weight: 700; }
        .pp-print-btn { background: #2e7d52; color: #fff; }
      `;

      const barraVoltar = `
  <div class="pp-voltar-bar">
    <button type="button" class="pp-voltar-btn" onclick="window.close();setTimeout(function(){if(!window.closed){history.back();}},250);">← Voltar ao SisAnestesia</button>
    <button type="button" class="pp-print-btn" onclick="window.print()">🖨️ Imprimir / PDF</button>
  </div>`;

      const TAG_OPEN_SCRIPT = '<' + 'script>';
      const TAG_CLOSE_SCRIPT = '<' + '/script>';
      const TAG_CLOSE_BODY = '<' + '/body>';
      const TAG_CLOSE_HTML = '<' + '/html>';
      const fullHTML = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${utils.escapeHTML(titulo)}</title>
  <style>${css}</style>
</head>
<body>
  ${barraVoltar}
  ${contentHTML}
${TAG_CLOSE_BODY}
${TAG_CLOSE_HTML}`;

      /* ESTRATÉGIA iOS-robusta: abre o conteúdo numa nova janela e dispara o
         print a partir DELA (gesto do usuário preservado). Se o pop-up for
         bloqueado, cai para o método do iframe. */
      const win = window.open('', '_blank');
      if (win && win.document) {
        win.document.open();
        win.document.write(fullHTML + TAG_OPEN_SCRIPT +
          'window.onload=function(){setTimeout(function(){window.focus();window.print();},300);};' +
          'window.onafterprint=function(){setTimeout(function(){window.close();},400);};' +
          TAG_CLOSE_SCRIPT);
        win.document.close();
        win.document.title = titulo;
        toast('Diálogo de impressão sendo aberto — escolha a impressora ou "Salvar em PDF".', 'success');
        return;
      }

      /* Pop-up bloqueado — que é o PADRÃO no navegador do celular.
         Antes daqui saía um iframe escondido com visibility:hidden a
         -10000px. O Safari do iPhone não rasteriza o que não está
         renderizado: o diálogo abria e a folha saía EM BRANCO. Não era do
         módulo — era de qualquer impressão feita pelo celular.
         Agora imprime-se a PRÓPRIA página. A folha de estilo
         `body.printing-preview` já existia para exatamente isto (esconde o
         app e deixa só o papel da visualização) e nunca chegou a ser ligada:
         só havia a linha que a removia. */
      const corpo = document.body;
      const tituloOriginal = document.title;
      const limparImpressao = () => {
        corpo.classList.remove('printing-preview');
        document.title = tituloOriginal;
        window.removeEventListener('afterprint', limparImpressao);
      };
      corpo.classList.add('printing-preview');
      document.title = titulo;          /* vira o nome sugerido do PDF */
      window.addEventListener('afterprint', limparImpressao);
      /* afterprint não existe em todo navegador: rede de segurança */
      setTimeout(limparImpressao, 60000);
      /* um quadro para o navegador aplicar o estilo antes de abrir o diálogo */
      setTimeout(() => { try { window.print(); } catch (err) { limparImpressao(); toast('Não consegui abrir a impressão: ' + (err.message || ''), 'error'); } }, 150);

      toast('Diálogo de impressão sendo aberto — escolha "Salvar como PDF" para gerar arquivo.', 'success');
    } catch (e) {
      console.error('Erro ao imprimir:', e);
      toast('Erro ao imprimir: ' + (e.message || ''), 'error');
    }
  },

  /* Gera o PDF da ficha atual via jsPDF e o envia ao backup na nuvem.
     Assim as fichas (não só a receita) entram no backup automático de PDF.
     Gera um PDF de TEXTO estruturado a partir do conteúdo do preview —
     100% offline e confiável (não depende de html2canvas nem de rasterização). */
  async salvarPDFnaNuvem() {
    const btn = document.getElementById('ppt-cloud-btn');
    try {
      const overlay = document.getElementById('print-preview-overlay');
      if (!overlay || !overlay.classList.contains('show')) {
        toast('Abra a pré-visualização primeiro', 'warn');
        return;
      }
      const cfg = (typeof pdfBackup !== 'undefined') ? pdfBackup.cfg() : {};
      const temDestino = (typeof cloud !== 'undefined' && cloud.estaLogado && cloud.estaLogado()) || cfg.drive === true;
      if (!temDestino) {
        toast('Faça login na nuvem (Ajustes → Sincronização) para salvar PDFs na nuvem.', 'warn');
        return;
      }
      const J = (window.jspdf && window.jspdf.jsPDF) || window.jsPDF;
      if (!J) { toast('Biblioteca de PDF não carregada', 'error'); return; }
      const ppp = document.getElementById('ppp');
      if (!ppp) { toast('Conteúdo de preview não encontrado', 'error'); return; }

      if (btn) { btn.disabled = true; btn.innerHTML = '<span class="icon">⏳</span> Gerando...'; }
      toast('Gerando PDF da ficha...');

      const doc = printPreview._gerarDocDeTexto(J, ppp);
      const nomeArq = printPreview._gerarNomeArquivo().replace(/[^\w.\-]+/g, '_') + '.pdf';
      await pdfBackup.enviarTodos(doc, nomeArq);
      toast('☁️ PDF da ficha enviado ao backup na nuvem');
    } catch (e) {
      console.error('Erro ao salvar PDF na nuvem:', e);
      toast('Não foi possível gerar o PDF na nuvem: ' + (e.message || ''), 'error');
    } finally {
      if (btn) { btn.disabled = false; btn.innerHTML = '<span class="icon">☁️</span> Salvar PDF na nuvem'; }
    }
  },

  /* Percorre o preview e monta um PDF de texto estruturado com jsPDF nativo.
     Reconhece cabeçalhos (h1/h2), campos (label+valor) e blocos de texto. */
  _gerarDocDeTexto(J, ppp) {
    const doc = new J({ unit: 'mm', format: 'a4' });
    const W = 210, H = 297, M = 16;
    const contentW = W - M * 2;
    let y = M;

    const novaPaginaSePreciso = (alturaProxima) => {
      if (y + alturaProxima > H - M) { doc.addPage(); y = M; }
    };
    const escreve = (txt, opts = {}) => {
      const size = opts.size || 10;
      const style = opts.style || 'normal';
      const cor = opts.cor != null ? opts.cor : 0;
      const gap = opts.gap != null ? opts.gap : size * 0.42;
      doc.setFont('helvetica', style); doc.setFontSize(size);
      if (Array.isArray(cor)) doc.setTextColor(cor[0], cor[1], cor[2]); else doc.setTextColor(cor);
      const linhas = doc.splitTextToSize(String(txt == null ? '' : txt), contentW - (opts.indent || 0));
      linhas.forEach(ln => {
        novaPaginaSePreciso(gap + 1);
        doc.text(ln, M + (opts.indent || 0), y);
        y += gap;
      });
      doc.setTextColor(0);
    };
    const linha = () => { novaPaginaSePreciso(4); doc.setDrawColor(200); doc.line(M, y, W - M, y); y += 4; };

    /* Cabeçalho do documento — logomarca primeiro (como na pré-visualização) */
    y = printPreview._logoPDF(doc, M, y, 58, 20);
    escreve(printPreview._infoLabel(state.currentModule) || 'Documento', { size: 14, style: 'bold', gap: 7 });
    escreve('Gerado em ' + utils.formatarDataHora(new Date().toISOString()), { size: 8, cor: 120, gap: 5 });
    linha();

    /* Percorre os nós relevantes do preview em ordem */
    const nodes = ppp.querySelectorAll('h1, h2, h3, .pp-doc-title, .pp-field, .pp-block, .pp-lab-item, .pp-check, .pp-table, p, .pp-prof-nome, .pp-prof-reg, .pp-quebra, .pp-capitulo, img.pp-grafico-img');
    nodes.forEach(node => {
      const cls = node.className || '';
      const tag = node.tagName;
      const txt = (node.innerText || node.textContent || '').trim();
      /* Quebra de capítulo (arquivo único ficha + SRPA): página nova SEMPRE */
      if (cls.includes('pp-quebra')) { doc.addPage(); y = M; return; }
      /* Gráfico de sinais vitais (imagem do canvas) — entra como figura no PDF */
      if (cls.includes('pp-grafico-img')) {
        try {
          const src = node.getAttribute('src') || '';
          if (src.startsWith('data:image')) {
            const nw = node.naturalWidth || 1000, nh = node.naturalHeight || 300;
            const w = contentW;
            const h = Math.max(30, Math.min(110, w * nh / Math.max(1, nw)));
            novaPaginaSePreciso(h + 4);
            doc.addImage(src, 'PNG', M, y, w, h);
            y += h + 4;
          }
        } catch (e) { /* imagem inválida — segue só com as tabelas */ }
        return;
      }
      if (!txt) return;
      if (cls.includes('pp-capitulo')) {
        escreve(txt, { size: 13, style: 'bold', cor: [34, 56, 79], gap: 7 });
        linha();
        return;
      }
      if (tag === 'H1' || cls.includes('pp-doc-title')) {
        y += 2; escreve(txt, { size: 12, style: 'bold', gap: 6 });
      } else if (tag === 'H2' || tag === 'H3') {
        y += 2; escreve(txt.toUpperCase(), { size: 9.5, style: 'bold', cor: [40, 52, 65], gap: 5 });
      } else if (cls.includes('pp-field')) {
        const label = (node.querySelector('.pp-label')?.innerText || '').trim();
        const value = (node.querySelector('.pp-value')?.innerText || '').trim();
        if (label || value) escreve((label ? label + ': ' : '') + value, { size: 9.5, gap: 4.6 });
      } else if (cls.includes('pp-block')) {
        const label = (node.querySelector('.pp-label')?.innerText || '').trim();
        const value = (node.querySelector('.pp-value')?.innerText || '').trim();
        if (label) escreve(label + ':', { size: 8, style: 'bold', cor: 120, gap: 4.2 });
        if (value) escreve(value, { size: 9.5, gap: 4.6, indent: 2 });
      } else if (cls.includes('pp-lab-item') || cls.includes('pp-check')) {
        escreve('• ' + txt, { size: 9, gap: 4.4, indent: 2 });
      } else if (tag === 'TABLE') {
        /* tabela simples: cada linha vira texto separado por " | " */
        node.querySelectorAll('tr').forEach(tr => {
          const cells = Array.from(tr.querySelectorAll('th, td')).map(c => (c.innerText || '').trim());
          if (cells.some(Boolean)) escreve(cells.join('  |  '), { size: 8.5, gap: 4.2 });
        });
        y += 1;
      } else if (tag === 'P') {
        escreve(txt, { size: 9.5, gap: 4.6 });
      }
    });
    return doc;
  },
  /* Captura a imagem de um gráfico (canvas) mesmo com o módulo OCULTO.
     Quando o módulo está display:none (ex.: imprimindo ficha+SRPA a partir da
     SRPA), o canvas fica com largura 0 e o toDataURL sai em branco — por isso
     o gráfico "sumia" no arquivo único. Aqui o módulo vira mensurável fora da
     tela, o gráfico é redesenhado, capturado e tudo é restaurado. */
  _larguraForcada: 0,
  _capturarGrafico(canvasId, moduleId, redesenhar) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return '';
    /* módulo/card oculto → sem layout → clientWidth 0; a largura forçada faz o
       desenho acontecer no buffer do canvas mesmo assim */
    printPreview._larguraForcada = 960;
    try { if (typeof redesenhar === 'function') redesenhar(); } catch (e) {}
    printPreview._larguraForcada = 0;
    let dataURL = '';
    try { if (canvas.width > 10 && canvas.height > 10) dataURL = canvas.toDataURL('image/png'); } catch (e) {}
    return (dataURL && dataURL.length > 100) ? dataURL : '';
  },

  /* Gera nome sugerido do arquivo: paciente_tipo_ddmmaaaa */
  /* --------------------------------------------------------------------------
     NOME DO ARQUIVO — Paciente_Tipo-do-documento_Data
     Todo documento tem rótulo PRÓPRIO. Antes o mapa cobria oito módulos e
     termo, receituário e risco cirúrgico caíam num "Documento" genérico: um
     termo de consentimento e um laudo do mesmo paciente, no mesmo dia,
     chegavam à pasta com o mesmo nome, e o segundo virava "(1)".
  -------------------------------------------------------------------------- */
  TIPOS_ARQUIVO: {
    pre: 'APA',
    consulta: 'Consulta',
    anestesia: 'Ficha-Anestesia',
    recuperacao: 'SRPA',
    termo: 'Termo-Consentimento',
    documentos: 'Documento',
    risco: 'Risco-Cirurgico',
    financeiro: 'Financeiro',
    agenda: 'Agenda',
    dashboard: 'Dashboard',
    orcamento: 'Orcamento'
  },
  /* O receituário não é um tipo só: o mesmo módulo imprime receita comum, de
     controle especial, de antimicrobiano, atestado, declaração e laudo. São
     documentos diferentes e precisam de nomes diferentes. */
  TIPOS_PRESCRICAO: {
    simples: 'Receita',
    especial: 'Receita-Controle-Especial',
    antimicrobiano: 'Receita-Antimicrobiano',
    atestado: 'Atestado',
    declaracao: 'Declaracao',
    laudo: 'Laudo'
  },
  _tipoDoDocumento(mod) {
    if (mod === 'prescricao') {
      const r = document.querySelector('#form-prescricao [name="modelo"]:checked');
      return printPreview.TIPOS_PRESCRICAO[(r && r.value) || 'simples'] || 'Receita';
    }
    return printPreview.TIPOS_ARQUIVO[mod] || 'Documento';
  },

  /* --------------------------------------------------------------------------
     IDENTIDADE DO DOCUMENTO
     Reimprimir o MESMO documento tem de devolver o MESMO nome — senão a cópia
     automática para a nuvem guardaria um arquivo novo a cada impressão, e a
     pasta encheria de duplicatas do mesmo papel. Por isso o desempate se
     prende ao registro, não ao instante da impressão.
     Registro salvo tem _id. Documento ainda não salvo é identificado pelo
     conteúdo do próprio formulário.
  -------------------------------------------------------------------------- */
  _chaveDocumento(mod) {
    const form = document.getElementById('form-' + mod);
    const id = form && (form.querySelector('[name="_id"]') || {}).value;
    if (id) return mod + ':' + id;
    if (!form) return mod + ':sem-form';
    /* sem _id: impressão digital dos campos preenchidos */
    let acc = 0;
    const txt = Array.from(form.querySelectorAll('input, select, textarea'))
      .filter(el => el.type !== 'hidden' && el.name)
      .map(el => el.name + '=' + (el.type === 'checkbox' || el.type === 'radio' ? (el.checked ? 1 : 0) : (el.value || '')))
      .join('|');
    for (let i = 0; i < txt.length; i++) { acc = ((acc << 5) - acc + txt.charCodeAt(i)) | 0; }
    return mod + ':form:' + Math.abs(acc).toString(36);
  },

  /* --------------------------------------------------------------------------
     UNICIDADE NO DIA
     Dois documentos DIFERENTES não podem sair com o mesmo nome no mesmo dia.
     O registro guarda, por dia, que documento reservou cada nome:
       - mesmo documento pedindo de novo  → devolve o nome que ele já tinha;
       - documento diferente, nome ocupado → recebe _2, _3, …
     Só o dia de hoje é mantido; o resto é descartado a cada uso.
  -------------------------------------------------------------------------- */
  _KEY_NOMES: 'medsys.v7.nomes_arquivo',
  _lerReserva() {
    try {
      const o = JSON.parse(localStorage.getItem(printPreview._KEY_NOMES) || '{}');
      const hoje = printPreview._dataCriacao();
      return (o && o.dia === hoje && o.nomes) ? o : { dia: hoje, nomes: {} };
    } catch (e) { return { dia: printPreview._dataCriacao(), nomes: {} }; }
  },
  _gravarReserva(r) {
    try { localStorage.setItem(printPreview._KEY_NOMES, JSON.stringify(r)); } catch (e) {}
  },
  _nomeUnico(base, chave) {
    const r = printPreview._lerReserva();
    /* A reserva é do documento MAIS do nome que ele pediu. Só a identidade do
       registro não basta: o mesmo registro gera documentos diferentes —
       imprimir "Pré + Termo" e depois só o termo, ou trocar o modelo do
       receituário de receita para atestado. Sem o nome na chave, o segundo
       recebia de volta o nome do primeiro. */
    const posse = chave + '|' + base;
    for (const nome in r.nomes) { if (r.nomes[nome] === posse) return nome; }
    let nome = base, n = 1;
    while (r.nomes[nome] && r.nomes[nome] !== posse) { n++; nome = base + '_' + n; }
    r.nomes[nome] = posse;
    printPreview._gravarReserva(r);
    return nome;
  },
  /* Esquece as reservas (usado pelos testes e por quem quiser recomeçar) */
  _limparReservaNomes() {
    try { localStorage.removeItem(printPreview._KEY_NOMES); } catch (e) {}
  },

  /* Para quem desenha o PDF direto, sem passar pela pré-visualização (receita,
     orçamento): mesma regra de nome e mesma garantia de unicidade no dia. */
  nomeDeArquivo(opts) {
    const base = printPreview._sanitizarPaciente(opts.paciente) + '_' +
                 (opts.tipo || 'Documento') + '_' + printPreview._dataCriacao();
    return printPreview._nomeUnico(base, opts.chave || base);
  },

  _gerarNomeArquivo() {
    const mod = state.currentModule;
    let base, chave;
    if (printPreview._nomeArquivoOverride) {
      /* arquivo combinado (ficha + SRPA, pré + termo): o nome vem pronto, mas
         a unicidade do dia vale para ele igual */
      base = printPreview._nomeArquivoOverride;
      chave = 'combinado:' + printPreview._chaveDocumento(mod);
    } else {
      const tipo = printPreview._tipoDoDocumento(mod);
      let paciente = '';
      if (mod === 'anestesia') {
        try { const d = anestesia.coletarEstruturado(); paciente = (d.paciente && d.paciente.nome) || ''; } catch (e) {}
      } else {
        const f = document.getElementById('form-' + mod);
        if (f) paciente = (f.querySelector('[name="nome"]') || f.querySelector('[name="paciente_nome"]') || {}).value || '';
      }
      /* Ordem fixa: Paciente_Tipo_Data — a data é SEMPRE a de criação do
         arquivo (hoje), porque é ela que ordena a pasta. */
      base = printPreview._sanitizarPaciente(paciente) + '_' + tipo + '_' + printPreview._dataCriacao();
      chave = printPreview._chaveDocumento(mod);
    }
    return printPreview._nomeUnico(base, chave);
  },
  /* ------------------------------------------------------------------
     LOGOMARCA NO PDF
     A pré-visualização (HTML) sempre mostrou a logo; o PDF gerado pelo
     jsPDF não a desenhava — todo documento saía sem identidade visual.
     Desenha a logo no topo e devolve o novo "y" (ou o mesmo, se não der).
  ------------------------------------------------------------------ */
  /* Nome e contato da clínica ao lado da logo. Devolve a altura ocupada —
     quem chama precisa saber onde continuar, e esse número não pode sair de
     um palpite sobre quantas linhas havia. */
  _clinicaPDF(doc, x, y) {
    let alt = 0;
    try {
      if (typeof clinicaIdentidade === 'undefined') return 0;
      const nome = clinicaIdentidade.nome();
      const linhas = clinicaIdentidade.linhas();
      if (!nome && !linhas.length) return 0;
      const fonte = doc.getFontSize ? doc.getFontSize() : 10;
      if (nome) {
        doc.setFont(undefined, 'bold'); doc.setFontSize(10);
        doc.text(String(nome), x, y + 3.2);
        alt = 4.4;
      }
      doc.setFont(undefined, 'normal'); doc.setFontSize(7.6);
      linhas.forEach(l => { doc.text(String(l), x, y + 3.2 + alt); alt += 3.4; });
      doc.setFontSize(fonte);
    } catch (e) {}
    return alt;
  },
  _logoPDF(doc, x, y, maxW, maxH) {
    try {
      /* Documento de paciente leva a marca da CLÍNICA, nunca a do sistema. */
      const src = (typeof logoUsuario !== 'undefined' && logoUsuario.daClinica()) || '';
      let w = 0, h = 0;
      if (src && src.indexOf('data:image') === 0) {
        let prop = null;
        try { prop = doc.getImageProperties ? doc.getImageProperties(src) : null; } catch (e) { prop = null; }
        const nw = (prop && prop.width) || 3, nh = (prop && prop.height) || 1;
        w = maxW; h = w * nh / nw;
        if (h > maxH) { h = maxH; w = h * nw / nh; }
        const fmt = /^data:image\/jpe?g/i.test(src) ? 'JPEG' : 'PNG';
        doc.addImage(src, fmt, x, y, w, h);
      }
      /* SEM LOGO O CABEÇALHO NÃO DESAPARECE. A versão anterior desistia antes
         de chegar aqui quando não havia imagem — e uma clínica que preencheu
         nome, endereço e telefone imprimia o PDF sem nada disso. */
      const altTexto = printPreview._clinicaPDF(doc, w ? (x + w + 4) : x, y + (w ? 3 : 0));
      const usado = Math.max(h, altTexto);
      return usado ? y + usado + 3 : y;
    } catch (e) { return y; }
  },
  /* Duração entre dois horários HH:MM (vira o dia se o fim for menor) */
  _durEntre(ini, fim) {
    if (!ini || !fim) return '';
    const a = String(ini).split(':').map(Number), b = String(fim).split(':').map(Number);
    if (a.length < 2 || b.length < 2 || isNaN(a[0]) || isNaN(b[0])) return '';
    let mm = (b[0] * 60 + b[1]) - (a[0] * 60 + a[1]);
    if (mm < 0) mm += 1440;
    return Math.floor(mm / 60) + 'h ' + String(mm % 60).padStart(2, '0') + 'min';
  },
  /* Data de criação do arquivo (hoje), formato ddmmaaaa */
  _dataCriacao() {
    const hoje = new Date();
    return String(hoje.getDate()).padStart(2, '0') + String(hoje.getMonth() + 1).padStart(2, '0') + hoje.getFullYear();
  },
  /* Sanitiza nome do paciente para uso em nome de arquivo */
  _sanitizarPaciente(nome) {
    return (nome || 'sem-paciente')
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-zA-Z0-9\s]/g, '')
      .trim()
      .replace(/\s+/g, '-')
      .slice(0, 40);
  },
  refreshSignature(acionadoPeloUsuario) {
    const sel = document.getElementById('ppt-signature-select');
    if (!sel) return;
    const id = sel.value;
    const sigArea = document.getElementById('ppp').querySelector('.pp-signature-area');
    if (!sigArea) return;
    /* SOMENTE o slot do PROFISSIONAL — nunca o do paciente/responsável.
       (No Termo há dois slots; o primeiro é o do paciente.) */
    let slot = sigArea.querySelector('.pp-signature-prof .pp-signature-img-slot');
    if (!slot) {
      const slots = sigArea.querySelectorAll('.pp-signature-img-slot');
      slot = slots.length ? slots[slots.length - 1] : null;   /* fallback: o último */
    }
    if (!slot) return;
    const jaTemAssinatura = !!slot.querySelector('img');
    if (!id) {
      /* Só limpa se foi o usuário que escolheu "— sem carimbo —" */
      if (acionadoPeloUsuario) slot.innerHTML = '';
      return;
    }
    /* Na abertura automática do preview, respeita assinatura já presente
       (desenhada/carimbada no formulário) — não sobrescreve. */
    if (!acionadoPeloUsuario && jaTemAssinatura) return;
    /* Busca em anestesistas e cirurgiões */
    let profissional = store.getById('cad_anestesistas', id) || store.getById('cad_cirurgioes', id);
    if (profissional && profissional.carimbo) {
      slot.innerHTML = `<img src="${profissional.carimbo}" alt="">`;
    } else if (acionadoPeloUsuario) {
      slot.innerHTML = '';
    }
  },
  _infoLabel(mod) {
    const labels = {
      pre: 'Avaliação pré-anestésica',
      consulta: 'Consulta / Dor',
      anestesia: 'Ficha de Anestesia',
      recuperacao: 'Recuperação pós-anestésica',
      documentos: 'Documento médico',
      financeiro: 'Conciliação financeira',
      agenda: 'Agenda',
      dashboard: 'Dashboard'
    };
    return labels[mod] || '';
  },

  /* Helpers de construção HTML
     opts.semProfissional = não repete nome/CRM no topo. Usado na ficha de
     anestesia e na SRPA: a logo já identifica o serviço e a assinatura no
     rodapé traz o profissional — no topo era repetição. */
  _header(titulo, subtitulo, opts = {}) {
    /* Identidade do profissional a partir do carimbo/cadastro ativo, se houver */
    let prof = {};
    try {
      const ativa = ajustes.perfilAtivo();
      if (ativa) prof = ativa;
    } catch (e) {}
    const nomeProf = opts.semProfissional ? '' : (prof.nomeProfissional || '');
    const linhaReg = [];
    if (prof.especialidade) linhaReg.push(prof.especialidade);
    if (prof.crm) linhaReg.push('CRM ' + prof.crm);
    if (prof.rqe) linhaReg.push('RQE ' + prof.rqe);
    /* Lado esquerdo: a CLÍNICA (logo + nome + contato). Lado direito: o
       PROFISSIONAL. São coisas diferentes e o papel precisa das duas. */
    const daClinica = clinicaIdentidade.cabecalhoHTML();
    return `
      <div class="pp-header">
        <div class="pp-header-top">
          <div class="pp-ident">
            ${logoUsuario.daClinica() ? `<img class="pp-logo" src="${logoUsuario.daClinica()}" alt="">` : ''}
            ${daClinica}
          </div>
          ${nomeProf ? `<div class="pp-prof">
            <div class="pp-prof-nome">${utils.escapeHTML(nomeProf)}</div>
            ${linhaReg.length ? `<div class="pp-prof-reg">${utils.escapeHTML(linhaReg.join(' · '))}</div>` : ''}
            ${prof.endereco ? `<div class="pp-prof-end">${utils.escapeHTML(prof.endereco)}</div>` : ''}
          </div>` : ''}
        </div>
        <div class="pp-doc-title">
          <h1>${utils.escapeHTML(titulo)}</h1>
          ${subtitulo ? `<div class="pp-doc-meta">${subtitulo}</div>` : ''}
        </div>
      </div>
    `;
  },
  _field(label, value, blockMode = false, sempre = false) {
    /* Por padrão, OMITE o campo se valor for vazio.
       Passe sempre=true para forçar mostrar com "—". */
    if (!sempre && (value === null || value === undefined || String(value).trim() === '' || value === '—')) {
      return '';
    }
    const v = value || '—';
    if (blockMode) {
      return `<div class="pp-block"><span class="pp-label">${utils.escapeHTML(label)}</span><span class="pp-value">${utils.escapeHTML(v)}</span></div>`;
    }
    return `<div class="pp-field"><span class="pp-label">${utils.escapeHTML(label)}:</span><span class="pp-value">${utils.escapeHTML(v)}</span></div>`;
  },
  /* Versão que SEMPRE mostra (usado em campos obrigatórios como nome/data) */
  _fieldSempre(label, value, blockMode = false) {
    return printPreview._field(label, value, blockMode, true);
  },
  /* Débito urinário em mL/kg/h para a impressão da anestesia.
     Usa o volume da diurese (painel ou campo do balanço), o peso e o tempo. */
  /* A ficha impressa usa a MESMA conta do painel (anestesia.diurese.calcular).
     Antes cada um fazia a sua, e as duas podiam discordar — a impressão dividia
     pelo tempo inteiro da anestesia mesmo quando a última aferição foi bem
     antes do fim. */
  _debitoUrinario(d) {
    try {
      const di = ((d.monitorizacao || {}).diurese) || {};
      const peso = parseFloat((d.paciente || {}).peso);
      const t = d.tempos || {};
      const ini = t.hora_inicio || (d.procedimento || {}).hora_inicio || d.hora_inicio ||
                  t.hora_sala_entrada || '';
      const fim = t.hora_fim || (d.procedimento || {}).hora_fim || d.hora_fim || '';
      const c = anestesia.diurese.calcular(di, peso, ini, fim, '');
      let vol = c.vol;
      if (!vol) vol = parseFloat((d.fluidos || {}).diurese) || 0;
      if (!vol) return '';
      if (!peso) return Math.round(vol) + ' mL (sem peso)';
      if (c.mlkgh == null) return Math.round(vol) + ' mL (tempo n/d)';
      const janela = (c.ini && c.fim) ? ' — ' + c.ini + '→' + c.fim : '';
      return c.mlkgh.toFixed(2).replace('.', ',') + ' mL/kg/h (' +
             Math.round(vol) + ' mL em ' + anestesia.diurese._fmtDur(c.min) + janela + ')';
    } catch (e) { return ''; }
  },
  /* Sinais vitais e medidas (peso, altura, IMC, PA, FC, FR, SpO2, Temp, Dor) — só preenchidos */
  _vitaisPre(d) {
    const vitais = [
      ['Peso', d.peso ? d.peso + ' kg' : ''], ['Altura', d.altura ? d.altura + ' cm' : ''], ['IMC', d.imc],
      ['Peso ideal / corrigido', d.peso_ideal],
      ['PA', d.pa], ['FC', d.fc ? d.fc + ' bpm' : ''], ['FR', d.fr ? d.fr + ' irpm' : ''],
      ['SpO₂', d.spo2 ? d.spo2 + '%' : ''], ['Temp', d.temp ? d.temp + '°C' : ''], ['Dor', d.dor]
    ];
    const preenchidos = vitais.filter(([, v]) => v && String(v).trim() !== '');
    if (!preenchidos.length) return '';
    const cells = preenchidos.map(([k, v]) =>
      `<div class="pp-lab-item"><span class="pp-lab-k">${utils.escapeHTML(k)}</span> <span class="pp-lab-v">${utils.escapeHTML(v)}</span></div>`
    ).join('');
    return `<div class="pp-block"><span class="pp-label">Sinais vitais e medidas</span><div class="pp-lab-grid">${cells}</div></div>`;
  },
  /* VIA AÉREA NA IMPRESSÃO
     Na tela o resumo é detalhado (Mallampati, preditores e a conduta a
     preparar). No papel o que importa é a ADVERTÊNCIA: quem lê precisa saber
     que a via aérea pode ser difícil — o preparo (videolaringoscópio, bougie,
     plano B/C) é decisão do anestesista na hora, não informação do documento. */
  _viaAereaImpressa(texto) {
    const t = String(texto || '').trim();
    if (!t) return '';
    /* só o alerta conta: "Sem preditores maiores de via aérea difícil" também
       contém a expressão, e é o contrário do aviso */
    if (t.indexOf('⚠') >= 0 || /potencialmente\s+dif[íi]cil/i.test(t)) return '⚠ Possível via aérea difícil';
    /* via aérea favorável: mantém o texto, sem a parte de preparo */
    return t.replace(/\s*[—-]\s*preparar\s+plano[^.]*\.?/i, '').trim();
  },
  /* "Resultado — realizado em dd/mm/aaaa": a data do exame importa tanto
     quanto o resultado (um exame de 8 meses atrás não vale o de ontem). */
  _comData(texto, data) {
    const t = String(texto || '').trim();
    const dt = data ? utils.formatarData(data) : '';
    if (!t) return dt ? '(realizado em ' + dt + ')' : '';
    return dt ? t + '  —  realizado em ' + dt : t;
  },
  /* Grade de exames laboratoriais (estilo ficha de referência) — só imprime os preenchidos */
  _labGrid(d) {
    const labs = [
      ['Hb', d.lab_hb], ['Ht', d.lab_ht], ['Hm', d.lab_hm], ['Leuco', d.lab_leuco], ['Plt', d.lab_plt], ['Fibrin.', d.lab_fibrinogenio],
      ['TC', d.lab_tc], ['TS', d.lab_ts], ['TP', d.lab_tp], ['INR', d.lab_inr], ['TTPa', d.lab_ttpa], ['Ativ Prot', d.lab_ativprot],
      ['Uréia', d.lab_ureia], ['Creat', d.lab_creat], ['Na', d.lab_na], ['K', d.lab_k], ['Ca', d.lab_ca], ['Mg', d.lab_mg],
      ['Glicemia', d.lab_glicemia], ['HbA1c', d.lab_hba1c], ['TSH', d.lab_tsh], ['T4 livre', d.lab_t4l], ['AST/TGO', d.lab_ast], ['ALT/TGP', d.lab_alt], ['Bilirr.', d.lab_bilirrubinas], ['Proteínas', d.lab_proteinas]
    ];
    /* inclui exames extras (campo livre) */
    (d._labExtras || []).forEach(x => { if (x && (x.label || x.valor)) labs.push([x.label || '—', x.valor]); });
    const preenchidos = labs.filter(([, v]) => v && String(v).trim() !== '');
    if (!preenchidos.length) return '';
    const cells = preenchidos.map(([k, v]) =>
      `<div class="pp-lab-item"><span class="pp-lab-k">${utils.escapeHTML(k)}</span> <span class="pp-lab-v">${utils.escapeHTML(v)}</span></div>`
    ).join('');
    return `<div class="pp-block"><span class="pp-label">Exames laboratoriais</span><div class="pp-lab-grid">${cells}</div></div>`;
  },
  _section(title, content) {
    /* Omite seções vazias */
    if (!content || String(content).trim() === '') return '';
    /* Se for só HTML mas sem texto real (só tags), também omite */
    const text = String(content).replace(/<[^>]*>/g, '').trim();
    if (!text) return '';
    return `<h2>${utils.escapeHTML(title)}</h2>${content}`;
  },
  _signature(nomeProf, registro, dadosForm = null) {
    /* Versão unificada: se receber dadosForm (objeto com assinatura_dataurl,
       assinatura_tipo, data_assinatura), usa o carimbo/desenho gravado.
       Caso contrário, faz fallback para busca do carimbo pelo nome do profissional. */
    let imgHTML = '';
    let dataAssin = '';
    if (dadosForm && dadosForm.assinatura_dataurl) {
      imgHTML = `<img src="${dadosForm.assinatura_dataurl}" alt="">`;
      dataAssin = dadosForm.data_assinatura || '';
    } else if (nomeProf) {
      const p = utils.getCarimboDoProfissional(nomeProf);
      if (p && p.carimbo) imgHTML = `<img src="${p.carimbo}" alt="">`;
    }
    const linha = (nomeProf || '_____________________________') + (registro ? '\n' + registro : '');
    const selo = dadosForm ? printPreview._icpSelo(dadosForm.assinatura_meta) : '';
    return `
      <div class="pp-signature-area">
        <div class="pp-signature pp-signature-prof">
          <div class="pp-signature-img-slot">${imgHTML}</div>
          <div style="white-space:pre-line">${utils.escapeHTML(linha)}</div>
          ${dataAssin ? `<div style="font-size:8pt;color:#666;margin-top:2px">${utils.escapeHTML(dataAssin)}</div>` : ''}
          ${selo}
        </div>
      </div>
    `;
  },
  /* Selo textual de assinatura ICP-Brasil para impressão (a partir do meta salvo) */
  _icpSelo(metaRaw) {
    let m = metaRaw;
    try { if (typeof metaRaw === 'string') m = metaRaw ? JSON.parse(metaRaw) : null; } catch (e) { m = null; }
    if (!m || m.tipo !== 'icp') return '';
    const dt = String(m.ts || '').replace('T', ' ').slice(0, 16);
    let qr = '';
    try { if (m.validar && window.SoftQR) qr = window.SoftQR.svg(m.validar, { px: 88, ecl: 'M' }); } catch (e) { qr = ''; }
    const qrCol = qr
      ? `<div style="flex:0 0 auto;text-align:center"><div style="background:#fff;border:1px solid #cfe8d8;padding:2px;display:inline-block">${qr}</div><div style="font-size:6pt;color:#3b7a5a;margin-top:1px">Aponte a câmera</div></div>`
      : '';
    const info = `<div style="flex:1 1 auto;min-width:0">` +
      `✔ Assinado digitalmente com certificado ICP-Brasil` + (m.arquivo ? ' — ' + utils.escapeHTML(m.arquivo) : '') +
      (m.assinante ? '<br>Assinante: ' + utils.escapeHTML(m.assinante) : '') +
      (dt ? '<br>Registro: ' + utils.escapeHTML(dt) : '') +
      `<br>SHA-256: <span style="font-family:monospace;word-break:break-all">${utils.escapeHTML((m.hash || '').slice(0, 48))}…</span>` +
      (m.codigo ? `<br>Código de validação: <b>${utils.escapeHTML(m.codigo)}</b>` : '') +
      (m.validar ? `<br>Validar em: ${utils.escapeHTML(m.validar)}` : '') +
      `<br>Cadeia ICP-Brasil verificável em validar.iti.gov.br</div>`;
    return `<div style="margin-top:4px;font-size:7.5pt;color:#1c6b3f;border:1px solid #b9e0c6;background:#eaf7ef;border-radius:4px;padding:4px 6px;line-height:1.35;text-align:left;display:flex;gap:8px;align-items:flex-start">` +
      qrCol + info + `</div>`;
  },
  _footer(label) {
    return `<div class="pp-footer">
      <span>${utils.escapeHTML(label)} · Impresso em ${new Date().toLocaleString('pt-BR')}${printPreview._versaoStamp()}</span>
      <span class="pp-footer-credit">Soft Anestesia · desenvolvido por Marcelo Pandolfi Caliman</span>
    </div>`;
  },
  /* Carimbo de versão do documento no rodapé (rastreabilidade médico-legal).
     Lê o registro salvo pelo _id do formulário atual (definido em abrir()). */
  _verCtx: null,
  _versaoStamp() {
    try {
      const ctx = printPreview._verCtx;
      if (!ctx || !ctx.mod || !ctx.formId) return '';
      const f = document.getElementById(ctx.formId);
      if (!f) return '';
      const id = (f.querySelector('[name="_id"]') || {}).value || '';
      if (!id) return ' · <strong>Rascunho não salvo</strong>';
      const rec = store.getById(ctx.mod, id);
      if (!rec) return '';
      const rev = rec._rev || 1;
      const status = rec._finalizado ? 'Finalizado' : 'Rascunho';
      const quando = rec._updatedAt ? new Date(rec._updatedAt).toLocaleString('pt-BR') : '';
      const cod = String(id).slice(-6).toUpperCase();
      return ' · Doc ' + cod + ' · Rev. ' + rev + ' · ' + status + (quando ? ' em ' + quando : '');
    } catch (e) { return ''; }
  },

  /* === Builders por módulo === */
  _buildPre() {
    const d = utils.formData('form-pre');
    try { d._labExtras = labExtra.coletar('pre-lab-extras'); } catch (e) {}
    /* Nome do paciente — tolerante a chaves alternativas para nunca sair vazio */
    const nomePac = (d.nome || d.paciente_nome || d.paciente || '').trim();
    /* Topo: só o título. O nome do paciente aparece uma vez, na identificação
       (antes vinha também sob o título) — e ganha a linha inteira, para nome
       comprido não quebrar em duas. */
    /* pp-compacto: fonte e logomarca menores neste documento (ver CSS) */
    return '<div class="pp-compacto">' +
      printPreview._header('AVALIAÇÃO PRÉ-ANESTÉSICA', '') +
      printPreview._section('Identificação', `
        <div class="pp-grid cols-1">
          ${printPreview._fieldSempre('Nome', nomePac)}
        </div>
        <div class="pp-grid cols-3">
          ${printPreview._field('Nascimento', utils.formatarData(d.nasc))}
          ${printPreview._field('Idade', d.idade)}
          ${printPreview._field('Sexo', d.sexo)}
          ${printPreview._field('Data avaliação', utils.formatarData(d.data))}
          ${printPreview._field('Senha / Autorização', d.senha)}
        </div>
        <div class="pp-grid">
          ${printPreview._field('Cirurgia', d.cirurgia)}
          ${printPreview._field('Cirurgião', d.cirurgiao)}
          ${printPreview._field('Hospital', d.hospital)}
        </div>
      `) +
      printPreview._section('Anamnese', `
        ${printPreview._field('Comorbidades', d.comorbidades, true)}
        ${printPreview._field('Alergias', d.alergias, true)}
        ${printPreview._field('Medicações em uso', d.medicacoes, true)}
        ${printPreview._field('Cirurgias prévias', d.cirurgias_previas, true)}
        ${printPreview._field('Antecedentes anestésicos', d.antecedentes, true)}
      `) +
      printPreview._section('Sinais vitais e exames', `
        ${printPreview._vitaisPre(d)}
        ${printPreview._field('Exame físico', d.exame_fisico, true)}
        ${printPreview._labGrid(d)}
        ${printPreview._field('Data dos exames laboratoriais', utils.formatarData(d.lab_data))}
        ${printPreview._field('ECG', printPreview._comData(d.lab_ecg, d.lab_ecg_data), true)}
        ${printPreview._field('ECO', printPreview._comData(d.lab_eco, d.lab_eco_data), true)}
        ${printPreview._field('Outros exames', printPreview._comData(d.exames_compl, d.exames_compl_data), true)}
      `) +
      printPreview._section('Pareceres de outras clínicas', `
        ${printPreview._field('Cardiológico / risco cardíaco', d.parecer_cardio, true)}
        ${printPreview._field('Pneumológico', d.parecer_pneumo, true)}
        ${printPreview._field('Outros pareceres', d.parecer_outros, true)}
      `) +
      printPreview._section('Classificação de risco', `
        <div class="pp-grid">
          ${printPreview._field('Classificação ASA', d.asa)}
          ${printPreview._field('Risco', d.risco)}
        </div>
        ${printPreview._field('Via aérea', printPreview._viaAereaImpressa(d.via_aerea_resumo || d.via_aerea), true)}
        ${printPreview._field('Resultado dos escores de risco', d.risco_resumo, true)}
      `) +
      printPreview._blocoRiscoPre(d) +
      printPreview._section('Conclusões e orientações', `
        ${printPreview._field('Jejum', d.jejum)}
        ${printPreview._field('Orientação de jejum ao paciente', d.jejum_orientacao, true)}
        ${printPreview._field('Prescrição pré-anestésica (pré-medicação)', d.medicacao_pre, true)}
        ${printPreview._field('Orientações', d.orientacoes, true)}
        ${printPreview._field('Conclusão', d.conclusao, true)}
      `) +
      printPreview._signature(d.anestesiologista, d.crm ? 'CRM ' + d.crm : '', d) +
      printPreview._footer('Avaliação pré-anestésica') +
      printPreview._buildProtocoloJejumAnexo(d) +
      '</div>';
  },

  /* Cartõezinhos ilustrados de alimentos (emoji + nome) para o anexo — estilos
     inline para funcionar tanto na pré-visualização quanto na impressão. */
  _jejumChips(lista, tipo) {
    if (!lista || !lista.length) return '';
    const evit = tipo === 'evitar';
    const bg = evit ? '#fdecea' : '#eef7f0';
    const bd = evit ? '#f3c6c0' : '#cfe3d4';
    const lblColor = evit ? '#c0392b' : '#2e7d52';
    const lblTxt = evit ? '✗ Não consuma' : '✓ Permitido';
    const chips = lista.map(it =>
      `<span style="display:inline-flex;flex-direction:column;align-items:center;width:64px;border:1px solid ${bd};background:${bg};border-radius:8px;padding:4px 2px;text-align:center;-webkit-print-color-adjust:exact;print-color-adjust:exact">` +
      JEJUM_SVG.icon(it[0], 26) +
      `<span style="font-size:7.5pt;color:#333;margin-top:2px;line-height:1.1">${utils.escapeHTML(it[1])}</span></span>`
    ).join('');
    return `<div style="font-size:7.5pt;font-weight:700;text-transform:uppercase;letter-spacing:.3px;color:${lblColor};margin:5px 0 3px">${lblTxt}</div>` +
      `<div style="display:flex;flex-wrap:wrap;gap:4px">${chips}</div>`;
  },
  /* Segundo documento (anexo): protocolo de jejum pré-operatório detalhado.
     Só aparece se marcado na avaliação; usa a identificação do paciente. */
  _buildProtocoloJejumAnexo(d) {
    if (!d || !d.jejum_protocolo_incluir) return '';
    const m = protocoloJejum.calcular(d.idade, d.jejum_protocolo_datahora, (d.jejum_protocolo_carbo || 'sim') === 'sim');
    if (!m.ok) return '';
    const dataProcTxt = m.data ? protocoloJejum.fmt(m.data) : '—';
    const meta = `<strong>Paciente:</strong> ${utils.escapeHTML(d.nome || '—')} &nbsp;·&nbsp; ` +
      `<strong>Idade:</strong> ${utils.escapeHTML(d.idade || '—')} &nbsp;·&nbsp; ` +
      `<strong>Protocolo:</strong> ${utils.escapeHTML(m.protoNome)} &nbsp;·&nbsp; ` +
      `<strong>Procedimento:</strong> ${utils.escapeHTML(dataProcTxt)}`;
    const tabela = m.itens.map(it => {
      const alvo = it.limite ? protocoloJejum.fmt(it.limite) : ('Até ' + it.horas + 'h antes');
      return `<div style="border:1px solid #d0d5db;border-radius:8px;padding:8px 10px;margin-bottom:7px;page-break-inside:avoid">` +
        `<div style="display:flex;justify-content:space-between;align-items:center;gap:8px">` +
          `<span style="font-weight:700;font-size:10.5pt;color:#1a2332;display:inline-flex;align-items:center;gap:6px">${JEJUM_SVG.icon(it.icon, 20)}<span>${utils.escapeHTML(it.nome)}</span></span>` +
          `<span style="font-weight:700;font-size:11pt;color:#2e7d52;white-space:nowrap">${utils.escapeHTML(alvo)}</span>` +
        `</div>` +
        printPreview._jejumChips(it.ok, 'ok') +
        printPreview._jejumChips(it.evitar, 'evitar') +
        (it.nota ? `<div style="font-size:8pt;color:#666;font-style:italic;margin-top:4px">${utils.escapeHTML(it.nota)}</div>` : '') +
      `</div>`;
    }).join('');
    const soLeiteMsg = m.soLeite
      ? `<div class="pp-block"><span class="pp-value">Abaixo de 6 meses: apenas leite materno ou fórmula infantil; as demais categorias não se aplicam.</span></div>`
      : '';
    const orient = m.soLeite ? '' : printPreview._section('Orientações gerais',
      `<div class="pp-block"><span class="pp-value" style="white-space:pre-line">${utils.escapeHTML(
        '• Higiene oral liberada: escovar os dentes e fazer bochecho/gargarejo é permitido, desde que não engula a água ou o enxaguante.\n' +
        '• Não consumir bebida alcoólica nos dias que antecedem o procedimento.\n' +
        '• Preferir refeições mais leves e não inflamatórias nas 24–48h anteriores (menos gordura, fritura, açúcar e ultraprocessados).\n' +
        '• Tabagismo: o ideal é interromper pelo menos 1 mês antes.\n' +
        '• Drogas ilícitas não devem ser usadas.\n' +
        '• Medicações GLP-1/GIP (ex.: Ozempic, Mounjaro): informe ao anestesista — retardam o esvaziamento gástrico e implicam diretamente no jejum.\n' +
        '• Suplementos: whey/shake proteico — evitar no jejum; creatina — suspender no dia; ômega-3/óleo de peixe — suspender ≥ 5 dias antes; ginkgo, ginseng, alho, kava kava e pariri — suspender dias antes (coagulação).'
      )}</span></div>`);
    const aviso = `<div class="pp-block"><span class="pp-value" style="font-size:9pt;color:#666">Ferramenta de apoio clínico. A decisão final considera protocolo institucional, avaliação anestésica, tipo de cirurgia, risco de aspiração e sintomas gastrointestinais.</span></div>`;
    return `<div class="pp-anexo" style="page-break-before:always">` +
      printPreview._header('PROTOCOLO DE JEJUM PRÉ-OPERATÓRIO', meta) +
      printPreview._section('Planejamento personalizado — até quando consumir', tabela + soLeiteMsg) +
      orient +
      aviso +
      printPreview._footer('Protocolo de jejum pré-operatório') +
      `</div>`;
  },

  /* Inclui o resumo de risco na impressão da Pré, se houver cálculo vinculado
     marcado para impressão (só os percentuais — compacto). */
  _blocoRiscoPre(dPre) {
    try {
      const f = document.getElementById('form-pre');
      const preId = f && f.querySelector('[name="_id"]') ? f.querySelector('[name="_id"]').value : '';
      if (!preId) return '';
      /* procura um cálculo de risco vinculado a esta pré (link por objeto _links) */
      const todos = store.list('risco');
      let alvo = null;
      for (const r of todos) {
        const links = r._links || {};
        if (links.pre_id === preId) { alvo = r; break; }
      }
      /* Fallback seguro para registros novos: caso explícito ou identidade
         forte escolhida. Nome isolado nunca injeta o risco de um homônimo na
         impressão da pré. Se houver mais de um candidato, não adivinha. */
      if (!alvo) {
        const caso = linker.contextoCaso('pre');
        const paciente = linker.contextoPaciente('pre');
        let candidatos = caso.caseId
          ? todos.filter(r => r && r._caseId === caso.caseId)
          : paciente.identityKey
            ? todos.filter(r => linker._chavePaciente(r) === paciente.identityKey)
            : paciente.patientRef
              ? todos.filter(r => r && r._patientRef === paciente.patientRef)
              : [];
        if (candidatos.length === 1) alvo = candidatos[0];
      }
      if (!alvo || !alvo.incluir_impressao || !alvo._resumo) return '';
      const tabela = risco.resumoCompactoHTML({ _resumo: alvo._resumo });
      if (!tabela) return '';
      return printPreview._section('Estimativa de risco perioperatório', tabela +
        '<p style="font-size:8pt;color:#777;margin-top:6px">Índice composto de apoio (ref.: ACS NSQIP / SORT). Não substitui julgamento clínico.</p>');
    } catch (e) { return ''; }
  },

  _buildConsulta() {
    const d = utils.formData('form-consulta');
    try { d._labExtras = labExtra.coletar('consulta-lab-extras'); } catch (e) {}
    let segs = [];
    try { segs = consulta.seguimento.coletar(); } catch (e) {}
    /* Calcula retorno conforme tipo */
    let retornoDesc = '—';
    if (d.retorno_tipo === 'data' && d.retorno) retornoDesc = utils.formatarData(d.retorno);
    else if (d.retorno_tipo === 'texto' && d.retorno_texto) retornoDesc = 'Em ' + d.retorno_texto;
    else if (d.retorno_tipo === 'sem') retornoDesc = 'Sem retorno previsto';
    else if (d.retorno) retornoDesc = utils.formatarData(d.retorno);  /* legacy */
    const meta = `${utils.formatarData(d.data) || new Date().toLocaleDateString('pt-BR')}`;
    /* Seção de seguimentos (consultas de retorno), da mais recente para a mais antiga */
    let segHtml = '';
    const segValidos = (segs || []).filter(s => (s.texto && s.texto.trim()) || (s.eva != null && s.eva !== ''));
    if (segValidos.length) {
      const linhas = segValidos
        .slice()
        .sort((a, b) => new Date(b.data || 0) - new Date(a.data || 0))
        .map(s => {
          const evaTxt = (s.eva != null && s.eva !== '') ? ' [EVA ' + s.eva + '/10]' : '';
          return `<div class="pp-field" style="margin-bottom:6px"><span class="pp-label">${utils.escapeHTML(s.data ? utils.formatarData(s.data) : 'Seguimento')}${utils.escapeHTML(evaTxt)}:</span><span class="pp-value">${utils.escapeHTML((s.texto || '').trim() || '—')}</span></div>`;
        })
        .join('');
      segHtml = printPreview._section('Seguimento / Acompanhamento', linhas);
    }
    /* Procedimentos realizados: o documento tem de dizer o que foi feito, com
       o código. Fração e valor são conta interna e ficam fora da impressão. */
    let procHtml = '';
    let procs = [];
    try { procs = consulta.procs.coletar(); } catch (e) {}
    const procValidos = procs.filter(p => p.codigo || p.descricao);
    if (procValidos.length) {
      procHtml = printPreview._section('Procedimentos realizados nesta consulta',
        procValidos.map(p => {
          const qtd = (p.quantidade > 1) ? ' ×' + p.quantidade : '';
          const obs = p.observacao ? ' — ' + p.observacao : '';
          return '<div class="pp-field" style="margin-bottom:4px"><span class="pp-label">' +
            utils.escapeHTML(p.codigo || '—') + ':</span><span class="pp-value">' +
            utils.escapeHTML((p.descricao || '') + qtd + obs) + '</span></div>';
        }).join(''));
    }
    return printPreview._header('CONSULTA / AVALIAÇÃO DE DOR', meta) +
      printPreview._section('Identificação', `
        <div class="pp-grid cols-3">
          ${printPreview._field('Nome', d.nome)}
          ${printPreview._field('Idade', d.idade)}
          ${printPreview._field('Sexo', d.sexo)}
          ${printPreview._field('Convênio', d.convenio)}
          ${printPreview._field('Local', d.local)}
          ${printPreview._field('Data', utils.formatarData(d.data))}
          ${printPreview._field('Senha / Autorização', d.senha)}
        </div>
      `) +
      printPreview._section('Anamnese', `
        ${printPreview._field('Queixa principal', d.queixa, true)}
        ${printPreview._field('HDA', d.hda, true)}
        ${printPreview._field('Antecedentes', d.antecedentes, true)}
        ${printPreview._field('Medicações em uso', d.medicacoes, true)}
        ${printPreview._field('Alergias', d.alergias, true)}
      `) +
      printPreview._section('Exame e conduta', `
        ${printPreview._field('Exame físico', d.exame_fisico, true)}
        ${printPreview._labGrid(d)}
        ${printPreview._field('Data dos exames laboratoriais', utils.formatarData(d.lab_data))}
        ${printPreview._field('ECG', printPreview._comData(d.lab_ecg, d.lab_ecg_data), true)}
        ${printPreview._field('ECO', printPreview._comData(d.lab_eco, d.lab_eco_data), true)}
        ${printPreview._field('Outros exames', printPreview._comData(d.exames_compl, d.exames_compl_data), true)}
        ${printPreview._field('Hipótese diagnóstica', d.hipotese, true)}
        ${printPreview._field('Conduta', d.conduta, true)}
        ${printPreview._field('Prescrição / orientações', d.prescricao, true)}
        <div class="pp-grid">
          ${printPreview._field('Retorno', retornoDesc)}
          ${printPreview._field('Observações', d.observacoes)}
        </div>
      `) +
      procHtml +
      segHtml +
      printPreview._signature(d.profissional, d.crm ? 'CRM ' + d.crm : '', d) +
      printPreview._footer('Consulta');
  },

  _buildAnestesia() {
    const d = anestesia.coletarEstruturado();
    const p = d.paciente, pr = d.procedimento, pa = d.pre_anestesico, tc = d.tecnica, mn = d.monitorizacao;
    /* Topo enxuto: logo à esquerda e, centralizado, só o título. Paciente,
       data e procedimento ficam nas seções de identificação/procedimento —
       repetir tudo no cabeçalho só ocupava a primeira página. */
    let html = printPreview._header('FICHA DE ANESTESIA', '', { semProfissional: true });
    html += printPreview._section('Identificação do paciente', `
      <div class="pp-grid cols-3">
        ${printPreview._field('Nome', p.nome)}
        ${printPreview._field('Nascimento', utils.formatarData(p.nascimento))}
        ${printPreview._field('Idade', p.idade)}
        ${printPreview._field('Sexo', p.sexo)}
        ${printPreview._field('Nome da mãe', p.nome_mae)}
        ${printPreview._field('Peso', p.peso ? p.peso + ' kg' : '')}
        ${printPreview._field('Altura', p.altura ? p.altura + ' cm' : '')}
        ${printPreview._field('IMC', p.imc)}
        ${printPreview._field('Prontuário', p.prontuario)}
        ${printPreview._field('Convênio', p.convenio)}
        ${printPreview._field('Carteirinha', p.carteirinha)}
        ${printPreview._field('Senha / Autorização', p.senha)}
        ${printPreview._field('Procedência / acomodação', p.acomodacao)}
      </div>
    `);
    /* O procedimento começa quando o paciente ENTRA na sala e termina quando
       SAI dela — é esse o tempo que vale para o convênio e para o hospital.
       Anestesia e cirurgia entram logo abaixo, como detalhamento. */
    const durEntre = printPreview._durEntre;
    const tSala = durEntre(pr.hora_sala_entrada, pr.hora_sala_saida);
    const tAnest = pr.duracao || durEntre(pr.hora_inicio, pr.hora_fim);
    const tCir = pr.duracao_cir || durEntre(pr.hora_cir_inicio, pr.hora_cir_fim);
    html += printPreview._section('Procedimento', `
      <div class="pp-grid cols-3">
        ${printPreview._field('Cirurgião', pr.cirurgiao)}
        ${printPreview._field('Auxiliares', (pr.auxiliares || []).join(', '))}
        ${printPreview._field('Hospital', pr.hospital)}
        ${printPreview._field('Sala', pr.sala)}
        ${printPreview._field('Data', utils.formatarData(pr.data))}
      </div>
      ${printPreview._field('Procedimento', cirurgia.texto({
        codigo: pr.codigo, descricao: pr.descricao, lateralidade: pr.lateralidade, quantidade: 1
      }) || pr.descricao, true)}
      ${(pr.cirurgias_extra || []).length
        ? printPreview._field('Procedimentos adicionais', cirurgia.textoLista(pr.cirurgias_extra), true)
        : ''}
      <div class="pp-grid cols-3">
        ${printPreview._field('Início (entrada em sala)', pr.hora_sala_entrada, false, true)}
        ${printPreview._field('Término (saída de sala)', pr.hora_sala_saida, false, true)}
        ${printPreview._field('Duração do procedimento', tSala, false, true)}
        ${printPreview._field('Início da anestesia', pr.hora_inicio)}
        ${printPreview._field('Fim da anestesia', pr.hora_fim)}
        ${printPreview._field('Duração da anestesia', tAnest)}
        ${printPreview._field('Início da cirurgia', pr.hora_cir_inicio)}
        ${printPreview._field('Fim da cirurgia', pr.hora_cir_fim)}
        ${printPreview._field('Duração da cirurgia', tCir)}
      </div>
    `);
    html += printPreview._section('Pré-anestésico', `
      <div class="pp-grid">
        ${printPreview._field('Diagnóstico', pa.diagnostico)}
        ${printPreview._field('ASA', pa.asa)}
        ${printPreview._field('Jejum', pa.jejum)}
        ${printPreview._field('Glicemia', pa.glicemia)}
        ${printPreview._field('Via aérea', pa.via_aerea)}
      </div>
      ${printPreview._field('Via aérea — observações', pa.via_aerea_obs, true)}
      ${printPreview._field('Alergias', pa.alergias, true)}
      ${printPreview._field('Comorbidades', pa.comorbidades, true)}
      ${printPreview._field('Exames', pa.exames, true)}
      ${printPreview._field('Medicações em uso', pa.medicacoes_uso, true)}
      ${printPreview._field('Medicação pré-anestésica', pa.medicacao_pre, true)}
      ${printPreview._field('Observações', pa.observacoes, true)}
      ${pa.timeout_realizado ? printPreview._field('Time-out', 'Realizado antes da incisão') : ''}
    `);
    html += printPreview._section('Técnica anestésica', `
      <div class="pp-checks">${(tc.tipos || []).map(t => `<span class="pp-check">${utils.escapeHTML(t)}</span>`).join('')}</div>
      ${printPreview._field('Técnica realizada', tc.descricao, true)}
      ${printPreview._field('Indução', tc.inducao, true)}
      ${printPreview._field('Manutenção', tc.manutencao, true)}
      <div class="pp-grid cols-3">
        ${printPreview._field('Via aérea utilizada', tc.via_aerea_uso)}
        ${printPreview._field('Horário', tc.via_aerea_hora)}
        ${printPreview._field('Ventilação', tc.ventilacao_tipo)}
      </div>
      ${printPreview._field('Via aérea — detalhe', tc.via_aerea_detalhe, true)}
      ${printPreview._field('Monitorização', tc.monitorizacao_descricao, true)}
      ${printPreview._field('Equipamentos utilizados', tc.equipamentos, true)}
    `);

    /* === CIRURGIAS COMBINADAS === */
    const cirsExtras = (pr.cirurgias_extra || []).filter(c => c.procedimento || c.cirurgiao);
    if (cirsExtras.length > 0) {
      html += printPreview._section('Cirurgias combinadas / procedimentos adicionais',
        '<table class="pp-table"><thead><tr><th>Procedimento</th><th>Cirurgião</th><th>Grau</th><th>Início</th><th>Fim</th><th>Observação</th></tr></thead><tbody>' +
        cirsExtras.map(c => `
          <tr>
            <td>${utils.escapeHTML(c.procedimento || '')}</td>
            <td>${utils.escapeHTML(c.cirurgiao || pr.cirurgiao || '')}${(!c.cirurgiao && pr.cirurgiao) ? ' <small>(mesma equipe)</small>' : ''}</td>
            <td>${utils.escapeHTML((c.grau || '') ? c.grau + '%' : '')}</td>
            <td>${utils.escapeHTML(c.inicio || '')}</td>
            <td>${utils.escapeHTML(c.fim || '')}</td>
            <td>${utils.escapeHTML(c.obs || '')}</td>
          </tr>
        `).join('') + '</tbody></table>'
      );
    }

    /* === BLOQUEIO REGIONAL / NEUROAXIAL === */
    const bl = tc.bloqueio || {};
    if (bl.realizado || bl.tipo || (bl.medicacoes && bl.medicacoes.length > 0)) {
      let blqHTML = `<div class="pp-grid cols-3">
        ${printPreview._field('Tipo', bl.tipo)}
        ${printPreview._field('Horário da punção', bl.hora)}
        ${printPreview._field('Espaço / local', bl.espaco)}
        ${printPreview._field('Lado', bl.lado)}
        ${printPreview._field('Posição', bl.posicao)}
        ${printPreview._field('Agulha', bl.agulha)}
        ${printPreview._field('Calibre', bl.calibre)}
        ${printPreview._field('Tentativas', bl.tentativas)}
        ${printPreview._field('Punção', bl.puncao)}
        ${printPreview._field('Refluxo de líquor', bl.liquor)}
      </div>`;
      /* Medicações do bloqueio */
      const blMeds = (bl.medicacoes || []).filter(m => m.nome);
      if (blMeds.length > 0) {
        blqHTML += '<h3 style="font-size:9pt;margin:8px 0 4px">Medicações do bloqueio</h3>' +
          '<table class="pp-table"><thead><tr><th>Hora</th><th>Medicação</th><th>Dose</th><th>Unid</th><th>Via</th><th>Obs</th></tr></thead><tbody>' +
          blMeds.map(m => `
            <tr>
              <td>${utils.escapeHTML(m.hora || '')}</td>
              <td>${utils.escapeHTML(m.nome)}</td>
              <td>${utils.escapeHTML(m.dose || '')}</td>
              <td>${utils.escapeHTML(m.unidade || '')}</td>
              <td>${utils.escapeHTML(m.via || '')}</td>
              <td>${utils.escapeHTML(m.obs || '')}</td>
            </tr>
          `).join('') + '</tbody></table>';
      }
      /* USG */
      const usg = bl.usg || {};
      if (usg.usado || usg.transdutor || usg.tecnica) {
        blqHTML += '<h3 style="font-size:9pt;margin:8px 0 4px">Ultrassom guiado</h3>' +
          `<div class="pp-grid cols-3">
            ${printPreview._field('Transdutor', usg.transdutor)}
            ${printPreview._field('Técnica', usg.tecnica)}
            ${printPreview._field('Estruturas', usg.estruturas)}
          </div>` +
          /* o card grava em "observacoes"; "obs" é o formato antigo */
          printPreview._field('Observações USG', usg.observacoes || usg.obs, true);
      }
      if (bl.observacoes) blqHTML += printPreview._field('Observações do bloqueio', bl.observacoes, true);
      html += printPreview._section('Bloqueio regional / neuroaxial', blqHTML);
    }

    /* === CATETERES E ACESSOS INVASIVOS === */
    const cateteres = (bl.cateteres || []).filter(c => c.tipo || c.local);
    if (cateteres.length > 0) {
      html += printPreview._section('Cateteres e acessos invasivos',
        '<table class="pp-table"><thead><tr><th>Tipo</th><th>Local</th><th>Técnica</th><th>Tent.</th><th>USG</th><th>Complicações</th></tr></thead><tbody>' +
        cateteres.map(c => `
          <tr>
            <td>${utils.escapeHTML(c.tipo || '')}</td>
            <td>${utils.escapeHTML(c.local || '')}</td>
            <td>${utils.escapeHTML(c.tecnica || '')}</td>
            <td>${utils.escapeHTML(c.tentativas || '')}</td>
            <td>${utils.escapeHTML(c.usg || '')}</td>
            <td>${utils.escapeHTML(c.complicacoes || '')}</td>
          </tr>
        `).join('') + '</tbody></table>'
      );
    }

    /* === VENTILAÇÃO DETALHADA ===
       Imprime sempre que houver QUALQUER dado de ventilação preenchido,
       mesmo se o radio "modo_geral" não foi marcado. */
    const vt = d.ventilacao || {};
    const espHasData = vt.espontanea && Object.values(vt.espontanea).some(x => x && String(x).trim());
    const mecHasData = vt.mecanica && Object.values(vt.mecanica).some(x => x && String(x).trim());
    const recHasData = Array.isArray(vt.recursos) && vt.recursos.length > 0;
    const terHasData = Array.isArray(vt.terapias) && vt.terapias.some(t => t.modo || t.hora_ini || t.param);
    if (vt.modo_geral || espHasData || mecHasData || recHasData || terHasData) {
      let ventHTML = '';
      /* Mostra TODO bloco que tenha dado. Antes escolhia um só pelo radio, e
         quem ventilou espontâneo no começo e mecânico depois (ou o contrário)
         perdia metade do registro na impressão — dado preenchido que não sai
         é o mesmo que dado perdido. */
      const mostrarEsp = espHasData || vt.modo_geral === 'espontanea';
      const mostrarMec = mecHasData || vt.modo_geral === 'mecanica';
      if (mostrarEsp && vt.espontanea) {
        const e = vt.espontanea;
        ventHTML += `<h3 style="font-size:9pt;margin:0 0 4px">Espontânea</h3>
          <div class="pp-grid cols-3">
            ${printPreview._field('Suporte O₂', e.suporte)}
            ${printPreview._field('FiO₂', e.fio2 ? e.fio2 + '%' : '')}
            ${printPreview._field('Fluxo', e.fluxo ? e.fluxo + ' L/min' : '')}
          </div>
          ${e.obs ? printPreview._field('Observações', e.obs, true) : ''}`;
      }
      if (mostrarMec && vt.mecanica) {
        const m = vt.mecanica;
        ventHTML += `<h3 style="font-size:9pt;margin:0 0 4px">Ventilação mecânica</h3>
          <div class="pp-grid cols-3">
            ${printPreview._field('Modo', m.modo)}
            ${printPreview._field('VC', m.vc ? m.vc + ' mL' : '')}
            ${printPreview._field('FR', m.fr ? m.fr + ' irpm' : '')}
            ${printPreview._field('PEEP', m.peep ? m.peep + ' cmH₂O' : '')}
            ${printPreview._field('FiO₂', m.fio2 ? m.fio2 + '%' : '')}
            ${printPreview._field('P. insp', m.pinsp ? m.pinsp + ' cmH₂O' : '')}
            ${printPreview._field('P. suporte', m.ps ? m.ps + ' cmH₂O' : '')}
            ${printPreview._field('P. pico', m.ppico ? m.ppico + ' cmH₂O' : '')}
            ${printPreview._field('P. platô', m.pplato ? m.pplato + ' cmH₂O' : '')}
            ${printPreview._field('Início da VM', m.hora_ini)}
            ${printPreview._field('Fim da VM', m.hora_fim)}
            ${printPreview._field('T insp.', m.tinsp ? m.tinsp + ' s' : '')}
            ${printPreview._field('Pausa insp.', m.pausa ? m.pausa + '%' : '')}
            ${printPreview._field('Driving P.', m.driving ? m.driving + ' cmH₂O' : '')}
            ${printPreview._field('I:E', m.ie)}
            ${printPreview._field('Trigger', m.trigger)}
            ${printPreview._field('VM', m.vm ? m.vm + ' L/min' : '')}
            ${printPreview._field('EtCO₂', m.etco2 ? m.etco2 + ' mmHg' : '')}
            ${printPreview._field('Complacência', m.complacencia)}
          </div>
          ${m.gaso ? printPreview._field('Gasometria', m.gaso, true) : ''}`;
      }
      if (recHasData) {
        ventHTML += '<h3 style="font-size:9pt;margin:8px 0 4px">Recursos avançados</h3>' +
          '<div class="pp-checks">' + vt.recursos.map(r => `<span class="pp-check">${utils.escapeHTML(r)}</span>`).join('') + '</div>';
      }
      /* Terapias / mudanças de modo ao longo do tempo */
      const terapias = (vt.terapias || []).filter(t => t.modo || t.hora_ini || t.param);
      if (terapias.length > 0) {
        ventHTML += '<h3 style="font-size:9pt;margin:8px 0 4px">Terapias / mudanças de modo ventilatório</h3>' +
          '<table class="pp-table"><thead><tr><th>Início</th><th>Fim</th><th>Modo</th><th>Parâmetros</th><th>Obs</th></tr></thead><tbody>' +
          terapias.map(t => `
            <tr>
              <td>${utils.escapeHTML(t.hora_ini || '')}</td>
              <td>${utils.escapeHTML(t.hora_fim || '')}</td>
              <td>${utils.escapeHTML(t.modo || '')}</td>
              <td>${utils.escapeHTML(t.param || '')}</td>
              <td>${utils.escapeHTML(t.obs || '')}</td>
            </tr>
          `).join('') + '</tbody></table>';
      }
      if (ventHTML) html += printPreview._section('Ventilação', ventHTML);
    }

    /* === CEC ===
       Este bloco lia campos que a ficha não coleta (cec.usado, cec.inicio,
       cec.fim): a seção inteira saía vazia mesmo com a CEC toda preenchida.
       Agora acompanha a estrutura real do card. */
    const cec = d.cec || {};
    const cecTer = (cec.terapias || []).filter(t => t.tipo);
    if (cec.utilizada || cecTer.length) {
      const F = printPreview._field;
      const g = cec.geral || {}, ac = cec.anticoag || {}, pf = cec.perfusao || {},
            cn = cec.canulacoes || {}, cp = cec.cardioplegia || {},
            ev = cec.eventos || {}, md = cec.medicamentos || {}, sd = cec.saida || {};
      const bloco = (titulo, corpo) => corpo.replace(/\s+/g, '') ? '<h3 style="font-size:9pt;margin:8px 0 4px">' + titulo + '</h3>' + corpo : '';
      let cecHTML = `<div class="pp-grid cols-3">
        ${F('Tempo total de CEC', g.tempo_total ? g.tempo_total + ' min' : '')}
        ${F('Anóxia / clampeamento', g.tempo_anoxia ? g.tempo_anoxia + ' min' : '')}
        ${F('Reperfusão', g.tempo_reperf ? g.tempo_reperf + ' min' : '')}
        ${F('Temperatura mínima', g.temp_min ? g.temp_min + ' °C' : '')}
        ${F('Fluxo de bomba', g.fluxo_bomba)}
        ${F('Ht mínimo', g.ht_min ? g.ht_min + '%' : '')}
        ${F('Lactato máximo', g.lactato_max)}
        ${F('SvO₂ mínima', g.svo2_min ? g.svo2_min + '%' : '')}
      </div>`;
      cecHTML += bloco('Anticoagulação', `<div class="pp-grid cols-3">
        ${F('TCA inicial', ac.act_ini)}
        ${F('TCA alvo', ac.act_alvo)}
        ${F('TCA máximo', ac.act_max)}
        ${F('TCA final', ac.act_final)}
        ${F('Heparina', ac.heparina_dose)}
        ${F('Protamina', ac.protamina_dose)}
        ${F('Relação protamina/heparina', ac.relacao_pro_hep)}
      </div>`);
      cecHTML += bloco('Perfusão', `<div class="pp-grid cols-3">
        ${F('Oxigenador', pf.oxigenador)}
        ${F('Prime — tipo', pf.prime_tipo)}
        ${F('Prime — volume', pf.prime_vol ? pf.prime_vol + ' mL' : '')}
        ${F('Hemofiltração', pf.hemofiltracao ? 'Sim' + (pf.hemof_vol ? ' — ' + pf.hemof_vol + ' mL' : '') : '')}
        ${F('UF modificada', pf.uf_modificada ? 'Sim' : '')}
        ${F('Recuperação celular', pf.recuperacao_celular ? 'Sim' + (pf.recup_vol ? ' — ' + pf.recup_vol + ' mL' : '') : '')}
      </div>` + F('Prime — descrição', pf.prime_descricao, true) + F('Observações da perfusão', pf.observacoes, true));
      const canulTipos = (cn.tipos || []).join(', ');
      cecHTML += bloco('Canulação', (canulTipos ? F('Canulações', canulTipos, true) : '') + F('Observações', cn.observacoes, true));
      cecHTML += bloco('Cardioplegia', `<div class="pp-grid cols-3">
        ${F('Solução', cp.solucao)}
        ${F('Via', cp.via)}
        ${F('Volume', cp.volume ? cp.volume + ' mL' : '')}
        ${F('Doses', cp.doses)}
      </div>` + F('Observações', cp.observacoes, true));
      const evLista = (ev.lista || []).join(', ');
      cecHTML += bloco('Intercorrências na CEC', (evLista ? F('Eventos', evLista, true) : '') + F('Observações', ev.observacoes, true));
      cecHTML += bloco('Medicações na CEC',
        F('Vasopressores', md.vasopressores, true) + F('Inotrópicos', md.inotropicos, true) +
        F('Vasodilatadores', md.vasodilatadores, true) + F('Antifibrinolíticos', md.antifibrinoliticos, true) +
        F('Outros', md.outros, true));
      cecHTML += bloco('Saída de CEC', `<div class="pp-grid cols-3">
        ${F('Ritmo', sd.ritmo)}
        ${F('Inotrópico', sd.inotropico)}
        ${F('Marca-passo temporário', sd.mp_temp)}
        ${F('Cardioversão', sd.cardiov)}
      </div>` + F('Observações', sd.observacoes, true));
      if (cecTer.length > 0) {
        cecHTML += '<h3 style="font-size:9pt;margin:8px 0 4px">Terapias durante CEC</h3>' +
          '<table class="pp-table"><thead><tr><th>Tipo</th><th>Início</th><th>Fim</th><th>Duração</th><th>Obs</th></tr></thead><tbody>' +
          cecTer.map(t => `
            <tr>
              <td>${utils.escapeHTML(t.tipo || '')}</td>
              <td>${utils.escapeHTML(t.inicio || t.hora_ini || '')}</td>
              <td>${utils.escapeHTML(t.fim || t.hora_fim || '')}</td>
              <td>${utils.escapeHTML(t.duracao || '')}</td>
              <td>${utils.escapeHTML(t.observacoes || t.obs || '')}</td>
            </tr>
          `).join('') + '</tbody></table>';
      }
      html += printPreview._section('Circulação extracorpórea (CEC)', cecHTML);
    }
    if ((mn.dispositivos || []).length || (mn.monitores || []).length) {
      /* O DETALHE do acesso — tipo, calibre e local — é justamente o que a
         janela de acessos existe para coletar, e era o único campo dela que
         não saía no documento: imprimia-se "Acesso venoso periférico" e se
         perdia o "18G, dorso da mão direita". Sai como uma linha por acesso,
         logo abaixo das marcações. */
      const det = mn.dispositivos_detalhes || {};
      const linhaDet = (mn.dispositivos || []).map(nome => {
        const v = det[nome];
        const partes = (v && typeof v === 'object')
          ? [v.tipo, v.calibre, v.local, v.texto].filter(Boolean)
          : [v].filter(Boolean);
        return partes.length ? `<div><b>${utils.escapeHTML(nome)}:</b> ${utils.escapeHTML(partes.join(' · '))}</div>` : '';
      }).filter(Boolean).join('');
      html += printPreview._section('Acessos e monitorização',
        '<div class="pp-checks">' +
        [...(mn.dispositivos || []), ...(mn.monitores || [])].map(x => `<span class="pp-check">${utils.escapeHTML(x)}</span>`).join('') +
        '</div>' +
        (linhaDet ? `<div style="font-size:9pt;margin-top:6px;line-height:1.5">${linhaDet}</div>` : '') +
        (mn.observacoes ? printPreview._field('Observações', mn.observacoes, true) : '')
      );
    }
    /* POSICIONAMENTO — o registro sempre teve `protecao`, a impressão nunca o
       mostrou. Coxim, proteção ocular, acolchoamento de plexos, botas
       pneumáticas e manta térmica são justamente o que se pergunta quando
       aparece lesão por posicionamento ou hipotermia: cuidado tomado e não
       registrado no documento é, para quem lê depois, cuidado não tomado.
       E a seção saía só quando havia POSIÇÃO marcada — quem preenchesse só as
       proteções e a observação não imprimia nada. */
    const pos = d.posicionamento || {};
    const protec = (pos.protecao || []).filter(Boolean);
    if (pos.posicao || protec.length || pos.observacoes) {
      html += printPreview._section('Posicionamento',
        (pos.posicao ? printPreview._field('Posição', pos.posicao, true) : '') +
        (protec.length
          ? printPreview._field('Proteção, aquecimento e profilaxia', protec.join(' · '), true)
          : '') +
        (pos.observacoes ? printPreview._field('Observações', pos.observacoes, true) : '')
      );
    }
    if ((d.medicacoes || []).filter(m => m.nome).length > 0) {
      const medsImp = d.medicacoes.filter(m => m.nome);
      /* Colunas opcionais entram quando alguma linha tem conteúdo; o FIM
         (gases, halogenados, infusões) é FIXO — sai sempre na impressão */
      const temCol = k => medsImp.some(m => String(m[k] || '').trim() !== '');
      const colsMed = [];
      if (temCol('tipo'))       colsMed.push({ k: 'tipo',       label: 'Tipo' });
      if (temCol('diluicao'))   colsMed.push({ k: 'diluicao',   label: 'Diluição / Solução' });
      if (temCol('velocidade')) colsMed.push({ k: 'velocidade', label: 'Fluxo / Veloc.' });
      colsMed.push({ k: 'horaFim', label: 'Fim' });
      html += printPreview._section('Medicações',
        '<table class="pp-table"><thead><tr><th>Hora</th><th>Medicação</th><th>Dose</th><th>Un.</th><th>Via</th>' +
        colsMed.map(c => '<th>' + c.label + '</th>').join('') +
        '<th>Obs</th></tr></thead><tbody>' +
        medsImp.map(m => `
          <tr>
            <td>${utils.escapeHTML(m.hora || '')}</td>
            <td>${utils.escapeHTML(m.nome)}</td>
            <td>${utils.escapeHTML(m.dose || '')}</td>
            <td>${utils.escapeHTML(m.unidade || '')}</td>
            <td>${utils.escapeHTML(m.via || '')}</td>` +
            colsMed.map(c => `<td>${utils.escapeHTML(m[c.k] || '')}</td>`).join('') + `
            <td>${utils.escapeHTML(m.observacao || m.obs || '')}</td>
          </tr>
        `).join('') + '</tbody></table>'
      );
    }
    if ((d.sinais_vitais || []).filter(v => v.hora).length > 0) {
      /* Captura do gráfico de sinais vitais para incluir no print — com
         redesenho forçado no contexto da ficha (funciona mesmo com o módulo
         oculto, ex.: impressão conjunta ficha+SRPA a partir da SRPA) */
      let graficoHTML = '';
      try {
        const ctxAnterior = anestesia.graficoUI._contexto;
        anestesia.graficoUI._contexto = 'anestesia';
        const dataURL = printPreview._capturarGrafico('vitals-chart', 'module-anestesia',
          () => anestesia.vitais.atualizarGrafico());
        anestesia.graficoUI._contexto = ctxAnterior;
        if (dataURL) {
          graficoHTML = `<div style="margin-bottom:8px; text-align:center"><img class="pp-grafico-img" src="${dataURL}" style="max-width:100%; max-height:280px; border:1px solid #888"></div>`;
        }
      } catch (e) { /* canvas vazio ou sem suporte — ignora */ }

      /* Legenda de medicações e eventos do gráfico (M1, M2... e E1, E2...) */
      let legendaPrint = '';
      try {
        const meds = (d.medicacoes || []).filter(m => m.hora && m.nome).slice().sort((a, b) => (a.hora || '').localeCompare(b.hora || ''));
        const evts = (d.eventos || []).filter(e => e.hora && e.tipo).slice().sort((a, b) => (a.hora || '').localeCompare(b.hora || ''));
        if (meds.length > 0 || evts.length > 0) {
          legendaPrint = '<div style="font-size:9pt;margin:6px 0 10px 0;line-height:1.5;background:#f4f4f4;padding:6px;border-radius:3px">';
          legendaPrint += '<strong style="font-size:9pt">Legenda do gráfico:</strong><br>';
          meds.forEach((m, i) => {
            const dose = m.dose ? ' ' + m.dose + (m.unidade || '') : '';
            const tipo = m.tipo && m.tipo.includes('Infusão') ? ' (inf.)' : (m.tipo && m.tipo.includes('Inalat') ? ' (inal.)' : '');
            const fim = m.horaFim ? ' até ' + m.horaFim : '';
            const obs = m.observacao || m.obs ? ' — ' + (m.observacao || m.obs) : '';
            legendaPrint += `<span style="display:inline-block;margin-right:10px;margin-bottom:2px"><span style="display:inline-block;background:#333;color:#fff;border-radius:50%;width:14px;height:14px;line-height:14px;text-align:center;font-size:8pt;font-weight:bold;margin-right:3px">M${i+1}</span>${m.hora} · ${utils.escapeHTML(m.nome)}${utils.escapeHTML(dose)}${tipo}${utils.escapeHTML(fim)}${utils.escapeHTML(obs)}</span>`;
          });
          if (meds.length > 0 && evts.length > 0) legendaPrint += '<br>';
          evts.forEach((e, i) => {
            /* exame entra só pelo nome: os valores saem legíveis na tabela de
               exames, e não espremidos numa linha da legenda */
            const detalhe = anestesia.exames.ehExame(e.tipo) ? '' : (e.observacao ? ' — ' + utils.escapeHTML(e.observacao) : '');
            legendaPrint += `<span style="display:inline-block;margin-right:10px;margin-bottom:2px"><span style="display:inline-block;background:#1f9171;color:#fff;border-radius:3px;width:18px;height:14px;line-height:14px;text-align:center;font-size:8pt;font-weight:bold;margin-right:3px">E${i+1}</span>${e.hora} · ${utils.escapeHTML(e.tipo)}${detalhe}</span>`;
          });
          legendaPrint += '</div>';
        }
      } catch (e) { /* sem legenda em caso de erro */ }

      /* Detecta colunas opcionais que têm dados */
      const has = (k) => d.sinais_vitais.some(v => v[k] != null && v[k] !== '');
      const colsOpcionais = [];
      if (has('ritmo')) colsOpcionais.push({ k: 'ritmo', label: 'Ritmo' });
      if (has('temp'))  colsOpcionais.push({ k: 'temp',  label: 'Temp' });
      if (has('bis'))   colsOpcionais.push({ k: 'bis',   label: 'BIS' });
      if (has('tof'))   colsOpcionais.push({ k: 'tof',   label: 'TOF' });
      if (has('glic'))  colsOpcionais.push({ k: 'glic',  label: 'Glic' });
      if (has('pvc'))   colsOpcionais.push({ k: 'pvc',   label: 'PVC' });
      if (has('pic'))   colsOpcionais.push({ k: 'pic',   label: 'PIC' });
      if (has('dc'))    colsOpcionais.push({ k: 'dc',    label: 'DC' });
      if (has('scvo2')) colsOpcionais.push({ k: 'scvo2', label: 'ScvO₂' });
      if (has('cam'))   colsOpcionais.push({ k: 'cam',   label: 'CAM' });
      if (has('diurese')) colsOpcionais.push({ k: 'diurese', label: 'Diurese mL' });

      const cabec = '<table class="pp-table"><thead><tr><th>Hora</th><th>PAS</th><th>PAD</th><th>PAM</th><th>FC</th><th>SpO₂</th><th>EtCO₂</th><th>FR</th>' +
        colsOpcionais.map(c => '<th>' + c.label + '</th>').join('') +
        '<th>Obs</th></tr></thead><tbody>';

      html += printPreview._section('Sinais vitais',
        graficoHTML +
        legendaPrint +
        cabec +
        d.sinais_vitais.filter(v => v.hora).map(v => {
          /* Se vier só pa legado, separa */
          let pas = v.pas || '', pad = v.pad || '', pam = v.pam || '';
          if ((!pas || !pad) && v.pa) {
            const m = String(v.pa).match(/(\d+)\s*\/\s*(\d+)/);
            if (m) { pas = pas || m[1]; pad = pad || m[2]; }
          }
          if (!pam && pas && pad) {
            pam = Math.round((parseFloat(pas) + 2 * parseFloat(pad)) / 3);
          }
          return `
          <tr>
            <td>${utils.escapeHTML(v.hora)}</td>
            <td>${utils.escapeHTML(pas)}</td>
            <td>${utils.escapeHTML(pad)}</td>
            <td>${utils.escapeHTML(pam)}</td>
            <td>${utils.escapeHTML(v.fc || '')}</td>
            <td>${utils.escapeHTML(v.spo2 || '')}</td>
            <td>${utils.escapeHTML(v.etco2 || '')}</td>
            <td>${utils.escapeHTML(v.fr || '')}</td>
            ${colsOpcionais.map(c => '<td>' + utils.escapeHTML(v[c.k] || '') + '</td>').join('')}
            <td>${utils.escapeHTML(v.observacao || '')}</td>
          </tr>
        `;
        }).join('') + '</tbody></table>'
      );
    }
    /* Exames intraoperatórios — os eventos que são exame, em tabela: os
       números de uma gasometria não se leem numa linha corrida da legenda */
    {
      const exs = anestesia.exames.listar(d);
      if (exs.length) {
        html += printPreview._section('Exames intraoperatórios',
          '<table class="pp-table"><thead><tr><th style="width:60px">Hora</th><th style="width:150px">Exame</th><th>Resultado</th></tr></thead><tbody>' +
          exs.map(e => '<tr><td>' + utils.escapeHTML(e.hora) + '</td>' +
            '<td>' + utils.escapeHTML(e.tipo) + '</td>' +
            '<td>' + utils.escapeHTML(e.resultado) + '</td></tr>').join('') +
          '</tbody></table>'
        );
      }
    }
    /* Fluidos */
    const f = d.fluidos;
    /* Tabela cronológica de hidratação, se houver */
    if (Array.isArray(f.hidratacao) && f.hidratacao.filter(h => h.tipo || h.volume).length > 0) {
      html += printPreview._section('Hidratação — registro cronológico',
        '<table class="pp-table"><thead><tr><th>Hora</th><th>Solução</th><th>Volume</th><th>Via</th><th>Obs.</th></tr></thead><tbody>' +
        f.hidratacao
          .filter(h => h.tipo || h.volume)
          .sort((a, b) => (a.hora || '99:99').localeCompare(b.hora || '99:99'))
          .map(h => `
            <tr>
              <td>${utils.escapeHTML(h.hora || '')}</td>
              <td>${utils.escapeHTML(h.tipo || '')}</td>
              <td>${h.volume ? utils.escapeHTML(h.volume) + ' mL' : ''}</td>
              <td>${utils.escapeHTML(h.via || '')}</td>
              <td>${utils.escapeHTML(h.observacao || '')}</td>
            </tr>
          `).join('') + '</tbody></table>'
      );
    }
    if (f.cristaloides || f.coloides || f.hemocomponentes || f.diurese || f.perdas) {
      html += printPreview._section('Totais e balanço', `
        <div class="pp-grid cols-3">
          ${printPreview._field('Cristaloides', f.cristaloides ? f.cristaloides + ' mL' : '')}
          ${printPreview._field('Coloides', f.coloides ? f.coloides + ' mL' : '')}
          ${printPreview._field('Hemocomponentes', f.hemocomponentes)}
          ${printPreview._field('Total infundido', f.total_infundido)}
          ${printPreview._field('Diurese', f.diurese ? f.diurese + ' mL' : '')}
          ${printPreview._field('Débito urinário', printPreview._debitoUrinario(d))}
          ${printPreview._field('Perdas', f.perdas ? f.perdas + ' mL' : '')}
          ${printPreview._field('Balanço', f.balanco)}
        </div>
        ${f.observacoes ? printPreview._field('Observações', f.observacoes, true) : ''}
      `);
    }
    /* Intercorrências */
    if ((d.intercorrencias.eventos || []).length || d.intercorrencias.descricao) {
      html += printPreview._section('Intercorrências',
        '<div class="pp-checks">' +
        (d.intercorrencias.eventos || []).map(e => `<span class="pp-check">${utils.escapeHTML(e)}</span>`).join('') +
        '</div>' +
        (d.intercorrencias.descricao ? printPreview._field('Descrição', d.intercorrencias.descricao, true) : '') +
        (d.intercorrencias.condutas ? printPreview._field('Condutas', d.intercorrencias.condutas, true) : '')
      );
    }
    /* Transferência */
    const t = d.transferencia;
    if (t.origem || t.destino || t.condicao_saida) {
      html += printPreview._section('Origem e destino', `
        <div class="pp-grid">
          ${printPreview._field('Origem', t.origem)}
          ${printPreview._field('Destino', t.destino)}
          ${printPreview._field('Condição de saída', t.condicao_saida)}
          ${printPreview._field('Hemodinamicamente estável', t.estavel)}
          ${printPreview._field('Em oxigênio', t.oxigenio)}
          ${printPreview._field('Com dor', t.dor)}
          ${printPreview._field('Acompanhado por', t.acompanhante)}
        </div>
        ${t.observacoes ? printPreview._field('Observações', t.observacoes, true) : ''}
      `);
    }
    /* Resumo / evolução */
    if (d.conclusao.resumo_narrativo) html += printPreview._section('Resumo da anestesia', printPreview._field('', d.conclusao.resumo_narrativo, true));
    if (d.conclusao.descricao_livre) html += printPreview._section('Descrição', printPreview._field('', d.conclusao.descricao_livre, true));
    if (d.conclusao.evolucao) html += printPreview._section('Evolução', printPreview._field('', d.conclusao.evolucao, true));
    if (d.conclusao.conclusao) html += printPreview._section('Conclusão', printPreview._field('', d.conclusao.conclusao, true));
    if (d.conclusao.observacoes_finais) html += printPreview._section('Observações finais', printPreview._field('', d.conclusao.observacoes_finais, true));

    /* === ASSINATURA NOVA (com carimbo / desenho) === */
    html += printPreview._signatureAnestesia(d.assinatura);
    html += printPreview._footer('Ficha de anestesia');
    return html;
  },

  /* Bloco específico de assinatura para a Anestesia (suporta 1 ou 2 anestesistas) */
  _signatureAnestesia(a) {
    if (!a) return '';
    const renderUm = (nome, crm, dataHora, dataurl, meta) => {
      /* Se não tem dataurl, busca carimbo cadastrado pelo nome */
      let imgHTML = '';
      if (dataurl) {
        imgHTML = `<img src="${dataurl}" alt="">`;
      } else if (nome) {
        const p = utils.getCarimboDoProfissional(nome);
        if (p && p.carimbo) imgHTML = `<img src="${p.carimbo}" alt="">`;
      }
      const linhaNome = nome || '_____________________________';
      const linhaCrm = crm ? ('CRM ' + crm) : '';
      return `
        <div class="pp-signature">
          <div class="pp-signature-img-slot">${imgHTML}</div>
          <div style="white-space:pre-line">${utils.escapeHTML(linhaNome)}${linhaCrm ? '\n' + utils.escapeHTML(linhaCrm) : ''}</div>
          ${dataHora ? `<div style="font-size:8pt;color:#666;margin-top:2px">${utils.escapeHTML(dataHora)}</div>` : ''}
          ${printPreview._icpSelo(meta)}
        </div>
      `;
    };
    let blocks = renderUm(a.anestesiologista, a.crm, a.data_hora, a.dataurl, a.meta);
    /* 2º anestesista, se preenchido */
    if (a.anestesiologista2 || a.dataurl2) {
      blocks += renderUm(a.anestesiologista2, a.crm2, a.data_hora2, a.dataurl2, a.meta2);
    }
    return `<div class="pp-signature-area">${blocks}</div>`;
  },

  _buildRecuperacao() {
    const d = utils.formData('form-recuperacao');
    /* mesmo padrão da ficha: topo só com logo e título (a data está logo
       abaixo, na identificação) */
    return printPreview._header('RECUPERAÇÃO PÓS-ANESTÉSICA', '', { semProfissional: true }) +
      printPreview._section('Identificação e procedência', `
        <div class="pp-grid cols-3">
          ${printPreview._field('Nome', d.nome)}
          ${printPreview._field('Idade', d.idade)}
          ${printPreview._field('Data', utils.formatarData(d.data))}
          ${printPreview._field('Entrada SRPA', d.entrada)}
          ${printPreview._field('Alta SRPA', d.alta)}
          ${printPreview._field('Procedência', d.procedencia)}
        </div>
        <div class="pp-grid">
          ${printPreview._field('Tipo de anestesia', d.tipo_anestesia)}
          ${printPreview._field('Procedimento', d.procedimento)}
        </div>
      `) +
      printPreview._section('Sinais vitais — chegada / alta', `
        <div class="pp-grid cols-3">
          ${printPreview._field('PA chegada', d.pa_inicial)}
          ${printPreview._field('FC chegada', d.fc_inicial)}
          ${printPreview._field('SpO₂ chegada', d.spo2_inicial)}
          ${printPreview._field('FR chegada', d.fr_inicial)}
          ${printPreview._field('Temp chegada', d.temp_inicial)}
          ${printPreview._field('PA alta', d.pa_alta)}
          ${printPreview._field('FC alta', d.fc_alta)}
          ${printPreview._field('SpO₂ alta', d.spo2_alta)}
          ${printPreview._field('FR alta', d.fr_alta)}
          ${printPreview._field('Temp alta', d.temp_alta)}
        </div>
        <div class="pp-grid">
          ${printPreview._field('O₂ em uso', d.oxigenio)}
          ${printPreview._field('Dor (EVA)', d.dor)}
          ${printPreview._field('Náusea/Vômito', d.nausea)}
          ${printPreview._field('Consciência', d.consciencia)}
          ${printPreview._field('Aldrete', d.aldrete)}
        </div>
      `) +
      ((d.aldk_total || d.aldk_atividade || d.aldk_respiracao || d.aldk_circulacao || d.aldk_consciencia || d.aldk_saturacao) ?
      printPreview._section('Escala de Aldrete-Kroulik', `
        <div class="pp-grid cols-3">
          ${printPreview._field('Atividade motora', d.aldk_atividade)}
          ${printPreview._field('Respiração', d.aldk_respiracao)}
          ${printPreview._field('Circulação (PA)', d.aldk_circulacao)}
          ${printPreview._field('Consciência', d.aldk_consciencia)}
          ${printPreview._field('Saturação O₂', d.aldk_saturacao)}
          ${printPreview._field('Pontuação total', d.aldk_total)}
        </div>
        ${d.aldk_datahora ? printPreview._field('Data/hora da avaliação', String(d.aldk_datahora).replace('T', ' ')) : ''}
        ${d.aldk_interpretacao ? printPreview._field('Interpretação', d.aldk_interpretacao, true) : ''}
      `) : '') +
      ((d.pad_total || d.pad_vitais || d.pad_deambulacao || d.pad_nausea || d.pad_dor || d.pad_sangramento) ?
      printPreview._section('Escala de alta domiciliar (PADSS)', `
        <div class="pp-grid cols-3">
          ${printPreview._field('Sinais vitais', d.pad_vitais)}
          ${printPreview._field('Deambulação', d.pad_deambulacao)}
          ${printPreview._field('Náusea/vômito', d.pad_nausea)}
          ${printPreview._field('Dor', d.pad_dor)}
          ${printPreview._field('Sangramento', d.pad_sangramento)}
          ${printPreview._field('Pontuação total', d.pad_total)}
        </div>
        ${d.pad_interpretacao ? printPreview._field('Interpretação', d.pad_interpretacao, true) : ''}
      `) : '') +
      printPreview._section('Conduta e desfecho', `
        ${printPreview._field('Complicações', d.complicacoes, true)}
        ${printPreview._field('Conduta', d.conduta, true)}
        <div class="pp-grid">
          ${printPreview._field('Critérios de alta', d.criterios_alta)}
          ${printPreview._field('Destino', d.destino)}
        </div>
        ${printPreview._field('Resumo de alta', d.resumo_alta, true)}
        ${printPreview._field('Observações', d.observacoes, true)}
      `) +
      printPreview._buildGraficoSRPA() +
      printPreview._signature(d.responsavel, d.registro || '', d) +
      printPreview._footer('Recuperação pós-anestésica');
  },

  /* Monta a seção de gráfico + tabelas da SRPA para impressão */
  _buildGraficoSRPA() {
    let g;
    try { g = recuperacao.grafico.coletar(); } catch (e) { g = { vitais: [], eventos: [], medicacoes: [] }; }
    const temVitais = (g.vitais || []).some(v => v.hora);
    const temEventos = (g.eventos || []).some(e => e.hora && e.tipo);
    const temMeds = (g.medicacoes || []).some(m => m.hora && m.nome);
    if (!temVitais && !temEventos && !temMeds) return '';

    let html = '';
    /* Captura a imagem do gráfico (canvas) — com redesenho forçado no contexto
       da SRPA e restauração (funciona mesmo com o módulo oculto) */
    try {
      if (temVitais || temEventos || temMeds) {
        const ctxAnterior = anestesia.graficoUI._contexto;
        anestesia.graficoUI._contexto = 'recuperacao';
        const dataUrl = printPreview._capturarGrafico('srpa-vitals-chart', 'module-recuperacao',
          () => anestesia.vitais.atualizarGrafico());
        anestesia.graficoUI._contexto = ctxAnterior;
        if (dataUrl) html += `<div style="text-align:center;margin:8px 0"><img class="pp-grafico-img" src="${dataUrl}" style="max-width:100%;border:1px solid #ccc" alt="Gráfico SRPA"></div>`;
      }
    } catch (e) {}

    /* Tabela de sinais vitais */
    if (temVitais) {
      html += '<table class="pp-table"><thead><tr><th>Hora</th><th>PAS</th><th>PAD</th><th>PAM</th><th>FC</th><th>SpO₂</th><th>FR</th><th>Temp</th><th>Dor</th><th>Obs</th></tr></thead><tbody>' +
        g.vitais.filter(v => v.hora).map(v => `<tr>
          <td>${utils.escapeHTML(v.hora || '')}</td>
          <td>${utils.escapeHTML(v.pas || '')}</td>
          <td>${utils.escapeHTML(v.pad || '')}</td>
          <td>${utils.escapeHTML(v.pam || '')}</td>
          <td>${utils.escapeHTML(v.fc || '')}</td>
          <td>${utils.escapeHTML(v.spo2 || '')}</td>
          <td>${utils.escapeHTML(v.fr || '')}</td>
          <td>${utils.escapeHTML(v.temp || '')}</td>
          <td>${utils.escapeHTML(v.dor || '')}</td>
          <td>${utils.escapeHTML(v.observacao || '')}</td>
        </tr>`).join('') + '</tbody></table>';
    }
    /* Tabela de eventos */
    if (temEventos) {
      html += '<h3 style="font-size:9pt;margin:8px 0 4px">Eventos</h3>' +
        '<table class="pp-table"><thead><tr><th>Hora</th><th>Evento</th><th>Detalhes</th></tr></thead><tbody>' +
        g.eventos.filter(e => e.hora && e.tipo).map(e => `<tr>
          <td>${utils.escapeHTML(e.hora)}</td>
          <td>${utils.escapeHTML(e.tipo)}</td>
          <td>${utils.escapeHTML(e.observacao || '')}</td>
        </tr>`).join('') + '</tbody></table>';
    }
    /* Tabela de medicações */
    if (temMeds) {
      html += '<h3 style="font-size:9pt;margin:8px 0 4px">Medicações</h3>' +
        '<table class="pp-table"><thead><tr><th>Hora</th><th>Medicação</th><th>Dose</th><th>Un</th><th>Via</th><th>Obs</th></tr></thead><tbody>' +
        g.medicacoes.filter(m => m.hora && m.nome).map(m => `<tr>
          <td>${utils.escapeHTML(m.hora)}</td>
          <td>${utils.escapeHTML(m.nome)}</td>
          <td>${utils.escapeHTML(m.dose || '')}</td>
          <td>${utils.escapeHTML(m.unidade || '')}</td>
          <td>${utils.escapeHTML(m.via || '')}</td>
          <td>${utils.escapeHTML(m.obs || m.observacao || '')}</td>
        </tr>`).join('') + '</tbody></table>';
    }
    return printPreview._section('Monitorização gráfica', html);
  },

  /* Assinatura desenhada (canvas) para Termo/Prescrição */
  _assinaturaDesenhada(dataUrl, linhaNome, linhaRegistro, papel) {
    const img = dataUrl ? `<img src="${dataUrl}" alt="" style="display:block;max-width:200px;max-height:60px;width:auto;height:auto;margin:0 auto 2px">` : '';
    const nome = linhaNome || '_____________________________';
    const classePapel = papel === 'prof' ? ' pp-signature-prof' : (papel === 'pac' ? ' pp-signature-pac' : '');
    return `
      <div class="pp-signature${classePapel}" style="text-align:center">
        <div class="pp-signature-img-slot" style="min-height:60px;display:flex;align-items:flex-end;justify-content:center">${img}</div>
        <div style="white-space:pre-line;border-top:1px solid #333;padding-top:3px;margin-top:2px">${utils.escapeHTML(nome)}${linhaRegistro ? '\n' + utils.escapeHTML(linhaRegistro) : ''}</div>
      </div>`;
  },

  _buildTermo() {
    const d = utils.formData('form-termo');
    const meta = `${utils.formatarData(d.data) || new Date().toLocaleDateString('pt-BR')}`;
    /* Texto do termo em parágrafos */
    const textoHtml = (d.texto || '').split('\n').filter(l => l.trim())
      .map(l => `<p style="margin:0 0 8px;text-align:justify;font-size:calc(10pt * var(--pp-esc, 1));line-height:1.5">${utils.escapeHTML(l)}</p>`).join('');

    let respHtml = '';
    if (d.tem_responsavel) {
      respHtml = printPreview._section('Responsável legal', `
        <div class="pp-grid cols-3">
          ${printPreview._field('Nome', d.resp_nome)}
          ${printPreview._field('Documento', d.resp_documento)}
          ${printPreview._field('Vínculo', d.resp_vinculo)}
          ${printPreview._field('Motivo', d.resp_motivo)}
        </div>`);
    }

    /* Duas assinaturas lado a lado */
    const labelPac = d.tem_responsavel
      ? (d.resp_nome ? d.resp_nome + ' (responsável)' : 'Paciente / responsável')
      : (d.nome || 'Paciente');
    const assinaturas = `
      <div class="pp-signature-area" style="display:flex;gap:30px;justify-content:space-between;margin-top:40px">
        ${printPreview._assinaturaDesenhada(d.sig_paciente_dataurl, labelPac, d.documento ? 'Doc: ' + d.documento : '', 'pac')}
        ${printPreview._assinaturaDesenhada(d.assinatura_dataurl || d.sig_profissional_dataurl, d.profissional || 'Profissional', d.crm, 'prof')}
      </div>`;

    /* pp-compacto: mesma redução da pré (ver CSS) */
    return '<div class="pp-compacto">' +
      printPreview._header('TERMO DE CONSENTIMENTO LIVRE E ESCLARECIDO', meta) +
      printPreview._section('Identificação do paciente', `
        <div class="pp-grid cols-3">
          ${printPreview._fieldSempre('Nome', d.nome)}
          ${printPreview._field('Nascimento', utils.formatarData(d.nascimento))}
          ${printPreview._field('Idade', d.idade)}
          ${printPreview._field('Documento', d.documento)}
          ${printPreview._field('Sexo', d.sexo)}
          ${printPreview._field('Convênio', d.convenio)}
        </div>
        <div class="pp-grid">
          ${printPreview._field('Procedimento', d.procedimento)}
          ${printPreview._field('Técnica anestésica', d.tecnica)}
        </div>`) +
      respHtml +
      printPreview._section('Termo', textoHtml +
        (d.riscos ? `<p style="margin:10px 0 0;font-size:calc(10pt * var(--pp-esc, 1))"><strong>Riscos específicos discutidos:</strong> ${utils.escapeHTML(d.riscos)}</p>` : '') +
        (d.observacoes ? `<p style="margin:8px 0 0;font-size:calc(10pt * var(--pp-esc, 1))"><strong>Observações:</strong> ${utils.escapeHTML(d.observacoes)}</p>` : '')) +
      printPreview._section('Local e data', `
        <div class="pp-grid cols-3">
          ${printPreview._field('Local', d.local)}
          ${printPreview._field('Data', utils.formatarData(d.data))}
          ${printPreview._field('Hora', d.hora)}
        </div>`) +
      assinaturas +
      /* Referências bibliográficas — só quando o termo cita os dados estatísticos */
      (/100\.?000|4,3|18 a 22%|0,45/.test(d.texto || '') ?
        `<div style="margin-top:22px;padding-top:8px;border-top:1px solid #ddd;font-size:7.5pt;color:#666;line-height:1.4">
          <strong style="display:block;margin-bottom:2px">Referências:</strong>
          1. Anesthesia and patient safety: have we reached our limits? Current Opinion in Anesthesiology. 2011;24:349-353.<br>
          2. Perioperative and anaesthetic-related mortality in developed and developing countries: a systematic review and meta-analysis. The Lancet. 2012;380:1075-1081.
        </div>` : '') +
      printPreview._footer('Termo de Consentimento') +
      '</div>';
  },

  /* A APRESENTAÇÃO NA RECEITA É A CONCENTRAÇÃO, NÃO A FORMA.
     Ao escolher o medicamento, o sistema compõe o campo com
        [conc, forma].join(' — ')   →  "7 MG — Comprimido"
     e isso é útil NA TELA: é o que distingue o comprimido de 7 mg da caneta
     de 7 mg na hora de selecionar. No papel vira ruído — a forma já está dita
     na posologia ("1 comprimido pela manhã") e repeti-la só rouba a leitura da
     dose, que é o que o farmacêutico confere.
     O snapshot da Anvisa guarda os dois campos separados; quando ele existe, a
     concentração vem dele. Sem snapshot, desfaz-se exatamente a junção que o
     próprio sistema fez — e o que foi digitado à mão fica como está. */
  _apresParaImpressao(it) {
    if (!it) return '';
    const snap = it.medicamento;
    if (snap && snap.conc) return String(snap.conc).trim();
    const apres = String(it.apres || '').trim();
    if (!apres) return '';
    const corte = apres.indexOf(' — ');
    return corte > 0 ? apres.slice(0, corte).trim() : apres;
  },

  _buildPrescricao() {
    const d = utils.formData('form-prescricao');
    const modelo = d.modelo || (d.tipo === 'especial' ? 'especial' : 'simples');
    if (modelo === 'atestado') return printPreview._buildAtestado(d);
    if (modelo === 'declaracao') return printPreview._buildDeclaracao(d);
    if (modelo === 'laudo') return printPreview._buildLaudo(d);

    const itens = prescricao._coletarItens();
    const duasVias = (modelo === 'especial' || modelo === 'antimicrobiano');
    const especial = modelo === 'especial';
    const meta = `${utils.formatarData(d.data) || new Date().toLocaleDateString('pt-BR')}`;
    const TITULOS = { simples: 'RECEITUÁRIO', especial: 'RECEITUÁRIO DE CONTROLE ESPECIAL', antimicrobiano: 'RECEITA DE ANTIMICROBIANO' };
    const titulo = TITULOS[modelo] || 'RECEITUÁRIO';
    /* validade padrão por modelo se não informada */
    const validadeTxt = d.validade || (modelo === 'antimicrobiano' ? '10 dias' : (modelo === 'especial' ? '30 dias' : ''));

    /* Lista de medicamentos numerada */
    const listaMeds = itens.length ? itens.map((it, i) => {
      const apres = printPreview._apresParaImpressao(it);
      const pos = [it.pos || '', it.via ? 'Via: ' + it.via : ''].filter(Boolean).join(' · ');
      return `
      <div class="pp-med">
        <div class="pp-med-linha">
          <span class="pp-med-nome">${i + 1}. ${utils.escapeHTML(it.nome)}${apres ? ' <span class="pp-med-apres">' + utils.escapeHTML(apres) + '</span>' : ''}</span>
          ${it.qtd ? `<span class="pp-med-qtd">${utils.escapeHTML(it.qtd)}</span>` : ''}
        </div>
        ${pos ? `<div class="pp-med-pos">${utils.escapeHTML(pos)}</div>` : ''}
      </div>`;
    }).join('') : '<p class="pp-med-vazio">Nenhum medicamento.</p>';

    const cabecalhoPac = `
      <div class="pp-grid cols-3 pp-ident">
        ${printPreview._fieldSempre('Paciente', d.nome)}
        ${printPreview._field('Idade', d.idade)}
        ${printPreview._field('CPF/RG', d.documento)}
        ${printPreview._field('Data', utils.formatarData(d.data))}
      </div>
      ${especial ? printPreview._field('Endereço', d.endereco, true, true) : printPreview._field('Endereço', d.endereco, true)}`;

    const assinatura = `
      <div class="pp-signature-area" style="margin-top:36px">
        ${printPreview._assinaturaDesenhada(d.assinatura_dataurl || d.sig_dataurl, d.profissional || 'Profissional', d.crm, 'prof')}
      </div>`;

    const orient = d.orientacoes ? printPreview._section('Orientações', `<p class="pp-orient">${utils.escapeHTML(d.orientacoes)}</p>`) : '';
    const validade = validadeTxt ? `<div class="pp-validade">Validade: ${utils.escapeHTML(validadeTxt)}</div>` : '';

    /* Monta uma via */
    const umaVia = (rotulo) => printPreview._header(titulo, meta + (rotulo ? `<br><span style="font-size:8pt;font-weight:700;color:#b3392a">${rotulo}</span>` : '')) +
      printPreview._section('Identificação', cabecalhoPac) +
      printPreview._section('Medicamentos', listaMeds + validade) +
      orient +
      `<div class="pp-grid cols-2" style="margin-top:8px">${printPreview._field('Local', d.local)}</div>` +
      assinatura;

    if (duasVias) {
      /* Controle especial (Portaria 344/98): 1ª via retida na farmácia.
         Antimicrobiano (RDC 471/2021): 2ª via retida na farmácia, 1ª via ao paciente. */
      const via1 = especial ? '1ª via — Retenção da Farmácia' : '1ª via — Paciente';
      const via2 = especial ? '2ª via — Orientação ao Paciente' : '2ª via — Retida na Farmácia';
      const rodapeLabel = especial ? 'Receituário de Controle Especial (2 vias)' : 'Receita de Antimicrobiano (2 vias)';
      return '<div class="pp-receita">' + umaVia(via1) +
        '<div style="page-break-before:always"></div>' +
        umaVia(via2) +
        printPreview._footer(rodapeLabel) + '</div>';
    }
    return '<div class="pp-receita">' + umaVia('') + printPreview._footer('Receituário') + '</div>';
  },

  /* Atestado médico e Declaração de comparecimento — documentos declaratórios
     (sem medicamentos), com texto corrido centralizado. */
  _buildAtestado(d) {
    const meta = `${utils.formatarData(d.data) || new Date().toLocaleDateString('pt-BR')}`;
    let texto = (d.atestado_texto || '').trim();
    if (!texto) texto = prescricao._gerarTextoAtestado(d);
    return printPreview._docDeclaratorio('ATESTADO MÉDICO', meta, texto, d, 'Atestado médico');
  },
  _buildDeclaracao(d) {
    const meta = `${utils.formatarData(d.data) || new Date().toLocaleDateString('pt-BR')}`;
    let texto = (d.decl_texto || '').trim();
    if (!texto) texto = prescricao._gerarTextoDeclaracao(d);
    return printPreview._docDeclaratorio('DECLARAÇÃO DE COMPARECIMENTO', meta, texto, d, 'Declaração de comparecimento');
  },
  _buildLaudo(d) {
    const meta = `${utils.formatarData(d.data) || new Date().toLocaleDateString('pt-BR')}`;
    let texto = (d.laudo_texto || '').trim();
    if (!texto) texto = prescricao._gerarTextoLaudo(d);
    return printPreview._docDeclaratorio('LAUDO MÉDICO', meta, texto, d, 'Laudo médico');
  },
  /* Módulo Documentos (atestado/declaração/laudo) — usa os mesmos geradores */
  _buildDocumento() {
    const d = utils.formData('form-documentos');
    const modelo = d.modelo || 'atestado';
    const meta = `${utils.formatarData(d.data) || new Date().toLocaleDateString('pt-BR')}`;
    if (modelo === 'declaracao') {
      const texto = (d.decl_texto || '').trim() || prescricao._gerarTextoDeclaracao(d);
      return printPreview._docDeclaratorio('DECLARAÇÃO DE COMPARECIMENTO', meta, texto, d, 'Declaração de comparecimento');
    }
    if (modelo === 'laudo') {
      const texto = (d.laudo_texto || '').trim() || prescricao._gerarTextoLaudo(d);
      return printPreview._docDeclaratorio('LAUDO MÉDICO', meta, texto, d, 'Laudo médico');
    }
    const texto = (d.atestado_texto || '').trim() || prescricao._gerarTextoAtestado(d);
    return printPreview._docDeclaratorio('ATESTADO MÉDICO', meta, texto, d, 'Atestado médico');
  },
  _docDeclaratorio(titulo, meta, texto, d, rodape) {
    const corpo = `<div style="font-size:11.5pt;line-height:1.9;text-align:justify;margin:26px 4px 0;white-space:pre-wrap">${utils.escapeHTML(texto)}</div>`;
    const localData = `<div style="margin-top:30px;font-size:10.5pt;text-align:right">${utils.escapeHTML(d.local || '')}${d.local ? ', ' : ''}${utils.formatarData(d.data) || new Date().toLocaleDateString('pt-BR')}</div>`;
    const assinatura = `
      <div class="pp-signature-area" style="margin-top:44px">
        ${printPreview._assinaturaDesenhada(d.assinatura_dataurl || d.sig_dataurl, d.profissional || 'Profissional', d.crm, 'prof')}
      </div>`;
    return printPreview._header(titulo, meta) + corpo + localData + assinatura + printPreview._footer(rodape);
  },

  _buildRisco() {
    const d = utils.formData('form-risco');
    try { risco.atualizar(); } catch (e) {}
    const meta = `${new Date().toLocaleDateString('pt-BR')}`;
    const tabela = risco.resumoCompactoHTML({ _resumo: risco._ultimoResumo });
    const proc = d.procBusca ? `<div class="pp-grid"><div><span class="pp-label">Procedimento</span><span class="pp-value">${utils.escapeHTML(d.procBusca)}</span></div></div>` : '';
    return printPreview._header('AVALIAÇÃO DE RISCO PERIOPERATÓRIO', meta) +
      printPreview._section('Identificação', `
        <div class="pp-grid cols-3">
          ${printPreview._fieldSempre('Paciente', d.nome)}
          ${printPreview._field('Idade', d.idade)}
          ${printPreview._field('Sexo', d.sexo === 'F' ? 'Feminino' : d.sexo === 'M' ? 'Masculino' : '')}
        </div>${proc}`) +
      printPreview._section('Estimativas de risco (resumo estatístico)', tabela ||
        '<p style="color:#888">Preencha os campos do módulo de risco para gerar as estimativas.</p>') +
      `<p style="font-size:8pt;color:#777;margin-top:10px">Índice composto de apoio. Padrão reconhecido para estimativa por procedimento: ACS NSQIP; mortalidade: SORT. Não substitui calculadora oficial nem julgamento clínico.</p>` +
      printPreview._footer('Risco perioperatório');
  },

  _buildFinanceiro() {
    const list = financeiro.filtrar();
    const meta = `<strong>Conciliação financeira</strong><br>${new Date().toLocaleDateString('pt-BR')}<br>Total: ${list.length} registros`;
    let html = printPreview._header('RELATÓRIO FINANCEIRO', meta);
    if (list.length === 0) {
      html += '<div class="empty-state">Nenhum registro</div>';
    } else {
      const totPrev = list.reduce((s, x) => s + (parseFloat(x.valor_previsto) || 0), 0);
      const totRec  = list.reduce((s, x) => s + (parseFloat(x.valor_recebido) || 0), 0);
      const totGlo  = list.reduce((s, x) => s + (parseFloat(x.glosa) || 0), 0);
      html += printPreview._section('Resumo', `
        <div class="pp-grid">
          ${printPreview._field('Total previsto', 'R$ ' + utils.formatarBR(totPrev))}
          ${printPreview._field('Total recebido', 'R$ ' + utils.formatarBR(totRec))}
          ${printPreview._field('Total glosa', 'R$ ' + utils.formatarBR(totGlo))}
          ${printPreview._field('A receber', 'R$ ' + utils.formatarBR(totPrev - totRec - totGlo))}
        </div>
      `);
      html += '<table class="pp-table"><thead><tr>' +
        '<th>Paciente</th><th>Procedimento</th><th>Hospital</th><th>Convênio</th><th>Data</th>' +
        '<th>Previsto</th><th>Recebido</th><th>Status</th></tr></thead><tbody>' +
        list.map(x => `
          <tr>
            <td>${utils.escapeHTML(x.paciente || '')}</td>
            <td>${utils.escapeHTML(x.procedimento || '')}</td>
            <td>${utils.escapeHTML(x.hospital || '')}</td>
            <td>${utils.escapeHTML(x.convenio || '')}</td>
            <td>${utils.formatarData(x.data_proc)}</td>
            <td>R$ ${utils.formatarBR(x.valor_previsto || 0)}</td>
            <td>R$ ${utils.formatarBR(x.valor_recebido || 0)}</td>
            <td>${utils.escapeHTML(x.status || '')}</td>
          </tr>
        `).join('') + '</tbody></table>';
    }
    html += printPreview._footer('Conciliação financeira');
    return html;
  },

  _buildAgenda() {
    const list = agenda.filtrar();
    const meta = `<strong>Agenda</strong><br>${new Date().toLocaleDateString('pt-BR')}<br>${list.length} compromisso(s)`;
    let html = printPreview._header('AGENDA', meta);
    if (list.length === 0) {
      html += '<div class="empty-state">Nenhum compromisso</div>';
    } else {
      html += '<table class="pp-table"><thead><tr>' +
        '<th>Data</th><th>Hora</th><th>Tipo</th><th>Paciente</th><th>Procedimento</th>' +
        '<th>Profissional</th><th>Local</th><th>Status</th></tr></thead><tbody>' +
        list.map(x => `
          <tr>
            <td>${utils.formatarData(x.data)}</td>
            <td>${utils.escapeHTML(x.hora || '')}</td>
            <td>${utils.escapeHTML(x.tipo || '')}</td>
            <td>${utils.escapeHTML(x.paciente || '')}</td>
            <td>${utils.escapeHTML(x.procedimento || '')}</td>
            <td>${utils.escapeHTML(x.cirurgiao || '')}</td>
            <td>${utils.escapeHTML(x.local || '')}</td>
            <td>${utils.escapeHTML(x.status || '')}</td>
          </tr>
        `).join('') + '</tbody></table>';
    }
    html += printPreview._footer('Agenda');
    return html;
  },

  _buildDashboard() {
    /* O relatório precisa dizer a MESMA coisa que a tela de onde ele saiu.
       Ele contava tudo: todo período, todo mundo, e rascunho junto com o que
       foi finalizado. Quem imprimia o painel recebia números que não batiam
       com os que acabara de olhar — e produção é justamente o número que se
       leva para fora do sistema.

       Mesma régua da tela: mesmo período, mesmo escopo (Pessoal/Clínica), e
       PRODUÇÃO = o que foi finalizado. Rascunho é trabalho em curso. */
    const periodo = (document.getElementById('dash-periodo') || {}).value || 'mes';
    const escopo = (document.getElementById('dash-escopo') || {}).value || 'pessoal';
    const filtPorMeta = list => dashboard.filtrarPorPeriodo(
      dashboard._filtrarEscopo(list || [], escopo)
        .map(it => Object.assign({}, it, { _dataClinica: dashboard._dataClinica(it) })),
      periodo, '_dataClinica');
    const rotuloPeriodo = (() => {
      const sel = document.getElementById('dash-periodo');
      const opt = sel && sel.options[sel.selectedIndex];
      return (opt && opt.textContent) || periodo;
    })();
    const meta = `<strong>Dashboard</strong><br>${new Date().toLocaleDateString('pt-BR')}` +
      `<br><span style="font-weight:normal">${utils.escapeHTML(rotuloPeriodo)} · ` +
      `${escopo === 'pessoal' ? 'meus atendimentos' : 'clínica'} · finalizados</span>`;
    let html = printPreview._header('RELATÓRIO — DASHBOARD', meta);
    /* Coleta totais */
    const allAnest = dashboard._soProducao(filtPorMeta(store.list('anestesia')));
    const allPre = dashboard._soProducao(filtPorMeta(store.list('pre')));
    const allCons = dashboard._soProducao(filtPorMeta(store.list('consulta')));
    const allRec = dashboard._soProducao(filtPorMeta(store.list('recuperacao')));
    const allFin = filtPorMeta(store.list('financeiro'));   /* financeiro não tem "finalizar" */
    const totPrev = allFin.reduce((s, x) => s + (parseFloat(x.valor_previsto) || 0), 0);
    const totRec = allFin.reduce((s, x) => s + (parseFloat(x.valor_recebido) || 0), 0);
    const totGlo = allFin.reduce((s, x) => s + (parseFloat(x.glosa) || 0), 0);
    html += printPreview._section('Totais', `
      <div class="pp-grid cols-3">
        ${printPreview._field('Anestesias', allAnest.length)}
        ${printPreview._field('Pré-anestésicas', allPre.length)}
        ${printPreview._field('Consultas', allCons.length)}
        ${printPreview._field('Recuperações pós', allRec.length)}
        ${printPreview._field('Registros financeiros', allFin.length)}
        ${printPreview._field('Pacientes únicos', dashboard.contarPacientesUnicos(allAnest, allPre, allCons, allRec))}
      </div>
    `);
    html += printPreview._section('Resumo financeiro', `
      <div class="pp-grid">
        ${printPreview._field('Previsto', 'R$ ' + utils.formatarBR(totPrev))}
        ${printPreview._field('Recebido', 'R$ ' + utils.formatarBR(totRec))}
        ${printPreview._field('Glosa', 'R$ ' + utils.formatarBR(totGlo))}
        ${printPreview._field('A receber', 'R$ ' + utils.formatarBR(totPrev - totRec - totGlo))}
      </div>
    `);
    html += printPreview._footer('Dashboard');
    return html;
  }
};

/* FIM DA CAMADA CENTRAL DE IMPRESSÃO */
