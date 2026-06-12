# Refreshes the LOCAL dev database from PRODUCTION, then unlinks QuickBooks locally.
# Run from your Windows machine. Prereqs: SSH access to the server (key below) and
# the local dev MySQL container running (docker compose -f docker-compose.dev.yml up).
#
#   powershell -ExecutionPolicy Bypass -File scripts\refresh-local-from-prod.ps1
$ErrorActionPreference = "Stop"

# --- adjust if your paths/host differ ---
$Key        = "C:\Users\jason\Downloads\LightsailDefaultKey-us-east-2.pem"
$Server     = "ubuntu@18.216.187.68"
$Container  = "myapp-mysql-dev"
$RemoteDump = "/tmp/prod_dump.sql.gz"
$LocalDump  = Join-Path $env:TEMP "prod_dump.sql.gz"
$ScriptDir  = Split-Path -Parent $MyInvocation.MyCommand.Path
# -----------------------------------------

Write-Host "1/4  Dumping prod on the server (read-only)..." -ForegroundColor Cyan
ssh -i $Key $Server "bash ~/apps/myapp/scripts/dump-prod.sh"

Write-Host "2/4  Downloading dump..." -ForegroundColor Cyan
scp -i $Key "${Server}:${RemoteDump}" "$LocalDump"

Write-Host "3/4  Copying dump + importer into the local container..." -ForegroundColor Cyan
docker cp "$LocalDump" "${Container}:/tmp/prod_dump.sql.gz"
docker cp "$ScriptDir\import-local.sh" "${Container}:/tmp/import-local.sh"

Write-Host "4/4  Importing + unlinking QuickBooks..." -ForegroundColor Cyan
docker exec $Container sh /tmp/import-local.sh

# Cleanup temp files (local + server)
Remove-Item "$LocalDump" -ErrorAction SilentlyContinue
ssh -i $Key $Server "rm -f $RemoteDump"

Write-Host "`nDone. Local DB now mirrors prod, with QuickBooks unlinked." -ForegroundColor Green
