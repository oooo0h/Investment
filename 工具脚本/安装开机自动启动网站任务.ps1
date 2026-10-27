param(
    [string]$TaskName = '基金账本-登录自动启动网站',
    [ValidateRange(5, 300)][int]$DelaySeconds = 20,
    [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$launcher = Join-Path $root 'fund-trade-web\scripts\start-local.ps1'

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

if (-not (Test-Path -LiteralPath $launcher -PathType Leaf)) {
    throw ('缺少网站启动脚本：' + $launcher)
}

$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$powershell = (Get-Command powershell.exe -ErrorAction Stop).Source
$arguments = '-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $launcher + '" -NoBrowser -Port 4186'
$action = New-ScheduledTaskAction -Execute $powershell -Argument $arguments -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
$trigger.Delay = 'PT' + $DelaySeconds + 'S'
$settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 5) `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal `
    -Description ('登录 Windows 后在后台启动基金账本网站，复用已运行服务；不自动打开浏览器。启动器：' + $launcher) `
    -Force | Out-Null

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
Write-Host ('已注册计划任务：' + $task.TaskName)
$task.Triggers | ForEach-Object {
    Write-Host ('触发：登录时，延迟 ' + $DelaySeconds + ' 秒')
}
Write-Host ('动作：' + $task.Actions.Execute + ' ' + $task.Actions.Arguments)
Write-Host ('工作目录：' + $task.Actions.WorkingDirectory)
Write-Host ('状态：' + $task.State)
Write-Host '说明：任务结束不代表网站进程结束；启动器会留下后台 Node 服务，且不会打开浏览器。'
