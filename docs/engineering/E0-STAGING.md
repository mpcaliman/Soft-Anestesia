# E0 — especificação da homologação

## Estado atual

A homologação **não foi criada**. A E0 local apenas prepara os controles; criar projeto, vincular CLI, aplicar migrações ou inserir usuários requer autorização G3 separada.

## Requisitos do futuro ambiente

- Projeto Supabase separado da produção, sem cópia de registros reais.
- Nenhuma credencial ou referência secreta versionada no repositório.
- Reconstrução a partir de migrações versionadas, depois da reconciliação dos históricos SQL.
- Duas organizações sintéticas e isoladas: `clinica-alfa-teste` e `clinica-beta-teste`.
- Quatro usuários sintéticos, dois por organização, cobrindo perfis clínico e administrativo.
- Testes explícitos de RLS, Realtime, conflito simultâneo, troca de usuário no mesmo computador e sincronização após reconexão.
- Logs e evidências sem nome, CPF, e-mail, prontuário ou dado clínico real.

## Critérios para liberar G3

1. Marcelo autoriza o projeto e o portão G3.
2. A baseline SQL está reconciliada sem reescrever o histórico aplicado em produção.
3. O plano de reversão e a matriz de isolamento estão anexados ao cartão.
4. A produção permanece sem qualquer alteração.
