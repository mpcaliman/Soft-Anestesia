import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { prepareRestorableProfile, browserStartupArguments, removeTransientDebugPort, connectLocalCdp, htmlCommitParts, readRestorePreferences, nativeRestoreTarget, originalSessionProof, nativeGuiError } from '../scripts/staging-only/browser-restore-profile.mjs';
const profile = await mkdtemp(resolve(tmpdir(), 'soft-browser-restore-profile-test-'));
try {
  // Pure helper checks require no display or network. In particular the
  // pinned Chromium's clipboard/native widget names must not be confused.
  execFileSync('python', ['-c', `
import importlib.util, sys
spec = importlib.util.spec_from_file_location('native_restore', sys.argv[1])
module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
for title in [b'New Tab - Chromium', b'New Tab - Google Chrome', b'New Tab - Google Chrome for Testing']:
    assert module.native_window_matches(title, 2, 1000, 800)
for title in [b'Chromium clipboard', b'chrome', b'Chrome', b'Patient record - Chromium', b'', b'chrome private data', b'Private New Tab - Chromium']:
    assert not module.native_window_matches(title, 2, 1000, 800)
for state, width, height in [(0,1000,800),(1,1000,800),(2,1,800),(2,1000,0)]:
    assert not module.native_window_matches(b'New Tab - Google Chrome for Testing', state, width, height)
assert module.safe_error_code(RuntimeError('private title or token')) == 'native_gui_operation_failed'
for code in module.ERROR_CODES: assert module.safe_error_code(RuntimeError(code)) == code
`, fileURLToPath(new URL('../scripts/staging-only/browser-native-restore.py', import.meta.url))],
  { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
  for (const code of ['native_display_unavailable', 'unique_native_new_tab_window_required', 'native_pointer_press_failed']) {
    assert.equal(nativeGuiError(code + '\n'), code);
  }
  for (const raw of ['secret-token-and-browser-title', 'native_pointer_press_failed\nprivate-details', '', null, 'native_unknown_error']) {
    assert.equal(nativeGuiError(raw), 'native_gui_operation_failed', 'unrecognized_native_details_must_never_escape');
  }
  await prepareRestorableProfile(profile);
  const text = await readFile(resolve(profile, 'Default/Preferences'), 'utf8');
  assert.deepEqual(JSON.parse(text), { session: { restore_on_startup: 1 } });
  assert.ok(!text.includes('http') && !text.includes('marker') && !text.includes('password') && !text.includes('token'));
  assert.deepEqual(await readRestorePreferences(profile), { continuePreviousSession: true, exitType: 'missing', exitedCleanly: null });
  await assert.rejects(prepareRestorableProfile(profile), { code: 'EEXIST' }, 'existing_Chrome_preferences_cannot_be_overwritten');
  assert.deepEqual(browserStartupArguments(false), ['about:blank']);
  assert.deepEqual(browserStartupArguments(true), [], 'restoration_passes_no_URL_and_Chrome_must_restore_original_documents_itself');
  const screenshot = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(screenshot);
  screenshot.write('IHDR', 12); screenshot.writeUInt32BE(1280, 16); screenshot.writeUInt32BE(800, 20);
  const runId = '12345678-1234-4567-8901-234567890abc';
  const acknowledgement = { runId, operator: 'root', nativeRestoreBubbleObserved: true,
    screenshotSha256: createHash('sha256').update(screenshot).digest('hex'), restoreButton: { x: 1190, y: 180 } };
  assert.deepEqual(nativeRestoreTarget({ acknowledgement, screenshot, runId }), { x: 1190, y: 180 });
  for (const invalid of [{ runId: 'another-run' }, { operator: 'unverified' }, { nativeRestoreBubbleObserved: false },
    { screenshotSha256: '0'.repeat(64) }]) {
    assert.throws(() => nativeRestoreTarget({ acknowledgement: { ...acknowledgement, ...invalid }, screenshot, runId }),
      { message: 'native_restore_acknowledgement_mismatch' });
  }
  for (const restoreButton of [{ x: -1, y: 20 }, { x: 1280, y: 20 }, { x: 20, y: 800 }, { x: 1.5, y: 20 },
    { x: '20', y: 20 }, { x: 20, y: null }, null]) {
    assert.throws(() => nativeRestoreTarget({ acknowledgement: { ...acknowledgement, restoreButton }, screenshot, runId }),
      { message: 'native_restore_button_outside_capture' });
  }
  const changedScreenshot = Buffer.from(screenshot); changedScreenshot.writeUInt32BE(1281, 16);
  assert.throws(() => nativeRestoreTarget({ acknowledgement, screenshot: changedScreenshot, runId }),
    { message: 'native_restore_acknowledgement_mismatch' }, 'acknowledgement_is_bound_to_the_exact_capture');
  const expected = [{ userId: 'fixture-owner', organizationId: 'fixture-clinic-a' },
    { userId: 'fixture-peer', organizationId: 'fixture-clinic-a' }, { userId: 'fixture-foreign', organizationId: 'fixture-clinic-b' }];
  const original = {
    'medsys.v7.auth.session': { uid: expected[0].userId, organization_id: expected[0].organizationId },
    'medsys.v7.cloud.session': { user: { id: expected[0].userId }, access_token: 'synthetic-private-access', refresh_token: 'synthetic-private-refresh' },
    'medsys.v7.tab.contexto': { userId: expected[0].userId, organizationId: expected[0].organizationId }
  };
  const proof = (records = original, globals = {}) => {
    const values = new Map(Object.entries(records).map(([key, value]) => [key, JSON.stringify(value)]));
    values.set('__hosted_crash_marker', 'original-document');
    const context = vm.createContext({ expected, sessionStorage: { getItem: key => values.get(key) ?? null }, ...globals });
    return JSON.parse(JSON.stringify(vm.runInContext(`(${originalSessionProof.toString()})(expected)`, context)));
  };
  assert.deepEqual(proof(), { fixtureIndex: 0, ownerMarkerPresent: true, originalCredentialsPresent: true, applicationNotStarted: true });
  assert.doesNotMatch(JSON.stringify(proof()), /synthetic-private|fixture-owner|fixture-clinic/);
  for (const missing of Object.keys(original)) {
    const altered = { ...original }; delete altered[missing];
    assert.equal(proof(altered).originalCredentialsPresent, false, 'both_credentials_and_original_context_are_required');
  }
  for (const key of ['access_token', 'refresh_token']) {
    const cloud = { ...original['medsys.v7.cloud.session'], [key]: '' };
    assert.equal(proof({ ...original, 'medsys.v7.cloud.session': cloud }).originalCredentialsPresent, false);
  }
  assert.equal(proof({ ...original, 'medsys.v7.tab.contexto': { userId: expected[0].userId, organizationId: expected[2].organizationId } }).originalCredentialsPresent, false);
  assert.equal(proof(original, { auth: {} }).applicationNotStarted, false);
  assert.equal(proof(original, { contextoAba: {} }).applicationNotStarted, false);
  for (const text of [
    '<!doctype html><html><head><meta charset="utf-8"><script src="real-app.js"></script></head></html>',
    '<!doctype html><html lang="pt-BR"><head><!-- configuração pública: clínica --><SCRIPT src="real-app.js"></SCRIPT></head></html>'
  ]) {
    const original = Buffer.from(text), parts = htmlCommitParts(original);
    assert.doesNotMatch(parts.before.toString('utf8'), /<script\b/i, 'no_app_script_can_run_before_CDP_observation');
    assert.match(parts.after.toString('utf8'), /^<script\b/i);
    assert.deepEqual(Buffer.concat([parts.before, parts.after]), original, 'the_original_document_is_not_rewritten');
  }
  assert.throws(() => htmlCommitParts(Buffer.from('<html>no_script</html>')), { message: 'restore_html_first_script_missing' });
  const preference = await readFile(resolve(profile, 'Default/Preferences'), 'utf8');
  await writeFile(resolve(profile, 'DevToolsActivePort'), 'old-transient-port');
  await removeTransientDebugPort(profile);
  await assert.rejects(readFile(resolve(profile, 'DevToolsActivePort')), { code: 'ENOENT' });
  assert.equal(await readFile(resolve(profile, 'Default/Preferences'), 'utf8'), preference, 'debug_port_cleanup_does_not_touch_Chrome_preferences');
  await writeFile(resolve(profile, 'DevToolsActivePort'), '12345\nopaque-debugging-path\n');
  const diagnostic = {}, connected = { contexts: 'synthetic-local-test-only' };
  let attempts = 0;
  const live = () => ({ exited: false, exitCode: null, signal: null });
  assert.equal(await connectLocalCdp({ profile, processState: live, diagnostic, retryDelayMs: 1, timeoutMs: 1000,
    connect: async (endpoint, options) => {
      assert.equal(endpoint, 'http://127.0.0.1:12345'); assert.ok(options.timeout > 0 && options.timeout <= 1500);
      if (++attempts === 1) throw new Error('private-query-password-token-transport-detail');
      return connected;
    } }), connected);
  assert.equal(diagnostic.connectionAttempts, 2); assert.equal(diagnostic.state, 'connected');
  assert.doesNotMatch(JSON.stringify(diagnostic), /password|token|private|http|12345|opaque/);
  const exited = {};
  await assert.rejects(connectLocalCdp({ profile, connect: () => { throw new Error('must_not_connect'); },
    diagnostic: exited, processState: () => ({ exited: true, exitCode: 23, signal: null }) }), { message: 'chromium_exited_before_cdp' });
  assert.equal(exited.state, 'process_exited'); assert.equal(exited.processExitCode, 23); assert.equal(exited.connectionAttempts, 0);
  await writeFile(resolve(profile, 'DevToolsActivePort'), 'https://foreign.invalid/token-secret\n');
  const invalid = {};
  await assert.rejects(connectLocalCdp({ profile, connect: () => { throw new Error('must_not_connect'); },
    diagnostic: invalid, processState: live, retryDelayMs: 1, timeoutMs: 10 }), { message: 'chromium_cdp_attach_timeout' });
  assert.equal(invalid.connectionAttempts, 0); assert.equal(invalid.state, 'cdp_attach_timed_out');
  assert.doesNotMatch(JSON.stringify(invalid), /foreign|token-secret|https/);
  for (const exit of ['Normal', 'Crashed', 'SessionEnded', 'private-password-token']) {
    await writeFile(resolve(profile, 'Default/Preferences'), JSON.stringify({ session: { restore_on_startup: 1 },
      profile: { exit_type: exit, exited_cleanly: false }, secret: 'private-password-token' }));
    const redacted = await readRestorePreferences(profile);
    assert.equal(redacted.exitType, exit === 'private-password-token' ? 'unknown' : exit);
    assert.equal(redacted.exitedCleanly, false); assert.equal(redacted.continuePreviousSession, true);
    assert.doesNotMatch(JSON.stringify(redacted), /private-password-token|secret/);
  }
  console.log('✓ perfil de restauração é configurado só antes do primeiro Chromium; relaunch não injeta URL/marcador nem reescreve preferências');
} finally { await rm(profile, { recursive: true, force: true }); }
