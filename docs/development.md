---
title: 开发说明
description: 当前工作区脚本、开发端口、服务启动链路与隔离验证要求。
---

# 开发说明

普通使用者从[安装与启动](/installation)进入；本页面向修改代码或文档的开发者。项目保留 Foldergram 包名及 AGPL 许可，不能把文档换名当作修改包名、版本或许可证的授权。

## 工作区与运行环境

```text
client/    Vue 页面、路由、API 客户端与前端测试
server/    Express、SQLite、入库/审核/目录服务与测试
docs/      VitePress 文档站
scripts/   根工作区脚本入口
data/      默认运行数据位置（不是测试夹具目录）
```

使用 `pnpm@10.28.0` 和锁文件，推荐 Node 24.21.0，版本由 `.node-version` / `.nvmrc` 固定。根 `package.json` 的 `engines` 支持 Node `>=22.16.0 <23 || >=24.0.0 <25`；Node 22 下限来自 `node:sqlite` backup API。GitHub Verify 在 Ubuntu 上分别执行 Node 22、24 矩阵。平台相关跳过需要看具体条件，不能仅凭两边通过数量不同判定回归或全部正常。

Verify 也在 Node 24 执行一次文档构建；它不会部署文档。每个矩阵任务的摘要分别列出事件 SHA、PR 的 head/base SHA、实际检出 SHA 和各检查结果。PR 的事件 SHA 可能是合并测试提交，不能当作候选 head；push 的 `before` 也单独列出。失败时，固定测试与构建日志作为 Actions artifact 保留 7 天；安装依赖或检出等步骤的详细输出仍在 Actions 日志中。新的同一 PR 运行会取消被替代的旧运行，main 的 push 验证不互相取消。

## 根命令

在仓库根目录运行：

| 命令 | 实际用途 |
| --- | --- |
| `pnpm install --frozen-lockfile` | 按锁文件安装工作区依赖。 |
| `pnpm dev` | 同时启动 server、client、docs 开发服务。 |
| `pnpm dev:server` / `pnpm dev:client` / `pnpm dev:docs` | 仅启动对应工作区。 |
| `pnpm build` | 服务端 TypeScript 构建与客户端类型检查、Vite 构建。 |
| `pnpm build:server` / `pnpm build:client` | 仅构建指定端。 |
| `pnpm start` | 设置 production，再调用服务端迁移脚本和编译入口。 |
| `pnpm build:docs` | 仅构建文档站，不包含在应用 build 中。 |
| `pnpm test` | 顺序运行服务端与客户端测试；服务端失败时不继续客户端。不包含下列独立专项、构建或文档检查。 |
| `pnpm test:server` / `pnpm test:client` | 单侧测试，支持测试文件参数和 `-t` 名称过滤，见下方示例。 |
| `pnpm lint` / `pnpm format:check` | 前者检查 manifest JSON、脚本语法与 diff 空白；后者仅检查列明文件的格式。不是全仓库代码 lint 或格式化。 |
| `pnpm test:build-info` / `pnpm test:workspace-runner` | 独立运行构建身份、工作区转发器与测试入口回归专项。 |
| `pnpm test:dev-security` | 使用合成夹具核对 Vite 开发文件边界、HMR 和后端代理。 |
| `pnpm migrate` | 单独应用待执行迁移；会改变所配置数据库，不是只读诊断。 |
| `pnpm rescan` | 显式图库重扫，会更新索引/派生数据，不是健康检查。 |

维护 CLI 仍存在，例如 `pnpm --dir server local-folder-admission --help`、`pnpm --dir server local-ingest --help`。它们与网页复用服务，但**普通网页入库不要求调用 CLI**；不能把从别处复制来的 scope、plan 或 JSON 当作当前范围的授权。

根目录命令请从 `pnpm run <script>`（或表中的 pnpm 简写）执行。工作区转发器使用调用方的 `npm_execpath`，并沿用当前 Node 执行包管理器；不要脱离包管理器上下文直接运行该内部脚本。此方式避免 Windows `node --run` 在含中文的工作目录中查找 `package.json` 失败。启动 pnpm 前应确认当前终端 `node --version` 符合项目支持范围；仅用绝对 Node 路径启动 pnpm，并不会自动替换终端 PATH 中另一个旧 Node。转发器仅给子进程前置当前 Node 目录，不修改系统 PATH。退出码与终止信号继续向上传递。

