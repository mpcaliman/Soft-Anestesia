# Soft Anestesia — Banco de dados (Supabase)

Este diretório contém as migrações que estabelecem o **Supabase como fonte
oficial** dos registros clínicos. É a **Fase 1** do rebuild: cria o esquema
relacional (organizações, perfis, pacientes, encounters, tabelas clínicas com
versão/status/finalização, linha do tempo, auditoria, anexos), com **RLS por
papel/organização**, triggers e Realtime.

> As migrações são **aditivas, idempotentes e não-destrutivas**. Não apagam nem
> alteram a tabela legada `documentos` (a sincronização atual do app continua
> funcionando durante a transição). **Nenhum dado é migrado por estes scripts** —
> a migração dos JSON atuais será uma etapa posterior, testada à parte.

## Como aplicar

No painel do Supabase → **SQL Editor**, rode nesta ordem:

1. `migrations/0001_foundation.sql` — tabelas, funções, triggers, RLS.
2. `migrations/0002_storage_realtime.sql` — bucket privado de anexos + Realtime.
3. **Seed inicial** (abaixo) — cria sua organização e te vincula como `gestor`.

Pode rodar de novo com segurança (idempotente).

## Seed inicial (rode logado como você mesmo)

Substitua o e-mail pelo da sua conta e ajuste o nome da organização.

```sql
-- 1) descubra seu user_id a partir do e-mail
--    (auth.users é gerenciado pelo Supabase Auth)
with me as (
  select id, email from auth.users where email = 'SEU_EMAIL@exemplo.com'
),
org as (
  insert into public.organizations (nome, ativo)
  values ('Minha Clínica de Anestesia', true)
  returning id
)
insert into public.organization_users (organization_id, user_id, role, ativo)
select org.id, me.id, 'gestor', true from org, me;

-- 2) crie/atualize seu profile
insert into public.profiles (id, nome, email, funcao, ativo)
select id, 'Seu Nome', email, 'gestor', true from auth.users
where email = 'SEU_EMAIL@exemplo.com'
on conflict (id) do update set funcao = 'gestor', ativo = true;
```

Depois disso, para adicionar a equipe (ex.: a secretária), primeiro crie a conta
dela no **Supabase Auth** (Authentication → Users → Add user, ou pelo fluxo de
signup do app), e então vincule:

```sql
insert into public.organization_users (organization_id, user_id, role, ativo)
values ('<ORG_ID>', '<USER_ID_DA_BETE>', 'auxiliar', true);
```

## Papéis e o que cada um enxerga (RLS aplicada no banco)

| Papel | Pacientes/Encounters | Clínico (pré, ficha, SRPA…) | Financeiro | Cadastros | Auditoria |
|---|---|---|---|---|---|
| **gestor** | ler/editar | ler/editar | ler/editar | editar | ler tudo |
| **anestesiologista** | ler/editar | ler/editar | ler/editar (rascunho) | ler | próprios logs |
| **cirurgião** | só os dele | só os dele | — | ler | próprios logs |
| **auxiliar** | ler/editar | — | — | ler | próprios logs |
| **financeiro** | — | — | ler/editar | ler | próprios logs |
| **empresa** | — | — | (a definir) | ler | próprios logs |

> Observações honestas sobre esta v1 de RLS:
> - **anestesiologista** vê o clínico da **organização inteira** (prático em
>   grupo). Se você quiser "cada um vê só os seus", dá para restringir por
>   `anesthesiologist_id` numa próxima migração — é uma linha de policy.
> - **cirurgião** só vê encounters/clínico onde `surgeon_id = ele`.
> - **financeiro/auxiliar não leem dado clínico** (evita exposição).
> - Registros **finalizados/assinados** ficam **imutáveis** no `data` (trigger
>   `guard_finalized`); correções vão para `addenda`.
> - Toda alteração clínica gera linha em `audit_logs` (trigger `audit_row`).

## O que estas migrações criam

- **Núcleo:** `organizations`, `organization_users`, `profiles`, `hospitals`,
  `rooms`, `equipment`.
