# One-time (re-runnable) provisioning for the hosted Session Scribe container app.
# Reads real names from infra/deploy.local.json (gitignored). Copy deploy.example.json to start.
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
$names = @{
    identity  = "id-session-scribe"
    registry  = "acrsessionscribe$s"
    storage   = "stscribenfs$s"
    share     = "session-data"
    logs      = "log-session-scribe"
    env       = "cae-session-scribe-$s"
    envStore  = "sessiondata"
}

Write-Host "Resource group $rg"
if (-not (AzExists group show --subscription $sub -n $rg)) { AzRun group create --subscription $sub -n $rg -l $loc -o none }

Write-Host "Dedicated VNet (Container Apps subnet + private endpoints)"
$net = $cfg.network
if (-not (AzExists network vnet show --subscription $sub -g $rg -n $net.vnetName)) {
    AzRun network vnet create --subscription $sub -g $rg -n $net.vnetName -l $loc --address-prefixes $net.addressPrefix -o none
}
if (-not (AzExists network vnet subnet show --subscription $sub -g $rg --vnet-name $net.vnetName -n container-apps)) {
    AzRun network vnet subnet create --subscription $sub -g $rg --vnet-name $net.vnetName -n container-apps `
        --address-prefixes $net.appSubnetPrefix --delegations Microsoft.App/environments -o none
}
if (-not (AzExists network vnet subnet show --subscription $sub -g $rg --vnet-name $net.vnetName -n private-endpoints)) {
    AzRun network vnet subnet create --subscription $sub -g $rg --vnet-name $net.vnetName -n private-endpoints `
        --address-prefixes $net.privateEndpointSubnetPrefix -o none
}
$appSubnetId = AzRun network vnet subnet show --subscription $sub -g $rg --vnet-name $net.vnetName -n container-apps --query id -o tsv
$peSubnetId = AzRun network vnet subnet show --subscription $sub -g $rg --vnet-name $net.vnetName -n private-endpoints --query id -o tsv
$vnetId = AzRun network vnet show --subscription $sub -g $rg -n $net.vnetName --query id -o tsv

function Ensure-PrivateEndpoint([string]$name, [string]$resourceId, [string]$group, [string]$zone) {
    if (-not (AzExists network private-dns zone show --subscription $sub -g $rg -n $zone)) {
        AzRun network private-dns zone create --subscription $sub -g $rg -n $zone -o none
    }
    if (-not (AzExists network private-dns link vnet show --subscription $sub -g $rg -z $zone -n session-scribe-vnet)) {
        AzRun network private-dns link vnet create --subscription $sub -g $rg -z $zone -n session-scribe-vnet -v $vnetId -e false -o none
    }
    if (-not (AzExists network private-endpoint show --subscription $sub -g $rg -n $name)) {
        AzRun network private-endpoint create --subscription $sub -g $rg -n $name -l $loc --subnet $peSubnetId `
            --private-connection-resource-id $resourceId --group-id $group --connection-name $name -o none
        AzRun network private-endpoint dns-zone-group create --subscription $sub -g $rg --endpoint-name $name `
            -n default --private-dns-zone $zone --zone-name $group -o none
    }
}
Write-Host "Managed identity"
if (-not (AzExists identity show --subscription $sub -g $rg -n $names.identity)) { AzRun identity create --subscription $sub -g $rg -n $names.identity -l $loc -o none }
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

Write-Host "Persistent NFS file share (private endpoint only, no account keys)"
if (-not (AzExists storage account show --subscription $sub -g $rg -n $names.storage)) {
    # NFS 4.1 Azure Files authenticates by network location, not keys: the account has no public
    # endpoint and is reachable only through the private endpoint in the app VNet. NFS requires the
    # "secure transfer" (HTTPS-only) flag off; traffic stays on the private network.
    AzRun storage account create --subscription $sub -g $rg -n $names.storage -l $loc --kind FileStorage --sku Premium_LRS `
        --min-tls-version TLS1_2 --https-only false --allow-blob-public-access false --allow-shared-key-access false `
        --public-network-access Disabled --default-action Deny --bypass None -o none
}
$storageId = AzRun storage account show --subscription $sub -g $rg -n $names.storage --query id -o tsv
if (-not (AzExists storage share-rm show --subscription $sub --storage-account $names.storage -g $rg -n $names.share)) {
    AzRun storage share-rm create --subscription $sub --storage-account $names.storage -g $rg -n $names.share `
        --quota 100 --enabled-protocols NFS --root-squash NoRootSquash -o none
}
& az storage account file-service-properties update --subscription $sub --account-name $names.storage -g $rg `
    --enable-delete-retention true --delete-retention-days 14 -o none --only-show-errors 2>$null
if ($LASTEXITCODE -ne 0) { Write-Warning "File share soft delete could not be enabled; continuing." }

Ensure-PrivateEndpoint "pe-session-scribe-nfs" $storageId "file" "privatelink.file.core.windows.net"

Write-Host "Private endpoint to the Speech-input Blob account"
$blobAccountId = AzRun storage account show --subscription $sub -g $cfg.blob.resourceGroup -n $cfg.blob.accountName --query id -o tsv
Ensure-PrivateEndpoint "pe-session-scribe-blob" $blobAccountId "blob" "privatelink.blob.core.windows.net"
Write-Host "Least-privilege role assignments for the app identity"
$ai = $cfg.ai
$aiId = AzRun cognitiveservices account show --subscription $sub -g $ai.resourceGroup -n $ai.accountName --query id -o tsv
$containerScope = "$blobAccountId/blobServices/default/containers/$($cfg.blob.container)"
$assignments = @(
    @{ role = "AcrPull"; scope = $registryId },
    @{ role = "Cognitive Services Speech User"; scope = $aiId },
    @{ role = "Cognitive Services OpenAI User"; scope = $aiId },
    @{ role = "Storage Blob Data Contributor"; scope = $containerScope }
)
foreach ($a in $assignments) {
    $existing = @(AzJson role assignment list --subscription $sub --assignee $identity.principalId --scope $a.scope --role $a.role)
    if ($existing.Count -eq 0) {
        AzRun role assignment create --subscription $sub --assignee-object-id $identity.principalId `
            --assignee-principal-type ServicePrincipal --role $a.role --scope $a.scope -o none
    }
}

Write-Host "Container Apps environment (VNet-integrated, Consumption)"
if (-not (AzExists containerapp env show --subscription $sub -g $rg -n $names.env)) {
    $workspaceId = AzRun monitor log-analytics workspace show --subscription $sub -g $rg -n $names.logs --query customerId -o tsv
    $workspaceKey = AzRun monitor log-analytics workspace get-shared-keys --subscription $sub -g $rg -n $names.logs --query primarySharedKey -o tsv
    AzRun containerapp env create --subscription $sub -g $rg -n $names.env -l $loc --enable-workload-profiles `
        --infrastructure-subnet-resource-id $appSubnetId --internal-only false `
        --logs-destination log-analytics --logs-workspace-id $workspaceId --logs-workspace-key $workspaceKey -o none
}
AzRun containerapp env storage set --subscription $sub -g $rg -n $names.env --storage-name $names.envStore `
    --storage-type NfsAzureFile --server "$($names.storage).file.core.windows.net" `
    --file-share "/$($names.storage)/$($names.share)" --access-mode ReadWrite -o none

$domain = AzRun containerapp env show --subscription $sub -g $rg -n $names.env --query properties.defaultDomain -o tsv
Write-Host ""
Write-Host "Provisioning complete."
Write-Host "Default app URL after first deploy: https://$($cfg.app.name).$domain"
Write-Host "Next: .\infra\deploy.ps1"
