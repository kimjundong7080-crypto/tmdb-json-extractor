param(
    [Parameter(Mandatory = $true)]
    [string]$ExtensionId,
    [string]$InputDir = (Join-Path $env:USERPROFILE 'Downloads\tmdb'),
    [string]$OutDir = '',
    [string]$Python = '',
    [double]$Interval = 30
)

$ErrorActionPreference = 'Stop'

if (-not $OutDir) { $OutDir = Join-Path $InputDir 'enriched' }
$ExtensionId = ($ExtensionId.Trim() -replace '^chrome-extension://', '').TrimEnd('/')

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $here
$enrichScript = Join-Path $root 'python\enrich.py'
if (-not (Test-Path -LiteralPath $enrichScript)) {
    throw "python\enrich.py not found: $enrichScript"
}

New-Item -ItemType Directory -Force -Path $InputDir | Out-Null
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

if (-not $Python) {
    $found = Get-Command pythonw.exe -ErrorAction SilentlyContinue
    if ($found) {
        $Python = $found.Source
    } else {
        $found = Get-Command python.exe -ErrorAction SilentlyContinue
        if ($found) {
            $Python = $found.Source
        } else {
            $found = Get-Command py.exe -ErrorAction SilentlyContinue
            if ($found) { $Python = $found.Source } else { throw "Python not found. Pass -Python <path>." }
        }
    }
}

$cscCandidates = @(
    (Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'),
    (Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe')
)
$csc = $cscCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $csc) { throw "C# compiler (csc.exe) not found." }

$exePath = Join-Path $here 'tmdb-enricher-host.exe'
& $csc /nologo /target:exe "/out:$exePath" (Join-Path $here 'launcher.cs')
if (-not (Test-Path -LiteralPath $exePath)) { throw "Failed to build $exePath" }

$ini = @(
    "python=$Python",
    "script=$enrichScript",
    "input=$InputDir",
    "out=$OutDir",
    "interval=$Interval"
) -join "`r`n"
[System.IO.File]::WriteAllText((Join-Path $here 'launcher.ini'), $ini, (New-Object System.Text.UTF8Encoding($false)))

$hostName = 'com.tmdb_json_extractor.enricher'
$manifestPath = Join-Path $here ($hostName + '.json')
$manifest = [ordered]@{
    name = $hostName
    description = 'TMDB JSON Extractor - Python enrichment watcher'
    path = $exePath
    type = 'stdio'
    allowed_origins = @("chrome-extension://$ExtensionId/")
}
[System.IO.File]::WriteAllText(
    $manifestPath,
    ($manifest | ConvertTo-Json -Depth 4),
    (New-Object System.Text.UTF8Encoding($false))
)

foreach ($browserKey in @(
    'HKCU:\Software\Google\Chrome\NativeMessagingHosts\' + $hostName,
    'HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\' + $hostName
)) {
    New-Item -Path $browserKey -Force | Out-Null
    Set-ItemProperty -Path $browserKey -Name '(default)' -Value $manifestPath
}

Write-Host ""
Write-Host "Native messaging host installed."
Write-Host "  Python : $Python"
Write-Host "  Script : $enrichScript"
Write-Host "  Input  : $InputDir"
Write-Host "  Output : $OutDir"
Write-Host "  Host   : $exePath"
Write-Host ""
Write-Host "Next steps:"
Write-Host "  1. Reload the unpacked extension at chrome://extensions"
Write-Host "  2. Restart Chrome (or the Python watcher starts on the next browser start)"
Write-Host "  3. New JSON files in InputDir are enriched into OutputDir every $Interval seconds"
Write-Host "  Optional: set OMDB_API_KEY in your user environment to enable OMDb."
