/** Configure the user's normal "continue where you left off" choice once,
 * BEFORE the first Chrome process. Never reopen app URLs, inject a restored
 * session marker or modify preferences after SIGKILL.
 */
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
const nativeGuiErrors = new Set(['task_owned_display_required', 'absolute_screenshot_path_required', 'native_restore_coordinate_invalid',
  'native_display_unavailable', 'native_window_inventory_failed', 'unique_native_new_tab_window_required',
  'native_restore_coordinate_outside_display', 'native_pointer_move_failed', 'native_pointer_press_failed',
  'native_pointer_release_failed', 'native_action_not_allowed', 'native_window_geometry_unavailable',
  'native_restore_coordinate_outside_window']);
export const nativeGuiError = stderr => nativeGuiErrors.has(String(stderr).trim()) ? String(stderr).trim() : 'native_gui_operation_failed';
export const prepareRestorableProfile = async profile => {
  const directory = resolve(profile, 'Default');
  await mkdir(directory, { recursive: true });
  await writeFile(resolve(directory, 'Preferences'), JSON.stringify({ session: { restore_on_startup: 1 } }) + '\n',
    { mode: 0o600, flag: 'wx' });
};
export const browserStartupArguments = restoring => restoring ? [] : ['about:blank'];

/** A native Restore click is authorized only for the exact public NTP
 * screenshot inspected by the operator. It is never an application click,
 * a keyboard shortcut that creates a new tab, or an injected navigation.
 */
export const nativeRestoreTarget = ({ acknowledgement, screenshot, runId }) => {
  if (!acknowledgement || acknowledgement.runId !== runId || acknowledgement.operator !== 'root'
      || acknowledgement.nativeRestoreBubbleObserved !== true
      || acknowledgement.screenshotSha256 !== createHash('sha256').update(screenshot).digest('hex')) {
    throw new Error('native_restore_acknowledgement_mismatch');
  }
  if (screenshot.length < 24 || !screenshot.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      || screenshot.toString('ascii', 12, 16) !== 'IHDR') throw new Error('native_restore_png_required');
  const width = screenshot.readUInt32BE(16), height = screenshot.readUInt32BE(20);
  const { x, y } = acknowledgement.restoreButton || {};
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || width > 10000 || height < 1 || height > 10000
      || !Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= width || y >= height) {
    throw new Error('native_restore_button_outside_capture');
  }
  return { x, y };
};

/** Executed inside each ORIGINAL document before its first app script. The
 * transport returns only booleans and a fixture index, never session values.
 */
export const originalSessionProof = expected => {
  const parse = key => { try { return JSON.parse(sessionStorage.getItem(key) || 'null'); } catch { return null; } };
  const app = parse('medsys.v7.auth.session'), cloud = parse('medsys.v7.cloud.session'), context = parse('medsys.v7.tab.contexto');
  const fixtureIndex = expected.findIndex(value => value.userId === cloud?.user?.id
    && value.userId === (app?.uid || app?.id) && value.userId === context?.userId
    && value.organizationId === app?.organization_id && value.organizationId === context?.organizationId);
  return { fixtureIndex, ownerMarkerPresent: sessionStorage.getItem('__hosted_crash_marker') === 'original-document',
    originalCredentialsPresent: fixtureIndex >= 0 && typeof cloud?.access_token === 'string' && !!cloud.access_token
      && typeof cloud?.refresh_token === 'string' && !!cloud.refresh_token,
    applicationNotStarted: typeof auth === 'undefined' && typeof contextoAba === 'undefined' };
};

/** Read only fixed public settings enums; never return a raw preference. */
export const readRestorePreferences = async profile => {
  try {
    const preferences = JSON.parse(await readFile(resolve(profile, 'Default/Preferences'), 'utf8'));
    const exit = preferences.profile?.exit_type ?? preferences.session?.exit_type;
    return { continuePreviousSession: preferences.session?.restore_on_startup === 1,
      exitType: ['Normal', 'Crashed', 'SessionEnded'].includes(exit) ? exit : exit == null ? 'missing' : 'unknown',
      exitedCleanly: typeof preferences.profile?.exited_cleanly === 'boolean' ? preferences.profile.exited_cleanly : null };
  } catch { return { continuePreviousSession: false, exitType: 'unavailable', exitedCleanly: null }; }
};

/** Commit the original HTML document without executing any application
 * script. Concatenating both parts preserves every original response byte.
 */
export const htmlCommitParts = content => {
  const text = content.toString('utf8');
  const offset = text.search(/<script\b/i);
  if (offset < 0) throw new Error('restore_html_first_script_missing');
  const byteOffset = Buffer.byteLength(text.slice(0, offset), 'utf8');
  return { before: content.subarray(0, byteOffset), after: content.subarray(byteOffset) };
};

/** DevToolsActivePort is transient debugging metadata, never session data. */
export const removeTransientDebugPort = profile => rm(resolve(profile, 'DevToolsActivePort'), { force: true });

/** Chrome can publish a debugging port before CDP is accepting connections.
 * Retry only a validated loopback port. Never expose transport error messages.
 */
export const connectLocalCdp = async ({ profile, connect, processState, diagnostic,
  timeoutMs = 20000, retryDelayMs = 100 }) => {
  const deadline = Date.now() + timeoutMs;
  diagnostic.connectionAttempts = 0;
  diagnostic.state = 'waiting_for_debug_port';
  while (Date.now() < deadline) {
    const state = processState();
    diagnostic.processExitCode = Number.isInteger(state.exitCode) ? state.exitCode : null;
    diagnostic.processSignal = ['SIGKILL', 'SIGTERM', 'SIGSEGV', 'SIGABRT', 'SIGBUS', 'SIGTRAP'].includes(state.signal) ? state.signal : null;
    if (state.exited) {
      diagnostic.state = 'process_exited';
      throw new Error('chromium_exited_before_cdp');
    }
    let port;
    try {
      const firstLine = (await readFile(resolve(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0];
      if (/^\d{1,5}$/.test(firstLine)) port = Number(firstLine);
    } catch { /* A new process has not published its port yet. */ }
    if (Number.isInteger(port) && port > 0 && port <= 65535) {
      diagnostic.connectionAttempts++;
      diagnostic.state = 'connecting_to_loopback';
      try {
        const browser = await connect(`http://127.0.0.1:${port}`, { timeout: Math.min(1500, Math.max(1, deadline - Date.now())) });
        diagnostic.state = 'connected';
        return browser;
      } catch { diagnostic.state = 'retrying_loopback_connection'; }
    }
    await new Promise(done => setTimeout(done, Math.min(retryDelayMs, Math.max(1, deadline - Date.now()))));
  }
  diagnostic.lastProgress = diagnostic.state;
  diagnostic.state = 'cdp_attach_timed_out';
  throw new Error('chromium_cdp_attach_timeout');
};
