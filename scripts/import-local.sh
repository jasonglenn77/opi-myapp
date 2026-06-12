#!/bin/sh
# Runs INSIDE the local MySQL container (myapp-mysql-dev). Imports the prod dump
# that was copied to /tmp, then unlinks QuickBooks by clearing its tokens.
# Uses the container's own MYSQL_ROOT_PASSWORD / MYSQL_DATABASE env vars, so no
# secrets live in this file.
set -e

gunzip -f /tmp/prod_dump.sql.gz

echo "Recreating database ${MYSQL_DATABASE} ..."
mysql -uroot -p"${MYSQL_ROOT_PASSWORD}" -e "DROP DATABASE IF EXISTS ${MYSQL_DATABASE}; CREATE DATABASE ${MYSQL_DATABASE};"

echo "Importing prod data ..."
mysql -uroot -p"${MYSQL_ROOT_PASSWORD}" "${MYSQL_DATABASE}" < /tmp/prod_dump.sql

echo "Unlinking QuickBooks (clearing qbo_connection) ..."
mysql -uroot -p"${MYSQL_ROOT_PASSWORD}" "${MYSQL_DATABASE}" -e "TRUNCATE TABLE qbo_connection;" 2>/dev/null || true

rm -f /tmp/prod_dump.sql /tmp/import-local.sh
echo "Local DB refreshed from prod; QuickBooks unlinked."