- **Central:** `patients` (cadastro único por org, com índices de busca por CPF,
  nome, nascimento, prontuário), `encounters` (atendimento — âncora dos módulos).
- **Clínico:** `preanesthetic_assessments`, `anesthesia_records`,
  `recovery_records`, `risk_assessments`, `consents`, `prescriptions`,
  `documents`, `finance_entries` — todas com `organization_id`, `encounter_id`,
  `patient_id`, `status`, `version`, `finalized_at/by`, `created/updated_by`,
  `deleted_at`, `data jsonb` (preserva os campos do formulário atual).
- **Linha do tempo:** `anesthesia_timeline_events` (vital, medication, fluid,
  event, airway, …) — fonte única para gráfico/tabela/eventos/balanço/PDF.
- **Governança:** `addenda`, `attachments` (metadados; binário no Storage),
  `templates`, `standard_texts`, `audit_logs`.
- **Segurança:** RLS em todas as tabelas + funções `app.org_ids()`,
  `app.has_role()`, `app.can_read_clinical()`, `app.can_write_clinical()`.
- **Storage:** bucket privado `clinical-attachments` com policies por org.
- **Realtime:** publicação nas tabelas de edição ao vivo.

## Roadmap (próximas fases — feitas no app, sem quebrar o atual)

- **Fase 2 — Camada de serviços + sync honesto:** um serviço central
  (`services/db`, `services/sync`) torna o Supabase a fonte; localStorage vira
  cache/fila. Status reais (Salvando / Salvo localmente / Sincronizando /
  Sincronizado / Offline / Pendente / Erro / Conflito). Fila idempotente com
  `operation_id` (UUID) + `base_version` + `retry_count`.
- **Fase 3 — Auth unificada (em andamento):** ✅ o login já é único (Supabase
  Auth, com fallback local offline) e, ao entrar, o app **puxa o papel do
  servidor** (`organization_users.role` + `profiles`) e deriva as permissões da
  UI a partir dele (gestor/anestesiologista/cirurgião/auxiliar/financeiro/
  empresa). Contas inativas no banco são barradas. ✅ **Gestão da equipe no app
  (Ajustes → Equipe da nuvem):** o gestor lista os membros da organização, muda
  o papel, ativa/desativa e **adiciona por e-mail** via a função segura
  `public.add_member` (`0006`, SECURITY DEFINER, só o gestor chama). A pessoa
  precisa ter criado a conta na nuvem antes. ✅ **Ponte local → nuvem:** no card
  *Usuários e segurança* cada usuário mostra se é **🔒 local** (só neste
  aparelho) ou **☁️ nuvem** (cross-device); os locais ganham um botão
  **☁️ Convidar** que mapeia o perfil local ao papel da nuvem
  (admin→gestor, médico→anestesiologista, secretária→auxiliar) e leva o gestor,
  já pré-preenchido, ao fluxo `add_member`. Não cria a conta automaticamente
  (isso depende da senha da própria pessoa) — orienta o passo a passo honesto.
- **Fase 4 — Paciente/Encounter central + migração dos dados atuais (em
  andamento):** ✅ `0003_migration_targets.sql` adiciona `legacy_id`
  (idempotência) às tabelas e cria `consultations`, `quotes` e `appointments`.
  ✅ No app (Ajustes → *Migração para o banco relacional*) há um motor que lê
  os dados locais, **deduplica pacientes** (pelo nome normalizado, enriquecido
  com CPF/nascimento — a mesma identidade que o app já usa), **forma
  encounters** (paciente + data + procedimento) e escreve nas tabelas de forma
  **idempotente** (`legacy_id`) e **aditiva**. Sempre há **pré-visualização**
  (dry-run) antes de qualquer escrita. Próximo: relatório persistido e
  reconciliação de anexos no Storage.
