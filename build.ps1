# Builds the Chrome Web Store / Opera / Edge upload package.
#
# IMPORTANT: this deliberately does NOT use Compress-Archive. On Windows
# PowerShell 5.1 that cmdlet writes ZIP entries with backslash separators
# (icons\icon-16.png), which violates the ZIP spec. Chromium's own
# "Load unpacked" tolerates it, but the Opera / Chrome / Edge web-store
# validators cannot resolve the manifest's icons/ paths inside such a zip
# and reject the package citing missing images. We write entries with
# forward slashes via System.IO.Compression instead.

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$version = (Get-Content (Join-Path $root 'manifest.json') -Raw | ConvertFrom-Json).version
$zipPath = Join-Path $root "youtube-blocker-chromium-$version.zip"

# Only the extension itself ships — never store-assets, README, .git, build.ps1.
$include = @('manifest.json', 'LICENSE', 'icons', 'src')

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

if (Test-Path $zipPath) { Remove-Item $zipPath -Force }

$files = @()
foreach ($item in $include) {
    $full = Join-Path $root $item
    if (Test-Path $full -PathType Container) {
        $files += Get-ChildItem $full -Recurse -File
    } elseif (Test-Path $full) {
        $files += Get-Item $full
    }
}

$zip = [System.IO.Compression.ZipFile]::Open($zipPath, [System.IO.Compression.ZipArchiveMode]::Create)
try {
    foreach ($f in $files) {
        # Relative path from repo root, forced to forward slashes.
        $rel = $f.FullName.Substring($root.Length).TrimStart('\', '/').Replace('\', '/')
        [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
            $zip, $f.FullName, $rel,
            [System.IO.Compression.CompressionLevel]::Optimal) | Out-Null
    }
} finally {
    $zip.Dispose()
}

Write-Host "Built $zipPath"
Write-Host "Entries:"
$verify = [System.IO.Compression.ZipFile]::OpenRead($zipPath)
try { $verify.Entries | ForEach-Object { "  $($_.FullName)" } }
finally { $verify.Dispose() }
