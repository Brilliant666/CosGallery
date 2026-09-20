# 本地入库闭环

本模块把已经下载到本地待入库目录的 Costuan 双层压缩包安全地纳入 CosGallery。它只处理配置的 allowlist，不会枚举或处理 allowlist 之外的博主。

## 数据流

```text
G:\cos待入库\<博主>\<序号>.7z
  → 文件稳定性与下载临时文件检查
  → 博主 + 下载任务 + source collection + source work 精确映射
  → SHA-256 幂等检查
  → 外层列表、安全与完整性测试
  → G:\cos处理中\<job-id>\level-1
  → 识别唯一内层 .7zz，并仅在处理目录改名为 .7z
  → 内层安全与完整性测试
  → G:\cos处理中\<job-id>\level-2
  → 媒体校验与入库预览
  → ready 目录一次原子移动到 G:\cos图集\<博主>\<作品>
  → 仅复扫当前博主
  → 图库索引、local work、source work、下载差集四方对账
  → 外层源包和整个 job 工作目录移入 Windows 回收站
```

`staged` 仍只表示百度网盘暂存完成。本地入库由独立的 `LocalIngestJob` 表达，不复用或改变 `staged` 的含义。

## 配置与秘密

管理页“图库账本 → Stage 3 本地入库闭环”可保存和验证：

- `libraryRoot`（只读，严格等于进程启动时的 `GALLERY_ROOT`）
- `inboxRoot`
- `processingRoot`
- `sevenZipPath`
- `fileStableSeconds`
- `recycleAfterIngest`
- 固定为 2 的 `maxExtractionDepth`
- 运行时 allowlist

解压密码只从服务端进程的 `LOCAL_INGEST_ARCHIVE_PASSWORD` 环境变量读取。数据库、普通设置、API、界面、日志、测试快照和证据文档都不保存或返回密码；界面只显示“已配置/未配置”。

V1 不支持在运行时切换正式图库根目录。管理页会显示：“V1 正式图库根目录由 GALLERY_ROOT 启动配置决定，修改后需要重启服务。”API 也会拒绝与启动配置不一致的 `libraryRoot`，因此 LocalIngest 写入根与 Scanner 扫描根不会分裂。

环境验证会检查三个根目录的存在性、读写权限、剩余空间、是否位于同一卷，以及 7-Zip 是否能够实际执行。三个根目录必须是绝对路径、彼此独立且不互相包含；可解析路径会按 realpath 校验，不能用 junction 或 symlink 绕过边界。正式处理前可运行 Windows 回收站哨兵测试。

## 发现、映射与幂等

服务启动会先把超过 lease 的遗留执行任务标记为可安全继续，再做补偿扫描；不会自动重新执行任务。管理页也可手动“扫描待入库”。

扫描排除 `.crdownload`、`.tmp`、`.downloading`、`.part`。新文件的路径、大小、mtime 与首次观察时间先写入轻量 observation 表；经过 `fileStableSeconds` 后第二次观察仍完全一致且没有关联临时文件，才会计算 SHA-256。哈希完成后再次 stat，期间若文件或临时文件发生变化，就丢弃哈希并重新开始观察。等待稳定期间不会创建正式 job，也不会读取整份大文件。历史 `waiting_stable` job 仅作为向后兼容状态保留，不能被单条入口或批处理领取。

映射顺序为：

1. allowlist 中的博主目录；
2. 该博主或明确别名对应的 creator；
3. active Costuan source collection；
4. active source work；
5. 百度下载任务中的 expected filename。

不使用跨博主裸文件名，也不使用标题相似度猜测。无映射或多映射只创建 `awaiting_review`，不解压且不阻断同目录其他任务。

已映射任务以 `(sourceWorkId, SHA-256)` 去重；未映射任务以 `(creatorId, sourceArchivePath, SHA-256)` 去重。相同字节属于不同 source work 时仍会生成两个独立任务；从回收站恢复同一源包后则会识别为既有已处理任务。

执行入口使用数据库原子 claim/lease 和进程内 per-job mutex。单任务、批处理、HTTP 重试或多个页面同时请求同一 job 时，只有一个执行者可以进入 7-Zip，`attemptCount` 也只由获得执行权的调用增加。

## 双层解压与安全边界

