'use strict';

/* ============================================================================
   INICIALIZAÇÃO
============================================================================ */

document.addEventListener('DOMContentLoaded', () => {
  /* 0. DISCO GRANDE — abre o IndexedDB e MUDA para lá o que é pesado (imagens,
       versões, lixeira). É o que tira o sistema do teto de 5 MB do
       localStorage. Assíncrono de propósito: o app não espera, e a tela é
       repintada quando os dados chegam. */
  try { disco.iniciar(); } catch (e) {}
  /* 0a. Aplica tema salvo (claro/escuro) */
  ui._aplicarTemaSalvo();
  /* 0. EXPOSIÇÃO NO WINDOW — garante que inline handlers (onclick="...") acessem os módulos
       em qualquer navegador, mesmo quando const não é global. */
  window.utils = utils; window.store = store; window.ui = ui;
  window.backupCompleto = backupCompleto;
  window.lixeira = lixeira; window.duplicados = duplicados; window.espaco = espaco; window.modoNuvem = modoNuvem; window.preLanc = preLanc;
  /* O rodapé é montado no boot, quando ninguém está logado ainda — por isso o
     botão de enviar pré-lançamento nunca aparecia. Recalcula a cada
     salvar/carregar/novo, que é quando registro e usuário já são conhecidos. */
  try {
    const _ads = ui.atualizarDocStatus;
    if (typeof _ads === 'function') {
      ui.atualizarDocStatus = function (mod) {
        const r = _ads.apply(ui, arguments);
        try { preLanc.renderBotao(mod); } catch (e) {}
        return r;
      };
    }
  } catch (e) {}
  window.carimboHora = carimboHora;
  window.cronometros = cronometros;
  window.dashboard = dashboard; window.pre = pre; window.consulta = consulta;
  window.anestesia = anestesia; window.recuperacao = recuperacao;
  window.termo = termo; window.prescricao = prescricao; window.MED_BASE = MED_BASE;
  window.risco = risco;
  window.captura = captura;
  window.pdfGen = pdfGen;
  window.pdfBackup = pdfBackup;
  window.cloud = cloud;
  window.contextoAba = contextoAba;
  window.migracaoFase4 = migracaoFase4;
  window.cloudRel = cloudRel;
  window.cloudDiag = cloudDiag;
  window.cloudRealtime = cloudRealtime;
  window.adendos = adendos;
  window.equipeNuvem = equipeNuvem;
  window.auditoria = auditoria;
  window.auth = auth;
  window.demo = demo;
  try { pre.premed.render(); } catch (e) {}
  try { comorbidades.renderRapidas(); } catch (e) {}
  try { alergias.renderRapidas(); } catch (e) {}
  try { pre.viaAerea.render(); } catch (e) {}
  try { pre.nav._wire(); pre.nav.render(); } catch (e) {}
  window.ajustesUsuarios = ajustesUsuarios;
  window.meuDia = meuDia;
  window.armazenamento = armazenamento;
  window.fabDial = fabDial;
  window.termoPadrao = termoPadrao;
  window.termoBiblioteca = termoBiblioteca;
  window.medicamentos = medicamentos; window.medAutocomplete = medAutocomplete;
  window.riscosTermo = riscosTermo;
  window.textosPadrao = textosPadrao;
  window.pacienteAutocomplete = pacienteAutocomplete;
  window.comorbidades = comorbidades;
  window.labExtra = labExtra;
  window.alergias = alergias;
  window.medicacoes = medicacoes;
  window.sigUI = sigUI;
  window.financeiro = financeiro; window.agenda = agenda;
  window.orcamento = orcamento;
  window.precos = precos;   /* a janela de tabela por convênio é chamada do HTML */
  window.doses = doses;
  window.modal = modal; window.modelos = modelos; window.fin = fin;
  window.linker = linker; window.templates = templates;
  window.rascunhos = rascunhos; window.rascunhosSync = rascunhosSync; window.clinicaSync = clinicaSync; window.nuvemEstado = nuvemEstado;
  window.globalSearch = globalSearch; window.pacientes = pacientes;
  window.ajustes = ajustes; window.autocomplete = autocomplete;
  window.mutirao = mutirao;
  window.ambiente = ambiente;
  window.tabelasValores = tabelasValores;
  try { ambiente.pintar(); } catch (e) {}
  window.ajustesGrupos = ajustesGrupos;
  try { ajustesGrupos.montar(); } catch (e) {}
  window.configSync = configSync;
  try { configSync.vigiar(); } catch (e) {}
  try { clinicaSync.vigiar(); } catch (e) {}
  try { nuvemEstado.vigiar(); } catch (e) {}
  try { anestesia.graficoUI.renderLegendaFixa(); } catch (e) {}
  window.programador = programador;
  try { programador.atualizarVisibilidade(); } catch (e) {}
  window.pendencias = pendencias;
  try { pendencias.iniciarTimer(); } catch (e) {}
  window.realtime = realtime;
  /* A clínica avisa, em vez de o aparelho perguntar (Etapa 5). */
  try { realtime.vigiar(); } catch (e) {}
  /* Chegou pelo link de recuperação de senha do e-mail: trata a âncora antes
     de qualquer outra coisa, senão ela é lida como nome de módulo. */
  try { cloud.checarLinkRecuperacao(); } catch (e) {}
  window.escritaContinua = escritaContinua;
  try { escritaContinua.ligar(); } catch (e) {}
  /* Repara espelhos de conta da nuvem criados sem id (✏️/🗑️ sem ação) */
  try { auth._repararIds(); } catch (e) {}
  /* sessão válida desta aba: checa também as pendências do mesmo dono */
  setTimeout(() => { try { pendencias.checarAoEntrar(); } catch (e) {} }, 3500);
  /* Acerta os lançamentos de consulta/pré que nasceram com a cirurgia proposta
     no lugar do procedimento. Varredura sem escrita quando não há nada errado. */
  setTimeout(() => { try { fin.repararEAvisar(); } catch (e) {} }, 4000);
  window.quickActions = quickActions; window.printPreview = printPreview;
  window.actions = actions; window.toast = toast;
  window.cbhpm = cbhpm; window.CBHPM_2022 = CBHPM_2022; window.CBHPM_LEGADO = CBHPM_LEGADO;
  window.CBHPM_VERSAO = CBHPM_VERSAO; window.CBHPM_ANESTESICOS = CBHPM_ANESTESICOS; window.cbhpmUI = cbhpmUI;
  window.histAutocomplete = histAutocomplete;
  window.historico = historico; window.assinatura = assinatura;
  window.markDirty = markDirty; window.markClean = markClean;
  window.setSavedStatus = setSavedStatus;

  /* 0b. Dropdowns ("Carregar ▾"): clicar FORA fecha — o menu não fica preso na tela */
  document.addEventListener('click', (e) => {
    try {
      if (e.target.closest('.dropdown') || e.target.closest('.dropdown-menu')) return;
      ui.fecharDropdowns();
    } catch (err) {}
  });

  /* 1. Sidebar — clique nos itens (links via #hash) */
  document.querySelectorAll('#sidebar-nav .nav-item').forEach(item => {
    item.addEventListener('click', (e) => {
      e.preventDefault();
      const mod = item.dataset.module;
      /* Se o endereço já aponta para cá, atribuí-lo de novo não dispara nada:
         navega direto. (Com a sincronia acima isto é raro, mas o menu não
         pode depender de sorte.) */
      if (('#' + mod) === window.location.hash) ui.navegar(mod);
      else window.location.hash = mod;
    });
  });

  /* 2. Hashchange para navegação */
  function navegarPorHash() {
    if (ui._navegando) return;   /* foi a própria navegar() que ajustou o endereço */
    const h = (window.location.hash || '#dashboard').replace('#', '');
    ui.navegar(h || 'dashboard');
  }
  window.addEventListener('hashchange', navegarPorHash);

  /* Service worker: abertura instantânea e offline (network-first — online o
     app sempre vem da rede; o cache só entra quando a rede falha). Só em
     http/https; em file:// (testes locais) não se aplica. */
  if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    });
  }

  /* 3. Inicializa Anestesia (assinatura, linhas iniciais, data) */
  anestesia.signature.init();
  document.querySelector('#form-anestesia [name="data_anestesia"]').value = utils.hojeISO();

  /* 4. Restaurar autosave da Ficha de Anestesia */
  try {
    const auto = JSON.parse(localStorage.getItem(STORAGE.autosave) || 'null');
    if (auto && auto._meta) {
      const t = utils.formatarDataHora(auto._meta.salvoEm);
      if (confirm('Foi encontrado um auto-save da Ficha de Anestesia (' + t + '). Deseja restaurar?')) {
        anestesia.limparSilencioso();
        anestesia.restaurarEstruturado(auto);
      }
    }
  } catch { /* silencioso */ }

  /* 5. Listener de dirty na Ficha de Anestesia */
  document.getElementById('form-anestesia').addEventListener('input', () => {
    if (state.currentModule === 'anestesia') markDirty();
  });
  document.getElementById('form-anestesia').addEventListener('change', () => {
    if (state.currentModule === 'anestesia') markDirty();
  });

  /* 6. Toggle de auto-save */
  const autoChk = document.getElementById('autosave-chk');
  const pref = localStorage.getItem(STORAGE.autosavePref);
  state.autosaveEnabled = pref == null ? true : pref === '1';
  autoChk.checked = state.autosaveEnabled;
  autoChk.addEventListener('change', e => {
    state.autosaveEnabled = e.target.checked;
    localStorage.setItem(STORAGE.autosavePref, state.autosaveEnabled ? '1' : '0');
    toast(state.autosaveEnabled ? 'Auto-save ativado' : 'Auto-save desativado');
  });

  /* 6b. Toggle de auto-financeiro */
  const autoFinChk = document.getElementById('autofin-chk');
  if (autoFinChk) {
    autoFinChk.checked = fin.isAutoEnabled();
    autoFinChk.addEventListener('change', e => {
      fin.setAutoEnabled(e.target.checked);
      toast(e.target.checked ? 'Auto-financeiro ativado' : 'Auto-financeiro desativado');
    });
  }

  /* 6c. Busca global */
  const gsInput = document.getElementById('global-search-input');
  const gsResults = document.getElementById('global-search-results');
  if (gsInput) {
    let gsTimer;
    gsInput.addEventListener('input', () => {
      clearTimeout(gsTimer);
      gsTimer = setTimeout(globalSearch.render, 200);
    });
    gsInput.addEventListener('focus', () => { if (gsInput.value.length >= 2) globalSearch.render(); });
    document.addEventListener('click', e => {
      if (!gsInput.contains(e.target) && !gsResults.contains(e.target)) {
        gsResults.classList.remove('show');
      }
    });
  }

  /* 7. Aviso ao sair com dirty */
  window.addEventListener('beforeunload', e => {
    if (state.dirty) { e.preventDefault(); e.returnValue = ''; }
  });

  /* 8. Autosave periódico (8s) */
  setInterval(autoSaveAnestesia, 8000);
  setInterval(autoSaveUniversal, 10000);

  /* 9. Atalhos de teclado */
  document.addEventListener('keydown', e => {
    const ctrl = e.ctrlKey || e.metaKey;
    if (!ctrl) return;
    if (e.key === 's') {
      e.preventDefault();
      const mod = state.currentModule;
      if (mod === 'anestesia') anestesia.salvar();
      else if (mod === 'pre') pre.salvar();
      else if (mod === 'consulta') consulta.salvar();
      else if (mod === 'recuperacao') recuperacao.salvar();
    } else if (e.key === 'e') {
      e.preventDefault();
      const mod = state.currentModule;
      if (mod === 'anestesia') anestesia.exportar();
      else if (mod === 'pre') pre.exportar();
      else if (mod === 'consulta') consulta.exportar();
      else if (mod === 'recuperacao') recuperacao.exportar();
      else if (mod === 'financeiro') financeiro.exportar();
      else if (mod === 'agenda') agenda.exportar();
    } else if (e.key === 'r' && !e.shiftKey) {
      if (state.currentModule === 'anestesia') {
        e.preventDefault(); anestesia.resumo.gerar();
      }
    }
  });

  /* 10. Atualizar gráfico em resize */
  window.addEventListener('resize', () => anestesia.vitais.atualizarGrafico());

  /* 11. Setar datas padrão nos outros forms */
  document.querySelector('#form-pre [name="data"]').value = utils.hojeISO();
  document.querySelector('#form-consulta [name="data"]').value = utils.hojeISO();
  document.querySelector('#form-recuperacao [name="data"]').value = utils.hojeISO();

  /* 12. Status inicial */
  setSavedStatus('Pronto');
  markClean();

  /* 12b. Doc-status inicial dos módulos */
  ui.atualizarDocStatus('pre', null);
  ui.atualizarDocStatus('consulta', null);
  ui.atualizarDocStatus('anestesia', null);
  ui.atualizarDocStatus('recuperacao', null);

  /* 13. Renderiza listas iniciais */
  financeiro.render();
  agenda.render();
  pacientes.render();
  ajustes.render();

  /* 13b. Liga autocomplete em todos os campos relevantes */
  setTimeout(() => autocomplete.ligarTudo(), 100);

  /* 13b2. Caixas de texto acompanham o conteúdo. Um ouvinte só, na captura:
     vale para o que se digita E para o que os seletores (alergias,
     comorbidades, medicações, modelos) escrevem no campo — todos disparam
     'input'. Campo novo criado depois entra junto, sem precisar ser ligado. */
  document.addEventListener('input', (e) => {
    if (e.target && e.target.tagName === 'TEXTAREA') utils.autoAltura(e.target);
  }, true);
  /* rede de segurança: ficha carregada com o card já aberto não passa por
     nenhuma das varreduras — ao tocar no campo, ele se ajusta na hora */
  document.addEventListener('focusin', (e) => {
    if (e.target && e.target.tagName === 'TEXTAREA') utils.autoAltura(e.target);
  }, true);
  /* mudou a largura, mudou onde o texto quebra; e o teto vem da altura da tela */
  let _reAlt;
  window.addEventListener('resize', () => {
    clearTimeout(_reAlt);
    _reAlt = setTimeout(() => utils.autoAlturaTodos(document.querySelector('.module.active')), 150);
  });
  setTimeout(() => { utils.autoAlturaTodos(); utils.corretorTodos(); }, 300);

  /* 13e. Inicializa interação do gráfico (drag/touch) */
  setTimeout(() => {
    try { anestesia.graficoUI.init('anestesia'); } catch (e) { console.error('Erro graficoUI.init:', e); }
    try { anestesia.graficoUI.init('recuperacao'); } catch (e) { console.error('Erro graficoUI.init SRPA:', e); }
    try { termo.sig._init(); } catch (e) { console.error('Erro termo.sig.init:', e); }
    try { prescricao.sig._init(); prescricao.addItem(); } catch (e) { console.error('Erro prescricao.sig.init:', e); }
    /* Injeta o componente de assinatura (3 abas) do profissional em termo e prescrição */
    try {
      const hostT = document.getElementById('sig-termo-host');
      if (hostT) {
        hostT.innerHTML = assinatura.blocoHTML('sig-termo', 'profissional', 'crm');
        const cT = hostT.querySelector('[name="profissional"]');
        if (cT) autocomplete.ligarProfissionalEm(cT);
      }
      const hostP = document.getElementById('sig-prescricao-host');
      if (hostP) {
        hostP.innerHTML = assinatura.blocoHTML('sig-prescricao', 'profissional', 'crm');
        const cP = hostP.querySelector('[name="profissional"]');
        if (cP) autocomplete.ligarProfissionalEm(cP);
      }
      const hostD = document.getElementById('sig-documentos-host');
      if (hostD) {
        hostD.innerHTML = assinatura.blocoHTML('sig-documentos', 'profissional', 'crm');
        const cD = hostD.querySelector('[name="profissional"]');
        if (cD) autocomplete.ligarProfissionalEm(cD);
      }
      assinatura.initCanvas('sig-termo');
      assinatura.initCanvas('sig-prescricao');
      assinatura.initCanvas('sig-documentos');
    } catch (e) { console.error('Erro ao injetar assinatura termo/prescricao:', e); }
    try { cloud.init(); } catch (e) { console.error('Erro cloud.init:', e); }
    try { cloudRealtime.init(); } catch (e) { console.error('Erro cloudRealtime.init:', e); }
    try { textosPadrao.init(); } catch (e) { console.error('Erro textosPadrao.init:', e); }
    try { pacienteAutocomplete.init(); } catch (e) { console.error('Erro pacienteAutocomplete.init:', e); }
    try { backupCompleto.migrarOrcamentosPresos(); } catch (e) {}
    try { lixeira.purgarExpirados(); } catch (e) {}
    try { armazenamento.autoManutencao(); } catch (e) {}
    /* Módulo de risco: recálculo automático ao mudar qualquer campo */
    try {
      const fr = document.getElementById('form-risco');
      if (fr) {
        fr.querySelectorAll('input,select').forEach(el => {
          el.addEventListener('input', () => { try { risco.atualizar(); } catch (e) {} });
          el.addEventListener('change', () => { try { risco.atualizar(); } catch (e) {} });
        });
        risco.atualizar();
      }
    } catch (e) { console.error('Erro init risco:', e); }
  }, 150);

  /* 13f. Tutorial breve no primeiro uso do gráfico interativo */
  if (!localStorage.getItem('medsys.v7.tutorial_grafico')) {
    setTimeout(() => {
      const original = ui.navegar;
      ui.navegar = function(modName) {
        original.call(ui, modName);
        if (modName === 'anestesia' && !localStorage.getItem('medsys.v7.tutorial_grafico')) {
          localStorage.setItem('medsys.v7.tutorial_grafico', '1');
          setTimeout(() => {
            const html = `
              <div style="padding:6px 0;line-height:1.6">
                <p style="font-size:.95rem;margin-bottom:14px">Bem-vindo ao <strong>Registro gestual</strong> do gráfico de sinais vitais!</p>
                <div style="background:var(--surface-alt);padding:14px;border-radius:6px;margin-bottom:12px">
                  <p style="margin:4px 0"><strong>👆 Toque/clique simples</strong> → abre menu contextual para escolher PAS, PAD, FC, SpO₂, EtCO₂, evento ou medicação</p>
                  <p style="margin:4px 0"><strong>🖐 Arrastar (dedo ou mouse)</strong> → desenha curva contínua do parâmetro selecionado na toolbar</p>
                  <p style="margin:4px 0"><strong>⛶ Ampliar</strong> → modo tela cheia para preenchimento mais confortável</p>
                  <p style="margin:4px 0"><strong>📍 Evento e 💉 Medicação</strong> → botões na toolbar para registro rápido</p>
                </div>
                <p style="font-size:.84rem;color:var(--text-soft);margin-bottom:10px">
                  Os monitores marcados em <em>"4. Acessos, Dispositivos e Equipamentos"</em> (BIS, TOF, Glicemia, PVC, PIC, Temperatura, Débito Cardíaco, ScvO₂, Analisador de gases/CAM) automaticamente aparecem como botões no gráfico, cada um com sua cor própria.
                </p>
                <p style="font-size:.84rem;color:var(--text-soft);margin-bottom:14px">
                  A janela de tempo se ajusta automaticamente aos horários informados de entrada em sala, anestesia e cirurgia.
                </p>
                <div style="text-align:right">
                  <button class="btn btn-primary" onclick="modal.close()">Entendi, vamos lá!</button>
                </div>
              </div>
            `;
            modal.open('📈 Como usar o gráfico interativo', html, '');
          }, 600);
        }
      };
    }, 200);
  }

  /* 13c. Popula selects de assinatura nos forms */
  setTimeout(() => {
    if (pre._popularAssinaturas) pre._popularAssinaturas();
    if (consulta._popularAssinaturas) consulta._popularAssinaturas();
    if (anestesia._popularAssinaturas) anestesia._popularAssinaturas();
    if (recuperacao._popularAssinaturas) recuperacao._popularAssinaturas();
  }, 150);

  /* 13d. Atalhos Enter/Tab para navegar entre células nas tabelas dinâmicas */
  document.addEventListener('keydown', (e) => {
    const el = e.target;
    if (!el || (el.tagName !== 'INPUT' && el.tagName !== 'SELECT')) return;
    const td = el.closest('td');
    if (!td) return;
    const tr = td.parentElement;
    if (!tr || tr.tagName !== 'TR') return;
    const table = tr.closest('table.dyn');
    if (!table) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      /* Enter = próxima linha mesma coluna; se for última, adiciona nova linha */
      const colIdx = Array.from(tr.children).indexOf(td);
      const linhas = Array.from(table.querySelectorAll('tbody tr'));
      const idx = linhas.indexOf(tr);
      let alvo = linhas[idx + 1];
      if (!alvo) {
        /* Cria nova linha conforme a tabela ativa */
        const tableId = table.id;
        if (tableId === 'medicacoes-table' || table.querySelector('[name="med_nome[]"]')) anestesia.meds.add();
        else if (tableId === 'tab-vitais' || table.querySelector('[name="vit_hora[]"]')) anestesia.vitais.add();
        else if (table.querySelector('[name="hidra_tipo[]"]')) anestesia.hidra.add();
        const novas = Array.from(table.querySelectorAll('tbody tr'));
        alvo = novas[novas.length - 1];
      }
      if (alvo && alvo.children[colIdx]) {
        const next = alvo.children[colIdx].querySelector('input, select');
        if (next) next.focus();
      }
    }
    /* Tab é nativo do browser — não preciso interceptar */
  });

  /* 14. Navegar para o módulo da hash inicial */
  navegarPorHash();

  /* 15. Listener de mudança de orientação — re-renderiza gráfico */
  window.addEventListener('orientationchange', () => {
    setTimeout(() => {
      anestesia.vitais.atualizarGrafico();
      /* Re-renderiza assinatura para ajustar canvas */
      if (state.sigCtx) {
        const canvas = document.getElementById('signature-canvas');
        if (canvas) {
          const dpr = window.devicePixelRatio || 1;
          /* preserva imagem ao redimensionar */
          const tempImg = canvas.toDataURL();
          canvas.width = canvas.clientWidth * dpr;
          canvas.height = canvas.clientHeight * dpr;
          state.sigCtx = canvas.getContext('2d');
          state.sigCtx.scale(dpr, dpr);
          state.sigCtx.lineCap = 'round';
          state.sigCtx.lineJoin = 'round';
          state.sigCtx.lineWidth = 1.8;
          state.sigCtx.strokeStyle = '#1a2332';
          if (tempImg && tempImg !== 'data:,') {
            const img = new Image();
            img.onload = () => state.sigCtx.drawImage(img, 0, 0, canvas.clientWidth, canvas.clientHeight);
            img.src = tempImg;
          }
        }
      }
    }, 200);
  });

  /* === APLICA LOGOS ===
     Sidebar usa o ícone; impressão usa a versão horizontal com CREMEB/RQE.
     Se houver logomarca personalizada (Ajustes), ela sobrepõe a padrão. */
  try { logoUsuario.carregar(); } catch (e) { console.warn('logos:', e); }

  /* Aplica autocomplete CBHPM em todos os campos com class="cbhpm-autocomplete"
     (procedimento cirúrgico em Anestesia, Pré, SRPA, Consulta, Financeiro) */
  try { cbhpm.aplicarTodos(); } catch (e) { console.warn('cbhpm.aplicarTodos:', e); }
  /* Liga a base central de medicamentos em qualquer campo marcado com
     class="med-autocomplete" — é o ponto de extensão para um módulo novo
     precisar escolher medicamento sem escrever busca própria de novo. */
  try { medAutocomplete.aplicarTodos(); } catch (e) { console.warn('medAutocomplete.aplicarTodos:', e); }

  /* Autocomplete de HISTÓRICO nos campos de texto livre recorrentes
     (cirurgião, hospital, local, convênio, profissional) — sugere valores já usados. */
  try { histAutocomplete.aplicarTodos(); } catch (e) { console.warn('histAutocomplete.aplicarTodos:', e); }

  /* Popula blocos de assinatura nos módulos Pré, Consulta, Recuperação.
     A Anestesia mantém seu próprio bloco signature pad (compatibilidade). */
  try {
    const blocos = [
      { id: 'sig-pre-body',         pref: 'sig-pre',         nome: 'anestesiologista', crm: 'crm' },
      { id: 'sig-consulta-body',    pref: 'sig-consulta',    nome: 'profissional',     crm: 'crm' },
      { id: 'sig-recuperacao-body', pref: 'sig-recuperacao', nome: 'responsavel',      crm: 'registro' },
      { id: 'sig-anest-body',       pref: 'sig-anest',       nome: 'anestesiologista', crm: 'crm' }
    ];
    blocos.forEach(b => {
      const host = document.getElementById(b.id);
      if (host && !host.dataset.populado) {
        host.innerHTML = assinatura.blocoHTML(b.pref, b.nome, b.crm);
        host.dataset.populado = '1';
        /* liga o autocomplete de profissional ao campo recém-criado */
        try {
          const campoProf = host.querySelector(`[name="${b.nome}"]`);
          if (campoProf) autocomplete.ligarProfissionalEm(campoProf);
        } catch (e) {}
      }
    });
    /* Inicializa os signature pads ao trocar para a aba "desenho" — lazy */
  } catch (e) { console.warn('assinatura init:', e); }

  /* === SEGURANÇA: inicializa o controle de acesso (login/bloqueio) ===
     Deve ser a última etapa: se não houver sessão, bloqueia a tela. */
  /* Junta os três cadastros de profissional num só, uma vez, antes de
     qualquer tela ler deles. */
  try { ajustes.migrarProfissionais(); } catch (e) { console.warn('migrarProfissionais:', e); }

  try { auth.init(); } catch (e) { console.warn('auth.init:', e); }
});

/* FIM DO BOOTSTRAP DA APLICAÇÃO */
