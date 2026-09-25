# Stage 3 对账恢复、批量结果统计与人工核查反馈 V1

## 本轮边界

本轮只在独立工作树和临时 SQLite/临时目录中修改、构建和测试。没有运行生产扫描、生产 LocalIngest、回收站操作、Costuan/百度网盘任务，也没有修改 `<GALLERY_ROOT>`、`<INBOX_ROOT>`、`<PROCESSING_ROOT>` 或生产数据库业务记录。

生产服务继续使用 `main@a1c3fee034d8518c26cc11ff216f2ab313202464`，进程为 PID `20568`，启动时间为 `2026-09-05 09:13:10 +08:00`。生产数据库为 `C:\CosGallery\data\db\gallery.sqlite`，迁移版本 `000016`，只读 `quick_check=ok`。

## 当前生产事实

本轮只读核对时，生产库中共有 588 条 `LocalIngestJob`：

| 状态 | 阶段 | 数量 |
| --- | --- | ---: |
| `ingested` | `done` | 570 |
| `reconciling` | `reconciling` | 16 |
| `awaiting_review` | `validating` | 2 |

这与用户截图时点一致，但实现和测试没有硬编码这些数量。

当前保存的 Stage 3 allowlist 正好是本次列出的 18 位博主；正式图库、待入库和处理中目录分别为 `<GALLERY_ROOT>`、`<INBOX_ROOT>`、`<PROCESSING_ROOT>`，`recycleAfterIngest=true`。

### 眼酱大魔王w：16 条待对账

| Job | Source Work | Download Task | 压缩包 |
| ---: | ---: | ---: | --- |
| 348 | 1644 | 1735 | 083.7z |
| 349 | 1645 | 1736 | 084.7z |
| 350 | 1646 | 1737 | 085.7z |
| 351 | 1647 | 1738 | 086.7z |
| 352 | 1648 | 1739 | 087.7z |
| 353 | 1649 | 1740 | 088.7z |
| 354 | 1650 | 1741 | 089.7z |
| 355 | 1651 | 1742 | 090.7z |
| 356 | 1652 | 1743 | 091.7z |
| 357 | 1653 | 1744 | 092.7z |
| 358 | 1654 | 1745 | 093.7z |
| 359 | 1655 | 1746 | 094.7z |
| 360 | 1656 | 1747 | 095.7z |
| 361 | 1657 | 1748 | 096.7z |
| 362 | 1658 | 1749 | 097.7z |
| 363 | 1659 | 1750 | 098.7z |

16 条均为 `attemptCount=1`、无当前 claim、正式目标目录存在、Source Work 已有唯一有效 Local Work 关系，且对应 Download Task 已经是 `ingested`。Job 349 的验证结果为 warning（声明 33 张、实测 32 张），其余 15 条为 passed。源压缩包和 processing 现场均仍存在。

当前 16 条 `error_code/error_detail` 已经被本次修复之前的一次生产启动统一覆盖为 `INTERRUPTED_PROCESS`。原业务错误字段无法从当前数据库无损还原，因此本轮没有猜测或反写错误；媒体摘要、目标路径、验证结果和账本关系仍保留，可供获授权后的定向恢复重新确认。

### lunana：2 条人工核查

| Job | Source Work | Download Task | 压缩包 | 阻断证据 |
| ---: | ---: | ---: | --- | --- |
| 489 | 438 | 1027 | 010.7z | `g (1).jfif`～`g (9).jfif` |
| 525 | 474 | 1063 | 046.7z | `(32).jfif`～`(40).jfif` |

两条均为 `awaiting_review / validating / validationStatus=failed / attemptCount=1`，错误为 `UNKNOWN_FILE_TYPE`。源包和 processing 现场存在，正式目标目录不存在，尚无 Local Work 关系，对应 Download Task 保持 `downloaded`。它们不能被批量继续、自动批准、降级校验或统一改回 queued/ingested。

## 根因

### 批量结果丢失

旧 `runBatch()` 固定遍历 queued/failed/reconciling Job，并复用 `runJob()`，但 `runJob()` 在数据库 claim 未取得时只返回当前 Job，没有告知批次“本项未取得执行权”。批次随后无条件将该 Job 加入 `processed`，却只统计 ingested、failed、awaiting_review。因此 16 条仍为 reconciling 或 claim 被占用时，页面只能得到“运行 16，已入库 0，待核查 0，失败 0”。

### 启动恢复覆盖业务错误

旧 `recoverInterruptedJobs()` 把所有没有 claim 的 reconciling Job 也当作中断，并无条件覆盖 `error_code/error_detail`。但“本次执行已结束，留下明确对账错误等待继续”的稳定 reconciling Job 本来就没有 claim，这不是进程中断证据。

