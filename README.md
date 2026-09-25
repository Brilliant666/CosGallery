# CosGallery

以规范博主、独立作品（Work）和本地媒体为核心的自有图库。可以先收录手头的图集，再补充来源资料；外部资源站用于发现、取得和补全资源，不是作品身份的唯一依据。

CosGallery 基于 [Foldergram](https://github.com/foldergram/foldergram)，沿用 Vue、Express、SQLite 与本地媒体处理能力，并增加博主账本、自有资源目录和入库工作流。许可证仍为 [AGPL-3.0](LICENSE)，保留上游署名。

## 主要能力与页面结构

```text
图库账本
├─ 博主库：规范名称、别名、分类、启用状态及本地目录关系
└─ 资源目录：恢复明确或上次有效范围，无可恢复选择时显示全部博主；搜索、编号及 TXT / CSV 导出

博主入库
├─ 本地入库：选择图集 → 检查并确认 → 入库结果
└─ Costuan：来源检查 → 网盘暂存 → Costuan入库
```

- **图库浏览**：`/library` 每页 60 位规范博主，分级与偏好使用常驻按钮组，与名称 / 别名联合筛选；博主页图集仍每页 24 套摘要，打开图集才读取完整媒体，Viewer 在当前图集内复用详情。
- **博主管理**：卡片提供“资源目录”和“管理资料”；管理面板默认只读概览，资料与本地目录分别保存。“为该博主入库”位于面板的“本地目录”标签。
- **本地入库**：从允许的已解压等待区集中选择多位博主与作品，网页核对身份、附件和冲突后提交，后台执行并保留结果与原计划。
- **自有目录**：按 Work 编目，不因多个来源或副本重复计数；持久化派生目录由后台 Worker 更新，普通翻页不重新编目全库。
- **来源与补缺**：原始资料、精确作品对应、本地版本接受及实际入库历史分别保存。不以“来源套数减本地套数”直接推定缺失。
- **异常审核**：针对具体计划 / Job 与具体文件审核，不提供“忽略所有错误”的通行开关。

日常入口为 `/archive-catalog` 和 `/creator-admission`。旧链接保留兼容跳转；详细操作见[页面地图](docs/creator-admission-navigation.md)。

## 本机快速开始

推荐使用已验证的 **Node.js 24、pnpm 10.28.0** 与本机源码构建。CI 仍使用 Node.js 22；推荐环境不等于其他版本均不支持。视频处理需要 FFmpeg / FFprobe，Costuan 归档处理另需配置 7-Zip。完整步骤见[安装](docs/installation.md)。

```powershell
git clone https://github.com/Brilliant666/CosGallery.git
cd CosGallery
Copy-Item .env.example .env
pnpm install --frozen-lockfile
```

首次启动前编辑根目录 `.env`，设置 `COS_GALLERY_MODE=1`，核对图库、数据库与缓存路径；不要将测试目录指向已有真实图库。图库在已有索引时跳过启动扫描，空库首次启动会扫描；Costuan 启动补偿扫描可用 `LOCAL_INGEST_STARTUP_SCAN=false` 关闭，两者不是同一个开关。详见[配置说明](docs/configuration.md)。等待区、允许处理名单与解压密码在对应入库页面配置。

```powershell
pnpm build
pnpm start
```

默认 production 地址为 `http://127.0.0.1:4141`，由后端提供配套前端。正常入口会执行必要迁移与数据库校验，不需要每次另外运行迁移命令。IDE 是可选工具。开发端口和分端启动见[开发指南](docs/development.md)。

现有 Docker 文件和 [Foldergram 镜像](https://github.com/foldergram/foldergram/pkgs/container/foldergram)属于上游部署基础；这里不将其当作包含当前 CosGallery 完整能力的已验收发布。[上游演示](https://foldergram.intentdeep.com/)也不是本项目的完整在线演示。

## 两种资源收录路径

### 已有本地资源

手工复制 / 解压结束后，进入 **博主入库 → 本地入库**：

1. 选择等待区中的博主及独立作品目录，核对规范博主。
2. 在“检查并确认”中处理有歧义的目录、已有 Work 候选和广告附件。
3. 查看确认范围并提交，在“入库结果”查看后台进度和图集入口。

正常路径不需要 agent、CLI 或手写 JSON，来源也不是必填项。复杂合集仍需先人工划分作品边界；文件或目录范围改动后使用重新读取 / 检查入口，确认新范围。离开页面不会主动取消已提交任务，但未提交的选择不是跨设备永久草稿。详见[本地入库与审核](docs/local-admission-web.md)。

### Costuan 补缺资源

网页与插件限定本次博主范围，检查来源并精确暂存；用户通过百度客户端下载，再由本机后端检查、解压、校验与入库。

**网盘已暂存 ≠ 本地已下载 ≠ 已入库。** 暂停或待核查时先查看具体原因，不能以反复继续代替身份与文件判断。详见[Costuan 操作指南](docs/local-ingest-closed-loop.md)。

## 数据与文件

- **规范博主 / Work** 是身份；同名不一定同套，来源编号不同也不一定是不同作品。
- **本地副本** 记录实际目录，主副本决定图库代表内容；额外副本不会自动覆盖主副本。
- **资源目录 NO** 在每位博主内按生效排序时间从早到晚编排。显示方向、搜索和分页不改 NO；补入作品或确认排序变化可能使后续 NO 顺移，不重命名文件。
- **SQLite** 保存身份、索引、来源、确认与执行历史；目录读取表是可重建的派生结果，不是第二套权威作品库。
- **原始媒体** 与缩略图 / 预览缓存分开。浏览通常读取索引和缓存；已授权入库会移动选定目录，回收或删除是另外的文件操作，不能笼统理解为“原件永远不会移动”。

备份应包含一致性数据库、原媒体、配置及必要本地密钥。网页保存的解压密码依赖独立 key 文件；不能只备份数据库。见[架构](docs/how-it-works.md)、[安全与备份](docs/security.md)、[资源目录](docs/own-resource-catalog.md)。

## 配套插件与来源资料

[CostuanArchiveManager](https://github.com/Brilliant666/Script/tree/main/CostuanArchiveManager)是独立浏览器扩展，不随 CosGallery 自动安装或重载。

当前配套 0.11.9 支持部分来源资料留存与同请求重传；这不绕过严格检查 / 自动暂存的校验，也不会自动恢复历史队列。安装、连接和版本核对请使用 Script 仓库的 README 与交接说明。

来源原文可以先留存，再确认归属和具体 Work 对应；留存资料不等于创建作品或证明本地已满足。ecytt / sndiary 可作为手工出处，但当前不宣称有专用自动采集适配器。见[来源资料](docs/source-evidence-local-admission.md)。

## 已知限制

- 本地后端只能处理其能访问的磁盘；部署到远端不会自动获得用户电脑盘符访问权。
- Windows 回收站及同卷目录移动有平台 / 卷边界；云端、NAS 和其他系统不等于已经完成同等入库验收。
- 不自动拆分混乱合集，不提供通用既有 Work 合并；部分事后关系纠正和历史广告维护仍需维护入口。
- “保留原件”不意味着超限 JPEG 等原件可以在普通 Viewer 中解码。
- 历史未完成状态可能已被后续计划覆盖，应查看当前去向，不重跑已完成项目。
- 误建博主删除仅限受保护的未使用、已停用手工身份；不是任意博主或资源的删除工具。
- 本项目不是经过公网加固的多用户云端图库；首次编目、完整性校验与首次图片生成没有固定耗时承诺。

## 文档与上游

- [快速开始](docs/quick-start.md) · [安装](docs/installation.md) · [配置](docs/configuration.md)
- [功能与页面地图](docs/features.md) · [本地入库](docs/local-admission-web.md) · [Costuan 入库](docs/local-ingest-closed-loop.md)
- [来源资料](docs/source-evidence-local-admission.md) · [自有资源目录](docs/own-resource-catalog.md)
- [FAQ](docs/faq.md) · [排错](docs/troubleshooting.md) · [开发](docs/development.md)
- [维护与历史参考索引](docs/reference-index.md) · [贡献约定](CONTRIBUTING.md)

感谢 Foldergram 作者 **Sajjad Ali** 及上游贡献者。上游媒体浏览、处理与分享文档保留为技术参考；其中 Foldergram 专属目录规则应结合当前 CosGallery 模式阅读，不作为本地入库的替代步骤。
