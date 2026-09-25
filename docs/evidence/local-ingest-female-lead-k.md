# 样例博主B 本地入库证据

> 脱敏后的历史验收摘要：博主/作品名、业务 ID、机器路径和文件指纹为匿名标记；数量、行为与验收结论保持。标记不可用于执行命令或定位真实资源，Git 历史未改写。

记录时间：2026-09-02（Asia/Shanghai）

## 首个独立样本：048.7z

| 字段 | 结果 |
| --- | --- |
| LocalIngestJob | `job-B1` |
| creator | 样例博主B（creator ID `creator-B`） |
| source work / task | `source-B1` / `download-B1` |
| Costuan 标题 | `NO.048 示例作品B1` |
| 源压缩包 | `<INBOX_ROOT>\样例博主B\048.7z` |
| SHA-256 | 原始文件指纹已脱敏；原核验结论保留 |
| 外层格式 / 大小 | 7z / 371,120,963 bytes |
| 第一层原始输出 | `048.7zz` |
| 内层原名 → 工作名 | `048.7zz` → `048.7z` |
| 最终内容 | 53 图片、0 视频、0 TXT/HTML、0 warning |
| 正式目录 | `<GALLERY_ROOT>\样例博主B\样例博主B NO.048 示例作品B1 [53P-353M]` |
| local work / local copy | `local-B1` |
| 定向复扫 | run `scan-B1`，`completed`，新增 53 图片 |
| 差集 | 下载任务 `download-B1` 为 `ingested`，缺失已清除 |
| 回收 | 外层源包与 `<PROCESSING_ROOT>\job-B1` 均成功进入回收站 |

## 同目录批量样本：047.7z

| 字段 | 结果 |
| --- | --- |
| LocalIngestJob | `job-B2` |
| source work / task | `source-B2` / `download-B2` |
| Costuan 标题 | `NO.047 示例作品B2` |
| 源压缩包 | `<INBOX_ROOT>\样例博主B\047.7z` |
| SHA-256 | 原始文件指纹已脱敏；原核验结论保留 |
| 外层格式 / 大小 | 7z / 693,462,131 bytes |
| 第一层原始输出 | `047.7zz` |
| 内层原名 → 工作名 | `047.7zz` → `047.7z` |
| 最终内容 | 129 图片、0 视频、0 TXT/HTML、0 warning |
| 正式目录 | `<GALLERY_ROOT>\样例博主B\样例博主B NO.047 示例作品B2[129P-659M]` |
| local work / local copy | `local-B2` |
| 定向复扫 | run `scan-B2`，`completed`，新增 129 图片 |
| 差集 | 下载任务 `download-B2` 为 `ingested`，缺失已清除 |
| 回收 | 外层源包与 `<PROCESSING_ROOT>\job-B2` 均成功进入回收站 |

两项外层和内层都经过真实完整性测试与密码解压；`.7zz` 只在各自 job 工作目录改名。重复执行 job 后两项 `attemptCount` 均保持 `1`，没有新建或覆盖作品目录。
