param(
  [switch]$Stop,
  [switch]$Status,
  [switch]$Help,
  [int]$BackendPort = 8000,
  [int]$FrontendPort = 3002,
  [int]$RealtimePort = 3003,
  [string]$HostName = "127.0.0.1",
  [switch]$Visible,
  [switch]$ReuseExisting,
  [switch]$NoForcePorts
)

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot
$BackendDir = Join-Path $Root "backend"
$FrontendDir = Join-Path $Root "OpenMAIC"
$TmpDir = Join-Path $BackendDir "tmp"
$PidFile = Join-Path $TmpDir "a3-dev-processes.json"
$BackendLog = Join-Path $TmpDir "a3-backend.log"
$FrontendLog = Join-Path $TmpDir "a3-frontend.log"
$RealtimeLog = Join-Path $TmpDir "a3-realtime-proxy.log"
$CeleryLog = Join-Path $TmpDir "a3-celery-worker.log"
$CeleryErrorLog = Join-Path $TmpDir "a3-celery-worker-error.log"
$CeleryWorkerName = "a3-worker@$([Environment]::MachineName)"
$RequiredCeleryTask = "assessments.refill_personal_question_pool"

function Show-Help {
  Write-Output @"
start-a3-dev.ps1 - start A3 local dev services

Usage:
  powershell -ExecutionPolicy Bypass -File .\scripts\start-a3-dev.ps1
  powershell -ExecutionPolicy Bypass -File .\scripts\start-a3-dev.ps1 -ReuseExisting
  powershell -ExecutionPolicy Bypass -File .\scripts\start-a3-dev.ps1 -Status
  powershell -ExecutionPolicy Bypass -File .\scripts\start-a3-dev.ps1 -Stop

Defaults:
  Backend:        http://127.0.0.1:8000
  Frontend:       http://127.0.0.1:3002
  Realtime proxy: http://127.0.0.1:3003/health
  Celery worker:  $CeleryWorkerName

Logs:
  backend\tmp\a3-backend.log
  backend\tmp\a3-frontend.log
  backend\tmp\a3-realtime-proxy.log
  backend\tmp\a3-celery-worker.log
  backend\tmp\a3-celery-worker-error.log
"@
}

function Ensure-Workspace {
  if (-not (Test-Path -LiteralPath $BackendDir)) { throw "Missing backend directory: $BackendDir" }
  if (-not (Test-Path -LiteralPath $FrontendDir)) { throw "Missing OpenMAIC directory: $FrontendDir" }
  if (-not (Test-Path -LiteralPath $TmpDir)) { New-Item -ItemType Directory -Path $TmpDir | Out-Null }
}

function Get-PortOwner {
  param([int]$Port)
  $connection = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $connection) { return $null }
  return [int]$connection.OwningProcess
}

function Stop-PortOwner {
  param(
    [string]$Name,
    [int]$Port,
    [switch]$IgnoreNoForce
  )

  $owner = Get-PortOwner -Port $Port
  if (-not $owner) { return }
  if ($NoForcePorts -and -not $IgnoreNoForce) {
    throw "$Name port $Port is already occupied by PID $owner. Stop it manually or rerun without -NoForcePorts."
  }
  $process = Get-Process -Id $owner -ErrorAction SilentlyContinue
  if (-not $process) { return }
  Write-Host "Stopping process on $Name port $Port (PID $owner, $($process.ProcessName)) before restart."
  Stop-Process -Id $owner -Force -ErrorAction Stop
  $deadline = (Get-Date).AddSeconds(12)
  while ((Get-Date) -lt $deadline) {
    if (-not (Get-PortOwner -Port $Port)) { return }
    Start-Sleep -Milliseconds 500
  }
  throw "$Name port $Port is still occupied after stopping PID $owner."
}

function Test-Url {
  param([string]$Url)
  try {
    $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 3
    return [int]$response.StatusCode
  } catch {
    return 0
  }
}