### 测试文件与名称过滤

专项参数使用 `test:server` 或 `test:client`，不要把文件过滤参数交给同时运行两端的 `pnpm test`。文件路径相对于对应工作区：服务端从 `server/` 开始，客户端从 `client/` 开始；以下命令仍在仓库根目录执行。

```powershell
# 只运行一个服务端测试文件
pnpm test:server -- test/gallery-statistics.test.ts

# 在该文件内按测试名称过滤；-t 接受正则表达式
pnpm test:server -- test/gallery-statistics.test.ts -t "unambiguous legacy copy"

# 只运行一个客户端测试文件，或进一步按名称过滤
pnpm test:client -- src/components/GalleryStatistics.test.ts
pnpm test:client -- src/components/GalleryStatistics.test.ts -t "real empty gallery"
```

文件参数由 Vitest 匹配测试路径；需要单个文件时使用完整的工作区相对路径，并核对报告中的实际文件列表。没有匹配到测试文件时命令返回非零，不回退到全量，也不要用 `--passWithNoTests` 把选错文件当作通过。`-t` 沿用 Vitest 的名称过滤行为：没有匹配到名称时可能只报告 skipped，因此还要核对实际执行的测试数，不能只看退出码。

以下专项独立于 `pnpm test`，按改动范围选择；现有 Verify 会分别调用它们：

| 命令 | 覆盖范围 |
| --- | --- |
| `pnpm test:build-info` | 构建身份生成规则。 |
| `pnpm test:workspace-runner` | 工作区命令参数、Node/包管理器上下文及退出行为，以及测试入口的文件选择和无匹配失败回归。 |
| `pnpm test:dev-security` | 合成环境中的 Vite 文件访问、HMR 和代理边界；不是浏览器端到端测试。 |

客户端常规测试使用 jsdom；`client/test/*-browser.mjs`、`server/test/fixtures/*-browser.cjs` 和 `scripts/perf/*-browser.mjs` 等浏览器脚本需要另外准备隔离环境并显式运行，不包含在常规 `pnpm test` 或 Verify 中。文件存在不等于浏览器场景已经验收。平台或能力条件造成的 skip、`-t` 过滤掉的测试，以及根本没有执行的独立专项，应分别记录原因和范围，不合并成“全部通过”。

## 开发端口与隔离

默认开发前端使用 4141～4144 中的空闲端口，后端 4140，文档站 4145。production 默认后端 4141，同时提供配套 `client/dist`。开发前端代理 `/api`、`/thumbnails`、`/previews` 到开发后端。

Vite 开发前端及静态预览默认监听 `127.0.0.1`，可通过 `DEV_CLIENT_HOST` 显式选择 `localhost` 或 IP；允许的静态文件范围与私有文件拒绝规则见[开发文件访问边界](/h1-development-boundary)。文档开发与预览脚本仍使用 `--host 0.0.0.0`，不与应用前端混为一谈。开发服务和 `vite preview` 都不代替配套 production 入口。

端口分开**不代表数据已经隔离**。独立工作树/进程还必须有自己的数据库、图库、等待区、处理中目录、缩略图、预览目录及明确的 `BACKUP_ROOT`。不要让测试脚本、CLI 或第二个 Worker 指向真实实例的数据。特别检查从 `.env.example` 复制的显式路径值，避免只改 `DATA_ROOT` 却仍复用旧路径。服务端的 `APP_ENV_FILE` 不会自动切换客户端 Vite 的环境文件，两个工作区的有效配置分别核对。

服务端 Vitest 配置及 `roster-first-runtime.mjs`、`unified-creator-sync-runtime.mjs` 两个可选端到端运行入口共用 `scripts/test-environment.mjs`：在导入应用模块前，将数据目录及其别名、数据库、图库、缩略图、预览、恢复点、环境文件和运行配置文件显式指向各自的夹具根目录，覆盖从 IDE 或终端继承的对应路径；同时关闭自动备份和入库启动补偿扫描，并清空继承的解压密码。测试仍可显式设置自己的合成夹具，其他手工脚本和客户端 Vite 不因此自动获得隔离。环境隔离回归位于 `server/test/test-environment.test.ts`，包含在常规 `pnpm test:server` 中。

