# Reconciliação e prontidão da produção — 9 de outubro de 2026

**Estado: produção não liberada para aplicação deste pacote.** A autorização
do proprietário, “Pode fazer tudo”, permite concluir o trabalho necessário.
O bloqueio atual é técnico: a homologação não está reconciliada, o runner real
não foi executado e a baseline completa da produção não foi obtida. Uma
alternativa de coleta de tabelas retornou metadados parciais, descritos abaixo.
Não é falta de consentimento para a tarefa.

Alvo de produção: `zbpbrnalamjrcfbscjkt`, Soft Anestesia. Alvo exclusivo de
homologação: `yqqrfgbvoexricjdxpis`, branch `audit-remediation-v2`.
Esta investigação fez somente leituras de metadados. Nenhuma migração,
classificação, cópia, atualização ou exclusão foi executada em produção.
Nenhum conteúdo clínico, nome de paciente ou credencial foi consultado.

## Evidência obtida da produção

As ferramentas `get_project`, `list_migrations` e `get_advisors` responderam
em 2026-10-09, por volta de 21:09 UTC:

- Projeto `ACTIVE_HEALTHY`; Postgres reportado como `17.6.1.127`, engine 17.
  Esse número, isoladamente, não prova vulnerabilidade nem disponibilidade de
  atualização; o painel de upgrades ainda precisa ser verificado.
- Histórico formal: **somente `0001`, nome `assinaturas`**. Não foram
  reconhecidas entradas para as migrações de `database/migrations`.
- Esse histórico prova a deriva de rastreabilidade, mas não prova ausência
  dos objetos: alterações manuais podem existir sem registro formal.

| Advisor de segurança | Quantidade | Situação confirmada |
| --- | ---: | --- |
| View com privilégios do criador | 1 erro | `public.assinaturas_publicas` |
| Função com `search_path` mutável | 8 | `public.set_updated_at`, `public.assinaturas_no_mutate`, `app.set_updated_at`, `app.bump_version`, `app.stamp_created`, `app.guard_finalized`, `public.med_unaccent`, `public.med_normalizar` |
| Extensão em `public` | 2 | `unaccent`, `pg_trgm` |
| Materialized view exposta à API | 1 | `public.medicamentos_clinicos` |
| SECURITY DEFINER executável por `anon` | 8 | RPCs administrativas e refresh de medicamentos |
| SECURITY DEFINER executável por `authenticated` | 8 | As mesmas assinaturas |
| Proteção contra senha vazada desabilitada | 1 | Configuração Auth |
| RLS habilitado sem policy | 1 informação | `public.assinaturas` |

As oito assinaturas públicas apontadas são `add_member(uuid,text,text)`,
`prog_add_member(uuid,text,text)`, `prog_contar_ambiente(uuid)`,
`prog_criar_ambiente(text,text)`, `prog_excluir_ambiente(uuid,boolean)`,
`prog_excluir_conta(uuid)`, `prog_remover_membro(uuid,uuid)` e
`refresh_medicamentos_clinicos()`.

| Advisor de desempenho | Quantidade |
| --- | ---: |
| FK sem índice de cobertura | 66 |
| Avaliação de Auth/RLS por linha | 22 |
| Policies permissivas múltiplas | 205 |
| Índice sem uso observado | 27 |
| Conexões Auth configuradas por número absoluto | 1 informação |

Não se deve remover índices com base apenas no contador de uso: a janela
estatística não demonstra ausência de necessidade.