7-Zip 直接只读访问待入库源包，不把外层包复制进工作目录。每一层均先列表并拒绝绝对路径、盘符路径和 `..` 路径，再执行完整性测试和密码解压；解压后还会检查符号链接、重解析点及越界路径。

归档命令超时时会终止该命令的完整进程树，并等待实际子进程退出后才把任务标记为失败；不会按进程名误杀其他 7-Zip，也不会在失败返回后继续向 job 目录写文件。

第一层必须恰好包含一个可识别的内层 `.7zz` 或已恢复的 `.7z`。原始内层名称、工作名称和第一层原始输出会在改名前写入任务摘要，以便中断恢复。第二层之后仍含归档会进入 `NESTED_DEPTH_EXCEEDED`，不会递归继续。

正式媒体：JPG、JPEG、PNG、GIF、WebP、MP4、MOV、MKV。图片由 Sharp 按原有安全限制解码验证，视频由 ffprobe 探测。未知二进制、零字节或不可读取媒体仍阻止提交；附件沿用既有分类，不因增加 WebP 放宽。单一包装目录可自动识别，但作品内部“图片/视频”等结构和原文件名保持不变。

预览记录博主、source work、下载任务、原始标题、源路径、SHA-256、两层归档名称、媒体计数、广告数、未知文件、声明计数、声明体积、实际体积、警告和目标目录。声明数量不一致只产生 warning；声明体积与实际体积差以字节记录。

## 原子提交、定向复扫与对账

通过校验后，程序先在 job 目录构造完整 `ready`。提交前会重新读取当前设置和账本映射，并重新校验 source、processing、ready、creator 与 target 的 realpath 边界；再次确认目标不存在后，才用一次目录重命名提交。它不会逐文件写入正式图库，也不会覆盖、合并或改名任何既有作品。

提交后只复扫映射博主，避免其他博主的历史异常干扰当前入库，也避免局部扫描把未扫描博主标记为删除。对账同时验证：

- 目标图库 folder 是 `carousel_source`；
- 索引图片数、视频数和 post item 数与校验摘要完全一致；
- active local work 位于配置的图库根且关联正确 source work；
- 下载任务已变为 `ingested`，不再进入缺失差集。

目录已经移动但复扫或关联未完成时，任务停在 `reconciling`。重试只执行定向复扫与对账，不再次解压或移动。

## 回收站清理

只有目标、索引、来源关联和差集全部确认后，任务才进入 cleanup。清理对象仅为该任务的外层源包与 `processingRoot/<job-id>`，通过 Windows Shell 回收站语义执行；没有永久删除 fallback，也不会删除空的博主父目录或清空回收站。

回收前会重新校验源包必须是 `inboxRoot/<博主>/<文件>`，处理现场必须严格是 `processingRoot/<job-id>`，正式目标必须仍位于 `libraryRoot` 且绝不能成为清理目标。边界不满足时记录 `cleanupStatus=failed` 与 `RECYCLE_PATH_OUTSIDE_ALLOWED_ROOT`，不调用回收适配器，也不降级为永久删除。

普通回收失败时 `status` 仍为 `ingested`，`cleanupStatus=failed`。重试入口只重试回收，不执行解压、提交或复扫。

V1 失败现场保留在任务处理目录，未来如有需要再引入独立隔离区。旧设置中的 `quarantineRoot` 会被兼容忽略；现有磁盘目录不会被删除、移动或送入回收站。

## 操作入口

管理页提供保存、环境验证、回收站 smoke test、扫描待入库、运行 allowlist 中可处理任务、单任务继续和失败清理重试。

本机运维 CLI：

```powershell
pnpm --dir server exec tsx src/scripts/local-ingest.ts validate
pnpm --dir server exec tsx src/scripts/local-ingest.ts smoke-recycle
pnpm --dir server exec tsx src/scripts/local-ingest.ts scan <博主...>
pnpm --dir server exec tsx src/scripts/local-ingest.ts batch <博主...>
pnpm --dir server exec tsx src/scripts/local-ingest.ts run <job-id>
pnpm --dir server exec tsx src/scripts/local-ingest.ts cleanup <job-id>
pnpm --dir server exec tsx src/scripts/local-ingest.ts jobs
```

所有写操作 API 都要求图库管理权限；读取设置与任务也要求设置访问权限。

## 已解压待审核任务的精确恢复（PR38 候选）

