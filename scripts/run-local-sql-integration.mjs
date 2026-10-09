import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PROJECT_PATTERN = /^soft-anestesia-sql-[a-f0-9]{24}$/;
const CLI_VERSION = '2.119.0';
const FIXTURES = ['tests/sql/retification-cas-security.sql', 'tests/sql/finalized-delete-security.sql'];
const hash = value => createHash('sha256').update(value).digest('hex');
const fail = message => { throw new Error(message); };

// No inherited database, Docker context or Supabase account can select a target.
export function assertSafeEnvironment(env) {
  for (const [key, value] of Object.entries(env)) {
    if (value && (/^(?:SUPABASE_|PG|DOCKER_)/i.test(key)
      || /^(?:DB_URL|DATABASE_URL|DB_HOST|DB_PORT|DB_NAME|DB_USER|DB_PASSWORD|POSTGRES_.*)$/i.test(key))) {
      fail('Ambiente contém configuração de alvo ou credencial proibida.');
    }
  }
}

export function assertLocalDatabaseUrl(raw) {
  if (typeof raw !== 'string' || !/^(?:postgres|postgresql):\/\/postgres:[^@/?#\s]+@(?:127\.0\.0\.1|localhost|\[::1\]):54322\/postgres$/.test(raw)) {
    fail('DB_URL da CLI deve apontar exclusivamente para o PostgreSQL local esperado.');
  }
  const url = new URL(raw);
  if (!['postgres:', 'postgresql:'].includes(url.protocol)
    || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    || url.port !== '54322' || url.pathname !== '/postgres'
    || url.username !== 'postgres' || !url.password || url.search || url.hash) {
    fail('DB_URL local inválida.');
  }
}

export function assertProjectContainer(inspection, projectId) {
  if (!PROJECT_PATTERN.test(projectId)) fail('Identidade do projeto efêmero inválida.');
  const entry = Array.isArray(inspection) && inspection.length === 1 ? inspection[0] : null;
  if (!entry || entry.Name !== `/supabase_db_${projectId}`
    || entry.Config?.Labels?.['com.supabase.cli.project'] !== projectId
    || entry.State?.Running !== true || !/^[a-f0-9]{64}$/.test(entry.Id)
    || !entry.NetworkSettings?.Ports?.['5432/tcp']?.some(binding => binding.HostPort === '54322')) {
    fail('Container PostgreSQL não pertence ao projeto local efêmero esperado.');
  }
  return entry.Id;
}

export function assertCommandSuccess(result, label, sql = '') {
  if (!result || result.code !== 0) {
    const error = new Error(`Comando local falhou: ${label}.`);
    // Expose only SQLSTATE and a known RAISE literal from the reviewed source.
    // Substituted values, status JSON, SQL input, environment and raw logs stay private.
    const code = result?.stderr?.match(/\bERROR:\s+([0-9A-Z]{5})\b/);
    if (code) error.sqlState = code[1];
    const message = result?.stderr?.match(/\bERROR:\s+[0-9A-Z]{5}:\s*([^\r\n]*)/)?.[1];
    if (message && typeof sql === 'string') {
      const escapeRegex = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      for (const match of sql.matchAll(/\braise\s+exception\s+'((?:''|[^'])*)'/gi)) {
        const literal = match[1].replaceAll("''", "'");
        const pattern = new RegExp(`^${literal.split('%').map(escapeRegex).join('.*')}$`);
        if (pattern.test(message) && !/(?:[a-z]+:\/\/|[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}|eyJ[a-z0-9_-]{20})/i.test(literal)) {
          error.assertion = literal.replace(/\s+/g, ' ').slice(0, 120);
          break;
        }
      }
    }
    throw error;
  }
  return result;
}

export function migrationSqlForEmptyDatabase(path, sql, emptyVerified) {
  if (path !== 'database/migrations/0026_e1_performance_indexes.sql') return sql;
  if (emptyVerified !== true) fail('Derivação de índices requer baseline local vazia verificada.');
  // Only a disposable, initially empty database uses this derivative. Original
  // source and its recorded SHA are never rewritten; production retains CONCURRENTLY.
  return sql.replace(/\bcreate index concurrently\b/gi, 'create index');
}

