# Requires Windows PowerShell 5.1 or PowerShell 7 on a clean Windows x64 account.
# Uses existing pinned Node/npm. Does not change execution policy or global tools.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$script:PhaseExitCode = 10
$resultCode = 0
$repoRoot = Split-Path -Parent $PSScriptRoot
$locationChanged = $false

function Invoke-NpmStep {
    param([string]$Label, [string[]]$Arguments, [int]$FailureCode)
    $script:PhaseExitCode = $FailureCode
    Write-Host "`n[$Label] node npm-cli.js $($Arguments -join ' ')"
    & $script:NodeExe $script:NpmCli @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$Label failed with native exit code $LASTEXITCODE. No later build stage was run."
    }
}

try {
    if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT -or -not [Environment]::Is64BitOperatingSystem) {
        throw 'WINDOWS_BUILD_REQUIRED: Use native Windows x64. Linux cannot build or certify this installer.'
    }
    Push-Location -LiteralPath $repoRoot
    $locationChanged = $true
    $script:PhaseExitCode = 11
    $script:NodeExe = (Get-Command node.exe -CommandType Application -ErrorAction Stop).Source
    $npmCommand = Get-Command npm.cmd -CommandType Application -ErrorAction Stop
    $script:NpmCli = Join-Path (Split-Path -Parent $npmCommand.Source) 'node_modules\npm\bin\npm-cli.js'
    if (-not (Test-Path -LiteralPath $script:NpmCli -PathType Leaf)) {
        throw 'NPM_CLI_MISSING: The existing npm.cmd must have its standard node_modules\npm\bin\npm-cli.js. No global installation is performed.'
    }
    $script:PhaseExitCode = 12
    $nodeIdentity = (& $script:NodeExe -p '[process.versions.node,process.platform,process.arch].join(String.fromCharCode(124))' | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or $nodeIdentity -ne '24.19.0|win32|x64') {
        throw "PINNED_NODE_REQUIRED: Expected Node 24.19.0 on win32 x64; got '$nodeIdentity'. Select the approved runtime before retrying."
    }
    $script:PhaseExitCode = 13
    $npmVersion = (& $script:NodeExe $script:NpmCli --version | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or $npmVersion -ne '11.9.0') {
        throw "PINNED_NPM_REQUIRED: Expected npm 11.9.0; got '$npmVersion'. No npm version is installed or changed by this script."
    }
    $package = Get-Content -LiteralPath (Join-Path $repoRoot 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($package.engines.node -ne '24.19.0' -or $package.engines.npm -ne '11.9.0') {
        throw 'SOURCE_BASELINE_CHANGED: This build entry requires the reviewed Node 24.19.0/npm 11.9.0 baseline.'
    }
    $script:PhaseExitCode = 14
    if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
        throw 'LOCALAPPDATA_REQUIRED: Use a normal clean Windows test account.'
    }
    $defaultData = Join-Path $env:LOCALAPPDATA 'MCP-FlowHub'
    if (Test-Path -LiteralPath $defaultData) {
        throw "CLEAN_ACCOUNT_REQUIRED: Existing data at '$defaultData' will not be touched. Run installation tests in a clean disposable Windows account."
    }

    Write-Host 'MCP FlowHub native Windows x64 build. Network access is used for locked npm dependencies and the pinned official NSIS ZIP.'
    Invoke-NpmStep 'Install locked dependencies' @('ci') 20
    Invoke-NpmStep 'Static checks' @('run', 'check') 21
    Invoke-NpmStep 'Application tests' @('test') 22
    Invoke-NpmStep 'Native Windows offline ZIP' @('run', 'package:windows') 23
    Invoke-NpmStep 'Offline ZIP smoke' @('run', 'test:package') 24
    Invoke-NpmStep 'Release integrity' @('run', 'verify:release') 25

    $script:PhaseExitCode = 30
    $pinPath = Join-Path $repoRoot 'installer\windows\toolchain.json'
    $pin = Get-Content -LiteralPath $pinPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($pin.name -ne 'NSIS' -or $pin.version -ne '3.11' -or $pin.archiveName -ne 'nsis-3.11.zip' -or
        $pin.url -ne 'https://prdownloads.sourceforge.net/nsis/nsis-3.11.zip' -or
        $pin.sha256 -ne 'c7d27f780ddb6cffb4730138cd1591e841f4b7edb155856901cdf5f214394fa1') {
        throw 'NSIS_PIN_CHANGED: The reviewed NSIS 3.11 URL and SHA-256 must match this build entry.'
    }
    $toolchainDir = Join-Path $repoRoot 'artifacts\toolchain'
    New-Item -ItemType Directory -Path $toolchainDir -Force | Out-Null
    $nsisArchive = Join-Path $toolchainDir $pin.archiveName
    $downloadDiagnostics = Join-Path $repoRoot 'artifacts\nsis-download-diagnostics.json'
    Write-Host "`n[NSIS toolchain] Fetching or revalidating the pinned official archive"
    & $script:NodeExe --use-env-proxy (Join-Path $repoRoot 'scripts\fetch-nsis.mjs') --output $nsisArchive --diagnostics $downloadDiagnostics --pin $pinPath
    if ($LASTEXITCODE -ne 0) {
        throw "NSIS_FETCH_FAILED: The pinned archive was not verified. See '$downloadDiagnostics'. No installer compilation was started."
    }
    $actualHash = (Get-FileHash -LiteralPath $nsisArchive -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actualHash -ne $pin.sha256) {
        throw "NSIS_SHA256_MISMATCH: Expected $($pin.sha256); got $actualHash. The archive was retained for diagnosis and will not be executed."
    }
    Invoke-NpmStep 'NSIS installer' @('run', 'installer:windows', '--', '--nsis-archive', $nsisArchive) 31
    Invoke-NpmStep 'Native install/run/reinstall/uninstall smoke' @('run', 'test:installer:windows') 32

    $script:PhaseExitCode = 33
    $latest = Get-Content -LiteralPath (Join-Path $repoRoot 'artifacts\latest-installer.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    $latestPackage = Get-Content -LiteralPath (Join-Path $repoRoot 'artifacts\latest-package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    Write-Host "`nBuild and automated checks completed. This is an unsigned release candidate; enterprise acceptance remains separate."
    Write-Host "Installer: $($latest.installer)"
    Write-Host "SHA-256:  $($latest.installerSha256)"
    Write-Host "ZIP:      $($latestPackage.archive)"
    Write-Host "Evidence: $(Join-Path $repoRoot 'artifacts\windows-installer-smoke.json')"
} catch {
    $resultCode = $script:PhaseExitCode
    [Console]::Error.WriteLine("BUILD_FAILED (exit $resultCode): $($_.Exception.Message)")
    [Console]::Error.WriteLine("Partial outputs, if any: $(Join-Path $repoRoot 'artifacts'). A partial installer is not a passed build.")
} finally {
    if ($locationChanged) { Pop-Location }
}
exit $resultCode
