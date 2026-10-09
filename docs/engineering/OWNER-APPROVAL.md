# Aprovação do proprietário e proteção de main

O chat de 09/10 autorizou implementar a conformidade no branch de teste. Ele não
é substituído por um campo com aparência de autorização nem por uma revisão
emitida pelo agente em nome do proprietário.

O workflow `owner-approval.yml` executa o verificador da base confiável, nunca o
código do diff avaliado. A decisão tem identidade `mpcaliman`, SHA completo e
escopo. Mudança de SHA invalida a aprovação; uma revogação posterior a cancela.
Um comentário do proprietário deve conter somente a decisão exata, por exemplo:

```
SOFT-AUTORIZACAO G4-PR-225 <SHA completo do HEAD avaliado> merge
```

CODEOWNERS mantém o proprietário responsável pelo código. Como o PR225 foi
aberto pela própria conta do proprietário, GitHub não permite que ela aprove
sua própria revisão; por isso a autorização exata é separada da revisão
independente, evitando uma regra impossível de satisfazer.

Esse registro precisa ser publicado pelo proprietário. A implementação não
cria o registro em seu nome. O status é associado ao HEAD do PR, inclusive
quando o evento vem de um comentário. Rascunhos permanecem com autorização
pendente. O workflow precisa existir em `main` para receber eventos confiáveis.

`.github/rulesets/main.json` exige PR, revisão independente, nova aprovação depois
de mudanças, CI e autorização específica; bloqueia exclusão e force push. O
script `scripts/configure-repository-governance.mjs` mostra a configuração sem
alterar o GitHub e aceita `--apply` somente com identidade administrativa do
proprietário. A configuração versionada **não comprova** proteção ativa.

Na leitura do GitHub antes desta implementação, `main` estava sem proteção e
sem ruleset. O conector disponível não oferece gravação administrativa dessas
configurações e o acesso administrativo via CLI não pôde ser confirmado (rede do executor bloqueada).
Portanto, a imposição de merge no servidor continua pendente de aplicação e
verificação da configuração; não pode ser declarada concluída por esses arquivos.

Pages exige disparo manual do proprietário em `main`, SHA atual exato, CI
aprovada e baseline com matriz de homologação autenticada validada. O próprio
evento autenticado com SHA e referência G5 é a evidência dessa autorização de
publicação. O pacote publicado vem exclusivamente de `dist`.
