# Ativação da governança — estado verificado em 9 de outubro de 2026

O proprietário autorizou a continuidade integral do trabalho com a mensagem
“Pode fazer tudo”, após receber o resultado do branch de teste e as pendências
de homologação e governança. Essa autorização permite executar o processo;
ela não fornece uma credencial administrativa, não substitui evidências de
homologação e não significa que a produção tenha sido publicada.

## Evidência remota obtida em consultas somente de leitura

| Item | Resultado observado |
| --- | --- |
| Repositório | `mpcaliman/Soft-Anestesia` |
| `main` | `634f9e2ccfe86ec0174b845526b0f9f70159db34` |
| Proteção de `main` | `protected: false` |
| Rulesets | coleção vazia |
| PR | [225](https://github.com/mpcaliman/Soft-Anestesia/pull/225), aberto e em rascunho |
| HEAD do PR | `13793124d1df0028f84ca382e7418f2ecd710191` |
| Base do PR | `634f9e2ccfe86ec0174b845526b0f9f70159db34` |
| Mesclabilidade | `mergeable: true`, `mergeable_state: clean` |
| Revisões do PR | nenhuma |
| Comentários do PR | nenhum |

Esses resultados descrevem o instante da consulta. Um novo commit ou alteração
administrativa exige nova leitura antes de agir.

## Capacidades e limites do ambiente

O conector GitHub disponível oferece leitura de branches e rulesets e ações
específicas de PR, incluindo marcar como pronto e mesclar. O catálogo ativo não
oferece criação ou atualização administrativa de rulesets, proteção de branch,
configuração de ambiente de publicação nem despacho arbitrário de workflow.
O `github_fetch` aceita somente GET e sua documentação informa que conexões
gerenciadas de GitHub App não incluem acesso de administração.

O estado observado do ambiente gerenciado informou conectividade ativa,
observações atuais e política HTTP `unrestricted` aplicada. As listas de
credenciais configuradas, variáveis de runtime e identidades de saída estavam
vazias. A verificação local registrou somente a presença booleana de `GH_TOKEN`;
nenhum valor de credencial foi lido ou publicado. Essa presença não comprova
validade do token, identidade do proprietário nem permissão administrativa.

Uma tentativa local de leitura normal dos endpoints GitHub `user` e do
repositório falhou antes da resposta HTTP com `PermissionError`, errno 1,
`Operation not permitted`. A tentativa posterior com permissão adicional de
rede permaneceu pendente e foi abortada pelo usuário, sem resultado de
autenticação. Não há evidência de HTTP 200, 401 ou 403 para essa credencial e
não foi realizada nenhuma operação administrativa.

Não foram modificados a política de rede, o proxy, as credenciais, as permissões
do repositório, o estado do PR, comentários, revisões ou a branch de produção
durante esta investigação.

## Controles já preparados no branch

- `.github/rulesets/main.json` exige PR, uma revisão independente, resolução de
  discussões, nova aprovação após o último push e os status `validate` e
  `Autorização G4 do proprietário`. Não contém atores de bypass; impede
  exclusão e force push de `main`.
- `.github/CODEOWNERS` identifica `@mpcaliman` como proprietário do código.
- `scripts/configure-repository-governance.mjs` apresenta a proposta sem
  alteração por padrão. Seu modo `--apply` exige identidade `mpcaliman` e
  permissão `admin`; depois consulta novamente o ruleset para confirmar que
  ficou ativo. Esse modo não foi executado.
- `.github/workflows/owner-approval.yml` lê o verificador da base confiável e
  publica autorização no HEAD real do PR. A decisão exige um comentário
  autenticado do proprietário com SHA e escopo exatos; revogação posterior e
  mudança de SHA invalidam a evidência.
- `.github/workflows/pages.yml` permite publicação manual pelo proprietário,
  apenas do SHA atual de `main`, após CI de push aprovada, baseline
  `staging_verified` e evidência real de sessões autenticadas. Publica somente
  `dist`.

O workflow confiável de autorização ainda não está em `main`. Ativar agora um
ruleset que exija seu status, antes de resolver a instalação inicial desse
workflow, pode bloquear o próprio PR 225. Isso precisa ser tratado como
instalação inicial explícita, sem inventar status ou registrar aprovação em
nome do proprietário.

## Caminho de ativação e bloqueadores

1. Concluir a reconciliação de staging e a matriz real de Auth, RLS, escrita,
   concorrência, Realtime, Storage e recuperação. Atualizar a baseline somente
   com resultados observados, sem transformar testes simulados em homologação.
2. Revalidar HEAD do PR, base, testes, mudanças de produção e evidência da
   autorização existente. Registrar a autorização desta sessão como tal;
   não convertê-la em comentário GitHub ou revisão independente fictícios.
3. Resolver a instalação inicial dos workflows confiáveis por um caminho
   administrativo real e rastreável. Confirmar que o revisor exigido é outra
   identidade habilitada, pois uma revisão do próprio autor não satisfaz a
   revisão independente proposta.
4. Aplicar o ruleset por identidade administrativa válida e conferir a resposta
   remota. O conector atual não oferece essa capacidade. A credencial local
   permanece não verificada; portanto, a proteção remota continua pendente.
5. Mesclar somente após os requisitos anteriores e a validação do commit final.
   Reexecutar a CI em `main` e confirmar o SHA antes da publicação.
6. Despachar a publicação pelo proprietário ou por uma capacidade explicitamente
   disponível que preserve a identidade e os controles do workflow. O catálogo
   atual não fornece o despacho; não trocar o workflow por publicação
   automática para contornar esse limite.
7. Confirmar a versão pública e o comportamento de produção com verificações
   adequadas, sem usar prontuários identificáveis como fixtures.

Os bloqueadores observados são a homologação real ainda incompleta, a ausência
de administração remota comprovada, a instalação inicial do workflow de
autorização, a revisão independente ainda ausente e a falta de capacidade
disponível para despachar a publicação. A autorização ampla do proprietário
está registrada; pedir novamente essa mesma autorização não resolve esses
limites técnicos.
