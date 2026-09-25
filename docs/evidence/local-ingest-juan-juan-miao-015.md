# 样例博主C 015 本地入库证据

> 脱敏后的历史验收摘要：博主/作品名、业务 ID、机器路径和文件指纹为匿名标记；数量、行为与验收结论保持。标记不可用于执行命令或定位真实资源，Git 历史未改写。

记录时间：2026-09-02（Asia/Shanghai）

证据来源：既有生产账本与正式图库的只读核对；没有恢复、重新解压、重新执行或重新回收真实文件。

| 字段 | 结果 |
| --- | --- |
| creator | 样例博主C（creator ID `creator-C`） |
| LocalIngestJob | `job-C` |
| source work | `source-C`，`NO.015`，示例作品C |
| archive download task | `download-C` |
| local work | `local-C` |
| 源文件名 | `015.7z` |
| 源归档原始大小 | `571,207,651` bytes |
| SHA-256 | 原始文件指纹已脱敏；原核验结论保留 |
| 外层归档格式 | 7z |
| 第一层输出 | `015.7zz` |
| 内层原名 → 工作名 | `015.7zz` → `015.7z`，改名仅发生于 job 处理目录 |
| 最终内容 | 40 图片、1 视频、41 媒体、0 TXT/HTML 广告、0 未知文件 |
| 正式目录 | `<GALLERY_ROOT>\样例博主C\样例博主C – NO.015 示例作品C[40P1V-544M]` |
| 定向复扫 | run `scan-C`，`completed`；索引 40 图片、1 视频、41 post items |
| source/local 关联 | source work `source-C` 与 local work `local-C` 通过同一 canonical work 关联；local copy 为 `样例博主C – NO.015 示例作品C[40P1V-544M]` |
| 缺失差集 | `missingDifferenceCleared=true`；task `download-C` 已为 `ingested` |
| 源归档清理 | `sourceArchiveRecycled=true`；原路径已不存在 |
| 处理目录清理 | `processingDirectoryRecycled=true`；`<PROCESSING_ROOT>\job-C` 已不存在 |
| 最终状态 | `status=ingested`、`phase=done`、`validationStatus=passed`、`cleanupStatus=recycled` |
| attemptCount | `1` |
| completedAt | `2026-09-02T08:16:22.546Z` |

任务创建于 `2026-09-02T08:15:52.433Z`，清理完成后的最后更新时间为 `2026-09-02T08:16:23.329Z`。任务摘要同时记录了声明大小与实测大小的非阻断差异；媒体数量一致、warning 为空。证据中不包含解压密码、Secret、SQLite、媒体或回收站内容。
