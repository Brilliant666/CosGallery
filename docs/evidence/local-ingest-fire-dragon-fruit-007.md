# 火龙果羊 007 本地入库证据

记录时间：2026-09-02（Asia/Shanghai）
LocalIngestJob：`1`

| 字段 | 结果 |
| --- | --- |
| creator | 火龙果羊（creator ID `192`） |
| source work | `485`，`NO.007`，日系死库水 |
| archive download task | `1068` |
| 源压缩包 | `G:\cos待入库\火龙果羊\007.7z` |
| SHA-256 | `17A57441040E338D3380DEFC8B0EF4EAD37CA97E951B5F03E9AA09E513691E58` |
| 外层格式 | 7z，79,924,226 bytes |
| 第一层原始输出 | `007.7zz` |
| 内层原名 → 工作名 | `007.7zz` → `007.7z`，改名仅发生于 job 处理目录 |
| 最终内容 | 24 图片、0 视频、24 媒体、0 TXT/HTML |
| warning / review / failed | 0 / 0 / 0 |
| 正式目录 | `G:\cos图集\火龙果羊\火龙果羊 NO.007 日系死库水[24P-76M]` |
| local work / local copy | `7676`，关联 canonical work/source work `485` |
| 下载任务最终状态 | `ingested`；不再属于缺失差集 |
| 外层回收 | 成功；源路径不存在 |
| 工作目录回收 | 成功；`G:\cos处理中\1` 不存在 |

外层和内层均经过真实密码完整性测试及解压。最终正式目录只包含 24 个图片文件，没有 TXT、HTML、外层或内层压缩包。

第一次全库复扫运行 `17` 已索引这 24 张图片，但随后被 allowlist 之外既有图库中的无效 GIF 阻断。为避免其他博主的历史异常影响本任务，复扫实现改为 creator-scoped；恢复运行 `20` 状态 `completed`，扫描 158 个媒体，新增/更新/删除均为 0。目标 folder、post item、local work、source work 和下载差集随后全部核对一致。

幂等复验：重复调用 job 后 `attemptCount` 仍为 `1`；再次扫描待入库发现 0 个归档、创建 0 个任务；双博主重复复扫运行 `24` 新增/更新/删除均为 0。
