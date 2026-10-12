# Resultado do replay e diferenças de homologação

Em 11/10/2026, os dois jobs SQL do commit `28cdabe` passaram. A referência
PostgreSQL 17 restaurou exatamente o catálogo da aplicação capturado de
produção, reproduziu as dependências de autorização gerenciadas capturadas,
executou a original `0013` como pré-requisito declarado e as 16 atualizações.
A corrida real produziu um aceite e um conflito; o original e ambas as versões
foram preservados, e o container efêmero foi removido. Nenhuma dessas operações
foi executada no banco de produção.
O catálogo de homologação usado nesse comparativo foi capturado às
**12:05:11 UTC de 11/10/2026**, antes das recuperações e dos endurecimentos
posteriores. Ele é uma referência histórica; este documento não descreve os
direitos atuais do projeto hospedado.

A comparação com a homologação continua **não equivalente**: 878 diferenças.
CI verde comprova esse ensaio, não a igualdade de autorização entre a referência
local, a homologação hospedada e a produção.

## Matriz das 878 diferenças

| Grupo | Quantidade | Evidência e implicação |
|---|---:|---|
| Grants efetivos | 785 | Reconstrução por identidade/hash: 191 concessões adicionadas e 191 removidas mantêm a mesma capacidade, mudando o grantor; outras 355 capacidades aparecem e 48 desaparecem. As diferenças de owner e execução privilegiada impedem tratar os pares como exceção automática. |
| Owners de funções | 51 | `postgres` na homologação versus `supabase_admin` no ensaio; 23 são SECURITY DEFINER. O papel executor da migração e os privilégios dos owners precisam ser reproduzidos e testados. |
| Definições de funções | 19 | Hashes dos registros completos provam a reconstrução exata: 18 diferenças apenas CRLF/LF; uma também alinha espaços em nove linhas `FROM public.tabela WHERE` de `prog_contar_ambiente`. Nenhum corpo foi substituído ou normalizado no baseline. |
| Owners de relações | 12 | Novos objetos foram criados com `supabase_admin` pelo executor local; a homologação os possui como `postgres`. Não é prova de equivalência de execução/RLS. |
| FORCE RLS | 2 | A homologação capturada aplica FORCE RLS adicional a `documentos` e `pacientes`; o replay preserva a configuração real de produção, sem essa contenção adicional. |
| Policies | 2 | As policies restritivas `staging_legacy_channel_frozen` das duas tabelas legadas existem somente na fixture da homologação. Sua presença é uma transformação explícita, não uma policy histórica da produção. |
| Função ausente no replay | 1 | `criar_minha_organizacao(text)` existe apenas na homologação, com EXECUTE para authenticated e SECURITY DEFINER. Seu corpo permite criar organização/gestor ou assumir uma organização órfã sem exigir programador. Não deve ser adicionada à produção para igualar contagens. |
| Default ACL | 5 | Hashes confirmam diferenças reais de permissões futuras. `0025` usa ALTER DEFAULT PRIVILEGES sem FOR ROLE: na execução local age sobre `supabase_admin`; na execução hospedada como `postgres`, sobre outro criador. |
| Bucket | 1 | `documentos-pdf` é preservado do estado real de produção; estava ausente na homologação capturada. O bucket é privado. A contagem zero de objetos vem da captura agregada separada `PRODUCTION-STORAGE-RETENTION-2026-10-11.json`, não do catálogo de buckets. Sua retenção e suas policies precisam permanecer explícitas. |

As colunas (718), constraints (258), índices (205), sequência, triggers (122),
extensões operacionais e publicação Realtime comparadas não apresentam diferenças.
Isso favorece a estrutura da transição, mas não encerra as diferenças de direitos.

## Direitos que exigem reconciliação

