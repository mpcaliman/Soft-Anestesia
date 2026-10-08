import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { publicAssets } from '../scripts/public-assets.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..');
const appArg = process.argv.find(arg => arg.startsWith('--app-root='));
const appRoot = resolve(repo, appArg ? appArg.slice('--app-root='.length) : '.');

const [html, encounterIdentity, platform, clinicalStore, auth, cloudClient, syncRuntime, relational, cloudFirst, realtimeCompat,
  encounterLinker, qr, signature, contracts, runbook] = await Promise.all([
  readFile(resolve(appRoot, 'index.html'), 'utf8'),
  readFile(resolve(appRoot, 'src/domain/encounter-identity.js'), 'utf8'),
  readFile(resolve(appRoot, 'src/platform/session-vault.js'), 'utf8'),
  readFile(resolve(appRoot, 'src/platform/clinical-store.js'), 'utf8'),
  readFile(resolve(appRoot, 'src/platform/auth.js'), 'utf8'),
  readFile(resolve(appRoot, 'src/platform/cloud-client.js'), 'utf8'),
  readFile(resolve(appRoot, 'src/platform/sync-runtime.js'), 'utf8'),
  readFile(resolve(appRoot, 'src/platform/relational-persistence.js'), 'utf8'),
  readFile(resolve(appRoot, 'src/platform/cloud-first.js'), 'utf8'),
  readFile(resolve(appRoot, 'src/platform/realtime-compat.js'), 'utf8'),
  readFile(resolve(appRoot, 'src/domain/encounter-linker.js'), 'utf8'),
  readFile(resolve(appRoot, 'src/shared/soft-qr.js'), 'utf8'),
  readFile(resolve(appRoot, 'src/integrations/signature-digital.js'), 'utf8'),
  readFile(resolve(repo, 'src/contracts/soft-anestesia.d.ts'), 'utf8'),
  readFile(resolve(repo, 'docs/engineering/F1-MODULARIZATION.md'), 'utf8'),
]);

const encounterIdentityRef = 'src="src/domain/encounter-identity.js"';
const platformRef = 'src="src/platform/session-vault.js"';
const clinicalStoreRef = 'src="src/platform/clinical-store.js"';
const authRef = 'src="src/platform/auth.js"';
const cloudClientRef = 'src="src/platform/cloud-client.js"';
const syncRuntimeRef = 'src="src/platform/sync-runtime.js"';
const relationalRef = 'src="src/platform/relational-persistence.js"';
const cloudFirstRef = 'src="src/platform/cloud-first.js"';
const realtimeCompatRef = 'src="src/platform/realtime-compat.js"';
const encounterLinkerRef = 'src="src/domain/encounter-linker.js"';
const qrRef = 'src="src/shared/soft-qr.js"';
const signatureRef = 'src="src/integrations/signature-digital.js"';
assert(html.indexOf(encounterIdentityRef) >= 0, 'HTML deve carregar identidade de atendimento');
assert(html.indexOf(platformRef) > html.indexOf(encounterIdentityRef), 'identidade deve existir antes da plataforma');
assert(html.indexOf(clinicalStoreRef) > html.indexOf(platformRef), 'store clínico deve carregar depois do contexto da aba');
assert(html.indexOf(authRef) > html.indexOf(platformRef), 'autenticação deve carregar depois do contexto da aba');
assert(html.indexOf(cloudClientRef) > html.indexOf(authRef), 'adaptador Supabase deve carregar depois da autenticação');
assert(html.indexOf(syncRuntimeRef) > html.indexOf(cloudClientRef), 'sincronização deve carregar depois do cliente');
assert(html.indexOf(relationalRef) > html.indexOf(syncRuntimeRef), 'persistência relacional deve manter sua ordem original');
assert(html.indexOf(cloudFirstRef) > html.indexOf(relationalRef), 'Cloud First deve carregar depois da persistência relacional');
assert(html.indexOf(realtimeCompatRef) > html.indexOf(cloudFirstRef), 'Realtime compatível deve carregar depois da persistência');
assert(html.indexOf(encounterLinkerRef) > html.indexOf(realtimeCompatRef), 'linker deve carregar depois da plataforma');
assert(html.indexOf(qrRef) >= 0, 'HTML deve carregar o QR externo');
assert(html.indexOf(encounterLinkerRef) < html.indexOf(qrRef), 'domínio deve carregar antes das integrações finais');
assert(html.indexOf(platformRef) < html.indexOf('const HISTORY_MAX'),
  'plataforma deve carregar antes do restante do runtime');