export async function loadMigrationPlan(repoDir = rootDir) {
  const manifest = JSON.parse(await readFile(join(repoDir, 'database/migration-baseline.json'), 'utf8'));
  assert.equal(manifest.remoteApplyAllowed, false, 'baseline deve continuar bloqueando aplicação remota');
  const files = (await readdir(join(repoDir, 'database/migrations')))
    .filter(name => /^\d{4}_.+\.sql$/.test(name)).sort();
  assert.equal(files.length, 32, 'executor exige exatamente a baseline 0001–0032');
  files.forEach((file, i) => assert.equal(file.slice(0, 4), String(i + 1).padStart(4, '0')));
  const paths = ['supabase/migrations/0001_assinaturas.sql',
    ...files.map(file => `database/migrations/${file}`),
    'supabase/migrations/0002_assinaturas_hardening.sql'];
  const supabaseFiles = (await readdir(join(repoDir, 'supabase/migrations'))).filter(name => name.endsWith('.sql')).sort();
  assert.deepEqual(supabaseFiles, ['0001_assinaturas.sql', '0002_assinaturas_hardening.sql']);
  const plan = [];
  for (const path of paths) {
    const sql = await readFile(join(repoDir, path), 'utf8');
    const sha256 = hash(sql);
    assert.equal(sha256, manifest.files[path], `Fonte SQL divergiu da baseline: ${path}`);
    plan.push({ path, sql, sha256 });
  }
  return plan;
}

export function isolatedConfig(projectId) {
  if (!PROJECT_PATTERN.test(projectId)) fail('Identidade do projeto efêmero inválida.');
  return `project_id = "${projectId}"
[api]
enabled = true
port = 54321
schemas = ["public", "graphql_public"]
extra_search_path = ["public", "extensions"]
auto_expose_new_tables = false
[db]
port = 54322
shadow_port = 54320
major_version = 17
[db.pooler]
enabled = false
[db.migrations]
enabled = false
schema_paths = []
[db.seed]
enabled = false
sql_paths = []
[realtime]
enabled = true
[studio]
enabled = true
port = 54323
api_url = "http://127.0.0.1"
[local_smtp]
enabled = true
port = 54324
[storage]
enabled = true
[auth]
enabled = true
site_url = "http://127.0.0.1:3000"
enable_signup = false
[analytics]
enabled = false
[edge_runtime]
enabled = true
`;
}

function openProcess(command, args, { env, cwd, timeoutMs = 120000, input, keepOpen = false } = {}) {
  const child = spawn(command, args, { env, cwd, stdio: ['pipe', 'pipe', 'pipe'], shell: false });
  let stdout = ''; let stderr = ''; let size = 0;
  const waiters = new Set();
  const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
  for (const [stream, name] of [[child.stdout, 'stdout'], [child.stderr, 'stderr']]) {
    stream.setEncoding('utf8');
    stream.on('data', chunk => {
      size += Buffer.byteLength(chunk);
      if (size > 16 * 1024 * 1024) { child.kill('SIGKILL'); return; }
      if (name === 'stdout') stdout += chunk; else stderr += chunk;
      for (const waiter of waiters) if (stdout.includes(waiter.marker)) { waiter.resolve(); waiters.delete(waiter); }
    });
  }
  // psql may exit while its peer is still writing. This is a failure, not an
  // unhandled EPIPE or a reason to downgrade a security assertion.
  child.stdin.on('error', () => {});
  const done = new Promise(resolveDone => {
    let settled = false;
    const settle = code => {
      if (settled) return; settled = true; clearTimeout(timer);
      for (const waiter of waiters) waiter.reject(new Error('Sessão SQL terminou antes da barreira.'));
      waiters.clear(); resolveDone({ code, stdout, stderr });
    };
    child.on('error', () => settle(-1));
    child.on('close', code => settle(code ?? -1));
  });
  if (input) child.stdin.write(input);
  if (!keepOpen) child.stdin.end();
  return {
    done,
    write: sql => child.stdin.write(sql),
    end: sql => child.stdin.end(sql),
    kill: () => child.kill('SIGKILL'),
    waitFor: marker => stdout.includes(marker) ? Promise.resolve() : new Promise((resolveWait, reject) => {
      waiters.add({ marker, resolve: resolveWait, reject });
    })
  };
}

async function runProcess(command, args, options) { return openProcess(command, args, options).done; }

const psqlArgs = containerId => ['exec', '--user', 'postgres', '-i', containerId, 'psql',
  '--no-psqlrc', '--host=/var/run/postgresql', '--port=5432', '--username=supabase_admin', '--dbname=postgres',
  '--set=ON_ERROR_STOP=1', '--set=VERBOSITY=verbose', '--quiet', '--tuples-only', '--no-align', '--file=-'];

