---
title: 配套产物验证
description: 明确输入的离线产物核验与可选只读运行核查。
---

# 配套产物验证

`scripts/release-tools.mjs` 按调用者明确指定的路径核对产物和部署准备材料，不自动发现或读取项目运行配置、数据库或媒体。它不构建、不启动服务、不扫描图库，也不替换现有安装。每个产物文件按相对路径、字节数和 SHA256 记录；两端的 `build-info.json` 必须是同一干净构建（产品、版本、commit、tree、dirty 一致）。基础 `manifest` / `verify` 的源提交只是**调用者声明**，这两个命令不会读取源码树验证它。下文 `plan` / `prepare` 会读取指定仓库的 Git 对象并比对构建输入；这些离线检查仍不单独证明产物可信或已获发布授权。

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

## 一次准备完整输入

`plan` 和 `prepare` 共用一个 JSON profile，汇总所有能够独立检查的缺口到 `issues`，避免进入停服阶段才发现缺少回归命令、恢复记录或验收预期。两者都只读取本地材料：不会运行 profile 中的命令、访问 HTTP、安装依赖或控制进程。

合成字段模板见仓库的 `scripts/examples/deployment-profile.example.json`。模板中的 SHA、路径、管理端路径和六个步骤均需替换；`node --version` 只是无服务副作用的占位命令，`expected` 明确标记未配置。模板不能作为完整部署方案或通过证据使用。

| 字段 | 要填的内容 |
| --- | --- |
| `schema` | 固定为 `cosgallery-deployment-profile/v1` |
| `sourceRoot` | 包含候选、基线和构建提交 Git 对象的仓库根绝对路径；工具不 fetch、不切换 checkout，也不采用未提交文件作为该提交内容 |
| `candidateSha` / `baselineSha` | 完整小写提交 SHA；基线应按本次部署现场核实，不能把旧记录当成当前运行版本 |
| `manifest` / `serverDist` / `clientDist` | 配套清单及双端产物的绝对路径；清单声明必须对应候选，产物必须逐文件匹配并具有干净、相同的构建身份 |
| `runtime` | 本次目标的 `node`、`pnpm` 完整版本，以及 `platform`、`arch`；填写值是声明，不是自动探测结果 |
| `records.dependencies` / `records.recovery` | 两份已有 JSON 核查记录的绝对路径，分别不超过 1 MiB；保留原始证据，使用新文件名记录变化 |
| `regression` | 至少一个本次范围相关的本地回归命令对象，列明 `argv`、`cwd`、`inputs`、`expected` |
| `steps` | 依次为 `read-check`、`stop`、`confirm-exit`、`install`、`start`、`health`，每项还包含同样的命令字段 |
| `acceptance` | 明确 `auth` 为 `enabled` 或 `disabled`，并列出匿名 GET 的路径、`public` / `admin` 和 `expectedStatus` |

命令的 `argv` 是非空字符串数组，首项是现存可执行文件的绝对路径；`cwd` 是现存目录的绝对路径。`inputs` 必须显式列出执行时读取的脚本和配置的绝对路径，包括间接导入、外部包装脚本和配置依赖。只有确实没有这类输入的内联或原生命令才使用空数组。工具对可执行文件及这些输入计算哈希，能发现常见直接脚本参数漏列，但无法自动推断完整依赖；审查者须确认清单没有漏项。不要在参数或 profile 中放置密码、Cookie、令牌及其他秘密。

依赖记录应说明锁文件、运行时、配套 CLI / 原生模块、已准备的依赖目录及相应验证结果。恢复记录应说明旧代码、依赖、配置的恢复方式以及**当前数据保护政策**；回退代码不意味着可以用旧数据库覆盖后续业务数据。工具只绑定这两份记录的哈希，不扫描依赖或恢复目录，也不会因为 JSON 文件存在就证明依赖可用、恢复有效。六类证据中的依赖、兼容与恢复审查负责确认其内容适用。

