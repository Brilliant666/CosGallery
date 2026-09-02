# 双博主本地入库批量验收

记录时间：2026-09-02（Asia/Shanghai）
allowlist：火龙果羊、女主K

## 批量结果

| 博主 | 初始压缩包 | 初始已关联作品 | 新成功 | 最终已关联 / 平台作品 | warning | awaiting_review | failed | 外层已回收 | cleanup failed | 待入库剩余 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 火龙果羊 | 2 | 6 | 2 | 8 / 8 | 0 | 0 | 0 | 2 | 0 | 无 |
| 女主K | 2 | 46 | 2 | 48 / 48 | 0 | 0 | 0 | 2 | 0 | 无 |

成功作品：

- 火龙果羊 `007.7z` → 24 图片，local work `7676`，task `1068`。
- 火龙果羊 `008.7z` → 33 视频，local work `12888`，task `1069`；证明纯视频作品可入库。
- 女主K `047.7z` → 129 图片，local work `11375`，task `1754`。
- 女主K `048.7z` → 53 图片，local work `9638`，task `1755`。

四个 job 最终均为 `status=ingested`、`phase=done`、`validationStatus=passed`、`cleanupStatus=recycled`、`attemptCount=1`。正式目录实测合计 206 图片、33 视频，没有广告文件、未知文件或归档。

## 差集与索引

- 火龙果羊：8 个 active source work 对应 8 个 active local work，非 `ingested` 下载任务为 0。
- 女主K：48 个 active source work 对应 48 个 active local work，非 `ingested` 下载任务为 0。
- 定向扫描运行 `20`、`21`、`22`、`23` 均为 `completed`。
- 双博主重复扫描运行 `24`：4184 个媒体，新增 0、更新 0、删除 0、warning 0。

## 幂等与恢复

- 清理后的 inbox 再扫描：发现 0、创建 0、既有 0；批处理返回空数组。
- 对 job 1–4 再次调用运行入口：全部直接返回已入库结果，尝试次数仍为 1。
- 已回收 job 再次调用清理入口不会重复回收。
- 合成集成测试验证：恢复同一 SHA 源包只命中既有 job；第一层/第二层 marker 恢复；正式移动后只重试对账；入库后回收失败只重试 cleanup；两个 creator 及同名同哈希文件不会串联。

## 回收站与边界

真实处理前，G: 盘程序哨兵通过 Windows 回收站 smoke test。四个外层源包和四个处理目录的原路径均已消失，两个空的博主父目录保留。代码没有永久删除 fallback，未清空回收站。

本批没有触碰 allowlist 外博主、既有作品目录、CostuanArchiveManager、83 套特殊编号、作品级 R15/R18 或跨平台逻辑。
