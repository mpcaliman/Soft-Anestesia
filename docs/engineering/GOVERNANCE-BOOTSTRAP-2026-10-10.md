# Bootstrap mínimo da governança — 10 de outubro de 2026

Foi preparado um patch exato de três arquivos para instalar o verificador
confiável de autorização e interromper a publicação automática de Pages. O
patch usa a árvore atual de `main` como base e preserva os hashes de todos os
arquivos clínicos. Foi publicado em branch separada no PR de rascunho
[228](https://github.com/mpcaliman/Soft-Anestesia/pull/228), com commit
`2f2fa71c8d1c14c2fa3b8e88f77e415d6358b0cb`. Não foi integrado ao `main`,
não ativou regras administrativas e não publicou uma versão do site.

A autorização ampla já registrada em
[AUTHORIZATIONS.md](AUTHORIZATIONS.md) permite continuar o processo. Ela não
cria uma identidade administrativa, uma revisão humana independente ou o
comentário autenticado que o verificador exige. Este documento não registra
nenhuma dessas ações como realizada.

## Evidência obtida por GET no conector GitHub

Consulta em **2026-10-10 00:36:42 UTC**, sem credenciais locais nem acesso de rede
por comandos do executor:

| Item | Evidência |
| --- | --- |
| Repositório | `mpcaliman/Soft-Anestesia` |
| `main` | `634f9e2ccfe86ec0174b845526b0f9f70159db34` |
| Árvore da base | `4f884ee5159b6829650d326bb8127fd8df85e944` |
| Proteção e rulesets | `protected: false`; coleção de rulesets vazia |
| PR 225 | Rascunho; autor `mpcaliman`; base igual ao SHA acima |
| Fonte revisada do PR 225 | `ad6f4b37c0f239619515b677bd1bef21227c28fc` |
| Pages em `main` | `push` em `main` e `workflow_dispatch`; upload de `.`; blob `c1feb9acf2bb6f9391cadc384d977a341c22bc4e` |
| CI em `main` | Workflow `Testes (smoke)`, job `smoke`; ainda não produz `validate` |
| Workflow de autorização e verificador em `main` | Ausentes, confirmados pelas árvores de `.github/workflows` e `scripts` |
| `.nvmrc` em `main` | Ausente, confirmado pela árvore raiz |

As consultas foram limitadas à configuração de governança, metadados de
árvores, workflows e estado do PR. Os hashes dos arquivos clínicos foram
preservados como referências; seus conteúdos não foram lidos. As árvores
consultadas não estavam truncadas. O gerador reproduz seus quatro hashes
antes de preparar a proposta:

- [Raiz da base](https://api.github.com/repos/mpcaliman/Soft-Anestesia/git/trees/4f884ee5159b6829650d326bb8127fd8df85e944)
- [`.github`](https://api.github.com/repos/mpcaliman/Soft-Anestesia/git/trees/ab9fa0180246d602b4593b9c1665049c3e579015)
- [`.github/workflows`](https://api.github.com/repos/mpcaliman/Soft-Anestesia/git/trees/837aa65e2e32e10340399f93ad11da9a94025ba5)
- [`scripts`](https://api.github.com/repos/mpcaliman/Soft-Anestesia/git/trees/29e5bc4631f389689f10022b7a61d41a73f5db5b)
- [Pages no SHA exato da base](https://api.github.com/repos/mpcaliman/Soft-Anestesia/contents/.github/workflows/pages.yml?ref=634f9e2ccfe86ec0174b845526b0f9f70159db34)

## Artefato concreto para revisão

O gerador [prepare-governance-bootstrap.mjs](../../scripts/prepare-governance-bootstrap.mjs)
é local e sem rede. Não lê tokens, não executa código da aplicação, não instala
dependências e não escreve refs, índice ou objetos Git. Ele só lê três blobs
fixados do commit fonte e grava um diretório novo fora do checkout. Os bytes
antigos de Pages e os metadados completos necessários para fechar a árvore
estão fixados no gerador; a árvore da base não precisa existir no clone local.

```bash
node scripts/prepare-governance-bootstrap.mjs --output /tmp/governance-bootstrap-2026-10-10
```

O diretório foi gerado e verificado nesta execução. Uma reprodução deve usar
outro diretório vazio, pois o comando recusa sobrescrever resultados existentes.

| Arquivo da proposta | Alteração | Blob Git resultante |
| --- | --- | --- |
| `.github/workflows/owner-approval.yml` | Adicionar workflow confiável de autorização | `85f75bc880fa85a74f9e7cd3ca095cfa04090020` |
| `.github/workflows/pages.yml` | Substituir publicação automática por bloqueio explícito | `5069f170b5afca5a2f7ce741d07af284af3be010` |
| `scripts/verify-owner-authorization.mjs` | Adicionar verificador independente do código clínico | `c22e94a955793cd5e4c02f2069ba8d0a9c02c0d6` |

O resultado inclui:

- `bootstrap.patch`: diff integral e exato dos três arquivos acima.
- `files/`: bytes novos de cada arquivo para revisão ou aplicação manual.
- `manifest.json`: SHA da base/fonte, hashes SHA-256, blobs Git, evidência da
  base e todos os metadados das quatro árvores alteradas.
- `temporary-main-ruleset.json`: regras administrativas iniciais, sem checks
  ainda indisponíveis na base.
- `main-ruleset-after-bootstrap.json`: ruleset completo proposto no PR 225.

**SHA-256 do patch:**
`2e734eb5f5dd625048dea519d0abc012a4a4ae2494db85ad99a0cf92ba83290b`.

**Árvore Git fechada proposta:**
`5cfde92dfa23a9458a50df854b979a90356bc20c`.

O SHA da árvore é calculado pelos bytes canônicos de objetos Git, sem gravá-los
na base de objetos. Ele representa exatamente a substituição dos três arquivos
na árvore fixada de `main`. O manifesto original registra `newCommitSha: null`
por descrever a preparação anterior à publicação. A criação posterior do
commit no GitHub confirmou a mesma árvore; seu SHA está no início deste
documento. Documentos, gerador, manifesto e JSON administrativo ficaram fora
desse commit mínimo.

## Decisões da proposta mínima

O workflow de autorização deriva do blob fonte
`523cc3e6a58e980866ceb78561a8b2f9bdbf3ccc`. Continua carregando o verificador do
SHA da base confiável, sem executar o HEAD do PR e sem persistir credenciais.
O único runtime necessário é Node, agora fixado explicitamente em `24.19.0`,
a versão de `.nvmrc` no commit fonte. Isso remove a dependência de um arquivo
inexistente em `main`. As execuções são serializadas por número de PR para
impedir que verificações concorrentes terminem sobrescrevendo uma revogação
mais recente com um status antigo de sucesso.

O verificador deriva do blob fonte
`ac7127c9631f5a19c07cec77efa4bd211e487ba0`. Usa somente módulos nativos de Node e
`fetch`, sem pacote npm ou arquivo da aplicação. A proposta acrescenta duas
correções pequenas: revogação vence aprovação quando os horários empatarem
na precisão de segundos do GitHub; os únicos escopos aceitos são propriedades
próprias do mapa de portões. Identidade, SHA completo, escopo, referência,
paginação e invalidação por revogação seguem obrigatórios.

O Pages completo do PR 225 depende de arquivos de build, lockfile, `.nvmrc`,
baseline de migrações, pacote `dist`, CI `validate` e homologação autenticada
que ainda não foram integrados à base. Copiá-lo isoladamente produziria um
workflow incompleto. Por isso o bootstrap usa um stub que só aceita
`workflow_dispatch`, não pede permissões, não faz checkout, não cria artefato,
não tem job de deploy e sempre termina com falha explícita. O stub serve como
bloqueio verificável até a integração do workflow completo.

As correções do verificador e a serialização devem ser preservadas quando o
PR 225 absorver o bootstrap. Uma resolução de conflito que restaure os blobs
antigos do PR perderia essas correções.

## Ordem administrativa de ativação

Estas são ações futuras do proprietário/administrador no GitHub. O conector
ativo oferece GET e ações de PR, mas não configuração administrativa de
rulesets, desativação de workflow nem despacho arbitrário de Actions. Nenhuma
ação administrativa abaixo foi executada nesta preparação.

1. **Conter Pages antes de qualquer merge.** No GitHub Actions, selecionar o
   workflow antigo `Publicar no GitHub Pages`, desativá-lo e cancelar suas
   execuções pendentes ou em andamento. Em Settings → Pages, confirmar que a
   origem é GitHub Actions; se estiver configurada publicação por branch,
   suspender essa origem antes de avançar. Desativar o workflow não apaga uma
   versão pública já existente. Manter a publicação desativada até que o
   workflow completo e seus portões estejam prontos.
2. **Revalidar a base.** Consultar novamente `main` e confirmar o SHA
   `634f9e2ccfe86ec0174b845526b0f9f70159db34`. Se mudou, regenerar e revisar uma
   proposta para a nova árvore; não aplicar este patch como se fosse atual.
3. **Instalar o ruleset inicial.** Em Settings → Rules → Rulesets, importar
   `temporary-main-ruleset.json` e confirmar enforcement `active`, destino
   somente `refs/heads/main` e nenhum ator de bypass. Ele impede exclusão e
   force push; exige PR, uma revisão aprovada, descarte de revisão antiga,
   aprovação depois do último push e resolução das discussões. Não exige
   `Autorização G4 do proprietário` nem `validate` durante a instalação
   inicial. Importar o ruleset completo neste ponto bloquearia o próprio
   bootstrap: o workflow confiável ainda não existe na base.
4. **Revisar o PR separado, sem código clínico.** O PR 228 já está publicado
   na branch `codex/governance-bootstrap-20261010`, usando somente os três
   caminhos de `bootstrap.patch`. Antes de
   aprovar, conferir que a árvore do commit é
   `5cfde92dfa23a9458a50df854b979a90356bc20c`; qualquer outro arquivo exige nova
   revisão da proposta. O antigo check `smoke` deve passar no PR inicial.
5. **Registrar decisões reais sobre o SHA final.** O proprietário deve revisar
   o diff e publicar, de sua própria conta, o comentário exato abaixo, usando
   o número desse novo PR e o SHA completo de seu HEAD. Uma outra pessoa com
   permissão de escrita deve realizar a revisão GitHub aprovada, depois do
   último push, e resolver as discussões. A conta `mpcaliman` é autora do PR
   225 e não pode aprovar a própria revisão; um comentário de autorização
   não substitui a revisão independente. Se não houver outro revisor habilitado,
   a instalação fica pendente até disponibilizar um; não registrar revisão
   fictícia nem cadastrar bypass.
6. **Mesclar apenas o bootstrap.** O novo `pull_request_target` não consegue
   validar o próprio PR inicial antes de existir em `main`. Essa instalação
   usa a revisão humana e o registro real do proprietário sob o ruleset
   inicial, sem fabricar o status ausente. Após o merge, conferir os três
   arquivos em `main`, verificar a nova árvore e confirmar que Pages não
   publicou nada no push.
7. **Atualizar e verificar o PR 225.** Incorporar a nova base ao branch de
   remediação, resolver os conflitos de governança preservando as correções
   descritas acima e reexecutar os checks no novo HEAD. O evento
   `synchronize` deve carregar o verificador já confiável de `main`. Enquanto
   o PR for rascunho, o status G4 deve ser `pending`. Confirmar que o status
   foi publicado no HEAD real, e que `validate` também existe nesse HEAD.
8. **Ativar o ruleset completo depois de observar os contextos.** Atualizar o
   mesmo ruleset pelo conteúdo de `main-ruleset-after-bootstrap.json`, com os
   dois status e sua origem GitHub Actions. Consultar novamente a configuração
   para comprovar enforcement `active`, ausência de bypass e regras completas.
   Não confundir o arquivo versionado com proteção remota efetiva.
9. **Concluir os portões do PR 225.** A homologação real continua necessária.
   Após seu resultado aprovado, marcar o PR como pronto, obter revisão humana
   independente válida e comentário do proprietário para o HEAD final. Só
   mesclar quando os checks requeridos forem aprovados e a base estiver atual.
   Mudança de SHA exige nova autorização e nova revisão; o comentário inicial
   do bootstrap não autoriza o PR 225.
10. **Habilitar publicação completa por último.** Depois de integrar o workflow
    completo, confirmar CI de `push` aprovada no SHA atual de `main`, baseline
    `staging_verified` e evidência de homologação autenticada. Só então
    reabilitar o workflow e despachá-lo pela conta `mpcaliman`, com o SHA
    completo de `main` e referência G5 explícita. Conferir execução, artefato
    `dist` e versão pública. Esta preparação não realizou despacho nem deploy.

Registro da autorização do proprietário no PR 228, após revisar o diff:

```text
SOFT-AUTORIZACAO G4-PR-228 2f2fa71c8d1c14c2fa3b8e88f77e415d6358b0cb merge
```

O texto acima é uma instrução, não evidência de autorização já publicada.
O verificador aceita somente a linha concreta, sem texto adicional, emitida por `mpcaliman`
no PR correspondente. Não utilizar o SHA da árvore ou o SHA do commit fonte
como substitutos do HEAD efetivamente revisado.

## Nomes exatos dos checks

| Momento | Contexto | Exigência |
| --- | --- | --- |
| Bootstrap inicial | `smoke` | CI herdada da base; verificar sucesso antes de mesclar |
| Ruleset completo | `validate` | Requerido; origem GitHub Actions, integration ID `15368` |
| Ruleset completo | `Autorização G4 do proprietário` | Requerido; status no HEAD real, origem GitHub Actions, integration ID `15368` |
| PR de remediação | `sql-local` | Verificação SQL separada; não consta como requerida neste ruleset |
| Workflow de autorização | `Verificar autorização registrada` | Nome do job; não substituir o contexto G4 por esse nome |

O ruleset completo exige a branch atualizada em relação à base. Os resultados
anteriores de CI do commit `ad6f4b37…` não validam automaticamente o novo HEAD
depois do bootstrap. Um status G4 `pending` em rascunho demonstra que o emissor
está instalado; não permite merge.

## Verificação local realizada

- Sintaxe Node do gerador e do verificador aprovadas.
- Regressões existentes de autorização executadas contra o verificador gerado:
  identidade, SHA, escopo, formato exato, revogação, rejeição de revisão como
  substituto de comentário e ausência de autorização aprovados.
- Casos sintéticos adicionais para empate de revogação, escopos herdados e fluxo
  de leitura GitHub com `fetch` simulado aprovados; nenhuma chamada de rede.
- YAML dos dois workflows carregado; stub manual sem permissões e sem ações
  de upload/deploy, referência de checkout confiável, ausência de credenciais
  persistentes, pin de Node e serialização conferidos.
- SHA-256 dos três arquivos e do patch conferidos. Metadados antigos reproduzem
  os hashes das quatro árvores consultadas; metadados novos fecham a árvore
  proposta com apenas os três caminhos de governança.
- `git apply --check` e aplicação do patch aprovados em diretório descartável
  contendo somente os bytes antigos de Pages; resultado igual a `files/`.

Não foi executada CI remota do bootstrap, pois não existe branch/commit remoto
para ele. Estes checks locais não comprovam proteção administrativa, revisão
independente, homologação autenticada ou publicação. Não houve escrita em
`main`, PR, comentário, revisão, ruleset, workflow remoto ou Pages.