普通 `run`/批处理继续跳过 `awaiting_review`，不会因为更新版本就自动放行历史任务。新的本机入口只接受已经完成两层解压、在媒体验证阶段暂停的原 job，不重新创建接纳计划，也不直接修改 SQL 状态。

在服务端工作目录使用同一候选编译的 `dist/scripts/local-ingest.js`：

```text
<Node24> dist/scripts/local-ingest.js preview-review <absolute-request.json>
<Node24> dist/scripts/local-ingest.js resume-review <absolute-confirmed-plan.json>
```

两个入口要求显式设置绝对 `DATA_ROOT`、`DB_DIR`、`GALLERY_ROOT`、`THUMBNAILS_DIR`、`PREVIEWS_DIR`，以及既有 Stage3 密码/工具运行配置。`--help` 不导入数据库。`preview-review` 使用只读数据库连接，不迁移、不创建存储目录、不解压、不移动文件；会读取并校验本任务的源压缩包和已解压文件，输出包含本机路径的 `confirmed:false` JSON，只能保存到本机忽略目录。

请求的最小形状（以下均为合成示例，不是实际执行授权）：

```json
{
  "jobId": 123,
  "removedFiles": [{ "relativePath": "wrapper/empty.jpg", "size": 0 }],
  "retainedFiles": [{ "relativePath": "wrapper/book.pdf", "reason": "attachment" }],
  "note": "逐项确认的审核依据"
}
```

路径相对本 job 的 `level-2`，必须明确到文件，不支持通配符、目录批准或“忽略全部差异”。移除项必须已由用户授权、通过其他明确操作移除；该入口不自行删除或回收它们。原包 `7z l -slt` 的路径、Size、CRC 必须能证明缺少的恰是批准项，其余文件逐一验证，额外、缺失、同大小内容变化均拒绝。旧暂停记录没有完整 manifest 时，也必须由原外层 SHA、内层 CRC/SHA 和归档成员补足证据，不能盲目信任当前文件树。

可保留类型限于逐文件明确批准的：

- `pixel_limit`：仅 JPEG，默认 Sharp 必须实际报告像素限制。正常 JPEG 或其他解码损坏不能借此绕过；不关闭或提高像素安全上限。
- `attachment`：仅 PDF，作为附件完整保留，不转换成图片、不算广告。

以上沿用 `_未支持格式原件` 和现有索引排除机制，不另建原件库。图片原件计入 `retainedOriginalCount`；PDF 单列 `retainedAttachmentCount`，不计入可展示图片/视频、媒体字节或未支持图片数量。原有 HEIC/HEIF/TIFF 自动保留和旧手工保留记录兼容，不重新解释旧决定。

人工核对预览后只把该完整计划的 `confirmed` 改为 `true` 再提交。服务重新核对源包、身份映射、路径、解压标记和文件清单；首次接受后把版本 1 的不可变 payload、hash、原失败及确认时间写入原 job 的 `summary_json.reviewRecovery`，无需新增迁移。重试必须使用同一 payload，不允许补写新例外覆盖原确认。

恢复复用原校验、提交、单作品索引及账本对账。审核恢复使用绑定 planId 的副本 staging，保留原解压现场直到提交和校验完成；复制中断后只复用 checksum 完全相符的已完成文件，截断或额外文件仍暂停且不自动覆盖/删除。目标目录存在不等于提交成功，还须匹配本计划的目录身份及完整清单。索引失败保留 `reconciling`，同计划重试不解包、不重复移动、不改其他作品。成功的同计划再次调用为 no-op；后续清理仍使用原 `cleanup`，回收前再次核对目标、源包、解压清单及原件校验和。

相关下载活动 claim、同博主 Stage3 执行、当前 job 活动 claim 和接纳互斥仍阻止恢复。已接受同一计划的进程退出后，可在取得跨进程互斥且原 heartbeat 确已过期时沿用既有 lease 接管，不清除活动所有权。索引后的审核对账只更新原下载任务，不调用整博主缺失规划；最终活动状态核对与更新位于同一 SQLite 写事务，保留暂存、worker、attempt、download 等真实历史。该功能不是解除任意审核失败的通用开关；不支持的文件/状态保持暂停。

## 第一版边界（历史范围）

本版本只解决本地已下载 Costuan 归档的入库闭环。不修改 CostuanArchiveManager，不处理 83 套特殊编号，不引入作品级 R15/R18，也不包含云端、NAS、对象存储、跨平台去重或自动下载。
