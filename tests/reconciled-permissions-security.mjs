import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const source = await readFile(new URL('../database/migrations/0033_reconciled_permissions.sql', import.meta.url), 'utf8');
function review(sql) {
  const code = sql.replace(/--[^\n]*/g, '');
  assert.match(code, /^\s*begin;/i);
  assert.match(code, /commit;\s*$/i);
  assert.doesNotMatch(code, /\bgrant\s+(?:all|select|insert|update|delete|truncate|execute|usage)\b/i);
  assert.doesNotMatch(code, /\balter\s+(?:function|table|role|user)\b|\bdrop\s+(?:table|function|policy|trigger)\b/i);
  assert.doesNotMatch(code, /(?:^|;)\s*(?:delete|truncate|insert|update)\b/im);
  assert.match(code, /current_user <> 'postgres'/);
  for (const creator of ['postgres']) {
    for (const [object,rights] of [['tables','all'],['sequences','all'],['functions','execute']]) {
      assert.match(code,new RegExp(`alter default privileges for role ${creator}\\s+revoke ${rights} on ${object} from public, anon, authenticated, service_role;`,'i'));
    }
  }
  assert.match(code, /foreach creator in array array\['postgres'\]/);
  assert.match(code, /foreach target_schema in array array\['public','app'\]/);
  for (const object of ['tables','sequences','functions']) {
    assert.match(code,new RegExp(`in schema %I '[\\s\\S]*?'revoke (?:all|execute) on ${object} from public, anon, authenticated, service_role`,'i'));
  }
  assert.match(code, /create temporary table soft_0033_service_crud on commit drop/);
  assert.match(code, /has_table_privilege\('service_role', b\.relation_oid, b\.privilege\)\s+is distinct from b\.allowed/);
  assert.match(code, /c\.relkind in \('r','p'\)/);
  assert.match(code, /revoke truncate on table %I\.%I '\s+'from public, anon, authenticated, service_role/);
  assert.match(code, /has_table_privilege\(target_role, item\.oid, 'TRUNCATE'\)/);
  assert.match(code, /has_sequence_privilege\(target_role,item\.sequence_oid,sequence_privilege\)/);
  assert.match(code, /array\['SELECT','UPDATE','USAGE'\]/);
  assert.match(code, /p\.proname = 'criar_minha_organizacao'/);
  assert.match(code, /has_function_privilege\(target_role,item\.oid,'EXECUTE'\)/);
  assert.match(code, /r\.rolname not in \('postgres','supabase_admin'\)/);
  assert.doesNotMatch(code, /alter default privileges for role supabase_admin/i);
  assert.match(code, /soft_0033_supplier_defaults/);
  assert.match(code, /full join/);
  assert.match(code, /is distinct from \(b\.defaclnamespace,b\.defaclobjtype,b\.defaclacl\)/);
  assert.match(code, /r\.rolname <> 'postgres'/);
  assert.match(code, /pg_has_role\(r\.oid,'supabase_admin','SET'\)/);
}

review(source);
const mutations = [
  source.replace(/alter default privileges for role postgres\s+revoke execute on functions from public, anon, authenticated, service_role;/i,''),
  source.replace(/, authenticated, service_role/g,', authenticated'),
  source.replace("has_sequence_privilege(target_role,item.sequence_oid,sequence_privilege)","false"),
  source.replace("has_table_privilege(target_role, item.oid, 'TRUNCATE')","false"),
  source.replace("is distinct from b.allowed","is not distinct from b.allowed"),
  source.replace("commit;","grant delete on public.patients to service_role;\ncommit;"),
  source.replace("commit;","alter default privileges for role supabase_admin revoke execute on functions from public;\ncommit;"),
];
for (const mutation of mutations) assert.throws(()=>review(mutation));
console.log(`0033 revocation contract reviewed; ${mutations.length} weakened variants rejected; SHA256 ${createHash('sha256').update(source).digest('hex')}`);
