param(
    [Parameter(Mandatory = $true)][string]$Subscription,
    [Parameter(Mandatory = $true)][string]$ResourceGroup,
    [Parameter(Mandatory = $true)][string]$AppName
)

$ErrorActionPreference = "Stop"
$project = Split-Path $PSScriptRoot -Parent
$stage = Join-Path ([System.IO.Path]::GetTempPath()) ("dnd-gateway-" + [guid]::NewGuid().ToString())
$zip = "$stage.zip"

Push-Location $project
try {
    npm run build
    if ($LASTEXITCODE -ne 0) { throw "Gateway build failed." }

    New-Item -ItemType Directory -Path (Join-Path $stage "dist") | Out-Null
    Copy-Item -LiteralPath "package.json", "package-lock.json" -Destination $stage
    foreach ($module in @("gateway-server", "gateway-storage", "gateway", "storage-contract")) {
        Copy-Item -LiteralPath "dist\$module.js" -Destination (Join-Path $stage "dist")
    }
    npm ci --omit=dev --prefix $stage
    if ($LASTEXITCODE -ne 0) { throw "Gateway deployment dependency restore failed." }

    Compress-Archive -Path (Join-Path $stage "*") -DestinationPath $zip
    az webapp deploy --name $AppName --resource-group $ResourceGroup --subscription $Subscription `
        --src-path $zip --type zip --timeout 600000 --track-status true
    if ($LASTEXITCODE -ne 0) { throw "Gateway deployment failed." }
}
finally {
    Pop-Location
    if (Test-Path -LiteralPath $zip) { Remove-Item -LiteralPath $zip }
    if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse }
}