Referências oficiais de correção: [views com security definer](https://supabase.com/docs/guides/database/database-linter?lint=0010_security_definer_view),
[search_path de funções](https://supabase.com/docs/guides/database/database-linter?lint=0011_function_search_path_mutable),
[funções privilegiadas públicas](https://supabase.com/docs/guides/database/database-linter?lint=0028_anon_security_definer_function_executable),
[funções privilegiadas autenticadas](https://supabase.com/docs/guides/database/database-linter?lint=0029_authenticated_security_definer_function_executable)
e [segurança de senhas](https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection).

## Catálogo de tabelas obtido e limites

Quatro consultas somente leitura foram solicitadas para catálogos de tabelas,
funções, constraints e policies. Elas não retornaram resultados e foram
interrompidas. Depois, o agente principal obteve um resultado usando
`list_tables`, schema `public`, `verbose: true`, sem executar novas consultas
SQL. O snapshot está em
[PRODUCTION-TABLE-CATALOG-2026-10-09.json](PRODUCTION-TABLE-CATALOG-2026-10-09.json),
SHA-256 `618f1c8f94096b77b478933ce89a76a2627e0a4f3a15869454b8d4cf844e356a`.

O snapshot contém **34 tabelas públicas, todas com RLS habilitado**, nomes e
tipos de colunas, indicação de nulabilidade, defaults, PKs e vínculos de FKs.
Não contém definições completas de constraints, índices únicos compostos,
ações das FKs, triggers, policies, grants, proprietários, privilégios padrão,
funções, Storage ou publicações Realtime. A opção de coluna `updatable` não
comprova permissão do usuário. Não é uma baseline completa assinada nem prova
de isolamento funcional.

O download direto do changelog falhou por conexão ao proxy. A página oficial
do changelog foi posteriormente acessada pelo conector de pesquisa. Essa
leitura documental não confirma as configurações, upgrades pendentes ou
versão de segurança efetivamente aplicada a este projeto.

### Contrato conhecido de `public.documentos`

O catálogo confirma a tabela legada e suas colunas:

| Coluna | Tipo | Nulabilidade | Default/identidade informado |
| --- | --- | --- | --- |
| `id` | `bigint` | NOT NULL | identidade `GENERATED BY DEFAULT` |
| `user_id` | `uuid` | NOT NULL | nenhum default informado |
| `modulo` | `text` | NOT NULL | nenhum default informado |
| `doc_id` | `text` | NOT NULL | nenhum default informado |
| `dados` | `jsonb` | NOT NULL | `'{}'::jsonb` |
| `atualizado_em` | `timestamptz` | NOT NULL | `now()` |

A PK é `id`; a FK `documentos_user_id_fkey` liga `user_id` a `auth.users.id`.
RLS está habilitado. O snapshot **não informa** ações ON DELETE/UPDATE,
parâmetros da sequência identity, índice único de `user_id + modulo + doc_id`,
policies, grants ou triggers. Portanto, o DDL completo ainda não foi obtido.
Não existe `CREATE TABLE public.documentos` nas migrações históricas
inventariadas. Esses metadados permitem preparar uma fixture sintética com
colunas corretas; não permitem declará-la reprodução exata da tabela real nem
inventar constraints/grants históricos para desbloquear o deploy.

O número **1.075 documentos legados** pertence à auditoria de 5 de outubro.
O novo snapshot informa `rows: 1152` para `documentos`; esse é um valor de
catálogo reportado pela ferramenta, **não um `COUNT(*)` independente**. Não
comprova por si só crescimento, quantidade ativa ou classificação do acervo.
Nenhuma linha foi lida, recontada independentemente ou atribuída a uma
clínica. Mesmo um usuário com um único vínculo não comprova a organização de
um documento histórico. A classificação permanece pendente de evidência
explícita e ação auditada do programador.

### Comparação de colunas com as fundações propostas

Uma comparação local dos blocos `CREATE TABLE` de
`0001_foundation.sql` e `0003_migration_targets.sql` com o snapshot encontrou
as **25 tabelas** desses blocos. As **337 colunas reconhecidas por nome e tipo**
estão presentes com tipos compatíveis; não apareceu uma coluna de fundação
ausente nessa comparação. Isso não compara cada constraint, policy, trigger
ou default. Colunas adicionais de migrações posteriores, como `legacy_id`,
`organizations.settings` e `organization_users.permissoes`, estão presentes.
Nenhum desses resultados autoriza reaplicar fundações em produção.

| Preflight de estrutura | Resultado que os metadados permitem concluir | O que continua pendente |
| --- | --- | --- |
| Fronteira das 13 tabelas operacionais de `0019` | `organization_id` é UUID NOT NULL nas 13 tabelas | FK completa, imutabilidade por trigger, RLS de leitura/escrita e papéis reais |
| Versões de pacientes/casos/agenda | `patients`, `encounters` e `appointments` **não possuem `version`** | Aplicar e validar a diferença de `0019` em homologação; disputa atômica real |
| Dez tabelas clínicas/financeiras já versionadas | `version` existe como integer NOT NULL default 1 | CHECK positivo, incremento e autoria no servidor, UPDATE condicionado e Realtime |
| Recibos de `0023` | As 12 tabelas listadas pela migração **não possuem** `last_operation_id` nem `last_operation_checksum` | Adição, constraints, unicidade e replay real após resposta perdida |
| Adendos `0020`/`0031` | `addenda` tem `legacy_id` nullable; **não tem** `reason`, `author_id`, `parent_legacy_id` ou `retification_revision` | Backfill histórico e resolução de pais, constraints, autoria, append-only e CAS concorrente |
| Assinaturas | **Não há** `organization_id` nem `signed_by` em `assinaturas` | Metadados históricos agregados, classificação comprovada, corrente/índices e API autorizada |
| Compartilhamento `0028` | `org_shares` só tem `id`, `org_origem`, `org_destino`, `modulos`, `criado_por`, `criado_em`; faltam prazo, motivo e estado de autorização | Endurecimento, revogação, auditoria e testes reais por módulo |
| Novos destinos públicos | `drafts`, `user_preferences`, `legacy_access_logs`, `sync_conflicts`, as quatro tabelas de migração legada e `cash_closings` **não estão no snapshot** | Reconstrução e validação das migrações dependentes na homologação |
| Chave offline `0022` | O snapshot cobre apenas `public` | Nenhuma conclusão sobre existência/ACL de `app.offline_keyrings` |

Há também `public.pacientes`, uma tabela histórica distinta de
`public.patients`, com FK de `user_id` para Auth e **sem `organization_id`**.
O catálogo informa RLS habilitado e `rows: 0`, que não é contagem independente.
Sua origem, ACL, uso por versões antigas e destino devem entrar na baseline;
não se deve atribuir-lhe organização ou descartar a tabela por inferência.

Os preflights de **existência, nomes/tipos, nulabilidade indicada, defaults
reportados, PKs e vínculos de FKs** têm evidência parcial revisável. Os de
isolamento, concorrência, durabilidade, privilégios e reprodução integral
permanecem bloqueados até obtenção do catálogo complementar e testes reais.

## Homologação após a autorização mais recente

O agente responsável pela aplicação informou sucesso de
`0014_medicamentos_anvisa` e `0018_stop_legacy_writes` no alvo de homologação.
A chamada de `0019_optimistic_concurrency` falhou com
`invalid or expired requestState`; a aplicação remota foi interrompida.
Esse resultado não equivale a recusa do proprietário. Não se deve reenviar em
loop nem declarar a migração aplicada sem histórico e catálogo confirmados.

O agente principal confirmou o histórico formal da homologação às
22:24:20 UTC: 19 entradas, correspondentes à assinatura original e às
18 migrações de fundação; `0019` não consta como aplicada. As versões remotas
de `0014` e `0018` são `20261009211312` e `20261009212903`.
O runner de integração real continua sem evidência de execução.
`0019`–`0032` e `supabase/migrations/0002_assinaturas_hardening.sql` ainda não
têm aplicação completa e validação demonstradas nesta etapa.

## Sequência segura para concluir a reconciliação

### Validação SQL isolada no GitHub

O workflow `.github/workflows/sql-integration.yml` executa a baseline Git em
um Supabase Docker efêmero, sem credenciais de homologação ou produção. O
executor verifica o alvo local, os hashes, 34 arquivos SQL ordenados e duas
fixtures com rollback. A disputa usa duas conexões e confirma no PostgreSQL
que a segunda está bloqueada antes de liberar a primeira. O resultado exige
uma proposta aceita, uma conflitante e preservação do original e da auditoria.

Os 12 grupos de proteção do executor passaram localmente; a execução SQL
efetiva precisa ser confirmada pelo job do SHA publicado. O artefato
`local-sql-integration-evidence.json` contém hashes e resultados, sem chaves.
Mesmo um resultado local aprovado não demonstra Auth API, RLS hospedada,
Realtime, baseline da produção ou classificação dos documentos históricos.
Os indicadores remotos continuam falsos e `remoteApplyAllowed` permanece
`false` até obtenção das evidências correspondentes.

### Etapas remotas pendentes

1. Confirmar novamente a referência dos dois projetos e capturar o histórico
   formal atual. Registrar resultado de cada operação e seus hashes; uma
   mensagem de erro não é evidência de transação concluída.
2. Capturar exclusivamente DDL e metadados de `public`, `app`, objetos
   próprios em `storage`, policies, ACL, privilégios padrão, funções,
   triggers, constraints, índices e publicações. Preservar a evidência com
   hash e referência exata do projeto. Exportar apenas schema, sem linhas.
3. Comparar o catálogo com os dois históricos Git. Separar objetos já
   existentes, alterações manuais, SQL pendente e objetos historicamente
   externos às migrações. Não reaplicar `0001`–`0017` na produção nem marcar
   versões como aplicadas apenas porque existem tabelas com o mesmo nome.
4. Reproduzir a baseline em homologação sem dados identificáveis. Incluir o
   DDL histórico exato de `documentos`, quando obtido, antes do seu
   endurecimento. Teste contra tabela ausente deve retornar **pendente**,
   nunca “RLS passou”. Usar somente fixtures sintéticas para os testes.
5. Validar os preflights abaixo; aplicar a diferença revisada em homologação,
   com ordem, hashes, tempo e locks registrados. A versão derivada de `0026`
   sem `CONCURRENTLY` é específica de homologação vazia; a produção exige
   execução de índices concorrentes fora de transação.
6. Executar a matriz real Auth/RLS/PostgREST/Storage/Realtime e a disputa CAS
   entre duas sessões. Preservar as propostas conflitantes e os originais
   finalizados. A evidência append-only não deve ser enfraquecida para apagar
   fixtures; definir retenção ou recriação do ambiente exclusivo de teste.
7. Rodar Advisors novamente, comparar catálogo e configuração hospedada e
   testar recuperação. Somente então registrar a baseline reconciliada,
   evidência dos gates e janela de aplicação da diferença em produção.

### Preflights que o histórico formal sozinho não resolve

| Pacote | Evidência exigida antes da produção |
| --- | --- |
| `0018` — fechar canal pessoal | DDL/ACL/RLS reais de `documentos`; teste negativo real de INSERT/UPDATE/DELETE e leitura comum, sem apagar acervo |
| `0019` — revisão atômica | Tipos/defaults de `version`, triggers de incremento, imutabilidade de organização e UPDATE condicional verificados em todas as tabelas operacionais |
| `0020` — finalização/adendos | Contagens agregadas de metadados históricos incompatíveis, resolução de pais na mesma organização e demonstração de que normalização de metadados não perde histórico |
| `0021` — anexos | Paths e policies reais de Storage, metadados de referências e bloqueio de exclusão física indevida |
| `0022`/`0023` — offline/recibos | ACL mínima, liberação de envelope apenas ao titular e recibo idempotente com UUID/checksum confirmado |
| `0024` — legado | Inventário sem conteúdo, classificação explícita com motivo, cópia idempotente, validação de hash e reversão sem sobrescrever destino divergente |
| `0025` — privilégios/RLS | Comparação de todas as policies/ACL antes/depois; matriz de papéis real, sem somar policies antigas por OR ou conceder escrita em módulo somente impressão |
| `0026` — índices | Cobertura real dos 66 FKs apontados, plano das consultas e criação concorrente fora de transação em produção |
| `0027`–`0030` — novos escopos/Realtime | Contratos de tabelas e shares, módulos autorizados, revogação, replica identity, publicação e assinatura de todos os tópicos necessários |
| `0031` — retificação append-only | Identidade dos adendos/pais, revisão exclusiva por cadeia, conflito preservado, replay com mesma autoria e corrida real de duas sessões |
| `0032` — bloqueio de exclusão de originais finalizados | UPDATE/DELETE, exclusão administrativa, cascata e modo replica rejeitados sem modificar original, auditoria ou adendos; exclusão de rascunho efetivamente executada |
| Assinaturas `0002` | Contagens de corrente/identidades incompatíveis antes do índice único; view invoker, ACL fechada e serviço autorizado funcionando sem acesso direto de cliente |

### Correções de Advisors já propostas no Git

`0025_supabase_hardening.sql` revoga privilégios implícitos, fixa caminhos de
funções próprias, move extensões relocáveis para `extensions` e a materialized
view de medicamentos para `app`, com view pública `security_invoker`.
`refresh_medicamentos_clinicos()` recebe EXECUTE somente para `service_role`.
RPCs administrativas necessárias continuam acessíveis a `authenticated`
pela allowlist, com verificação do papel no banco; o eventual aviso residual
do Advisor deve corresponder exatamente a essa API auditada. `anon` não deve
executar RPCs administrativas.

O arquivo `supabase/migrations/0002_assinaturas_hardening.sql` torna
`assinaturas_publicas` invoker/barrier, fixa o caminho da função de imutabilidade
e revoga acesso direto de `PUBLIC`, `anon` e `authenticated`. A ausência de
policies de cliente em `assinaturas` é intencional nesse desenho; o INFO do
Advisor deve ser interpretado junto com ACL e API Edge autorizada.

Essas propostas **não são evidência de correção já aplicada à produção**.
Como `0025` altera policies e grants amplamente, sua aplicação depende da
matriz funcional real e da análise de diferenças, não apenas de passar em
verificações de texto SQL.

### Configurações hospedadas ainda não comprovadas

SQL não habilita proteção contra senhas vazadas, política de cadastro público,
reauthentication nem upgrades da plataforma. Confirmar essas configurações no
projeto e registrar evidência antes/depois. Confirmar também os schemas
expostos pela Data API: `app` e `extensions` não devem ser expostos.
Novas tabelas precisam de grants explícitos e RLS; o comportamento de exposição
automática não deve ser presumido. Governança GitHub, aprovação registrada e
deploy devem permanecer vinculados ao SHA e ao projeto exatos da validação.

## Critério para alterar o estado deste relatório

A autorização do proprietário já existe. Para declarar “concluído”, faltam
resultados verificáveis: baseline DDL reproduzida, homologação reconciliada,
integração real aprovada, acervo legado tratado com classificação comprovada,
controles remotos de governança ativos e aplicação/validação em produção.
Falhas técnicas do conector devem ser resolvidas ou relatadas sem transformar
autorização existente em novos pedidos repetidos de consentimento.
