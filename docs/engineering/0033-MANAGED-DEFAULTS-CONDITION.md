# Condição de aplicação da 0033

A primeira candidata falhou em homologação com `42501`: o papel `postgres`
não é superuser nem membro autorizado de `supabase_admin`, portanto não pode
alterar os defaults desse papel interno. A falha não autoriza elevar o papel,
trocar owners ou tratar a candidata como aplicada. Sua aplicação e o rollback
devem ser confirmados pelo histórico e pelo catálogo de homologação.

A candidata revisada revoga direitos atuais de TRUNCATE em tabelas public/app,
direitos de clientes nas sequências legadas e a execução do autoprovisionamento
existente. Preserva todos os direitos CRUD atuais de `service_role`. Fecha os
defaults globais e de public/app do executor da aplicação, `postgres`, para
PUBLIC, anon, authenticated e service_role. Cada objeto novo desse executor
exigirá grants explícitos acompanhados de autorização e RLS.

Os defaults de `supabase_admin` ficam **preservados e pendentes do fornecedor**.
A migração compara suas linhas de catálogo antes/depois e falha se mudarem.
Os relatórios precisam registrar separadamente:

- `applicationExecutor: postgres`;
- `applicationExecutorDefaultsClosed: true` apenas depois dos probes reais;
- `managedAdminDefaultsClosed: false`;
- `managedAdminDefaultsPreserved: true` apenas depois da comparação por hash;
- `universalCreatorDefaultsClosed: false`;
- a autoridade efetiva observada para alterar defaults de Admin, sem simulá-la.

O preflight exige que os objetos da aplicação public/app sejam de `postgres`
e que anon/authenticated/service_role não tenham acesso herdado ou SET ROLE
ao papel interno Admin. Não modifica memberships, owners, RLS ou managed schemas.
Um objeto ou criador fora do contrato causa falha transacional e requer revisão.

Essa pendência não concede acesso a dados atuais por si só. Ela permite que
objetos futuros criados pelo papel interno recebam os defaults ainda amplos.
A liberação da aplicação só pode assumir o escopo restrito comprovado: toda
DDL da aplicação nasce em migração aprovada executada como `postgres`; gates
de catálogo verificam owners e privilégios antes de cada publicação e recusam
drift. O operador da aplicação não deve criar objetos public/app como Admin.

Essa condição operacional não bloqueia a versão por si só quando comprovada
e declarada. Ela bloqueia qualquer afirmação de que todos os criadores foram
fechados ou de que criações futuras arbitrárias pelo fornecedor são cobertas.
Uma exigência de fechamento universal requer intervenção do fornecedor ou
outro desenho aprovado, e permanece pendente até essa evidência existir.

A migração é transacional. Nenhuma exceção de permissão é absorvida: falha em
preflight, REVOKE ou pós-condição aborta sem conservar mudanças parciais.
O rollback de segurança não deve restaurar TRUNCATE, sequência de clientes ou
autoprovisionamento. Uma correção posterior é uma nova migração revisável.

Validação necessária antes da liberação: ensaio local fiel como postgres,
probes reais de objetos futuros postgres em public/app, preservação dos
defaults Admin por hash, catálogo de homologação e testes hospedados das
operações atuais. Navegador/crash e expiração natural de JWT continuam sendo
verificações independentes; a 0033 não as substitui.
