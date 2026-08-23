#!/usr/bin/env node
//
// Pour a notebook folder out as text, into the place other tools read from.
//
// The notebook is the one place a term's material actually accumulates: handwriting
// transcribed, documents filed, the student's own framing on top of both. All of it
// sits in the file database as JSON, which is useless to anything that wants to READ
// it. This walks that database, takes the folders you pick (with everything filed
// under them), and writes one Markdown file per folder into
// ~/Documents/The_Factory/context, where the rest of the toolchain looks for context.
//
// It reads a database directory, so it works the same on ./data and on a snapshot
// pulled back off the box (scripts/backup.sh pull leaves those in ./data-restored-*).
// Nothing here writes to the database, ever.
//
//   npm run dump                     pick folders from a list, write them out
//   npm run dump -- --list           just show what is in there
//   npm run dump -- --all            every folder, no prompt
//   npm run dump -- --folder Krypto  by name or path, repeatable, no prompt
//   npm run dump -- --restored       read the newest pulled-back snapshot
//   npm run dump -- --data <dir>     read some other database directory
//   npm run dump -- --out <dir>      write somewhere else
//   npm run dump -- --flat           one file for the whole selection
//   npm run dump -- --shallow        the folder itself, without its subfolders

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const DEFAULT_OUT = path.join(os.homedir(), 'Documents', 'The_Factory', 'context');
// Every file this writes opens with this line, so a re-run knows which files are its
// own and refuses to overwrite anything that is not.
const MARK = '<!-- written by nuclear-learning scripts/dump-folder.mjs -->';

function parseArgs(argv) {
  const out = {
    data: '',
    outDir: DEFAULT_OUT,
    folders: [],
    all: false,
    list: false,
    flat: false,
    shallow: false,
    restored: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--all') out.all = true;
    else if (a === '--list') out.list = true;
    else if (a === '--flat') out.flat = true;
    else if (a === '--shallow') out.shallow = true;
    else if (a === '--restored') out.restored = true;
    else if (a === '--data') out.data = argv[++i] ?? '';
    else if (a === '--out') out.outDir = argv[++i] ?? DEFAULT_OUT;
    else if (a === '--folder') out.folders.push(argv[++i] ?? '');
    else if (a === '-h' || a === '--help') out.help = true;
    else {
      console.error(`dump: unknown option "${a}". Try --help.`);
      process.exit(2);
    }
  }
  return out;
}

const HELP = `Pour notebook folders out as text.

  npm run dump                     pick folders from a list, write them out
  npm run dump -- --list           just show what is in there
  npm run dump -- --all            every folder, no prompt
  npm run dump -- --folder <name>  by name or path, repeatable, no prompt
  npm run dump -- --restored       read the newest pulled-back snapshot
  npm run dump -- --data <dir>     read some other database directory
  npm run dump -- --out <dir>      write somewhere else (default ${DEFAULT_OUT})
  npm run dump -- --flat           one file for the whole selection
  npm run dump -- --shallow        the folder itself, without its subfolders`;

/** The newest data-restored-* beside the repo, which is where a pull lands. */
function newestRestored() {
  const dirs = fs
    .readdirSync(ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name.startsWith('data-restored-'))
    .map((d) => d.name)
    .sort();
  return dirs.length ? path.join(ROOT, dirs[dirs.length - 1]) : '';
}

function readCollection(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    try {
      out.push(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
    } catch {
      console.warn(`dump: skipping unreadable ${f}`);
    }
  }
  return out;
}

/** "Mathe / Analysis / Grenzwerte", the same display path the app shows. */
function folderPath(byId, id) {
  const parts = [];
  const seen = new Set();
  let cur = byId.get(id);
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    parts.unshift(cur.name);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return parts.join(' / ');
}

/** Depth-first, Inbox first at each level, exactly the order the app's tree uses. */
function folderTree(folders) {
  const byParent = new Map();
  for (const f of folders) {
    const key = f.parentId ?? null;
    byParent.set(key, [...(byParent.get(key) ?? []), f]);
  }
  for (const list of byParent.values()) {
    list.sort((a, b) =>
      a.id === 'inbox' ? -1 : b.id === 'inbox' ? 1 : a.name.localeCompare(b.name, 'de'),
    );
  }
  const out = [];
  const walk = (parentId, depth, guard) => {
    for (const f of byParent.get(parentId) ?? []) {
      if (guard.has(f.id)) continue;
      guard.add(f.id);
      out.push({ folder: f, depth });
      walk(f.id, depth + 1, guard);
    }
  };
  walk(null, 0, new Set());
  return out;
}

