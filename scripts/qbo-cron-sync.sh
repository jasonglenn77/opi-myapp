#!/usr/bin/env bash
# Nightly QuickBooks transactions sync — run by host cron on the PROD server.
#
# Execs into the running backend container and calls the exact same in-process
# sync the admin "Sync transactions" button triggers, so it also:
#   - refreshes recurring-overhead run-rates (refresh_auto_from_runrate), and
#   - exercises the QBO token refresh, keeping the shared refresh token alive.
#
# Idempotent and safe to re-run (the sync pulls incrementally with a 24h overlap).
# Install (one-time, on the prod host):
#   ( crontab -l 2>/dev/null | grep -v qbo-cron-sync.sh ; \
#     echo '0 9 * * * bash /home/ubuntu/apps/myapp/scripts/qbo-cron-sync.sh >> /home/ubuntu/qbo-sync.log 2>&1' ) | crontab -
#   ( 09:00 UTC ≈ 4am US Central. Adjust the hour for a different local time. )
set -uo pipefail
ts() { date -u +%FT%TZ; }

echo "[$(ts)] qbo-cron-sync: start"
if ! docker ps --format '{{.Names}}' | grep -q '^myapp-backend$'; then
  echo "[$(ts)] qbo-cron-sync: myapp-backend not running — skipping"
  exit 0
fi

docker exec myapp-backend python -c "from app.qbo import service; import json; print(json.dumps(service.run_transactions_sync(triggered_by='cron'), default=str))"
rc=$?
echo "[$(ts)] qbo-cron-sync: done (exit ${rc})"
exit ${rc}