function Wait-Url {
  param(
    [string]$Name,
    [string]$Url,
    [string]$LogPath,
    [int]$TimeoutSeconds = 45
  )

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    $status = Test-Url $Url
    if ($status -ge 200 -and $status -lt 500) {
      Write-Host "$Name ready: $Url status=$status"
      return $true
    }
    Start-Sleep -Seconds 2
  }

  Write-Warning "$Name did not become ready: $Url"
  if (Test-Path -LiteralPath $LogPath) {
    Write-Warning "Last log lines from $LogPath"
    Get-Content -LiteralPath $LogPath -Tail 40 | ForEach-Object { Write-Warning $_ }
  }
  return $false
}

function Get-CeleryWorkerProcesses {
  $escapedRoot = [regex]::Escape($Root)
  return @(
    Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
      Where-Object {
        $_.CommandLine -and
        $_.Name -in @("celery.exe", "python.exe") -and
        $_.CommandLine -match $escapedRoot -and
        $_.CommandLine -match "celery(\.exe)?" -and
        $_.CommandLine -match "-A\s+backend\.config\s+worker"
      }
  )
}

function Stop-CeleryWorkers {
  $workers = Get-CeleryWorkerProcesses
  foreach ($worker in $workers) {
    Write-Host "Stopping a3-celery-worker (PID $($worker.ProcessId))"
    Stop-Process -Id $worker.ProcessId -Force -ErrorAction SilentlyContinue
  }
  if ($workers.Count) {
    $deadline = (Get-Date).AddSeconds(12)
    while ((Get-Date) -lt $deadline) {
      if (-not (Get-CeleryWorkerProcesses).Count) { return }
      Start-Sleep -Milliseconds 500
    }
    throw "A3 Celery worker is still running after stop request."
  }
}

function Test-CeleryWorker {
  param([string]$CeleryExe)

  if (-not (Get-CeleryWorkerProcesses).Count) { return $false }
  try {
    $output = & $CeleryExe -A backend.config inspect registered --destination $CeleryWorkerName --timeout 3 2>&1 | Out-String
    return $LASTEXITCODE -eq 0 -and $output.Contains($RequiredCeleryTask)
  } catch {
    return $false
  }
}

function Wait-CeleryWorker {
  param(
    [string]$CeleryExe,
    [int]$TimeoutSeconds = 45
  )

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    if (Test-CeleryWorker -CeleryExe $CeleryExe) {
      Write-Host "Celery worker ready: $CeleryWorkerName registered $RequiredCeleryTask"
      return $true
    }
    if (-not (Get-CeleryWorkerProcesses).Count) { break }
    Start-Sleep -Seconds 2
  }

  Write-Warning "Celery worker did not become ready or did not register $RequiredCeleryTask"
  foreach ($logPath in @($CeleryLog, $CeleryErrorLog)) {
    if (Test-Path -LiteralPath $logPath) {
      Write-Warning "Last log lines from $logPath"
      Get-Content -LiteralPath $logPath -Tail 40 | ForEach-Object { Write-Warning $_ }
    }
  }
  return $false
}

function Read-ProcessRecords {
  if (-not (Test-Path -LiteralPath $PidFile)) { return @() }
  try {
    $records = Get-Content -Raw -LiteralPath $PidFile | ConvertFrom-Json
    if ($null -eq $records) { return @() }
    return @($records)
  } catch {
    return @()
  }
}

function Save-ProcessRecords {
  param([array]$Records)
  $Records | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $PidFile -Encoding UTF8
}

function Stop-RecordedProcesses {
  Ensure-Workspace
  $records = Read-ProcessRecords
  if (-not $records.Count) {
    Write-Host "No recorded A3 dev processes found."
  }
  foreach ($record in $records) {
    $pidValue = [int]$record.pid
    $name = [string]$record.name
    $process = Get-Process -Id $pidValue -ErrorAction SilentlyContinue
    if ($process) {
      Write-Host "Stopping $name (PID $pidValue)"
      Stop-Process -Id $pidValue -Force -ErrorAction SilentlyContinue
    } else {
      Write-Host "$name already stopped (PID $pidValue)"
    }
  }
  Stop-PortOwner -Name "a3-backend" -Port $BackendPort -IgnoreNoForce
  Stop-PortOwner -Name "a3-frontend" -Port $FrontendPort -IgnoreNoForce
  Stop-PortOwner -Name "a3-realtime-proxy" -Port $RealtimePort -IgnoreNoForce
  Stop-CeleryWorkers
  Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue
}

