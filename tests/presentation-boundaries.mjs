import { readRuntimeComposition, readCompiledActions } from './helpers/read-app-source.mjs';
/** F1d: apresentação isolada sem decidir autorização, estado clínico ou mutações de transporte. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { publicAssets } from '../scripts/public-assets.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..');
const rootArg = process.argv.find(arg => arg.startsWith('--app-root='));
const appRoot = rootArg ? resolve(process.cwd(), rootArg.slice('--app-root='.length)) : repo;

const SoftActions = await readCompiledActions(appRoot);

const [html, feedbackSource, anesthesiaEventCommandsSource, anesthesiaTimeToolsSource,
  syncStatusSource,
  modalSource, searchSource, patientsViewSource, autocompleteSource,
  quickActionsSource, printSource, meuDiaSource, dashboardSource, agendaViewSource,
  printMetaSource, layoutControlsSource, bootstrapSource, actionFeedbackSource,
  anesthesiaQuickCommandsSource,
  anesthesiaPatientBarSource, anesthesiaDosePanelSource, dashboardTodaySource,
  agendaTimelineSource, formSteppersSource, anesthesiaVitalsPanelSource,
  globalCommandSearchSource, runbook] = await Promise.all([
  readRuntimeComposition(appRoot),
  readFile(resolve(appRoot, 'src/ui/feedback.js'), 'utf8'),
  readFile(resolve(appRoot, 'src/domain/anesthesia-event-commands.js'), 'utf8'),
  readFile(resolve(appRoot, 'src/ui/anesthesia-time-tools.js'), 'utf8'),
  readFile(resolve(appRoot, 'src/ui/sync-status.js'), 'utf8'),
  readFile(resolve(appRoot, 'src/ui/modal.js'), 'utf8'),
  readFile(resolve(appRoot, 'src/ui/search.js'), 'utf8'),
  readFile(resolve(appRoot, 'src/ui/patients-view.js'), 'utf8'),
  readFile(resolve(appRoot, 'src/ui/autocomplete.js'), 'utf8'),
  readFile(resolve(appRoot, 'src/ui/quick-actions.js'), 'utf8'),
  readFile(resolve(appRoot, 'src/print/print-preview.js'), 'utf8'),
  readFile(resolve(appRoot, 'src/ui/meu-dia.js'), 'utf8'),
  readFile(resolve(appRoot, 'src/ui/dashboard.js'), 'utf8'),
  readFile(resolve(appRoot, 'src/ui/agenda-view.js'), 'utf8'),
  readFile(resolve(appRoot, 'src/print/print-meta.js'), 'utf8'),
  readFile(resolve(appRoot, 'src/ui/layout-controls.js'), 'utf8'),
  readFile(resolve(appRoot, 'src/app/bootstrap.js'), 'utf8'),
  readFile(resolve(appRoot, 'src/ui/action-feedback.js'), 'utf8'),
  readFile(resolve(appRoot, 'src/domain/anesthesia-quick-commands.js'), 'utf8'),
  readFile(resolve(appRoot, 'src/ui/anesthesia-patient-bar.js'), 'utf8'),
  readFile(resolve(appRoot, 'src/ui/anesthesia-dose-panel.js'), 'utf8'),
  readFile(resolve(appRoot, 'src/ui/dashboard-today.js'), 'utf8'),
  readFile(resolve(appRoot, 'src/ui/agenda-timeline.js'), 'utf8'),
  readFile(resolve(appRoot, 'src/ui/form-steppers.js'), 'utf8'),
  readFile(resolve(appRoot, 'src/ui/anesthesia-vitals-panel.js'), 'utf8'),
  readFile(resolve(appRoot, 'src/ui/global-command-search.js'), 'utf8'),
  readFile(resolve(repo, 'docs/engineering/F1-MODULARIZATION.md'), 'utf8'),
]);

const linkerRef = 'src="src/domain/encounter-linker.js"';
const platformRef = 'src="src/platform/session-vault.js"';
const feedbackRef = 'src="src/ui/feedback.js"';
const clinicalStoreRef = 'src="src/platform/clinical-store.js"';
const anesthesiaEventCommandsRef = 'src="src/domain/anesthesia-event-commands.js"';
const anesthesiaTimeToolsRef = 'src="src/ui/anesthesia-time-tools.js"';
const syncStatusRef = 'src="src/ui/sync-status.js"';
const modalRef = 'src="src/ui/modal.js"';
const searchRef = 'src="src/ui/search.js"';
const patientsViewRef = 'src="src/ui/patients-view.js"';
const autocompleteRef = 'src="src/ui/autocomplete.js"';
const quickActionsRef = 'src="src/ui/quick-actions.js"';
const printRef = 'src="src/print/print-preview.js"';
const meuDiaRef = 'src="src/ui/meu-dia.js"';
const dashboardRef = 'src="src/ui/dashboard.js"';
const agendaViewRef = 'src="src/ui/agenda-view.js"';
const printMetaRef = 'src="src/print/print-meta.js"';
const layoutControlsRef = 'src="src/ui/layout-controls.js"';
const bootstrapRef = 'src="src/app/bootstrap.js"';
const actionFeedbackRef = 'src="src/ui/action-feedback.js"';
const qrRef = 'src="src/shared/soft-qr.js"';
const signatureRef = 'src="src/integrations/signature-digital.js"';
const anesthesiaQuickCommandsRef = 'src="src/domain/anesthesia-quick-commands.js"';
const anesthesiaPatientBarRef = 'src="src/ui/anesthesia-patient-bar.js"';
const anesthesiaDosePanelRef = 'src="src/ui/anesthesia-dose-panel.js"';
const dashboardTodayRef = 'src="src/ui/dashboard-today.js"';
const agendaTimelineRef = 'src="src/ui/agenda-timeline.js"';
const formSteppersRef = 'src="src/ui/form-steppers.js"';
const anesthesiaVitalsPanelRef = 'src="src/ui/anesthesia-vitals-panel.js"';
const globalCommandSearchRef = 'src="src/ui/global-command-search.js"';
assert(html.indexOf(feedbackRef) > html.indexOf(platformRef),
  'feedback deve carregar depois das utilidades e do contexto inicial');
assert(html.indexOf(feedbackRef) < html.indexOf(modalRef),
  'feedback deve existir antes dos consumidores visuais posteriores');
assert(html.indexOf(clinicalStoreRef) > html.indexOf(feedbackRef),
  'store clínico deve continuar imediatamente depois do feedback');
assert(html.indexOf(anesthesiaEventCommandsRef) > html.indexOf(feedbackRef),
  'comandos de evento devem carregar depois das utilidades e do store');
assert(html.indexOf(anesthesiaTimeToolsRef) > html.indexOf(anesthesiaEventCommandsRef),
  'ferramentas temporais devem carregar depois da fronteira clínica');
assert(html.indexOf(syncStatusRef) > html.indexOf(anesthesiaTimeToolsRef),
  'status de sincronização deve preservar sua posição depois das ferramentas iniciais');
assert(html.indexOf(syncStatusRef) < html.indexOf(modalRef),
  'status de sincronização deve existir antes dos consumidores de nuvem posteriores');
assert(html.indexOf(anesthesiaTimeToolsRef) < html.indexOf(modalRef),
  'ferramentas temporais devem preservar a posição anterior aos módulos clínicos');
assert(html.indexOf(modalRef) > html.indexOf(linkerRef),
  'modal deve preservar a posição posterior ao domínio');
assert(html.indexOf(modalRef) < html.indexOf(qrRef),
  'modal deve carregar antes das integrações finais');
assert(html.indexOf(searchRef) > html.indexOf(modalRef),
  'busca deve manter a posição posterior ao modal');
assert(html.indexOf(patientsViewRef) > html.indexOf(searchRef),
  'lista de pacientes deve continuar depois da busca');
assert(html.indexOf(autocompleteRef) > html.indexOf(patientsViewRef),
  'autocomplete deve manter a posição posterior aos componentes básicos');
assert(html.indexOf(autocompleteRef) < html.indexOf(qrRef),
  'autocomplete deve carregar antes das integrações finais');
assert(html.indexOf(quickActionsRef) > html.indexOf(autocompleteRef),
  'ações rápidas devem carregar depois do autocomplete que preenche os módulos');
assert(html.indexOf(printRef) > html.indexOf(quickActionsRef),
  'impressão deve manter sua posição depois dos componentes de seleção');
assert(html.indexOf(meuDiaRef) > html.indexOf(printRef),
  'Meu Dia deve continuar depois da impressão central');
assert(html.indexOf(dashboardRef) > html.indexOf(meuDiaRef),
  'dashboard deve continuar depois do Meu Dia');
assert(html.indexOf(agendaViewRef) > html.indexOf(dashboardRef),
  'apresentação da Agenda deve continuar depois do dashboard');
assert(html.indexOf(printMetaRef) > html.indexOf(agendaViewRef),
  'metadados de impressão devem continuar depois da Agenda');
assert(html.indexOf(layoutControlsRef) > html.indexOf(printMetaRef),
  'controles de layout devem continuar depois da Agenda');
assert(html.indexOf(layoutControlsRef) < html.indexOf(qrRef),
  'controles de layout devem carregar antes das integrações finais');
assert(html.indexOf(bootstrapRef) > html.indexOf(layoutControlsRef),
  'bootstrap deve manter a posição posterior aos módulos que inicializa');
assert(html.indexOf(actionFeedbackRef) > html.indexOf(bootstrapRef),
  'feedback de ações deve continuar depois da inicialização principal');
assert(html.indexOf(actionFeedbackRef) < html.indexOf(qrRef),
  'feedback de ações deve continuar antes do encoder de QR');
assert(html.indexOf(anesthesiaQuickCommandsRef) > html.indexOf(signatureRef),
  'comandos rápidos da anestesia devem carregar depois das integrações');
assert(html.indexOf(anesthesiaPatientBarRef) > html.indexOf(anesthesiaQuickCommandsRef),
  'barra do paciente deve carregar depois da fronteira clínica');
assert(html.indexOf(anesthesiaDosePanelRef) > html.indexOf(anesthesiaPatientBarRef),
  'painel de dose deve carregar depois da barra da ficha');
assert(html.indexOf(dashboardTodayRef) > html.indexOf(signatureRef),
  'resumo de hoje deve preservar a posição posterior às integrações');
assert(html.indexOf(dashboardTodayRef) > html.indexOf(anesthesiaDosePanelRef),
  'resumo de hoje deve continuar depois do painel de dose');
assert(html.indexOf(agendaTimelineRef) > html.indexOf(dashboardTodayRef),
  'linha do tempo deve continuar depois do resumo de hoje');
assert(html.indexOf(formSteppersRef) > html.indexOf(agendaTimelineRef),
  'seletores rápidos devem continuar depois da linha do tempo');
assert(html.indexOf(anesthesiaVitalsPanelRef) > html.indexOf(formSteppersRef),
  'painel de sinais vitais deve preservar sua posição após os seletores');
assert(html.indexOf(globalCommandSearchRef) > html.indexOf(formSteppersRef),
  'busca global deve continuar no encerramento da composição visual');
assert(html.indexOf(globalCommandSearchRef) > html.indexOf(anesthesiaVitalsPanelRef),
  'busca global deve continuar depois do painel de sinais vitais');
assert.match(html,
  /src="src\/ui\/modal\.js"><\/script>\s*<script>\s*'use strict';\s*\/\* ={20,}\s*MODELOS/,
  'continuação do runtime deve manter modo estrito e ordem síncrona');
assert.match(html,
  /src="src\/ui\/feedback\.js"><\/script>\s*<script src="src\/platform\/clinical-store\.js"><\/script>\s*<script src="src\/domain\/anesthesia-event-commands\.js"><\/script>/,
  'store clínico deve continuar entre o feedback e os comandos de evento');
assert.match(html,
  /src="src\/domain\/anesthesia-event-commands\.js"><\/script>\s*<script src="src\/ui\/anesthesia-time-tools\.js"><\/script>\s*<script>\s*'use strict';\s*\/\* ={20,}\s*EXPORTAÇÃO LEGADA/,
  'comando e ferramentas temporais devem preservar a fronteira síncrona anterior à exportação legada');
assert.match(html,
  /src="src\/ui\/sync-status\.js"><\/script>\s*<script>\s*'use strict';\s*\/\* ={20,}\s*ACTIONS/,
  'status de sincronização deve preservar a fronteira síncrona anterior às ações');
assert.match(html,
  /src="src\/ui\/autocomplete\.js"><\/script>\s*<script src="src\/ui\/quick-actions\.js"><\/script>/,
  'ações rápidas devem continuar imediatamente depois do autocomplete');
assert.match(html,
  /src="src\/ui\/quick-actions\.js"><\/script>\s*<script>\s*'use strict';\s*\/\* ={20,}\s*ÍCONES SVG/,
  'recursos de jejum devem continuar imediatamente depois das ações rápidas');
assert.match(html,
  /src="src\/ui\/search\.js"><\/script>\s*<script src="src\/ui\/patients-view\.js"><\/script>\s*<script>\s*'use strict';\s*\/\* ={20,}\s*MÓDULO — PACIENTES/,
  'apresentação e módulo de pacientes devem preservar a ordem síncrona');
assert.match(html,
  /src="src\/print\/print-preview\.js"><\/script>\s*<script src="src\/ui\/meu-dia\.js"><\/script>\s*<script src="src\/ui\/dashboard\.js"><\/script>\s*<script>\s*'use strict';\s*\/\* ={20,}\s*MÓDULO — FINANCEIRO/,
  'Meu Dia, dashboard e financeiro devem preservar a ordem síncrona');
assert.match(html,
  /src="src\/ui\/agenda-view\.js"><\/script>\s*<script>\s*'use strict';\s*\/\* ={20,}\s*MÓDULO — AGENDA/,
  'apresentação e módulo da Agenda devem preservar a ordem síncrona');
assert.match(html,
  /src="src\/print\/print-meta\.js"><\/script>\s*<script src="src\/ui\/layout-controls\.js"><\/script>\s*<script src="src\/app\/bootstrap\.js"><\/script>/,
  'metadados, controles de layout e bootstrap devem manter a ordem síncrona');
assert.match(html,
  /src="src\/app\/bootstrap\.js"><\/script>\s*<script src="src\/ui\/action-feedback\.js"><\/script>/,
  'bootstrap deve terminar imediatamente antes do feedback visual');
assert.match(html,
  /src="src\/ui\/action-feedback\.js"><\/script>\s*<!-- ={20,}\s*QR CODE/,
  'feedback visual deve carregar imediatamente antes do encoder de QR');
assert.match(html,
  /src="src\/domain\/anesthesia-quick-commands\.js"><\/script>\s*<script src="src\/ui\/anesthesia-patient-bar\.js"><\/script>\s*<script src="src\/ui\/anesthesia-dose-panel\.js"><\/script>\s*<script src="src\/ui\/dashboard-today\.js"><\/script>\s*<script src="src\/ui\/agenda-timeline\.js"><\/script>\s*<script src="src\/ui\/form-steppers\.js"><\/script>/,
  'widgets de dashboard, Agenda e formulário devem manter a ordem original');
assert.match(html,
  /id="vit-sheet"[\s\S]*src="src\/ui\/anesthesia-vitals-panel\.js"><\/script>[\s\S]*id="gs-overlay"/,
  'painel de sinais vitais deve carregar depois do próprio markup e antes da busca');
assert.match(html,
  /src="src\/ui\/global-command-search\.js"><\/script>\s*<\/body>/,
  'busca global deve permanecer como último script da página');
assert.doesNotMatch(html, /const modal\s*=\s*\{/,
  'implementação do modal não pode voltar ao HTML monolítico');
assert.doesNotMatch(html, /function toast\s*\(/,
  'implementação do feedback não pode voltar ao HTML monolítico');
assert.doesNotMatch(html, /const autocomplete\s*=\s*\{/,
  'autocomplete canônico não pode voltar ao HTML monolítico');
assert.doesNotMatch(html, /const (?:historico|globalSearch)\s*=\s*\{/,
  'busca e histórico não podem voltar ao HTML monolítico');
assert.doesNotMatch(html, /const patientsView\s*=\s*\{/,
  'apresentação de pacientes não pode voltar ao HTML monolítico');
assert.doesNotMatch(html, /const printPreview\s*=\s*\{/,
  'impressão central não pode voltar ao HTML monolítico');
assert.doesNotMatch(html, /const quickActions\s*=\s*\{/,
  'ações rápidas não podem voltar ao HTML monolítico');
assert.doesNotMatch(html, /const meuDia\s*=\s*\{/,
  'Meu Dia não pode voltar ao HTML monolítico');
assert.doesNotMatch(html, /const dashboard\s*=\s*\{/,
  'dashboard não pode voltar ao HTML monolítico');
assert.doesNotMatch(html, /const agendaView\s*=\s*\{/,
  'apresentação da Agenda não pode voltar ao HTML monolítico');
assert.doesNotMatch(html, /const (?:acoesUI|ajustesGrupos)\s*=\s*\{/,
  'controles de layout não podem voltar ao HTML monolítico');
assert.doesNotMatch(html, /const PADRAO_ONCLICK\s*=/,
  'feedback de ações não pode voltar ao HTML monolítico');
assert.doesNotMatch(html, /function renderHero\s*\(/,
  'resumo de hoje não pode voltar ao HTML monolítico');
assert.doesNotMatch(html, /window\.agTimeline\s*=\s*\{/,
  'linha do tempo não pode voltar ao HTML monolítico');
assert.doesNotMatch(html, /dataset\.stepper\s*=\s*['"]1['"]/,
  'seletores rápidos não podem voltar ao HTML monolítico');
assert.doesNotMatch(html, /window\.buscaGlobal\s*=\s*\{/,
  'busca global de comandos não pode voltar ao HTML monolítico');
assert.doesNotMatch(html, /window\.(?:doseRapida|vitaisRapidos)\s*=\s*\{/,
  'painéis rápidos da anestesia não podem voltar ao HTML monolítico');
assert.doesNotMatch(html, /function atualizarMetaImpressao\s*\(/,
  'metadados de impressão não podem voltar ao HTML monolítico');
assert.doesNotMatch(html, /const (?:anesthesiaEventCommands|carimboHora|fabDial|cronometros)\s*=\s*\{/,
  'comandos e ferramentas temporais não podem voltar ao HTML monolítico');
assert.doesNotMatch(html, /const syncStatus\s*=\s*\{|function setSavedStatus\s*\(/,
  'status de sincronização não pode voltar ao HTML monolítico');
assert.doesNotMatch(html, /\* ={20,}\s*INICIALIZAÇÃO/,
  'bootstrap não pode voltar ao HTML monolítico');

assert.match(feedbackSource, /^'use strict';/);
assert.match(feedbackSource, /function toast\s*\(/);
assert.match(feedbackSource, /utils\.escapeHTML\(msg\)/,
  'mensagem do toast deve continuar escapada antes de entrar no DOM');
assert.match(feedbackSource, /FIM DO FEEDBACK DE APRESENTAÇÃO/);
assert.match(anesthesiaEventCommandsSource, /^'use strict';/);
assert.match(anesthesiaEventCommandsSource, /const anesthesiaEventCommands\s*=\s*\{/);
assert.match(anesthesiaEventCommandsSource, /recuperacao\.grafico\.addEvento\(\{ hora \}\)/,
  'comando deve manter o carimbo da SRPA na fonte clínica canônica');
assert.match(anesthesiaEventCommandsSource, /anestesia\.eventos\.add\(\{ hora \}\)/,
  'comando deve manter o carimbo da anestesia na fonte clínica canônica');
assert.match(anesthesiaEventCommandsSource, /FIM DOS COMANDOS CLÍNICOS DE EVENTO DA ANESTESIA/);
assert.doesNotMatch(anesthesiaEventCommandsSource,
  /\b(?:store|cloudRel|persistenciaCloudFirst|contextoAba|realtime|supabase|auth|localStorage)\b/,
  'comando de evento não pode assumir persistência, sessão ou transporte');
assert.match(anesthesiaTimeToolsSource, /^'use strict';/);
assert.match(anesthesiaTimeToolsSource, /const carimboHora\s*=\s*\{/);
assert.match(anesthesiaTimeToolsSource, /const fabDial\s*=\s*\{/);
assert.match(anesthesiaTimeToolsSource, /const cronometros\s*=\s*\{/);
assert.match(anesthesiaTimeToolsSource,
  /anesthesiaEventCommands\.registrarCarimbo\(state\.currentModule\)/,
  'apresentação deve delegar o carimbo ao comando clínico');
assert.doesNotMatch(anesthesiaTimeToolsSource,
  /(?:anestesia\.eventos\.add|recuperacao\.grafico\.addEvento)\s*\(/,
  'apresentação não pode inserir eventos diretamente na ficha');
assert.match(anesthesiaTimeToolsSource, /FIM DAS FERRAMENTAS TEMPORAIS DE APRESENTAÇÃO/);
assert.match(syncStatusSource, /^'use strict';/);
assert.match(syncStatusSource, /const syncStatus\s*=\s*\{/);
assert.match(syncStatusSource, /function setSavedStatus\s*\(/);
assert.match(syncStatusSource,
  /else if \(this\._cloud === 'synced'\) \{\s*txt = 'Sincronizado'/,
  'sincronizado só pode ser exibido após estado remoto confirmado');
assert(syncStatusSource.indexOf('conflitosN > 0') < syncStatusSource.indexOf("this._cloud === 'syncing'"),
  'conflito preservado deve ter prioridade visual sobre sincronização');
assert.match(syncStatusSource, /FIM DO STATUS VISUAL DE SINCRONIZAÇÃO/);
assert.doesNotMatch(syncStatusSource,
  /(?:store\.(?:save|delete|setList)|cloudRel\.(?:enviar|remover|drenar)|persistenciaCloudFirst\.(?:salvar|remover|drenar)|localStorage\.(?:setItem|removeItem))\s*\(/,
  'status visual não pode gravar, remover ou drenar dados');
assert.match(modalSource, /^'use strict';/);
assert.match(modalSource, /const modal\s*=\s*\{/);
assert.match(modalSource, /FIM DO MODAL DE APRESENTAÇÃO/);
assert.match(searchSource, /^'use strict';/);
assert.match(searchSource, /const historico\s*=\s*\{/);
assert.match(searchSource, /const globalSearch\s*=\s*\{/);
assert.match(searchSource, /FIM DA BUSCA E DO HISTÓRICO DE APRESENTAÇÃO/);
assert.match(searchSource, /_prontEscolhas\(opcoes\)/,
  'histórico deve continuar exigindo escolha diante de prontuários ambíguos');
assert.match(patientsViewSource, /^'use strict';/);
assert.match(patientsViewSource, /const patientsView\s*=\s*\{/);
assert.match(patientsViewSource, /store\.getById\('pacientes', id\)/,
  'ação da tabela deve resolver o paciente novamente pelo ID');
assert.match(patientsViewSource, /data-pac-action="historico"/);
assert.match(patientsViewSource, /return list\.slice\(\)\.sort\(cmp\)/,
  'ordenar a tela não pode alterar a ordem armazenada');
assert.match(patientsViewSource, /FIM DA APRESENTAÇÃO DE PACIENTES/);
assert.doesNotMatch(patientsViewSource, /store\.(?:save|delete|setList)\s*\(/,
  'apresentação de pacientes não pode gravar nem excluir prontuários');
assert.match(autocompleteSource, /^'use strict';/);
assert.match(autocompleteSource, /const autocomplete\s*=\s*\{/);
assert.match(autocompleteSource, /FIM DO AUTOCOMPLETE DE APRESENTAÇÃO/);
assert.match(autocompleteSource, /_patientKey: identityKey, _patientRef: patientRef/,
  'autocomplete deve preservar a identidade selecionada no documento');
assert.match(autocompleteSource, /linker\.limparContextoPaciente\(MOD\)/,
  'trocar de paciente deve continuar invalidando o contexto anterior');
assert.match(quickActionsSource, /^'use strict';/);
assert.match(quickActionsSource, /const quickActions\s*=\s*\{/);
assert.match(quickActionsSource, /store\.getById\('pacientes', pacienteId\)/,
  'ação rápida deve resolver paciente pelo ID, nunca por coincidência de nome');
assert.match(quickActionsSource, /FIM DAS AÇÕES RÁPIDAS DE APRESENTAÇÃO/);
assert.match(printSource, /^'use strict';/);
assert.match(printSource, /const printPreview\s*=\s*\{/);
assert.match(printSource, /FIM DA CAMADA CENTRAL DE IMPRESSÃO/);
assert.match(printSource, /Não é seguro juntar ficha e SRPA sem o mesmo atendimento vinculado/);
assert.match(printSource, /pacientes ou atendimentos diferentes/);
assert.doesNotMatch(printSource, /store\.(?:save|delete|setList)\s*\(/,
  'impressão não pode alterar o prontuário que renderiza');
assert.match(printMetaSource, /^'use strict';/);
assert.match(printMetaSource, /function atualizarMetaImpressao\s*\(/);
assert.match(printMetaSource, /utils\.escapeHTML\(periodo\)/,
  'período do dashboard deve ser escapado antes de entrar no cabeçalho de impressão');
assert.match(printMetaSource, /utils\.escapeHTML\(getNome\('form-anestesia'\)\)/,
  'nome do paciente deve ser escapado antes de entrar no cabeçalho de impressão');
assert.match(printMetaSource, /utils\.escapeHTML\(procA\)/,
  'procedimento deve ser escapado antes de entrar no cabeçalho de impressão');
assert.match(printMetaSource, /utils\.escapeHTML\(utils\.formatarData\(dataA\)\)/,
  'data formatada deve ser escapada antes de entrar no cabeçalho de impressão');
assert.match(printMetaSource, /window\.addEventListener\('beforeprint', atualizarMetaImpressao\)/);
assert.match(printMetaSource, /FIM DOS METADADOS DE IMPRESSÃO/);
assert.doesNotMatch(printMetaSource, /store\.(?:save|delete|setList)\s*\(/,
  'metadados de impressão não podem alterar o prontuário');
assert.doesNotMatch(printMetaSource,
  /\b(?:cloud|cloudRel|persistenciaCloudFirst|contextoAba|realtime|supabase|auth|localStorage)\b/,
  'metadados de impressão não podem assumir transporte, sessão ou persistência');
assert.match(bootstrapSource, /^'use strict';/);
assert.match(bootstrapSource, /document\.addEventListener\('DOMContentLoaded'/);
assert.match(bootstrapSource, /disco\.iniciar\(\)/);
assert.match(bootstrapSource, /realtime\.vigiar\(\)/);
assert.match(bootstrapSource, /cloud\.checarLinkRecuperacao\(\)/);
assert.match(bootstrapSource, /escritaContinua\.ligar\(\)/);
assert.match(bootstrapSource, /navigator\.serviceWorker\.register\('sw\.js'\)/);
assert.match(bootstrapSource, /FIM DO BOOTSTRAP DA APLICAÇÃO/);
assert(bootstrapSource.indexOf('disco.iniciar()') < bootstrapSource.indexOf('realtime.vigiar()'),
  'bootstrap deve preservar a ordem entre armazenamento local e Realtime');
assert(bootstrapSource.indexOf('realtime.vigiar()') < bootstrapSource.indexOf('auth.init()'),
  'controle de acesso deve continuar depois da composição do runtime');
assert.match(bootstrapSource,
  /try \{ auth\.init\(\); \} catch \(e\) \{ console\.warn\('auth\.init:', e\); \}\s*\}\);\s*\/\* FIM DO BOOTSTRAP DA APLICAÇÃO \*\/\s*$/,
  'auth.init deve permanecer como última etapa do bootstrap');
assert.match(meuDiaSource, /^'use strict';/);
assert.match(meuDiaSource, /const meuDia\s*=\s*\{/);
assert.match(meuDiaSource, /linker\._chavePaciente\(item\)/,
  'Meu Dia deve agrupar por identidade forte, não apenas pelo nome');
assert.match(meuDiaSource, /Registro legado sem vínculo fica isolado/);
assert.match(meuDiaSource, /FIM DO PAINEL MEU DIA/);
assert.doesNotMatch(meuDiaSource, /store\.(?:save|delete|setList)\s*\(/,
  'coleta e renderização do Meu Dia não podem gravar prontuários diretamente');
assert.match(dashboardSource, /^'use strict';/);
assert.match(dashboardSource, /const dashboard\s*=\s*\{/);
assert.match(dashboardSource, /cloudRel\.autoPullModulo\(m\)/,
  'dashboard deve delegar a leitura da clínica ao adaptador relacional');
assert.match(dashboardSource, /linker\._chavePaciente\(it\)/,
  'total de pacientes deve usar identidade forte');
assert.match(dashboardSource, /FIM DO DASHBOARD DE APRESENTAÇÃO/);
assert.doesNotMatch(dashboardSource, /store\.(?:save|delete|setList)\s*\(/,
  'dashboard não pode gravar prontuários diretamente');
assert.match(agendaViewSource, /^'use strict';/);
assert.match(agendaViewSource, /const agendaView\s*=\s*\{/);
assert.match(agendaViewSource, /(?:agenda\.cal\.abrirDia\(\$\{utils\.jsArg\(iso\)\}\)|SoftActions\.html\([^\n]+utils\.jsArg\(iso\))/,
  'dias do calendário devem continuar usando argumento JavaScript seguro');
assert.match(agendaViewSource, /return list\.filter\(x =>/);
assert.match(agendaViewSource, /FIM DA APRESENTAÇÃO DA AGENDA/);
assert.doesNotMatch(agendaViewSource, /store\.(?:save|delete|setList)\s*\(/,
  'apresentação da Agenda não pode gravar nem excluir compromissos');
assert.doesNotMatch(agendaViewSource, /\b(?:cloudRel|persistenciaCloudFirst|contextoAba)\b/,
  'apresentação da Agenda não pode assumir transporte ou contexto de autorização');
assert.match(layoutControlsSource, /^'use strict';/);
assert.match(layoutControlsSource, /const acoesUI\s*=\s*\{/);
assert.match(layoutControlsSource, /const ajustesGrupos\s*=\s*\{/);
assert.match(layoutControlsSource, /medsys\.v7\.acoes\.abertas/);
assert.match(layoutControlsSource, /medsys\.v7\.ajustes\.sysgrupos/);
assert.match(layoutControlsSource, /FIM DOS CONTROLES VISUAIS DE LAYOUT/);
assert.doesNotMatch(layoutControlsSource, /store\.(?:save|delete|setList)\s*\(/,
  'preferências visuais não podem gravar prontuários');
assert.doesNotMatch(layoutControlsSource,
  /\b(?:cloudRel|persistenciaCloudFirst|contextoAba|realtime|supabase)\b/,
  'preferências visuais não podem assumir transporte, sessão ou Realtime');
assert.match(actionFeedbackSource, /const PADRAO_ONCLICK\s*=/);
assert.match(actionFeedbackSource, /btn-acao-processando/,
  'clique deve mostrar apenas um estado transitório neutro');
assert.doesNotMatch(actionFeedbackSource, /btn-acao-ok|['"](?:Salvo|Atualizado|Feito)['"]|['"]✓ /,
  'feedback por clique não pode declarar sucesso antes do resultado real');
assert.match(actionFeedbackSource, /FIM DO FEEDBACK VISUAL DE AÇÕES/);
assert.match(anesthesiaQuickCommandsSource, /^'use strict';/);
assert.match(anesthesiaQuickCommandsSource, /const anesthesiaQuickCommands\s*=\s*\{/);
assert.match(anesthesiaQuickCommandsSource, /anestesia\.meds\.add\(item\)/,
  'somente a fronteira clínica deve inserir a dose na ficha aberta');
assert.match(anesthesiaQuickCommandsSource, /anestesia\.vitais\.add\(false, item\)/,
  'somente a fronteira clínica deve inserir sinais vitais na ficha aberta');
assert.match(anesthesiaQuickCommandsSource, /markDirty\(\)/,
  'comandos clínicos devem preservar a marcação de edição pendente');
assert.doesNotMatch(anesthesiaQuickCommandsSource,
  /\b(?:store|cloudRel|persistenciaCloudFirst|contextoAba|realtime|supabase)\b/,
  'atalhos clínicos não podem assumir persistência, sessão ou transporte');
assert.match(anesthesiaPatientBarSource, /FIM DA BARRA VISUAL DO PACIENTE NA ANESTESIA/);
assert.match(anesthesiaPatientBarSource, /function esc\s*\(/,
  'barra do paciente deve escapar dados antes de montar HTML');
assert.doesNotMatch(anesthesiaPatientBarSource,
  /\b(?:anestesia\.meds\.add|anestesia\.vitais\.add|markDirty|store\.(?:save|delete|setList))\b/,
  'barra visual não pode modificar a ficha clínica');
assert.match(anesthesiaDosePanelSource, /anesthesiaQuickCommands\.registrarDose\(/);
assert.doesNotMatch(anesthesiaDosePanelSource, /anestesia\.meds\.add|markDirty\s*\(/,
  'painel visual de dose deve delegar a mutação ao comando clínico');
assert.match(anesthesiaDosePanelSource, /FIM DO PAINEL VISUAL DE DOSE RÁPIDA/);
assert.match(anesthesiaVitalsPanelSource, /function esc\s*\(/,
  'painel de vitais deve possuir escaping no próprio escopo');
assert.match(anesthesiaVitalsPanelSource, /anesthesiaQuickCommands\.lerUltimosVitais\(\)/);
assert.match(anesthesiaVitalsPanelSource, /anesthesiaQuickCommands\.registrarVitais\(/);
assert.doesNotMatch(anesthesiaVitalsPanelSource,
  /anestesia\.vitais\.(?:add|_calcPAM)|anestesia\.grafico\.render|markDirty\s*\(/,
  'painel visual de vitais deve delegar cálculo e mutação ao comando clínico');
assert.match(anesthesiaVitalsPanelSource, /FIM DO PAINEL VISUAL DE SINAIS VITAIS/);
assert.match(dashboardTodaySource, /store\.list\('agenda'\)/,
  'resumo de hoje deve continuar lendo a Agenda canônica');
assert.match(dashboardTodaySource, /FIM DO RESUMO DE HOJE DO DASHBOARD/);
assert.match(agendaTimelineSource, /window\.agTimeline\s*=\s*\{/);
assert.match(agendaTimelineSource, /(?:agenda\.editar\('\+utils\.jsArg\(a\._id\|\|''\)\+'\)|SoftActions\.html\([^\n]+utils\.jsArg\(a\._id\|\|''\))/,
  'linha do tempo deve abrir o compromisso por argumento JavaScript seguro');
assert.match(agendaTimelineSource, /FIM DA LINHA DO TEMPO DA AGENDA/);
assert.match(formSteppersSource, /select\.dispatchEvent\(new Event\('change'/,
  'seletor visual deve continuar acionando o fluxo normal do formulário');
assert.match(formSteppersSource, /FIM DOS SELETORES RÁPIDOS DE FORMULÁRIO/);
assert.match(globalCommandSearchSource, /window\.buscaGlobal\s*=\s*\{/);
assert.match(globalCommandSearchSource, /utils\.jsArg\(r\.mod\).*utils\.jsArg\(r\.id\)/s,
  'busca global deve manter argumentos seguros ao abrir registros');
assert.match(globalCommandSearchSource, /FIM DA BUSCA GLOBAL DE COMANDOS/);
for (const [source, label] of [
  [anesthesiaTimeToolsSource, 'ferramentas temporais'],
  [actionFeedbackSource, 'feedback de ações'],
  [anesthesiaPatientBarSource, 'barra do paciente'],
  [anesthesiaDosePanelSource, 'painel de dose rápida'],
  [dashboardTodaySource, 'resumo de hoje'],
  [agendaTimelineSource, 'linha do tempo'],
  [formSteppersSource, 'seletores rápidos'],
  [anesthesiaVitalsPanelSource, 'painel de sinais vitais'],
  [globalCommandSearchSource, 'busca global de comandos']
]) {
  assert.doesNotMatch(source, /store\.(?:save|delete|setList)\s*\(/,
    `${label} não pode gravar nem excluir registros diretamente`);
  assert.doesNotMatch(source,
    /\b(?:cloudRel|persistenciaCloudFirst|contextoAba|realtime|supabase)\b/,
    `${label} não pode assumir transporte, sessão ou Realtime`);
}
assert.doesNotMatch(modalSource, /\b(?:store|cloud|cloudRel|auth|contextoAba|localStorage)\b/,
  'componente visual não pode decidir persistência, sessão ou ambiente');
assert.doesNotMatch(feedbackSource, /\b(?:store|cloud|cloudRel|auth|contextoAba|localStorage)\b/,
  'feedback visual não pode decidir persistência, sessão ou ambiente');
assert(publicAssets.includes('src/ui/feedback.js'), 'feedback precisa entrar no pacote público');
assert(publicAssets.includes('src/domain/anesthesia-event-commands.js'),
  'comandos clínicos de evento precisam entrar no pacote público');
assert(publicAssets.includes('src/ui/anesthesia-time-tools.js'),
  'ferramentas temporais precisam entrar no pacote público');
assert(publicAssets.includes('src/ui/sync-status.js'),
  'status de sincronização precisa entrar no pacote público');
assert(publicAssets.includes('src/ui/modal.js'), 'modal precisa entrar no pacote público');
assert(publicAssets.includes('src/ui/search.js'), 'busca precisa entrar no pacote público');
assert(publicAssets.includes('src/ui/patients-view.js'), 'lista de pacientes precisa entrar no pacote público');
assert(publicAssets.includes('src/ui/autocomplete.js'), 'autocomplete precisa entrar no pacote público');
assert(publicAssets.includes('src/ui/quick-actions.js'), 'ações rápidas precisam entrar no pacote público');
assert(publicAssets.includes('src/print/print-preview.js'), 'impressão precisa entrar no pacote público');
assert(publicAssets.includes('src/ui/meu-dia.js'), 'Meu Dia precisa entrar no pacote público');
assert(publicAssets.includes('src/ui/dashboard.js'), 'dashboard precisa entrar no pacote público');
assert(publicAssets.includes('src/ui/agenda-view.js'), 'apresentação da Agenda precisa entrar no pacote público');
assert(publicAssets.includes('src/print/print-meta.js'), 'metadados de impressão precisam entrar no pacote público');
assert(publicAssets.includes('src/ui/layout-controls.js'), 'controles de layout precisam entrar no pacote público');
assert(publicAssets.includes('src/app/bootstrap.js'), 'bootstrap precisa entrar no pacote público');
assert(publicAssets.includes('src/ui/action-feedback.js'), 'feedback de ações precisa entrar no pacote público');
assert(publicAssets.includes('src/domain/anesthesia-quick-commands.js'), 'comandos rápidos da anestesia precisam entrar no pacote público');
assert(publicAssets.includes('src/ui/anesthesia-patient-bar.js'), 'barra do paciente precisa entrar no pacote público');
assert(publicAssets.includes('src/ui/anesthesia-dose-panel.js'), 'painel de dose rápida precisa entrar no pacote público');
assert(publicAssets.includes('src/ui/dashboard-today.js'), 'resumo de hoje precisa entrar no pacote público');
assert(publicAssets.includes('src/ui/agenda-timeline.js'), 'linha do tempo precisa entrar no pacote público');
assert(publicAssets.includes('src/ui/form-steppers.js'), 'seletores rápidos precisam entrar no pacote público');
assert(publicAssets.includes('src/ui/anesthesia-vitals-panel.js'), 'painel de sinais vitais precisa entrar no pacote público');
assert(publicAssets.includes('src/ui/global-command-search.js'), 'busca global de comandos precisa entrar no pacote público');
assert.match(runbook, /F1d — apresentação/);

const classes = () => {
  const values = new Set();
  return {
    add: value => values.add(value),
    remove: value => values.delete(value),
    contains: value => values.has(value)
  };
};

let anesthesiaStamped = null;
let recoveryStamped = null;
const eventCommandSandbox = { SoftActions,
  utils: { horaAtual: () => '10:20' },
  anestesia: {
    graficoUI: { _contexto: '' },
    eventos: { add: item => { anesthesiaStamped = item; return { id: 'anestesia-row' }; } }
  },
  recuperacao: {
    grafico: { addEvento: item => { recoveryStamped = item; return { id: 'srpa-row' }; } }
  }
};
vm.runInNewContext(
  anesthesiaEventCommandsSource + '\nglobalThis.__testedEventCommands = anesthesiaEventCommands;',
  eventCommandSandbox,
  { filename: 'anesthesia-event-commands.js' }
);
const testedEventCommands = eventCommandSandbox.__testedEventCommands;
const anesthesiaStampResult = testedEventCommands.registrarCarimbo('anestesia');
assert.equal(anesthesiaStampResult.contexto, 'anestesia');
assert.equal(anesthesiaStampResult.hora, '10:20');
assert.equal(anesthesiaStampResult.tr.id, 'anestesia-row');
assert.equal(anesthesiaStamped.hora, '10:20');
assert.equal(eventCommandSandbox.anestesia.graficoUI._contexto, 'anestesia');
const recoveryStampResult = testedEventCommands.registrarCarimbo('recuperacao');
assert.equal(recoveryStampResult.contexto, 'recuperacao');
assert.equal(recoveryStampResult.tr.id, 'srpa-row');
assert.equal(recoveryStamped.hora, '10:20');
assert.equal(eventCommandSandbox.anestesia.graficoUI._contexto, 'recuperacao');

const timeToolListeners = {};
const timeToolElements = {
  'fab-dial-main': { classList: classes(), offsetWidth: 20 },
  'fab-carimbo-badge': { textContent: '', style: {} }
};
let delegatedStampModule = null;
let timeToolToast = '';
const timeToolSandbox = { SoftActions,
  state: { currentModule: 'anestesia' },
  document: {
    addEventListener: (name, handler) => { timeToolListeners[name] = handler; },
    getElementById: id => timeToolElements[id] || null,
    createElement: () => ({})
  },
  navigator: { vibrate: () => true },
  anesthesiaEventCommands: {
    registrarCarimbo: modulo => {
      delegatedStampModule = modulo;
      return { contexto: modulo, hora: '10:20', tr: null };
    }
  },
  toast: message => { timeToolToast = message; },
  utils: { escapeAttr: value => String(value) },
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  window: {}
};
vm.runInNewContext(
  anesthesiaTimeToolsSource +
    '\nglobalThis.__testedCarimboHora = carimboHora;' +
    '\nglobalThis.__testedFabDial = fabDial;' +
    '\nglobalThis.__testedCronometros = cronometros;',
  timeToolSandbox,
  { filename: 'anesthesia-time-tools.js' }
);
timeToolSandbox.__testedCarimboHora.carimbar();
assert.equal(delegatedStampModule, 'anestesia');
assert.match(timeToolToast, /Hora 10:20 carimbada/);
assert(timeToolElements['fab-dial-main'].classList.contains('carimbou'));
assert.equal(timeToolElements['fab-carimbo-badge'].textContent, 0);
assert.equal(timeToolSandbox.__testedCronometros._fmt(3723000), '01:02:03');
assert.equal(typeof timeToolListeners.click, 'function');

const syncVisual = { textContent: '' };
const syncBadge = {
  state: '',
  setAttribute: (name, value) => { if (name === 'data-state') syncBadge.state = value; }
};
const syncFixture = {
  configured: false,
  logged: false,
  legacy: 0,
  relational: 0,
  deletes: 0,
  encrypted: 0,
  conflicts: 0
};
const syncStatusSandbox = { SoftActions,
  document: {
    getElementById: id => id === 'saved-text' ? syncVisual : (id === 'saved-badge' ? syncBadge : null)
  },
  navigator: { onLine: true },
  cloud: {
    estaConfigurado: () => syncFixture.configured,
    estaLogado: () => syncFixture.logged,
    _fila: () => Array(syncFixture.legacy).fill({})
  },
  cloudRel: {
    filaPendentes: () => syncFixture.relational,
    _filaDelLer: () => Array(syncFixture.deletes).fill({}),
    conflitosPendentes: () => syncFixture.conflicts
  },
  persistenciaCloudFirst: {
    pendentesConhecidos: () => syncFixture.encrypted
  }
};
vm.runInNewContext(
  syncStatusSource +
    '\nglobalThis.__testedSyncStatus = syncStatus;' +
    '\nglobalThis.__testedSetSavedStatus = setSavedStatus;',
  syncStatusSandbox,
  { filename: 'sync-status.js' }
);
const testedSyncStatus = syncStatusSandbox.__testedSyncStatus;
syncStatusSandbox.__testedSetSavedStatus('Salvo às 10:20');
assert.equal(syncVisual.textContent, 'Salvo às 10:20 · nuvem indisponível');
assert.equal(syncBadge.state, 'local');

syncFixture.configured = true;
syncFixture.logged = true;
syncFixture.legacy = 1;
syncFixture.relational = 1;
syncFixture.deletes = 1;
syncFixture.encrypted = 1;
testedSyncStatus.refresh();
assert.equal(syncVisual.textContent, 'Fila cifrada · 4 aguardando envio');
assert.equal(syncBadge.state, 'queued');

syncFixture.conflicts = 2;
testedSyncStatus.cloudState('syncing');
assert.equal(syncVisual.textContent, '2 conflitos preservados');
assert.equal(syncBadge.state, 'error');

syncFixture.conflicts = 0;
syncFixture.legacy = 0;
syncFixture.relational = 0;
syncFixture.deletes = 0;
syncFixture.encrypted = 0;
testedSyncStatus.cloudState('syncing');
assert.equal(syncVisual.textContent, 'Sincronizando…');
assert.equal(syncBadge.state, 'syncing');

syncStatusSandbox.navigator.onLine = false;
testedSyncStatus.cloudState('offline');
assert.equal(syncVisual.textContent, 'Protegido offline · sem internet');
assert.equal(syncBadge.state, 'offline');

syncStatusSandbox.navigator.onLine = true;
testedSyncStatus.cloudState('error');
assert.equal(syncVisual.textContent, 'Erro ao sincronizar — confira a fila protegida');
assert.equal(syncBadge.state, 'error');

testedSyncStatus.cloudState('synced');
assert.match(syncVisual.textContent, /^Sincronizado às /);
assert.equal(syncBadge.state, 'synced');

const printMetaModules = [{ classList: classes() }, { classList: classes() }];
const printMetaElements = {
  'dash-periodo': { selectedOptions: [{ text: '<img src=x onerror=alert(1)> Últimos 30 dias' }] },
  'print-meta-dashboard': { innerHTML: '' },
  'print-meta-pre': { innerHTML: '' },
  'print-meta-consulta': { innerHTML: '' },
  'print-meta-recuperacao': { innerHTML: '' },
  'print-meta-anestesia': { innerHTML: '' },
  'print-meta-financeiro': { innerHTML: '' },
  'print-meta-agenda': { innerHTML: '' }
};
const printMetaFields = {
  '#form-pre [name="nome"]': { value: '<img src=x onerror=alert(2)> Maria' },
  '#form-consulta [name="nome"]': { value: 'José & Ana' },
  '#form-recuperacao [name="nome"]': { value: 'Paciente "Teste"' },
  '#form-anestesia [name="nome"]': { value: '<b>Ana</b>' },
  '#form-anestesia [name="procedimento"]': { value: '<svg onload=alert(3)>' },
  '#form-anestesia [name="data_anestesia"]': { value: '<img src=x onerror=alert(4)>' }
};
const printMetaListeners = {};
const printMetaDocument = {
  querySelectorAll: selector => selector === '.module' ? printMetaModules : [],
  querySelector: selector => selector === '.module.active'
    ? printMetaModules[1]
    : (printMetaFields[selector] || null),
  getElementById: id => printMetaElements[id] || null
};
const printMetaSandbox = { SoftActions,
  document: printMetaDocument,
  window: {
    addEventListener: (name, handler) => { printMetaListeners[name] = handler; }
  },
  utils: {
    escapeHTML: value => String(value).replace(/[&<>"']/g, char => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[char]),
    formatarData: value => value
  }
};
vm.runInNewContext(printMetaSource, printMetaSandbox, { filename: 'print-meta.js' });
assert.equal(typeof printMetaListeners.beforeprint, 'function');
printMetaListeners.beforeprint();
assert(printMetaModules[1].classList.contains('print-active'));
assert.match(printMetaElements['print-meta-dashboard'].innerHTML, /&lt;img/);
assert.doesNotMatch(printMetaElements['print-meta-dashboard'].innerHTML, /<img/);
assert.match(printMetaElements['print-meta-pre'].innerHTML, /&lt;img/);
assert.doesNotMatch(printMetaElements['print-meta-pre'].innerHTML, /<img/);
assert.match(printMetaElements['print-meta-anestesia'].innerHTML, /&lt;svg/);
assert.match(printMetaElements['print-meta-anestesia'].innerHTML, /&lt;img/);
assert.doesNotMatch(printMetaElements['print-meta-anestesia'].innerHTML, /<svg/);
assert.doesNotMatch(printMetaElements['print-meta-anestesia'].innerHTML, /<img/);
printMetaElements['dash-periodo'].selectedOptions = [];
printMetaListeners.beforeprint();
assert.match(printMetaElements['print-meta-dashboard'].innerHTML, /<strong>Período:<\/strong> —<br>/,
  'impressão deve manter fallback quando o filtro do dashboard não existir');

const elements = {
  'modal-title': { textContent: '' },
  'modal-body': { innerHTML: '' },
  'modal-footer': { innerHTML: '' },
  'modal-backdrop': { classList: classes() }
};
const listeners = {};
const document = {
  body: { classList: classes() },
  getElementById: id => elements[id] || null,
  querySelector: () => null,
  addEventListener: (name, handler) => { listeners[name] = handler; }
};
const sandbox = { SoftActions, document };
vm.runInNewContext(modalSource + '\nglobalThis.__testedModal = modal;', sandbox, {
  filename: 'modal.js'
});
const modal = sandbox.__testedModal;
modal.open('Título seguro', '<p>conteúdo</p>', '<button>ok</button>');
assert.equal(elements['modal-title'].textContent, 'Título seguro');
assert.equal(elements['modal-body'].innerHTML, '<p>conteúdo</p>');
assert.equal(elements['modal-footer'].innerHTML, '<button>ok</button>');
assert(elements['modal-backdrop'].classList.contains('show'));
assert(document.body.classList.contains('tem-modal'));

listeners.click({ target: elements['modal-backdrop'] });
assert(!elements['modal-backdrop'].classList.contains('show'));

const autocompleteSandbox = { SoftActions,};
vm.runInNewContext(
  autocompleteSource + '\nglobalThis.__testedAutocomplete = autocomplete;',
  autocompleteSandbox,
  { filename: 'autocomplete.js' }
);
const testedAutocomplete = autocompleteSandbox.__testedAutocomplete;
assert.equal(testedAutocomplete._modPorForm('form-anestesia'), 'anestesia');
assert.equal(testedAutocomplete._modPorForm('form-financeiro'), 'financeiro');
assert.equal(testedAutocomplete._modPorForm('form-inexistente'), '');
assert(testedAutocomplete._MODS_NOME.includes('risco'));

const searchSandbox = { SoftActions,};
vm.runInNewContext(
  searchSource + '\nglobalThis.__testedHistorico = historico; globalThis.__testedGlobalSearch = globalSearch;',
  searchSandbox,
  { filename: 'search.js' }
);
assert.equal(searchSandbox.__testedHistorico.LABELS.anestesia, 'Ficha de Anestesia');
assert.equal(searchSandbox.__testedGlobalSearch.query('a').length, 0);

const patientRows = [
  { _id: '2', nome: 'Zélia', plano: 'Unimed' },
  { _id: '1', nome: 'Maria', plano: 'Unimed' },
  { _id: '3', nome: 'Maria', plano: 'Outro' }
];
const patientFilters = {
  'pac-f-busca': { value: 'maria' },
  'pac-f-plano': { value: 'Unimed' },
  'pac-f-ordem': { value: 'nome' }
};
const patientsViewSandbox = { SoftActions,
  pacientes: {
    list: () => patientRows,
    ORDENS: { nome: (a, b) => a.nome.localeCompare(b.nome) }
  },
  document: { getElementById: id => patientFilters[id] || null }
};
vm.runInNewContext(
  patientsViewSource + '\nglobalThis.__testedPatientsView = patientsView;',
  patientsViewSandbox,
  { filename: 'patients-view.js' }
);
const testedPatientsView = patientsViewSandbox.__testedPatientsView;
assert.deepEqual(
  Array.from(testedPatientsView.filtrar(), item => item._id),
  ['1'],
  'busca e plano devem ser combinados sem misturar cadastros'
);
patientFilters['pac-f-busca'].value = '';
patientFilters['pac-f-plano'].value = '';
assert.deepEqual(Array.from(testedPatientsView.filtrar(), item => item._id), ['1', '3', '2']);
assert.deepEqual(patientRows.map(item => item._id), ['2', '1', '3'],
  'ordenar a apresentação deve preservar a lista original');

const agendaRows = [
  { _id: 'a', data: '2026-10-08', hora: '10:00', status: 'confirmado', paciente: 'Maria' },
  { _id: 'b', data: '2026-10-07', hora: '09:00', status: 'agendado', paciente: 'José' },
  { _id: 'c', data: '2026-10-07', hora: '08:00', status: 'confirmado', paciente: 'Maria' }
];
const agendaFilters = {
  'ag-f-de': { value: '2026-10-07' },
  'ag-f-ate': { value: '2026-10-08' },
  'ag-f-tipo': { value: '' },
  'ag-f-status': { value: 'confirmado' },
  'ag-f-busca': { value: 'maria' }
};
const agendaViewSandbox = { SoftActions,
  store: { list: mod => mod === 'agenda' ? agendaRows : [] },
  document: { getElementById: id => agendaFilters[id] || null }
};
vm.runInNewContext(
  agendaViewSource + '\nglobalThis.__testedAgendaView = agendaView;',
  agendaViewSandbox,
  { filename: 'agenda-view.js' }
);
const testedAgendaView = agendaViewSandbox.__testedAgendaView;
assert.deepEqual(
  Array.from(testedAgendaView.filtrar(), item => item._id),
  ['c', 'a'],
  'Agenda deve combinar período, status e busca em ordem cronológica'
);
assert.deepEqual(agendaRows.map(item => item._id), ['a', 'b', 'c'],
  'ordenar a apresentação da Agenda deve preservar a lista original');

const layoutStorage = new Map();
const layoutSandbox = { SoftActions,
  window: {},
  localStorage: {
    getItem: key => layoutStorage.has(key) ? layoutStorage.get(key) : null,
    setItem: (key, value) => layoutStorage.set(key, String(value))
  }
};
vm.runInNewContext(
  layoutControlsSource +
    '\nglobalThis.__testedAcoesUI = acoesUI; globalThis.__testedAjustesGrupos = ajustesGrupos;',
  layoutSandbox,
  { filename: 'layout-controls.js' }
);
assert.equal(layoutSandbox.__testedAcoesUI.aberto('pre'), false);
layoutStorage.set(layoutSandbox.__testedAcoesUI.KEY, JSON.stringify({ pre: true }));
assert.equal(layoutSandbox.__testedAcoesUI.aberto('pre'), true);
assert.equal(layoutSandbox.__testedAjustesGrupos._aberto('nuvem'), false);
layoutStorage.set(layoutSandbox.__testedAjustesGrupos.KEY, JSON.stringify({ nuvem: true }));
assert.equal(layoutSandbox.__testedAjustesGrupos._aberto('nuvem'), true);

let quickDose = null;
let quickVitals = null;
let quickDirty = 0;
let quickGraphRenders = 0;
const quickCommandSandbox = { SoftActions,
  utils: { horaAtual: () => '10:15' },
  markDirty: () => { quickDirty++; },
  anestesia: {
    meds: { add: item => { quickDose = item; } },
    vitais: {
      _lerUltima: () => ({ pas: '110', pad: '70', fc: '65', fr: '14', spo2: '99', ritmo: 'Sinusal' }),
      _calcPAM: (pas, pad) => Math.round((Number(pas) + 2 * Number(pad)) / 3),
      add: (novo, item) => { quickVitals = { novo, item }; }
    },
    grafico: { render: () => { quickGraphRenders++; } }
  }
};
vm.runInNewContext(
  anesthesiaQuickCommandsSource + '\nglobalThis.__testedQuickCommands = anesthesiaQuickCommands;',
  quickCommandSandbox,
  { filename: 'anesthesia-quick-commands.js' }
);
const testedQuickCommands = quickCommandSandbox.__testedQuickCommands;
testedQuickCommands.registrarDose({ nome: 'Fentanil', dose: 50, unidade: 'mcg', via: 'EV' });
assert.equal(quickDose.hora, '10:15');
assert.equal(quickDose.nome, 'Fentanil');
assert.equal(quickDose.dose, '50');
assert.equal(quickDirty, 1);
assert.throws(() => testedQuickCommands.registrarDose({ nome: '', dose: 0 }),
  /Dose rápida inválida/);
assert.equal(testedQuickCommands.lerUltimosVitais().pas, '110');
testedQuickCommands.registrarVitais({
  pas: 120, pad: 80, fc: 70, fr: 12, spo2: 98, ritmo: 'Sinusal'
});
assert.equal(quickVitals.novo, false);
assert.equal(quickVitals.item.pam, '93');
assert.equal(quickVitals.item.hora, '10:15');
assert.equal(quickDirty, 2);
assert.equal(quickGraphRenders, 1);
assert.throws(() => testedQuickCommands.registrarVitais({ pas: 'inválido' }),
  /Sinais vitais inválidos/);

const doseElements = {
  'ds-meds': { innerHTML: '' },
  'ds-doses': { innerHTML: '', style: {} },
  'ds-titulo': { textContent: '' },
  'ds-sub': { textContent: '' },
  'ds-go': { disabled: true, textContent: '' },
  'dose-overlay': { classList: classes() },
  'dose-sheet': { classList: classes() }
};
let delegatedDose = null;
const dosePanelSandbox = { SoftActions,
  document: {
    getElementById: id => doseElements[id] || null,
    querySelectorAll: () => []
  },
  anesthesiaQuickCommands: { registrarDose: value => { delegatedDose = value; } },
  alert: () => {}
};
dosePanelSandbox.window = dosePanelSandbox;
vm.runInNewContext(anesthesiaDosePanelSource, dosePanelSandbox, {
  filename: 'anesthesia-dose-panel.js'
});
dosePanelSandbox.doseRapida.abrir();
dosePanelSandbox.doseRapida.med(0);
dosePanelSandbox.doseRapida.dose(50);
dosePanelSandbox.doseRapida.registrar();
assert.equal(delegatedDose.nome, 'Fentanil');
assert.equal(delegatedDose.dose, 50);
assert(!doseElements['dose-overlay'].classList.contains('on'));

const vitalsElements = {
  'vit-sub': { textContent: '' },
  'vit-grid': { innerHTML: '' },
  'vit-ritmo': { innerHTML: '' },
  'vit-overlay': { classList: classes() },
  'vit-sheet': { classList: classes() }
};
let delegatedVitals = null;
const vitalsPanelSandbox = { SoftActions,
  document: {
    getElementById: id => vitalsElements[id] || null,
    querySelectorAll: () => []
  },
  utils: { jsArg: value => JSON.stringify(value).replaceAll('"', '&quot;') },
  anesthesiaQuickCommands: {
    lerUltimosVitais: () => ({ pas: 110, pad: 70, fc: 65, fr: 14, spo2: 99, ritmo: 'Sinusal' }),
    registrarVitais: value => { delegatedVitals = value; }
  },
  alert: () => {}
};
vitalsPanelSandbox.window = vitalsPanelSandbox;
vm.runInNewContext(anesthesiaVitalsPanelSource, vitalsPanelSandbox, {
  filename: 'anesthesia-vitals-panel.js'
});
assert.doesNotThrow(() => vitalsPanelSandbox.vitaisRapidos.abrir(),
  'painel de vitais deve abrir sem depender de função esc fora do próprio escopo');
assert.match(vitalsElements['vit-ritmo'].innerHTML, /Ritmo de marca-passo/);
assert(vitalsElements['vit-overlay'].classList.contains('on'));
vitalsPanelSandbox.vitaisRapidos.registrar();
assert.equal(delegatedVitals.pas, 110);
assert.equal(delegatedVitals.spo2, 99);
assert(!vitalsElements['vit-overlay'].classList.contains('on'));

const commandElements = {
  'gs-overlay': { classList: classes(), addEventListener() {} },
  'gs-input': { value: 'maria', focus() {} },
  'gs-results': { innerHTML: '' }
};
const commandDocument = {
  readyState: 'loading',
  getElementById: id => commandElements[id] || null,
  querySelector: () => null,
  createElement: () => ({}),
  addEventListener() {}
};
const commandSandbox = { SoftActions,
  document: commandDocument,
  location: { hash: '' },
  setTimeout: () => 1,
  store: {
    list: mod => mod === 'pre'
      ? [{ _id: 'registro-1', paciente_nome: '<img src=x onerror=alert(1)> Maria' }]
      : []
  },
  utils: {
    jsArg: value => JSON.stringify(value).replaceAll('"', '&quot;')
  }
};
commandSandbox.window = commandSandbox;
vm.runInNewContext(globalCommandSearchSource, commandSandbox, {
  filename: 'global-command-search.js'
});
commandSandbox.buscaGlobal.buscar();
assert.match(commandElements['gs-results'].innerHTML, /&lt;img src=x onerror=alert\(1\)&gt; Maria/,
  'busca global deve escapar dados clínicos antes de renderizar resultados');
assert.doesNotMatch(commandElements['gs-results'].innerHTML, /<img/,
  'busca global não pode reintroduzir HTML armazenado');

const printSandbox = { SoftActions,};
vm.runInNewContext(
  printSource + '\nglobalThis.__testedPrintPreview = printPreview;',
  printSandbox,
  { filename: 'print-preview.js' }
);
const testedPrint = printSandbox.__testedPrintPreview;
assert.equal(testedPrint._durEntre('07:30', '09:05'), '1h 35min');
assert.equal(testedPrint._durEntre('23:40', '00:20'), '0h 40min');
assert.equal(testedPrint._viaAereaImpressa(''), '');

/* Correções precisam atravessar a composição real do preview e a janela de
   impressão; testar apenas o gerador de bloco não comprova que saem no papel. */
