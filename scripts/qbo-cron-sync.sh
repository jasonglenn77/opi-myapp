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

# Customers first (new QBO projects/customers exist before their transactions reference them)
docker exec myapp-backend python -c "from app.qbo import service; import json; print(json.dumps(service.run_customers_sync(triggered_by='cron'), default=str))"
docker exec myapp-backend python -c "from app.qbo import service; import json; print(json.dumps(service.run_transactions_sync(triggered_by='cron'), default=str))"
rc=$?
# Then Google Drive: re-read the B151 + Job Schedule, mirror the B151 into the
# Pipeline and link quotes to the freshly synced QBO projects (Data Review page).
docker exec myapp-backend python -m app.gsync.run --cron || echo "[$(ts)] gsync failed (see gsync_runs)"
# Re-measure the forecast assumptions (expense timing per category, bill-to-
# payment lag) from the freshly synced bills; shown on the Assumptions page.
# New expense schedules use them; existing rows are re-spread only on request.
docker exec myapp-backend python -m app.assumptions.calibrate || echo "[$(ts)] assumptions recalibrate failed"
# Rebuild the saved page results (Tracker, Data Review, Overview job cost) from
# tonight's data so the first person in the morning doesn't wait (0089).
docker exec myapp-backend python -m app.snapshots warm || echo "[$(ts)] page snapshot warm failed"
echo "[$(ts)] qbo-cron-sync: done (exit ${rc})"
exit ${rc}
