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

使用 `pnpm@10.28.0` 和锁文件。Windows 本地验证推荐 Node 24；GitHub Verify 当前是 Ubuntu / Node 22。平台相关跳过需要看具体条件，不能仅凭两边通过数量不同判定回归或全部正常。当前 package 文件没有统一 `engines` 声明，依赖和 `node:sqlite` 仍有实际运行要求。

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
| `pnpm test` | 顺序运行服务端与客户端测试。 |
| `pnpm test:server` / `pnpm test:client` | 单侧测试。 |
| `pnpm migrate` | 单独应用待执行迁移；会改变所配置数据库，不是只读诊断。 |
| `pnpm rescan` | 显式图库重扫，会更新索引/派生数据，不是健康检查。 |

维护 CLI 仍存在，例如 `pnpm --dir server local-folder-admission --help`、`pnpm --dir server local-ingest --help`。它们与网页复用服务，但**普通网页入库不要求调用 CLI**；不能把从别处复制来的 scope、plan 或 JSON 当作当前范围的授权。

## 开发端口与隔离

默认开发前端使用 4141～4144 中的空闲端口，后端 4140，文档站 4145。production 默认后端 4141，同时提供配套 `client/dist`。开发前端代理 `/api`、`/thumbnails`、`/previews` 到开发后端。

Vite 开发前端当前监听 `0.0.0.0`，不等同于 production 默认的回环监听；文档开发脚本也使用 `--host 0.0.0.0`。开发服务不要直接当作公开发布方式。

端口分开**不代表数据已经隔离**。独立工作树/进程还必须有自己的数据库、图库、等待区、处理中目录、缩略图和预览目录。不要让测试脚本、CLI 或第二个 Worker 指向真实实例的数据。特别检查从 `.env.example` 复制的显式路径值，避免只改 `DATA_ROOT` 却仍复用旧路径。

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

这是一组命令入口，不是每次只改文档也必须手工重跑业务全量。文档变化重点做链接、事实与文档构建；仓库正常 CI 按现有规则运行，不通过改 skip 或断言缩小门槛。

现有 Verify 包括服务端与迁移测试、客户端测试、双端构建及生成文件污染检查；文档站另有 `.github/workflows/deploy-docs.yml`。报告对应精确提交和实际运行环境，不累计重复测试数量，不把修改前全量当成修改后全量。

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
