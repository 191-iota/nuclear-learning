import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Plugin } from 'vite';

/**
 * The database keeps itself backed up while the app is running.
 *
 * scripts/backup.sh is the whole mechanism (rsync over SSH into hardlinked
 * snapshots on the Hetzner box); this only decides WHEN to call it, because the
 * moment worth backing up is the moment you are actually writing notes, and nobody
 * remembers to run a script then.
 *
 * Off unless .env sets a host, a path and an interval:
 *
 *   NL_BACKUP_HOST=user@your-box
 *   NL_BACKUP_PATH=/srv/nuclear-learning
 *   NL_BACKUP_EVERY_MIN=30
 *
 * A run that fails says so in the dev server output and changes nothing else: a box
 * that is down or a laptop on a train must never get in the way of writing.
 */

const FIRST_RUN_MS = 60_000; // let the app finish booting before the first push

export function backupSync(root: string, env: Record<string, string>): Plugin {
  const every = Number(env.NL_BACKUP_EVERY_MIN ?? '0');
  const configured = Boolean(env.NL_BACKUP_HOST && env.NL_BACKUP_PATH);
  const script = path.join(root, 'scripts', 'backup.sh');
  let timer: NodeJS.Timeout | null = null;
  let running = false;

  function runOnce(): void {
    if (running || !fs.existsSync(script)) return;
    running = true;
    const child = spawn('bash', [script, 'push'], {
      cwd: root,
      // BatchMode: unattended, so a key that wants a passphrase fails fast instead
      // of waiting for a prompt nobody will see.
      env: { ...process.env, ...env, NL_BACKUP_BATCH: '1' },
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
      const line = out.trim().split('\n').pop() ?? '';
      if (code === 0) console.log(`[nuclear-learning] backup: ${line}`);
      else console.warn(`[nuclear-learning] backup failed (${code}): ${line}`);
    });
  }

  const start = () => {
    if (!configured || !(every > 0) || timer) return;
    console.log(`[nuclear-learning] backup: pushing ./data to ${env.NL_BACKUP_HOST} every ${every} min`);
    setTimeout(runOnce, FIRST_RUN_MS);
    timer = setInterval(runOnce, every * 60_000);
    timer.unref?.(); // never hold the process open on its own account
  };

  return {
    name: 'nuclear-learning-backup',
    configureServer: start,
    configurePreviewServer: start,
    closeBundle() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