- **Fase 6 — Módulos lendo/gravando do relacional:** ✅ **Pacientes**, ✅ **Agenda**
  e ✅ **todos os módulos de registro** (pré, consulta, ficha de anestesia,
  recuperação, risco, termo, receituário, documentos, financeiro, orçamento) já
  usam as tabelas relacionais como registro central cross-device via `cloudRel`.
  Um **motor genérico** espelha cada gravação (hook central no `store.save`),
  criando/vinculando **paciente e encounter** automaticamente pela mesma
  identidade da migração (idempotente, atualiza as linhas migradas). Pull
  automático 1×/sessão ao abrir cada módulo. Detecção de conflito (Fase 5) em
  todos, com diálogo genérico. Cache de ids na sessão evita GETs repetidos.
  localStorage segue como cache/offline.
- **Fase 5 — Conflitos + Realtime:** ✅ concorrência otimista em todos os
  módulos — ao salvar, o app confere se a linha mudou na nuvem (`updated_at`)
  desde que foi carregada; se mudou, abre resolução de conflito (comparar *meu*
  × *nuvem*, manter/usar/adiar) em vez de sobrescrever cego. ✅ **Tempo real
  (beta, opt-in)** via Supabase Realtime: escuta mudanças no banco e atualiza o
  módulo aberto; best-effort/silent-fail, com status visível no Diagnóstico.
- **Anexos no Storage:** ✅ os anexos já sobem ao Storage; agora seus **metadados
  são registrados na tabela `attachments`** (idempotente por `storage_path`,
  índice em `0004_attachments_index.sql`), vinculados a paciente/encounter.
- **Diagnóstico da nuvem:** ✅ tela em Ajustes compara, tabela a tabela, o que
  está no aparelho × no banco relacional, com fila pendente, última sync e
  saúde da conexão.
- **Segurança do login (Ajustes → Usuários e segurança):** ✅ bloqueio de tela
  por inatividade **configurável** (2/5/10/15/30 min ou *Nunca*, padrão 5),
  botão **Bloquear agora** e **anti-força-bruta**: após 5 senhas erradas o
  login trava por 30 s (nos dois fluxos — nuvem e local). Tudo no aparelho, sem
  SQL novo.
- **Auditoria (Ajustes → Registro de auditoria):** ✅ tela read-only lê a
  `audit_logs` (populada pelos triggers) e mostra **quem** criou/editou/
  finalizou/excluiu **o quê** e **quando**, com filtro por módulo. Gestor vê a
  organização inteira; os demais veem os próprios eventos (RLS `audit_sel`).
  Não requer SQL novo — a tabela já vem da fundação.
- **Adendos / correções (medicina-legal):** ✅ correções após finalizar vão para
  a tabela `addenda` (append-only, idempotente por `legacy_id` — `0005`), sem
  alterar o registro original. Datadas e assinadas, aparecem na ficha e no PDF,
  e ficam locais (`_adendos`) para offline. Piloto na ficha de anestesia
  (`adendos.*`); o helper já suporta pré/consulta/recuperação/risco.
- **Linha do tempo unificada (visão):** ✅ botão na ficha de anestesia mostra
  sinais vitais + medicações + eventos + fluidos numa **única lista
  cronológica** (revisão do caso). Lê os dados que já estão na ficha — não muda
  o modelo. A tabela `anesthesia_timeline_events` fica para uma futura fonte
  única relacional, se/quando valer o refactor.
- **Ficha de anestesia — modo cirurgia (fluidez p/ alto volume):** ✅ auditoria
  de fluxo apontou 3 fricções principais no intra-op e todas foram resolvidas:
  (1) **navegação por seções** na ficha (a mais longa do app, 14 seções): chips
  fixos no topo com estado (○/●/✓) e **contadores ao vivo** de vitais/meds/
  fluidos; tocar rola e abre a seção. (2) **FAB ⏱️ Tempos**: os 6 horários do
  caso (entrada em sala → saída) carimbáveis com **um toque de qualquer lugar**
  da ficha, com o próximo esperado destacado — sem rolar ao topo. (3) **FAB 💉
  Medicação**: abre o catálogo multiseleção direto. Com os FABs já existentes
  (🩺 vitais, 🕐 evento), as 4 ações mais frequentes do caso ficam a um toque.