assert.match(html,
  /src="src\/platform\/session-vault\.js"><\/script>\s*<script>\s*'use strict';\s*\/\* Quantos registros/,
  'continuação do runtime deve preservar modo estrito e ordem síncrona');
assert.match(html,
  /src="src\/platform\/auth\.js"><\/script>\s*<script>\s*'use strict';\s*\/\* ={20,}\s*MODO DEMONSTRAÇÃO/,
  'runtime depois da autenticação deve preservar modo estrito e ordem síncrona');
assert.match(html,
  /src="src\/platform\/cloud-client\.js"><\/script>\s*<script>\s*'use strict';\s*\/\* ={20,}\s*CONFIGURAÇÕES NA NUVEM/,
  'runtime depois do adaptador Supabase deve preservar modo estrito e ordem síncrona');
assert.match(html,
  /src="src\/platform\/sync-runtime\.js"><\/script>\s*<script>\s*'use strict';\s*\/\* ={20,}\s*MEDIDOR DE TRÁFEGO DA NUVEM/,
  'runtime depois da sincronização deve preservar modo estrito e ordem síncrona');
assert.match(html,
  /src="src\/platform\/relational-persistence\.js"><\/script>\s*<script src="src\/platform\/cloud-first\.js"><\/script>/,
  'Cloud First deve carregar imediatamente depois da persistência relacional');
assert.match(html,
  /src="src\/platform\/cloud-first\.js"><\/script>\s*<script>\s*'use strict';\s*\/\* ={20,}\s*DIAGNÓSTICO DA NUVEM/,
  'runtime depois do Cloud First deve preservar modo estrito e ordem síncrona');
assert.match(html,
  /src="src\/platform\/realtime-compat\.js"><\/script>\s*<script>\s*'use strict';\s*\/\* ={20,}\s*BIBLIOTECA DE MODELOS/,
  'runtime depois do Realtime compatível deve preservar modo estrito e ordem síncrona');
assert.match(html,
  /src="src\/domain\/encounter-linker\.js"><\/script>\s*<script>\s*'use strict';\s*\/\* ={20,}\s*FIN — criação automática/,
  'runtime depois do linker deve preservar modo estrito e ordem síncrona');
assert(html.indexOf(signatureRef) > html.indexOf(qrRef), 'QR deve carregar antes da assinatura');
assert.doesNotMatch(html,
  /const contextoAba\s*=|const filaCifrada\s*=|const store\s*=|const auth\s*=|const cloud\s*=|const cloudRel\s*=|const persistenciaCloudFirst\s*=|const realtime\s*=|const sincronia\s*=|const cloudRealtime\s*=|const linker\s*=/,
  'implementações de plataforma extraídas não devem voltar ao HTML');
assert.doesNotMatch(html, /window\.SoftQR\s*=/, 'implementação do QR não deve voltar ao HTML');
assert.doesNotMatch(html, /window\.SoftEncounterIdentity\s*=/,
  'implementação da identidade de atendimento não deve voltar ao HTML');
assert.doesNotMatch(html, /const assinaturaDigital\s*=/, 'integração de assinatura não deve voltar ao HTML');

