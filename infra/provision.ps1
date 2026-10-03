# One-time (re-runnable) provisioning for the hosted Session Scribe container app.
# Reads real names from infra/deploy.local.json (gitignored). Copy deploy.example.json to start.
#
# Split by cost and policy:
#   - App subscription: Container Apps environment (no VNet), container app identity, registry, logs, budgets.
#     The AI account (Speech + OpenAI) already lives here and is used through the managed identity.
#   - Storage subscription: one standard storage account holding the /data SMB share and the temporary
#     Speech-input blob container. Key-based auth is required for the SMB mount, so it lives where policy allows it.
# Creates only app-specific resources; never modifies unrelated apps, plans, or model deployments.
param([string]$ConfigPath = (Join-Path $PSScriptRoot "deploy.local.json"))

$ErrorActionPreference = "Stop"
$PSNativeCommandUseErrorActionPreference = $false
$cfg = Get-Content -Raw -LiteralPath $ConfigPath | ConvertFrom-Json

function AzRun {
    $output = & az @args --only-show-errors
    if ($LASTEXITCODE -ne 0) { throw "az $($args[0..2] -join ' ') failed." }
    return $output
}
function AzJson { return (AzRun @args -o json | Out-String | ConvertFrom-Json) }
function AzExists { & az @args --only-show-errors -o none 2>$null; return $LASTEXITCODE -eq 0 }

$sub = $cfg.subscriptionId
$rg = $cfg.resourceGroup
$loc = $cfg.location
$s = $cfg.nameSuffix
$st = $cfg.storage
$names = @{
    identity  = "id-session-scribe"
    registry  = "acrsessionscribe$s"
    logs      = "log-session-scribe"
    env       = "cae-session-scribe-public-$s"
    envStore  = "sessiondata"
    share     = "session-data"
}

Write-Host "== Storage subscription: $($st.resourceGroup)/$($st.accountName)"
if (-not (AzExists group show --subscription $st.subscriptionId -n $st.resourceGroup)) {
    AzRun group create --subscription $st.subscriptionId -n $st.resourceGroup -l $st.location -o none
}
if (-not (AzExists storage account show --subscription $st.subscriptionId -g $st.resourceGroup -n $st.accountName)) {
    # Reachable over HTTPS/SMB 3 with the account key or a short-lived SAS only; no anonymous access.
    AzRun storage account create --subscription $st.subscriptionId -g $st.resourceGroup -n $st.accountName -l $st.location `
        --kind StorageV2 --sku Standard_LRS --access-tier Hot --min-tls-version TLS1_2 --https-only true `
        --allow-blob-public-access false --allow-shared-key-access true -o none
}
if (-not (AzExists storage share-rm show --subscription $st.subscriptionId -g $st.resourceGroup --storage-account $st.accountName -n $names.share)) {
    AzRun storage share-rm create --subscription $st.subscriptionId -g $st.resourceGroup --storage-account $st.accountName `
        -n $names.share --quota 100 --access-tier TransactionOptimized -o none
}
if (-not (AzExists storage container-rm show --subscription $st.subscriptionId -g $st.resourceGroup --storage-account $st.accountName -n $st.speechContainer)) {
    AzRun storage container-rm create --subscription $st.subscriptionId -g $st.resourceGroup --storage-account $st.accountName `
        -n $st.speechContainer --public-access off -o none
}
AzRun storage account file-service-properties update --subscription $st.subscriptionId -g $st.resourceGroup `
    --account-name $st.accountName --enable-delete-retention true --delete-retention-days 7 -o none
# Crash safety net: temporary Speech input is normally deleted right after transcription.
$policy = Join-Path ([IO.Path]::GetTempPath()) "scribe-lifecycle-$([guid]::NewGuid()).json"
try {
    @{ rules = @(@{
        enabled = $true; name = "delete-temporary-speech-audio"; type = "Lifecycle"
        definition = @{
            filters = @{ blobTypes = @("blockBlob"); prefixMatch = @("$($st.speechContainer)/") }
            actions = @{ baseBlob = @{ delete = @{ daysAfterModificationGreaterThan = 3 } } }
        }
    }) } | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $policy -Encoding utf8
    AzRun storage account management-policy create --subscription $st.subscriptionId -g $st.resourceGroup `
        --account-name $st.accountName --policy "@$policy" -o none
} finally { Remove-Item -LiteralPath $policy -ErrorAction SilentlyContinue }