function Start-ServiceProcess {
  param(
    [string]$Name,
    [string]$WorkingDirectory,
    [string]$Command,
    [string]$LogPath,
    [int]$Port
  )

  $owner = Get-PortOwner -Port $Port
  if ($owner) {
    if ($ReuseExisting) {
      Write-Host "$Name already has a listener on port $Port (PID $owner); reusing it."
      return @{
        name = $Name
        pid = $owner
        port = $Port
        log = $LogPath
        reused = $true
      }
    }
    Stop-PortOwner -Name $Name -Port $Port
  }

  $windowStyle = if ($Visible) { "Normal" } else { "Hidden" }
  $escapedCommand = "& { Set-Location -LiteralPath '$WorkingDirectory'; $Command } *> '$LogPath'"
  $process = Start-Process `
    -FilePath "powershell.exe" `
    -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", $escapedCommand) `
    -WindowStyle $windowStyle `
    -PassThru

  Write-Host "Started $Name on port $Port (launcher PID $($process.Id)); log: $LogPath"
  return @{
    name = $Name
    pid = $process.Id
    port = $Port
    log = $LogPath
    reused = $false
  }
}

function Start-CeleryWorker {
  param([string]$CeleryExe)

  $workers = Get-CeleryWorkerProcesses
  if ($workers.Count) {
    if ($ReuseExisting -and (Test-CeleryWorker -CeleryExe $CeleryExe)) {
      $worker = $workers | Select-Object -First 1
      Write-Host "Celery worker already running and healthy (PID $($worker.ProcessId)); reusing it."
      return @{
        name = "a3-celery-worker"
        pid = [int]$worker.ProcessId
        port = 0
        log = $CeleryLog
        reused = $true
      }
    }
    Stop-CeleryWorkers
  }

  Remove-Item -LiteralPath $CeleryLog -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $CeleryErrorLog -Force -ErrorAction SilentlyContinue
  $windowStyle = if ($Visible) { "Normal" } else { "Hidden" }
  $process = Start-Process `
    -FilePath $CeleryExe `
    -ArgumentList @("-A", "backend.config", "worker", "--loglevel=INFO", "--pool=solo", "--queues=celery,resource-generation", "--hostname=$CeleryWorkerName") `
    -WorkingDirectory $Root `
    -WindowStyle $windowStyle `
    -RedirectStandardOutput $CeleryLog `
    -RedirectStandardError $CeleryErrorLog `
    -PassThru

  Write-Host "Started a3-celery-worker (PID $($process.Id)); logs: $CeleryLog, $CeleryErrorLog"
  return @{
    name = "a3-celery-worker"
    pid = $process.Id
    port = 0
    log = $CeleryLog
    reused = $false
  }
}

function Show-Status {
  Ensure-Workspace
  $celeryExe = Join-Path $BackendDir ".venv\Scripts\celery.exe"
  $backendStatus = Test-Url "http://$HostName`:$BackendPort/api/auth/me/"
  $frontendStatus = Test-Url "http://$HostName`:$FrontendPort/a3/login"
  $realtimeStatus = Test-Url "http://$HostName`:$RealtimePort/health"
  $celeryStatus = if ((Test-Path -LiteralPath $celeryExe) -and (Test-CeleryWorker -CeleryExe $celeryExe)) { "ready" } else { "unavailable" }
  $celeryPids = @((Get-CeleryWorkerProcesses) | ForEach-Object { $_.ProcessId }) -join ","

  Write-Host "A3 dev status"
  Write-Host "  Backend        http://$HostName`:$BackendPort  status=$backendStatus  portOwner=$(Get-PortOwner -Port $BackendPort)"
  Write-Host "  Frontend       http://$HostName`:$FrontendPort  status=$frontendStatus  portOwner=$(Get-PortOwner -Port $FrontendPort)"
  Write-Host "  Realtime proxy http://$HostName`:$RealtimePort/health  status=$realtimeStatus  portOwner=$(Get-PortOwner -Port $RealtimePort)"
  Write-Host "  Celery worker  $CeleryWorkerName  status=$celeryStatus  pid=$celeryPids"
  Write-Host "  PID file       $PidFile"
}

