[CmdletBinding()]
param(
  [string]$OutputDirectory
)

$ErrorActionPreference = 'Stop'

if ($env:OS -ne 'Windows_NT') {
  throw 'The Windows portable package can only be built on Windows.'
}

$desktopRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$repoRoot = (Resolve-Path (Join-Path $desktopRoot '..\..')).Path
$packageJsonPath = Join-Path $desktopRoot 'package.json'
$tauriConfigPath = Join-Path $desktopRoot 'src-tauri\tauri.conf.json'
$cargoTomlPath = Join-Path $desktopRoot 'src-tauri\Cargo.toml'

$package = Get-Content -Raw $packageJsonPath | ConvertFrom-Json
$tauriConfig = Get-Content -Raw $tauriConfigPath | ConvertFrom-Json
$cargoToml = Get-Content -Raw $cargoTomlPath
$cargoVersionMatch = [regex]::Match($cargoToml, '(?m)^version\s*=\s*"([^"]+)"')

if (-not $cargoVersionMatch.Success) {
  throw 'Could not read the desktop Cargo package version.'
}

$versions = @(
  [string]$package.version
  [string]$tauriConfig.version
  [string]$cargoVersionMatch.Groups[1].Value
)
if (($versions | Select-Object -Unique).Count -ne 1) {
  throw "Desktop versions do not match: $($versions -join ', ')"
}

$version = $versions[0]
$artifactName = "SuperDoc-Desktop-$version-win-x64-portable"
if ([string]::IsNullOrWhiteSpace($OutputDirectory)) {
  $OutputDirectory = Join-Path $repoRoot 'artifacts\desktop'
}
$outputRoot = [IO.Path]::GetFullPath($OutputDirectory)
$stagingPath = Join-Path $outputRoot $artifactName
$zipPath = Join-Path $outputRoot "$artifactName.zip"
$checksumPath = Join-Path $outputRoot "$artifactName.zip.sha256"

foreach ($path in @($stagingPath, $zipPath, $checksumPath)) {
  if (Test-Path $path) {
    throw "Refusing to overwrite existing portable output: $path"
  }
}

New-Item -ItemType Directory -Force -Path $outputRoot | Out-Null

Push-Location $desktopRoot
try {
  & pnpm build:web
  if ($LASTEXITCODE -ne 0) {
    throw "The desktop web build failed with exit code $LASTEXITCODE."
  }

  & pnpm exec tauri build --no-bundle
  if ($LASTEXITCODE -ne 0) {
    throw "The Tauri executable build failed with exit code $LASTEXITCODE."
  }
}
finally {
  Pop-Location
}

$executablePath = Join-Path $desktopRoot 'src-tauri\target\release\superdoc-desktop.exe'
if (-not (Test-Path $executablePath -PathType Leaf)) {
  throw "The Tauri executable was not found at $executablePath"
}

New-Item -ItemType Directory -Path $stagingPath | Out-Null
Copy-Item $executablePath (Join-Path $stagingPath 'SuperDoc-Desktop.exe')
Copy-Item (Join-Path $desktopRoot 'README.md') (Join-Path $stagingPath 'DESKTOP-README.md')

$commit = ''
try {
  $commit = (& git -C $repoRoot rev-parse HEAD).Trim()
}
catch {
  $commit = 'unknown'
}

$manifest = [ordered]@{
  product = [string]$tauriConfig.productName
  version = $version
  architecture = 'x86_64'
  platform = 'windows'
  commit = $commit
  executable = 'SuperDoc-Desktop.exe'
  webview2 = [ordered]@{
    runtime = 'Evergreen WebView2 Runtime'
    required = $true
    installerMode = 'not included in portable ZIP'
  }
  signed = $false
}
$manifest | ConvertTo-Json -Depth 5 | Set-Content (Join-Path $stagingPath 'portable-manifest.json') -Encoding utf8

@"
SuperDoc Desktop $version - Windows portable build

This ZIP contains the Tauri executable only. It is not a signed Windows release.

Prerequisite:
- Microsoft Evergreen WebView2 Runtime must already be installed.
- The portable executable does not download or install WebView2.
- Use the regular installer when WebView2 installation is required.

The application reads and writes DOCX files selected by the user. Keep the
executable in a writable directory if future crash-recovery files are enabled.
See DESKTOP-README.md for the current POC scope and Agent privacy behavior.
"@ | Set-Content (Join-Path $stagingPath 'PORTABLE-README.txt') -Encoding utf8

Compress-Archive -Path (Join-Path $stagingPath '*') -DestinationPath $zipPath -CompressionLevel Optimal
$hash = (Get-FileHash $zipPath -Algorithm SHA256).Hash.ToLowerInvariant()
"$hash *$([IO.Path]::GetFileName($zipPath))" | Set-Content $checksumPath -Encoding ascii

Write-Output "Portable package: $zipPath"
Write-Output "SHA-256: $hash"
