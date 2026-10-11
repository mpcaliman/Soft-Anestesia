import assert from 'node:assert/strict';

const BLOCKED = 'blocked_pending_staging_reconciliation';
const VERIFIED = 'staging_verified';
const PURPOSES = new Set(['integrity', 'local-sql', 'publication']);
const SHA256 = /^[0-9a-f]{64}$/;
const WORKFLOW_URL = /^https:\/\/github\.com\/mpcaliman\/Soft-Anestesia\/actions\/runs\/[1-9]\d*$/;

// Validates a recorded state; it neither verifies remote evidence nor grants a
// database capability. Local executors must retain their own target barriers.
export function assertMigrationBaselineState(manifest, { purpose = 'integrity' } = {}) {
  assert.ok(PURPOSES.has(purpose), 'Finalidade da validação de baseline inválida');
  assert.ok(manifest && typeof manifest === 'object' && !Array.isArray(manifest), 'Baseline ausente ou inválida');
  assert.equal(manifest.schema, 1, 'Versão da baseline não suportada');
  assert.ok([BLOCKED, VERIFIED].includes(manifest.status), 'Estado de baseline não suportado');

  const stagingVerified = manifest.status === VERIFIED;
  assert.equal(manifest.remoteApplyAllowed, stagingVerified, 'Estado e sinalizador da baseline são inconsistentes');
  if (stagingVerified) {
    const evidence = manifest.stagingEvidence;
    assert.ok(evidence && typeof evidence === 'object' && !Array.isArray(evidence), 'Falta evidência de homologação');
    assert.equal(evidence.matrixPassed, true, 'Matriz de homologação não aprovada');
    assert.equal(evidence.authenticatedSessionsPassed, true, 'Sessões reais autenticadas não aprovadas');
    assert.ok(typeof evidence.schemaHash === 'string' && SHA256.test(evidence.schemaHash), 'Hash do schema inválido');
    assert.ok(typeof evidence.workflowUrl === 'string' && WORKFLOW_URL.test(evidence.workflowUrl), 'Execução de homologação inválida');
  }
  if (purpose === 'publication') assert.equal(stagingVerified, true, 'Publicação bloqueada até homologação registrada');

  return Object.freeze({ status: manifest.status, stagingVerified, remoteApplyAllowed: manifest.remoteApplyAllowed });
}

export function assertPublicationDispatch({ eventName, ref, actor, triggeringActor, runAttempt, repository } = {}) {
  assert.equal(eventName, 'workflow_dispatch', 'Publicação exige evento manual real');
  assert.equal(ref, 'refs/heads/main', 'Publicação exige a base confiável main');
  assert.equal(repository, 'mpcaliman/Soft-Anestesia', 'Repositório de publicação inválido');
  assert.equal(actor, 'mpcaliman', 'Publicação exige o proprietário');
  assert.equal(triggeringActor, 'mpcaliman', 'Execução exige disparo do proprietário');
  assert.equal(runAttempt, '1', 'Publicação exige despacho novo, sem reexecução');
}