function subtreeIds(folders, rootId) {
  const ids = new Set([rootId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const f of folders) {
      if (f.parentId && ids.has(f.parentId) && !ids.has(f.id)) {
        ids.add(f.id);
        grew = true;
      }
    }
  }
  return ids;
}

function notesIn(notes, ids) {
  return notes
    .filter((n) => ids.has(n.folderId))
    .sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || b.ts - a.ts);
}

function slug(s) {
  return (
    s
      .toLowerCase()
      .replace(/ä/g, 'ae')
      .replace(/ö/g, 'oe')
      .replace(/ü/g, 'ue')
      .replace(/ß/g, 'ss')
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'folder'
  );
}

function stamp(ts) {
  return new Date(ts).toISOString().slice(0, 10);
}

/** One note as text: what it is, what the student said about it, what it says. */
function renderNote(n, pathOf) {
  const lines = [`## ${n.title || 'Untitled'}`, ''];
  const meta = [pathOf, stamp(n.ts)];
  if (n.tags?.length) meta.push(`tags: ${n.tags.join(', ')}`);
  if (n.file?.name) meta.push(`file: ${n.file.name}`);
  if (n.draft) meta.push('draft');
  lines.push(`\`${meta.join(' · ')}\``, '');
  if (n.context?.trim()) {
    lines.push('**Context (written by hand, not by a model):**', '', n.context.trim(), '');
  }
  if (n.text?.trim()) lines.push(n.text.trim(), '');
  else if (n.hasImage) lines.push('_This page has not been transcribed yet._', '');
  else lines.push('_Empty._', '');
  return lines.join('\n');
}

function renderFolder(entry, byId, folders, notes, opts) {
  const { folder } = entry;
  const ids = opts.shallow ? new Set([folder.id]) : subtreeIds(folders, folder.id);
  const list = notesIn(notes, ids);
  const title = folderPath(byId, folder.id);
  const lines = [
    MARK,
    `# ${title}`,
    '',
    `_${list.length} note${list.length === 1 ? '' : 's'}${
      opts.shallow ? '' : ', subfolders included'
    }, dumped ${new Date().toISOString().slice(0, 16).replace('T', ' ')} from ${opts.data}._`,
    '',
  ];
  // The folder's own background first, and every parent's above it: a note read
  // without the module it belongs to is half a note.
  const chain = [];
  const seen = new Set();
  let cur = byId.get(folder.id);
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    if (cur.context?.trim()) chain.unshift({ path: folderPath(byId, cur.id), text: cur.context.trim() });
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  for (const c of chain) {
    lines.push(`## What "${c.path}" is about`, '', c.text, '');
  }
  if (!list.length) lines.push('_No notes filed here._', '');
  for (const n of list) lines.push('---', '', renderNote(n, folderPath(byId, n.folderId)));
  return { text: lines.join('\n'), count: list.length, title };
}

function writeFile(outDir, name, text) {
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, name);
  if (fs.existsSync(file)) {
    const head = fs.readFileSync(file, 'utf8').slice(0, MARK.length);
    if (head !== MARK) {
      console.error(`dump: ${file} was not written by this script, leaving it alone.`);
      return '';
    }
  }
  fs.writeFileSync(file, text, 'utf8');
  return file;
}

function printTree(tree, folders, notes) {
  const width = Math.min(
    46,
    Math.max(...tree.map((t) => t.depth * 2 + t.folder.name.length)) + 2,
  );
  tree.forEach((t, i) => {
    const count = notesIn(notes, subtreeIds(folders, t.folder.id)).length;
    const own = notesIn(notes, new Set([t.folder.id])).length;
    const label = `${'  '.repeat(t.depth)}${t.folder.name}`.padEnd(width, ' ');
    const withSubs = count === own ? '' : ` (${count} with subfolders)`;
    console.log(
      `${String(i + 1).padStart(3, ' ')}  ${label} ${String(own).padStart(3, ' ')} note${
        own === 1 ? ' ' : 's'
      }${withSubs}`,
    );
  });
}