// Validation returns a capability for exactly one Docker-local DB. The CLI's
// connection string is only checked, never passed to psql or written to disk.
export function createPsqlExecutor({ status, inspection, projectId, inheritedEnv = {}, env, cwd,
  execute = runProcess, open = openProcess }) {
  assertSafeEnvironment(inheritedEnv);
  if (env?.DOCKER_HOST !== 'unix:///var/run/docker.sock'
    || Object.keys(env).some(key => /^DOCKER_/i.test(key) && !['DOCKER_HOST', 'DOCKER_CONFIG'].includes(key))) {
    fail('Executor exige exclusivamente o socket Docker local.');
  }
  assertLocalDatabaseUrl(status?.DB_URL);
  const containerId = assertProjectContainer(inspection, projectId);
  const validate = async () => {
    const result = assertCommandSuccess(await execute('docker', ['inspect', '--type', 'container', `supabase_db_${projectId}`], { env, cwd }), 'identidade do container');
    let current; try { current = JSON.parse(result.stdout); } catch { fail('Inspeção Docker inválida.'); }
    assert.equal(assertProjectContainer(current, projectId), containerId, 'container foi substituído durante o teste');
  };
  return {
    async run(sql, label) {
      await validate();
      return assertCommandSuccess(await execute('docker', psqlArgs(containerId), { env, cwd, input: sql }), label, sql);
    },
    async open(sql) {
      await validate();
      return open('docker', psqlArgs(containerId), { env, cwd, input: sql, keepOpen: true, timeoutMs: 45000 });
    }
  };
}

const EMPTY_BASELINE_SQL = `do $verify$
begin
  if current_database() is distinct from 'postgres' or current_user is distinct from 'supabase_admin'
     or current_setting('server_version_num')::integer / 10000 <> 17 then
    raise exception 'Unexpected local database identity';
  end if;
  if (select rolsuper from pg_roles where rolname=current_user) is distinct from true
     or not exists (select 1 from pg_roles where rolname='authenticated' and not rolsuper and not rolbypassrls)
     or not exists (select 1 from pg_roles where rolname='postgres') then
    raise exception 'Stock local admin and authenticated role capabilities unavailable';
  end if;
  if exists (select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
             where n.nspname='public' and c.relkind in ('r','p','v','m','f','S'))
     or exists (select 1 from auth.users) then
    raise exception 'Disposable baseline must be empty';
  end if;
end $verify$;
create schema if not exists extensions;
create extension if not exists pgcrypto with schema public;
alter extension pgcrypto set schema public;
create extension if not exists unaccent with schema public;
alter extension unaccent set schema public;
create extension if not exists pg_trgm with schema public;
alter extension pg_trgm set schema public;
do $verify$
begin
  if to_regprocedure('public.digest(text,text)') is null
     or to_regprocedure('public.unaccent(regdictionary,text)') is null
     or to_regprocedure('public.similarity(text,text)') is null then
    raise exception 'Historical extension schema prerequisites unavailable';
  end if;
end $verify$;
`;

const RACE_ORG = 'fc220000-0000-4000-8000-000000000001';
const RACE_PARENT = 'fc330000-0000-4000-8000-000000000001';
const RACE_USERS = ['fc110000-0000-4000-8000-000000000001', 'fc110000-0000-4000-8000-000000000002'];

function raceWriter(index) {
  const actor = RACE_USERS[index]; const letter = index === 0 ? 'a' : 'b';
  return `begin isolation level read committed;
set local statement_timeout='30s';
set local lock_timeout='20s';
set local application_name='soft_anestesia_sql_race_${letter}';
select set_config('request.jwt.claim.sub','${actor}',true);
select set_config('request.jwt.claims','{"sub":"${actor}","role":"authenticated"}',true);
set local role authenticated;
insert into public.addenda(organization_id,parent_table,parent_id,legacy_id,texto,reason,data)
values ('${RACE_ORG}','preanesthetic_assessments','${RACE_PARENT}','local-race-${letter}',
 'Synthetic concurrent ${letter}','correcao',
 '{"retificacao":{"schema":1,"baseAdendoId":"","campos":{"alergias":"Synthetic ${letter}"}}}');
`;
}

