# Consulta pública de comprovantes — contrato e implantação

Estado em 11/10/2026: implementação e testes locais. **Nenhuma implantação,
migração remota ou assinatura real foi executada por este pacote.**

## Contrato entregue

A função assinatura-validacao é separada do driver CSC incompleto assinatura.
A interface usa POST /functions/v1/assinatura-validacao, com apikey pública e
exatamente um destes corpos:

    {"codigo":"ABCD-2345-EFGH"}
    {"hash":"<SHA-256 com 64 dígitos hexadecimais>"}

O código existente tem 60 bits aleatórios. A alternativa exige conhecimento
do hash completo do PDF. Não existe busca por pessoa, clínica, UUID, prefixo,
listagem ou conteúdo clínico. A prova permanece no corpo da requisição, sem
query string, Bearer ou cookie. Dois registros com o mesmo hash exigem o
código específico. Uma consulta pelo hash não revela o código correspondente.

A resposta contém somente código quando fornecido pelo solicitante, hash,
algoritmo, versão e horário do registro. Não contém título livre, paciente,
iniciais, profissional, CRM, organização, identidade clínica, certificado,
conteúdo do documento ou arquivo PDF. A consulta confirma a existência do
registro e do hash; **não verifica assinatura criptográfica, cadeia
ICP-Brasil, certificado, revogação ou carimbo de tempo**.

A função só lê: não possui comandos clínicos, provedor, geração de assinatura,
cadastro, escrita, alteração de privilégios ou exclusão. A rota pública
antiga assinatura?op=validar responde 410. As verificações de JWT, vínculo
clínico ativo e organização das rotas protegidas de assinatura permanecem.
O driver CSC continua fechado: DRIVER_HOMOLOGADO é false. Segredos
configurados não habilitam um driver que ainda não foi homologado.

## Segredos e dependências

O servidor prefere SUPABASE_SECRET_KEYS.default e envia a chave moderna
somente como apikey. Não trata sb_secret como JWT. O fallback
SUPABASE_SERVICE_ROLE_KEY aceita somente JWT do papel service_role. Chaves
públicas, de usuário, configurações malformadas e URLs inesperadas falham
sem consultar o banco. Segredos não são devolvidos ou registrados em logs.
Nenhum SDK, pacote ou importação CDN foi acrescentado.

O banco deve conter a view existente assinaturas_publicas e conceder SELECT
a service_role. A migração original supabase/migrations/0002_assinaturas_hardening.sql
fornece esse contrato e permanece intacta. A função não cria policy nem
concede acesso direto a anon/authenticated.

O arquivo supabase/config.toml declara functions.assinatura-validacao com
verify_jwt=false porque a posse do comprovante é a prova pública. Isso se
aplica apenas ao endpoint de leitura e não autoriza publicar comandos
protegidos sem verificação. A interface pública nunca envia JWT de usuário,
Bearer de chave pública ou credencial de provedor.

## Ordem de implantação e evidência obrigatória

1. Publicar apenas os dois arquivos de assinatura-validacao em staging,
   com verify_jwt=false. Não publicar o scaffold CSC para habilitar a consulta.
2. Testar por HTTPS real, com chave pública: código sintético conhecido,
   hash sintético conhecido, prova ausente/inválida, prova inexistente,
   digest ambíguo e retorno mínimo. Provar que o cliente anônimo continua sem
   leitura direta da view/tabela após o endurecimento.
3. Qualquer registro positivo de teste deve ser explicitamente sintético,
   vinculado a organização e usuário sintéticos já autorizados, sem dados
   de pacientes ou alegação de ICP. Preservar a evidência append-only em vez
   de enfraquecer sua imutabilidade para removê-la.
4. Registrar versão/hash do deploy, HTTP e campos retornados, sem prova
   completa, chave, token ou corpo clínico nos artefatos públicos.
5. Após validar o contrato em staging, publicar o mesmo código em produção
   e provar a leitura do endpoint. Só depois aplicar o endurecimento que
   revoga leitura direta da view. Este pacote não antecipa outras condições
   nem autorizações da liberação de produção.

Teste local: node tests/signature-public-verification-security.mjs. A opção
--app-root aceita os artefatos compilados da publicação; a verificação com
CSP usa o runtime real de ações, sem permitir código inline.
Os grupos comportamentais cobrem campos, injeção/enumeração, limites, chaves
modernas/legadas, destinos, ambiguidade, falhas, interface pública sem sessão,
retorno hostil, concorrência e a identificação honesta de PDFs anexados.
Dezesseis grupos passaram no código-fonte e em uma compilação CSP isolada.
São evidência local; não substituem a verificação remota acima.

## Contenção do fluxo externo

Uma anexação externa recebe o tipo pdf_anexado, signatureVerified=false e
centralReceiptConfirmed=false. A UI, o selo do PDF e a restauração de
metadados antigos exibem **“PDF anexado — assinatura não verificada”**.
Mesmo metadados antigos do tipo icp, ou uma marca de verificação enviada
pelo navegador, não afirmam validação de certificado. Anexar um PDF nesse
fluxo não finaliza nem bloqueia o formulário como uma assinatura confirmada.

No fluxo assinaturaDigital, registrarImutavel atualiza a lista assinaturas
da memória da sessão através de store.setList. Isso não insere um registro
em public.assinaturas nem guarda esse PDF em Storage. A operação permanece
explicitamente sem recibo central. A interface orienta manter o PDF,
salvar o registro e confirmar seu envio em Anexos, sem prometer nuvem.

O componente antigo de assinatura pode enviar o arquivo por prontuario
quando o módulo possui Anexos; a seleção, por si só, também não é recibo
de upload ou prova de assinatura. A escrita central autorizada de
comprovantes e homologação do provedor exigem contrato próprio antes de
anunciar assinatura digital integrada como completa.

As duas entradas de anexação capturam o objeto DOM do formulário, módulo,
identidade do documento e referências de paciente/caso antes de ler o PDF.
Essas identidades e o usuário/clínica são verificados novamente após cada
operação assíncrona e antes da escrita. Trocar o formulário, reutilizar o
mesmo DOM para outro documento ou mudar caso/paciente impede a aplicação
dos metadados antigos. No componente antigo, o alvo também é fixado antes
de abrir o seletor de arquivo.

Os appends à lista de metadados são serializados: dois PDFs selecionados
no mesmo modal preservam ambos os registros, versões sequenciais e a
corrente de hashes. O comprovante só substitui esse modal depois que todas
as seleções em andamento terminam. Fechar/substituir o modal, trocar
usuário/clínica ou módulo invalida a capacidade daquela instância; uma
leitura ou cálculo de hash que retorna depois do cancelamento não pode
gravar metadados ou abrir um comprovante. Reabrir o mesmo documento cria
uma capacidade nova, sem reativar a operação anterior. Os eventos de ciclo
de vida em modal.js são apenas apresentação; não decidem autorização ou
persistência. Os testes interrompem a leitura do arquivo, seu hash e o
hash da corrente, além de cancelar uma segunda operação na fila.