匿名验收至少包含 `/api/health` 与 `/build-info.json`，两者为 `public`、预期 200。认证开启时，列出的 `admin` 路径预期为 401；这表示匿名访问边界正确，不能记为管理员功能验收。这里只声明预期，不验证路由是否存在或 GET 是否有派生写入；须选用已确认适合本次只读验收的路径。既有 `runtime` 命令仍只访问健康和构建身份两条路径。

完整六步骤 profile 用于提前审查切换方案，**不扩大当前授权**。仅获准离线安装并保持关闭时，到离线安装核对完成即停止；不能因为 profile 有 `start` / `health` 就执行它们，也无需为获得完整计时状态补做未授权阶段。准备期间仍可保留已关闭或由用户管理的服务状态。

## 保存并复用适用证据

先填齐 profile，再生成计划。下面保存路径是合成示例，需改为本次新文件名；`-NoClobber` 防止覆盖已有记录。

```powershell
$node = 'C:\example\runtime\node.exe'
$tool = 'C:\example\source\scripts\release-tools.mjs'
$profile = 'C:\example\evidence\profile.json'
$planFile = 'C:\example\evidence\plan-001.json'
$evidenceFile = 'C:\example\evidence\evidence-001.json'
$planText = & $node $tool plan --profile $profile
$planExit = $LASTEXITCODE
$planText | Out-File -Encoding utf8 -NoClobber $planFile
if ($planExit -ne 0) { throw '先处理 plan 的 issues，再生成新版本计划' }
$plan = ($planText -join [Environment]::NewLine) | ConvertFrom-Json
$plan.evidenceTemplate | ConvertTo-Json -Depth 100 | Out-File -Encoding utf8 -NoClobber $evidenceFile
```

`plan` 成功只说明离线输入检查通过，`offlineReady` 仍为 false。生成的 `evidenceTemplate` 六类回执均为 `pending`。审查者根据已有真实结果填写对应回执的 `status: passed`、UTC 毫秒时间 `checkedAt`、`checkedBy`、可定位的 `reference` 和实际 `coverage`；不要批量把 pending 改成 passed。没有对应结果时，保留缺口，在停服前完成必要验证。

| 回执 | 复用约束和必要内容 |
| --- | --- |
| `ci` | 精确候选 SHA 及现有四个 Verify 检查名称和 success 结果；即使文件树相同，新 Head 仍须对应自己的成功 CI |
| `review` | 候选、基线、步骤命令及输入哈希、匿名验收预期；引用实际独立审查结论 |
| `compatibility` | 候选、基线、构建身份与运行时；填写持久化影响 `none` / `compatible` / `migration` 及 `rationale`，迁移文件改变必须明确标为 migration |
| `regression` | 构建与依赖输入、产物、运行时、依赖记录以及回归命令和输入哈希；引用范围对应的实际本地结果 |
| `dependencies` | 构建与依赖输入、锁文件、运行时及依赖记录哈希 |
| `recovery` | 基线、目标构建与依赖输入、运行时及恢复记录哈希；coverage 必须覆盖 `code`、`dependencies`、`configuration`、`data-policy` |

工具分别绑定构建输入与依赖输入，并单列锁文件和迁移摘要。构建输入排除 `docs/`、根 Markdown 和许可证文本；依赖输入更保守，仅排除 Markdown 和许可证文本，因此 `docs/package.json`、文档构建配置等仍会使相关依赖证据失效。文档或 Squash 身份变化且两类输入都一致时，可以保留原干净构建及仍适用的回归、依赖证据；源码 SHA、产物构建 SHA 和实际运行身份仍分别记录，不修改 build-info。

完成证据后运行一次完整准备检查：

```powershell
$preparedFile = 'C:\example\evidence\prepared-001.json'
$preparedText = & $node $tool prepare --profile $profile --evidence $evidenceFile
$prepareExit = $LASTEXITCODE
$preparedText | Out-File -Encoding utf8 -NoClobber $preparedFile
if ($prepareExit -ne 0) { throw '准备未通过；查看 issues 和 evidenceStatus，勿进入切换' }
```

