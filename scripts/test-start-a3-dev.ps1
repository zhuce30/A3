$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$scriptPath = Join-Path $PSScriptRoot "start-a3-dev.ps1"

if (-not (Test-Path -LiteralPath $scriptPath)) {
  throw "Missing startup script: $scriptPath"
}

$tokens = $null
$errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($scriptPath, [ref]$tokens, [ref]$errors)
if ($errors.Count -gt 0) {
  $messages = ($errors | ForEach-Object { $_.Message }) -join "; "
  throw "PowerShell parse errors: $messages"
}

$source = Get-Content -Raw -LiteralPath $scriptPath
$requiredSnippets = @(
  "backend\manage.py",
  "pnpm.cmd",
  "realtime:dashscope-proxy",
  "a3-dev-processes.json",
  "a3-backend.log",
  "a3-frontend.log",
  "a3-realtime-proxy.log",
  "a3-celery-worker.log",
  "a3-celery-worker-error.log",
  "A3_REALTIME_WS_PROXY_PORT",
  "assessments.refill_personal_question_pool",
  "inspect registered",
  "--pool=solo",
  "Get-CeleryWorkerProcesses",
  "Wait-CeleryWorker",
  "http://127.0.0.1:3002",
  "http://127.0.0.1:8000",
  "http://127.0.0.1:3003/health"
)

foreach ($snippet in $requiredSnippets) {
  if (-not $source.Contains($snippet)) {
    throw "Startup script missing required snippet: $snippet"
  }
}

$help = & $scriptPath -Help
if ($LASTEXITCODE -ne 0) {
  throw "Help command failed"
}
if (($help -join "`n") -notmatch "start-a3-dev.ps1") {
  throw "Help output does not describe the startup script"
}

Write-Host "start-a3-dev.ps1 static checks passed"