if ($Help) {
  Show-Help
  exit 0
}

if ($Stop) {
  Stop-RecordedProcesses
  exit 0
}

if ($Status) {
  Show-Status
  exit 0
}

Ensure-Workspace

$PythonExe = Join-Path $BackendDir ".venv\Scripts\python.exe"
$CeleryExe = Join-Path $BackendDir ".venv\Scripts\celery.exe"
if (-not (Test-Path -LiteralPath $PythonExe)) {
  throw "Missing backend virtualenv python: $PythonExe"
}
if (-not (Test-Path -LiteralPath $CeleryExe)) {
  throw "Missing backend virtualenv Celery executable: $CeleryExe"
}

$records = @()
$records += Start-CeleryWorker -CeleryExe $CeleryExe
$records += Start-ServiceProcess `
  -Name "a3-backend" `
  -WorkingDirectory $Root `
  -Command "& '$PythonExe' 'backend\manage.py' runserver $HostName`:$BackendPort --noreload" `
  -LogPath $BackendLog `
  -Port $BackendPort

$records += Start-ServiceProcess `
  -Name "a3-frontend" `
  -WorkingDirectory $FrontendDir `
  -Command "pnpm.cmd dev -p $FrontendPort -H $HostName" `
  -LogPath $FrontendLog `
  -Port $FrontendPort

$records += Start-ServiceProcess `
  -Name "a3-realtime-proxy" `
  -WorkingDirectory $FrontendDir `
  -Command "`$env:A3_REALTIME_WS_PROXY_HOST='$HostName'; `$env:A3_REALTIME_WS_PROXY_PORT='$RealtimePort'; pnpm.cmd realtime:dashscope-proxy" `
  -LogPath $RealtimeLog `
  -Port $RealtimePort

Save-ProcessRecords -Records $records

$backendReady = Wait-Url -Name "Backend" -Url "http://$HostName`:$BackendPort/api/auth/me/" -LogPath $BackendLog
$frontendReady = Wait-Url -Name "Frontend" -Url "http://$HostName`:$FrontendPort/a3/login" -LogPath $FrontendLog -TimeoutSeconds 120
$realtimeReady = Wait-Url -Name "Realtime proxy" -Url "http://$HostName`:$RealtimePort/health" -LogPath $RealtimeLog -TimeoutSeconds 20
$celeryReady = Wait-CeleryWorker -CeleryExe $CeleryExe

Write-Host ""
Write-Host "A3 dev services requested."
Write-Host "  Backend:        http://$HostName`:$BackendPort"
Write-Host "  Frontend:       http://$HostName`:$FrontendPort/a3/coaching"
Write-Host "  Realtime proxy: http://$HostName`:$RealtimePort/health"
Write-Host "  Celery worker:  $CeleryWorkerName"
Write-Host ""
Write-Host "Check status:"
Write-Host "  powershell -ExecutionPolicy Bypass -File .\scripts\start-a3-dev.ps1 -Status"
Write-Host "Stop services started by this script:"
Write-Host "  powershell -ExecutionPolicy Bypass -File .\scripts\start-a3-dev.ps1 -Stop"

if (-not ($backendReady -and $frontendReady -and $realtimeReady -and $celeryReady)) {
  throw "One or more A3 dev services failed to become ready. Check the logs above."
}
