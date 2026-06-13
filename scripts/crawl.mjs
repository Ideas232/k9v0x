#!/usr/bin/env node
// Daily crawl orchestrator.
//
// Fetches events from every adapter in scripts/sources/, merges with the
// existing data/events.json by stable id (new events appended, existing
// ones field-merged with the fresh fetch winning), and writes back.
//
// Run locally:        node scripts/crawl.mjs
// Run dry (no write): node scripts/crawl.mjs --dry
//
// Exit codes: 0 on success (even with per-source errors logged), 2 on
// fatal/unhandled error.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import * as tlsports from './sources/tlsports.mjs';
import * as volleynation from './sources/volleynation.mjs';
import * as armada from './sources/armada.mjs';
import * as nagva from './sources/nagva.mjs';
import * as noattitudes from './sources/noattitudes.mjs';
import * as sfdynasty from './sources/sfdynasty.mjs';
import * as fvbl from './sources/fvbl.mjs';

const SOURCES = [
  ['tlsports', tlsports],
  ['volleynation', volleynation],
  ['armada', armada],
  ['nagva', nagva],
  ['noattitudes', noattitudes],
  ['sfdynasty', sfdynasty],
  ['fvbl', fvbl],
];

const here = dirname(fileURLToPath(import.meta.url));
const EVENTS_JSON = resolve(here, '../data/events.json');
const STATUS_JSON = resolve(here, '../data/crawl-status.json');
const dry = process.argv.includes('--dry');

const log = (...a) => console.log('[crawl]', ...a);

async function run() {
  const existing = JSON.parse(readFileSync(EVENTS_JSON, 'utf8'));
  const byId = new Map((existing.events || []).map(e => [e.id, e]));
  const status = { startedAt: new Date().toISOString(), sources: {} };
  let added = 0, updated = 0, fetched = 0;

  for (const [name, mod] of SOURCES) {
    log(`fetching ${name}…`);
    const t0 = Date.now();
    let result;
    try { result = await mod.fetchEvents(); }
    catch (e) {
      status.sources[name] = { ok: false, durationMs: Date.now() - t0, events: 0, added: 0, updated: 0, errors: [`threw: ${e.message}`] };
      continue;
    }
    const errors = (result.errors || []).slice();
    const evs = (result.events || []).filter(e => e && e.id && e.startDate);
    const dropped = (result.events || []).length - evs.length;
    if (dropped) errors.push(`${dropped} event(s) skipped (missing id or startDate)`);
    let srcAdded = 0, srcUpdated = 0;
    for (const ev of evs) {
      const old = byId.get(ev.id);
      if (!old) { byId.set(ev.id, ev); srcAdded++; added++; }
      else {
        const merged = { ...old };
        for (const [k, v] of Object.entries(ev)) {
          if (v == null) continue;
          if (Array.isArray(v) && v.length === 0) continue;
          if (typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0) continue;
          merged[k] = v;
        }
        if (JSON.stringify(merged) !== JSON.stringify(old)) {
          byId.set(ev.id, merged);
          srcUpdated++; updated++;
        }
      }
    }
    fetched += evs.length;
    status.sources[name] = {
      ok: errors.length === 0,
      durationMs: Date.now() - t0,
      events: evs.length,
      added: srcAdded,
      updated: srcUpdated,
      errors,
    };
    log(`  ${name}: ${evs.length} events (${srcAdded} new, ${srcUpdated} updated), ${errors.length} errors`);
  }

  status.finishedAt = new Date().toISOString();
  status.totals = { sources: SOURCES.length, fetched, added, updated };

  const next = {
    updatedAt: status.finishedAt,
    events: [...byId.values()].sort((a, b) => (a.startDate || '').localeCompare(b.startDate || '')),
  };

  log(`fetched ${fetched} events from ${SOURCES.length} sources — added ${added}, updated ${updated}`);

  if (dry) { log('dry run — no write.'); console.log(JSON.stringify(status, null, 2)); return; }

  writeFileSync(STATUS_JSON, JSON.stringify(status, null, 2) + '\n');
  log('wrote', STATUS_JSON);

  const before = readFileSync(EVENTS_JSON, 'utf8');
  const after = JSON.stringify(next, null, 2) + '\n';
  if (before === after) { log('no change to events.json'); return; }
  writeFileSync(EVENTS_JSON, after);
  log('wrote', EVENTS_JSON);
}

run().catch(e => { console.error('[crawl] FATAL', e); process.exit(2); });
