import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Plugin } from 'vite';

/**
 * The database keeps itself in step with the other machines while the app is running.
 *
 * scripts/sync.sh is the whole mechanism (a private git repository holding ./data);
 * this only decides WHEN to call it, and the important moment is the first one: you
 * sat down at a different machine, and what you wrote on the last one should already
 * be here before you start typing. So this runs a sync as the server comes up, and
 * again every few minutes while you work.
 *
 * It overlaps on purpose with the launchd agent that scripts/sync.sh install puts in
 * place. The agent covers the machine, this covers the session, and the script takes
 * a lock, so whichever fires second sees the other running and steps aside. On a
 * machine without launchd this is the only timer there is.
 *
 *   NL_SYNC_EVERY_MIN=5     minutes between runs while the server is up, 0 turns it off
 *
 * A run that fails says so in the dev server output and changes nothing else: an
 * unreachable remote or a laptop on a train must never get in the way of writing.
 */

const BOOT_DELAY_MS = 2_000; // let the server bind its port before shelling out

export function syncData(root: string, env: Record<string, string>): Plugin {
  const every = Number(env.NL_SYNC_EVERY_MIN ?? '5');
  const script = path.join(root, 'scripts', 'sync.sh');
  let timer: NodeJS.Timeout | null = null;
  let running = false;

  function runOnce(): void {
    // The data directory is a clone or it is nothing; syncing a directory that was
    // never set up would only print the same error every five minutes.
    if (running || !fs.existsSync(script) || !fs.existsSync(path.join(root, 'data', '.git'))) return;
    running = true;
    const child = spawn('bash', [script, 'sync'], {
      cwd: root,
      env: { ...process.env, ...env },
    });
    let out = '';
    child.stdout.on('data', (c: Buffer) => {
      out += c.toString();
    });
    child.stderr.on('data', (c: Buffer) => {
      out += c.toString();
    });
    child.on('close', (code) => {
      running = false;
      const lines = out.trim().split('\n').filter(Boolean);
      // "up to date" is the answer almost every time and is not worth a line in the
      // log. Anything else moved something or went wrong, and a run that both pulled
      // and had nothing to push says both, so filter rather than look at the last line.
      const worth = lines.filter((l) => !l.endsWith('up to date'));
      if (code !== 0) {
        console.warn(`[nuclear-learning] sync failed (${code}): ${lines[lines.length - 1] ?? ''}`);
        return;
      }
      for (const l of worth) console.log(`[nuclear-learning] ${l}`);
    });
  }

  const start = () => {
    if (!(every > 0) || timer) return;
    console.log(`[nuclear-learning] sync: ./data every ${every} min, and once now`);
    setTimeout(runOnce, BOOT_DELAY_MS);
    timer = setInterval(runOnce, every * 60_000);
    timer.unref?.(); // never hold the process open on its own account
  };

  return {
    name: 'nuclear-learning-sync',
    configureServer: start,
    configurePreviewServer: start,
    closeBundle() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