Write-Host "== App subscription: $rg"
if (-not (AzExists group show --subscription $sub -n $rg)) { AzRun group create --subscription $sub -n $rg -l $loc -o none }

Write-Host "Managed identity"
if (-not (AzExists identity show --subscription $sub -g $rg -n $names.identity)) {
    AzRun identity create --subscription $sub -g $rg -n $names.identity -l $loc -o none
}
$identity = AzJson identity show --subscription $sub -g $rg -n $names.identity

Write-Host "Log Analytics workspace"
if (-not (AzExists monitor log-analytics workspace show --subscription $sub -g $rg -n $names.logs)) {
    AzRun monitor log-analytics workspace create --subscription $sub -g $rg -n $names.logs -l $loc --retention-time 30 --quota 0.5 -o none
}

Write-Host "Container registry"
if (-not (AzExists acr show --subscription $sub -g $rg -n $names.registry)) {
    AzRun acr create --subscription $sub -g $rg -n $names.registry -l $loc --sku Basic --admin-enabled false -o none
}
$registryId = AzRun acr show --subscription $sub -g $rg -n $names.registry --query id -o tsv

Write-Host "Least-privilege role assignments for the app identity"
$ai = $cfg.ai
$aiId = AzRun cognitiveservices account show --subscription $sub -g $ai.resourceGroup -n $ai.accountName --query id -o tsv
$assignments = @(
    @{ role = "AcrPull"; scope = $registryId },
    @{ role = "Cognitive Services Speech User"; scope = $aiId },
    @{ role = "Cognitive Services OpenAI User"; scope = $aiId }
)
foreach ($a in $assignments) {
    $existing = @(AzJson role assignment list --subscription $sub --scope $a.scope --role $a.role --fill-principal-name false) |
        Where-Object { $_.principalId -eq $identity.principalId }
    if (@($existing).Count -eq 0) {
        AzRun role assignment create --subscription $sub --assignee-object-id $identity.principalId `
            --assignee-principal-type ServicePrincipal --role $a.role --scope $a.scope -o none
    }
}

Write-Host "Recap content filter (fantasy violence): block only high-severity violence on the recap deployment"
# D&D combat narration routinely rates "medium" violence, which the default filter blocks. This policy keeps every
# other category at the default and applies only to this app's recap deployment. No approval is needed to raise a
# threshold; only turning filters off requires one.
$policyName = "session-scribe-fantasy-violence"
$filters = @()
foreach ($source in @("Prompt", "Completion")) {
    $filters += @{ name = "Violence"; blocking = $true; enabled = $true; severityThreshold = "High"; source = $source }
    foreach ($category in @("Hate", "Sexual", "Selfharm")) {
        $filters += @{ name = $category; blocking = $true; enabled = $true; severityThreshold = "Medium"; source = $source }
    }
}
$filters += @{ name = "Jailbreak"; blocking = $true; enabled = $true; source = "Prompt" }
$filters += @{ name = "Protected Material Text"; blocking = $true; enabled = $true; source = "Completion" }
$filters += @{ name = "Protected Material Code"; blocking = $false; enabled = $true; source = "Completion" }
$policyBody = Join-Path ([IO.Path]::GetTempPath()) "rai-$([guid]::NewGuid()).json"
try {
    @{ properties = @{ mode = "Blocking"; basePolicyName = "Microsoft.DefaultV2"; contentFilters = $filters } } |
        ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $policyBody -Encoding utf8
    AzRun rest --method put --url "https://management.azure.com$aiId/raiPolicies/$($policyName)?api-version=2024-10-01" --body "@$policyBody" -o none
    $deploymentUrl = "https://management.azure.com$aiId/deployments/$($ai.openaiDeployment)?api-version=2024-10-01"
    $deployment = AzRun rest --method get --url $deploymentUrl -o json | Out-String | ConvertFrom-Json
    if ($deployment.properties.raiPolicyName -ne $policyName) {
        $update = @{ sku = $deployment.sku; properties = @{
            model = $deployment.properties.model; raiPolicyName = $policyName
            versionUpgradeOption = $deployment.properties.versionUpgradeOption
        } }
        $update | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $policyBody -Encoding utf8
        AzRun rest --method put --url $deploymentUrl --body "@$policyBody" -o none
    }
} finally { Remove-Item -LiteralPath $policyBody -ErrorAction SilentlyContinue }

Write-Host "Container Apps environment (Consumption, no VNet: no load balancer or private endpoint charges)"
if (-not (AzExists containerapp env show --subscription $sub -g $rg -n $names.env)) {
    $workspaceId = AzRun monitor log-analytics workspace show --subscription $sub -g $rg -n $names.logs --query customerId -o tsv
    $workspaceKey = AzRun monitor log-analytics workspace get-shared-keys --subscription $sub -g $rg -n $names.logs --query primarySharedKey -o tsv
    AzRun containerapp env create --subscription $sub -g $rg -n $names.env -l $loc --enable-workload-profiles false `
        --logs-destination log-analytics --logs-workspace-id $workspaceId --logs-workspace-key $workspaceKey -o none
}
# The SMB mount needs the storage account key; it is stored only as a Container Apps environment secret.
$storageKey = AzRun storage account keys list --subscription $st.subscriptionId -g $st.resourceGroup -n $st.accountName --query "[0].value" -o tsv
AzRun containerapp env storage set --subscription $sub -g $rg -n $names.env --storage-name $names.envStore `
    --storage-type AzureFile --azure-file-account-name $st.accountName --azure-file-account-key $storageKey `
    --azure-file-share-name $names.share --access-mode ReadWrite -o none
$storageKey = $null
$domain = AzRun containerapp env show --subscription $sub -g $rg -n $names.env --query properties.defaultDomain -o tsv

Write-Host "Monthly budget alerts (email the subscription owners; alerts only, not a hard cap)"
function Set-Budget([string]$subscription, [string]$scope, [string]$name, [double]$amount, [object]$filter) {
    $notifications = @{}
    foreach ($n in @(@{ key = "actual80"; type = "Actual"; threshold = 80 }, @{ key = "actual100"; type = "Actual"; threshold = 100 },
                     @{ key = "forecast100"; type = "Forecasted"; threshold = 100 })) {
        $notifications[$n.key] = @{ enabled = $true; operator = "GreaterThan"; threshold = $n.threshold; thresholdType = $n.type; contactRoles = @("Owner") }
    }
    $properties = @{
        category = "Cost"; amount = $amount; timeGrain = "Monthly"
        timePeriod = @{ startDate = (Get-Date -Day 1).ToString("yyyy-MM-01T00:00:00Z") }
        notifications = $notifications
    }
    if ($filter) { $properties.filter = $filter }
    $body = Join-Path ([IO.Path]::GetTempPath()) "budget-$([guid]::NewGuid()).json"
    try {
        @{ properties = $properties } | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $body -Encoding utf8
        AzRun rest --method put --url "https://management.azure.com$scope/providers/Microsoft.Consumption/budgets/$($name)?api-version=2023-11-01" --body "@$body" -o none
    } finally { Remove-Item -LiteralPath $body -ErrorAction SilentlyContinue }
}
Set-Budget $sub "/subscriptions/$sub/resourceGroups/$rg" "session-scribe-hosting" ([double]$cfg.app.budgetMonthlyUsd) $null
if ($cfg.app.PSObject.Properties.Name -contains "aiBudgetMonthlyUsd" -and $cfg.app.aiBudgetMonthlyUsd) {
    # Speech/OpenAI spend lands on the (possibly shared) AI account, so it gets its own resource-filtered budget.
    $aiFilter = @{ dimensions = @{ name = "ResourceId"; operator = "In"; values = @($aiId) } }
    Set-Budget $sub "/subscriptions/$sub/resourceGroups/$($ai.resourceGroup)" "session-scribe-ai" ([double]$cfg.app.aiBudgetMonthlyUsd) $aiFilter
}
if ($st.PSObject.Properties.Name -contains "budgetMonthlyUsd" -and $st.budgetMonthlyUsd) {
    Set-Budget $st.subscriptionId "/subscriptions/$($st.subscriptionId)/resourceGroups/$($st.resourceGroup)" "session-scribe-storage" ([double]$st.budgetMonthlyUsd) $null
}

Write-Host ""
Write-Host "Provisioning complete."
$customDomain = if ($cfg.app.PSObject.Properties.Name -contains "customDomain" -and $cfg.app.customDomain) { $cfg.app.customDomain } else { "$($cfg.app.name).$domain" }
Write-Host "App URL after deploy: https://$customDomain"
Write-Host "Next: .\infra\deploy.ps1"
