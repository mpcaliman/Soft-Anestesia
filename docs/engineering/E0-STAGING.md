# E0 — especificação da homologação

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
