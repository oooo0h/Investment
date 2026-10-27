param(
    [string]$TaskName = '基金账本-晚间净值自动更新',
    [string[]]$Times = @('20:00', '21:30', '23:00'),
    [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$wrapper = Join-Path $PSScriptRoot '晚间净值自动更新.ps1'

if ($Uninstall) {
    $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($existing) {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        Write-Host ('已删除计划任务：' + $TaskName)
    } else {
        Write-Host ('未找到计划任务：' + $TaskName)
    }
    exit 0
}

if (-not (Test-Path -LiteralPath $wrapper -PathType Leaf)) {
    throw ('缺少更新包装脚本：' + $wrapper)
}
$powershell = (Get-Command powershell.exe -ErrorAction Stop).Source
$triggers = @($Times | ForEach-Object { New-ScheduledTaskTrigger -Daily -At $_ })
$action = New-ScheduledTaskAction -Execute $powershell `
    -Argument ('-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $wrapper + '"') `
    -WorkingDirectory $root
$settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit (New-TimeSpan -Hours 1) `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries
$principal = New-ScheduledTaskPrincipal `
    -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) `
    -LogonType Interactive `
    -RunLevel Limited

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $triggers -Settings $settings -Principal $principal `
    -Description '每晚自动更新七只持仓基金的最新公开净值；本地网站服务运行时由网站内轮询负责，不读取账户金额。' `
    -Force | Out-Null

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
Write-Host ('已注册计划任务：' + $task.TaskName)
$task.Triggers | ForEach-Object { Write-Host ('触发：' + $_.StartBoundary) }
Write-Host ('动作：' + $task.Actions.Execute + ' ' + $task.Actions.Arguments)
Write-Host ('状态：' + $task.State)
