param(
    [switch]$CheckOnly,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$logDirectory = Join-Path $root '临时文件\净值更新'
$logPath = Join-Path $logDirectory '晚间自动更新.log'
New-Item -ItemType Directory -Force -Path $logDirectory | Out-Null

function Write-RunLog([string]$Message) {
    $line = '[' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + '] ' + $Message
    Add-Content -LiteralPath $logPath -Value $line -Encoding UTF8
}

function Test-LocalSiteReady {
    try {
        $response = Invoke-WebRequest -Uri 'http://127.0.0.1:4186/__local/health' -UseBasicParsing -TimeoutSec 2
        $health = $response.Content | ConvertFrom-Json
        return ($response.StatusCode -eq 200 -and $health.application -eq 'fund-trade-web' -and $health.mode -eq 'live' -and $health.status -eq 'ready')
    } catch {
        return $false
    }
}

# A named mutex prevents overlapping task triggers. The updater also has its
# own file locks, so a concurrent server-side poller still fails safely.
$mutex = New-Object System.Threading.Mutex($false, 'Local\FundLedgerEveningNavUpdate')
$acquired = $false
$exitCode = 0
try {
    $acquired = $mutex.WaitOne(0)
    if (-not $acquired) {
        Write-RunLog '已有晚间更新在运行，本次跳过。'
        $exitCode = 0
    } else {
        if (-not $CheckOnly -and -not $Force -and (Test-LocalSiteReady)) {
            Write-RunLog '本地网站服务正在运行，由网站内晚间轮询负责更新；本次跳过。'
            $exitCode = 0
        } else {
            $cmdArguments = @('--no-pause')
            if ($CheckOnly) { $cmdArguments += '--check-only' }
            Write-RunLog ('开始' + $(if ($CheckOnly) { '只读检查' } else { '更新' }) + '。')
            & (Join-Path $root '一键更新持仓基金净值.cmd') @cmdArguments
            $exitCode = $LASTEXITCODE
            Write-RunLog ('结束，退出码 ' + $exitCode + '。')
        }
    }
} catch {
    Write-RunLog ('失败：' + $_.Exception.Message)
    $exitCode = 1
} finally {
    if ($acquired) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
exit $exitCode
