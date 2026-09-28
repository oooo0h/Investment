$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$chartRoot = Split-Path -Parent $PSScriptRoot
$chartRawDir = Join-Path $chartRoot 'data/raw'
New-Item -ItemType Directory -Force -Path $chartRawDir | Out-Null
$chartEnd = (Get-Date).ToString('yyyy-MM-dd')
function Save-PublicData([string]$Uri, [string]$Name) {
    $chartResponse = Invoke-WebRequest -UseBasicParsing -Uri $Uri -TimeoutSec 35 -Headers @{'User-Agent'='Mozilla/5.0';'Referer'='https://finance.sina.com.cn/'}
    [IO.File]::WriteAllText((Join-Path $chartRawDir $Name), $chartResponse.Content, [Text.UTF8Encoding]::new($false))
    Write-Output "Downloaded $Name"
}
foreach ($chartSymbol in @('sh000300', 'sz399986', 'sh000993')) {
    Save-PublicData "https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=$chartSymbol,day,2024-01-01,$chartEnd,2000,qfq" "$chartSymbol.json"
}
$chartEndCompact = $chartEnd.Replace('-', '')
foreach ($chartSymbol in @('000002', '399107')) {
    Save-PublicData "https://q.stock.sohu.com/hisHq?code=zs_$chartSymbol&start=20240101&end=$chartEndCompact&stat=1&order=D&period=d&rt=json" "turnover-$chartSymbol.json"
}
$chartFilter = [Uri]::EscapeDataString("(DIM_DATE>='2024-01-01')")
$chartMarginUrl = "https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPTA_RZRQ_LSDB&columns=ALL&filter=$chartFilter&pageSize=500&sortColumns=DIM_DATE&sortTypes=1&source=WEB&client=WEB"
Save-PublicData "$chartMarginUrl&pageNumber=1" 'margin.json'
$chartMargin = Get-Content -LiteralPath (Join-Path $chartRawDir 'margin.json') -Raw | ConvertFrom-Json
if (!$chartMargin.success) { throw 'Financing source returned an error.' }
for ($chartPage = 2; $chartPage -le $chartMargin.result.pages; $chartPage++) {
    Save-PublicData "$chartMarginUrl&pageNumber=$chartPage" "margin-page-$chartPage.json"
}
& node (Join-Path $PSScriptRoot 'prepare-data.cjs')
if ($LASTEXITCODE -ne 0) { throw 'Data validation failed; previous snapshot was retained.' }
