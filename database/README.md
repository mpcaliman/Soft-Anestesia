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
  empresa). Contas inativas no banco são barradas. Falta ainda a migração
  assistida dos usuários locais antigos para contas do Auth.
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
- **Fase 6 — Módulos lendo/gravando do relacional (em andamento):** ✅ piloto no
  módulo **Pacientes**: puxa os pacientes da tabela `patients` (nuvem) e junta
  com os locais (dedup pelo nome, igual à migração), e cada paciente salvo é
  espelhado (upsert idempotente por nome) na tabela relacional — cross-device,
  com o localStorage como cache/offline. Próximos módulos seguem o mesmo padrão
  via `cloudRel`.
- **Fase 5 — Conflitos + Realtime (em andamento):** ✅ concorrência otimista no
  piloto Pacientes — ao salvar, o app confere se a linha mudou na nuvem
  (`updated_at`) desde que foi carregada; se mudou, abre resolução de conflito
  (comparar *meu* × *nuvem*, manter/usar/adiar) em vez de sobrescrever cego.
  Falta a presença ao vivo via Realtime ("fulano está editando").
- **Fase 6+ — Pré reorganizada, Ficha/linha do tempo unificada, SRPA,
  Financeiro (rascunho/conciliação), anexos no Storage, PDF versionado, tela de
  diagnóstico da nuvem, testes.**

## Rollback

Como é aditivo, para reverter basta remover os objetos criados (as tabelas novas
não têm dados de produção ainda). Não há `DROP` sobre nada existente.