export async function runConcurrentRetification(db) {
  await db.run(`begin;
insert into auth.users(id,email) values
 ('${RACE_USERS[0]}','local-race-a@example.invalid'),('${RACE_USERS[1]}','local-race-b@example.invalid');
insert into public.organizations(id,nome) values ('${RACE_ORG}','Synthetic concurrent organization');
insert into public.organization_users(organization_id,user_id,role,ativo) values
 ('${RACE_ORG}','${RACE_USERS[0]}','gestor',true),('${RACE_ORG}','${RACE_USERS[1]}','gestor',true);
select set_config('request.jwt.claim.sub','${RACE_USERS[0]}',true);
select set_config('request.jwt.claims','{"sub":"${RACE_USERS[0]}","role":"authenticated"}',true);
set local role authenticated;
insert into public.preanesthetic_assessments(id,organization_id,legacy_id,status,data)
values ('${RACE_PARENT}','${RACE_ORG}','local-race-parent','finalized',
 '{"nome":"Synthetic concurrent original","_finalizado":true}');
commit;
`, 'setup sintético da concorrência');
  const before = await db.run(`select jsonb_build_object('parent',to_jsonb(p),'audit',
 (select coalesce(jsonb_agg(to_jsonb(a) order by a.id),'[]'::jsonb) from public.audit_logs a where a.record_id=p.id))
 from public.preanesthetic_assessments p where p.id='${RACE_PARENT}';`, 'snapshot do original');
  let snapshot; try { snapshot = JSON.parse(before.stdout.trim()); } catch { fail('Snapshot do original ausente.'); }
  if (!snapshot?.parent?.finalized_at || !Array.isArray(snapshot.audit) || snapshot.audit.length !== 1) fail('Original finalizado ou auditoria inicial ausente.');
  let a; let b;
  try {
    a = await db.open(`${raceWriter(0)}\\echo LOCAL_SQL_RACE_A_HELD\n`);
    await a.waitFor('LOCAL_SQL_RACE_A_HELD');
    b = await db.open(`${raceWriter(1)}commit;\n\\q\n`);
    b.end();
    // The authenticated INSERT already exercised RLS. Restore the stock local
    // admin only for lock observation; no authenticated ACL is widened.
    a.end(`reset role;
do $barrier$
declare observed boolean := false;
begin
  for attempt in 1..200 loop
    select exists (
      select 1 from pg_locks waiting
      join pg_locks held on held.locktype=waiting.locktype
       and held.database is not distinct from waiting.database
       and held.classid=waiting.classid and held.objid=waiting.objid and held.objsubid=waiting.objsubid
      join pg_stat_activity activity on activity.pid=waiting.pid
      where waiting.locktype='advisory' and not waiting.granted and held.granted
       and held.pid=pg_backend_pid() and activity.application_name='soft_anestesia_sql_race_b'
    ) into observed;
    exit when observed;
    perform pg_sleep(0.05);
  end loop;
  if observed is distinct from true then raise exception 'Concurrent writer never waited on the held advisory lock'; end if;
end $barrier$;
\\echo LOCAL_SQL_RACE_OVERLAP
commit;
\\q
`);
    const [resultA, resultB] = await Promise.all([a.done, b.done]);
    assertCommandSuccess(resultA, 'sessão concorrente A');
    assertCommandSuccess(resultB, 'sessão concorrente B');
    if (!resultA.stdout.includes('LOCAL_SQL_RACE_OVERLAP')) fail('Barreira de concorrência não foi observada.');
  } finally {
    a?.kill(); b?.kill();
    await Promise.allSettled([a?.done, b?.done].filter(Boolean));
  }
  const after = await db.run(`select jsonb_build_object('parent',to_jsonb(p),'audit',
 (select coalesce(jsonb_agg(to_jsonb(a) order by a.id),'[]'::jsonb) from public.audit_logs a where a.record_id=p.id),
 'addenda',(select jsonb_agg(to_jsonb(a) order by a.legacy_id) from public.addenda a where a.parent_id=p.id),
 'addendaAudit',(select jsonb_agg(to_jsonb(l) order by l.record_id) from public.audit_logs l
  where l.record_id in (select id from public.addenda where parent_id=p.id)))
 from public.preanesthetic_assessments p where p.id='${RACE_PARENT}';`, 'invariantes após concorrência');
  let result; try { result = JSON.parse(after.stdout.trim()); } catch { fail('Resultado da concorrência ausente.'); }
  assert.deepEqual(result.parent, snapshot.parent, 'original finalizado foi alterado');
  assert.deepEqual(result.audit, snapshot.audit, 'auditoria do original foi alterada');
  assert.equal(result.addenda?.length, 2, 'ambas as propostas devem ser preservadas');
  assert.equal(result.addendaAudit?.length, 2, 'ambas as propostas exigem auditoria');
  const accepted = result.addenda.filter(row => row.data?.retificacao?.status === 'accepted');
  const conflict = result.addenda.filter(row => row.data?.retificacao?.status === 'conflict');
  assert.equal(accepted.length, 1); assert.equal(conflict.length, 1);
  assert.equal(accepted[0].retification_revision, 1);
  assert.equal(accepted[0].data.retificacao.baseAdendoId, '');
  assert.equal(conflict[0].retification_revision, null);
  assert.equal(conflict[0].data.retificacao.baseAtualId, accepted[0].legacy_id);
  assert.equal(conflict[0].data.retificacao.baseAdendoId, '');
  for (let i = 0; i < 2; i++) {
    const row = result.addenda[i]; const letter = i === 0 ? 'a' : 'b';
    assert.equal(row.legacy_id, `local-race-${letter}`);
    assert.equal(row.author_id, RACE_USERS[i]);
    assert.equal(row.parent_id, RACE_PARENT); assert.equal(row.organization_id, RACE_ORG);
    assert.equal(row.data.retificacao.campos.alergias, `Synthetic ${letter}`);
    const audit = result.addendaAudit.find(entry => entry.record_id === row.id);
    assert.ok(audit); assert.equal(audit.action, 'insert'); assert.equal(audit.user_id, row.author_id);
    assert.deepEqual(audit.new_value, row, 'auditoria deve preservar a proposta inteira');
  }
  return { accepted: 1, conflict: 1, blockedSessions: 1 };
}

