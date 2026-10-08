# F1 — modularização, fluxos e preparação comercial

Status: **escopo técnico local da auditoria concluído; publicação, homologação
e mudanças remotas bloqueadas**.

O F1 começa somente depois dos bloqueadores P0. B2 e E1 já estão implementados
localmente; a aplicação das migrações continua dependendo de homologação e G3.

## Fronteiras da arquitetura

| Camada | Responsabilidade | Não pode decidir |
|---|---|---|
| `domain` | regras clínicas e do atendimento/caso | sessão, cache ou transporte |
| `platform/auth` | identidade e ciclo da sessão por aba | permissões clínicas locais |
| `platform/persistence` | leitura/gravação com versão e recibo | trocar clínica do registro |
| `platform/sync` | Realtime, fila offline e reconciliação | descartar conflito ou dado sem recibo |
| `permissions` | papel, módulo e só impressão | confiar em `user_metadata` |
| `integrations` | Supabase, assinatura, medicamentos e CBHPM | guardar segredos no navegador |
| `ui` | interação e apresentação | ser fonte de autorização |
| `print` | documentos e PDF | alterar o registro clínico original |

O atendimento/caso (`encounter`) permanece o eixo entre paciente, agenda,
pré-anestésica, consulta, anestesia, recuperação, documentos e financeiro.
Uma extração só é aceita se não criar recadastro nem um segundo estado do mesmo
dado.

## Contratos que não podem ser quebrados

`src/contracts/soft-anestesia.d.ts` registra as fronteiras mínimas entre as
camadas:

- toda operação e evento carrega `organizationId` e identidade da sessão;
- gravação online informa `expectedVersion`, `operationId` e `checksum`;
- sucesso só existe com `CloudReceipt` do servidor;
- fila offline é cifrada, pertence a usuário + clínica + dispositivo e só sai
  após recibo;
- conflito preserva base, versão local e versão remota;
- telemetria operacional não possui paciente, documento ou conteúdo clínico.

Os contratos ainda documentam o JavaScript existente; cada módulo extraído
passará a consumi-los antes de uma conversão gradual para TypeScript.

## Estratégia incremental

1. **F1a — composição reproduzível (concluído localmente):** uma allowlist
   única define o que entra em `dist`; QR e assinatura saíram do HTML sem mudar
   a ordem de execução.
2. **F1b — plataforma (separação concluída localmente):** contexto por aba, cofre por clínica,
   armazenamento grande e fila offline cifrada estão isolados em
   `src/platform/session-vault.js`; identidade, sessão, perfis e permissões
   estão em `src/platform/auth.js`; o adaptador de sessão e API do Supabase está
   em `src/platform/cloud-client.js`; persistência relacional, concorrência e
   conflitos estão em `src/platform/relational-persistence.js`; o diário
   cifrado, recibos e reconciliação estão em `src/platform/cloud-first.js`.
   Realtime, reconexão automática e estado da nuvem estão em
   `src/platform/sync-runtime.js`; o adaptador beta já existente permanece
   isolado em `src/platform/realtime-compat.js`.
3. **F1c — domínio e fluxo (concluído localmente):** o vínculo e reaproveitamento de
   dados entre módulos foi isolado em `src/domain/encounter-linker.js`. A
   identidade forte do paciente já atravessa autocomplete, reabertura de ficha
   e Agenda → atendimento. Cada documento clínico novo também recebe um
   identificador opaco de caso, propagado entre Agenda, pré, ficha, SRPA,
   documentos derivados e financeiro. Este incremento fecha os fluxos
   legados que ainda agrupavam somente pelo nome.
