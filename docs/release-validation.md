---
title: 配套产物验证
description: 明确输入的离线产物核验与可选只读运行核查。
---

# 配套产物验证

`scripts/release-tools.mjs` 只处理调用者明确指定的前后端构建目录，不读取项目运行配置、数据库或媒体。它不构建、不启动服务、不扫描图库，也不替换现有安装。每个文件按相对路径、字节数和 SHA256 记录；两端的 `build-info.json` 必须是同一干净构建（产品、版本、commit、tree、dirty 一致）。指定的源提交只是**调用者声明**，工具不会读取源码树验证它；即使与构建 commit 相同，也不单独证明源码或产物可信、等价或已获发布授权。

以下 PowerShell 示例中的路径均需由调用者自行指定为绝对路径。`manifest` 和 `verify` 默认只读并将 JSON 写到标准输出；保存清单是调用者显式进行的文件写入。清单中只包含所选构建产物的文件名、大小、哈希和身份，保存前应确认公开范围。PowerShell 的 UTF-8 BOM 可被工具读取。

```powershell
$serverDist = 'C:\example\candidate\server\dist'
$clientDist = 'C:\example\candidate\client\dist'
$manifest = 'C:\example\candidate-manifest.json'
$declaredSha = '<完整小写 Git SHA>'
node scripts/release-tools.mjs manifest --server-dist $serverDist --client-dist $clientDist --declared-source-sha $declaredSha | Out-File -Encoding utf8 $manifest
node scripts/release-tools.mjs verify --manifest $manifest --server-dist $serverDist --client-dist $clientDist
```

核对会报告缺失、新增或内容变化，以及声明的源码 SHA 和已安装产物的构建身份。可用 `--runtime-info <绝对 JSON 文件>` 导入一个单独保存的构建身份快照，与当前产物比对；这只是离线快照比对，不能证明现在有进程在运行。核对失败返回非零。

## 离线复制准备

`install` 默认只做预检；只有明确传入 `--apply` 才向允许的父目录下一个**尚不存在的直接子目录**复制文件。工具验证清单、拒绝目录重叠、链接和 junction、非法或大小写冲突的相对路径，且不覆盖现有文件。复制后再逐文件核验；失败时保留可能存在的不完整新目录，不自动回滚或清理。父目录、源目录和目标应处于调用者明确拥有的隔离范围，不应同时有其他进程修改这些目录；路径检查不提供抵抗恶意并发替换的操作系统级隔离。

```powershell
$allowParent = 'C:\example\isolated-output'
$destination = 'C:\example\isolated-output\prepared'
node scripts/release-tools.mjs install --manifest $manifest --server-dist $serverDist --client-dist $clientDist --allow-parent $allowParent --destination $destination
# 确认预检结果和目标后，才显式复制：
node scripts/release-tools.mjs install --manifest $manifest --server-dist $serverDist --client-dist $clientDist --allow-parent $allowParent --destination $destination --apply
```

这是准备一份新目录中的配套产物，不是对已有安装的覆盖升级，也不表示已安装、已启动或运行验收通过。

## 按授权只读核查运行实例

仅在有对应运行核查授权时，显式提供本机回环 HTTP 基础 URL 和端口：

```powershell
node scripts/release-tools.mjs runtime --base-url 'http://127.0.0.1:<授权端口>' --manifest $manifest
```

该命令只 GET `/api/health` 和 `/build-info.json`，分别读取服务端运行身份和正在提供的客户端身份，并可与提供的清单比对。只允许 `127.0.0.1`、`localhost` 或 `[::1]`，拒绝凭据、路径、重定向、非本机主机及不明确的端口；每个请求有 5 秒超时和 64 KiB 响应上限。结果仅包含健康、存储可用状态、内存数据库标志和身份比对，不输出其他响应内容。端点成功不代表数据库全量完整、受影响交互已验收或源码已等价，也不授予启停服务的权限。

`pnpm test:release-tools` 使用合成文件和随机端口上的合成 HTTP 服务测试这些契约，不接触实际运行实例。