export async function runLocalSqlIntegration({ repoDir = rootDir, inheritedEnv = process.env, execute = runProcess } = {}) {
  assertSafeEnvironment(inheritedEnv);
  const plan = await loadMigrationPlan(repoDir);
  const fixtures = [];
  for (const path of FIXTURES) {
    const sql = await readFile(join(repoDir, path), 'utf8');
    if (!/^begin\b/im.test(sql) || !/\brollback;\s*$/i.test(sql)) fail('Fixture SQL deve usar transação com ROLLBACK.');
    fixtures.push({ path, sql, sha256: hash(sql) });
  }
  const cli = join(repoDir, 'node_modules/.bin/supabase');
  await access(cli);
  const workdir = await mkdtemp(join(tmpdir(), 'soft-anestesia-sql-'));
  const projectId = `soft-anestesia-sql-${randomBytes(12).toString('hex')}`;
  const env = { PATH: inheritedEnv.PATH, HOME: inheritedEnv.HOME, TMPDIR: workdir, LANG: 'C.UTF-8',
    DOCKER_HOST: 'unix:///var/run/docker.sock', DOCKER_CONFIG: join(workdir, 'docker-config'),
    SUPABASE_SKIP_UPDATE_CHECK: 'true', SUPABASE_TELEMETRY_DISABLED: 'true' };
  const evidence = {
    schema: 1,
    hashes: Object.fromEntries([...plan, ...fixtures].map(entry => [entry.path, entry.sha256])),
    tests: [],
    counters: { migrations: 0, fixtures: 0, accepted: 0, conflict: 0, blockedSessions: 0 },
    localSqlVerified: false, stagingVerified: false, realAuthApiVerified: false, productionVerified: false
  };
  let startAttempted = false; let failure; let stage = 'prepare-local-project';
  const checked = async (command, args, label, options = {}) => {
    stage = label;
    return assertCommandSuccess(await execute(command, args, { env, cwd: workdir, ...options }), label);
  };
  try {
    await mkdir(join(workdir, 'supabase'));
    await mkdir(env.DOCKER_CONFIG);
    await writeFile(join(workdir, 'supabase/config.toml'), isolatedConfig(projectId), { mode: 0o600 });
    const version = await checked(cli, ['--version'], 'versão da CLI');
    assert.equal(version.stdout.trim(), CLI_VERSION, 'CLI deve usar a versão fixada no lockfile');
    const top = await checked(cli, ['--help'], 'help da CLI');
    if (!top.stdout.includes('--workdir')) fail('CLI não documentou isolamento por workdir.');
    const help = {};
    for (const command of ['start', 'status', 'stop']) help[command] = (await checked(cli, [command, '--help'], `help de ${command}`)).stdout;
    if (!(help.status.includes('--output') || top.stdout.includes('--output')) || !help.stop.includes('--no-backup')) fail('CLI não documentou flags locais necessárias.');
    await checked('docker', ['info', '--format', '{{.ServerVersion}}'], 'Docker local');
    startAttempted = true;
    await checked(cli, ['start', '--workdir', workdir], 'inicialização do Supabase local', { timeoutMs: 12 * 60 * 1000 });
    const raw = await checked(cli, ['status', '--workdir', workdir, '--output', 'json'], 'status local');
    let status; try { status = JSON.parse(raw.stdout); } catch { fail('Status JSON da CLI inválido.'); }
    assertLocalDatabaseUrl(status.DB_URL);
    const inspected = await checked('docker', ['inspect', '--type', 'container', `supabase_db_${projectId}`], 'identidade PostgreSQL');
    let inspection; try { inspection = JSON.parse(inspected.stdout); } catch { fail('Inspeção Docker inválida.'); }
    const db = createPsqlExecutor({ status, inspection, projectId, inheritedEnv, env, cwd: workdir, execute });
    stage = 'empty-local-baseline-and-extension-schemas';
    await db.run(EMPTY_BASELINE_SQL, stage);
    evidence.tests.push({ name: 'empty-local-baseline-and-extension-schemas', passed: true });
    for (const entry of plan) {
      stage = entry.path;
      await db.run(`set search_path=public,extensions;\n${migrationSqlForEmptyDatabase(entry.path, entry.sql, true)}`, entry.path);
      evidence.counters.migrations++;
    }
    stage = 'hardened-extension-schemas';
    await db.run(`do $verify$ begin
      if (select count(*) from pg_extension e join pg_namespace n on n.oid=e.extnamespace
          where e.extname in ('pgcrypto','unaccent','pg_trgm') and n.nspname='extensions') <> 3 then
        raise exception 'Hardened extension schemas were not preserved';
      end if;
    end $verify$;`, 'schemas finais das extensões');
    evidence.tests.push({ name: 'ordered-migrations-0001-through-0032-and-signature-hardening', passed: true });
    for (const fixture of fixtures) {
      stage = fixture.path;
      await db.run(fixture.sql, fixture.path);
      evidence.counters.fixtures++;
      evidence.tests.push({ name: fixture.path, passed: true });
    }
    stage = 'two-session-retification-cas-observed-advisory-lock';
    Object.assign(evidence.counters, await runConcurrentRetification(db));
    evidence.tests.push({ name: 'two-session-retification-cas-observed-advisory-lock', passed: true });
    evidence.localSqlVerified = true;
  } catch (error) {
    const sqlState = /^[0-9A-Z]{5}$/.test(error.sqlState ?? '') ? ` (SQLSTATE ${error.sqlState})` : '';
    const assertion = error.assertion ? ` [${error.assertion}]` : '';
    failure = new Error(`Integração SQL local falhou em ${stage}${sqlState}${assertion}; nenhuma verificação remota foi declarada.`);
    evidence.tests.push({ name: stage, passed: false });
  } finally {
    if (startAttempted) {
      try {
        await checked(cli, ['stop', '--workdir', workdir, '--no-backup'], 'limpeza exclusiva do projeto efêmero', { timeoutMs: 90000 });
        evidence.tests.push({ name: 'ephemeral-project-cleanup', passed: true });
      } catch {
        evidence.localSqlVerified = false;
        evidence.tests.push({ name: 'ephemeral-project-cleanup', passed: false });
        failure = new Error('Limpeza do projeto SQL efêmero falhou.');
      }
    }
    await rm(workdir, { recursive: true, force: true });
    await mkdir(join(repoDir, 'artifacts'), { recursive: true });
    await writeFile(join(repoDir, 'artifacts/local-sql-integration-evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  }
  if (failure) throw failure;
  return evidence;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 2) fail('Executor local não aceita argumentos ou configuração de alvo.');
  runLocalSqlIntegration().then(evidence => {
    console.log(`✓ SQL local: ${evidence.counters.migrations} migrações, ${evidence.counters.fixtures} fixtures e concorrência 1 accepted / 1 conflict.`);
  }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
