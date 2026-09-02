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

- `libraryRoot`
- `inboxRoot`
- `processingRoot`
- `quarantineRoot`
- `sevenZipPath`
- `fileStableSeconds`
- `recycleAfterIngest`
- 固定为 2 的 `maxExtractionDepth`
- 运行时 allowlist

解压密码只从服务端进程的 `LOCAL_INGEST_ARCHIVE_PASSWORD` 环境变量读取。数据库、普通设置、API、界面、日志、测试快照和证据文档都不保存或返回密码；界面只显示“已配置/未配置”。

环境验证会检查四个根目录的存在性、读写权限、剩余空间、是否位于同一卷，以及 7-Zip 是否能够实际执行。正式处理前可运行 Windows 回收站哨兵测试。

## 发现、映射与幂等

服务启动会做补偿扫描，管理页也可手动“扫描待入库”。扫描排除 `.crdownload`、`.tmp`、`.downloading`、`.part`，并要求非零文件在配置时间内保持稳定。`waiting_stable` 任务不能被单条入口或批处理领取。

映射顺序为：

1. allowlist 中的博主目录；
2. 该博主或明确别名对应的 creator；
3. active Costuan source collection；
4. active source work；
5. 百度下载任务中的 expected filename。

不使用跨博主裸文件名，也不使用标题相似度猜测。无映射或多映射只创建 `awaiting_review`，不解压且不阻断同目录其他任务。

已映射任务以 `(sourceWorkId, SHA-256)` 去重；未映射任务以 `(creatorId, sourceArchivePath, SHA-256)` 去重。相同字节属于不同 source work 时仍会生成两个独立任务；从回收站恢复同一源包后则会识别为既有已处理任务。

## 双层解压与安全边界

7-Zip 直接只读访问待入库源包，不把外层包复制进工作目录。每一层均先列表并拒绝绝对路径、盘符路径和 `..` 路径，再执行完整性测试和密码解压；解压后还会检查符号链接、重解析点及越界路径。

第一层必须恰好包含一个可识别的内层 `.7zz` 或已恢复的 `.7z`。原始内层名称、工作名称和第一层原始输出会在改名前写入任务摘要，以便中断恢复。第二层之后仍含归档会进入 `NESTED_DEPTH_EXCEEDED`，不会递归继续。

正式媒体：JPG、JPEG、PNG、GIF、MP4、MOV、MKV。图片由 Sharp 解码验证，视频由 ffprobe 探测。TXT/HTML 只计入广告数并留在工作目录；EXE、LNK、URL、未知二进制、零字节或不可读取媒体都会阻止提交。单一包装目录可自动识别，但作品内部“图片/视频”等结构和原文件名保持不变。

预览记录博主、source work、下载任务、原始标题、源路径、SHA-256、两层归档名称、媒体计数、广告数、未知文件、声明计数、声明体积、实际体积、警告和目标目录。声明数量不一致只产生 warning；声明体积与实际体积差以字节记录。

## 原子提交、定向复扫与对账

通过校验后，程序先在 job 目录构造完整 `ready`，再次确认目标不存在，然后用一次目录重命名提交。它不会逐文件写入正式图库，也不会覆盖、合并或改名任何既有作品。

提交后只复扫映射博主，避免其他博主的历史异常干扰当前入库，也避免局部扫描把未扫描博主标记为删除。对账同时验证：

- 目标图库 folder 是 `carousel_source`；
- 索引图片数、视频数和 post item 数与校验摘要完全一致；
- active local work 位于配置的图库根且关联正确 source work；
- 下载任务已变为 `ingested`，不再进入缺失差集。

目录已经移动但复扫或关联未完成时，任务停在 `reconciling`。重试只执行定向复扫与对账，不再次解压或移动。

## 回收站清理

只有目标、索引、来源关联和差集全部确认后，任务才进入 cleanup。清理对象仅为该任务的外层源包与 `processingRoot/<job-id>`，通过 Windows Shell 回收站语义执行；没有永久删除 fallback，也不会删除空的博主父目录或清空回收站。

回收失败时 `status` 仍为 `ingested`，`cleanupStatus=failed`。重试入口只重试回收，不执行解压、提交或复扫。

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

## 第一版边界

本版本只解决本地已下载 Costuan 归档的入库闭环。不修改 CostuanArchiveManager，不处理 83 套特殊编号，不引入作品级 R15/R18，也不包含云端、NAS、对象存储、跨平台去重或自动下载。