assert.match(encounterIdentity, /^'use strict';/);
assert.match(encounterIdentity, /window\.SoftEncounterIdentity\s*=\s*\(function/);
assert.match(encounterIdentity, /function strongPatientKey/);
assert.match(encounterIdentity, /function scopedKey/);
assert.match(platform, /^'use strict';/);
assert.match(platform, /const contextoAba\s*=\s*\(\(\)\s*=>/);
assert.match(platform, /const cofre\s*=\s*\{/);
assert.match(platform, /const filaCifrada\s*=\s*\{/);
assert.match(platform, /FIM DA PLATAFORMA DE CONTEXTO E FILA OFFLINE/);
assert.match(clinicalStore, /^'use strict';/);
assert.match(clinicalStore, /const store\s*=\s*\{/);
assert.match(clinicalStore, /FIM DO ARMAZENAMENTO CLÍNICO EM MEMÓRIA E CACHE LOCAL/);
assert.match(auth, /^'use strict';/);
assert.match(auth, /const auth\s*=\s*\{/);
assert.match(auth, /A conta Supabase é a única identidade capaz de abrir dados clínicos/);
assert.match(auth, /FIM DA PLATAFORMA DE AUTENTICAÇÃO/);
assert.match(cloudClient, /^'use strict';/);
assert.match(cloudClient, /const cloud\s*=\s*\{/);
assert.match(cloudClient, /Supabase como fonte oficial, com continuidade offline/);
assert.match(cloudClient, /FIM DO ADAPTADOR SUPABASE/);
assert.match(syncRuntime, /^'use strict';/);
assert.match(syncRuntime, /const realtime\s*=\s*\{/);
assert.match(syncRuntime, /const sincronia\s*=\s*\{/);
assert.match(syncRuntime, /const nuvemEstado\s*=\s*\{/);
assert.match(syncRuntime, /FIM DO RUNTIME DE SINCRONIZAÇÃO/);
assert.match(relational, /^'use strict';/);
assert.match(relational, /const cloudRel\s*=\s*\{/);
assert.match(relational, /FIM DA PERSISTÊNCIA RELACIONAL/);
assert.match(cloudFirst, /^'use strict';/);
assert.match(cloudFirst, /const persistenciaCloudFirst\s*=\s*\{/);
assert.match(cloudFirst, /FIM DA PERSISTÊNCIA CLOUD-FIRST/);
assert.match(realtimeCompat, /^'use strict';/);
assert.match(realtimeCompat, /const cloudRealtime\s*=\s*\{/);
assert.match(realtimeCompat, /contextoAba\.aoMudar/);
assert.match(realtimeCompat, /FIM DO REALTIME DE COMPATIBILIDADE/);
assert.match(encounterLinker, /^'use strict';/);
assert.match(encounterLinker, /const linker\s*=\s*\{/);
assert.match(encounterLinker, /Cria\/atualiza vínculo bidirecional/);
assert.match(encounterLinker, /FIM DO LINKER DE ATENDIMENTOS/);
assert.match(qr, /^window\.SoftQR\s*=\s*\(function/m);
assert.match(signature, /^window\.assinaturaDigital\s*=\s*\(function/m);
assert.match(signature, /authorization: 'Bearer ' \+ s\.access_token/);

const qrSandbox = { TextEncoder, window: {} };
vm.runInNewContext(qr, qrSandbox, { filename: 'soft-qr.js' });
const generatedQr = qrSandbox.window.SoftQR.generate('Soft Anestesia', 'M');
assert(Number.isInteger(generatedQr.size) && generatedQr.size >= 21,
  'QR extraído deve continuar gerando tamanho válido');
assert(Array.isArray(generatedQr.modules) && generatedQr.modules.length === generatedQr.size,
  'QR extraído deve continuar gerando matriz válida');
assert(generatedQr.modules.every(row => Array.isArray(row) && row.length === generatedQr.size),
  'matriz QR deve permanecer quadrada');

assert.deepEqual(publicAssets, [...new Set(publicAssets)], 'allowlist pública não pode ter duplicatas');
assert(publicAssets.includes('src/domain/encounter-identity.js'));
assert(publicAssets.includes('src/platform/session-vault.js'));
assert(publicAssets.includes('src/platform/clinical-store.js'));
assert(publicAssets.includes('src/platform/auth.js'));
assert(publicAssets.includes('src/platform/cloud-client.js'));
assert(publicAssets.includes('src/platform/sync-runtime.js'));
assert(publicAssets.includes('src/platform/relational-persistence.js'));
assert(publicAssets.includes('src/platform/cloud-first.js'));
assert(publicAssets.includes('src/platform/realtime-compat.js'));
assert(publicAssets.includes('src/domain/encounter-linker.js'));
assert(publicAssets.includes('src/shared/soft-qr.js'));
assert(publicAssets.includes('src/integrations/signature-digital.js'));

for (const contract of [
  'interface TabContext', 'interface CloudMutation', 'interface CloudReceipt',
  'interface OfflineEnvelope', 'interface RealtimeChange',
  'interface PreservedConflict', 'interface SafeTelemetryEvent'
]) assert.match(contracts, new RegExp(contract));
assert.match(runbook, /telemetria operacional não possui paciente/i);
assert.match(runbook, /PWA\/TWA ou aplicativo híbrido só será escolhido depois/i);

console.log('✓ F1a: módulos, allowlist pública e contratos arquiteturais preservados');
