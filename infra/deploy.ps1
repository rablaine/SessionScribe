# Manual release: builds the image in Azure Container Registry from your working tree and rolls the
# single container app replica onto it. Nothing here runs automatically; run it when you want a deploy.
#   .\infra\deploy.ps1            build + deploy
#   .\infra\deploy.ps1 -SkipBuild -Tag <existing-tag>   redeploy/roll back to an earlier image
param(
    [string]$ConfigPath = (Join-Path $PSScriptRoot "deploy.local.json"),
    [string]$Tag,
    [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"
$cfg = Get-Content -Raw -LiteralPath $ConfigPath | ConvertFrom-Json
$project = Split-Path $PSScriptRoot -Parent

function AzRun {
    $output = & az @args --only-show-errors
    if ($LASTEXITCODE -ne 0) { throw "az $($args[0..2] -join ' ') failed." }
    return $output
}
function AzExists { & az @args --only-show-errors -o none 2>$null; return $LASTEXITCODE -eq 0 }

$sub = $cfg.subscriptionId
$rg = $cfg.resourceGroup
$s = $cfg.nameSuffix
$appName = $cfg.app.name
$registry = "acrsessionscribe$s"
$envName = "cae-session-scribe-$s"

if (-not $Tag) {
    $sha = (git -C $project rev-parse --short HEAD 2>$null)
    $dirty = (git -C $project status --porcelain 2>$null) ? "-dirty" : ""
    $Tag = "$(Get-Date -Format 'yyyyMMdd-HHmmss')-$sha$dirty"
}
$loginServer = AzRun acr show --subscription $sub -g $rg -n $registry --query loginServer -o tsv
$image = "$loginServer/session-scribe:$Tag"

if (-not $SkipBuild) {
    Write-Host "Building $image in ACR (context honors .dockerignore; .env, .secrets, data are never uploaded)..."
    Push-Location $project
    try {
        # Log streaming in az crashes on non-UTF-8 consoles, so queue the build and poll its status instead.
        $run = AzRun acr build --subscription $sub --registry $registry --image "session-scribe:$Tag" --file Dockerfile . --no-logs -o json | Out-String | ConvertFrom-Json
    } finally { Pop-Location }
    do {
        Start-Sleep -Seconds 20
        $status = AzRun acr task show-run --subscription $sub --registry $registry --run-id $run.runId --query status -o tsv
        Write-Host "  build $($run.runId): $status"
    } while ($status -in @("Queued", "Started", "Running"))
    if ($status -ne "Succeeded") {
        $registryId = AzRun acr show --subscription $sub -g $rg -n $registry --query id -o tsv
        $logUrl = AzRun rest --method post --url "https://management.azure.com$registryId/runs/$($run.runId)/listLogSasUrl?api-version=2019-06-01-preview" --query logLink -o tsv
        $logFile = Join-Path ([IO.Path]::GetTempPath()) "session-scribe-build-$($run.runId).log"
        Invoke-WebRequest -Uri $logUrl -OutFile $logFile -UseBasicParsing
        Get-Content $logFile -Tail 40 | Out-Host
        throw "Image build $($run.runId) finished with status $status. Full log: $logFile"
    }
}

$identity = AzRun identity show --subscription $sub -g $rg -n id-session-scribe -o json | Out-String | ConvertFrom-Json
$envInfo = AzRun containerapp env show --subscription $sub -g $rg -n $envName -o json | Out-String | ConvertFrom-Json
$origin = if ($cfg.app.publicOrigin) { $cfg.app.publicOrigin } else { "https://$appName.$($envInfo.properties.defaultDomain)" }

$settings = [ordered]@{
    NODE_ENV = "production"
    HOST = "0.0.0.0"
    PORT = "3000"
    DATA_DIR = "/data"
    APP_PUBLIC_ORIGIN = $origin
    APP_ADMIN_EMAIL = $cfg.app.adminEmail
    APP_OPEN_SIGNUP = "false"
    TRUST_PROXY = "1"
    SQLITE_JOURNAL_MODE = "DELETE"
    RECORDING_RETENTION_DAYS = "30"
    AZURE_AUTH_MODE = "managed-identity"
    AZURE_CLIENT_ID = $identity.clientId
    AZURE_SPEECH_ENDPOINT = $cfg.ai.speechEndpoint
    AZURE_SPEECH_API_VERSION = "2025-10-15"
    AZURE_OPENAI_ENDPOINT = $cfg.ai.openaiEndpoint
    AZURE_OPENAI_DEPLOYMENT = $cfg.ai.openaiDeployment
    AZURE_OPENAI_REASONING_EFFORT = $cfg.ai.reasoningEffort
    AZURE_STORAGE_ACCOUNT_URL = "https://$($cfg.blob.accountName).blob.core.windows.net"
    AZURE_STORAGE_CONTAINER = $cfg.blob.container
    LAUGHTER_DETECTION_ENABLED = "true"
}
if ($cfg.app.PSObject.Properties.Name -contains "env") {
    foreach ($p in $cfg.app.env.PSObject.Properties) { $settings[$p.Name] = [string]$p.Value }
}

$spec = [ordered]@{
    location = $envInfo.location
    identity = @{ type = "UserAssigned"; userAssignedIdentities = @{ $identity.id = @{} } }
    properties = [ordered]@{
        managedEnvironmentId = $envInfo.id
        configuration = [ordered]@{
            activeRevisionsMode = "Single"
            ingress = [ordered]@{
                external = $true; targetPort = 3000; transport = "http"; allowInsecure = $false
                traffic = @(@{ latestRevision = $true; weight = 100 })
            }
            registries = @(@{ server = $loginServer; identity = $identity.id })
        }
        template = [ordered]@{
            terminationGracePeriodSeconds = 60
            containers = @(@{
                name = "session-scribe"
                image = $image
                resources = @{ cpu = [double]$cfg.app.cpu; memory = $cfg.app.memory }
                env = @($settings.GetEnumerator() | Where-Object { $_.Value } | ForEach-Object { @{ name = $_.Key; value = [string]$_.Value } })
                volumeMounts = @(@{ volumeName = "data"; mountPath = "/data" })
            })
            # Exactly one replica: SQLite and the in-process job queue assume a single writer.
            scale = @{ minReplicas = 1; maxReplicas = 1 }
            volumes = @(@{
                name = "data"; storageType = "NfsAzureFile"; storageName = "sessiondata"
            })
        }
    }
}
$specFile = Join-Path ([IO.Path]::GetTempPath()) "session-scribe-$([guid]::NewGuid()).yaml"
try {
    $spec | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $specFile -Encoding utf8
    if (AzExists containerapp show --subscription $sub -g $rg -n $appName) {
        Write-Host "Updating $appName to $Tag..."
        AzRun containerapp update --subscription $sub -g $rg -n $appName --yaml $specFile -o none
    } else {
        Write-Host "Creating $appName with $Tag..."
        AzRun containerapp create --subscription $sub -g $rg -n $appName --yaml $specFile -o none
    }
} finally { Remove-Item -LiteralPath $specFile -ErrorAction SilentlyContinue }

Write-Host ""
Write-Host "Deployed $Tag"
Write-Host "URL: $origin"
