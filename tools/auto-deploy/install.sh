#!/bin/bash
set -euo pipefail
set +x
umask 077

if [[ ${1:-} == --dry-run && $# == 1 ]]; then
  cat <<'PLAN'
Verify the checked-out revision is on origin/main and select Node 22.
Install its tracked files and locked dependencies in /workspace/agamajung/auto-deploy/controllers/<sha>.
Start or refresh only agamajung-auto-deploy, leaving a healthy matching revision running.
Verify its PM2 registration and run pm2 save.
PLAN
  exit 0
fi
if (( $# )); then
  printf '%s\n' 'Usage: tools/auto-deploy/install.sh [--dry-run]' >&2
  exit 2
fi

fail() { printf '%s\n' "$1" >&2; exit 1; }
root=/workspace/agamajung/auto-deploy
name=agamajung-auto-deploy
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.."
source_repo=$PWD

# PM2 imports its CLI environment into newly registered apps. Use the same
# allowlist for npm and PM2 so invocation from an operator shell stays safe.
service_env=(env -i "HOME=$HOME" "USER=$(id -un)" "LOGNAME=$(id -un)" "PATH=$PATH" "TZ=Asia/Seoul")
if [[ -n ${PM2_HOME:-} ]]; then service_env+=("PM2_HOME=$PM2_HOME"); fi
git_read() { "${service_env[@]}" GIT_TERMINAL_PROMPT=0 git -C "$source_repo" "$@" 2>/dev/null; }
revision=$(git_read rev-parse --verify 'HEAD^{commit}') || fail 'Controller revision unavailable.'
[[ $revision =~ ^[0-9a-f]{40}$ ]] || fail 'Controller revision invalid.'
origin=$(git_read config --get remote.origin.url) || fail 'Controller repository origin unavailable.'
case "$origin" in
  https://github.com/SUNBURN-Golden/geunbon-baby.git|git@github.com:SUNBURN-Golden/geunbon-baby.git) ;;
  *) fail 'Controller repository origin invalid.' ;;
esac
git_read merge-base --is-ancestor "$revision" refs/remotes/origin/main || fail 'Controller revision must be on the locally verified origin/main.'

bootstrap=''
for candidate in "$source_repo/node_modules/node/bin/node" "$(command -v node || true)" /workspace/agamajung/repo/node_modules/node/bin/node; do
  if [[ -x $candidate ]] && [[ $("${service_env[@]}" "$candidate" --version 2>/dev/null) == v22.* ]]; then
    bootstrap=$candidate
    break
  fi
done
[[ -n $bootstrap ]] || fail 'Node 22 is required for installation.'
service_env[5]="PATH=$(dirname -- "$bootstrap"):$PATH"

mkdir -p -- "$root/controllers"
[[ $(realpath -- "$root/controllers") == "$root/controllers" ]] || fail 'Controller installation directory invalid.'
exec 8>>"$root/install.lock"
flock 8
# Keep the inode stable across installs and restarts.
: >>"$root/controller.lock"
installation="$root/controllers/$revision"

if [[ ! -f $installation/.installed ]]; then
  staging=$(mktemp -d "$root/controllers/.install-XXXXXXXX")
  trap 'rm -rf -- "$staging"' EXIT
  git_read archive "$revision" | tar -x -C "$staging" || fail 'Controller archive unavailable.'
  [[ -x $staging/tools/auto-deploy/run.sh ]] || fail 'Controller entrypoint unavailable.'
  (cd -- "$staging" && "${service_env[@]}" CI=true npm_config_userconfig=/dev/null npm ci --include=dev) >/dev/null 2>&1 ||
    fail 'Controller dependency installation failed.'
  [[ $("${service_env[@]}" "$staging/node_modules/node/bin/node" --version 2>/dev/null) == v22.* ]] || fail 'Installed Node 22 unavailable.'
  printf '%s\n' "$revision" >"$staging/.installed"
  mv -T -- "$staging" "$installation" || fail 'Controller installation could not be finalized.'
fi
[[ $(realpath -- "$installation") == "$installation" && $(<"$installation/.installed") == "$revision" ]] ||
  fail 'Controller installation identity invalid.'

pm2_safe() { "${service_env[@]}" pm2 "$@" 8>&-; }
registration() {
  pm2_safe jlist 2>/dev/null | "${service_env[@]}" "$bootstrap" -e '
    const fs = require("node:fs");
    try {
      const items = JSON.parse(fs.readFileSync(0, "utf8")).filter(p => p.name === "agamajung-auto-deploy");
      if (items.length === 0) process.exit(0);
      if (items.length !== 1) process.exit(1);
      const [p] = items, env = p.pm2_env;
      const cwd = env.pm_cwd;
      const prefix = process.argv[1] + "/controllers/";
      if (typeof cwd !== "string" || !cwd.startsWith(prefix) || !/^[0-9a-f]{40}$/.test(cwd.slice(prefix.length)) ||
          env.pm_exec_path !== cwd + "/tools/auto-deploy/run.sh") process.exit(1);
      const healthy = (env.status === "online" || env.status === "launching") && p.pid > 0;
      process.stdout.write(cwd + "|" + (healthy ? "running" : "stopped"));
    } catch { process.exit(1); }
  ' "$root" 2>/dev/null
}

registered=$(registration) || fail 'Controller registration could not be verified.'
if [[ $registered != "$installation|running" ]]; then
  previous=${registered%|*}
  if [[ -n $registered ]]; then
    pm2_safe delete "$name" >/dev/null 2>&1 || fail 'Existing controller could not be stopped.'
  fi
  flock -w 610 "$root/controller.lock" true || fail 'Controller lock remained held.'
  if ! pm2_safe start "$installation/tools/auto-deploy/ecosystem.config.cjs" --only "$name" >/dev/null 2>&1 ||
      [[ $(registration) != "$installation|running" ]]; then
    failed_registration=$(registration || true)
    if [[ $failed_registration == "$installation|"* ]]; then
      pm2_safe delete "$name" >/dev/null 2>&1 || true
    fi
    if [[ -n $previous && -z $(registration || printf 'unavailable') ]]; then
      pm2_safe start "$previous/tools/auto-deploy/ecosystem.config.cjs" --only "$name" >/dev/null 2>&1 || true
    fi
    fail 'Controller start could not be verified.'
  fi
fi
pm2_safe save >/dev/null 2>&1 || fail 'PM2 save failed.'
printf '%s\n' "agamajung-auto-deploy registered at $revision."
