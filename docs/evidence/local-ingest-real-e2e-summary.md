# LocalIngest 真实 E2E 聚合证据

记录时间：2026-09-02（Asia/Shanghai）

本次合并前硬化仅只读复核既有账本与正式目标，没有重新执行任何真实任务。

| 博主 | 归档 | job | source work / task | local work | 图片 | 视频 | scan run | 最终状态 |
| --- | --- | ---: | --- | ---: | ---: | ---: | ---: | --- |
| 火龙果羊 | `007.7z` | 1 | 485 / 1068 | 7676 | 24 | 0 | 20（恢复对账） | ingested / done / passed / recycled |
| 火龙果羊 | `008.7z` | 2 | 486 / 1069 | 12888 | 0 | 33 | 23 | ingested / done / passed / recycled |
| 女主K | `047.7z` | 3 | 1348 / 1754 | 11375 | 129 | 0 | 22 | ingested / done / passed / recycled |
| 女主K | `048.7z` | 4 | 1349 / 1755 | 9638 | 53 | 0 | 21 | ingested / done / passed / recycled |
| 倦倦喵 | `015.7z` | 5 | 912 / 1014 | 14689 | 40 | 1 | 25 | ingested / done / passed / recycled |
| **合计** | **5 个真实压缩包 / 3 位博主** |  |  |  | **246** | **34** |  | **5 个均已入库并回收** |

这五项覆盖纯图片、纯视频、图片与视频混合三种真实作品。五个任务的 `attemptCount` 均为 `1`，source/local 已关联，下载任务均为 `ingested`，缺失差集均已清除，正式目标目录均存在，源归档与 job 处理目录的原路径均已消失。

本次硬化没有恢复五个已回收归档、没有重新解压或运行任务、没有增加 attemptCount，也没有修改正式媒体。
