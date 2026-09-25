> Historical milestone record. Current roster authority is CosGallery DB; HentaiClub JSON import has been retired. Use the 博主库 section of `/archive-catalog` for new creators and manual classification. The historical sequence below is retained as evidence, not current import instructions.

# CosGallery 基础全链路

## 当前阶段结论

截至 2026-09-02，链路已经从百度网盘 `staged` 延伸到本地图库 `ingested`：本地入库模块能够识别下载完成的 Costuan 双层归档，精确映射账本，完成安全双层解压、媒体校验、原子写入、creator-scoped 复扫、来源对账和 Windows 回收站清理。

真实验收使用火龙果羊和女主K两个 allowlist 目录，4 个归档全部完成：206 张图片、33 个视频，0 个 warning/review/failed。详情见 [本地入库闭环](./local-ingest-closed-loop.md) 与 [双博主证据](./evidence/local-ingest-two-creator-batch.md)。

## 数据流

```text
HentaiClub 人工筛选 JSON
  └─ 喜欢 / 保留博主 ID、R15 / R18 初始信息
       ↓
CostuanArchiveManager
  └─ 匹配持续更新合集、采集 works[]、记录百度交付目录
       ↓
CosGallery 图库账本
  └─ 与只读 <GALLERY_ROOT> 按博主和 Costuan 序号核对
       ↓
缺失作品任务
  └─ 生成“Costuan 平台已知但本地未收录”的图集
       ↓
CostuanArchiveManager 自动暂存
  └─ 我的网盘/cos待入库/<博主 ID>/<序号>.7z
       ↓
人工或外部工具下载到 <INBOX_ROOT>\<博主 ID>
       ↓
CosGallery LocalIngestJob
  └─ 稳定检查、精确映射、安全双层解压、媒体预览
       ↓
<GALLERY_ROOT>\<博主 ID>\<作品>
  └─ 定向复扫、账本关联、差集清除、回收站清理
```

## 已稳定能力

1. HentaiClub JSON 作为首批人工审美筛选结果导入；它是初始来源，不是永久唯一来源。
2. Costuan 是第一个资源平台；博主、合集、作品和交付方式分别记录，百度网盘不被误当成作品来源。
3. 本地作品优先按 Costuan 稳定序号关联；无法确定的目录保持待核查，不猜测匹配。
4. 缺失任务可重复生成而不重复建单；本地已有部分作品时只生成增量任务，本地没有博主目录时生成整位缺失任务。
5. 扩展可按博主批量暂存；长目录使用虚拟滚动仍可逐屏核验，只有目标目录实际存在整批文件才写入 `staged`。
6. 本地入库只扫描 allowlist，按 creator、collection、source work、下载任务文件名和 SHA-256 建立独立 job。
7. Costuan 的 `.7zz → .7z` 只发生在 job 工作目录；两层都做安全列表检查、完整性测试和密码解压。
8. JPG/JPEG/PNG/GIF 与 MP4/MOV/MKV 保持原名和内部目录；TXT/HTML 不进入正式图库，未知或危险内容阻止提交。
9. 完整作品用一次目录移动提交；提交后只扫描当前博主，并验证图库索引、local/source work 和下载差集。
10. 确认入库后，源包和 job 目录只通过 Windows 回收站清理；清理失败不重跑入库。

## 状态含义

| 状态 | 含义 |
| --- | --- |
| `pending` | 已生成下载任务，尚未被扩展领取 |
| `claimed` | 扩展正在处理下载任务 |
| `staged` | 已核验存在于百度网盘待入库目录 |
| `downloading` | 下载过程的可选过渡状态 |
| `downloaded` | 已下载到本地待入库，但尚未完成图库入库 |
| `ingested` | 已解压、校验、索引、关联并清除缺失差集 |
| `failed` | 当前阶段失败；保留错误和安全恢复入口 |

本地解压和清理由独立 LocalIngestJob 状态机表达，详见 [状态模型](./local-ingest-status-model.md)。

## 当前人工边界

百度网盘只是当前 Costuan 的一种交付方式。链路仍由人工或现有下载工具把博主目录下载到 `<INBOX_ROOT>`；从本地文件稳定开始，后续入库由 CosGallery 接管。

仍需人工处理：

1. 从百度网盘或其他交付方式取得归档。
2. 对 `awaiting_review` 的无映射、多内层、未知文件或目标冲突作判断。
3. 重新采集 Costuan 后续更新，生成新的增量任务。

不能仅凭 `staged` 认定本地收录完成；必须以 LocalIngestJob 的 `ingested`、图库索引、来源关联和差集核对为准。

## 后续阶段入口

本地入库基础闭环完成后可独立研究：

1. 文件系统变化监听，但补偿扫描继续作为事实来源。
2. `awaiting_review` 的人工决策和重新映射界面。
3. 新平台作品发现与跨平台候选去重。
4. 下载器集成；不得把百度网盘固化为作品来源。

所有删除和覆盖操作都必须使用回收站或保留可恢复副本。
