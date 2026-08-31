#!/usr/bin/env bash
#
# Keep ./data in step across machines through a private git repository.
#
# ./data is the local file database: notes, handwriting, chats, the Aufgaben archive,
# the retrieval index. The app treats it as the source of truth, and it is gitignored
# in THIS repository on purpose, because personal state does not belong next to the
# code that reads it. It lives in its own private repository instead, and this script
# is the only thing that talks to it.
#
# What this is and is not:
#   sync (this)        one shared timeline, every machine converges on the same state
#   backup.sh (rsync)  dated snapshots on the box, what you restore a lost note from
# They answer different questions. A delete travels through sync and is caught by
# backup, so keep both.
#
#   scripts/sync.sh init        set this machine up: clone ./data, install the agent,
#                               sync once. The only command a new machine needs.
#   scripts/sync.sh sync        commit, pull, push (the default, and what the agent runs)
#   scripts/sync.sh push        commit and push only
#   scripts/sync.sh pull        fetch and merge only
#   scripts/sync.sh status      what is local, what is remote, is the agent running
#   scripts/sync.sh install     run sync every few minutes from launchd
#   scripts/sync.sh uninstall   stop that
#   scripts/sync.sh gc          repack, after a long stretch of drawing
#   scripts/sync.sh autostart   what `npm install` runs: do whichever of the above
#                               this machine still needs, and never fail the install
#
# Configuration is optional and lives in .env, which is never committed:
#
#   NL_SYNC_REMOTE=git@github.com:191-iota/nuclear-learning-data.git
#   NL_SYNC_EVERY_MIN=5      minutes between automatic runs
#
# Conflicts. Two machines editing the same note between two syncs is the only case
# git cannot decide alone. The rule here is: the side whose commit is newer wins the
# file, and BOTH sides are written out to ./data-conflicts/<stamp>/ first, so the
# choice is never a loss. .gitattributes in the data repository marks everything
# binary, which is what stops git from writing conflict markers into a JSON record
# and corrupting it.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA="$ROOT/data"
STAMP="$(date +%Y-%m-%dT%H-%M-%S)"
HOSTNAME_SHORT="$(hostname -s 2>/dev/null || echo machine)"
LABEL="com.nuclear-learning.sync"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/nuclear-learning-sync.log"
LOCK="$DATA/.git/nl-sync.lock"

if [ -f "$ROOT/.env" ]; then
  while IFS='=' read -r key value; do
    [ -n "${!key:-}" ] || export "$key=$(printf '%s' "$value" | sed -e 's/^"//' -e 's/"$//')"
  done < <(grep -E '^NL_[A-Z_]+=' "$ROOT/.env" || true)
fi

REMOTE="${NL_SYNC_REMOTE:-git@github.com:191-iota/nuclear-learning-data.git}"
EVERY_MIN="${NL_SYNC_EVERY_MIN:-5}"

# The agent runs this with no terminal attached, where any prompt would hang until
# the next reboot. Everything below fails fast instead.
export GIT_TERMINAL_PROMPT=0
export GIT_SSH_COMMAND="${GIT_SSH_COMMAND:-ssh -o BatchMode=yes -o ConnectTimeout=15}"

say() { printf 'sync: %s\n' "$*"; }
die() { printf 'sync: %s\n' "$*" >&2; exit 1; }

git_data() { git -C "$DATA" "$@"; }

require_repo() {
  [ -d "$DATA/.git" ] || die "./data is not a clone yet. Run: scripts/sync.sh init"
}

# mkdir is atomic on every filesystem this will ever see, which makes it a lock. A
# lock older than an hour is a crashed run, not a running one.
take_lock() {
  if ! mkdir "$LOCK" 2>/dev/null; then
    if [ -n "$(find "$LOCK" -maxdepth 0 -mmin +60 2>/dev/null)" ]; then
      rm -rf "$LOCK"; mkdir "$LOCK"
    else
      say "another run is in progress, skipping"; exit 0
    fi
  fi
  trap 'rm -rf "$LOCK"' EXIT
}

# `launchctl list | grep -q` looks right and is not: grep exits on the first match,
# launchctl dies of SIGPIPE, and pipefail turns that into "no agent". Read the list
# into a variable and match it there.
agent_running() {
  local list
  list="$(launchctl list 2>/dev/null || true)"
  case "$list" in
    *"$LABEL"*) return 0 ;;
  esac
  return 1
}