const addendaStart = html.indexOf('const adendos = (() => {');
const addendaEnd = html.indexOf('\n})();', addendaStart);
assert(addendaStart >= 0 && addendaEnd > addendaStart);
const printRecords = new Map();
const printForms = new Map();
const printNodes = new Map(['ppp', 'ppt-signature-select', 'ppt-info', 'ppt-filename']
  .map(id => [id, { innerHTML: '', textContent: '' }]));
printNodes.set('print-preview-overlay', { classList: classes() });
const hostileAddendum = 'Exames posteriores: Hb 13,2\n<img src=x onerror="alert(1)">';
const hostileAuthor = 'Dr. O\'Connor <svg onload="alert(2)">';
const escaped = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
for (const mod of ['pre', 'consulta', 'anestesia', 'recuperacao', 'risco', 'termo', 'prescricao', 'documentos']) {
  const id = mod + '-aberto';
  const fields = { _id: { value: id }, nome: { value: 'Paciente A' }, paciente_nome: { value: 'Paciente A' } };
  const form = { id: 'form-' + mod, querySelector: selector => fields[selector.match(/name="([^"]+)"/)?.[1]] || null };
  printForms.set(mod, fields); printNodes.set(form.id, form);
  printRecords.set(mod + '|' + id, { _id: id, _finalizado: true, nome: 'Original ' + mod,
    _adendos: [{ id: mod + '-adendo', data: '2026-10-09T12:00:00Z', autor: hostileAuthor,
      texto: mod + ': ' + hostileAddendum }] });
}
const recordsBeforePrinting = JSON.stringify([...printRecords]);
let printedDocument = '';
const popupWriter = { document: { open() { printedDocument = ''; }, close() {}, write(value) { printedDocument = value; } },
  addEventListener() {}, focus() {}, print() {}, close() {} };
const actualPrintSandbox = { SoftActions, console,
  state: { currentModule: 'pre' }, ajustes: { list: () => [] },
  utils: { escapeHTML: escaped },
  store: { getById: (mod, id) => printRecords.get(mod + '|' + id),
    save() { throw new Error('Impressão não pode regravar o original'); } },
  document: { getElementById: id => printNodes.get(id) || null, querySelector: () => null },
  window: { open: () => popupWriter }, setTimeout: () => 1,
  toast(message, type) { if (type === 'error') throw new Error(message); },
  anestesia: { coletarEstruturado: () => ({ paciente: { nome: 'Paciente A' } }) },
  linker: { contextoPaciente: () => ({ patientRef: 'paciente-a', identityKey: 'id-a' }),
    contextoCaso: () => ({ caseId: 'caso-a' }) }
};
const actualPrintContext = Object.freeze({ userId: 'autor-sintetico', organizationId: 'clinica-sintetica',
  tabId: 'aba-sintetica', deviceId: 'dispositivo-sintetico', generation: 1, verified: true });
actualPrintSandbox.contextoAba = { capturar: () => actualPrintContext, atual: () => actualPrintContext,
  organizationId: () => actualPrintContext.organizationId, aoMudar() {},
  corresponde: contexto => contexto === actualPrintContext || JSON.stringify(contexto) === JSON.stringify(actualPrintContext) };
vm.runInNewContext(html.slice(addendaStart, addendaEnd + '\n})();'.length) + '\n' + printSource
  + '\nglobalThis.testedPrint = printPreview; globalThis.testedAddenda = adendos;', actualPrintSandbox, { filename: 'actual-addenda-print.js' });
const actualPrint = actualPrintSandbox.testedPrint;
const realPrintBuilders = new Map([['pre', '_buildPre'], ['consulta', '_buildConsulta'], ['anestesia', '_buildAnestesia'],
  ['recuperacao', '_buildRecuperacao'], ['risco', '_buildRisco'], ['termo', '_buildTermo'],
  ['prescricao', '_buildPrescricao'], ['documentos', '_buildDocumento']]
  .map(([mod, method]) => [mod, { method, builder: actualPrint[method] }]));
actualPrint._gerarNomeArquivo = () => 'Documento'; actualPrint._infoLabel = mod => mod;
actualPrint._sanitizarPaciente = () => 'Paciente'; actualPrint._dataCriacao = () => '2026-10-09';
actualPrint.refreshSignature = () => {};
for (const [mod, { method }] of realPrintBuilders) {
  actualPrint[method] = () => '<section>Original ' + mod + '</section>';
}
for (const mod of realPrintBuilders.keys()) {
  actualPrintSandbox.state.currentModule = mod;
  actualPrint.abrir(); actualPrint.imprimir();
  assert(printedDocument.includes('Original ' + mod));
  assert(printedDocument.includes(escaped(mod + ': ' + hostileAddendum)), mod + ': adendo deve chegar à impressão real');
  assert(printedDocument.includes(escaped(hostileAuthor)), mod + ': autoria precisa estar escapada');
  assert(printedDocument.includes('2026') && /ADENDOS \/ CORREÇÕES/.test(printedDocument));
  assert.doesNotMatch(printedDocument, /<(?:img|svg)\b/, 'adendos não podem introduzir HTML executável');
  assert(!printedDocument.includes('consulta: ' + escaped(hostileAddendum)) || mod === 'consulta',
    'somente os adendos do módulo/registro aberto são impressos');
}
actualPrint.abrirPreTermo(); actualPrint.imprimir();
assert(printedDocument.includes('Original pre') && printedDocument.includes('Original termo'));
assert(printedDocument.includes(escaped('pre: ' + hostileAddendum)), 'conjunto pré+termo conserva as correções da pré');
assert(printedDocument.includes(escaped('termo: ' + hostileAddendum)), 'conjunto pré+termo conserva as correções do termo');
actualPrint.abrirConjunto(); actualPrint.imprimir();
assert(printedDocument.includes(escaped('anestesia: ' + hostileAddendum))
  && printedDocument.includes(escaped('recuperacao: ' + hostileAddendum)), 'conjunto anestesia+SRPA imprime os adendos de ambas as fichas');
printForms.get('pre')._id.value = '';
actualPrintSandbox.state.currentModule = 'pre'; actualPrint.abrir(); actualPrint.imprimir();
assert(!/ADENDOS \/ CORREÇÕES/.test(printedDocument), 'formulário novo não pode herdar os adendos da impressão anterior');
assert.equal(JSON.stringify([...printRecords]), recordsBeforePrinting, 'preview e impressão preservam o original e sua autoria');

/* Executa os builders reais com uma retificação aceita pelo servidor e outra
   concorrente recusada. Nenhum deles pode ler alterações ainda não salvas do
   formulário, nem misturar tabelas/gráficos de versões diferentes. */
const unsavedClinicalRead = () => { throw new Error('Leitura clínica do formulário finalizado'); };
Object.assign(actualPrintSandbox.utils, { formData: unsavedClinicalRead, formatarData: value => value || '',
  getCarimboDoProfissional: () => null });
Object.assign(actualPrintSandbox, {
  labExtra: { coletar: unsavedClinicalRead },
  consulta: { seguimento: { coletar: unsavedClinicalRead }, procs: { coletar: unsavedClinicalRead } },
  recuperacao: { grafico: { coletar: unsavedClinicalRead } },
  prescricao: { _coletarItens: unsavedClinicalRead },
  risco: { atualizar: unsavedClinicalRead, resumoCompactoHTML: data => escaped(JSON.stringify(data._resumo || {})) },
  cirurgia: { texto: data => data.descricao || '', textoLista: () => '' }
});
actualPrintSandbox.anestesia.coletarEstruturado = unsavedClinicalRead;
actualPrintSandbox.anestesia.exames = { listar: () => [], ehExame: () => false };
actualPrintSandbox.store.list = mod => [...printRecords].filter(([key]) => key.startsWith(mod + '|')).map(([, rec]) => rec);
let renderingCurrentVersion = false;
actualPrintSandbox.store.setList = () => { if (renderingCurrentVersion) throw new Error('Impressão não pode regravar o original'); };
actualPrint._header = titulo => '<h1>' + escaped(titulo) + '</h1>';
actualPrint._signature = () => ''; actualPrint._signatureAnestesia = () => '';
actualPrint._footer = label => '<footer>' + escaped(label) + '</footer>';
const plottedPoints = [];
actualPrintSandbox.document.createElement = tag => {
  assert.equal(tag, 'canvas', 'gráfico vigente deve usar canvas separado do formulário');
  const context = { fillRect() {}, fillText() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, fill() {},
    arc(x, y) { plottedPoints.push({ x, y }); } };
  return { getContext: () => context, toDataURL: () => 'data:image/png;base64,' + 'A'.repeat(160) };
};
const freezePrintRecord = value => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(freezePrintRecord); Object.freeze(value);
  }
  return value;
};
for (const [mod, { method, builder }] of realPrintBuilders) {
  actualPrint[method] = builder;
  printForms.get(mod)._id.value = mod + '-aberto';
  const original = printRecords.get(mod + '|' + mod + '-aberto');
  Object.assign(original, { nome: 'Paciente sintético original ' + mod, texto: 'Texto original',
    alergias: 'Alergia original', atestado_texto: 'Atestado original', itens: [], grafico: {},
    paciente: { nome: 'Paciente sintético original ' + mod }, procedimento: {}, pre_anestesico: {},
    tecnica: {}, monitorizacao: {}, fluidos: {}, intercorrencias: {}, transferencia: {},
    conclusao: {}, assinatura: {}, sinais_vitais: [], _labExtras: [], _seguimentos: [], _procsRealizados: [], _resumo: {} });
  const nome = 'Paciente sintético vigente ' + mod;
  const campos = { nome, alergias: 'Alergia aceita ' + mod, texto: 'Texto aceito ' + mod,
    atestado_texto: 'Atestado aceito ' + mod, itens: [{ nome: 'Medicamento aceito ' + mod, pos: 'Posologia aceita' }],
    _labExtras: [{ label: 'Exame aceito', valor: 'Resultado aceito ' + mod }],
    _seguimentos: [{ texto: 'Seguimento aceito ' + mod }],
    _procsRealizados: [{ codigo: 'SINTETICO', descricao: 'Procedimento aceito ' + mod }],
    _resumo: { aceito: 'Estimativa aceita ' + mod },
    paciente: { nome }, sinais_vitais: [{ hora: '08:00', fc: '80' }],
    grafico: { vitais: [{ hora: '08:00', fc: '80', observacao: 'Vital aceito ' + mod }], eventos: [], medicacoes: [] } };
  const linhaBase = { id: '00000000-0000-4000-8000-000000000001',
    organization_id: actualPrintContext.organizationId, parent_table: actualPrintSandbox.testedAddenda.MODS[mod],
    parent_id: '00000000-0000-4000-8000-000000000002', parent_legacy_id: original._id };
  actualPrintSandbox.testedAddenda.receberLinha({ ...linhaBase, legacy_id: mod + '-retificacao',
    author_id: 'autor-sintetico', created_at: '2026-10-09T13:00:00Z', retification_revision: 1,
    texto: 'Diff aceito do registro', data: { autor_exibicao: 'RÓTULO DE AUTOR FORJADO',
      retificacao: { schema: 1, baseAdendoId: '', campos, status: 'accepted', baseAtualId: '', revisao: 1 } } });
  actualPrintSandbox.testedAddenda.receberLinha({ ...linhaBase, id: '00000000-0000-4000-8000-000000000003',
    legacy_id: mod + '-conflito', author_id: 'autor-concorrente',
    created_at: '2026-10-09T13:00:01Z', retification_revision: null,
    texto: 'Diff em conflito', data: { autor_exibicao: 'Autor concorrente',
      retificacao: { schema: 1, baseAdendoId: '',
        campos: { nome: 'CONFLITO NÃO APLICADO', texto: 'CONFLITO NÃO APLICADO' },
        status: 'conflict', baseAtualId: mod + '-retificacao', revisao: 1 } } });
  original._adendos.push(
  { id: mod + '-pendente', autor: 'Autor offline', data: '2026-10-09T13:01:00Z', _pushed: false,
    texto: 'Diff ainda pendente', _retificacao: { schema: 1, baseAdendoId: mod + '-retificacao',
      campos: { nome: 'PENDENTE NÃO APLICADO', texto: 'PENDENTE NÃO APLICADO' }, status: 'pending' } });
  freezePrintRecord(original);
  const before = JSON.stringify(original);
  actualPrintSandbox.state.currentModule = mod;
  renderingCurrentVersion = true;
  try { actualPrint.abrir(); actualPrint.imprimir(); } finally { renderingCurrentVersion = false; }
  if (mod !== 'documentos') assert(printedDocument.includes(escaped(nome)), mod + ': identificação deve vir da versão aceita');
  assert(printedDocument.includes('VERSÃO ATUAL — RETIFICADA') && printedDocument.includes('autor-sintetico'),
    mod + ': documento precisa identificar a retificação aceita e sua autoria');
  assert(!printedDocument.includes('RÓTULO DE AUTOR FORJADO'), mod + ': carimbo retificado deve usar autoria canônica do servidor');
  assert(printedDocument.includes('retificação(ões) em conflito') && printedDocument.includes('pendente(s) de confirmação'),
    mod + ': conflito e pendência devem ser explícitos');
  assert(!printedDocument.includes('CONFLITO NÃO APLICADO') && !printedDocument.includes('PENDENTE NÃO APLICADO'),
    mod + ': campos não aceitos jamais entram no documento');
  assert(printedDocument.includes(escaped(mod + ': ' + hostileAddendum)), mod + ': adendos de texto continuam legíveis');
  if (mod === 'pre' || mod === 'consulta') {
    assert(printedDocument.includes('Alergia aceita ' + mod) && printedDocument.includes('Resultado aceito ' + mod));
  }
  if (mod === 'consulta') assert(printedDocument.includes('Seguimento aceito consulta') && printedDocument.includes('Procedimento aceito consulta'));
  if (mod === 'termo') assert(printedDocument.includes('Texto aceito termo'));
  if (mod === 'prescricao') assert(printedDocument.includes('Medicamento aceito prescricao') && printedDocument.includes('Posologia aceita'));
  if (mod === 'documentos') assert(printedDocument.includes('Atestado aceito documentos'));
  if (mod === 'risco') assert(printedDocument.includes('Estimativa aceita risco'));
  if (mod === 'anestesia' || mod === 'recuperacao') assert(printedDocument.includes('Gráfico dos sinais vitais da versão vigente'));
  assert.equal(JSON.stringify(original), before, mod + ': projeção e impressão não regravam o registro original');
}
assert.equal(plottedPoints.length, 2, 'ficha e SRPA desenham somente o ponto vigente confirmado');
for (const point of plottedPoints) assert.equal(point.y, 138, 'FC 80 confirmada deve alimentar o gráfico, sem coleta do formulário');
actualPrint.abrirPreTermo(); actualPrint.imprimir();
assert(printedDocument.includes('Texto aceito termo') && printedDocument.includes('Alergia aceita pre'));
assert.equal((printedDocument.match(/VERSÃO ATUAL — RETIFICADA/g) || []).length, 2, 'cada parte do conjunto identifica sua própria revisão aceita');
actualPrint.abrirConjunto(); actualPrint.imprimir();
assert(printedDocument.includes('Paciente sintético vigente anestesia') && printedDocument.includes('Paciente sintético vigente recuperacao'));
assert.equal((printedDocument.match(/VERSÃO ATUAL — RETIFICADA/g) || []).length, 2);
printForms.get('pre')._id.value = '';
actualPrintSandbox.utils.formData = () => ({ nome: 'Paciente sintético ainda não salvo' });
actualPrintSandbox.state.currentModule = 'pre'; actualPrint.abrir(); actualPrint.imprimir();
assert(printedDocument.includes('Paciente sintético ainda não salvo') && !printedDocument.includes('VERSÃO ATUAL — RETIFICADA'),
  'documento novo lê seu formulário sem herdar a projeção do paciente anterior');

