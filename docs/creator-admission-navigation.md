# 图库账本与博主入库导航

本轮为前端容器、路由和读取生命周期调整。原业务 API、计划/Job、来源规则和数据库结构保持；不要求本地接纳先具有 Costuan 来源。

## 入口

| 入口 | 当前归属 |
| --- | --- |
| `/archive-catalog`、`?workspace=roster` | 图库账本 → 博主库 |
| `/archive-catalog?workspace=resources` | 图库账本 → 资源目录 |
| `/archive-catalog?workspace=source/staging/ingest` | 兼容跳转到博主入库 → Costuan对应阶段 |
| `/creator-admission` | 无明确上下文时默认本地入库 |
| `/creator-admission/local` | 多博主本地入库三步流程 |
| `/creator-admission/local/:creatorId` | 单博主本地入库 |
| `/creator-admission/costuan?workspace=source` | 来源检查 |
| `/creator-admission/costuan?workspace=staging` | 网盘暂存 |
| `/creator-admission/costuan?workspace=ingest` | Costuan入库 |
| `/creator-admission/review` | 保留原kind/planId/itemKey/jobId/creatorId审核上下文 |
| `/local-admission`、`/local-admission/:creatorId`、`/local-review` | 保留原query/hash的兼容跳转 |

导航不执行来源检查、任务规划、扫描、恢复或接纳。所有子路由继承管理员权限。明确的旧链接和已保存批次优先于默认模块。

## 状态与边界

模块选择和本地三步进度分为两层。薄父容器在本标签页保留已访问模块，回切恢复原链接；本地已保存草稿继续使用原有会话恢复，不扩展跨设备存储。未提交目录与人工选择不因切到Costuan而清空。审核页按照任务类型高亮和返回，不把Costuan Job当作本地计划。

Costuan三阶段从账本提取为单一实现，未访问阶段不挂载队列；停用阶段停止不必要前端轮询，后台业务不取消。博主库必要统计与来源资料管理仍保留，不等于启动Costuan执行模块。

本轮首次交付为Draft和4241隔离预览；不自动更新4141、不安装Script候选，不自动Ready或合并。保留PR38本地接纳、范围确认、后续完成及防重入语义。数据库仍000026，无新增迁移。