4. **F1d — apresentação (recorte da auditoria concluído localmente):** as primitivas de feedback e modal
   foram isoladas em `src/ui/feedback.js` e `src/ui/modal.js`; o autocomplete
   canônico, inclusive a seleção explícita de homônimos, está em
   `src/ui/autocomplete.js`, e busca/histórico estão em `src/ui/search.js`.
   As ações rápidas orientadas pelo ID do paciente estão em
   `src/ui/quick-actions.js`.
   A impressão central saiu do HTML para `src/print/print-preview.js`, sem
   ganhar permissão para alterar o registro original. O painel **Meu Dia**
   está em `src/ui/meu-dia.js`, preservando o agrupamento por paciente/caso
   forte e mantendo registros legados sem vínculo em linhas separadas. O
   dashboard principal está em `src/ui/dashboard.js`; as leituras da clínica
   continuam delegadas à persistência relacional, sem gravação direta de
   prontuários. A tabela, os filtros e a ordenação de pacientes estão em
   `src/ui/patients-view.js`; CRUD, conflitos e sincronização continuam no
   módulo original. Calendário, contadores, filtros e tabela da Agenda estão
   em `src/ui/agenda-view.js`; salvar, excluir, conflitos, sincronização e
   início do atendimento continuam no módulo original. As próximas extrações
   repartem os demais renderizadores por módulo. Os controles recolhíveis de
   formulários e os grupos de Ajustes estão em `src/ui/layout-controls.js`;
   guardam apenas preferências visuais do aparelho e não participam de dados
   clínicos, autorização ou Realtime. O feedback efêmero de botões, o resumo
   **Hoje**, a linha do tempo da Agenda, os seletores rápidos ASA/Mallampati e
   a busca global de comandos estão, respectivamente, em
   `src/ui/action-feedback.js`, `src/ui/dashboard-today.js`,
   `src/ui/agenda-timeline.js`, `src/ui/form-steppers.js` e
   `src/ui/global-command-search.js`. Esses componentes apenas apresentam,
   navegam ou leem a fonte canônica; não gravam prontuários nem assumem
   transporte, sessão ou Realtime. Nomes globais e posição síncrona dos
   handlers legados permanecem preservados. O feedback genérico dos botões usa
   somente “Salvando…”/“Processando…” e cor neutra; nunca declara sucesso pelo
   clique. Resultado local, fila offline, erro e confirmação remota continuam
   pertencendo ao estado canônico de sincronização ao lado do documento. Na
   ficha de anestesia, a barra fixa do paciente e os painéis de dose rápida e
   sinais vitais estão em `src/ui/anesthesia-patient-bar.js`,
   `src/ui/anesthesia-dose-panel.js` e `src/ui/anesthesia-vitals-panel.js`.
   Eles não alteram diretamente a ficha: comandos passam por
   `src/domain/anesthesia-quick-commands.js`, que preserva os métodos clínicos
   existentes, valida os valores mínimos necessários, marca a edição pendente
   e atualiza o gráfico. A gravação, o autosave e a sincronização continuam nos
   fluxos canônicos. O painel de vitais agora possui escaping no próprio escopo,
   eliminando o `ReferenceError` que podia ocorrer ao montar os ritmos. Os
   metadados de cabeçalho de impressão estão em `src/print/print-meta.js`, com
   escaping também para período, data e procedimento e fallback quando o
   filtro do dashboard não estiver disponível. A composição inicial saiu do
   HTML para `src/app/bootstrap.js` sem reordenar as etapas: disco local,
   recuperação da nuvem, Realtime, escrita contínua e service worker mantêm
   seus pontos de inicialização, e `auth.init()` continua sendo a última etapa.
   Nenhuma regra de sessão, persistência, fila offline ou sincronização foi
   alterada. O carimbo rápido de evento agora passa pela fronteira clínica
   `src/domain/anesthesia-event-commands.js`; badge, speed dial e cronômetros
   efêmeros estão em `src/ui/anesthesia-time-tools.js`. A apresentação não
   insere diretamente eventos na ficha e nenhum desses módulos acessa store,
   sessão, fila, Supabase ou Realtime. O indicador do cabeçalho está isolado em
   `src/ui/sync-status.js`: ele apenas lê contagens e estados canônicos e mantém
   a prioridade visual de conflitos, offline e pendências; “Sincronizado” só é
   exibido após o estado remoto confirmado. O componente não grava, remove nem
   drena qualquer dado.
   O fechamento local também consolidou a política cloud-only: registros
   confirmados vivem na fonte relacional e apenas na memória da aba; durante
   indisponibilidade, mutações e adendos ficam no WAL cifrado e retomam o envio
   automaticamente. O caixa diário usa uma linha versionada por clínica/data,
   com compare-and-swap, conflito preservado e Realtime. Novas extrações de UI
   podem continuar como manutenção arquitetural, mas não fazem parte do
   bloqueador funcional desta auditoria.
5. **F1e — operação comercial:** telemetria sem conteúdo clínico, suporte,
   termos, privacidade, cobrança e requisitos das lojas.

PWA/TWA ou aplicativo híbrido só será escolhido depois da segurança,
homologação e operação estarem comprovadas.

O cliente Realtime primário é obrigatório e expõe seu estado no Diagnóstico.
O segundo cliente foi preservado somente como compatibilidade para instalações
antigas que já tinham a preferência beta ligada; ele não aparece mais como
opção capaz de desligar o tempo real. A consolidação física dos dois exige uma
homologação funcional em navegador com duas sessões e não será feita como mera
refatoração estrutural.

### Transição segura da identidade do atendimento

`src/domain/encounter-identity.js` mantém duas chaves intencionalmente
separadas:

- a chave **legada** por nome reproduz o `legacy_id` já gravado e evita criar
  duplicatas durante a transição;
- a chave **forte** aceita CPF válido ou nome + nascimento; nome isolado nunca
  autoriza unir prontuários, e a chave pode ser escopada pela organização.

O caminho remoto continua usando a chave legada até existir migração aditiva e
homologação dos vínculos atuais. Nos fluxos locais novos, o autocomplete mostra
nascimento e os quatro últimos dígitos do CPF, quando disponíveis, e guarda a
identidade escolhida no documento. Agenda e reabertura da ficha preservam esse
contexto. Se houver mais de uma identidade forte com o mesmo nome e o usuário
não tiver escolhido uma delas, autopreenchimento e importação param com aviso;
nenhum campo dos homônimos é combinado por conveniência.

O vínculo de atendimento segue duas camadas locais e aditivas:

- `_caseId` é o identificador opaco e prevalece quando um módulo abre outro;
- `_caseKey` é uma impressão digital auxiliar formada apenas quando há
  paciente forte + data + procedimento; ela não substitui uma seleção
  explícita nem autoriza união baseada só no nome.

Agenda → atendimento, pré → anestesia, anestesia → SRPA e documento clínico →
financeiro preservam o mesmo caso. O painel **Meu Dia** cruza módulos somente
por esse vínculo ou pela origem financeira exata; registros legados sem vínculo
ficam em linhas separadas. Impressões combinadas bloqueiam pacientes/casos
incompatíveis. A importação do Google Drive é idempotente por ID/hash do arquivo
e cria um registro isolado por PDF, pois nome + data não provam identidade.

Essa identidade forte ainda vive dentro do documento e não muda o esquema
remoto. A promoção para colunas relacionais e índices próprios exige migração
aditiva, homologação com duas sessões e autorização G3 antes de qualquer
aplicação no Supabase.

## Critérios de aceite por extração

- mesma ordem de carregamento e mesmos pontos globais de compatibilidade;
- `dist` contém apenas a allowlist e hashes conferidos;
- funcionamento online, Realtime, offline e computador compartilhado não muda;
- testes de segurança passam na fonte e no `dist`;
- nenhuma aplicação em Supabase, push, deploy ou publicação é feita pelo F1.
