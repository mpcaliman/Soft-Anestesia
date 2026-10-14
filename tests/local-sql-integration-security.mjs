import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertCommandSuccess, assertLocalDatabaseUrl, assertProjectContainer, assertSafeEnvironment,
  createPsqlExecutor, MANAGED_EXTENSION_RELOCATION_PROBE, MANAGED_STORAGE_REALTIME_PROBE, isolatedConfig, loadMigrationPlan, migrationSqlForEmptyDatabase,
  legacySourceSchemaCatalogScope, loadLegacySourceSchemaPrerequisite, verifyLegacySourceSchemaPrerequisite,
  readPlatformMigrationCapabilityDiagnostics, reconciledPermissionFixtureEvidence,runConcurrentRetification, runLocalSqlIntegration, verifyPlatformMigrationCapabilities
} from '../scripts/run-local-sql-integration.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const projectId = `soft-as-sql-${'a'.repeat(24)}`;
const containerId = 'b'.repeat(64);
const localEnv = { DOCKER_HOST: 'unix:///var/run/docker.sock' };
const status = { DB_URL: 'postgresql://postgres:synthetic-password@127.0.0.1:54322/postgres' };
const platformCapabilities = {roleVerified:true,adminDefaultsAuthorized:true,extensionSchemaCreateAuthorized:true,
  extensions:['pgcrypto','pg_trgm','unaccent'].map(name=>({name,schema:'public',owner:'postgres',moveRequired:true,moveAuthorized:true})),
  storagePoliciesAuthorized:true,realtimePublicationAuthorized:true};
const extensionResults = facts => facts.extensions.map(x=>({name:x.name,moveRequired:x.moveRequired,
  relocationExecuted:x.moveRequired,relocationAuthorized:x.moveRequired?true:null,statePreserved:true}));
const managedOperationResults = {storageObjectsPolicy:{createExecuted:true,alterExecuted:true,dropExecuted:true,
  authorized:true,statePreserved:true,deniedSqlState:null},
  storageBucketInsert:{insertExecuted:true,authorized:true,rowRolledBack:true,statePreserved:true,deniedSqlState:null},
  realtimePublication:{createTableExecuted:true,replicaIdentityExecuted:true,addExecuted:true,dropExecuted:true,
    authorized:true,statePreserved:true,deniedSqlState:null}};
const capabilityDb = (facts=platformCapabilities, relocations=extensionResults(facts), managed=managedOperationResults) => ({
  runMigrationAsPostgres:async sql=>({stdout:JSON.stringify(sql===MANAGED_EXTENSION_RELOCATION_PROBE?relocations:
    sql===MANAGED_STORAGE_REALTIME_PROBE?managed:facts)})
});
const historicalFacts={verified:true,historicalOriginals:455,historicalAdenda:2,historicalSignatures:1,
  authRows:3,patientRows:1,encounterRows:1,addendaRows:2,signatureRows:1,clinicalRows:459,
  backfillFinalizationAuditRows:455,priorAuditRowsRetained:455,payloadAndLinksPreserved:true,
  historicalTimestampAndAuthorPreserved:true,historicalAdendaNotCasHeads:true,
  historicalSignaturesUnassignedAndImmutable:true,administrativeFinalizedDeletionDenied:true,
  replicaFinalizedDeletionDenied:true,productionMutated:false,
  sourceDistribution:{preanesthetic_assessments:92,anesthesia_records:167,recovery_records:143,consents:53},
  timestampCases:{valid_timestamp:149,invalid_timestamp:153,absent_timestamp:153}};
const inspectionFor = project => [{
  Id: containerId, Name: `/supabase_db_${project}`,
  Config: { Labels: { 'com.supabase.cli.project': project } }, State: { Running: true },
  NetworkSettings: { Ports: { '5432/tcp': [{ HostIp: '0.0.0.0', HostPort: '54322' }] } }
}];
let checks = 0;
async function check(name, callback) { await callback(); checks++; console.log(`✓ ${name}`); }

