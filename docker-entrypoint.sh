#!/bin/sh
# Runs as root only long enough to make the persistent volume writable by the unprivileged app user,
# then replaces itself with the Node process running as "node". Nothing else runs as root.
set -eu
DATA_DIR="${DATA_DIR:-/data}"
mkdir -p "$DATA_DIR"
if [ "$(stat -c %u "$DATA_DIR")" != "$(id -u node)" ]; then
  chown node:node "$DATA_DIR"
fi
chmod 0750 "$DATA_DIR"
exec setpriv --reuid=node --regid=node --init-groups --inh-caps=-all --bounding-set=-all --no-new-privs -- "$@"
