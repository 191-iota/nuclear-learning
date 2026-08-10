#!/usr/bin/env bash
#
# Back up the local file database (./data) to the Hetzner box, and bring it back.
#
# ./data is the one irreplaceable thing in this repo: handwriting, transcripts,
# chats, and the documents filed into folders. It is gitignored by design, so git is
# NOT the backup. This is.
#
# Every push writes a full snapshot on the box, but files that did not change are
# hardlinked into the previous snapshot, so keeping a month of daily backups of a
# notebook costs one copy plus the changes.
#
#   scripts/backup.sh check              can we reach the box, and what would move
#   scripts/backup.sh push               mirror ./data over and snapshot it (default)
#   scripts/backup.sh pull               newest snapshot into ./data-restored-<stamp>
#   scripts/backup.sh pull --into-data   newest snapshot straight into ./data
#   scripts/backup.sh list               snapshots and disk use on the box
#
# Configuration lives in .env, which is never committed:
#
#   NL_BACKUP_HOST=user@your-box            required, an SSH target your key reaches
#   NL_BACKUP_PATH=/srv/nuclear-learning        required, the directory on the box
#   NL_BACKUP_PORT=22                       optional
#   NL_BACKUP_SSH_KEY=~/.ssh/id_ed25519     optional
#   NL_BACKUP_KEEP=30                       optional, snapshots kept on the box
#   NL_BACKUP_EVERY_MIN=0                   optional, minutes between automatic
#                                           pushes while the dev server runs
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA="$ROOT/data"
STAMP="$(date +%Y-%m-%dT%H-%M-%S)"

# The same .env the app reads its API key from; only NL_* is taken out of it, and
# only when the variable is not already set in the environment.
if [ -f "$ROOT/.env" ]; then
  while IFS='=' read -r key value; do
    [ -n "${!key:-}" ] || export "$key=$(printf '%s' "$value" | sed -e 's/^"//' -e 's/"$//')"
  done < <(grep -E '^NL_[A-Z_]+=' "$ROOT/.env" || true)
fi

HOST="${NL_BACKUP_HOST:-}"
REMOTE="${NL_BACKUP_PATH:-}"
PORT="${NL_BACKUP_PORT:-22}"
KEY="${NL_BACKUP_SSH_KEY:-}"
KEEP="${NL_BACKUP_KEEP:-30}"

if [ -z "$HOST" ] || [ -z "$REMOTE" ]; then
  cat >&2 <<'MSG'
backup: not configured. Add this to .env (and nothing else is needed):

  NL_BACKUP_HOST=user@your-hetzner-box
  NL_BACKUP_PATH=/srv/nuclear-learning

The SSH key you already use for that box is the one this uses. Check it with:
  npm run backup:check
MSG
  exit 2
fi

SSH_OPTS=(-p "$PORT")
[ -n "$KEY" ] && SSH_OPTS+=(-i "${KEY/#\~/$HOME}")
# The dev server runs this unattended, where a password prompt would hang forever.
[ -n "${NL_BACKUP_BATCH:-}" ] && SSH_OPTS+=(-o BatchMode=yes -o ConnectTimeout=10)
RSH="ssh ${SSH_OPTS[*]}"

# A Hetzner Storage Box answers SSH with a restricted shell: bare commands only, no
# pipes, no loops, no symlinks. Everything below therefore sends ONE plain command at
# a time and does the thinking locally, which costs nothing on a real Linux box and
# is the difference between working and not on a storage box.
remote_sh() {
  ssh "${SSH_OPTS[@]}" "$HOST" "$1"
}

# The snapshots on the box, oldest first. The stamps sort by name, so the last line
# is the newest, and no remote sorting is needed.
remote_snapshots() {
  remote_sh "ls -1 '$REMOTE/snapshots'" 2>/dev/null | tr -d '\r' | sort || true
}

