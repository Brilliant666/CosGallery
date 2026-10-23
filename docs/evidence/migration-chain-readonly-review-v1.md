# 迁移链只读审查记录 V1

日期：2026-10-23。审查基线：PR50 `5c12e6eb06ef14c7b51e4b28e860ea677be532c7`；本次归档起点为 `dcd3e31ad1757b41531bd8a9d0660d805f440afd`，二者之间只有 `AGENTS.md` 文档差异。以下保留前轮静态审查结论，源码链接固定到审查基线，不代表后续修复后的行号或正式运行状态。

## 四个后续评估候选

| 对象 | 静态证据与当前分类 | 清理前必须完成的核对 |
| --- | --- | --- |
| `creator_rating_sources` | **升级资料，当前需保留。** 日常博主分级已由规范博主的 `effective_rating` 维护，但旧表仍被[升级逻辑](https://github.com/Brilliant666/CosGallery/blob/5c12e6eb06ef14c7b51e4b28e860ea677be532c7/server/src/db/managed-creator-migration.ts#L13-L38)读取，且[启动校验](https://github.com/Brilliant666/CosGallery/blob/5c12e6eb06ef14c7b51e4b28e860ea677be532c7/server/src/db/migration.ts#L605-L680)仍依赖其结构、索引和外键。`completed` 仅以冲突和无效来源元数据为判断条件，`unresolved` 单独记录；完成标记不能证明所有未匹配旧资料都已迁入。 | 先确定支持的升级起点，并逐项确认旧资料保全、未匹配记录和已有人工修改的去向，再讨论退役。不通过清除完成标记或重跑升级来代替核对。 |
| `archive_catalog_works.content_rating` | **业务用途待确认，当前保留。** 未发现它的独立业务用途，但不能据此认定历史值无意义。[字段定义](https://github.com/Brilliant666/CosGallery/blob/5c12e6eb06ef14c7b51e4b28e860ea677be532c7/server/src/db/schema.ts#L296-L307)仍在；删除预览使用 [`SELECT *`](https://github.com/Brilliant666/CosGallery/blob/5c12e6eb06ef14c7b51e4b28e860ea677be532c7/server/src/services/work-removal-service.ts#L247-L251)，提交时对[整行快照进行一致性比较](https://github.com/Brilliant666/CosGallery/blob/5c12e6eb06ef14c7b51e4b28e860ea677be532c7/server/src/services/work-removal-service.ts#L650-L696)，字段形状也可能进入历史快照。 | 先决定作品级分级是否有产品用途，核对历史值，并制定未完成删除操作及旧快照的兼容办法。本轮不删字段、不批量改写快照，也不新增分级功能。 |
| `idx_folder_scan_state_updated_at` | **优先验证的索引候选。** [索引](https://github.com/Brilliant666/CosGallery/blob/5c12e6eb06ef14c7b51e4b28e860ea677be532c7/server/src/db/schema.ts#L558)按更新时间建立；现行[扫描状态查询](https://github.com/Brilliant666/CosGallery/blob/5c12e6eb06ef14c7b51e4b28e860ea677be532c7/server/src/db/repositories.ts#L4440-L4486)按路径读取、排序和删除，未发现按更新时间过滤或排序的业务查询。静态证据支持进一步评估，尚不能替代性能验证。 | 在合理规模的隔离数据集上比较实际查询计划及读写成本，并核对维护入口依赖。即使索引最终可删，也不因此删除 `updated_at` 字段或扫描状态表。 |
| `idx_resource_catalog_state_pending` | **收益未验证，暂保留。** [索引](https://github.com/Brilliant666/CosGallery/blob/5c12e6eb06ef14c7b51e4b28e860ea677be532c7/server/src/db/resource-catalog-schema.ts#L24)为 `(generation,built_generation)`；实际 [pending 查询](https://github.com/Brilliant666/CosGallery/blob/5c12e6eb06ef14c7b51e4b28e860ea677be532c7/server/src/services/resource-catalog-read-model.ts#L17-L26)包含两列不等比较、规则版本、重试时间及关联排序。静态阅读不足以确认该索引收益或可安全删除。 | 用具有合理待处理、已完成、失败比例的隔离数据比较查询计划与耗时，再决定保留、删除或调整。不借此新增 Worker 查询体系。 |

## 保留项与已完成的退役

- 媒体、Post 和成员关系；底层接纳计划与网页批次；来源决定、满足记录；回收恢复、删除审计及当前触发器，继续保留。它们承担不同层次的身份、执行或历史证据，不能按“旧补丁”合并清除。
- [000027](https://github.com/Brilliant666/CosGallery/blob/5c12e6eb06ef14c7b51e4b28e860ea677be532c7/server/db/migrations/000027_remove_redundant_indexes.sql#L1-L11) 已在迁移链中退役八个精确重复索引；当前 schema 未重新引入，[启动校验](https://github.com/Brilliant666/CosGallery/blob/5c12e6eb06ef14c7b51e4b28e860ea677be532c7/server/src/db/migration.ts#L645-L652)改为验证保留的唯一约束／主键。它们不再列为待删除候选。前缀、部分、表达式索引及唯一约束不能仅因列名相似而判重。
- 历史 SQL 中的表重建临时名称不等于正式库仍有残留；迁移 SQL 与内存初始化 schema 的重复定义，也不等于数据库中存在两套业务表。

## 证据边界

本记录归档迁移链和相关代码的静态审查结论，没有实施任何结构清理，也没有执行迁移、升级重跑、触发器治理或索引性能测试。未连接正式数据库核查结构、历史值、额外对象或迁移执行状态；因此不声称正式库没有残留。上述四项是带前置条件的后续候选，不是已获执行授权的清理清单。本次归档没有启动、停止、重启或部署 4141，没有改动正式数据及恢复材料。
