[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Executable,
  [string]$OutputDirectory,
  [ValidateRange(5, 120)][int]$TimeoutSeconds = 45
)

$ErrorActionPreference = 'Stop'
$Executable = (Resolve-Path -LiteralPath $Executable).Path
if ([string]::IsNullOrWhiteSpace($OutputDirectory)) {
  $repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
  $OutputDirectory = Join-Path $repoRoot "artifacts\desktop\startup-$([guid]::NewGuid().ToString('N'))"
}
if (Test-Path -LiteralPath $OutputDirectory) {
  throw 'Startup evidence directory already exists; choose a new directory.'
}
$null = New-Item -ItemType Directory -Path $OutputDirectory
$OutputDirectory = (Resolve-Path -LiteralPath $OutputDirectory).Path

$start = New-Object System.Diagnostics.ProcessStartInfo
$start.FileName = $Executable
$start.WorkingDirectory = Split-Path -Parent $Executable
$start.Arguments = '--startup-smoke-test'
$start.UseShellExecute = $false
$start.RedirectStandardOutput = $true
$start.RedirectStandardError = $true
# Only this child sees the fresh profile; no user profile or machine setting is changed.
$start.EnvironmentVariables['WEBVIEW2_USER_DATA_FOLDER'] = Join-Path $OutputDirectory 'webview-profile'
$process = New-Object System.Diagnostics.Process
$process.StartInfo = $start
$utf8 = New-Object System.Text.UTF8Encoding($false)
$failure = $null
$started = $false
try {
  $started = $process.Start()
  if (-not $started) { throw 'Could not start the packaged desktop executable.' }
  $stderr = $process.StandardError.ReadToEndAsync()
  $ready = $process.StandardOutput.ReadLineAsync()
  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  while (-not $ready.IsCompleted -and -not $process.HasExited -and [DateTime]::UtcNow -lt $deadline) {
    Start-Sleep -Milliseconds 100
  }
  if ($process.HasExited) { throw "Desktop exited during startup (exit $($process.ExitCode))." }
  if (-not $ready.IsCompleted -or $ready.Result -cne 'SUPERDOC_DESKTOP_READY') {
    throw 'The native window did not receive the mounted frontend readiness acknowledgement.'
  }
  # Receiving Ready is insufficient if the application crashes immediately afterwards.
  if ($process.WaitForExit(5000)) { throw "Desktop exited after frontend readiness (exit $($process.ExitCode))." }
  $process.Refresh()
  if ($process.MainWindowHandle -eq [IntPtr]::Zero -or -not $process.Responding) {
    throw 'The ready desktop has no responsive main window.'
  }
  [System.IO.File]::WriteAllText((Join-Path $OutputDirectory 'ready.txt'), "SUPERDOC_DESKTOP_READY`n", $utf8)
  [System.IO.File]::WriteAllText((Join-Path $OutputDirectory 'receipt.json'), (@{
    executable = $Executable
    sha256 = (Get-FileHash -LiteralPath $Executable -Algorithm SHA256).Hash.ToLowerInvariant()
    pid = $process.Id
    windowTitle = $process.MainWindowTitle
    frontendMounted = $true
    aliveAfterReadySeconds = 5
    checkedAt = [DateTime]::UtcNow.ToString('o')
  } | ConvertTo-Json), $utf8)
} catch {
  $failure = $_
} finally {
  if ($started -and -not $process.HasExited) {
    $null = $process.CloseMainWindow()
    if (-not $process.WaitForExit(5000)) {
      # Terminate only the process this test created, never other WebView2 applications.
      $process.Kill()
      $process.WaitForExit()
      if ($null -eq $failure) { $failure = 'Desktop did not close normally after the startup test.' }
    }
  }
  if ($stderr) {
    [System.IO.File]::WriteAllText((Join-Path $OutputDirectory 'stderr.log'), $stderr.GetAwaiter().GetResult(), $utf8)
  }
  $process.Dispose()
}
if ($null -ne $failure) {
  $diagnostic = Get-Content -Raw -LiteralPath (Join-Path $OutputDirectory 'stderr.log') -ErrorAction SilentlyContinue
  throw "$failure`n$diagnostic`nStartup evidence: $OutputDirectory"
}
Write-Output "Verified packaged native window and mounted frontend. Evidence: $OutputDirectory"
