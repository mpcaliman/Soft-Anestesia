# Fechamento local da auditoria técnica

> **Atualização de estado — 10 de outubro de 2026.** O corpo abaixo é um
> retrato histórico e não representa o estado atual da execução. A branch de
> teste foi publicada no PR [225](https://github.com/mpcaliman/Soft-Anestesia/pull/225).
> A homologação registra 19 novas migrações (`0001`–`0019`),
> além da pré-existente `0001_assinaturas`; a aplicação de `0019` superou o
> bloqueio anterior e foi conferida no histórico e no catálogo. `0020` falhou
> por estado inválido ou expirado do conector e continua ausente, assim como
> as migrações posteriores.
> O runner de integração real não foi implantado nem
> executado. A proteção remota de `main` permanece inativa; os controles
> propostos no branch ainda não demonstram sua imposição em produção. Consulte
> [o estado atual da homologação](STAGING-REBUILD-PLAN.md) e
> [a evidência das migrações](STAGING-MIGRATION-EVIDENCE.json). Nenhum SQL desta
> execução foi enviado à produção. A reconstrução está parcial e interrompida.

## Retrato histórico preservado

Data: 2026-10-08  
Branch: `codex/audit-remediation-v2`

## Resultado

O escopo técnico executável localmente da auditoria foi concluído. Os portões
G2–G6 foram autorizados em sequência em 2026-10-08, mas isso não é evidência de
produção: nenhuma branch foi publicada, nenhuma migração foi aplicada a
Supabase remoto e nenhum deploy foi feito neste fechamento local.

## Regras de ouro verificadas no código

| Regra | Implementação local |
|---|---|
| Edição simultânea | compare-and-swap por `version`, conflito durável com os dois lados e Realtime sem sobrescrita silenciosa |
| Isolamento por ambiente | contexto imutável por aba, `organization_id` obrigatório, RLS e filas vinculadas a clínica + usuário + dispositivo |
| Autorização de mudança | portões G0–G6 documentados; G2–G6 agora estão autorizados sequencialmente, sem permissão para pular evidências ou adivinhar o alvo remoto |
| Nuvem e offline | Supabase é a fonte canônica; confirmado fica apenas na nuvem/memória; operações e recuperação de texto não salvo ficam cifradas em AES-GCM e reenviam automaticamente |
| Computador multiusuário | token e sessão vivem somente na aba; bloqueio por inatividade é obrigatório; memória, rascunho, fila, anexos e conflitos são isolados; troca de contexto limpa a visão sem apagar trabalho pendente do dono anterior |

## Fechamentos deste incremento

- feedback de sucesso condicionado a recibo remoto verificável;
- cache clínico confirmado removido do armazenamento durável do navegador;
- restauração “1× por dia”, token persistente e exceção de aparelho pessoal
  removidos; conta sem clínica acessa apenas Ajustes até obter `organization_id`;
- caixa diário incorporado ao motor relacional versionado;
- adendos append-only protegidos no WAL cifrado antes do envio;
- rascunhos e edição ainda não salva usam snapshots AES-GCM por
  clínica/usuário/dispositivo; lápides cifradas impedem que um recibo tardio
  apague caracteres digitados depois do clique;
- restaurar da lixeira agora é uma operação cloud-first causal, com WAL,
  compare-and-swap, recibo idempotente e reversão efetiva de `deleted_at`;
- pacientes, agenda, documentos, prescrições, orçamentos, caixa, adendos,
  rascunhos e conflitos cobertos pela publicação Realtime preparada em `0027`;
- testes de segurança ampliados para cloud-only, recibo de adendo, conflito,
  isolamento de aba, sessão por aba, computador compartilhado e reconciliação
  offline.

## Evidência necessária fora do repositório

Estas etapas não podem ser concluídas por teste local. Estão autorizadas em
sequência, mas cada uma continua condicionada à evidência da anterior:

1. **G2:** publicar a branch e abrir/revisar o PR;
2. **G3:** identificar explicitamente o projeto Supabase de homologação,
   reconciliar os dois históricos SQL e criar/reconstruir homologação vazia;
3. aplicar `0018`–`0027` somente na homologação autorizada;
4. executar matriz RLS com duas clínicas e múltiplos papéis;
5. testar duas sessões reais, Realtime, conflito, queda/reconexão e troca de
   usuário no mesmo computador;
6. inventariar e classificar manualmente o acervo legado, sem inferir clínica;
7. somente após evidências aprovadas: G4 merge, G5 deploy e G6 confirmação de produção.

Privacidade, termos, suporte, cobrança, observabilidade operacional e a escolha
PWA/TWA/híbrido permanecem no estágio comercial F1e; não devem ser declarados
prontos apenas porque o núcleo técnico local foi corrigido.
