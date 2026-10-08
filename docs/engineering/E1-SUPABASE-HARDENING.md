# E1 — hardening do Supabase e desempenho

Status: **implementado localmente; aplicação remota bloqueada por G3**.

Este pacote é formado por:

- `database/migrations/0025_supabase_hardening.sql`: RLS, privilégios, funções,
  extensões, materialized view e imutabilidade de ambiente;
- `database/migrations/0026_e1_performance_indexes.sql`: índices concorrentes,
  sem remoção de índices existentes;
- `supabase/migrations/0002_assinaturas_hardening.sql`: assinatura append-only
  fora do acesso direto de `anon`/`authenticated`;
- validação explícita de JWT e vínculo clínico na Edge Function `assinatura`;
- cadastro público desligado e senha local mínima de 12 caracteres com
  minúscula, maiúscula, número e símbolo.

## Decisões de segurança

1. Policies antigas `FOR ALL`, auxiliares e de compartilhamento não ficam
   somando permissões. Cada comando tem uma policy e o compartilhamento
   excepcional de leitura é incorporado à mesma decisão.
2. O papel `cirurgiao` volta a enxergar somente os encounters em que está
   nomeado. Módulos `só impressão` não ganham escrita no banco.
3. `organization_id`, `created_by` e identidades de vínculo (`user_id`/papel)
   são imutáveis depois do INSERT. A mudança excepcional de classificação do
   legado continua somente nos RPCs auditados do programador.
4. Funções começam sem EXECUTE para `PUBLIC`/`anon`/`authenticated`; somente a
   allowlist recebe EXECUTE. RPCs SECURITY DEFINER expostos permanecem apenas
   quando o navegador realmente precisa chamá-los e todos conferem o papel no
   banco.
5. A materialized view de medicamentos passa para `app`; a view pública de
   compatibilidade é `security_invoker`. Extensões relocáveis passam para
   `extensions`.
6. A validação de assinatura continua pública pela Edge Function. A tabela e
   a view não têm acesso direto de cliente; assinatura e acesso ao provedor
   exigem JWT válido e vínculo ativo de gestor/anestesiologista.
7. Nenhuma autorização usa `user_metadata`. Papéis são lidos de tabelas
   protegidas por RLS. `user_metadata.deve_trocar_senha` permanece somente como
   aviso de UX e não concede acesso.
8. A corrente de assinaturas tem uma posição única por clínica. Inserções
   simultâneas que disputem o mesmo predecessor são relidas e recalculadas; o
   navegador não pode afirmar emissor, titular ou cadeia ICP. Esses campos só
   serão preenchidos pelo driver SafeID homologado.
9. A `0026` reaproveita os índices `ux_<tabela>_legacy`, cujo primeiro campo já
   é `organization_id`, e não cria uma segunda cópia só para RLS.

## Homologação obrigatória antes da produção

Executar somente após reconciliação E0 e autorização G3:

1. restaurar um snapshot anonimizado em projeto de homologação vazio;
2. aplicar os dois históricos na ordem reconciliada;
3. medir tempo e locks da `0025`;
4. aplicar cada índice da `0026`, registrando duração e `pg_size_pretty`;
5. rodar Database Advisors e guardar o antes/depois;
6. executar a matriz RLS abaixo com usuários reais de teste;
7. comparar `EXPLAIN (ANALYZE, BUFFERS)` das consultas de login, lista por
   clínica, agenda, registros clínicos e compartilhamento;
8. validar Realtime com dois usuários editando o mesmo ambiente e confirmar
   que o controle de versão/conflito continua ativo;
9. testar rollback do snapshot antes de qualquer janela de produção.

### Matriz RLS mínima

| Papel | Mesma clínica | Outra clínica | Compartilhamento manual | Escrita |
|---|---|---|---|---|
| Gestor | módulos concedidos | negado | leitura concedida | módulos editáveis |
| Anestesiologista | equipe/próprios | negado | leitura concedida | módulos editáveis |
| Cirurgião | somente caso atribuído | negado | leitura concedida | respeita só impressão |
| Auxiliar | módulos concedidos | negado | leitura concedida | respeita só impressão |
| Financeiro | módulos concedidos | negado | leitura concedida | respeita só impressão |
| Empresa | módulos concedidos | negado | leitura concedida | respeita só impressão |
| Programador | funções auditadas | funções auditadas | configura exceção | sem escrita clínica direta |
| Anon | medicamentos públicos | negado | negado | negado |

## Configuração hospedada que SQL não resolve

No projeto de homologação e depois em produção, com evidência antes/depois:

- Auth → desativar cadastro público;
- Auth → senha mínima de 12 caracteres e composição forte;
- Auth → exigir login recente para troca de senha;
- Auth → habilitar proteção contra senhas vazadas, se o plano permitir;
- confirmar que as Edge Functions protegidas verificam JWT; `assinatura`
  mantém validação manual porque uma única rota é pública;
- revisar schemas expostos: somente `public` e `graphql_public`; `app` e
  `extensions` não devem entrar na Data API.

## Critérios de aceite

- nenhum erro crítico novo nos Advisors;
- nenhuma função privilegiada executável por papel desnecessário;
- UPDATE policies com `USING` e `WITH CHECK`;
- matriz RLS integralmente verde;
- latência p95 e planos sem regressão relevante;
- Realtime, edição simultânea, fila offline e reconciliação aprovados;
- duas assinaturas simultâneas na mesma clínica preservam uma corrente linear;
- restauração do snapshot comprovada.
