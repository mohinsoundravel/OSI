#!/usr/bin/env node
/** Syntax-checks every poller module and validates JSON config without running anything. */
import { readdir, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'fixtures') out.push(...(await walk(full)));
    } else if (entry.name.endsWith('.mjs')) {
      out.push(full);
    }
  }
  return out;
}

let failed = 0;
for (const file of await walk('poller')) {
  const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (r.status !== 0) {
    failed++;
    console.error(`syntax error in ${file}\n${r.stderr}`);
  }
}
try {
  JSON.parse(await readFile('config/monitor.json', 'utf8'));
} catch (err) {
  failed++;
  console.error(`config/monitor.json: ${err.message}`);
}
if (failed) {
  process.exitCode = 1;
} else {
  console.log('syntax and config checks passed');
}
