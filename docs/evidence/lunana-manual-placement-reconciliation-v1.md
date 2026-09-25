# lunana 人工放置作品受控对账 V1

## 任务边界

用户已主动删除两套作品中共 18 个不再保留的 JFIF 文件，并将保留内容手工放入正式图库。本任务不增加 JFIF 支持，不恢复、解码或展示已删除内容，也不移动、合并或重命名 `<GALLERY_ROOT>\lunananya` 与 `<GALLERY_ROOT>\lunana`。

生产写入前的审计和实现验证均在只读磁盘现场与生产 SQLite 的独立副本中完成。隔离验证禁用了回收、压缩工具和正式目录提交，只允许读取真实媒体并写临时数据库及临时派生目录。

## 审计基线

- 代码：`main@207057cedabc6806d9a2a801484e6ceccb3a4031`，工作树干净。
- 数据库：迁移 `000016`，`quick_check=ok`，`foreign_key_check` 无结果。
- 服务：`127.0.0.1:4141` 未监听；无活动 Stage 3 operation 或 Job claim。
- Job：总数 588；586 条 `ingested/done`，Job 489、525 为 `awaiting_review/validating`，`UNKNOWN_FILE_TYPE`，`attemptCount=1`。
- 规范身份：只有一个有效 Creator，ID `166`，规范名 `lunana`；明确别名包含 `lunana` 和 `lunananya`。
- 目录桥接：`lunananya` 为 Local Creator Folder ID `8` / Gallery Folder ID `1`；`lunana` 为 Local Creator Folder ID `1004` / Gallery Folder ID `2290`。两者均明确关联 Creator `166`，不存在第二个重复 Creator。
- `<GALLERY_ROOT>\lunananya`：9 个直接作品目录，257 个文件，2,081,417,636 bytes；数据库已有 9 个有效 Local Work。
- `<GALLERY_ROOT>\lunana`：41 个直接作品目录，1,196 个文件，7,690,753,552 bytes；审计时数据库只有此前的 39 个有效 Local Work，手工放入的 NO.010、NO.046 尚未索引。

## 两条人工放置作品

| Job | Source Work | Download Task | 正式目标 | 来源声明 | 实际保留媒体 | 用户删除证据 |
| ---: | ---: | ---: | --- | --- | --- | --- |
| 489 | 438 | 1027 | `<GALLERY_ROOT>\lunana\lunana NO.010 黑馆晴奈 [37P-268MB]` | 37P / 268MB | 37 JPG / 266,312,793 bytes | `g (1).jfif`～`g (9).jfif` |
| 525 | 474 | 1063 | `<GALLERY_ROOT>\lunana\lunananya NO.046 自拍&杂图 [40P1V-91MB]` | 40P + 1V / 91MB | 31 JPG + 1 MP4 / 81,149,048 bytes | ` (32).jfif`～` (40).jfif`（文件名保留原始前导空格） |

两项目标目录均只含可读取媒体，无压缩包、TXT、HTML、临时文件、其他未知文件或符号链接。任务原源包仍在 `<INBOX_ROOT>\lunana`，processing 目录仍在 `<PROCESSING_ROOT>\489`、`525`，其中只保留历史 marker 与第一层内包；原先的 level-2 内容已因用户移动而为空。

## 最小修复

新增维护入口 `adopt-manual <absolute-plan.json>`，并复用原 Job ID。入口必须同时精确匹配 Job、Creator、Source Work、Download Task、原 Job target path、来源完整标题以及原 `UNKNOWN_FILE_TYPE` 中的 JFIF 清单。任何空范围、路径越界、身份差异、源包 SHA/大小变化、已有冲突关系、残留 JFIF、未知文件、空文件或不可读取媒体都会关闭式停止。

通过后只执行：

1. 重新读取并校验正式目标中的全部现存媒体；
2. 重建实际图片、视频、字节数摘要，并保留来源声明；
3. 记录“用户手工放置”“每套主动删除 9 个 JFIF”“未重放解压”“未执行目标提交”；
4. 运行既有 creator-scoped 扫描、账本对账和缺失任务核销；
5. 唯一索引及 Stage 2 状态确认后，进入既有 Windows 回收站清理流程。

入口不会把 Job 改回 queued 后调用普通解压流程，也不会伪造自动解压或原子提交历史。重复提交同一份精确计划会读取已完成证据并直接返回，不重新扫描、回收或新增关系。

实现同时修正了 `40P1V` 紧邻写法的图片声明解析，使 Job 525 能明确保留“声明 40 张、实际保留 31 张”的差异警告。

## 隔离副本验证

真实目录 + 生产数据库副本的演练结果：

- Job 489、525 均完成媒体核验和 creator-scoped 对账；压缩命令调用数为 0，目标提交数为 0，回收被强制禁用。
- 第一次定向扫描新增 69 个媒体索引与 2 个 Post；第二次定向扫描新增 0，证明已建立关系可安全复用。
- 两条 Source Work 分别唯一关联 Local Work `81363`、`81399`；对应 Download Task 均变为 `ingested`。
- `lunana` 有效 Local Work 为 41，历史 `lunananya` 仍为 9；两条 Folder bridge 均保持 active。
- 全局有效 Local Work 2,323 / 已关联 2,323 / 未关联 0 / 歧义 0。
- 其余 Creator 的 Catalog 完整行哈希、非 lunana 图库拓扑完整行哈希、原 586 条完成 Job 完整行哈希及其余 Job 完整行哈希均逐字节一致。
- 两个正式目标的文件数、字节数、mtime 元数据哈希和文件内容哈希在演练前后完全一致。
- 副本 `quick_check=ok`，`foreign_key_check` 无结果，迁移保持 `000016`。

隔离环境关闭回收后，两 Job 停在 `ingested/cleanup/not_ready` 属预期；生产环境现有 `recycleAfterIngest=true` 时才会调用回收站并进入 `ingested/done/recycled`。

## 目录写入策略审查

当前 Stage 3 的新作品目标仍由 `creator_name`（规范名）拼接，因此 Creator `166` 的默认新写入目录会是 `<GALLERY_ROOT>\lunana`。读取与扫描已经支持 `lunana`、`lunananya` 两个明确桥接目录，且定向扫描不会失活同 Creator 的另一个有效目录。

长期最小修正建议是为 Creator 增加显式的 preferred ingest folder 关系，并要求它必须指向该 Creator 的一个 active Local Creator Folder；未配置或存在多个候选时关闭式请求人工选择。本任务不实现该配置，不擅自把历史目录或新目录设为长期默认，也不开展目录迁移。

## 生产执行门禁

生产执行前重新读取实际状态，创建包含 WAL 内容的一致性 SQLite 备份，并保存两目标、源包、processing、原 586 条 Job、其他 Creator Catalog 与图库拓扑的前置快照。只有 migration、完整性、精确身份、源包校验、目录内容、operation/claim 全部仍与门禁一致时，才顺序接管 Job 489、525。

确认两项对账成功后，只通过现有 Windows 回收站适配器处理对应源包与 processing 目录；不永久删除、不清空回收站、不触碰正式作品目录。任一项失败时立即停止并保留现场。
