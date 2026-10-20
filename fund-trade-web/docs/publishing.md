# 发布与排查

2026-10-20用户最新约定：Git/GitHub同步和GitHub Pages发布均由用户手动执行。以下入口仅供用户手动使用，或在用户另行明确委托某次操作时使用；助手完成本地修改和必要核验后，不自动提交、推送、同步或发布Pages，也不反复询问是否执行。

双击网站根目录 `D:\wd\数据分析\fund-trade-web` 中的 `一键发布到GitHub Pages.cmd` 即可运行完整流程。CMD 会自动切换到自身所在目录；也可以在网站根目录运行：

```powershell
node scripts/publish-local.mjs
```

程序按以下顺序执行：

1. 检查 Node.js 和 GitHub CLI；缺少工具时按提示安装。
2. 检查 GitHub 登录。若检查未通过，运行 `gh auth login --hostname github.com --git-protocol https --web`；按终端提示在浏览器完成登录，程序随后重新验证并自动继续。
3. 检查 `oooo0h/Investment` 仓库的访问权限。
4. 从四份权益双模式交易表和两份债基交易账本读取最新数据，在内存校验并生成两份加密快照。两份均准备完成后才替换本地密文；替换失败会回滚，停止发布。
5. 重新打包，生成本地 `dist/`。
6. 发布到 `gh-pages`，默认上传最新两份账户密文、网站和公开数据，显示发布结果及站点网址。此行为沿用用户已确认的密文发布授权；原始 Excel 不进入站点。

取消网页登录或重新验证失败时，本次流程停止，并显示失败原因与日志路径。

登录检查未通过且设置了 `GH_TOKEN` 或 `GITHUB_TOKEN` 时，程序会在本次流程中忽略这两项，改用网页登录后的系统凭据；全局环境不变。有效的环境认证会继续使用。

## 只检查或仅发布公开数据

在网站根目录执行任一命令：

```powershell
& '.\一键发布到GitHub Pages.cmd' --check
node scripts/publish-local.mjs --check
```

`--check` 会检查依赖、登录、仓库访问和六份表格，不修改账户密文或 `dist/`，也不发布。登录检查未通过时也会引导网页登录，完成后自动继续检查。

只发布页面与公开数据、保留线上账户快照时，使用：

```powershell
node scripts/publish-local.mjs --public-only
```

`--public-only` 不读取表格、不刷新或上传账户密文；可以和 `--check` 合用，只检查登录与仓库访问。CMD 同样透传这两个参数。手动运行下层 `publish-pages.mjs` 仍默认只发布公开数据；一键完整流程自动加上 `--include-account-data`。

单独核验六份表格但不连接 GitHub 时，可运行 `node scripts/prepare-account-data.mjs --check`。去掉 `--check` 会刷新两份本地密文，不打包、不发布。债基来源是各基金目录的 `006485_债基交易账本.xlsx`、`006663_债基交易账本.xlsx`，由本机只读 Python 进程载入；账户明文不写入日志或临时文件。

## 日志

发布程序启动时即创建 `../临时文件/fund-trade-web/logs/publish-YYYYMMDD-HHmmss-SSS.log`，文件名使用北京时间，终端会显示本次日志的绝对路径。日志记录各阶段、耗时、退出码、Node.js 与 GitHub CLI 版本，以及六表校验、密文替换或回滚、打包和发布结果；失败时从最后一个失败阶段开始查看。

日志只保存筛选后的诊断。网页登录的认证输出和设备验证码在终端交互，不被捕获；API 请求、响应正文和账户载荷不写入日志，敏感字段还会经过脱敏。`../临时文件/` 已加入 Git 忽略规则，也不进入站点打包。

需要协助排查时，可提供本次 `.log` 文件；不要附上密码、访问令牌、一次性设备验证码、账户明文或账户截图。下层脚本的手工调用与账户密文发布约定见 [README](../README.md#测试预览与发布)。
