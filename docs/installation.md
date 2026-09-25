---
title: 安装与启动
description: 从 CosGallery 源码安装本机服务，区分运行环境、媒体工具与平台边界。
---

# 安装与启动

当前推荐使用 **CosGallery 源码 + 本机 Node.js + pnpm**。本机后端直接读取配置的本地目录；浏览器不需要上传整套媒体。IDE 可以作为启动工具，但不是必装依赖。

## 准备运行环境

| 项目 | 当前要求与验证范围 |
| --- | --- |
| Git | 用于取得本仓库及记录版本。 |
| Node.js | 推荐 Node 24.21.0，当前 Windows 本地入库与发布验证使用该版本。仓库使用 `node:sqlite`；GitHub Verify 同时验证 Node 22 和 24。根 `package.json` 的 `engines` 声明支持 `>=22.16.0 <23` 或 `>=24.0.0 <25`，不承诺其他版本可用。 |
| pnpm | 使用根 `package.json` 指定的 `10.28.0`，依赖由 `pnpm-lock.yaml` 锁定。本文不将 npm 安装视为等价验证路径。 |
| FFmpeg / FFprobe | 视频元数据、缩略图、预览及动画 AVIF 处理需要；通过 PATH 或配置中的完整路径提供。 |
| 7-Zip | Costuan 压缩包入库需要，在网页“入库设置与环境工具”中配置可执行文件。已解压图集的本地入库不需要先重新压缩。 |
| 本地存储 | 数据库、图库及派生目录需有适当权限和空间；入库会移动所选目录，不能把图库仅挂为只读再期待完成入库。 |

安装 Node 后确认 `node --version`。安装或启用 pnpm 10.28.0 后确认 `pnpm --version`；若已使用统一的本机工具管理方式，沿用它，不必为了本文另装一套。

## 从源码运行

以下为 Windows PowerShell 示例，工作目录是新克隆的仓库根目录：

```powershell
git clone https://github.com/Brilliant666/CosGallery.git
cd CosGallery
pnpm install --frozen-lockfile
Copy-Item .env.example .env
```

`Copy-Item` 仅用于第一次创建配置；已有 `.env` 时保留原配置，不覆盖。启动前打开 `.env`，按[配置说明](/configuration)设置实际路径。保留 `COS_GALLERY_MODE=1`，以使用本指南描述的博主与作品图库模式。

如果先准备环境、之后再手工选择 Costuan 待入库范围，可设：

```dotenv
LOCAL_INGEST_STARTUP_SCAN=false
```

这只关闭 Stage3 的启动等待区补偿扫描，不是关闭数据库迁移、完整校验或资源目录 Worker。全新的空索引仍可能触发首次图库扫描，因此第一次启动前应确认 `GALLERY_ROOT` 指向预期图库，而不是混乱的下载等待区。

完成配置后：

```powershell
pnpm build
pnpm start
```

`pnpm build` 编译配套的 `server/dist` 和 `client/dist`，不构建文档站。`pnpm start` 使用 production 模式：服务端工作区先执行迁移入口，再启动编译后的服务；数据库连接初始化也保留迁移检查和完整性校验。不要为了日常启动再手工额外运行一次迁移命令。

默认访问 [http://127.0.0.1:4141](http://127.0.0.1:4141)，健康接口为 `GET /api/health`。实际端口由 `SERVER_PORT` 决定，默认只监听 `127.0.0.1`。迁移或完整性检查期间尚未就绪是正常启动阶段，不承诺固定秒数。

首次运行后，按[快速开始](/quick-start)选择本地入库或 Costuan 路径。空图库没有作品不等于安装失败；没有配置访问保护时，可访问服务的人能直接使用管理功能。开放局域网或反向代理前先阅读[安全说明](/security)。

## 目录与平台边界

推荐将数据库、正式图库、已解压等待区、压缩包等待区及处理区分开。示例结构见[配置说明](/configuration)，盘符与文件夹名称不是项目硬编码要求。

- 本地目录接纳使用受检查的同卷移动；Costuan 的图库、压缩包等待区、处理中目录也有同卷及不重叠约束。
- Windows 回收站适配器用于相应广告、空父目录及压缩包清理；其他系统上该适配器明确报不可用，不是自动永久删除的替代实现。
- 不支持把链接、junction 或任意外部路径当作已经批准的导入范围。
- 远程访问网页不会让远程服务器获得你电脑的盘符。服务运行在哪台机器，目录选择与执行就发生在哪台机器。
- 7-Zip 默认值仍带有历史 Windows 工具路径。不要假设它在新机器上存在，应在环境工具中选定自己的 `7z.exe` 并验证。

Windows 本机路径是当前重点验证环境。Linux、NAS、云端或网络共享的浏览能力，不能代替 Windows 入库/回收闭环兼容性验证。

## 升级现有实例

先保留当前一致性数据库备份、原始媒体及配置；本地加密解压密码还依赖独立 key 文件，见[密码配置](/local-ingest-password-settings)。不要把一份旧数据库恢复到已有新入库事实的目录上来“清理状态”。

准备新版本的独立构建，确认业务空闲后停止旧服务，再切换配套前端、后端及维护 CLI，随后按正常入口启动。不要在旧后端仍运行时先覆盖新前端，也不要让新 CLI 指向另一版本的数据库结构。

正常启动按序应用待执行迁移。当前文档基线包含至 `000026` 的迁移；后续版本以仓库实际迁移文件为准。已应用版本不应反复升级或执行 down，不能删除迁移记录绕过异常。发生失败时保留真实错误与恢复材料，见[故障处理](/troubleshooting)。

## Docker 与上游参考

仓库保留 `Dockerfile`、`docker-compose.yml` 和 `docker-compose.local.yml`。其中默认 Compose 使用 `ghcr.io/foldergram/foldergram:latest`，是 **Foldergram 上游镜像**，不能用它代表当前 CosGallery 功能。

本地 Docker 构建文件可供开发者研究，但本文不把它列为已经完整验证的 CosGallery Windows 入库、7-Zip、回收站或本地密码恢复方案。没有发布可验证的 CosGallery 镜像或在线演示时，不以虚构地址替代。

## 开发与文档站

需要热更新或修改代码时见[开发说明](/development)，不要把开发端口与 production 的 4141 混用。文档站单独构建：

```powershell
pnpm build:docs
```

输出为 `docs/.vitepress/dist`，不需要为文档构建启动图库服务。
