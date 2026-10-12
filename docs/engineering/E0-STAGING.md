# E0 — especificação da homologação

> **Atualização de estado — 9 de outubro de 2026.** O corpo abaixo é um
> retrato histórico e não representa o estado atual da execução. A branch de
> teste foi publicada no PR [225](https://github.com/mpcaliman/Soft-Anestesia/pull/225).
> A homologação registra 16 novas migrações (`0001`–`0013` e `0015`–`0017`),
> além da pré-existente `0001_assinaturas`; `0014` foi recusada e `0018`–`0031`
> permanecem ausentes. O runner de integração real não foi implantado nem
> executado. A proteção remota de `main` permanece inativa; os controles
> propostos no branch ainda não demonstram sua imposição em produção. Consulte
> [o estado atual da homologação](STAGING-REBUILD-PLAN.md) e
> [a evidência das migrações](STAGING-MIGRATION-EVIDENCE.json). Nenhum SQL desta
> execução foi enviado à produção. A reconstrução está parcial e interrompida.

## Retrato histórico preservado

## Estado atual

A homologação **ainda não foi identificada nem criada**. O portão G3 foi
autorizado explicitamente em 2026-10-08, condicionado ao sucesso de G2 e à
confirmação do projeto/ref exato. Nenhuma migração pode ser aplicada a um alvo
inferido, e a produção permanece fora desta etapa.

## Requisitos do futuro ambiente

- Projeto Supabase separado da produção, sem cópia de registros reais.
- Nenhuma credencial ou referência secreta versionada no repositório.
- Reconstrução a partir de migrações versionadas, depois da reconciliação dos históricos SQL.
- Duas organizações sintéticas e isoladas: `clinica-alfa-teste` e `clinica-beta-teste`.
- Quatro usuários sintéticos, dois por organização, cobrindo perfis clínico e administrativo.
- Testes explícitos de RLS, Realtime, conflito simultâneo, troca de usuário no mesmo computador e sincronização após reconexão.
- Fechar e reabrir o navegador deve exigir nova autenticação; token Supabase e
  sessão diária não podem existir em `localStorage`.
- Verificação de que registros já confirmados não permanecem em `localStorage`
  ou IndexedDB; somente operações offline e snapshots de recuperação não
  salvos, todos cifrados, podem ficar no aparelho.
- Queda de rede durante criação, edição, exclusão e adendo; em todos os casos a
  volta da conexão deve drenar automaticamente o mesmo UUID, sem duplicar.
- Dois usuários fechando o mesmo caixa diário: nenhuma versão pode sobrescrever
  silenciosamente a outra e a decisão deve atualizar a tela Financeiro.
- Logs e evidências sem nome, CPF, e-mail, prontuário ou dado clínico real.

## Critérios para liberar G3

1. Marcelo já autorizou o portão G3; ainda é obrigatório identificar e
   confirmar o projeto/ref de homologação exato antes do vínculo.
2. A baseline SQL está reconciliada sem reescrever o histórico aplicado em produção.
3. O plano de reversão e a matriz de isolamento estão anexados ao cartão.
4. A produção permanece sem qualquer alteração.
