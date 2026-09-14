<#
.SYNOPSIS
    Task runner for the Employee API — the Windows equivalent of the Makefile.

.DESCRIPTION
    `make` is not installed on Windows by default, so this script mirrors the
    Makefile targets. Both call the same underlying commands, so it does not
    matter which you use.

.PARAMETER Task
    The task to run. Use `-Task help` (or no arguments) to list them.

.EXAMPLE
    .\scripts\task.ps1 dev
    .\scripts\task.ps1 build -ImageRepo myuser/employee-api
    .\scripts\task.ps1 deploy -Namespace employee-app -Tag abc1234
#>

[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [string]$Task = 'help',

    [string]$ImageRepo = $env:IMAGE_REPO,
    [string]$Tag       = $env:TAG,
    [string]$Release   = 'employee-api',
    [string]$Namespace = 'employee-app',
    [string]$Chart     = './charts/employee-api',
    [string]$Values    = '',
    [int]$ApiPort      = 3080
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# Always operate from the repository root, whatever directory this was run from.
$RepoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $RepoRoot

if (-not $ImageRepo) { $ImageRepo = 'YOUR_DOCKERHUB_USERNAME/employee-api' }

function Get-GitSha {
    param([switch]$Short)
    # Outside a git repo (or before the first commit) git writes to stderr and
    # exits non-zero. Swallow both so the task runner still works.
    try {
        $args = if ($Short) { @('rev-parse', '--short=7', 'HEAD') } else { @('rev-parse', 'HEAD') }
        $sha = & git @args 2>$null
        if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($sha)) {
            $global:LASTEXITCODE = 0
            return 'dev'
        }
        return $sha.Trim()
    } catch {
        $global:LASTEXITCODE = 0
        return 'dev'
    }
}

if (-not $Tag) { $Tag = Get-GitSha -Short }
$GitCommit = Get-GitSha
$BuildDate = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')

function Write-Step($message) { Write-Host "==> $message" -ForegroundColor Cyan }
function Write-Ok($message)   { Write-Host "    $message" -ForegroundColor Green }

function Invoke-Checked {
    param([string]$Exe, [string[]]$Arguments)
    Write-Verbose "$Exe $($Arguments -join ' ')"
    & $Exe @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$Exe exited with code $LASTEXITCODE"
    }
}

function Get-ValuesArgs {
    if ([string]::IsNullOrWhiteSpace($Values)) { return @() }
    # Accepts "-f path" or just "path".
    return ($Values -split '\s+' | Where-Object { $_ })
}

# ---------------------------------------------------------------------------

function Task-Help {
    Write-Host ''
    Write-Host 'Employee API - tasks' -ForegroundColor White
    Write-Host ''
    $tasks = [ordered]@{
        'install'          = 'Install Node dependencies'
        'test'             = 'Run unit tests (no database needed)'
        'test-integration' = 'Run integration tests against the Compose database'
        'audit'            = 'Fail on high or critical dependency vulnerabilities'
        'build'            = 'Build the image tagged with the commit hash'
        'push'             = 'Build and push to Docker Hub'
        'scan'             = 'Scan the image with Trivy (if installed)'
        'dev'              = 'Start the local stack (Postgres + migrations + API)'
        'dev-logs'         = 'Follow local application logs'
        'dev-down'         = 'Stop the local stack and delete its data'
        'verify'           = 'Exercise the local API end to end'
        'lint'             = 'Lint the chart against every values file'
        'template'         = 'Render manifests to stdout'
        'deploy'           = 'Install or upgrade the Helm release'
        'deploy-dev'       = 'Deploy with the development values'
        'status'           = 'Show the state of the release'
        'logs'             = 'Follow application logs in the cluster'
        'smoke'            = 'Run the Helm smoke tests'
        'port-forward'     = 'Forward the service to localhost:8080'
        'rollback'         = 'Roll back to the previous revision'
        'uninstall'        = 'Remove the release'
        'clean'            = 'Remove local build artefacts'
    }
    foreach ($key in $tasks.Keys) {
        Write-Host ('  {0,-18} {1}' -f $key, $tasks[$key])
    }
    Write-Host ''
    Write-Host 'Current settings:' -ForegroundColor White
    Write-Host "  ImageRepo = $ImageRepo"
    Write-Host "  Tag       = $Tag"
    Write-Host "  Namespace = $Namespace"
    Write-Host ''
}

function Task-Install { Write-Step 'Installing dependencies'; Push-Location app; try { Invoke-Checked npm @('ci') } finally { Pop-Location } }

function Task-Test { Write-Step 'Unit tests'; Push-Location app; try { Invoke-Checked npm @('run','test:unit') } finally { Pop-Location } }

function Task-TestIntegration {
    Write-Step 'Integration tests (requires: task dev)'
    Push-Location app
    try {
        $env:DB_HOST='127.0.0.1'; $env:DB_PORT='55432'; $env:DB_NAME='employees'
        $env:DB_USER='employee_app'; $env:DB_PASSWORD='local-dev-password'; $env:LOG_LEVEL='silent'
        Invoke-Checked npm @('run','test:integration')
    } finally { Pop-Location }
}

function Task-Audit { Push-Location app; try { Invoke-Checked npm @('audit','--audit-level=high') } finally { Pop-Location } }

function Task-Build {
    Write-Step "Building $ImageRepo`:$Tag"
    Invoke-Checked docker @(
        'build',
        '--build-arg', "GIT_COMMIT=$GitCommit",
        '--build-arg', "APP_VERSION=$Tag",
        '--build-arg', "BUILD_DATE=$BuildDate",
        '-t', "$ImageRepo`:$Tag",
        '-t', "$ImageRepo`:latest",
        './app'
    )
    Write-Ok "Built $ImageRepo`:$Tag"
}