# Can we log in at all? ssh exits 255 for its own failures (auth, connection) and
# passes anything else through from the remote side, which is how this tells "wrong
# key" apart from "that box has a restricted shell and does not know that command".
require_login() {
  local err rc
  err="$(ssh "${SSH_OPTS[@]}" -o BatchMode=yes -o ConnectTimeout=10 "$HOST" ls 2>&1)" && return 0
  rc=$?
  [ "$rc" != 255 ] && return 0
  cat >&2 <<MSG
backup: cannot log in to $HOST
  ssh said: $(printf '%s' "$err" | tail -1)

  Install your public key on the box once (it will ask for the box password):
    ssh-copy-id -p $PORT -s -i ~/.ssh/id_ed25519.pub $HOST

  A Hetzner Storage Box needs the -s (SFTP) form, because it has no login shell.
MSG
  exit 1
}

ensure_dirs() {
  remote_sh "mkdir -p '$REMOTE/snapshots'" 2>/dev/null ||
    { remote_sh "mkdir '$REMOTE'" 2>/dev/null || true; remote_sh "mkdir '$REMOTE/snapshots'" 2>/dev/null || true; }
}

prune() {
  local keep_from
  keep_from=$((KEEP + 1))
  remote_snapshots | sort -r | tail -n "+$keep_from" | while read -r old; do
    [ -n "$old" ] && remote_sh "rm -rf '$REMOTE/snapshots/$old'" || true
  done
}

cmd_check() {
  echo "backup: $HOST:$REMOTE"
  require_login
  ensure_dirs
  local prev
  prev="$(remote_snapshots | tail -1)"
  echo "backup: snapshots on the box: $(remote_snapshots | wc -l | tr -d ' ') (newest ${prev:-none})"
  echo "backup: what a push would move --"
  local link=()
  [ -n "$prev" ] && link=(--link-dest="$REMOTE/snapshots/$prev")
  # ${a[@]+"${a[@]}"}: an empty array is an unbound variable to the bash that ships
  # with macOS, and this script runs under set -u.
  rsync -az --delete --dry-run --stats -e "$RSH" ${link[@]+"${link[@]}"} \
    "$DATA/" "$HOST:$REMOTE/snapshots/dry-run/" | grep -E 'Number of|Total transferred' || true
}

cmd_push() {
  if [ ! -d "$DATA" ]; then
    echo "backup: no ./data yet, nothing to push"
    exit 0
  fi
  require_login
  ensure_dirs
  local prev link=()
  prev="$(remote_snapshots | tail -1)"
  # Unchanged files become hardlinks into the previous snapshot, so a full history
  # costs one copy plus the changes.
  [ -n "$prev" ] && link=(--link-dest="$REMOTE/snapshots/$prev")
  rsync -az --delete --partial -e "$RSH" ${link[@]+"${link[@]}"} \
    "$DATA/" "$HOST:$REMOTE/snapshots/$STAMP/"
  prune
  echo "backup: pushed $STAMP"
}

cmd_pull() {
  local dest="$ROOT/data-restored-$STAMP" newest
  [ "${1:-}" = "--into-data" ] && dest="$DATA"
  newest="$(remote_snapshots | tail -1)"
  if [ -z "$newest" ]; then
    echo "backup: nothing on the box yet" >&2
    exit 1
  fi
  mkdir -p "$dest"
  # No --delete: a restore never silently removes something the box has not seen.
  rsync -az --partial -e "$RSH" "$HOST:$REMOTE/snapshots/$newest/" "$dest/"
  echo "backup: restored $newest into $dest"
}

cmd_list() {
  remote_snapshots | tail -20
}

case "${1:-push}" in
  check) cmd_check ;;
  push) cmd_push ;;
  pull) cmd_pull "${2:-}" ;;
  list) cmd_list ;;
  *)
    echo "usage: scripts/backup.sh [check|push|pull [--into-data]|list]" >&2
    exit 2
    ;;
esac
