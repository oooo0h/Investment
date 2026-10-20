# 基金账本

2026-10-20用户最新约定：Git/GitHub同步与GitHub Pages发布由用户手动执行。助手默认只完成本地修改和必要核验，不自动提交、推送、运行同步或发布入口；只有用户另行明确委托某次操作时才执行。

完整开发、环境安装、数据格式、计算和云端复现步骤见[项目开发与复现说明](项目开发与复现说明.md)。当前表格接入说明见[本地网站数据](docs/local-data.md)。

本地服务现已包含19:00后的净值轮询，QDII以前一交易日为目标，非QDII以当天交易日为目标；未更新基金每3分钟重试，全部达标后停止当晚轮询。云端页面不运行该任务。交易日历范围、区间盈亏、四基金持仓分布、电脑侧边菜单和债基订单兼容说明见[本地晚间净值轮询](docs/local-evening-nav.md)。

```powershell
node scripts/serve.mjs --demo
```

以上使用虚构数据；真实模式运行 `node scripts/serve.mjs` 或双击 `启动网站.cmd`。默认地址为 `http://127.0.0.1:4186/`，真实模式需要父目录资料及Python/openpyxl。

```powershell
node scripts/test-local.mjs
```

发布前检查运行 `node scripts/publish-local.mjs --check`，完整发布运行同一脚本不带参数。原始交易表、密文与公开净值的上传范围按用户实际授权处理。