- **Pré-anestésica reorganizada:** ✅ uma **barra de navegação por seções** no
  topo da avaliação (Identificação · Anamnese · Exames · Pareceres · Risco ·
  Conclusões) mostra o **status de preenchimento** de cada bloco (vazio ○ /
  parcial ● / completo ✓) e, ao tocar, **rola e abre** a seção. Ao **finalizar**,
  um **checklist gentil** avisa se faltam itens essenciais (ASA, via aérea,
  jejum, conclusão/aptidão) — sem travar (dá para finalizar mesmo assim). A barra
  não sai na impressão.
- **SRPA mais completa:** ✅ além do **Aldrete** (alta da sala de recuperação),
  a ficha agora tem a **escala PADSS** (aptidão para **alta domiciliar**): 5
  critérios (sinais vitais, deambulação, náusea/vômito, dor, sangramento) com
  soma automática 0–10 e leitura clínica (**apto ≥ 9 e nenhum critério zerado**).
  Um botão **gera um resumo de alta padronizado** a partir dos campos (tempo de
  SRPA, sinais vitais chegada→alta, escalas, conduta, destino), editável. O topo
  mostra chip do PADSS; ao finalizar com destino *alta hospitalar*, avisa se o
  PADSS falta/está abaixo de 9. Tudo entra na impressão/PDF.
- **PDF versionado:** ✅ cada gravação incrementa uma **revisão** (`_rev`) no
  registro. Na impressão/PDF dos documentos clínicos (pré, consulta, ficha,
  SRPA, termo, risco) o **rodapé** carimba **código do documento** (6 dígitos do
  id), **número da revisão**, **status** (Rascunho/Finalizado) e **data/hora da
  última edição** — rastreabilidade médico-legal, sem SQL novo. Documento não
  salvo aparece como *Rascunho não salvo*.
- **Financeiro — fechamento de caixa do dia:** ✅ botão *Fechar caixa* abre um
  resumo por data (padrão hoje): **recebido no dia** (por data de
  pagamento/recebimento), **realizado** (por data do procedimento), **glosa** e
  **a receber**, com quebra por **forma de pagamento** e por **convênio**.
  Permite **salvar um snapshot** persistente (um por data, com observação e quem
  fechou) e lista os fechamentos anteriores. Entra no backup completo
  (`fin_fechamentos`). Conciliação por código TUSS, status por lançamento,
  regras por convênio e relatório mensal em PDF já existiam.
- **Testes automatizados + CI:** ✅ uma suíte de **smoke tests** (Playwright,
  `tests/smoke.mjs`) roda o app num Chromium headless e verifica os fluxos
  essenciais — boot sem erros de JS, modo demonstração, pré (navegação +
  completude), SRPA (PADSS + resumo de alta), financeiro (fechamento de caixa)
  e versionamento de documentos. Um **workflow de CI** (`.github/workflows/
  ci.yml`) roda `npm test` a cada push/PR, protegendo o que foi construído.
  Rodar localmente: `npm install && npx playwright install chromium && npm test`.
  **Cobertura ampliada (10 testes):** além dos fluxos acima, valida os **escores
  de risco** (ARISCAT/RCRI/STOP-Bang/Caprini/ASA), um **sweep dos construtores
  de impressão** (pré, consulta, ficha, SRPA, termo, receituário, documentos,
  risco, financeiro, agenda geram HTML sem erro), o **roundtrip do store**
  (salvar/buscar/excluir) e os **adendos append-only** (correção anexa sem
  alterar o original). Também cobre o **cálculo de infusão** (dose → mL/h por
  unidade, incluindo o caso "sem peso → não calcula") e o **RBAC** por papel
  (podeAcessar/podeEditar: admin, secretária só-impressão). Cobre ainda a
  **sincronização / fila offline**: fila idempotente (dedup por documento,
  `operation_id`/`base_version`) e o fluxo *push falha → enfileira → sincronizar
  drena → retry incrementa* (com a rede mockada). **14 testes no total.**

## Rollback

Como é aditivo, para reverter basta remover os objetos criados (as tabelas novas
não têm dados de produção ainda). Não há `DROP` sobre nada existente.
