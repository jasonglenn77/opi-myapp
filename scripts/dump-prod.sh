#!/usr/bin/env bash
# Dumps the PRODUCTION MySQL database to a gzipped file on THIS server (/tmp).
# Read-only: mysqldump issues SELECTs against a consistent snapshot, so it never
# modifies prod. Run on the Lightsail server (it can reach the managed DB).
set -euo pipefail
cd "$(dirname "$0")/.."          # repo root, where .env.prod lives

# Load prod DB creds: DB_HOST / DB_PORT / DB_NAME / DB_USER / DB_PASSWORD (+ MYSQL_SSL_MODE)
set -a; . ./.env.prod; set +a

# Match the app's SSL behavior for managed databases.
SSL_FLAG=""
case "${MYSQL_SSL_MODE:-}" in
  require|required|REQUIRED) SSL_FLAG="--ssl-mode=REQUIRED" ;;
esac

OUT="/tmp/prod_dump.sql.gz"
echo "Dumping ${DB_NAME} from ${DB_HOST} ..."

# Uses the mysql:8.0 image's mysqldump (matches the local container's version).
# --network host so the container reaches the managed DB the same way the host does.
# MYSQL_PWD keeps the password out of the process list.
docker run --rm --network host -e MYSQL_PWD="${DB_PASSWORD}" mysql:8.0 \
  mysqldump \
    -h "${DB_HOST}" -P "${DB_PORT:-3306}" -u "${DB_USER}" \
    ${SSL_FLAG} \
    --single-transaction --quick --no-tablespaces --skip-lock-tables \
    --set-gtid-purged=OFF \
    "${DB_NAME}" \
  | gzip > "${OUT}"

echo "Wrote ${OUT} ($(du -h "${OUT}" | cut -f1))"
