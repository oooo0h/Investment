# 基金账本

完整开发、环境安装、数据格式、计算和云端复现步骤见[项目开发与复现说明](项目开发与复现说明.md)。当前表格接入说明见[本地网站数据](docs/local-data.md)。

```powershell
node scripts/serve.mjs --demo
```

以上使用虚构数据；真实模式运行 `node scripts/serve.mjs` 或双击 `启动网站.cmd`。默认地址为 `http://127.0.0.1:4186/`，真实模式需要父目录资料及Python/openpyxl。

```powershell
node scripts/test-local.mjs
```

发布前检查运行 `node scripts/publish-local.mjs --check`，完整发布运行同一脚本不带参数。原始交易表、密文与公开净值的上传范围按用户实际授权处理。