commit_local() {
  [ -n "$(git_data status --porcelain)" ] || return 0
  git_data add -A
  git_data -c user.name="191-iota" -c user.email="101976629+191-iota@users.noreply.github.com" \
    commit -q -m "$HOSTNAME_SHORT $STAMP"
  say "committed local changes"
}

# Both sides of every conflicted file land here before anything is decided, so the
# losing version is always still on disk under a name the app does not read.
keep_both() {
  local f="$1" dir="$ROOT/data-conflicts/$STAMP"
  mkdir -p "$dir/$(dirname "$f")"
  git_data show ":2:$f" > "$dir/$f.this-machine" 2>/dev/null || true
  git_data show ":3:$f" > "$dir/$f.other-machine" 2>/dev/null || true
  # One side of a delete-against-edit has no content to save, and a zero byte file
  # here would read as "the note was empty" instead of "the note was deleted".
  [ -s "$dir/$f.this-machine" ] || rm -f "$dir/$f.this-machine"
  [ -s "$dir/$f.other-machine" ] || rm -f "$dir/$f.other-machine"
}

resolve_conflicts() {
  local f ours theirs winner=0
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    keep_both "$f"
    ours="$(git_data log -1 --format=%ct HEAD -- "$f" 2>/dev/null || echo 0)"
    theirs="$(git_data log -1 --format=%ct MERGE_HEAD -- "$f" 2>/dev/null || echo 0)"
    if [ "${theirs:-0}" -gt "${ours:-0}" ]; then
      git_data checkout --theirs -- "$f" 2>/dev/null && git_data add -- "$f" \
        || git_data rm -q -f -- "$f" >/dev/null 2>&1 || true
      say "conflict on $f: kept the other machine"
    else
      git_data checkout --ours -- "$f" 2>/dev/null && git_data add -- "$f" \
        || git_data rm -q -f -- "$f" >/dev/null 2>&1 || true
      say "conflict on $f: kept this machine"
    fi
    winner=1
  done < <(git_data diff --name-only --diff-filter=U)
  git_data -c user.name="191-iota" -c user.email="101976629+191-iota@users.noreply.github.com" \
    commit -q --no-edit
  if [ "$winner" = 1 ]; then
    say "both versions of every conflicted file are in ./data-conflicts/$STAMP"
  fi
  return 0
}

pull_remote() {
  git_data fetch -q origin main || { say "cannot reach the remote, staying local"; return 1; }
  local before after incoming
  before="$(git_data rev-parse HEAD)"
  git_data merge --no-edit -q origin/main 2>/dev/null || resolve_conflicts
  after="$(git_data rev-parse HEAD)"
  if [ "$before" != "$after" ]; then
    incoming="$(git_data rev-list --count "$before..$after")"
    say "pulled $incoming commit(s) from the other side"
  fi
  return 0
}

push_remote() {
  git_data push -q origin main 2>/dev/null && return 0
  # Somebody pushed between our fetch and our push. Take their side in and try once more.
  say "remote moved, merging again"
  pull_remote || return 1
  git_data push -q origin main || { say "push failed"; return 1; }
}

cmd_init() {
  if [ -d "$DATA/.git" ]; then
    say "./data is already a clone of $(git_data remote get-url origin)"
    exit 0
  fi
  if [ -d "$DATA" ] && [ -n "$(ls -A "$DATA" 2>/dev/null)" ]; then
    die "./data already has files in it. Move it aside first, then run init:
       mv data data-before-sync && scripts/sync.sh init"
  fi
  git clone -q "$REMOTE" "$DATA"
  say "cloned the database into ./data"
  # A clone alone leaves you with a snapshot that starts going stale immediately.
  # Being set up means the agent is in place and one round has already run.
  install_agent_if_possible
  cmd_sync || true
  cmd_status
}

# launchd is macOS only. Everywhere else the dev server timer (server/sync.ts) is
# what keeps the two sides in step, so a missing launchctl is not a failure.
install_agent_if_possible() {
  if ! command -v launchctl >/dev/null 2>&1; then
    say "no launchctl here, so the dev server timer does the syncing (NL_SYNC_EVERY_MIN)"
    return 0
  fi
  if agent_running; then
    say "agent already installed"
    return 0
  fi
  cmd_install
}