/** "1 3 5", "2-4", "all", or a folder name. Empty cancels. */
function parseSelection(answer, tree, byId) {
  const q = answer.trim();
  if (!q) return [];
  if (q.toLowerCase() === 'all') return tree.map((_, i) => i);
  const picked = new Set();
  for (const part of q.split(/[\s,]+/).filter(Boolean)) {
    const range = /^(\d+)-(\d+)$/.exec(part);
    if (range) {
      const from = Number(range[1]);
      const to = Number(range[2]);
      for (let i = Math.min(from, to); i <= Math.max(from, to); i += 1) {
        if (i >= 1 && i <= tree.length) picked.add(i - 1);
      }
      continue;
    }
    if (/^\d+$/.test(part)) {
      const i = Number(part);
      if (i >= 1 && i <= tree.length) picked.add(i - 1);
      else console.warn(`dump: there is no folder ${i}`);
      continue;
    }
    const hit = matchFolder(part, tree, byId);
    if (hit >= 0) picked.add(hit);
    else console.warn(`dump: no folder matches "${part}"`);
  }
  return [...picked].sort((a, b) => a - b);
}

/** By id, by full path, or by any unique piece of a name. */
function matchFolder(needle, tree, byId) {
  const q = needle.toLowerCase();
  const exact = tree.findIndex(
    (t) => t.folder.id === needle || folderPath(byId, t.folder.id).toLowerCase() === q,
  );
  if (exact >= 0) return exact;
  const partial = tree.filter((t) => t.folder.name.toLowerCase().includes(q));
  if (partial.length === 1) return tree.indexOf(partial[0]);
  if (partial.length > 1) {
    console.warn(
      `dump: "${needle}" matches ${partial.map((t) => t.folder.name).join(', ')}; be more specific`,
    );
  }
  return -1;
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(HELP);
    return;
  }

  let data = opts.data;
  if (!data && opts.restored) {
    data = newestRestored();
    if (!data) {
      console.error('dump: no data-restored-* directory here. Run `npm run backup:pull` first.');
      process.exit(1);
    }
  }
  if (!data) data = path.join(ROOT, 'data');
  data = path.resolve(data);
  if (!fs.existsSync(path.join(data, 'notes'))) {
    console.error(`dump: ${data} does not look like a database (no notes/ in it).`);
    process.exit(1);
  }
  opts.data = data;

  const folders = readCollection(path.join(data, 'notefolders'));
  const notes = readCollection(path.join(data, 'notes'));
  if (!folders.length) {
    console.error(`dump: no folders in ${data}.`);
    process.exit(1);
  }
  const byId = new Map(folders.map((f) => [f.id, f]));
  const tree = folderTree(folders);

  console.log(`\nnuclear·learning: ${notes.length} notes in ${folders.length} folders (${data})\n`);
  printTree(tree, folders, notes);

  if (opts.list) return;

  let chosen = [];
  if (opts.all) {
    chosen = tree.map((_, i) => i);
  } else if (opts.folders.length) {
    for (const name of opts.folders) {
      const i = matchFolder(name, tree, byId);
      if (i >= 0) chosen.push(i);
    }
  } else {
    const answer = await ask('\nWhich folders? (numbers, 2-4 for a range, a name, or "all")\n> ');
    chosen = parseSelection(answer, tree, byId);
  }
  chosen = [...new Set(chosen)].sort((a, b) => a - b);
  if (!chosen.length) {
    console.log('dump: nothing picked, nothing written.');
    return;
  }

  const rendered = chosen.map((i) => renderFolder(tree[i], byId, folders, notes, opts));
  console.log('');
  if (opts.flat) {
    const body = [
      MARK,
      `# Notebook dump, ${rendered.length} folder${rendered.length === 1 ? '' : 's'}`,
      '',
      ...rendered.map((r) => r.text.replace(`${MARK}\n`, '')),
    ].join('\n');
    const file = writeFile(opts.outDir, `nuclear-learning-${stamp(Date.now())}.md`, body);
    if (file) {
      const total = rendered.reduce((sum, r) => sum + r.count, 0);
      console.log(`wrote ${file}  (${total} notes, ${(body.length / 1024).toFixed(1)} KB)`);
    }
    return;
  }
  for (const r of rendered) {
    const file = writeFile(opts.outDir, `${slug(r.title)}.md`, r.text);
    if (file) console.log(`wrote ${file}  (${r.count} notes, ${(r.text.length / 1024).toFixed(1)} KB)`);
  }
}

main().catch((err) => {
  console.error('dump: failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
