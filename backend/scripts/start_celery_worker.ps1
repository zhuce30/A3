$ErrorActionPreference = "Stop"

$backendRoot = Split-Path -Parent $PSScriptRoot
$projectRoot = Split-Path -Parent $backendRoot
$python = Join-Path $backendRoot ".venv\Scripts\python.exe"

if (-not (Test-Path $python)) {
    throw "Virtual environment not found: $python"
}

Set-Location $projectRoot
& $python -m celery `
    -A backend.config.celery:app `
    worker `
    --pool=solo `
    --concurrency=1 `
    --loglevel=INFO `
    --without-gossip `
    --without-mingle `
    --without-heartbeat
