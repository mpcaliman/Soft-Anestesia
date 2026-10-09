# Reconciliação e prontidão da produção — 9 de outubro de 2026

**Estado: produção não liberada para aplicação deste pacote.** A autorização
do proprietário, “Pode fazer tudo”, permite concluir o trabalho necessário.
O bloqueio atual é técnico: a homologação não está reconciliada, o runner real
não foi executado e a coleta completa do catálogo de produção não retornou.
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

## Coleta interrompida e limites

Quatro consultas somente leitura foram solicitadas para catálogos de tabelas,
funções, constraints e policies. Elas não retornaram resultados e foram
interrompidas. Portanto, não há nesta entrega uma baseline completa assinada
de schema, índices, triggers, privilégios, Storage ou publicação Realtime.
Não foram feitas novas tentativas após a interrupção.

O download direto do changelog do Supabase também falhou por conexão ao proxy.
A pesquisa documental do conector respondeu sobre migrações e schemas, mas
não substitui a revisão do changelog e das configurações do projeto antes de
uma aplicação remota.

**O DDL exato de `public.documentos` não foi obtido.** Não existe um
`CREATE TABLE public.documentos` nas migrações históricas inventariadas. O
contrato usado pelo código (`user_id`, `modulo`, `doc_id`, `dados` e
`atualizado_em`) não revela sozinho tipos completos, defaults, índices, FKs,
triggers, RLS ou ACL. Não é seguro inventar uma tabela equivalente e tratá-la
como baseline reproduzida.

O número **1.075 documentos legados** pertence à auditoria de 5 de outubro.
Ele não foi recontado nesta investigação. Nenhuma linha foi atribuída a uma
clínica. Mesmo um usuário com um único vínculo não comprova a organização de
um documento histórico. A classificação permanece pendente de evidência
explícita e ação auditada do programador.

## Homologação após a autorização mais recente

O agente responsável pela aplicação informou sucesso de
`0014_medicamentos_anvisa` e `0018_stop_legacy_writes` no alvo de homologação.
A chamada de `0019_optimistic_concurrency` falhou com
`invalid or expired requestState`; a aplicação remota foi interrompida.
Esse resultado não equivale a recusa do proprietário. Não se deve reenviar em
loop nem declarar a migração aplicada sem histórico e catálogo confirmados.

Essa atualização é um registro do resultado informado pela aplicação; esta
investigação não refez `list_migrations` da homologação após esses resultados.
Os documentos anteriores de execução parcial devem ser lidos com essa
distinção. O runner de integração real continua sem evidência de execução.
`0019`–`0031` e `supabase/migrations/0002_assinaturas_hardening.sql` ainda não
têm aplicação completa e validação demonstradas nesta etapa.

## Sequência segura para concluir a reconciliação

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