`offlineReady: true` 表示输入检查及六类回执绑定通过。每次 prepare 仍重新核对产物文件，不以旧“通过”代替当前文件；`evidenceStatus` 指出可复用或缺失/失效的范围，只补齐受影响范围的证据。不要给旧结果换一个新 key 来伪装新验证。CI、审查人与回执均是调用者提供的离线证据，工具不会联网认证它们，审查者应核对原始来源。

切换前仍须按 `requiresFreshChecks` 核对当前授权、实际进程身份、业务空闲、保护项和恢复材料适用性。准备结果不是部署许可，也不能保证稍后文件或现场状态未变化。

## 分步执行与计时

在停止服务之前完成参数、脚本、证据、产物与恢复材料准备。现场满足当前授权后，按只读核对、停止、确认退出、安装、启动、健康核查分别调用工具；每步通过后连续推进，失败立即处理，不机械重复已有有效审查。HTTP 核查与进程启停不能放在同一请求，不能以合并命令换取更短耗时。

每次独立调用内记录 UTC 开始/结束和 Stopwatch 耗时，之后再合并日志。以下仅演示**单个合成读取命令**的采集，不控制服务；先把 Node 路径替换为已核实的本地执行文件。它只能作为一个 `read-check` 条目，不能冒充实际进程或部署验收。

```powershell
$stageStart = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
$stageWatch = [Diagnostics.Stopwatch]::StartNew()
& 'C:\example\runtime\node.exe' --version
$stageCode = $LASTEXITCODE
$stageWatch.Stop()
$stageEnd = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
[ordered]@{
    stage = 'read-check'
    start = $stageStart
    end = $stageEnd
    elapsedMs = $stageWatch.Elapsed.TotalMilliseconds
    outcome = $(if ($stageCode -eq 0) { 'passed' } else { 'failed' })
} | ConvertTo-Json
```

保存原始计时 JSON：`schema` 为 `cosgallery-deployment-timing/v1`，包含本次 `runId`、成功 prepare 的 `planDigest` 及按顺序排列的 `stages` 条目。六阶段必须形成连续前缀；中途结束是 incomplete，失败条目后不能追加其他阶段。已确认服务原本关闭时，stop 可记录 `outcome: skipped`、`reason: already-stopped`，开始和结束相同且耗时为 0；其他阶段不能用 skip 伪装完成。后续另一次尝试使用新的 runId 和日志，不覆盖失败证据。

可选 `downtime` 中的 `unavailableAt` 必须是在 stop / confirm-exit 阶段明确观察到不可用的时刻，`healthyAt` 必须是在成功 health 阶段明确观察到健康的时刻。只有两者都有才能计算观测区间；只有一个或没有时结果为 null，不从启动命令时间推测停服时长。服务早已关闭时，不应把本次确认时间称为实际停服起点。

```powershell
& $node $tool timing --plan $preparedFile --log 'C:\example\evidence\timing-001.json'
```

`timing` 要求日志与成功准备结果的 planDigest 相同，只汇总已有观测，不执行命令或独立验证现场。输出分别列出 `commandElapsedMs`（Stopwatch 累计）、`interCallGapMs`（前次结束到下次开始）、`totalWallMs` 和可用时的 `downtimeMs`。倒退或重叠时间拒绝计算；墙钟与 Stopwatch 差异超过 1 秒时保留 `clockWarnings` 并返回非零，不把差异直接归因于服务、模型或工具。未完成、失败也返回非零，但保留相应统计。

首次准备争取几分钟、已有候选的纯切换争取几十秒，是待后续授权实测验证的目标；下载、构建、必要 CI、迁移和实际启动耗时须分别说明，不能用合成测试或命令时间之和宣称已经达到生产停服目标。

`pnpm test:release-tools` 覆盖合成产物、离线计划与计时契约，运行核查测试只使用随机端口上的合成 HTTP 服务，不接触实际运行实例。
