param(
    [ValidateRange(1, 65535)][int]$Port = $(if ($env:PORT) { [int]$env:PORT } else { 4186 }),
    [switch]$NoBrowser
)

$ErrorActionPreference = 'Stop'
$siteRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$siteTemp = Join-Path (Split-Path $siteRoot -Parent) '临时文件\fund-trade-web\logs'
$siteUrl = "http://127.0.0.1:$Port/"
$siteChild = $null

function Test-SiteReady {
    try {
        $response = Invoke-WebRequest -Uri ($siteUrl + '__local/health') -UseBasicParsing -TimeoutSec 2
        $health = $response.Content | ConvertFrom-Json
        return ($response.StatusCode -eq 200 -and $health.application -eq 'fund-trade-web' -and $health.mode -eq 'live' -and $health.status -eq 'ready')
    } catch { return $false }
}

function Test-PortBusy {
    $client = New-Object Net.Sockets.TcpClient
    try {
        $pending = $client.BeginConnect('127.0.0.1', $Port, $null, $null)
        if (-not $pending.AsyncWaitHandle.WaitOne(500)) { return $false }
        $client.EndConnect($pending)
        return $true
    } catch { return $false }
    finally { $client.Dispose() }
}

try {
    New-Item -ItemType Directory -Path $siteTemp -Force | Out-Null
    $run = 'startup-' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff')
    $statusLog = Join-Path $siteTemp ($run + '.log')
    function Write-SiteStatus([string]$Message) {
        $line = '[' + (Get-Date -Format 'HH:mm:ss') + '] ' + $Message
        Write-Host $line
        Add-Content -LiteralPath $statusLog -Value $line -Encoding UTF8
    }
    if (Test-SiteReady) {
        Write-SiteStatus '网站已在后台运行，复用当前服务。'
    } else {
        if (Test-PortBusy) { throw '端口已被其他服务占用，或旧版网站尚未重启；请先关闭该端口原服务再重试。' }
        $nodePath = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
        if (-not (Test-Path -LiteralPath $nodePath -PathType Leaf)) {
            $nodePath = (Get-Command node.exe -ErrorAction Stop).Source
        }
        $stdoutLog = Join-Path $siteTemp ($run + '.stdout.log')
        $stderrLog = Join-Path $siteTemp ($run + '.stderr.log')
        $env:PORT = [string]$Port
        $env:PYTHONDONTWRITEBYTECODE = '1'
        Write-SiteStatus '正在启动网站，等待数据校验和端口就绪……'
        $siteChild = Start-Process -FilePath $nodePath -ArgumentList 'scripts/serve.mjs' -WorkingDirectory $siteRoot -WindowStyle Hidden -RedirectStandardOutput $stdoutLog -RedirectStandardError $stderrLog -PassThru
        $ready = $false
        $deadline = (Get-Date).AddSeconds(45)
        while ((Get-Date) -lt $deadline) {
            if (Test-SiteReady) { $ready = $true; break }
            $siteChild.Refresh()
            if ($siteChild.HasExited) { throw '网站进程未能启动，请查看本次启动日志。' }
            Start-Sleep -Milliseconds 400
        }
        if (-not $ready) { throw '等待网站启动超时，请查看本次启动日志。' }
        Write-SiteStatus '网站已通过启动检查，正在后台运行；关闭启动窗口不会停止网站。'
    }
    Write-SiteStatus ('访问地址：' + $siteUrl)
    Write-SiteStatus ('日志目录：' + $siteTemp)
    if (-not $NoBrowser) {
        try { Start-Process -FilePath $siteUrl }
        catch { Write-SiteStatus '服务已运行，但浏览器未能自动打开；请手动打开上述地址。' }
    }
    exit 0
} catch {
    if ($siteChild) {
        $siteChild.Refresh()
        if (-not $siteChild.HasExited) { Stop-Process -Id $siteChild.Id -ErrorAction SilentlyContinue }
    }
    $message = if ($_.Exception.Message -match '端口|进程|超时') { $_.Exception.Message } else { '启动未完成，请检查Node.js运行环境和日志。' }
    if (Get-Command Write-SiteStatus -ErrorAction SilentlyContinue) { Write-SiteStatus ('启动失败：' + $message) }
    else { Write-Host ('启动失败：' + $message) }
    exit 1
}
