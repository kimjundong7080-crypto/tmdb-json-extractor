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
if ($ExtensionId -notmatch '^[a-p]{32}$') {
    throw "Invalid extension ID '$ExtensionId'. Copy the 32-character ID from chrome://extensions (it contains only a-p)."
}

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $here
$enrichScript = Join-Path $root 'python\enrich.py'
if (-not (Test-Path -LiteralPath $enrichScript)) {
    throw "python\enrich.py not found: $enrichScript"
}

New-Item -ItemType Directory -Force -Path $InputDir | Out-Null
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

function Test-PythonExecutable {
    param([string]$Exe)
    try {
        & $Exe --version *> $null
        return ($LASTEXITCODE -eq 0)
    } catch {
        return $false
    }
}

if (-not $Python) {
    # Windows ships a Store alias stub named python.exe that must be skipped:
    # it fails with a "Python was not found" message, so each candidate is executed.
    foreach ($name in @('pythonw.exe', 'python.exe', 'py.exe')) {
        $found = Get-Command $name -ErrorAction SilentlyContinue
        if ($found -and (Test-PythonExecutable $found.Source)) { $Python = $found.Source; break }
    }
    if (-not $Python) { throw "Python not found. Pass -Python <path>." }
} elseif (-not (Test-PythonExecutable $Python)) {
    throw "Python at '$Python' does not run. Pass -Python <path>."
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

$browserKeys = @(
    ('HKCU:\Software\Google\Chrome\NativeMessagingHosts\' + $hostName),
    ('HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\' + $hostName)
)
foreach ($browserKey in $browserKeys) {
    New-Item -Path $browserKey -Force | Out-Null
    New-ItemProperty -Path $browserKey -Name '(Default)' -Value $manifestPath -PropertyType String -Force | Out-Null
    $registered = (Get-Item -Path $browserKey).GetValue('')
    if ($registered -ne $manifestPath) {
        throw "Failed to register native messaging host at $browserKey (got '$registered')."
    }
    Write-Host "  Reg    : $browserKey"
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
