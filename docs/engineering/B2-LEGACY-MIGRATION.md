# B2 — execução segura do acervo legado

## Estado deste cartão

A infraestrutura foi implementada e testada localmente sob G1. A migração
`0024_legacy_quarantine_migration.sql` **não foi aplicada a nenhum Supabase** e
nenhuma das 1.075 linhas reais foi lida, classificada ou movida.

Aplicar a `0024`, inventariar dados reais ou fazer uma classificação exige G3
explícito e ambiente de homologação reconciliado. Produção continua bloqueada.

## Invariantes

1. `public.documentos` é fonte congelada: não recebe `UPDATE`, `DELETE` nem
   permissão direta para `anon`/`authenticated`.
2. Uma associação exige IDs explícitos, organização sem valor padrão,
   programador autenticado e justificativa. Quantidade de clínicas atuais do
   usuário nunca é prova histórica.
3. Inventário e relatórios não armazenam nem retornam `dados`; usam conta,
   módulo, identificador, datas, tamanho e SHA-256.
4. Cópia usa `(organization_id, legacy_id)` e `ON CONFLICT DO NOTHING`. Um
   destino existente com hash diferente — inclusive um paciente com a mesma
   chave nominal — fica em `target_conflict`; não há mesclagem presumida.
5. A validação compara origem, destino, organização e vínculos de paciente e
   atendimento. Uma origem finalizada também precisa chegar com
   `finalized_at`, mantendo a imutabilidade no servidor. Só então o estado
   vira `validated`.
6. Reversão usa `deleted_at` somente em linha criada pelo migrador, dentro da
   janela, com o mesmo hash e versão e sem dependentes. Registro finalizado é
   imutável e bloqueia a reversão automática. A origem não é tocada.

## Sequência de homologação — requer autorização G3

1. Criar snapshot/backup verificável do banco e registrar ponto de retorno.
2. Reconciliar os dois históricos de migração antes de aplicar qualquer SQL.
3. Aplicar a `0024` primeiro em homologação vazia, nunca diretamente em
   produção.
4. Na área **Programador → Migração segura do legado**, executar
   **Inventariar origem congelada**.
5. Confirmar total esperado de 1.075 linhas e comparar contagens por conta e
   módulo. Diferença interrompe o cartão; nenhum dado é classificado.
6. Tratar `unsupported`, `source_changed` e `source_missing` como bloqueios.
7. Classificar um lote pequeno e conhecido, sempre com comprovação externa e
   justificativa sem informação clínica. Processar `pacientes` antes dos
   módulos dependentes; colisão posterior exige revisão, nunca mesclagem.
8. Copiar, validar e testar funcionalmente uma amostra autorizada. O relatório
   registra somente contagens, hashes e códigos de erro.
9. Ampliar em lotes de até 250, repetindo cópia e validação. Não avançar com
   `target_conflict` ou vínculo divergente.
10. Manter `public.documentos` e a janela de reversão por no mínimo sete dias.
    Retirada definitiva do canal exige nova autorização e cartão próprio.

## Critérios de aceite

- total inventariado reconciliado com a fonte autorizada;
- zero linha suportada sem `organization_id` depois da classificação aprovada;
- zero sobrescrita de destino divergente;
- toda linha copiada validada ou explicitamente bloqueada com código;
- contagens por origem, módulo e destino conciliadas;
- nenhum conteúdo clínico em relatórios, eventos ou capturas de teste;
- teste de reversão aprovado em amostra e fonte legada íntegra;
- acesso comum/local incapaz de adotar ou ocultar a quarentena.

## Parada obrigatória

Interromper imediatamente se a origem mudar após o inventário, se o total não
for 1.075, se houver organização duvidosa, hash divergente, destino já editado,
vínculo inesperado ou qualquer conteúdo clínico aparecer em relatório/log.
Esses casos não são resolvidos por inferência automática.