# What `npm install` runs. A fresh clone of the code on a machine that has never seen
# this database should end up working without anyone remembering a second command,
# and no branch below may fail, because failing here would fail the install.
cmd_autostart() {
  if [ "${CI:-}" = "true" ] || [ "${NL_SYNC_AUTOSTART:-1}" = "0" ]; then
    return 0
  fi
  if [ ! -d "$DATA/.git" ]; then
    if [ -d "$DATA" ] && [ -n "$(ls -A "$DATA" 2>/dev/null)" ]; then
      say "./data holds files but is not a clone, leaving it untouched (see scripts/sync.sh init)"
      return 0
    fi
    if git clone -q "$REMOTE" "$DATA" 2>/dev/null; then
      say "first run on this machine, cloned the database into ./data"
    else
      say "cannot reach $REMOTE from here yet. Put your ssh key on this machine, then: scripts/sync.sh init"
      return 0
    fi
  fi
  install_agent_if_possible || true
  cmd_sync || true
  return 0
}

cmd_sync() {
  require_repo; take_lock
  commit_local
  pull_remote || exit 0
  local ahead
  ahead="$(git_data rev-list --count origin/main..HEAD)"
  if [ "$ahead" = 0 ]; then
    say "up to date"
    return 0
  fi
  push_remote && say "pushed $ahead commit(s)"
}

cmd_push() {
  require_repo; take_lock
  commit_local
  push_remote && say "pushed"
}

cmd_pull() {
  require_repo; take_lock
  commit_local
  pull_remote && say "pulled"
}

cmd_status() {
  require_repo
  local ahead behind dirty
  git_data fetch -q origin main 2>/dev/null || say "(offline, counts are from the last fetch)"
  ahead="$(git_data rev-list --count origin/main..HEAD 2>/dev/null || echo '?')"
  behind="$(git_data rev-list --count HEAD..origin/main 2>/dev/null || echo '?')"
  dirty="$(git_data status --porcelain | wc -l | tr -d ' ')"
  echo "remote     $(git_data remote get-url origin)"
  echo "size       $(du -sh "$DATA" | cut -f1) on disk, $(git_data count-objects -vH | awk '/size-pack/{print $2, $3}') packed"
  echo "uncommitted $dirty file(s)"
  echo "ahead      $ahead commit(s) not pushed"
  echo "behind     $behind commit(s) not pulled"
  echo "last       $(git_data log -1 --format='%h %ad %s' --date=format:'%Y-%m-%d %H:%M' 2>/dev/null)"
  if agent_running; then
    echo "agent      running every $EVERY_MIN min, log at $LOG"
  else
    echo "agent      not installed (scripts/sync.sh install)"
  fi
  # Under pipefail a failing ls ends the script, and a missing directory is the
  # normal case here, so the existence test comes first.
  if [ -d "$ROOT/data-conflicts" ]; then
    local conflicts
    conflicts="$(find "$ROOT/data-conflicts" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')"
    if [ "$conflicts" != 0 ]; then
      echo "conflicts  $conflicts set(s) in ./data-conflicts, both versions kept, look at them"
    fi
  fi
  return 0
}

cmd_install() {
  require_repo
  mkdir -p "$(dirname "$PLIST")" "$(dirname "$LOG")"
  cat > "$PLIST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$ROOT/scripts/sync.sh</string>
    <string>sync</string>
  </array>
  <key>StartInterval</key><integer>$((EVERY_MIN * 60))</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>HOME</key><string>$HOME</string>
  </dict>
</dict>
</plist>
PLISTEOF
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null || launchctl load -w "$PLIST"
  say "agent installed, runs every $EVERY_MIN min and once at login"
  say "log: $LOG"
}

cmd_uninstall() {
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || launchctl unload -w "$PLIST" 2>/dev/null || true
  rm -f "$PLIST"
  say "agent removed. ./data stays where it is and sync still works by hand."
}

cmd_gc() {
  require_repo
  say "before: $(git_data count-objects -vH | awk '/size-pack/{print $2, $3}')"
  git_data gc --prune=now -q
  say "after:  $(git_data count-objects -vH | awk '/size-pack/{print $2, $3}')"
}

case "${1:-sync}" in
  init) cmd_init ;;
  autostart) cmd_autostart ;;
  sync) cmd_sync ;;
  push) cmd_push ;;
  pull) cmd_pull ;;
  status) cmd_status ;;
  install) cmd_install ;;
  uninstall) cmd_uninstall ;;
  gc) cmd_gc ;;
  *)
    echo "usage: scripts/sync.sh [init|sync|push|pull|status|install|uninstall|gc|autostart]" >&2
    exit 2
    ;;
esac