/* O nome do PDF também contém dado clínico. As reservas só existem na memória
   da aba/contexto; legado em claro é eliminado sem ser lido ou restaurado. */
const legacyPrintKeys = ['medsys.v7.nomes_arquivo', 'medsys.v7.nomes_arquivo@clinica-a',
  'medsys.v7.nomes_arquivo@clinica-b', 'demo:medsys.v7.nomes_arquivo@demo'];
let reservationStorageWrites = 0, reservationClinicalReads = 0;
function reservationStorage() {
  const data = new Map(legacyPrintKeys.map(key => [key, JSON.stringify({ nomes: { Paciente_Anterior: 'documento-anterior' } })]));
  data.set('medsys.offline.cifrada', 'AES-GCM-sintetico');
  return { data, get length() { return data.size; }, key: index => [...data.keys()][index] || null,
    getItem(key) {
      if (/nomes_arquivo/.test(key)) { reservationClinicalReads++; throw new Error('Não restaurar nomes clínicos'); }
      return data.get(key) || null;
    },
    setItem() { reservationStorageWrites++; throw new Error('Reservas não podem persistir no navegador'); },
    removeItem(key) { data.delete(key); } };
}
const printLocalStorage = reservationStorage(), printSessionStorage = reservationStorage();
const reservationListeners = [], reservationPageEvents = new Map();
const reservationPreviewNodes = new Map(['ppp', 'ppt-signature-select', 'ppt-filename', 'ppt-info']
  .map(id => [id, { innerHTML: 'Paciente sintético anterior', textContent: 'Nome clínico anterior' }]));