## 正常启动链路

服务端 `dev` 脚本先用 tsx 执行迁移，再由 tsx watch 启动源码入口；`start` 先执行编译迁移脚本再运行 `dist/index.js`。数据库连接初始化也调用迁移检查并完成必要校验。两进程脚本与直接编译入口的耗时不能混为同一种样本，见[启动配置说明](/configuration)。

服务本体在监听前处理必要恢复与图库启动判定，监听后处理 Stage3 中断状态恢复/可选补偿扫描，随后启动资源目录 Worker。完整校验中的结构、关系、外键、integrity 不能用此前另一进程的“已通过”替代；升级需要的变更后检查也不能被变更前检查代替。

资源目录是可重建读取模型，不是第二套作品主数据。其 Worker 读取数据库事实并发布完整代次；普通目录读取不应重新扫描全库媒体。相关实现见[读取模型说明](/resource-catalog-read-model-performance)和[失效范围](/resource-catalog-invalidation)。

开发 watcher 由扫描/重建相关流程启动，不是始终运行的入库自动化。不要以为编辑等待区文件就会自动建立接纳计划或完成移动。

## 验证范围

代码改动应覆盖相关服务、路由和页面行为，并在必要时运行完整回归：

```powershell
pnpm test
pnpm build
pnpm build:docs
```

这是一组命令入口，不是每次只改文档也必须手工重跑业务全量。普通 Markdown 修改检查 diff 空白、受影响链接/锚点与事实一致性；涉及文档站配置、组件或渲染疑点时再构建文档站。其他变更按[分级验证规则](/governance-runtime#分级验证与最小部署检查)选择必要检查；仓库正常 CI 按现有规则运行，不通过改 skip 或断言缩小门槛。

现有 Verify 的 Node 22/24 矩阵包括服务端与迁移测试、客户端测试、治理与构建身份/转发器专项、Vite 开发边界专项、双端构建及生成文件污染检查；文档站另有 `.github/workflows/deploy-docs.yml`。报告对应精确提交和实际运行环境，不累计重复测试数量，不把修改前全量当成修改后全量。真实 4141 部署保留最终候选精确 Head 的 Verify 门槛，构建命令不能代替[最小部署闭环](/governance-runtime#_4141-最小部署闭环)。

隔离验证应特别覆盖：

- 原计划恢复、重复提交、活动任务保护与真实文件快照变化。
- 草稿重读范围变化、人工暂缓保留及后续完成的历史展示。
- 来源资料留存、精确对应与本地满足的不同状态。
- Windows 回收站、同卷与路径规范化的真实平台边界。
- 资源目录更新一致性、故障保留旧完整版本及普通读取复用。

真实媒体、数据库、浏览器存储、密钥与私人证据不进入测试夹具或 Git。没有授权时，不为验收重跑真实入库、恢复、来源检查或清理。

## 数据库变更

`server/db/migrations/*.sql` 是按序迁移；`server/src/db/schema.ts` 及引用的子 schema 描述当前结构。新变化应新增兼容的增量迁移并保持快照一致，不改写已在真实数据库应用的迁移。

迁移测试在副本或夹具数据库进行，覆盖升级、幂等、受支持恢复和异常拒绝。不能用删除迁移表、清空真实数据库或自动 down 解决开发不一致。恢复本地解压密码还需要对应 private key，见[密码设置](/local-ingest-password-settings)。

## 页面、插件与文档协作

- 新正常路由以[入口与导航](/creator-admission-navigation)为准，旧入口只保留兼容。
- 图库摘要与完整 Work 详情分工保持；Viewer 复用当前详情不等于跨路由永久缓存。
- Script 的 CostuanArchiveManager 是独立仓库配套插件；服务端能力存在，不代表用户浏览器已经安装对应插件。
- 翻译键位于 `client/src/locales/`，修改共享界面文本时遵守现有语言键一致性测试。
- 文档站复用 VitePress。修改 README 或当前指南时同步主页与导航；阶段性能和发布记录保留历史范围，不能改写旧测量为今天的结果。
