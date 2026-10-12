# Pendências para concluir a auditoria — 10 de outubro de 2026

A autorização “Pode fazer tudo” permanece válida. O impedimento atual é a
execução remota e a imposição dos controles de produção. Nenhuma alteração
desta execução foi aplicada ao banco de produção ou integrada ao `main`.

## Evidência confirmada

- PR [225](https://github.com/mpcaliman/Soft-Anestesia/pull/225): correções de
  aplicação e SQL. No commit `ad6f4b37c0f239619515b677bd1bef21227c28fc`, os
  quatro workflows terminaram com sucesso: `38005962942`, `38005966667`,
  `38005962961`, `38005966715`. Foram verificados 256 smoke tests, os checks
  de segurança, navegador Chromium e integração SQL local com corrida real.
  Esses resultados não provam Auth, RLS, Realtime e Storage hospedados.
- PR [228](https://github.com/mpcaliman/Soft-Anestesia/pull/228): bootstrap de
  governança, HEAD `2f2fa71c8d1c14c2fa3b8e88f77e415d6358b0cb`, exatamente três
  arquivos e árvore `5cfde92dfa23a9458a50df854b979a90356bc20c`. Proposta revisada
  localmente, ainda em rascunho; CI herdada inicialmente em andamento.
- Homologação `yqqrfgbvoexricjdxpis`: 19 migrações novas, `0001`–`0019`, mais
  `0001_assinaturas` preservada. A `0019` está na versão `20261010002555`;
  histórico de 20 entradas e guardas de versão/organização conferidos.
- `0020`: retornou `Invalid or expired requestState` e não consta no histórico
  verificado às 00:42:32 UTC. As aplicações foram interrompidas.
- Nova coleta completa de metadados de produção: uma única consulta SELECT
  de catálogos ficou pendente e foi abortada sem resultado. Nenhum metadata
  novo foi capturado, e nenhum conteúdo clínico foi consultado. O catálogo
  parcial de 9/10 continua sendo a única evidência disponível dessa coleta.

## Ordem de resolução

1. **Restabelecer o canal de execução Supabase.** Verificar conexão, escopo
   de alteração e suporte a confirmações SQL no cliente. O erro observado
   não determina sozinho qual desses mecanismos falhou. Não desligar
   proteções, insistir em chamadas iguais ou inferir sucesso de timeout.
   Persistindo a falha do conector, usar uma execução normal do Supabase CLI
   com rede autorizada e credenciais provisionadas em armazenamento seguro,
   mantendo alvo, hashes, histórico e conferência independente. Não enviar
   tokens ou senhas pelo chat. [Referência oficial de confirmações SQL](https://supabase.com/docs/guides/troubleshooting/sql-confirmations-do-not-appear-in-your-mcp-client-sQf7Kp).
2. **Concluir a prova de homologação.** Capturar as definições reais ainda
   ausentes, incluindo o canal legado, sem prontuários; reconciliar a baseline;
   aplicar `0020`–`0032` e endurecimento de assinaturas na homologação; executar
   testes com contas sintéticas reais e evidência verificável. O runner
   preparado ainda não foi publicado nem executado. O MCP oferece deployment,
   mas não invocação: a chamada HTTP exige um canal de rede permitido, JWT
   público apropriado e capacidade efêmera, sem expor `service_role`.
3. **Instalar governança antes de integrar correções.** Administrador desativa
   Pages automático, cancela execuções antigas e verifica a origem de Pages;
   aplica regras iniciais, obtém revisão humana independente e registra a
   autorização já concedida para o HEAD do PR 228. O conector GitHub instalado
   não possui administração de rulesets nem dispatch de Actions. Depois do
   bootstrap, atualizar PR 225, revalidar CI e observar os contextos de
   autorização antes de ativar o ruleset completo. Instruções e diff exato:
   [GOVERNANCE-BOOTSTRAP-2026-10-10.md](GOVERNANCE-BOOTSTRAP-2026-10-10.md).
4. **Aplicar e publicar somente com evidência completa.** Rever a diferença
   específica de produção, preservar o histórico e o acervo legado, registrar
   aprovação nas identidades reais e fazer publicação manual. Não mesclar
   automaticamente o branch Supabase sobre a produção.

A recuperação temporária que permitiu aplicar `0019` não demonstra que o
conector está estável. Os checks locais e o PR de governança estão preparados;
produção e conformidade integral continuam pendentes das etapas acima.
