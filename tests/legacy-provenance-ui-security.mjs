/**0034 UI contracts. Synthetic RPC responses; real PostgreSQL proof is separate. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { publicAssets } from '../scripts/public-assets.mjs';
import { readRuntimeComposition } from './helpers/read-app-source.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const arg = process.argv.find(value => value.startsWith('--app-root='));
const appRoot = arg ? resolve(process.cwd(), arg.slice('--app-root='.length)) : repo;
const source = await readFile(resolve(appRoot, 'src/ui/legacy-provenance.js'), 'utf8');
const html = await readRuntimeComposition(appRoot);
const clone = value => JSON.parse(JSON.stringify(value));
const A = 'f1100000-0000-4000-8000-000000000001';
const B = 'f1100000-0000-4000-8000-000000000002';
const OWNER = 'f1100000-0000-4000-8000-000000000003';
const ORG = 'f2200000-0000-4000-8000-000000000001';
const OTHER = 'f2200000-0000-4000-8000-000000000002';
const ROW = 'f3300000-0000-4000-8000-000000000001';
const ROW2 = 'f3300000-0000-4000-8000-000000000002';
const TARGET = 'f4400000-0000-4000-8000-000000000001';
const BIND = 'f5500000-0000-4000-8000-000000000001';
const HASH = 'a'.repeat(64);
const picked = { sourceUser: OWNER, organization: ORG, scope: 'unstamped_only' };
const evidence = { statement: 'Synthetic owner confirms only this exact clinic', reference: 'synthetic-owner-statement', reviewed: true };
const window = { addEventListener() {} };
const sandbox = vm.createContext({ window });
vm.runInContext(source, sandbox, { filename: 'legacy-provenance.js' });
const api = window.SoftLegacyProvenance;
assert(publicAssets.includes('src/ui/legacy-provenance.js'));
assert.match(html, /src="src\/ui\/legacy-provenance\.js"/);
assert.match(html, /SoftLegacyProvenance\.mount\(\{/);
assert.match(html, /SoftLegacyProvenance\.perform\('classify'\)/);
assert.match(html, /SoftLegacyProvenance\.perform\('copy'\)/);
assert.match(html, /SoftLegacyProvenance\.perform\('validate'\)/);
assert.doesNotMatch(source, /localStorage|sessionStorage|innerHTML|setAttribute\(['"]on|source_doc_id|documentos\?select/);

function fixture() {
  let uid = A, generation = 1, authorized = true, authenticated = true;
  let recorded = null, scopeAllowed = true;
  const calls = [], rows = [{ registry_id: ROW, source_user_id: OWNER, source_module: 'pre',
    source_hash: HASH, organization_id: null, target_table: 'preanesthetic_assessments', status: 'quarantined' }];
  const responses = new Map();
  const deps = {
    captureAuth: () => authenticated ? { userId: uid, context: { generation, userId: uid } } : null,
    isCurrent: snapshot => authenticated && snapshot.userId === uid && snapshot.context.generation === generation,
    rows: () => rows,
    request: async path => {
      calls.push({ type: 'request', path });
      if (path.startsWith('app_programmers?')) return authorized ? [{ user_id: uid }] : [];
      return recorded ? [clone(recorded)] : [];
    },
    rpc: async (name, args) => {
      calls.push({ type: 'rpc', name, args: clone(args) });
      if (responses.has(name)) return responses.get(name)(args);
      if (name === 'prog_legacy_provenance_preview') return { source_count: 2, source_manifest_hash: HASH, source_scope: args.p_scope };
      if (name === 'prog_bind_legacy_provenance') {
        recorded = { id: BIND, source_user_id: args.p_source_user, organization_id: args.p_org, source_scope: args.p_scope,
          source_count: args.p_expected_source_count, source_manifest_hash: args.p_expected_manifest_hash,
          recorded_by: uid, owner_statement: args.p_owner_statement, evidence_reference: args.p_evidence_reference };
        return { binding_id: BIND, source_count: args.p_expected_source_count };
      }
      if (name === 'prog_check_legacy_scope') {
        if (!scopeAllowed) throw new Error('legacy_organization_stamp_mismatch');
        return { binding_id: args.p_binding_id, selected_count: args.p_registry_ids.length, scope_confirmed: true };
      }
      if (name === 'prog_classify_legacy_documents') return { classified: args.p_registry_ids.length };
      if (name === 'prog_bind_legacy_patient') return { registry_id: args.p_registry, patient_mapping_recorded: true };
      if (name === 'prog_bind_legacy_encounter') return { registry_id: args.p_registry, encounter_mapping_recorded: true };
      if (name === 'prog_copy_legacy_documents') return { copied: args.p_registry_ids.length, blocked: 0, failed: 0 };
      if (name === 'prog_validate_legacy_documents') return { validated: args.p_registry_ids.length, blocked: 0 };
      throw new Error('Unexpected RPC ' + name);
    }
  };
  const workflow = api.createWorkflow(deps);
  return { workflow, deps, rows, calls, responses,
    authorization: value => { authorized = value; }, authentication: value => { authenticated = value; },
    switchUser: () => { uid = B; generation++; }, changeContext: () => { generation++; },
    setScopeAllowed: value => { scopeAllowed = value; },
    corruptReceipt: () => { recorded.recorded_by = B; },
    mutations: () => calls.filter(call => call.type === 'rpc' && /classify|copy|validate|bind_legacy_(?:patient|encounter)/.test(call.name)),
    approve: async () => { await workflow.preview(picked); await workflow.bind(picked, evidence); }
  };
}
{
  const f = fixture();
  for (const bad of [{ ...picked, sourceUser: '' }, { ...picked, organization: '' }, { ...picked, scope: '' }]) {
    await assert.rejects(f.workflow.preview(bad));
  }
  assert.equal(f.calls.length, 0, 'no default owner, clinic or scope');
  f.authentication(false); await assert.rejects(f.workflow.preview(picked), /Entre/);
  assert.equal(f.calls.length, 0, 'no request without authenticated session');
  f.authentication(true); f.authorization(false);
  await assert.rejects(f.workflow.preview(picked), /servidor.*programador/);
  assert.equal(f.calls.filter(call => call.type === 'rpc').length, 0, 'email/client visibility cannot authorize RPC');
}
{
  const f = fixture(); await f.workflow.preview(picked);
  const call = f.calls.find(item => item.name === 'prog_legacy_provenance_preview');
  assert.deepEqual(call.args, { p_source_user: OWNER, p_org: ORG, p_scope: 'unstamped_only' });
  for (const proof of [{ ...evidence, reviewed: false }, { ...evidence, statement: '' }, { ...evidence, reference: '' }]) {
    await assert.rejects(f.workflow.bind(picked, proof));
  }
  assert.equal(f.calls.filter(item => item.name === 'prog_bind_legacy_provenance').length, 0);
  await f.workflow.bind(picked, evidence);
  const bind = f.calls.find(item => item.name === 'prog_bind_legacy_provenance');
  assert.equal(bind.args.p_expected_source_count, 2); assert.equal(bind.args.p_expected_manifest_hash, HASH);
  assert.equal(bind.args.p_owner_statement, evidence.statement); assert.equal(bind.args.programmer_id, undefined);
  assert(f.calls.some(item => item.path?.startsWith('legacy_provenance_bindings?id=eq.' + BIND)), 'persisted binding is read back');
  await f.workflow.classify(picked, [ROW, ROW], evidence.statement);
  const classify = f.calls.find(item => item.name === 'prog_classify_legacy_documents');
  assert.deepEqual(classify.args.p_registry_ids, [ROW]); assert.equal(classify.args.p_org, ORG);
  assert(f.calls.findIndex(item => item.name === 'prog_check_legacy_scope') < f.calls.indexOf(classify));
}
{
  const f = fixture(); await f.workflow.preview(picked);
  const request = f.deps.request;
  f.deps.request = async path => {
    if (path.startsWith('legacy_provenance_bindings?')) f.corruptReceipt();
    return request(path);
  };
  await assert.rejects(f.workflow.bind(picked, evidence), /vínculo persistido/);
  assert.equal(f.workflow.state().binding, null);
  await assert.rejects(f.workflow.classify(picked, [ROW], evidence.statement), /declaração/);
  assert.equal(f.mutations().length, 0);
}
{
  const f = fixture(); await f.approve();
  // Same account has a matching-stamp binding from another prior operation.
  // The visible module is plain "pre" but actual payload contains _relOrg.
  // Only the exact immutable binding check can decide this scope safely.
  f.setScopeAllowed(false);
  await assert.rejects(f.workflow.classify(picked, [ROW], evidence.statement), /stamp_mismatch/);
  assert.equal(f.mutations().length, 0, '_relOrg-only source cannot use an earlier binding of another scope');
  f.setScopeAllowed(true);
  for (const invalidate of [
    () => { f.rows[0].source_user_id = B; },
    () => { f.rows[0].source_user_id = OWNER; f.rows[0].organization_id = OTHER; },
    () => { f.rows[0].organization_id = null; f.rows[0].target_table = null; },
    () => { f.rows[0].target_table = 'preanesthetic_assessments'; f.rows[0].source_module = 'pre@' + OTHER; }
  ]) {
    invalidate(); await assert.rejects(f.workflow.classify(picked, [ROW], evidence.statement));
  }
  assert.equal(f.mutations().length, 0, 'wrong owner/clinic/unsupported/stamp never classified');
}
{
  const f = fixture(); await f.approve(); f.rows[0].organization_id = ORG; f.rows[0].status = 'classified';
  await f.workflow.map(picked, [ROW], 'patient', TARGET, evidence.statement);
  await f.workflow.map(picked, [ROW], 'encounter', TARGET, evidence.statement);
  for (const call of f.mutations()) { assert.equal(call.args.p_registry, ROW); assert.equal(call.args.p_reason, evidence.statement); }
  assert.equal(f.mutations()[0].args.p_patient, TARGET); assert.equal(f.mutations()[1].args.p_encounter, TARGET);
  f.rows.push({ ...f.rows[0], registry_id: ROW2 });
  await assert.rejects(f.workflow.map(picked, [ROW, ROW2], 'patient', TARGET, evidence.statement), /exatamente uma/);
  const result = await f.workflow.copy(picked, [ROW]); assert.deepEqual(clone(result), { copied: 1, blocked: 0, failed: 0 });
  f.rows[0].status = 'copied'; await f.workflow.validate(picked, [ROW]);
  f.responses.set('prog_validate_legacy_documents', () => ({ validated: 0, blocked: 1 }));
  assert.deepEqual(clone(await f.workflow.validate(picked, [ROW])), { validated: 0, blocked: 1 });
  f.responses.set('prog_copy_legacy_documents', () => ({ copied: 99, blocked: 0, failed: 0 }));
  await assert.rejects(f.workflow.copy(picked, [ROW]), /todas as linhas/);
}
{
  const f = fixture(); await f.approve(); f.workflow.invalidateEvidence();
  assert.equal(f.workflow.state().binding, null); assert(f.workflow.state().preview);
  await assert.rejects(f.workflow.classify(picked, [ROW], evidence.statement), /declaração/);
  await f.workflow.bind(picked, evidence); f.changeContext();
  await assert.rejects(f.workflow.classify(picked, [ROW], evidence.statement), /declaração|mudou/);
  assert.equal(f.mutations().length, 0);
}
{
  const f = fixture(); let release, started;
  const pending = new Promise(resolve => { release = resolve; });
  const signal = new Promise(resolve => { started = resolve; });
  f.responses.set('prog_legacy_provenance_preview', async () => { started(); await pending; return { source_count: 2, source_manifest_hash: HASH, source_scope: picked.scope }; });
  const operation = f.workflow.preview(picked); await signal;
  await assert.rejects(f.workflow.preview(picked), /Aguarde/);
  f.switchUser(); release(); await assert.rejects(operation, /mudou/);
  assert.equal(f.workflow.state().preview, null, 'old session response cannot authorize or display a new user');
}
{
  const f = fixture(); await f.approve(); f.rows[0].organization_id = ORG; f.rows[0].status = 'classified';
  let release, started;
  const pending = new Promise(resolve => { release = resolve; });
  const signal = new Promise(resolve => { started = resolve; });
  f.responses.set('prog_check_legacy_scope', async args => { started(); await pending; return { binding_id: args.p_binding_id, selected_count: 1, scope_confirmed: true }; });
  const operation = f.workflow.copy(picked, [ROW]); await signal; f.workflow.reset(); release();
  await assert.rejects(operation, /mudou/);
  assert.equal(f.mutations().length, 0, 'selection changed during scope check stops the clinical mutation');
}

// Actual mount uses textContent and event listeners, including hostile labels.
{
  const fields = new Map();
  class Element {
    constructor(tag) { this.tagName = tag; this.children = []; this.events = {}; this.value = ''; this.textContent = ''; this.checked = false; }
    set id(value) { this._id = value; fields.set(value, this); } get id() { return this._id; }
    set innerHTML(value) { throw new Error('unsafe HTML assignment: ' + value); }
    appendChild(child) { this.children.push(child); return child; }
    replaceChildren(...children) { this.children = children; }
    setAttribute(key, value) { assert(!key.startsWith('on')); this[key] = value; }
    addEventListener(name, handler) { this.events[name] = handler; }
  }
  const document = { createElement: tag => new Element(tag), getElementById: id => fields.get(id) || null };
  for (const [id, value] of [['prog-legado-proveniencia', ''], ['prog-legado-user', OWNER], ['prog-legado-org', ORG]]) {
    const el = new Element('div'); el.id = id; el.value = value;
  }
  const f = fixture(); let changeContext;
  window.document = document;
  const admin = { souProgramador: () => true, _req: f.deps.request, _rpc: f.deps.rpc,
    _legacyItems: f.rows, _legacySelecionados: () => [ROW], _legacyJustificativa: () => evidence.statement,
    _nomeOrg: () => '<img src=x onerror=alert(1)>', _legacyResultado() {}, _legacyErro() {},
    carregarResumoLegado: async () => {}, carregarItensLegado: async () => {} };
  api.mount({ document, programador: admin, cloud: { session: () => ({ access_token: 'synthetic-session', user: { id: A } }) },
    contextoAba: { capturar: () => ({ userId: A, generation: 1 }), mesmaGeracao: () => true, aoMudar: handler => { changeContext = handler; } }, confirm: () => true });
  fields.get('prog-legado-scope').value = 'unstamped_only';
  await api.perform('preview');
  assert(fields.get('prog-legado-manifesto').textContent.includes('<img src=x onerror=alert(1)>'));
  fields.get('prog-legado-owner-statement').value = evidence.statement;
  fields.get('prog-legado-evidence-reference').value = evidence.reference;
  fields.get('prog-legado-proof-reviewed').checked = true;
  await api.perform('bind');
  assert.match(fields.get('prog-legado-proveniencia-estado').textContent, /conferidos na nuvem/);
  f.rows[0].status = 'classified'; f.rows[0].organization_id = ORG;
  f.responses.set('prog_copy_legacy_documents', () => ({ copied: 0, blocked: 1, failed: 0 }));
  await api.perform('copy');
  assert.match(fields.get('prog-legado-proveniencia-estado').textContent, /1 bloqueio/);
  fields.get('prog-legado-evidence-reference').events.input();
  assert.equal(fields.get('prog-legado-proof-reviewed').checked, false);
  const before = f.mutations().length; await api.perform('classify'); assert.equal(f.mutations().length, before);
  changeContext({ userId: B, generation: 2 }, { userId: A, generation: 1 });
  assert.equal(fields.get('prog-legado-proveniencia').children.length, 0, 'administrative evidence leaves DOM on account change');
}
console.log('✓ Legacy provenance UI: exact owner/clinic/scope, authenticated server permission, immutable evidence, explicit mapping, partial results and stale-context protection');
