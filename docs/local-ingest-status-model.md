# LocalIngestJob 状态模型

`status`、`phase`、`validationStatus` 和 `cleanupStatus` 是四个独立维度。尤其是入库成功与回收成功不能合并为一个状态。

## 主状态

| status | 含义 | 可执行动作 |
| --- | --- | --- |
| `queued` | 已通过连续稳定观察、完成哈希且可处理 | 运行；历史 `waiting_stable` 不可领取 |
| `running` | 正在测试、解压、校验或提交 | 进程中断后按 phase/marker 恢复 |
| `awaiting_review` | 映射、结构、安全或内容需要人工判断 | 保持源文件和工作目录，不自动重试 |
| `reconciling` | 正式目录已提交，但索引或账本尚未全部确认 | 只复扫和对账，不再解压/移动 |
| `ingested` | 正式目录、图库索引、来源关联及差集均已确认 | 仅执行或重试 cleanup |
| `failed` | 可重试的工具、密码、归档或运行故障 | 从安全 checkpoint 继续 |

## 阶段

| phase | checkpoint / 行为 |
| --- | --- |
| `discovered` | 文件稳定且映射完成 |
| `waiting_stable` | 仅兼容旧任务；新文件等待稳定时只写 observation，不创建正式 job |
| `mapping` | 无映射、多映射、目标冲突或来源已本地化 |
| `testing_outer` | 外层列表安全检查与完整性测试 |
| `extracting_outer` | 解压至 `level-1`，完成后写 `.level-1-complete` |
| `detecting_inner` | 识别唯一内层归档 |
| `renaming_inner` | 先保存第一层输出和原/工作名，再仅在工作目录改名 |
| `testing_inner` | 内层列表安全检查与完整性测试 |
| `extracting_inner` | 解压至 `level-2`，完成后写 `.level-2-complete` |
| `validating` | 媒体、安全、结构和声明差异校验 |
| `awaiting_commit` | 完整预览已保存，目标尚未写入 |
| `committing` | `ready` 一次目录移动至正式图库 |
| `rescanning` | 仅扫描当前博主 |
| `reconciling` | 验证索引、local/source work 与差集 |
| `cleanup` | 仅处理回收站清理 |
| `done` | 入库与清理均完成 |

## 校验与清理状态

| validationStatus | 含义 |
| --- | --- |
| `unknown` | 尚未完成内容校验 |
| `passed` | 无阻断项或声明警告 |
| `warning` | 可入库，但声明图片/视频数量与实测不一致 |
| `failed` | 需要人工核查的映射、安全、结构或媒体问题 |

| cleanupStatus | 含义 |
| --- | --- |
| `not_ready` | 尚未确认入库，或配置不自动清理 |
| `pending` | 已入库，等待回收 |
| `recycling` | 回收站操作进行中 |
| `recycled` | 源包和 job 目录的原路径均已消失 |
| `failed` | 回收失败；入库状态保持 `ingested` |

## 恢复规则

服务启动时会按数据库 lease 检查遗留状态，但不会自动执行真实任务：遗留的 `running` 转为可继续的 `failed`；只有仍持有过期 claim 的 `reconciling` 才标记为真正中断，无 claim 的稳定待对账任务保持原状态；`ingested + recycling` 转为可重试的 cleanup failed。恢复会保留已有业务 `error_code/error_detail`、原 phase、processing path、marker 和 attemptCount，只有原本没有错误证据时才补充 `INTERRUPTED_PROCESS`。管理页据此区分业务错误与“上次进程中断，可继续”。

| 中断位置 | 重启后的行为 |
| --- | --- |
| 第一层解压后 | 识别 `.level-1-complete`，验证已有输出，跳过重复外层解压 |
| 内层改名后 | 从已保存摘要恢复 `.7zz` 原名和 `.7z` 工作名 |
| 第二层解压后 | 识别 `.level-2-complete`，验证已有输出，跳过重复内层解压 |
| 正式目录移动后、复扫前 | 发现目标存在，直接进入 `reconciling` |
| 对账完成、回收前 | `ingested + pending/failed` 只调用 cleanup |
| cleanup 部分完成 | 对每个路径先检查是否仍存在，只回收剩余对象 |

失败现场在 V1 中始终留在 `processingRoot/<job-id>`。不自动移动到隔离目录，也不自动回收未确认入库的数据。

明确禁止的迁移：

- `awaiting_review → running` 的自动越权；
- `waiting_stable → running`；
- `reconciling → extracting_*`；
- `ingested → running/reconciling`（清理重试除外）；
- 回收失败后重新提交目标目录。
