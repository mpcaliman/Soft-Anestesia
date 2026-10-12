# Comprovantes de documentos e driver de assinatura

O backend entrega uma consulta pública de registros e hashes através da função
assinatura-validacao. O driver CSC de assinatura em nuvem permanece incompleto
até a homologação da API real do provedor. Configurar segredos não habilita
assinatura nem comprova validade ICP-Brasil.

## Consulta pública independente

A interface chama POST /functions/v1/assinatura-validacao com chave pública
apenas no cabeçalho apikey e um código aleatório ou hash SHA-256 completo no
corpo. A resposta confirma somente registro, hash, algoritmo, versão e horário.
Não divulga paciente, profissional, clínica, título livre ou certificado e não
atesta a assinatura criptográfica. Consulte o PDF no validador oficial
https://validar.iti.gov.br para essa verificação.

A função utiliza segredos apenas no servidor, não escreve e não contém
comandos clínicos ou chamadas ao provedor. O JWT da sessão do usuário não é
enviado pela interface durante a consulta pública. O gateway usa
verify_jwt=false exclusivamente para essa função de leitura.

A ordem de implantação e os testes reais exigidos estão em
[Contrato de implantação](../docs/engineering/SIGNATURE-VERIFICATION-DEPLOYMENT-2026-10-11.md).
Publique e verifique a função em staging, depois em produção, antes de aplicar
o endurecimento que revoga a leitura direta da view. Este documento não
autoriza ignorar as condições e controles de migração ou publicação do projeto.
Não use db push enquanto a baseline e a aplicação remota permanecerem bloqueadas.

## Driver de assinatura em nuvem

O arquivo functions/assinatura/index.ts é um scaffold CSC com endpoints do
provedor ainda marcados para ajuste. DRIVER_HOMOLOGADO permanece false, e a
função não anuncia disponibilidade nem executa assinatura apenas porque
CSC_BASE_URL, CSC_CLIENT_ID e CSC_CLIENT_SECRET existem. Não publique esse
scaffold para habilitar a consulta pública.

As rotas protegidas preservam validação real do JWT em Auth e vínculo clínico
ativo por organização antes de responder que o driver está indisponível.
A rota antiga assinatura?op=validar foi encerrada com HTTP 410; a interface
usa a função independente de leitura.

Para homologar futuramente o driver SafeID/Safeweb, são necessários:

1. URL e documentação da API real do provedor.
2. Fluxo OAuth e contratos das URLs de autorização e token.
3. Credenciais de servidor em secrets, sem segredo no app.
4. Contrato de assinatura por PDF ou hash e formato PAdES de resposta.
5. Autorização SAD/OTP e evidência de cadeia, revogação e carimbo de tempo.
6. Teste real do resultado criptográfico, escopo da organização, concorrência
   e recibo imutável antes de habilitar a operação na interface.

Nenhum desses itens é substituído pela simples criação de um hash do arquivo.
Não há integração pronta de um clique anunciada neste estado.

## PDF assinado externamente

O usuário pode assinar e validar o PDF no provedor externo e anexá-lo no app.
A anexação recebe o rótulo “PDF anexado — assinatura não verificada”. A UI e a
impressão não tratam o arquivo, o hash ou metadados legados como prova ICP.

O fluxo assinaturaDigital conserva metadados na memória da sessão, sem recibo
central e sem upload automático desse PDF. Ele orienta manter o original,
salvar o registro e confirmar o envio em Anexos. Nos módulos que possuem
Anexos, o componente antigo pode enviar o arquivo através de prontuario;
seleção e hash, sozinhos, não confirmam upload ou assinatura. O contrato de
escrita central de comprovantes externos ainda precisa ser concluído.

## Segurança do banco

A tabela assinaturas é append-only; UPDATE e DELETE são rejeitados. O
endurecimento original adiciona organização e autor obrigatórios para novas
linhas, unicidade da posição da corrente e uma view security invoker sem
acesso direto de anon/authenticated. A função de consulta lê somente uma
allowlist de campos por correspondência exata com service_role, sem retornar
conteúdo clínico ou dados pessoais. As migrações existentes permanecem intactas.
