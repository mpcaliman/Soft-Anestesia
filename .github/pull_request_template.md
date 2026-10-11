## Cartão e autorização

- Cartão técnico:
- Escopo autorizado por Marcelo:
- Itens explicitamente fora do escopo:

## Regras de Ouro

- [ ] Preserva edição simultânea e integração Realtime.
- [ ] Mantém cada dado isolado no ambiente/organização correto.
- [ ] Esta modificação foi autorizada antes da implementação.
- [ ] Mantém nuvem como fonte principal e sincronização automática após offline.
- [ ] Funciona com vários usuários no mesmo computador, sem misturar sessões.

## Segurança e dados

- [ ] Não contém dados reais de pacientes, credenciais ou segredos.
- [ ] Alterações de banco estão em migração versionada e foram testadas fora da produção.
- [ ] Não executa DDL, seed ou função remota na produção.
- [ ] O pacote publicado contém somente artefatos públicos do `dist/`.

## Validação

- [ ] `npm ci`
- [ ] `npm run test:ci`
- [ ] Evidências e riscos residuais documentados abaixo.

## Portões posteriores

- [ ] Push/PR autorizado.
- [ ] Homologação/Supabase remoto autorizado.
- [ ] Merge autorizado.
- [ ] Deploy em produção autorizado.

Evidências, observações e plano de reversão:
