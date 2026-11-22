#!/bin/bash
set -euo pipefail
umask 077

root=/workspace/agamajung/auto-deploy
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.."
exec 9>>"$root/controller.lock"
/usr/bin/flock --nonblock --conflict-exit-code 75 9

exec "$PWD/node_modules/node/bin/node" --import tsx tools/auto-deploy/index.ts