reservationPreviewNodes.set('print-preview-overlay', { classList: classes() });
let reservationDemo = false, reservationDay = '2026-10-09';
let reservationContext = { tabId: 'tab-a', deviceId: 'dispositivo-a', userId: 'usuario-a',
  organizationId: 'clinica-a', generation: 1, verified: true };
const reservationSandbox = { SoftActions,
  localStorage: printLocalStorage, cofre: { _real: printLocalStorage },
  window: { localStorage: printLocalStorage, sessionStorage: printSessionStorage,
    addEventListener: (event, fn) => reservationPageEvents.set(event, fn) },
  document: { getElementById: id => reservationPreviewNodes.get(id) || null, body: { classList: classes() } },
  demo: { ativo: () => reservationDemo },
  contextoAba: { capturar: () => ({ ...reservationContext }), aoMudar: fn => reservationListeners.push(fn) } };
vm.runInNewContext(printSource + '\nglobalThis.printReservations = printPreview;', reservationSandbox,
  { filename: 'print-reservations-security.js' });
const reservationPrint = reservationSandbox.printReservations;
reservationPrint._dataCriacao = () => reservationDay;
assert.equal(reservationPreviewNodes.get('ppp').innerHTML, '', 'boot remove conteúdo anterior de impressão');
assert.equal(reservationPreviewNodes.get('ppt-filename').textContent, '', 'boot remove nome clínico anterior');
for (const storage of [printLocalStorage, printSessionStorage]) {
  assert(legacyPrintKeys.every(key => !storage.data.has(key)), 'boot deve remover reservas antigas de todas as clínicas e demo');
  assert.equal(storage.data.get('medsys.offline.cifrada'), 'AES-GCM-sintetico', 'limpeza não pode apagar pendências cifradas');
}
reservationPrint._gravarReserva({ dia: reservationDay, nomes: { Paciente_Sintetico_APA: 'pre:a' } });
assert.equal(reservationPrint._lerReserva().nomes.Paciente_Sintetico_APA, 'pre:a', 'API pública deve reservar apenas em memória');
assert.equal(reservationPrint._nomeUnico('Paciente_Sintetico_APA', 'pre:b'), 'Paciente_Sintetico_APA_2');
assert.equal(reservationPrint._nomeUnico('Paciente_Sintetico_APA', 'pre:b'), 'Paciente_Sintetico_APA_2', 'mesmo documento conserva nome nesta aba');
reservationContext = { ...reservationContext, organizationId: 'clinica-b', generation: 2 };
assert.equal(Object.keys(reservationPrint._lerReserva().nomes).length, 0, 'contexto diferente limpa reservas mesmo sem listener');
reservationPrint._gravarReserva({ dia: reservationDay, nomes: { Outra_Clinica: 'pre:c' } });
reservationPrint._nomeArquivoOverride = 'Paciente_Anterior_Conjunto';
reservationPrint._verCtx = { mod: 'pre', formId: 'form-pre' };
reservationPreviewNodes.get('ppp').innerHTML = 'Conteúdo clínico da sessão anterior';
reservationPreviewNodes.get('ppt-filename').textContent = 'Paciente_Anterior_Conjunto.pdf';
reservationPreviewNodes.get('print-preview-overlay').classList.add('show');
reservationContext = { ...reservationContext, userId: 'usuario-b', generation: 3 };
reservationListeners.forEach(fn => fn());
assert.equal(Object.keys(reservationPrint._lerReserva().nomes).length, 0, 'troca de usuário encerra nomes do usuário anterior');
assert.equal(reservationPrint._nomeArquivoOverride, null, 'troca de usuário encerra o nome do documento combinado');
assert.equal(reservationPrint._verCtx, null, 'troca de usuário encerra o contexto de versão');
assert.equal(reservationPreviewNodes.get('ppp').innerHTML, '', 'troca de usuário remove o preview clínico anterior');
assert.equal(reservationPreviewNodes.get('ppt-filename').textContent, '', 'troca de usuário remove o nome clínico anterior');
assert(!reservationPreviewNodes.get('print-preview-overlay').classList.contains('show'), 'troca de usuário fecha o preview anterior');
reservationPrint._gravarReserva({ dia: reservationDay, nomes: { Paciente_Real: 'pre:real' } });
reservationDemo = true;
assert.equal(Object.keys(reservationPrint._lerReserva().nomes).length, 0, 'demo não pode ler nomes clínicos do contexto real');
reservationPrint._gravarReserva({ dia: reservationDay, nomes: { Paciente_Demo: 'pre:demo' } });
reservationDemo = false;
assert.equal(Object.keys(reservationPrint._lerReserva().nomes).length, 0, 'sair de demo não recupera suas reservas nem as reais anteriores');
reservationPrint._gravarReserva({ dia: reservationDay, nomes: { Documento_Dia: 'pre:dia' } });
reservationDay = '2026-10-10';
assert.equal(Object.keys(reservationPrint._lerReserva().nomes).length, 0, 'reservas vencem ao mudar de dia');
reservationPrint._gravarReserva({ dia: reservationDay, nomes: { Documento_Aberto: 'pre:aberto' } });
reservationPageEvents.get('pagehide')();
assert.equal(Object.keys(reservationPrint._lerReserva().nomes).length, 0, 'fechar/ocultar documento encerra reserva em memória');
reservationPrint._gravarReserva({ dia: reservationDay, nomes: { Documento_Antes_Logout: 'pre:antes' } });
reservationContext = { ...reservationContext, userId: '', organizationId: '', verified: false, generation: 4 };
reservationListeners.forEach(fn => fn());
assert.equal(Object.keys(reservationPrint._lerReserva().nomes).length, 0, 'logout não libera nomes do usuário anterior');
assert.equal(reservationStorageWrites, 0, 'nenhuma reserva pode escrever em localStorage ou sessionStorage');
assert.equal(reservationClinicalReads, 0, 'nenhum nome clínico legado pode ser restaurado');

