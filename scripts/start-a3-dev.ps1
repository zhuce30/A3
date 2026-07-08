param(
  [switch]$Stop,
  [switch]$Status,
  [switch]$Help,
  [int]$BackendPort = 8000,
  [int]$FrontendPort = 3002,
  [int]$RealtimePort = 3003,
  [string]$HostName = "127.0.0.1",
  [switch]$Visible
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

function Show-Help {
  Write-Output @"
start-a3-dev.ps1 - start A3 local dev services

Usage:
  powershell -ExecutionPolicy Bypass -File .\scripts\start-a3-dev.ps1
  powershell -ExecutionPolicy Bypass -File .\scripts\start-a3-dev.ps1 -Status
  powershell -ExecutionPolicy Bypass -File .\scripts\start-a3-dev.ps1 -Stop

Defaults:
  Backend:        http://127.0.0.1:8000
  Frontend:       http://127.0.0.1:3002
  Realtime proxy: http://127.0.0.1:3003/health

Logs:
  backend\tmp\a3-backend.log
  backend\tmp\a3-frontend.log
  backend\tmp\a3-realtime-proxy.log
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

function Test-Url {
  param([string]$Url)
  try {
    $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 3
    return [int]$response.StatusCode
  } catch {
    return 0
  }
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
    return
  }
  foreach ($record in $records) {
    $pidValue = [int]$record.pid
    $name = [string]$record.name
    if ($record.reused) {
      Write-Host "Skipping reused $name (PID $pidValue); it was already running before this script."
      continue
    }
    $process = Get-Process -Id $pidValue -ErrorAction SilentlyContinue
    if ($process) {
      Write-Host "Stopping $name (PID $pidValue)"
      Stop-Process -Id $pidValue -Force -ErrorAction SilentlyContinue
    } else {
      Write-Host "$name already stopped (PID $pidValue)"
    }
  }
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
    Write-Host "$Name already has a listener on port $Port (PID $owner); leaving it running."
    return @{
      name = $Name
      pid = $owner
      port = $Port
      log = $LogPath
      reused = $true
    }
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

function Show-Status {
  Ensure-Workspace
  $backendStatus = Test-Url "http://$HostName`:$BackendPort/api/auth/me/"
  $frontendStatus = Test-Url "http://$HostName`:$FrontendPort/a3/coaching"
  $realtimeStatus = Test-Url "http://$HostName`:$RealtimePort/health"

  Write-Host "A3 dev status"
  Write-Host "  Backend        http://$HostName`:$BackendPort  status=$backendStatus  portOwner=$(Get-PortOwner -Port $BackendPort)"
  Write-Host "  Frontend       http://$HostName`:$FrontendPort  status=$frontendStatus  portOwner=$(Get-PortOwner -Port $FrontendPort)"
  Write-Host "  Realtime proxy http://$HostName`:$RealtimePort/health  status=$realtimeStatus  portOwner=$(Get-PortOwner -Port $RealtimePort)"
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
if (-not (Test-Path -LiteralPath $PythonExe)) {
  throw "Missing backend virtualenv python: $PythonExe"
}

$records = @()
$records += Start-ServiceProcess `
  -Name "a3-backend" `
  -WorkingDirectory $Root `
  -Command "& '$PythonExe' 'backend\manage.py' runserver $HostName`:$BackendPort" `
  -LogPath $BackendLog `
  -Port $BackendPort

$records += Start-ServiceProcess `
  -Name "a3-frontend" `
  -WorkingDirectory $FrontendDir `
  -Command "pnpm.cmd dev -- -p $FrontendPort -H $HostName" `
  -LogPath $FrontendLog `
  -Port $FrontendPort

$records += Start-ServiceProcess `
  -Name "a3-realtime-proxy" `
  -WorkingDirectory $FrontendDir `
  -Command "`$env:A3_REALTIME_WS_PROXY_HOST='$HostName'; `$env:A3_REALTIME_WS_PROXY_PORT='$RealtimePort'; pnpm.cmd realtime:dashscope-proxy" `
  -LogPath $RealtimeLog `
  -Port $RealtimePort

Save-ProcessRecords -Records $records

Write-Host ""
Write-Host "A3 dev services requested."
Write-Host "  Backend:        http://$HostName`:$BackendPort"
Write-Host "  Frontend:       http://$HostName`:$FrontendPort/a3/coaching"
Write-Host "  Realtime proxy: http://$HostName`:$RealtimePort/health"
Write-Host ""
Write-Host "Check status:"
Write-Host "  powershell -ExecutionPolicy Bypass -File .\scripts\start-a3-dev.ps1 -Status"
Write-Host "Stop services started by this script:"
Write-Host "  powershell -ExecutionPolicy Bypass -File .\scripts\start-a3-dev.ps1 -Stop"
