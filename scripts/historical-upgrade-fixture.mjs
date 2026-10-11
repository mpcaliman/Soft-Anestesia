import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const path='tests/sql/historical-upgrade-preconditions-security.sql';
const hash=value=>createHash('sha256').update(value).digest('hex');
const distribution={preanesthetic_assessments:92,anesthesia_records:167,recovery_records:143,consents:53};

export function historicalFixtureSections(source) {
  const sections={};
  for(const phase of ['SEED','VERIFY']) {
    const start='-- BEGIN HISTORICAL '+phase, end='-- END HISTORICAL '+phase;
    assert.equal(source.split(start).length,2,'Historical phase start must be unique');
    assert.equal(source.split(end).length,2,'Historical phase end must be unique');
    const from=source.indexOf(start)+start.length, to=source.indexOf(end);
    assert.ok(from<to,'Historical phase boundaries are reversed');
    const sql=source.slice(from,to);
    assert.match(sql,/^\s*begin;/i);
    assert.match(sql,phase==='SEED'?/commit;\s*$/i:/rollback;\s*$/i);
    sections[phase.toLowerCase()]={sql,sha256:hash(sql)};
  }
  assert.ok(source.indexOf('-- END HISTORICAL SEED')<source.indexOf('-- BEGIN HISTORICAL VERIFY'));
  return {path,sha256:hash(source),...sections};
}

export async function loadHistoricalUpgradeFixture(repoDir) {
  return historicalFixtureSections(await readFile(join(repoDir,path),'utf8'));
}

export function historicalFixtureEvidence(stdout,fixture) {
  let raw;try{raw=JSON.parse(stdout.trim());}catch{throw new Error('Historical fixture must return one safe JSON result');}
  assert.ok(raw&&typeof raw==='object'&&!Array.isArray(raw),'Historical fixture response must be an object');
  const evidence={};
  for(const [key,expected] of Object.entries({verified:true,historicalOriginals:455,historicalAdenda:2,
    historicalSignatures:1,authRows:3,patientRows:1,encounterRows:1,addendaRows:2,signatureRows:1,
    clinicalRows:459,backfillFinalizationAuditRows:455,payloadAndLinksPreserved:true,
    historicalTimestampAndAuthorPreserved:true,historicalAdendaNotCasHeads:true,
    historicalSignaturesUnassignedAndImmutable:true,administrativeFinalizedDeletionDenied:true,
    replicaFinalizedDeletionDenied:true,productionMutated:false})) {
    assert.equal(raw[key],expected,'Historical preservation/count criterion failed');evidence[key]=expected;
  }
  assert.ok(Number.isInteger(raw.priorAuditRowsRetained)&&raw.priorAuditRowsRetained>=455,
    'Earlier synthetic audit must remain present');
  evidence.priorAuditRowsRetained=raw.priorAuditRowsRetained;
  for(const [field,expected] of Object.entries({sourceDistribution:distribution,
    timestampCases:{valid_timestamp:149,invalid_timestamp:153,absent_timestamp:153}})) {
    assert.ok(raw[field]&&typeof raw[field]==='object'&&!Array.isArray(raw[field]));
    assert.deepEqual(Object.keys(raw[field]).sort(),Object.keys(expected).sort());
    for(const [key,count] of Object.entries(expected))assert.equal(raw[field][key],count,'Synthetic historical distribution changed');
    evidence[field]={...expected};
  }
  return {...evidence,sourcePath:fixture.path,sourceSha256:fixture.sha256,
    extractedPhaseSha256:{seed:fixture.seed.sha256,verify:fixture.verify.sha256},
    sourceMigrationsChanged:false,persistedRowsSynthetic:true};
}