const meuDiaSandbox = { SoftActions,
  linker: { _chavePaciente: item => item._patientKey || '' },
  store: { getById: () => null }
};
vm.runInNewContext(
  meuDiaSource + '\nglobalThis.__testedMeuDia = meuDia;',
  meuDiaSandbox,
  { filename: 'meu-dia.js' }
);
const testedMeuDia = meuDiaSandbox.__testedMeuDia;
assert.notEqual(
  testedMeuDia._caseToken('pre', { _id: 'legado-a', nome: 'Maria Souza' }),
  testedMeuDia._caseToken('pre', { _id: 'legado-b', nome: 'Maria Souza' }),
  'registros legados homônimos devem continuar isolados'
);
assert.notEqual(
  testedMeuDia._caseToken('pre', { _caseId: 'caso-1', _patientKey: 'forte-a' }),
  testedMeuDia._caseToken('pre', { _caseId: 'caso-1', _patientKey: 'forte-b' }),
  'um caseId nunca pode unir pacientes fortes diferentes'
);

const dashboardSandbox = { SoftActions,
  linker: { _chavePaciente: item => item._patientKey || '' }
};
vm.runInNewContext(
  dashboardSource + '\nglobalThis.__testedDashboard = dashboard;',
  dashboardSandbox,
  { filename: 'dashboard.js' }
);
const testedDashboard = dashboardSandbox.__testedDashboard;
assert(testedDashboard.MODULOS_DADOS.includes('consulta'));
assert.equal(
  testedDashboard.contarPacientesUnicos(
    [{ _patientKey: 'forte-a' }],
    [{ _patientKey: 'forte-a' }]
  ),
  1,
  'o mesmo paciente forte deve contar uma vez entre módulos'
);
assert.equal(
  testedDashboard.contarPacientesUnicos(
    [{ _id: 'legado-a', nome: 'Maria Souza' }],
    [{ _id: 'legado-b', nome: 'Maria Souza' }]
  ),
  2,
  'homônimos legados sem vínculo devem permanecer separados no total'
);
assert(!document.body.classList.contains('tem-modal'));

modal.open('Outro', '', '');
listeners.keydown({ key: 'Escape' });
assert(!elements['modal-backdrop'].classList.contains('show'));

const toastChildren = [];
const toastWrap = { appendChild: value => toastChildren.push(value) };
const toastDocument = {
  getElementById: id => id === 'toast-wrap' ? toastWrap : null,
  createElement: () => ({
    className: '', innerHTML: '', classList: classes(), remove() {}
  })
};
const feedbackSandbox = { SoftActions,
  document: toastDocument,
  console: { log() {} },
  requestAnimationFrame: callback => callback(),
  setTimeout: () => 1,
  utils: {
    escapeHTML: value => String(value).replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  }
};
vm.runInNewContext(feedbackSource + '\nglobalThis.__testedToast = toast;', feedbackSandbox, {
  filename: 'feedback.js'
});
feedbackSandbox.__testedToast('<img src=x onerror=alert(1)>', 'warn');
assert.equal(toastChildren.length, 1);
assert.match(toastChildren[0].innerHTML, /&lt;img src=x onerror=alert\(1\)&gt;/);
assert.doesNotMatch(toastChildren[0].innerHTML, /<img/);

console.log('  ✓ F1d: componentes visuais isolados preservam ordem e fronteiras');
