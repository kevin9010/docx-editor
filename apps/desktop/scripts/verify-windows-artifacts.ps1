[CmdletBinding()]
param(
  [string]$OutputDirectory,
  [string]$BundleDirectory,
  [string]$ExpectedCommit
)

$ErrorActionPreference = 'Stop'
$desktopRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$repoRoot = (Resolve-Path (Join-Path $desktopRoot '..\..')).Path
$package = Get-Content -Raw (Join-Path $desktopRoot 'package.json') | ConvertFrom-Json
if ([string]::IsNullOrWhiteSpace($OutputDirectory)) {
  $OutputDirectory = Join-Path $repoRoot 'artifacts\desktop'
}
if ([string]::IsNullOrWhiteSpace($BundleDirectory)) {
  $BundleDirectory = Join-Path $desktopRoot 'src-tauri\target\release\bundle'
}
if ([string]::IsNullOrWhiteSpace($ExpectedCommit)) {
  $ExpectedCommit = & git -C $repoRoot rev-parse HEAD
  if ($LASTEXITCODE -ne 0) {
    throw 'Could not determine the build commit.'
  }
  $ExpectedCommit = $ExpectedCommit.Trim()
}

# upload-artifact's if-no-files-found only fails when ALL patterns are empty.
# Require each installer format before uploading the finished deliverables.
foreach ($pattern in @('msi\*.msi', 'nsis\*-setup.exe')) {
  $installers = @(Get-ChildItem -Path (Join-Path $BundleDirectory $pattern) -File)
  if ($installers.Count -eq 0 -or @($installers | Where-Object { $_.Length -eq 0 }).Count -gt 0) {
    throw "Missing or empty Windows installer: $pattern"
  }
}

$zipName = "SuperDoc-Desktop-$($package.version)-win-x64-portable.zip"
$zipPath = Join-Path $OutputDirectory $zipName
$checksum = (Get-Content -Raw -LiteralPath "$zipPath.sha256").Trim()
if ($checksum -notmatch '^([a-fA-F0-9]{64}) \*(.+)$' -or $Matches[2] -cne $zipName) {
  throw 'The portable checksum file must name the generated ZIP.'
}
$expectedHash = $Matches[1]
$sha256 = [System.Security.Cryptography.SHA256]::Create()
try {
  $stream = [System.IO.File]::OpenRead($zipPath)
  try {
    $actualHash = ([System.BitConverter]::ToString($sha256.ComputeHash($stream)) -replace '-', '').ToLowerInvariant()
  } finally {
    $stream.Dispose()
  }
} finally {
  $sha256.Dispose()
}
if ($actualHash -ne $expectedHash) {
  throw 'The portable ZIP does not match its SHA-256 checksum.'
}

Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [System.IO.Compression.ZipFile]::OpenRead($zipPath)
try {
  foreach ($name in @('SuperDoc-Desktop.exe', 'portable-manifest.json', 'PORTABLE-README.txt', 'DESKTOP-README.md')) {
    $entry = $archive.GetEntry($name)
    if ($null -eq $entry -or $entry.Length -eq 0) {
      throw "Missing or empty file in portable ZIP: $name"
    }
  }

  $manifestStream = $archive.GetEntry('portable-manifest.json').Open()
  $manifestBytes = New-Object System.IO.MemoryStream
  try {
    $manifestStream.CopyTo($manifestBytes)
    $bytes = $manifestBytes.ToArray()
  } finally {
    $manifestStream.Dispose()
    $manifestBytes.Dispose()
  }
  if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xef -and $bytes[1] -eq 0xbb -and $bytes[2] -eq 0xbf) {
    throw 'The portable JSON manifest must be UTF-8 without a BOM.'
  }
  $utf8 = New-Object System.Text.UTF8Encoding -ArgumentList $false, $true
  $manifest = $utf8.GetString($bytes) | ConvertFrom-Json
  if ($manifest.version -ne $package.version -or $manifest.platform -ne 'windows' -or
      $manifest.architecture -ne 'x86_64' -or $manifest.executable -ne 'SuperDoc-Desktop.exe' -or
      $manifest.commit -ne $ExpectedCommit) {
    throw 'The portable manifest does not match this Windows x64 build, version, or commit.'
  }

  $executableStream = $archive.GetEntry('SuperDoc-Desktop.exe').Open()
  $executableBytes = New-Object System.IO.MemoryStream
  try {
    $executableStream.CopyTo($executableBytes)
    $executableBytes.Position = 0
    $reader = New-Object System.IO.BinaryReader -ArgumentList $executableBytes
    try {
      if ($reader.ReadUInt16() -ne 0x5a4d -or $executableBytes.Length -lt 64) {
        throw 'The portable executable has no valid DOS header.'
      }
      $executableBytes.Position = 0x3c
      $peOffset = $reader.ReadUInt32()
      if ($peOffset -lt 64 -or $peOffset -gt $executableBytes.Length - 6) {
        throw 'The portable executable has an invalid PE header offset.'
      }
      $executableBytes.Position = $peOffset
      if ($reader.ReadUInt32() -ne 0x00004550 -or $reader.ReadUInt16() -ne 0x8664) {
        throw 'The portable executable is not a Windows x64 PE binary.'
      }
    } finally {
      $reader.Dispose()
    }
  } finally {
    $executableStream.Dispose()
    $executableBytes.Dispose()
  }
} finally {
  $archive.Dispose()
}

Write-Output "Verified MSI, NSIS, portable manifest, and Windows x64 executable for $ExpectedCommit."
Write-Output "SHA-256: $actualHash"
