import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { catalogHash, catalogIdentity, validateCatalog } from './compare-application-catalog.mjs';

// This analysis never changes the catalog comparator or turns its false result
// into approval. Hashes prove the exact candidate function metadata; bodies are
// not exported in the report.
export function analyzeReplayFunctionDefinitions(evidence, productionDocument, stagingDocument) {
  const production=validateCatalog(productionDocument), staging=validateCatalog(stagingDocument);
  assert.equal(evidence.baselineReplayVerified,true);
  assert.equal(evidence.baselineComparison.equal,true);
  assert.equal(evidence.managedSecurityComparison.equal,true);
  assert.equal(evidence.stagingComparison.equal,false);
  assert.equal(catalogHash(production),evidence.baselineComparison.expectedCatalogSha256,'Evidence must bind the captured production catalog');
  assert.equal(catalogHash(staging),evidence.stagingComparison.expectedCatalogSha256,'Evidence must bind the captured staging catalog');
  const rows=[];
  for(const change of evidence.stagingComparison.changes.filter(x=>x.category==='functions'&&x.changedFields.includes('definition'))){
    const expected=structuredClone(staging.functions.find(x=>catalogIdentity('functions',x)===change.identity));
    const original=structuredClone(production.functions.find(x=>catalogIdentity('functions',x)===change.identity));
    assert.ok(expected&&original,'An unknown function difference requires separate review');
    delete expected.acl;delete original.acl;
    assert.equal(catalogHash(expected),change.expectedSha256,'Evidence must bind the captured staging function');
    const stageAs=expected.definition.indexOf('AS $function$'), sourceAs=original.definition.indexOf('AS $function$');
    assert.ok(stageAs>=0&&sourceAs>=0,'Unreviewed function definition format');
    const amended={...expected,definition:expected.definition.slice(0,stageAs)+original.definition.slice(sourceAs)};
    const candidates=[['captured_production_function',original],['staging_header_preserved_production_body',amended]];
    const candidate=candidates.find(([,row])=>catalogHash(row)===change.actualSha256);
    if(!candidate){rows.push({identity:change.identity,classification:'unresolved',actualSha256:change.actualSha256});continue;}
    const lf=s=>s.replaceAll('\r\n','\n');
    const before=lf(expected.definition),after=lf(candidate[1].definition);
    let classification='line_endings_only',alignmentLines=[];
    if(before!==after){
      const left=before.split('\n'),right=after.split('\n');
      let alignmentOnly=change.identity==='public|prog_contar_ambiente|p_org uuid'&&left.length===right.length;
      for(let i=0;i<Math.max(left.length,right.length);i++){
        if(left[i]===right[i])continue;
        const a=left[i]?.match(/^(.*\bfrom public\.[a-z_]+)[ \t]+(where .*)$/);
        const b=right[i]?.match(/^(.*\bfrom public\.[a-z_]+)[ \t]+(where .*)$/);
        if(!a||!b||a[1]!==b[1]||a[2]!==b[2])alignmentOnly=false;
        alignmentLines.push(i+1);
      }
      classification=alignmentOnly?'line_endings_and_from_where_alignment':'unresolved';
    }
    rows.push({identity:change.identity,classification,hashMatchedReconstruction:candidate[0],
      expectedSha256:change.expectedSha256,actualSha256:change.actualSha256,
      preservedProductionBody:true,normalizationAppliedToSource:false,
      ...(alignmentLines.length?{alignmentLines}:{}),authorizationReviewRequired:true});
  }
  return {format:1,metadataOnly:true,capturedProductionProject:productionDocument.projectRef,
    capturedStagingProject:stagingDocument.projectRef,stagingCatalogEqual:false,
    catalogComparatorChanged:false,differencesIgnored:false,definitionsAnalyzed:rows.length,
    counts:Object.fromEntries([...new Set(rows.map(x=>x.classification))].map(key=>[key,rows.filter(x=>x.classification===key).length])),
    functions:rows,authorizationEquivalent:false,productionApplyAllowed:false};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const [evidencePath,productionPath,stagingPath,outputPath]=process.argv.slice(2);
  if(process.argv.length!==6)throw new Error('Usage: node scripts/analyze-production-replay-functions.mjs evidence.json production-catalog.json staging-catalog.json output.json');
  const read=async path=>JSON.parse(await readFile(path,'utf8'));
  const result=analyzeReplayFunctionDefinitions(await read(evidencePath),await read(productionPath),await read(stagingPath));
  await writeFile(outputPath,JSON.stringify(result,null,2)+'\n');
  console.log(`Function definitions reviewed: ${result.definitionsAnalyzed}; unresolved ${result.counts.unresolved??0}; staging authorization still requires reconciliation.`);
}
