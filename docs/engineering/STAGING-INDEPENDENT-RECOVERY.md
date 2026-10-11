# Recuperação independente de fixtures de homologação

Alvo exclusivo: `yqqrfgbvoexricjdxpis`. Esta infraestrutura não pertence às
migrações de produção, aos assets públicos ou ao baseline clínico.

## Instalar antes de criar fixtures

1. Confirmar pelo MCP o projeto/branch e o histórico `0032`, sem inferir o alvo
   pelo nome exibido. A proteção SQL exige também a tabela de claims existente.
2. Aplicar `scripts/staging-only/fixture-recovery.sql` nesse projeto pelo MCP
   `apply_migration`, com nome próprio de infraestrutura de homologação.
3. Verificar `staging_audit_recoveries`: RLS e FORCE RLS habilitados, zero
   policies e zero privilégios diretos de anon/authenticated/service_role.
4. Verificar as três RPCs abaixo: SECURITY DEFINER, search_path fixo, execução
   revogada de PUBLIC/anon/authenticated e permitida somente a service_role.
   O proprietário do banco continua podendo operá-las pelo SQL Editor/MCP.
5. Ainda com Auth/organizações vazios, aplicar
   `scripts/staging-only/fixture-server-rights.sql`. BYPASSRLS não concede
   SELECT/INSERT de tabelas: o backend de fixtures precisa desses grants
   explícitos antes do preflight de adendos. O arquivo recusa instalação depois
   das fixtures e verifica que permissões de anon/authenticated, RLS, policies
   e triggers continuam exatamente iguais na mesma transação.
6. Com histórico formal exatamente em 38 entradas e Auth/organizações ainda
   vazios, aplicar `scripts/staging-only/fixture-server-rights-hardening.sql`.
   O primeiro arquivo concede os direitos necessários, mas não elimina direitos
   já existentes. O complemento retira TRUNCATE de todas as tabelas públicas
   regulares/particionadas e normaliza a matriz de treze tabelas abaixo com
   REVOKE ALL seguido de grants mínimos. As pós-condições verificam os oito
   privilégios efetivos de cada alvo, zero TRUNCATE efetivo no catálogo público
   inteiro e preservação de RLS, policies, triggers e direitos dos clientes.
   Se um direito permanecer por herança, a transação inteira falha. Confirmar
   novamente pelo MCP a matriz e zero TRUNCATE antes de criar qualquer fixture;
   a aplicação pelo MCP acrescenta a entrada de infraestrutura número 39.

Direitos mínimos do backend: organizações SELECT/INSERT/UPDATE/DELETE; perfis e
vínculos SELECT/INSERT/UPDATE; privilégio de programador SELECT/INSERT/DELETE;
pacientes, atendimento, pré finalizado, adendos, auditoria, canal legado e
shares somente SELECT. DELETE de organização é exclusivamente o teste da
cascata protegida; nenhuma escrita clínica usa a chave administrativa. Claims
mantêm SELECT/INSERT próprios e recovery não ganha CRUD direto.
REFERENCES, TRIGGER, MAINTAIN e TRUNCATE ficam ausentes nos treze alvos;
o canal pessoal legado não recebe INSERT/UPDATE/DELETE do backend de teste.

Essa matriz é infraestrutura de teste, separada do histórico de produção. O
catálogo da aplicação capturado em 11/10 mostra defaults de produção de
postgres/supabase_admin com privilégios amplos de service_role, inclusive
TRUNCATE/TRIGGER/REFERENCES/MAINTAIN nas tabelas citadas. A matriz de staging é
mais restrita e não copia esses defaults nem altera privilégios futuros.
Ela não prova que as ACLs de produção foram modificadas ou reconciliadas.

```sql
select p.proname, p.prosecdef, p.proconfig,
       has_function_privilege('anon', p.oid, 'EXECUTE') as anon_execute,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated_execute,
       has_function_privilege('service_role', p.oid, 'EXECUTE') as service_execute
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname in (
  'staging_audit_recovery_inventory', 'staging_audit_block_fixture',
  'staging_audit_verify_recovery'
);
```

## Contrato das fixtures

O claim durável deve existir antes do primeiro POST Auth. Cada execução usa um
UUID distinto, máximo quatro identidades e duas organizações. Auth recebe
`app_metadata.synthetic_audit = UUID`. Organizações recebem exatamente
`synthetic-UUID-0` e `synthetic-UUID-1`. Recuperação não aceita prefixos livres,
um UUID como ID de usuário, nomes semelhantes ou inventário global de Auth.