Os clientes `anon` e `authenticated` ganham, na referência local, SELECT,
UPDATE e USAGE sobre **`public.documentos_id_seq`**: seis concessões ausentes
na homologação. A fixture de legado da homologação revoga esses direitos
explicitamente; as originais `0018`–`0032` não produzem a mesma revogação.
Revogar CRUD da tabela não revoga o direito de atualizar sua sequência.
As tabelas legadas mantêm zero grants de cliente/PUBLIC e a RPC de leitura
bruta `prog_read_legacy_documents` mantém zero EXECUTE de cliente. A falta
das duas policies restritivas e de FORCE RLS adicionais não significa que
o canal pessoal foi reaberto; representa uma defesa adicional presente apenas
na homologação capturada.

O papel `service_role` ganha 25 EXECUTE e 177 concessões CRUD em relação à
homologação: 45 DELETE, 44 INSERT, 43 SELECT e 45 UPDATE. Não perde direitos
nesse comparativo, depois de excluir corretamente o controle temporário de
claims. Há TRUNCATE concedido em 44 tabelas regulares do ensaio; outras três
entradas ACL pertencem a uma materialized view e duas views e não representam
a mesma operação de TRUNCATE de tabela. Service role é privilegiado: esses
direitos precisam constar do contrato do servidor e dos testes das Edge Functions.
Testes hospedados com grants menores não demonstram esse contrato da produção.

Os defaults públicos de `postgres` mantidos pelo replay ainda concedem direitos
amplos a clientes em objetos futuros, inclusive TRUNCATE em tabelas e UPDATE
em sequências. Endurecer somente o papel que executou o SQL não resolve os
defaults de todos os criadores. Alterações de defaults também não corrigem
automaticamente objetos existentes.

## Como produzir homologação fiel

1. Declarar os papéis que criam e executam migrações, os owners dos objetos e
   o contrato de service role. Repetir o ensaio usando o papel de produção
   esperado, preservando os bytes e hashes das originais e verificando os
   guards do executor. Não remover owners/grantors da comparação para fazê-la passar.
2. Preparar uma migração adicional de reconciliação, sem reescrever `0013`
   ou `0025`: tratar defaults com FOR ROLE explícito para todos os criadores
   relevantes, direitos das sequências legadas e permissões existentes.
   Rever grants de serviço por finalidade; não copiar cegamente o catálogo
   mais amplo ou o mais restritivo.
3. Construir uma referência de homologação vazia a partir do baseline real,
   dos pré-requisitos declarados e das atualizações, sem copiar Auth, prontuários
   ou arquivos. Conservar os dois buckets privados. Documentar separadamente
   as contenções e os controles temporários de teste.
4. Conter a RPC de autoprovisionamento presente apenas na homologação e testar
   que um usuário autenticado comum não cria organização nem se promove a gestor.
   A provisão de ambientes continua sendo ação do programador.
5. Reexecutar catálogo, grants, direitos negativos de clientes/service role,
   RLS de escrita/exclusão, Auth/Storage/Realtime hospedados e o navegador contra
   essa referência. Toda diferença restante precisa de uma decisão explícita
   por objeto, com evidência de execução. O comparador permanece íntegro.

Não é necessário introduzir uma função de autoprovisionamento ausente da
produção nem remover o bucket real para forçar igualdade com a homologação
capturada. O alvo deve representar o estado pretendido e autorizado, com contenções
adicionais documentadas e direitos testados.

## Evidência reproduzível de definições

`PRODUCTION-REPLAY-FUNCTION-DIFF-2026-10-11.json` contém identidades e hashes,
sem corpos das funções, contas ou conteúdo clínico. Pode ser reproduzido com:

```sh
node scripts/analyze-production-replay-functions.mjs \
  /tmp/production-baseline-replay-28-push-evidence.json \
  docs/engineering/PRODUCTION-APPLICATION-CATALOG-2026-10-11.json \
  docs/engineering/STAGING-APPLICATION-CATALOG-2026-10-11.json \
  /tmp/function-diff-review.json
```

A classificação explica diferenças de bytes. Ela não altera o comparador,
não aprova grants/defaults/owners e não autoriza publicação em produção.
As 292 linhas legadas sem correspondência e os 113 candidatos com criador
divergente são pendências destinadas à quarentena no rollout; o banco de
produção ainda não foi modificado. Nenhuma clínica é inferida. Os demais
candidatos também precisam de evidência histórica e classificação auditada.
