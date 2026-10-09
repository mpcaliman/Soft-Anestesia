import assert from 'node:assert/strict';
import { authorizationFor } from '../scripts/verify-owner-authorization.mjs';

const sha = 'a'.repeat(40);
const input = { sha, scope: 'merge', reference: 'G4-audit-v2' };
const comment = {
  user: { login: 'mpcaliman', type: 'User' },
  body: `SOFT-AUTORIZACAO G4-audit-v2 ${sha} merge`,
  created_at: '2026-10-09T10:00:00Z', html_url: 'https://github.com/mpcaliman/Soft-Anestesia/pull/225#issuecomment-test'
};
assert.throws(() => authorizationFor(input));
assert.throws(() => authorizationFor({ ...input, comments: [{ ...comment, user: { login: 'outro' } }] }));
assert.throws(() => authorizationFor({ ...input, sha: 'b'.repeat(40), comments: [comment] }));
assert.throws(() => authorizationFor({ ...input, comments: [{ ...comment, body: comment.body + ' extra' }] }));
assert.equal(authorizationFor({ ...input, comments: [comment] }).owner, 'mpcaliman');
assert.throws(() => authorizationFor({ ...input, comments: [comment, {
  ...comment, body: comment.body.replace('SOFT-AUTORIZACAO', 'SOFT-REVOGACAO'), updated_at: '2026-10-09T11:00:00Z'
}] }));
assert.throws(() => authorizationFor({ ...input, comments: [{ ...comment, body: 'Exemplo\n' + comment.body }] }));
assert.throws(() => authorizationFor({ ...input, reviews: [{ ...comment, state: 'APPROVED', commit_id: sha }] }));
assert.throws(() => authorizationFor({ ...input, scope: 'deploy', comments: [comment] }));
console.log('  ✓ autorização do proprietário exige identidade, escopo e SHA exatos; revogação invalida');
