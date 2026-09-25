# Costuan：来源检查、网盘暂存与压缩包入库

本指南适用于已有明确 Costuan 来源和下载任务映射的压缩包入库。已解压、来源未关联的本地图集应走[本地入库三步流程](local-admission-web.md)，不必为入库先补 Costuan 来源。

## 各环节由谁负责

| 参与者 | 负责什么 |
| --- | --- |
| CosGallery 网页 | 选择规范博主 / 固定检查范围，展示来源与任务；配置允许处理名单，明确扫描和运行本机入库 |
| CostuanArchiveManager 插件 | 在用户网站会话中检查来源与原分享，核对具体文件并暂存到网盘；不替用户下载或解压 |
| 百度客户端 / 用户 | 将已暂存文件手工下载到本机压缩包待入库目录，等下载完成 |
| CosGallery 本机后端 | 检查稳定文件、核对映射、解压、媒体验证、移动到图库、索引与账本对账 |

**网盘已暂存 ≠ 已下载到本地 ≠ 已入库。** 来源总数减本地总数不能直接算出独立缺失作品；来源编号也不是 Work 身份。补缺依赖具体来源 / Work 对应、本地有效性和当前任务状态。

## 日常网页流程

1. **博主入库 → Costuan → 来源检查**：筛选并明确选择对象，准备检查任务，复制本次固定检查范围到插件。也可在插件明确选择规范博主；不要把“刷新账本状态（只读）”当作来源检查。
2. 插件通过严格核验后按明确范围处理缺失文件；**网盘暂存**页展示任务和回执。严格核验失败时暂停或记录失败，不因升级插件自动放行；0.11.9 可独立留存已观察资料，见[来源资料说明](source-evidence-local-admission.md)。
3. 用百度客户端手工下载到配置的 `inboxRoot/<规范博主目录>/`，保留任务预期文件名。等下载结束，不要把临时文件当完成。
4. 打开 **Costuan入库 → 入库设置与环境工具**核对待入库区、处理区、7-Zip、密码与环境。正式图库根由启动配置决定。
5. 点击**读取待入库博主**后，用**追加到当前名单 / 替换当前名单**保存允许范围；也可在主页面编辑后**保存名单**。只保存名单，不改其他设置、不扫描或运行。
6. 点击**扫描待入库**确认稳定压缩包并建立 / 对账 Job。新文件要满足稳定窗口；未稳定时等下载结束和稳定时间经过后再检查，不是盲目连续重扫。
7. 点击**运行可处理任务**，处理已保存名单内的可执行 Job；范围不是当前分页或筛选后的行。查看各任务阶段、结果和未完成原因。
8. 完成项可查看图集；异常按其原 Job 处理。媒体问题适用时点击**查看并处理**进行[网页精确审核](local-admission-web.md#异常文件-网页精确审核)，无需手写 JSON。

这里只处理已保存 allowlist，不把整个磁盘或任意压缩包当作通用输入。未保存名单会阻止扫描和批量运行。刷新页面 / 状态查询不等于扫描文件，批量运行也不自动扫描发现新包。

## 暂停与重复保护

“待核查”可能是来源映射、已存在本地作品、活动身份限制或媒体验证问题，不应一律归因于图片格式。先看具体阶段和错误：

- 无可靠或多义映射：保留待核查，不按裸文件名或相似标题猜测。
- 本地已经满足获取需求：不应为了消除待核查而再入库一份。任务执行前也会重新核对当前来源获取限制；已有移动 / 对账检查点仍使用原恢复路径。
- 源包、解压清单或目标变化：保留原现场与历史，不改名掩盖冲突、不直接改 SQL 成功。
- 适用媒体异常：使用原 Job 的逐文件审核，不执行“忽略全部错误”。
- 回执未知或进程中断：核对原任务，再使用其具体继续入口；页面打开和插件重载不自动恢复旧队列。

历史错误任务的专项退役、来源纠正或通用 Work 合并不是普通扫描功能。不能把单次维护脚本当成所有用户的日常核销入口。

## 数据流

```text
<inboxRoot>/<博主>/<预期文件名>.7z
  → 文件稳定性与下载临时文件检查
  → 博主 + 下载任务 + source collection + source work 精确映射
  → SHA-256 幂等检查
  → 外层列表、安全与完整性测试
  → <processingRoot>/<job-id>/level-1
  → 识别唯一内层 .7zz，并仅在处理目录改名为 .7z
  → 内层安全与完整性测试
  → <processingRoot>/<job-id>/level-2
  → 媒体校验与入库预览
  → ready 目录一次原子移动到 <libraryRoot>/<博主>/<作品>
  → 仅复扫当前博主
  → 图库索引、local work、source work、下载差集四方对账
  → 若已启用入库后回收，外层源包和整个 job 工作目录移入 Windows 回收站
```

`staged` 仍只表示百度网盘暂存完成。本地入库由独立的 `LocalIngestJob` 表达，不复用或改变 `staged` 的含义。

## 配置与解压密码

**博主入库 → Costuan → Costuan入库**的“入库设置与环境工具”弹窗可配置和验证：

- `libraryRoot`（只读，严格等于进程启动时的 `GALLERY_ROOT`）
- `inboxRoot`
- `processingRoot`
- `sevenZipPath`（只读，由 `LOCAL_INGEST_SEVEN_ZIP_PATH` 启动配置指定；网页不能更换程序）
- `fileStableSeconds`
- `recycleAfterIngest`
- 固定为 2 的 `maxExtractionDepth`

运行时 allowlist 在 Costuan入库主页面独立管理和保存，不在环境设置弹窗内随其他配置一起覆盖。

解压密码在设置弹窗中只写不读：只显示状态和有效来源，不回传或预填已有密码。留空或保存其他设置保持原值，输入新密码后保存才替换；单独勾选明确清除并保存后停用密码及环境回退。已保存本地配置优先于环境值；尚无本地决定时可使用 `LOCAL_INGEST_ARCHIVE_PASSWORD`。旧专用读取接口已退役；本地密文存入数据库，独立 key 文件位于 `DATA_ROOT/private/local-ingest-archive-password.key`。备份恢复需同时保护数据库和该文件，不打印或提交密钥。详见[解压密码设置](local-ingest-password-settings.md)。

V1 不支持在运行时切换正式图库根目录。管理页会显示：“V1 正式图库根目录由 GALLERY_ROOT 启动配置决定，修改后需要重启服务。”API 也会拒绝与启动配置不一致的 `libraryRoot`，因此 LocalIngest 写入根与 Scanner 扫描根不会分裂。

环境验证会检查三个根目录的存在性、读写权限、剩余空间、是否位于同一卷，以及 7-Zip 是否能够实际执行。三个根目录必须是绝对路径、彼此独立且不互相包含；可解析路径会按 realpath 校验，不能用 junction 或 symlink 绕过边界。正式处理前可运行 Windows 回收站哨兵测试。

## 发现、映射与幂等

正常启动会按既有 lease / 所有权规则恢复中断任务的可继续状态，不自动重新执行任务。是否做待入库补偿扫描由 `LOCAL_INGEST_STARTUP_SCAN` 控制；关闭该开关不等于停用资源目录 Worker，也不免除数据库校验。日常可以在页面明确点击“扫描待入库”。

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

网页提供环境设置与验证、回收站测试、名单独立保存、扫描待入库、运行允许范围内可处理任务、单任务继续及失败清理重试。回收站测试会创建并回收哨兵文件，不是纯读取。

以下是已有本机**维护 CLI**，不是正常网页流程的必需步骤。需使用与运行服务兼容的代码及同一配置，不能把 CLI 默认路径当作已核对的正式数据路径：

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

## 精确审核的维护协议

普通 `run`/批处理继续跳过 `awaiting_review`，不会因为更新版本就自动放行历史任务。适用条件下网页已接通检查、精确文件处置和原 Job 恢复；用户优先使用[网页审核](local-admission-web.md#异常文件-网页精确审核)。以下说明保留给维护人员，接受已经完成两层解压、在媒体验证阶段暂停的原 Job，不新建接纳计划、不直接修改 SQL 状态。

在服务端工作目录使用与运行服务兼容版本编译的 `dist/scripts/local-ingest.js`：

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

路径相对本 Job 的 `level-2`，必须明确到文件，不支持通配符、目录批准或“忽略全部差异”。**这里的底层 CLI**要求移除项已由用户授权、通过其他明确操作移除，本入口本身不删除或回收；**网页审核**则会在确认后先执行获准的精确可恢复移出，再调用原恢复服务，不能把两者能力混写。原包 `7z l -slt` 的路径、Size、CRC 必须能证明缺少的恰是批准项，其余文件逐一验证，额外、缺失、同大小内容变化均拒绝。旧暂停记录没有完整 manifest 时，也必须由原外层 SHA、内层 CRC/SHA 和归档成员补足证据，不能盲目信任当前文件树。

7-Zip 的列表、测试和解压命令统一使用 `-sccUTF-8` 输出控制台文本，子进程读取器按流解码 UTF-8，保留跨输出块的完整字符。此约定只解决 Windows 本地代码页造成的中文成员名乱码，不改变包内名称、解压路径、匹配规则或批准范围，也不增加清单/哈希/解码调用。

可保留类型限于逐文件明确批准的：

- `pixel_limit`：仅 JPEG，默认 Sharp 必须实际报告像素限制。正常 JPEG 或其他解码损坏不能借此绕过；不关闭或提高像素安全上限。
- `attachment`：精确指定的 PDF、TXT、URL，作为附件完整保留，不转换成图片、不打开 URL、不算广告。网页审核中，未被明确批准移出的 TXT/URL 默认按此方式保留；这不改变普通 Stage3 的原有流程，也不放行未知文件类型。

以上沿用 `_未支持格式原件` 和现有索引排除机制，不另建原件库。图片原件计入 `retainedOriginalCount`；附件单列 `retainedAttachmentCount`，不计入可展示图片/视频、媒体字节或未支持图片数量。原有 HEIC/HEIF/TIFF 自动保留和旧手工保留记录兼容，不重新解释旧决定。

人工核对预览后只把该完整计划的 `confirmed` 改为 `true` 再提交。服务重新核对源包、身份映射、路径、解压标记和文件清单；首次接受后把版本 1 的不可变 payload、hash、原失败及确认时间写入原 job 的 `summary_json.reviewRecovery`，无需新增迁移。重试必须使用同一 payload，不允许补写新例外覆盖原确认。

恢复复用原校验、提交、单作品索引及账本对账。审核恢复使用绑定 planId 的副本 staging，保留原解压现场直到提交和校验完成；复制中断后只复用 checksum 完全相符的已完成文件，截断或额外文件仍暂停且不自动覆盖/删除。目标目录存在不等于提交成功，还须匹配本计划的目录身份及完整清单。索引失败保留 `reconciling`，同计划重试不解包、不重复移动、不改其他作品。成功的同计划再次调用为 no-op；后续清理仍使用原 `cleanup`，回收前再次核对目标、源包、解压清单及原件校验和。

相关下载活动 claim、同博主 Stage3 执行、当前 job 活动 claim 和接纳互斥仍阻止恢复。已接受同一计划的进程退出后，可在取得跨进程互斥且原 heartbeat 确已过期时沿用既有 lease 接管，不清除活动所有权。索引后的审核对账只更新原下载任务，不调用整博主缺失规划；最终活动状态核对与更新位于同一 SQLite 写事务，保留暂存、worker、attempt、download 等真实历史。该功能不是解除任意审核失败的通用开关；不支持的文件/状态保持暂停。

## 当前适用边界与历史范围

当前仍是明确来源 / 文件映射的 Costuan 双层归档流程，不是任意归档导入器，不自动下载，也不提供自动跨平台作品去重。普通已解压资源使用独立本地入库模块；网页精确审核与密码配置已在后续迭代加入。

第一版曾明确不包含插件修改、特殊编号批次处理、作品级分级、云端 / NAS / 对象存储。这个初期范围不是对后续版本状态的描述；旧阶段与计时材料见[状态模型](local-ingest-status-model.md)及[早期双博主基线](local-ingest-two-creator-baseline.md)。
