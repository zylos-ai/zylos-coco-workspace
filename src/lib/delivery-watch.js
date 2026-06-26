/**
 * Delivery watch — confirm DM delivery by detecting the recipient's 👀 reaction.
 *
 * When coco-workspace sends a DM, the receiving agent (also running
 * coco-workspace) adds a 👀 reaction on receipt (reactOnReceive).
 * This module watches for that reaction event on the sender side.
 *
 * Cross-process coordination: send.js (separate process) writes a
 * `.watch` marker to the watch directory; comm-bridge (long-running)
 * polls for markers, starts timers, and matches incoming
 * message.reaction.added WS events.
 */

import fs from 'fs';
import path from 'path';
import { RUNTIME_DIR } from './session.js';

const LOG_PREFIX = '[delivery-watch]';
function log(...a) { console.log(LOG_PREFIX, ...a); }
function warn(...a) { console.warn(LOG_PREFIX, ...a); }

const WATCH_DIR = path.join(RUNTIME_DIR, 'delivery-watch');
const FAILURE_LOG = path.join(RUNTIME_DIR, 'delivery-failures.log');
const DEFAULT_TIMEOUT_MS = 15_000;
const POLL_MS = 1_000;
const STALE_MARKER_MS = 120_000;

// messageId (string) → { convId, orgId, ts, timer }
const pending = new Map();

let timeoutMs = DEFAULT_TIMEOUT_MS;

export function configure(opts) {
  if (opts?.timeout_ms > 0) timeoutMs = opts.timeout_ms;
}

export function startWatch(messageId, convId, orgId) {
  messageId = String(messageId);
  if (pending.has(messageId)) return;
  const timer = setTimeout(() => onTimeout(messageId), timeoutMs);
  timer.unref();
  pending.set(messageId, { convId, orgId, ts: Date.now(), timer });
  log(`watching msg=${messageId} conv=${convId} timeout=${timeoutMs}ms`);
}

export function onReactionEvent(data) {
  const messageId = String(data.message_id || '');
  if (!messageId) return false;
  const watch = pending.get(messageId);
  if (!watch) return false;

  clearTimeout(watch.timer);
  pending.delete(messageId);
  const elapsed = Date.now() - watch.ts;
  log(`delivered msg=${messageId} conv=${watch.convId} elapsed=${elapsed}ms reactor=${data.reactor_id || '?'}`);
  return true;
}

function onTimeout(messageId) {
  const watch = pending.get(messageId);
  if (!watch) return;
  pending.delete(messageId);
  const line = `${new Date().toISOString()} TIMEOUT msg=${messageId} conv=${watch.convId} org=${watch.orgId} timeout=${timeoutMs}ms\n`;
  warn(`timeout msg=${messageId} conv=${watch.convId}`);
  try { fs.appendFileSync(FAILURE_LOG, line); } catch {}
}

// --- Marker file coordination with send.js ---

export function writeMarker(messageId, convId, orgId) {
  const safe = String(messageId).replace(/[^a-zA-Z0-9_-]/g, '_');
  try {
    fs.mkdirSync(WATCH_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(WATCH_DIR, `${safe}.watch`),
      `${convId}|${orgId}|${Date.now()}`
    );
  } catch {}
}

export function pollMarkers() {
  let files;
  try { files = fs.readdirSync(WATCH_DIR); } catch { return; }
  const now = Date.now();
  for (const f of files) {
    if (!f.endsWith('.watch')) continue;
    const fp = path.join(WATCH_DIR, f);
    const messageId = f.slice(0, -6); // strip .watch
    let content;
    try { content = fs.readFileSync(fp, 'utf8').trim(); } catch { continue; }
    try { fs.unlinkSync(fp); } catch {}
    const [convId, orgId, tsStr] = content.split('|');
    const ts = parseInt(tsStr, 10) || 0;
    if (now - ts > STALE_MARKER_MS) continue;
    startWatch(messageId, convId, orgId);
  }
}

let _pollTimer = null;

export function startPolling() {
  fs.mkdirSync(WATCH_DIR, { recursive: true });
  // Clear stale markers from previous run
  try {
    for (const f of fs.readdirSync(WATCH_DIR)) {
      try { fs.unlinkSync(path.join(WATCH_DIR, f)); } catch {}
    }
  } catch {}
  _pollTimer = setInterval(pollMarkers, POLL_MS);
  _pollTimer.unref();
  log(`polling started dir=${WATCH_DIR} interval=${POLL_MS}ms timeout=${timeoutMs}ms`);
}

export function stopPolling() {
  if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
  for (const [msgId, watch] of pending) {
    clearTimeout(watch.timer);
  }
  pending.clear();
}

export function pendingCount() { return pending.size; }

export { WATCH_DIR };