await check('URLs externas, portas, bancos, credenciais e overrides são recusados', () => {
  for (const host of ['127.0.0.1', 'localhost', '[::1]']) {
    assert.doesNotThrow(() => assertLocalDatabaseUrl(`postgresql://postgres:synthetic@${host}:54322/postgres`));
  }
  const invalid = [
    undefined, '', 'https://localhost:54322/postgres',
    'postgresql://postgres:synthetic@db.example.invalid:54322/postgres',
    'postgresql://postgres:synthetic@127.0.0.1.evil.invalid:54322/postgres',
    'postgresql://postgres:synthetic@127.0.0.2:54322/postgres',
    'postgresql://postgres:synthetic@2130706433:54322/postgres',
    'postgresql://postgres:synthetic@127.0.0.1:6543/postgres',
    'postgresql://postgres:synthetic@127.0.0.1:54322/other',
    'postgresql://postgres:synthetic@127.0.0.1:54322/postgres?host=db.example.invalid',
    'postgresql://postgres:synthetic@127.0.0.1:54322/postgres?options=-csearch_path=evil',
    'postgresql://postgres:synthetic@127.0.0.1:54322/postgres#override',
    'postgresql://other:synthetic@127.0.0.1:54322/postgres',
    'postgresql://postgres@127.0.0.1:54322/postgres',
    'postgresql://postgres:synthetic@127.0.0.1:54322/postgres/'
  ];
  for (const raw of invalid) assert.throws(() => assertLocalDatabaseUrl(raw));
  for (const key of ['DB_URL', 'DATABASE_URL', 'PGHOST', 'PGSERVICE', 'PGOPTIONS', 'POSTGRES_PASSWORD',
    'SUPABASE_URL', 'SUPABASE_ACCESS_TOKEN', 'SUPABASE_HOME', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG']) {
    assert.throws(() => assertSafeEnvironment({ [key]: 'forbidden' }));
  }
  assert.doesNotThrow(() => assertSafeEnvironment({ PATH: '/usr/bin', HOME: '/home/runner', GITHUB_ACTIONS: 'true' }));
});

await check('nome, label, identidade e porta do container são obrigatórios', () => {
  const inspection = inspectionFor(projectId);
  assert.ok(projectId.length <= 40, 'CLI não pode truncar a identidade do projeto');
  assert.equal(assertProjectContainer(inspection, projectId), containerId);
  assert.throws(() => assertProjectContainer(inspection, `soft-anestesia-sql-${'a'.repeat(24)}`));
  const mutations = [
    value => { value[0].Name = '/supabase_db_shared'; },
    value => { value[0].Config.Labels['com.supabase.cli.project'] = 'shared'; },
    value => { delete value[0].Config.Labels; },
    value => { value[0].Id = '--privileged'; },
    value => { value[0].State.Running = false; },
    value => { value[0].NetworkSettings.Ports['5432/tcp'][0].HostPort = '6543'; },
    value => { value.push(value[0]); }
  ];
  const guards = ['container-name','container-project-label','container-project-label','container-id','container-running','container-port','container-shape'];
  for (const [index, mutate] of mutations.entries()) {
    const value = structuredClone(inspection); mutate(value);
    assert.throws(() => assertProjectContainer(value, projectId), error => error.guard === guards[index]);
  }
  assert.throws(() => assertProjectContainer(inspection, 'production'));
});

await check('nenhum psql é iniciado antes de validar ambiente, URL e container', async () => {
  let calls = 0;
  const execute = async () => { calls++; return { code: 0, stdout: '[]', stderr: '' }; };
  const base = { status, inspection: inspectionFor(projectId), projectId, env: localEnv, execute };
  for (const override of [
    { inheritedEnv: { PGHOST: 'db.example.invalid' } },
    { status: { DB_URL: 'postgresql://postgres:synthetic@remote.invalid:54322/postgres' } },
    { inspection: [] },
    { env: { DOCKER_HOST: 'tcp://remote.invalid:2375' } },
    { env: { ...localEnv, DOCKER_CONTEXT: 'remote' } }
  ]) assert.throws(() => createPsqlExecutor({ ...base, ...override }));
  assert.equal(calls, 0);
  const db = createPsqlExecutor(base);
  await assert.rejects(db.run('select 1;', 'identity'), /Container/);
  assert.equal(calls, 1, 'somente a reinspeção, nunca psql, pode ocorrer se a identidade falhar');
});

await check('psql usa socket e argumentos fixos; uma recusa RLS falha a execução', async () => {
  const calls = [];
  const db = createPsqlExecutor({ status, inspection: inspectionFor(projectId), projectId, env: localEnv,
    execute: async (command, args, options) => {
      calls.push({ command, args, options });
      if (args[0] === 'inspect') return { code: 0, stdout: JSON.stringify(inspectionFor(projectId)), stderr: '' };
      return { code: 3, stdout: '', stderr: 'psql:<stdin>:1: ERROR:  42501\nsynthetic-secret-do-not-print' };
    }
  });
  await assert.rejects(db.run('set role authenticated; select 1;', 'RLS fixture'), error => {
    assert.equal(error.sqlState, '42501');
    assert.doesNotMatch(error.message, /synthetic-secret/);
    return true;
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].command, 'docker');
  assert.deepEqual(calls[1].args.slice(0, 5), ['exec', '--user', 'postgres', '-i', containerId]);
  for (const arg of ['--no-psqlrc', '--host=/var/run/postgresql', '--port=5432', '--dbname=postgres',
    '--username=supabase_admin', '--set=ON_ERROR_STOP=1', '--set=VERBOSITY=verbose']) {
    assert.ok(calls[1].args.includes(arg));
  }
  assert.ok(!calls[1].args.some(arg => /postgres(?:ql)?:\/\//.test(arg)));
  assert.throws(() => assertCommandSuccess({ code: 1, stderr: 'permission denied' }, 'RLS'));
  const migrationCalls=[];
  const migrationDb=createPsqlExecutor({status,inspection:inspectionFor(projectId),projectId,env:localEnv,
    execute:async(command,args,options)=>{
      migrationCalls.push({command,args,options});
      return args[0]==='inspect'?{code:0,stdout:JSON.stringify(inspectionFor(projectId)),stderr:''}:{code:0,stdout:'',stderr:''};
    }});
  const original='create index concurrently reviewed_original_idx on public.reviewed_original(id);\n';
  await migrationDb.runMigrationAsPostgres(original,'original migration');
  const invocation=migrationCalls[1];
  assert.equal(invocation.options.input,original,'Source stdin and transaction boundaries must remain unchanged');
  assert.ok(invocation.args.includes('--username=postgres'));
  assert.ok(!invocation.args.includes('--username=supabase_admin'));
  const guard=invocation.args.find(x=>x.startsWith('--command='));
  assert.match(guard,/current_user<>'postgres'/);assert.match(guard,/session_user<>'postgres'/);
  assert.match(guard,/server_version_num/);
  assert.ok(invocation.args.indexOf(guard)<invocation.args.indexOf('--file=-'));
  assert.ok(!invocation.args.includes('--single-transaction')&&!invocation.args.includes('-1'));
  const refused=createPsqlExecutor({status,inspection:inspectionFor(projectId),projectId,env:localEnv,
    execute:async(command,args)=>args[0]==='inspect'?{code:0,stdout:JSON.stringify(inspectionFor(projectId)),stderr:''}:
      {code:3,stdout:'',stderr:'ERROR:  P0001: Migration requires the verified local PostgreSQL 17 postgres role\nprivate runtime content'}});
  await assert.rejects(refused.runMigrationAsPostgres(original,'migration role guard'),error=>{
    assert.equal(error.sqlState,'P0001');assert.doesNotMatch(JSON.stringify(error),/private runtime content/);return true;
  });
});

await check('diagnóstico publica somente a asserção literal; valores substituídos ficam privados', async () => {
  const sql = `do $t$ begin raise exception 'Signed original changed: %'; end $t$;`;
  assert.throws(() => assertCommandSuccess({ code: 3, stderr:
    'psql:<stdin>:1: ERROR:  P0001: Signed original changed: synthetic-secret@example.invalid\nCONTEXT: private content' }, 'fixture', sql), error => {
    assert.equal(error.sqlState, 'P0001');
    assert.equal(error.assertion, 'Signed original changed: %');
    assert.doesNotMatch(error.message, /synthetic-secret|private content/);
    return true;
  });
  assert.equal((await verifyPlatformMigrationCapabilities(capabilityDb())).verified,true);
  const safeCapabilities=await verifyPlatformMigrationCapabilities(capabilityDb({...platformCapabilities,
    privateRuntimeContent:'synthetic-secret-do-not-export'}));
  assert.doesNotMatch(JSON.stringify(safeCapabilities),/synthetic-secret|privateRuntimeContent/);
  await assert.rejects(verifyPlatformMigrationCapabilities({runMigrationAsPostgres:async()=>({
    stdout:'private runtime content'})}),error=>!/private runtime content/.test(error.message));
  for(const stdout of ['null','[]','42'])await assert.rejects(verifyPlatformMigrationCapabilities({
    runMigrationAsPostgres:async()=>({stdout})}),/Platform migration capability response is invalid/);
  const deniedAdminAuthority=await verifyPlatformMigrationCapabilities(capabilityDb({...platformCapabilities,adminDefaultsAuthorized:false}));
  assert.equal(deniedAdminAuthority.adminDefaultsAuthorized,false);
  assert.equal(deniedAdminAuthority.supplierDefaultPrivilegesPending,true);
  assert.equal(deniedAdminAuthority.adminDefaultAuthorityMatchesHosted,true);
  const permissionFacts={verified:true,applicationExecutorDefaultPrivilegesClosed:true,
    supplierDefaultPrivilegesClosed:false,supplierDefaultPrivilegesPending:true,supplierPrivilegesAdded:false,
    supplierOwnersChanged:false,managedRoleDeniedAttemptTested:true,managedRoleDefaultDenied42501:true,
    adminDefaultAuthorityMatchesHosted:true};
  assert.equal(reconciledPermissionFixtureEvidence(JSON.stringify(permissionFacts),deniedAdminAuthority).universalDefaultPrivilegesClosureVerified,false);
  assert.throws(()=>reconciledPermissionFixtureEvidence(JSON.stringify({...permissionFacts,
    managedRoleDefaultDenied42501:false}),deniedAdminAuthority));
  for(const mutate of [x=>{x.roleVerified='true';},x=>{x.adminDefaultsAuthorized='false';},
    x=>{x.extensionSchemaCreateAuthorized=false;},x=>{x.extensions[0]=null;},x=>{x.extensions[0].moveAuthorized='false';},
    x=>{x.storagePoliciesAuthorized='false';},x=>{x.realtimePublicationAuthorized='false';}]) {
    const unauthorized=structuredClone(platformCapabilities);mutate(unauthorized);
    await assert.rejects(verifyPlatformMigrationCapabilities(capabilityDb(unauthorized,extensionResults(platformCapabilities))),error=>{
      assert.match(error.platformPrerequisite,/^(?:postgres-role|supabase-admin-default-privileges|extension-schema-create|required-extension-inventory|extension-owner|storage-policy-owner|realtime-publication-owner)$/);
      return true;
    });
  }
  const inheritedAuthorityDenied=structuredClone(platformCapabilities);
  inheritedAuthorityDenied.extensions[0]={name:'pgcrypto',schema:'public',owner:'supabase_admin',moveRequired:true,moveAuthorized:false,
    privateRuntimeContent:'synthetic-secret-do-not-export'};
  const managedHookAuthorized=await verifyPlatformMigrationCapabilities(capabilityDb(inheritedAuthorityDenied));
  assert.equal(managedHookAuthorized.verified,true);
  assert.equal(managedHookAuthorized.extensionAuthorityVerifiedBy,'actual-relocation-rollback');
  assert.equal(managedHookAuthorized.extensions[0].inheritedOwnerAuthority,false);
  assert.equal(managedHookAuthorized.extensions[0].relocationExecuted,true);
  assert.equal(managedHookAuthorized.extensions[0].statePreserved,true);
  assert.doesNotMatch(JSON.stringify(managedHookAuthorized),/synthetic-secret|privateRuntimeContent/);
  for(const change of [x=>{x[0].relocationAuthorized=false;x[0].relocationExecuted=false;},
    x=>{x[0].statePreserved=false;},x=>{x[0].name='private-secret';},
    x=>{x[0].moveRequired=false;},x=>{x[0].relocationExecuted='true';},x=>{x.push(x[0]);}]) {
    const result=extensionResults(inheritedAuthorityDenied);change(result);
    await assert.rejects(verifyPlatformMigrationCapabilities(capabilityDb(inheritedAuthorityDenied,result)),error=>{
      assert.equal(error.platformPrerequisite,'extension-owner');
      assert.equal(error.platformCapabilityDiagnostics.extensions[0].owner,'supabase_admin');
      assert.doesNotMatch(JSON.stringify(error),/synthetic-secret|privateRuntimeContent|private-secret/);return true;
    });
  }
  const targetReady=structuredClone(platformCapabilities);
  targetReady.extensions[0]={name:'pgcrypto',schema:'extensions',owner:'supabase_admin',moveRequired:false,moveAuthorized:false};
  const noMove=await verifyPlatformMigrationCapabilities(capabilityDb(targetReady));
  assert.equal(noMove.extensions[0].relocationAuthorized,null,'Existing target schema must not claim an unexecuted relocation');
  const initialOwnership=await readPlatformMigrationCapabilityDiagnostics(capabilityDb({...inheritedAuthorityDenied,
    privateRuntimeContent:'synthetic-secret-do-not-export'}));
  assert.equal(initialOwnership.extensions[0].owner,'supabase_admin');
  assert.doesNotMatch(JSON.stringify(initialOwnership),/synthetic-secret|privateRuntimeContent/);
  const inheritedStorageDenied={...platformCapabilities,storagePoliciesAuthorized:false,realtimePublicationAuthorized:false};
  const actualManaged=await verifyPlatformMigrationCapabilities(capabilityDb(inheritedStorageDenied));
  assert.equal(actualManaged.storagePolicyInheritedOwnerAuthority,false);
  assert.equal(actualManaged.realtimePublicationInheritedOwnerAuthority,false);
  assert.equal(actualManaged.storagePoliciesAuthorized,true);
  assert.equal(actualManaged.realtimePublicationAuthorized,true);
  assert.equal(actualManaged.managedStorageRealtimeAuthorityVerifiedBy,'actual-operation-rollback');
  for(const [name,result]of Object.entries(managedOperationResults)) {
    for(const key of Object.keys(result)) {
      const rejected=structuredClone(managedOperationResults);
      rejected[name][key]=key==='deniedSqlState'?'42501':false;
      rejected[name].privateRuntimeContent='synthetic-secret-do-not-export';
      await assert.rejects(verifyPlatformMigrationCapabilities(capabilityDb(inheritedStorageDenied,
        extensionResults(platformCapabilities),rejected)),error=>{
        assert.equal(error.platformPrerequisite,name==='realtimePublication'?'realtime-publication-owner':'storage-policy-owner');
        assert.doesNotMatch(JSON.stringify(error),/synthetic-secret|privateRuntimeContent/);return true;
      });
    }
  }
  for(const malformed of [null,[],{},'synthetic-secret-do-not-export'])await assert.rejects(
    verifyPlatformMigrationCapabilities(capabilityDb(inheritedStorageDenied,extensionResults(platformCapabilities),malformed)),
    error=>!error.message.includes('synthetic-secret'));
  assert.throws(() => assertCommandSuccess({ code: 3, stderr:
    'ERROR:  P0001: Unknown message with synthetic-secret@example.invalid' }, 'fixture', sql), error => {
    assert.equal(error.assertion, undefined); return true;
  });
  const ddl = 'begin;\ngrant select on table public.cbhpm_codigos to authenticated;\ncommit;';
  assert.throws(() => assertCommandSuccess({ code: 3, stderr:
    'psql:<stdin>:2: ERROR:  42P01: relation "public.cbhpm_codigos" does not exist\nDETAIL: private content\nCONTEXT: private content' }, 'fixture', ddl), error => {
    assert.equal(error.missingRelation, 'public.cbhpm_codigos'); assert.equal(error.sourceLine, 2);
    assert.doesNotMatch(JSON.stringify(error), /private content/); return true;
  });
  for (const relation of ['public.unreviewed_table', 'public.private@example.invalid', 'https://private.invalid', 'public.'+'a'.repeat(64)]) {
    assert.throws(() => assertCommandSuccess({ code: 3, stderr: `psql:<stdin>:999: ERROR:  42P01: relation "${relation}" does not exist` }, 'fixture', ddl), error => {
      assert.equal(error.missingRelation, undefined); assert.equal(error.sourceLine, undefined); return true;
    });
  }
});

await check('baseline fechada usa os hashes registrados, sem reescrever CONCURRENTLY', async () => {
  const plan = await loadMigrationPlan(root);
  const legacySchema=await loadLegacySourceSchemaPrerequisite(root);
  assert.equal(legacySchema.source.catalog.relations.length,3);
  assert.equal(legacySchema.source.catalog.effective_grants.length,81);
  assert.equal(verifyLegacySourceSchemaPrerequisite(legacySchema.source,legacySchema.source).verified,true);
  for(const [category,change]of [
    ['columns',row=>{row.type='private-wrong-type';}],['policies',row=>{row.permissive='PERMISSIVE';row.using_expression='true';}],
    ['functions',row=>{row.security_definer=true;}],['relations',row=>{row.owner='supabase_admin';}],
    ['indexes',row=>{row.definition+=' WHERE false';}],['effective_grants',row=>{row.grantee='ci_unreviewed_role';}]]) {
    const altered=structuredClone(legacySchema.source);change(altered.catalog[category][0]);
    assert.throws(()=>verifyLegacySourceSchemaPrerequisite(legacySchema.source,altered));
  }
  const missingLegacy=structuredClone(legacySchema.source);missingLegacy.catalog.constraints.pop();
  assert.throws(()=>verifyLegacySourceSchemaPrerequisite(legacySchema.source,missingLegacy));
  assert.match(MANAGED_EXTENSION_RELOCATION_PROBE,/current_user<>'postgres'/);
  assert.match(MANAGED_EXTENSION_RELOCATION_PROBE,/session_user<>'postgres'/);
  assert.match(MANAGED_EXTENSION_RELOCATION_PROBE,/alter extension %I set schema extensions/);
  assert.match(MANAGED_EXTENSION_RELOCATION_PROBE,/raise exception using errcode='PZ001'/);
  assert.match(MANAGED_EXTENSION_RELOCATION_PROBE,/execute format\('alter extension %I set schema extensions',r\.extname\);\s*executed:=true;/);
  assert.match(MANAGED_EXTENSION_RELOCATION_PROBE,/when sqlstate 'PZ001' then\s*if not executed then raise; end if;\s*authorized:=true/);
  assert.match(MANAGED_EXTENSION_RELOCATION_PROBE,/when insufficient_privilege then executed:=false; authorized:=false/);
  assert.match(MANAGED_EXTENSION_RELOCATION_PROBE,/before_state is distinct from after_state/);
  assert.match(MANAGED_EXTENSION_RELOCATION_PROBE,/rollback;\s*$/);
  assert.doesNotMatch(MANAGED_EXTENSION_RELOCATION_PROBE,/alter\s+(?:extension\s+[^;]+\s+owner|role|user)|\bgrant\b|create extension/i);
  assert.match(MANAGED_STORAGE_REALTIME_PROBE,/current_user<>'postgres'/);
  assert.match(MANAGED_STORAGE_REALTIME_PROBE,/as restrictive for select to public using\(false\)/);
  assert.match(MANAGED_STORAGE_REALTIME_PROBE,/alter policy soft_as_managed_policy_probe on storage\.objects to public using\(false\)/);
  assert.match(MANAGED_STORAGE_REALTIME_PROBE,/drop policy soft_as_managed_policy_probe on storage\.objects/);
  assert.match(MANAGED_STORAGE_REALTIME_PROBE,/values\('soft-as-ci-capability-probe','soft-as-ci-capability-probe',false\)/);
  assert.match(MANAGED_STORAGE_REALTIME_PROBE,/replica identity full/);
  assert.match(MANAGED_STORAGE_REALTIME_PROBE,/alter publication supabase_realtime add table public\.soft_as_managed_publication_probe/);
  assert.match(MANAGED_STORAGE_REALTIME_PROBE,/before_state is distinct from after_state/);
  assert.match(MANAGED_STORAGE_REALTIME_PROBE,/rollback;\s*$/);
  assert.doesNotMatch(MANAGED_STORAGE_REALTIME_PROBE,/alter\s+(?:role|user|[^;]+\s+owner)|\bgrant\b|using\(true\)/i);
  /* Cada migração nova cresce o plano em um e entra na cauda. A posição das
     duas do Supabase (0001 na frente, 0002 antes da cauda) é o que este teste
     guarda — e o deslocamento delas a cada migração é esperado. */
  assert.equal(plan.length, 38);
  assert.equal(plan[0].path, 'supabase/migrations/0001_assinaturas.sql');
  assert.match(plan.at(-5).path, /^database\/migrations\/0033_[a-z0-9_]+\.sql$/);
  assert.equal(plan.at(-4).path, 'supabase/migrations/0002_assinaturas_hardening.sql');
  assert.match(plan.at(-3).path, /^database\/migrations\/0034_[a-z0-9_]+\.sql$/);
  assert.match(plan.at(-2).path, /^database\/migrations\/0035_[a-z0-9_]+\.sql$/);
  assert.match(plan.at(-1).path, /^database\/migrations\/0036_[a-z0-9_]+\.sql$/);
  const source = plan.find(entry => entry.path.endsWith('0026_e1_performance_indexes.sql'));
  assert.throws(() => migrationSqlForEmptyDatabase(source.path, source.sql, false));
  const derived = migrationSqlForEmptyDatabase(source.path, source.sql, true);
  assert.doesNotMatch(derived, /create index concurrently/i);
  assert.match(source.sql, /create index concurrently/i);
  assert.equal(await readFile(join(root, source.path), 'utf8'), source.sql);
  assert.match(isolatedConfig(projectId), /\[db\.migrations\]\nenabled = false/);
  assert.match(isolatedConfig(projectId), /\[db\.seed\]\nenabled = false/);
  assert.doesNotMatch(isolatedConfig(projectId), /env\(|project_ref|remote|access_token/i);
});

const testRoot = await mkdtemp(join(tmpdir(), 'soft-anestesia-sql-unit-'));
try {
  await cp(join(root, 'database'), join(testRoot, 'database'), { recursive: true });
  await cp(join(root, 'supabase/migrations'), join(testRoot, 'supabase/migrations'), { recursive: true });
  await cp(join(root, 'tests/sql'), join(testRoot, 'tests/sql'), { recursive: true });
  await mkdir(join(testRoot,'docs/engineering'),{recursive:true});
  await cp(join(root,'docs/engineering/PRODUCTION-APPLICATION-CATALOG-2026-10-11.json'),
    join(testRoot,'docs/engineering/PRODUCTION-APPLICATION-CATALOG-2026-10-11.json'));
  await mkdir(join(testRoot,'scripts'),{recursive:true});
  await cp(join(root,'scripts/capture-application-catalog.sql'),join(testRoot,'scripts/capture-application-catalog.sql'));
  await mkdir(join(testRoot, 'node_modules/.bin'), { recursive: true });
  await writeFile(join(testRoot, 'node_modules/.bin/supabase'), 'unused mock CLI');

  await check('alvo herdado impede start; baseline alterada impede start', async () => {
    let calls = 0;
    const execute = async () => { calls++; throw new Error('must not execute'); };
    await assert.rejects(runLocalSqlIntegration({ repoDir: testRoot, inheritedEnv: { DATABASE_URL: 'forbidden' }, execute }));
    assert.equal(calls, 0);
    const path = join(testRoot, 'database/migrations/0001_foundation.sql');
    const original = await readFile(path, 'utf8');
    await writeFile(path, `${original}\n-- unexpected source mutation\n`);
    await assert.rejects(runLocalSqlIntegration({ repoDir: testRoot, inheritedEnv: {}, execute }), /baseline/);
    assert.equal(calls, 0);
    await writeFile(path, original);
  });

  for (const mode of ['startup-failure', 'remote-status', 'rls-fixture-failure']) {
    await check(`${mode}: falha fechada, limpeza exclusiva e evidência sem segredos`, async () => {
      const calls = []; let project; let temporaryWorkdir;
      const execute = async (command, args, options) => {
        calls.push({ command, args, options });
        assert.equal(options.env.DOCKER_HOST, 'unix:///var/run/docker.sock');
        assert.equal(options.env.HOME, '/home/synthetic-runner', 'HOME deve ser preservado');
        assert.ok(options.env.DOCKER_CONFIG.startsWith(options.cwd));
        assert.equal(options.env.SUPABASE_HOME,join(options.cwd,'supabase-home'));
        const result = stdout => ({ code: 0, stdout, stderr: '' });
        if (args[0] === '--version') return result('2.119.0\n');
        if (args.includes('--help')) return result('--workdir --output --no-backup');
        if (args[0] === 'start') {
          temporaryWorkdir = args[2];
          const config = await readFile(join(temporaryWorkdir, 'supabase/config.toml'), 'utf8');
          project = config.match(/^project_id = "([^"]+)"/)[1];
          assert.notEqual(temporaryWorkdir, root);
          assert.match(project, /^soft-as-sql-[a-f0-9]{24}$/);
          assert.ok(project.length <= 40, 'project_id excede o limite da CLI fixada');
          if (mode === 'startup-failure') return { code: 1, stdout: 'synthetic-cli-secret', stderr: 'synthetic-cli-secret' };
          return result('synthetic-cli-secret');
        }
        if (args[0] === 'status') return result(JSON.stringify({
          DB_URL: mode === 'remote-status' ? 'postgresql://postgres:synthetic@db.remote.invalid:54322/postgres' : status.DB_URL,
          SERVICE_ROLE_KEY: 'synthetic-cli-secret', ANON_KEY: 'synthetic-cli-secret'
        }));
        if (args[0] === 'inspect') return result(JSON.stringify(inspectionFor(project)));
        if (args[0] === 'exec' && options.input===MANAGED_STORAGE_REALTIME_PROBE) return result(JSON.stringify(managedOperationResults));
        if (args[0] === 'exec' && options.input.includes("'migration_history'")) {
          const source=JSON.parse(await readFile(join(testRoot,'docs/engineering/PRODUCTION-APPLICATION-CATALOG-2026-10-11.json'),'utf8'));
          return result(JSON.stringify(source.catalog));
        }
        if (args[0] === 'exec' && options.input===MANAGED_EXTENSION_RELOCATION_PROBE) return result(JSON.stringify(extensionResults(platformCapabilities)));
        if (args[0] === 'exec' && options.input.includes('adminDefaultsAuthorized')) return result(JSON.stringify(platformCapabilities));
        if (args[0] === 'exec' && options.input.includes('backfillFinalizationAuditRows')) return result(JSON.stringify(historicalFacts));
        if (args[0] === 'exec' && options.input.includes("'legacyProvenanceFixture'")) return result(JSON.stringify({
          legacyProvenanceFixture:{passed:true,syntheticSourceRows:12,validatedSources:6,divergentTargetPreserved:true,
            sourceFrozenAndPreserved:true,ownerAndStampIsolation:true,explicitPatientAndCaseMapping:true,
            historicalClaimsSeparatedFromImportAudit:true,repeatedCopyIdempotent:true,verificationRolledBack:true}}));
        if (args[0] === 'exec' && options.input.includes("'legacySourceRows'")) return result(JSON.stringify({
          authRows:8,legacySourceRows:12,signatureRows:1,tableRows:{patients:6,encounters:3,preanesthetic_assessments:93,
            anesthesia_records:167,recovery_records:143,consents:53,addenda:2,appointments:0}}));
        if (args[0] === 'exec' && options.input.includes('fb110000-')) {
          return { code: 3, stdout: '', stderr: 'ERROR:  42501\nsynthetic-cli-secret' };
        }
        return result('');
      };
      await assert.rejects(runLocalSqlIntegration({ repoDir: testRoot,
        inheritedEnv: { PATH: process.env.PATH, HOME: '/home/synthetic-runner' }, execute }), error => {
        assert.doesNotMatch(error.message, /synthetic-cli-secret|synthetic-password/);
        if (mode === 'rls-fixture-failure') assert.match(error.message, /SQLSTATE 42501/);
        return true;
      });
      const starts = calls.filter(call => call.args[0] === 'start' && !call.args.includes('--help'));
      const stops = calls.filter(call => call.args[0] === 'stop' && !call.args.includes('--help'));
      assert.equal(starts.length, 1); assert.equal(stops.length, 1);
      assert.deepEqual(stops[0].args, ['stop', '--workdir', temporaryWorkdir, '--no-backup']);
      const startIndex = calls.indexOf(starts[0]);
      for (const subcommand of ['start', 'status', 'stop']) {
        assert.ok(calls.findIndex(call => call.args[0] === subcommand && call.args.includes('--help')) < startIndex);
      }
      const psqlCalls = calls.filter(call => call.args[0] === 'exec');
      if (mode !== 'rls-fixture-failure') assert.equal(psqlCalls.length, 0);
      if(mode==='rls-fixture-failure') {
        const extensionProbe=psqlCalls.find(call=>call.options.input===MANAGED_EXTENSION_RELOCATION_PROBE);
        assert.ok(extensionProbe);assert.ok(extensionProbe.args.includes('--username=postgres'));
        assert.ok(!extensionProbe.args.includes('--username=supabase_admin'));
        const adminSql=psqlCalls.filter(call=>call.args.includes('--username=supabase_admin')).map(call=>call.options.input).join('\n');
        assert.match(adminSql,/create extension if not exists unaccent with schema public/i,
          'Historical fixture preserves the managed extension creator rather than changing owners to satisfy the guard');
        assert.match(adminSql,/create table if not exists supabase_migrations\.schema_migrations/);
        assert.match(adminSql,/if exists\(select 1 from supabase_migrations\.schema_migrations\)/);
        assert.doesNotMatch(adminSql,/insert\s+into\s+supabase_migrations\.schema_migrations/i);
      }
      const raw = await readFile(join(testRoot, 'artifacts/local-sql-integration-evidence.json'), 'utf8');
      assert.doesNotMatch(raw, /synthetic-cli-secret|synthetic-password|DB_URL|SERVICE_ROLE|ANON_KEY|postgresql:\/\//);
      const evidence = JSON.parse(raw);
      for (const key of ['localSqlVerified', 'stagingVerified', 'realAuthApiVerified', 'productionVerified']) assert.equal(evidence[key], false);
      assert.ok(evidence.tests.some(test => test.passed === false));
      assert.ok(evidence.tests.some(test => test.name === 'ephemeral-project-cleanup' && test.passed));
      /* o contador acompanha o plano, que cresceu com a 0035 */
      assert.equal(evidence.counters.migrations, mode === 'rls-fixture-failure' ? 38 : 0);
      await assert.rejects(readFile(join(temporaryWorkdir, 'supabase/config.toml')));
    });
  }
} finally { await rm(testRoot, { recursive: true, force: true }); }

await check('corrida exige duas sessões, barreira observada, original e auditorias preservados', async () => {
  const parent = { id: 'synthetic-parent', finalized_at: '2026-01-01T00:00:00Z', version: 1 };
  const audit = [{ id: 'synthetic-original-audit', action: 'insert' }];
  const events = []; let opens = 0; let finalSql;
  const org = 'fc220000-0000-4000-8000-000000000001';
  const parentId = 'fc330000-0000-4000-8000-000000000001';
  const addenda = ['a', 'b'].map((letter, i) => ({
    id: `synthetic-addendum-${letter}`, legacy_id: `local-race-${letter}`,
    author_id: `fc110000-0000-4000-8000-00000000000${i + 1}`, organization_id: org, parent_id: parentId,
    retification_revision: i === 0 ? 1 : null,
    data: { retificacao: { status: i === 0 ? 'accepted' : 'conflict', baseAdendoId: '',
      baseAtualId: i === 0 ? '' : 'local-race-a', campos: { alergias: `Synthetic ${letter}` } } }
  }));
  const final = { parent, audit, addenda, addendaAudit: addenda.map(row => ({ record_id: row.id,
    action: 'insert', user_id: row.author_id, new_value: row })) };
  const db = {
    run: async (sql, label) => {
      if (label === 'snapshot do original') return { stdout: JSON.stringify({ parent, audit }) };
      if (label === 'invariantes após concorrência') return { stdout: JSON.stringify(final) };
      assert.match(sql, /commit;/); return {};
    },
    open: async sql => {
      const index = opens++; events.push(`open-${index}`);
      assert.match(sql, /begin isolation level read committed/);
      assert.match(sql, /"baseAdendoId":""/);
      if (index === 1) assert.ok(events.includes('held'));
      return {
        waitFor: async marker => { assert.equal(marker, 'LOCAL_SQL_RACE_A_HELD'); events.push('held'); },
        end: value => { if (index === 0) finalSql = value; }, kill: () => {},
        done: Promise.resolve({ code: 0, stdout: index === 0 ? 'LOCAL_SQL_RACE_OVERLAP' : '', stderr: '' })
      };
    }
  };
  assert.deepEqual(await runConcurrentRetification(db), { accepted: 1, conflict: 1, blockedSessions: 1 });
  assert.equal(opens, 2);
  assert.match(finalSql, /pg_locks waiting/); assert.match(finalSql, /not waiting\.granted/);
  assert.ok(finalSql.indexOf('perform pg_stat_clear_snapshot();') < finalSql.indexOf('pg_locks waiting'));
  assert.ok(finalSql.indexOf('reset role;') < finalSql.indexOf('pg_locks waiting'));
  assert.match(finalSql, /held\.pid=pg_backend_pid\(\)/);
  assert.ok(finalSql.indexOf('if observed is distinct from true') < finalSql.indexOf('commit;'));
  final.addendaAudit.pop();
  opens = 0; events.length = 0;
  await assert.rejects(runConcurrentRetification(db), /auditoria/);
});

await check('workflow tem permissões mínimas, timeout e somente as duas evidências SQL revisadas', async () => {
  const workflow = await readFile(join(root, '.github/workflows/sql-integration.yml'), 'utf8');
  const ci = await readFile(join(root, '.github/workflows/ci.yml'), 'utf8');
  assert.match(workflow, /contents: read/); assert.doesNotMatch(workflow, /contents: write|secrets\.|environment:/);
  assert.match(workflow, /persist-credentials: false/);
  // Two independently disposable Supabase projects now run in this job. Keep
  // their combined deadline fixed, rather than allowing an unbounded workflow.
  assert.match(workflow, /^\s+timeout-minutes: 40\s*$/m);
  assert.match(workflow, /branches: \[ 'codex\/\*\*' \]/); assert.match(workflow, /branches: \[ main \]/);
  assert.match(workflow, /run: npm ci/); assert.match(workflow, /run: node tests\/local-sql-integration-security\.mjs/);
  assert.match(workflow, /run: node scripts\/run-local-sql-integration\.mjs/);
  assert.match(workflow, /run: node tests\/production-baseline-security\.mjs/);
  assert.match(workflow, /run: node scripts\/run-production-baseline-replay\.mjs/);
  const actions = [...workflow.matchAll(/uses:\s*([^\s]+)@([a-f0-9]{40})/g)];
  assert.equal(actions.length, 4);
  for (const [, name, sha] of actions) assert.ok(ci.includes(`${name}@${sha}`));
  assert.deepEqual([...workflow.matchAll(/^\s+path:\s*(.+)$/gm)].map(match => match[1]),
    ['artifacts/local-sql-integration-evidence.json', 'artifacts/production-baseline-replay-evidence.json']);
});

console.log(`✓ ${checks} grupos de segurança do executor SQL local; PostgreSQL real é verificado pelo workflow Docker.`);