## 修复

- 批次结果拆分为 `examined`（已检查）和 `settled`（已有明确终态结果），不再把遍历数量称作完成数量。
- `total` 明确表示服务器固定选中的任务数；六个业务结果桶彼此互斥，`settled=ingested+failed+awaitingReview` 只是辅助汇总，`remaining` 只表示尚未检查。
- 独立统计 `reconciling`、`claimUnavailable` 和 `unchanged`；页面运行中和结束提示均显示这些去向。
- 数据库 claim 失败会返回明确的 `claim_unavailable` 批次结果，不运行压缩、扫描或对账。
- 任务在固定选中后、轮到执行前若已由其他执行者完成，本批将其记为 `unchanged`，不会把外部完成错误计入本批 `ingested`。
- 支持 `creatorIds` 或 `jobIds` 的明确批次范围；两者不能同时提交。
- 显式 ID 在 API 入口执行正整数、非空、上限和去重校验；空集合在服务层仍保持空范围，非法、空或混合范围都不会退化为全量运行。
- 管理页在展开博主后提供“继续该博主待处理”，范围由服务端从完整数据库任务集生成，不受当前 50 条分页影响；仍由既有 operation coordinator 串行执行并互斥。
- `awaiting_review` 不进入任何批量继续范围，管理页直接展示未知文件、processing 路径以及正式目录是否提交的人工核查证据。
- 已有正式目标目录的 reconciling Job 仍只走 `reconcile()`：定向扫描、定向账本对账、Stage 2/缺失差集确认；不会重新解压、重复提交或覆盖目录。
- 对账异常现在会写回该 Job 的明确 reconciling 错误并返回本项结果，不会以未捕获异常丢失批次去向；每次批次只尝试一次，无自动循环重试。
- 启动恢复只把持有过期 claim 的 reconciling Job判定为真正中断；无 claim 的稳定待对账 Job保持不变。已有业务错误使用 `COALESCE` 保留，运行/清理恢复也不再覆盖原错误证据。

## 隔离验证

测试全部使用临时 SQLite 和临时目录，覆盖：

- 首次对账仍未完成时，批次精确报告 `reconciling=1`；再次继续只做对账并成功，不重复解压或提交；
- 精确 16 项已提交任务的批次先得到 15 项入库、1 项仍待对账的完整统计，补足测试关系后只继续该 1 项并最终 16 项全部收尾；
- 跨服务实例执行权被占用时，报告 `claimUnavailable=1` 且 archive command 不启动；
- 60 条同博主任务从完整数据库范围运行，证明不受 50 条页面分页限制；
- 重复 Job 调用只执行一次，Stage 3 operation 重复请求继续返回 409；
- 过期真实 claim 可恢复；无 claim 的稳定对账不被改写；已有业务错误在启动恢复后逐字段保留；
- awaiting-review Job 不进入批次，整行及错误证据不变；
- 已提交目录的第二次恢复保持 `attemptCount=1`、目录内容不变；
- creator-scoped 恢复前后，无关博主的 Creator、Collection、Work、Source Work 和 Download Task 完整行逐字段一致。

聚焦验证结果：服务端 5 个测试文件共 63 passed、2 skipped；客户端管理页 20 passed。最终全量验证结果为服务端 82 个测试文件、467 passed、2 skipped，客户端 53 个测试文件、303 passed。服务端 TypeScript 构建和客户端类型检查/生产构建均通过，`git diff --check` 通过。

## 真实恢复前的明确写入范围（尚未执行）

只有在新代码合并、生产服务切换到该版本并另行获得生产执行授权后，才可对 Job 348～363 发起一次 `creatorIds=[66]` 的继续操作。预期写入仅包括：

1. 当前博主的定向扫描/账本时间与必要索引结果；
2. Job 348～363 的对账摘要、明确状态和完成时间；
3. 对应 Download Task/缺失差集的确认（当前已为 ingested，不得降级或新建任务）；
4. 每项确认 ingested 后，按现有设置将该项源包和 processing 目录移入 Windows 回收站。

不得触碰 lunana Job 489/525，不得执行全图库扫描或全局 metadata planning，不得修改其他 17 位博主业务行，不得启动 Costuan/百度转存、复制或下载。执行前还需重新读取生产事实；任一目标、关系、目录或 claim 发生变化时必须停止并重新评估。

## 后续任务

“规范博主库显式选人 + 零本地作品首次收录”保持为后续任务，真实全链路验收应在本恢复修复合并并完成生产恢复验证后进行。