O runner verifica a RPC de inventário antes de criar qualquer conta. Seu
orçamento é 90 segundos de trabalho e 140 segundos totais, reservando tempo
para encerramento. Um timeout/kill do processo continua podendo interromper
finally; a Edge Function de recuperação é um processo independente.

## Preparar e invocar a recuperação

1. Renderizar `scripts/staging-only/fixture-recovery.ts` fora do Git com o UUID
   **da execução original**, uma nova capacidade aleatória e seu SHA-256,
   emissão UTC e expiração de até quinze minutos. Não reaproveitar a capacidade
   do runner. Manter capacidade/JWT em arquivo privado, sem logs ou resultado.
2. Implantar uma Edge Function temporária pelo MCP com `verify_jwt=true`.
   Preservar o TARGET fixo. Credenciais administrativas vêm somente do ambiente
   da função; não obtê-las para o executor, navegador ou cliente.
   Runner e recovery preferem os defaults de `SUPABASE_SECRET_KEYS` e
   `SUPABASE_PUBLISHABLE_KEYS`, com fallback aos nomes legados. Chaves modernas
   `sb_secret_`/`sb_publishable_` vão somente em `apikey`, nunca em Bearer.
   Chamadas administrativas usam a chave administrativa no `apikey`; sessões
   dos usuários mantêm chave pública no `apikey` e JWT do usuário no Bearer.
3. Após `claimed_at + 180 segundos`, invocar uma vez via HTTPS autorizado,
   usando JWT anon público **legado** na gateway, `Content-Type: application/json`,
   capacidade em `x-audit-capability` e corpo contendo somente:

```json
{"runId":"UUID-DA-EXECUCAO-ORIGINAL"}
```

O inventário encontra inclusive Auth/org POST confirmado sem resposta. A RPC
primeiro desativa vínculos, perfis e organizações e remove privilégio de
programador numa transação. Depois a função troca senhas por 68 bytes ASCII e
bane somente os UUIDs encontrados, verificando cada identidade pela API Auth.
Ela nunca cria ou apaga Auth, organizações, prontuários ou auditoria.

Se a recuperação perder a resposta, repetir **a recuperação**, com o mesmo
UUID, é idempotente. Nunca repetir o runner que cria fixtures. Capacidade
expirada exige renderizar uma nova capacidade de recuperação vinculada ao
mesmo UUID; o claim original permanece imutável.

## Shares e verificação final

Shares sintéticas do runner duram dois minutos. A RPC fecha somente as shares
envolvendo as organizações exatas da fixture cuja expiração já ocorreu,
alterando apenas `ativo` e `expirado_em`. O guard original aceita esse caminho
de manutenção e grava auditoria. Nenhum guard ou trigger é alterado, nenhum
usuário é impersonado e nenhum prazo é encurtado pela recuperação.

Uma share criada no limite dos 90 segundos pode expirar apenas após
`claimed_at + 210 segundos`. `pending > 0` nunca é aprovação. Consultar
`inventory.latestActiveShareExpiry` e repetir somente a recuperação depois
desse horário. Shares não expiradas continuam explicitamente pendentes.

Aceitar a recuperação somente com `failed=0`, `pending=0`, UUID/alvo exatos,
todos os contadores de acesso/privilegiados zero e `bannedAuthUsers` igual ao
número de identidades sintéticas. O banco marca `contained_at` depois dessa
verificação de bloqueio Auth; `completed_at` exige também nenhuma share ativa.
Confirmar por metadados a permanência das identidades, registros e auditoria.
Não declarar revogação criptográfica de access JWT: o escopo desativado impede
acesso enquanto esses JWTs ainda não expiraram.

Após capturar os relatórios, substituir ambas as Edge Functions por funções
fechadas ou removê-las. Conservar claims, recuperação e evidências sintéticas.

## Validação local

`node tests/staging-runner-security.mjs` executa também os testes independentes
de recuperação. Cobertura: prazo/alvo/UUID; Auth confirmado sem resposta;
orçamento do runner; isolamento de outra execução; falha e resposta perdida
no ban com repetição idempotente; alteração inesperada do inventário; share
pendente/expirada; falha 503 de Storage sem falsa aprovação de isolamento.
Os mocks não substituem a execução real das RPCs e das APIs na homologação.
O teste usa a matriz extraída do DDL para executar o runner inteiro e também
confirma que SELECT ausente impede o preflight antes de criar Auth. A validação
nativa pelo MCP continua obrigatória para provar os grants efetivos e o catálogo
de triggers/policies do PostgreSQL.