function Task-Push {
    Task-Build
    Write-Step 'Pushing to Docker Hub'
    Invoke-Checked docker @('push', "$ImageRepo`:$Tag")
    Invoke-Checked docker @('push', "$ImageRepo`:latest")
}

function Task-Scan {
    Task-Build
    if (-not (Get-Command trivy -ErrorAction SilentlyContinue)) {
        Write-Warning 'trivy is not installed. Install from https://aquasecurity.github.io/trivy/'
        return
    }
    Invoke-Checked trivy @('image','--severity','HIGH,CRITICAL','--ignore-unfixed',"$ImageRepo`:$Tag")
}

function Task-Dev {
    Write-Step 'Starting the local stack'
    $env:API_PORT = "$ApiPort"
    Invoke-Checked docker @('compose','up','--build','-d')
    Write-Host ''
    Write-Ok "API      http://127.0.0.1:$ApiPort/api/v1/employees"
    Write-Ok "Health   http://127.0.0.1:$ApiPort/readyz"
    Write-Ok 'Metrics  http://127.0.0.1:9091/metrics'
}

function Task-DevLogs { & docker compose logs -f api }
function Task-DevDown { Write-Step 'Stopping the local stack'; Invoke-Checked docker @('compose','down','-v') }

function Task-Verify {
    Write-Step "Verifying the local API on port $ApiPort"
    $base = "http://127.0.0.1:$ApiPort"

    $ready = Invoke-RestMethod "$base/readyz" -TimeoutSec 10
    if ($ready.checks.database -ne 'ok') { throw "Database is not reachable: $($ready | ConvertTo-Json -Compress)" }
    Write-Ok 'readiness: database ok'

    $body = @{ name='Verify Script'; dob='1990-01-01'; designation='QA'; doj='2020-01-01' } | ConvertTo-Json
    $created = Invoke-RestMethod "$base/api/v1/employees" -Method Post -Body $body -ContentType 'application/json'
    Write-Ok "created id=$($created.data.id) $($created.data.name)"

    $fetched = Invoke-RestMethod "$base/api/v1/employees/$($created.data.id)"
    if ($fetched.data.designation -ne 'QA') { throw 'Read-back mismatch' }
    Write-Ok 'read back ok'

    Invoke-RestMethod "$base/api/v1/employees/$($created.data.id)" -Method Delete | Out-Null
    Write-Ok 'deleted'
    Write-Host ''
    Write-Host 'All checks passed.' -ForegroundColor Green
}

function Task-Lint {
    Write-Step 'Linting the chart'
    Invoke-Checked helm @('lint', $Chart)
    Invoke-Checked helm @('lint', $Chart, '-f', "$Chart/values-dev.yaml")
    Invoke-Checked helm @('lint', $Chart, '-f', "$Chart/values-prod.yaml")
}

function Task-Template {
    & helm template $Release $Chart --namespace $Namespace `
        --set "image.repository=$ImageRepo" --set "image.tag=$Tag" @(Get-ValuesArgs)
}

function Task-Deploy {
    Write-Step "Deploying $Release to namespace $Namespace (tag $Tag)"
    $args = @(
        'upgrade','--install',$Release,$Chart,
        '--namespace',$Namespace,
        '--set',"image.repository=$ImageRepo",
        '--set',"image.tag=$Tag"
    ) + (Get-ValuesArgs) + @('--wait','--timeout','10m')
    Invoke-Checked helm $args
    Task-Status
}

function Task-DeployDev {
    $script:Namespace = 'employee-dev'
    $script:Values = "-f $Chart/values-dev.yaml"
    Task-Deploy
}

function Task-Status {
    Write-Step "Release status ($Namespace)"
    & kubectl get pods -n $Namespace -o wide
    & kubectl get svc -n $Namespace
    & kubectl get gateway,virtualservice -n $Namespace 2>$null
}

function Task-Logs { & kubectl logs -n $Namespace -l app.kubernetes.io/component=api -c api -f --tail=100 }
function Task-Smoke { Invoke-Checked helm @('test',$Release,'-n',$Namespace,'--logs') }
function Task-PortForward { & kubectl port-forward -n $Namespace "svc/$Release" 8080:80 }
function Task-Rollback { Invoke-Checked helm @('rollback',$Release,'-n',$Namespace,'--wait') }
function Task-Uninstall { Invoke-Checked helm @('uninstall',$Release,'-n',$Namespace) }

function Task-Clean {
    Write-Step 'Cleaning'
    Remove-Item -Recurse -Force .render, app/coverage -ErrorAction SilentlyContinue
    & docker compose down -v 2>$null
}

# ---------------------------------------------------------------------------

switch ($Task.ToLower()) {
    'help'             { Task-Help }
    'install'          { Task-Install }
    'test'             { Task-Test }
    'test-integration' { Task-TestIntegration }
    'audit'            { Task-Audit }
    'build'            { Task-Build }
    'push'             { Task-Push }
    'scan'             { Task-Scan }
    'dev'              { Task-Dev }
    'dev-logs'         { Task-DevLogs }
    'dev-down'         { Task-DevDown }
    'verify'           { Task-Verify }
    'lint'             { Task-Lint }
    'template'         { Task-Template }
    'deploy'           { Task-Deploy }
    'deploy-dev'       { Task-DeployDev }
    'status'           { Task-Status }
    'logs'             { Task-Logs }
    'smoke'            { Task-Smoke }
    'port-forward'     { Task-PortForward }
    'rollback'         { Task-Rollback }
    'uninstall'        { Task-Uninstall }
    'clean'            { Task-Clean }
    default {
        Write-Error "Unknown task '$Task'. Run with -Task help to list them."
        exit 1
    }
}
