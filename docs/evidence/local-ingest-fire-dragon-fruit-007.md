# 样例博主A 007 本地入库证据

> 脱敏后的历史验收摘要：博主/作品名、业务 ID、机器路径和文件指纹为匿名标记；数量、行为与验收结论保持。标记不可用于执行命令或定位真实资源，Git 历史未改写。

记录时间：2026-09-02（Asia/Shanghai）
LocalIngestJob：`job-A`

| 字段 | 结果 |
| --- | --- |
| creator | 样例博主A（creator ID `creator-A`） |
| source work | `source-A`，`NO.007`，示例作品A |
| archive download task | `download-A` |
| 源压缩包 | `<INBOX_ROOT>\样例博主A\007.7z` |
| SHA-256 | 原始文件指纹已脱敏；原核验结论保留 |
| 外层格式 | 7z，79,924,226 bytes |
| 第一层原始输出 | `007.7zz` |
| 内层原名 → 工作名 | `007.7zz` → `007.7z`，改名仅发生于 job 处理目录 |
| 最终内容 | 24 图片、0 视频、24 媒体、0 TXT/HTML |
| warning / review / failed | 0 / 0 / 0 |
| 正式目录 | `<GALLERY_ROOT>\样例博主A\样例博主A NO.007 示例作品A[24P-76M]` |
| local work / local copy | `local-A`，关联 canonical work/source work `source-A` |
| 下载任务最终状态 | `ingested`；不再属于缺失差集 |
| 外层回收 | 成功；源路径不存在 |
| 工作目录回收 | 成功；`<PROCESSING_ROOT>\job-A` 不存在 |

外层和内层均经过真实密码完整性测试及解压。最终正式目录只包含 24 个图片文件，没有 TXT、HTML、外层或内层压缩包。

第一次全库复扫运行 `scan-A-initial` 已索引这 24 张图片，但随后被 allowlist 之外既有图库中的无效 GIF 阻断。为避免其他博主的历史异常影响本任务，复扫实现改为 creator-scoped；恢复运行 `scan-A-recovery` 状态 `completed`，扫描 158 个媒体，新增/更新/删除均为 0。目标 folder、post item、local work、source work 和下载差集随后全部核对一致。

幂等复验：重复调用 job 后 `attemptCount` 仍为 `1`；再次扫描待入库发现 0 个归档、创建 0 个任务；双博主重复复扫运行 `scan-A-repeat` 新增/更新/删除均为 0。
