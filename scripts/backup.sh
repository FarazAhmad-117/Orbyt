#!/usr/bin/env sh
# Back up the Orbyt database (everything lives in Postgres: contacts, mail, workflows, settings, and
# the encrypted credentials). Keep ORBYT_ENCRYPTION_KEY / BETTER_AUTH_SECRET safe too: without them the
# stored mailbox passwords and API keys in a backup cannot be decrypted.
#
#   DATABASE_URL=postgres://orbyt:orbyt@127.0.0.1:5432/orbyt ./scripts/backup.sh [output-dir]
#   ./scripts/backup.sh --docker [output-dir]     # runs pg_dump inside the compose postgres container
#
# Restore into an empty database:  pg_restore --no-owner --clean --if-exists -d "$DATABASE_URL" backup.dump
set -eu

mode=direct
if [ "${1:-}" = "--docker" ]; then mode=docker; shift; fi
dir="${1:-backups}"
mkdir -p "$dir"
file="$dir/orbyt-$(date +%Y%m%d-%H%M%S).dump"

if [ "$mode" = docker ]; then
  docker compose exec -T postgres pg_dump -U "${POSTGRES_USER:-orbyt}" -Fc "${POSTGRES_DB:-orbyt}" > "$file"
else
  : "${DATABASE_URL:?Set DATABASE_URL (or use --docker)}"
  pg_dump "$DATABASE_URL" -Fc -f "$file"
fi

# A dump that is empty or truncated is worse than none: fail loudly.
[ -s "$file" ] || { echo "backup failed: $file is empty" >&2; rm -f "$file"; exit 1; }
echo "$file"
