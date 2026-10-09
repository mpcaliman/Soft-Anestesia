import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertCommandSuccess, assertLocalDatabaseUrl, assertProjectContainer, assertSafeEnvironment,
  createPsqlExecutor, isolatedConfig, loadMigrationPlan, migrationSqlForEmptyDatabase,
  runConcurrentRetification, runLocalSqlIntegration
} from '../scripts/run-local-sql-integration.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const projectId = `soft-as-sql-${'a'.repeat(24)}`;
const containerId = 'b'.repeat(64);
const localEnv = { DOCKER_HOST: 'unix:///var/run/docker.sock' };
const status = { DB_URL: 'postgresql://postgres:synthetic-password@127.0.0.1:54322/postgres' };
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
    'SUPABASE_URL', 'SUPABASE_ACCESS_TOKEN', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG']) {
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
});

await check('diagnóstico publica somente a asserção literal; valores substituídos ficam privados', () => {
  const sql = `do $t$ begin raise exception 'Signed original changed: %'; end $t$;`;
  assert.throws(() => assertCommandSuccess({ code: 3, stderr:
    'psql:<stdin>:1: ERROR:  P0001: Signed original changed: synthetic-secret@example.invalid\nCONTEXT: private content' }, 'fixture', sql), error => {
    assert.equal(error.sqlState, 'P0001');
    assert.equal(error.assertion, 'Signed original changed: %');
    assert.doesNotMatch(error.message, /synthetic-secret|private content/);
    return true;
  });
  assert.throws(() => assertCommandSuccess({ code: 3, stderr:
    'ERROR:  P0001: Unknown message with synthetic-secret@example.invalid' }, 'fixture', sql), error => {
    assert.equal(error.assertion, undefined); return true;
  });
});

await check('baseline fechada usa os hashes registrados, sem reescrever CONCURRENTLY', async () => {
  const plan = await loadMigrationPlan(root);
  assert.equal(plan.length, 34);
  assert.equal(plan[0].path, 'supabase/migrations/0001_assinaturas.sql');
  assert.equal(plan.at(-2).path, 'database/migrations/0032_finalized_delete_guard.sql');
  assert.equal(plan.at(-1).path, 'supabase/migrations/0002_assinaturas_hardening.sql');
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
      const raw = await readFile(join(testRoot, 'artifacts/local-sql-integration-evidence.json'), 'utf8');
      assert.doesNotMatch(raw, /synthetic-cli-secret|synthetic-password|DB_URL|SERVICE_ROLE|ANON_KEY|postgresql:\/\//);
      const evidence = JSON.parse(raw);
      for (const key of ['localSqlVerified', 'stagingVerified', 'realAuthApiVerified', 'productionVerified']) assert.equal(evidence[key], false);
      assert.ok(evidence.tests.some(test => test.passed === false));
      assert.ok(evidence.tests.some(test => test.name === 'ephemeral-project-cleanup' && test.passed));
      assert.equal(evidence.counters.migrations, mode === 'rls-fixture-failure' ? 34 : 0);
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
  assert.ok(finalSql.indexOf('reset role;') < finalSql.indexOf('pg_locks waiting'));
  assert.match(finalSql, /held\.pid=pg_backend_pid\(\)/);
  assert.ok(finalSql.indexOf('if observed is distinct from true') < finalSql.indexOf('commit;'));
  final.addendaAudit.pop();
  opens = 0; events.length = 0;
  await assert.rejects(runConcurrentRetification(db), /auditoria/);
});

await check('workflow tem permissões mínimas, timeout e somente artefato de evidência', async () => {
  const workflow = await readFile(join(root, '.github/workflows/sql-integration.yml'), 'utf8');
  const ci = await readFile(join(root, '.github/workflows/ci.yml'), 'utf8');
  assert.match(workflow, /contents: read/); assert.doesNotMatch(workflow, /contents: write|secrets\.|environment:/);
  assert.match(workflow, /persist-credentials: false/); assert.match(workflow, /timeout-minutes: 25/);
  assert.match(workflow, /branches: \[ 'codex\/\*\*' \]/); assert.match(workflow, /branches: \[ main \]/);
  assert.match(workflow, /run: npm ci/); assert.match(workflow, /run: node tests\/local-sql-integration-security\.mjs/);
  assert.match(workflow, /run: node scripts\/run-local-sql-integration\.mjs/);
  const actions = [...workflow.matchAll(/uses:\s*([^\s]+)@([a-f0-9]{40})/g)];
  assert.equal(actions.length, 3);
  for (const [, name, sha] of actions) assert.ok(ci.includes(`${name}@${sha}`));
  assert.deepEqual([...workflow.matchAll(/^\s+path:\s*(.+)$/gm)].map(match => match[1]), ['artifacts/local-sql-integration-evidence.json']);
});

console.log(`✓ ${checks} grupos de segurança do executor SQL local; PostgreSQL real é verificado pelo workflow Docker.`);
