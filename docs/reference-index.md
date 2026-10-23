# 技术与历史参考索引

日常使用从[页面地图](creator-admission-navigation.md)开始。本页区分当前维护契约和阶段证据；历史文档中的候选、端口、数量、测试结果与“未部署”只描述当时状态，不代表今天的运行现场。

## 当前维护与实现参考

| 文档 | 适用范围 |
| --- | --- |
| [架构](how-it-works.md)、[安全与备份](security.md) | 主业务数据、派生目录、文件与恢复材料 |
| [应用恢复点](application-recovery-points.md) | 一致性数据库、配置/key、保留策略及隔离恢复步骤 |
| [旧文件夹删除退役](legacy-folder-delete-retirement.md) | 旧永久删除入口的 410、调用者与有限隔离复现 |
| [本地接纳 CLI](local-folder-admission.md) | 维护人员的精确计划 / checkpoint 契约；普通用户走网页 |
| [本地版本复用](local-first-source-reuse.md) | 严格对应、版本接受、撤销及活动任务保护 |
| [目录失效与更新](resource-catalog-invalidation.md) | 派生表、触发器、代次及后台发布 |
| [确认排序时间](confirmed-work-sort-time.md) | 固定作品级决定与来源顺序估算，不是发布日期恢复 |
| [解压密码](local-ingest-password-settings.md) | 管理接口、加密保存与独立 key |
| [Costuan Job 状态](local-ingest-status-model.md) | 入库结果与回收结果分开 |
| [删除博主](unused-manual-creator-deletion.md) | 删除资格、引用核验与确认边界 |
| [范围编号](costuan-range-source-diagnostics.md)、[无逐行姓名目录](costuan-unnamed-directory-identity.md) | 特定来源解析契约，不代表任意网站适配 |
| [API](api.md)、[开发](development.md) | 代码入口、脚本与隔离验证 |
| [媒体处理](media-processing.md)、[Foldergram Carousel](carousel-posts.md) | 继承的底层能力；Carousel 限制不是 CosGallery 图集上限 |

## 历史研究与验证

以下保留原事实，不作为当前运行、性能承诺或重新执行真实业务的依据：

- [早期基础链路](cosgallery-basic-pipeline.md)与[双博主基线](local-ingest-two-creator-baseline.md)。
- [路径索引与摘要](gallery-load-performance.md)、[账本读取与启动校验](catalog-read-startup-performance.md)、[图集打开](work-entry-loading-performance.md)。
- [目录读取模型测量](resource-catalog-read-model-performance.md)、[启动锁修复](resource-catalog-startup-lock-fix.md)。
- [目录与排序早期预览](catalog-entry-preview.md)：其中创建时间方案、五项估算 / 两项待核对和折叠式布局是当时迭代记录，不是现行默认规则。
- [PR39 阶段收尾记录](pr39-closeout.md)。
- `docs/evidence/` 下的已有专项记录：阅读其原始基线、日期及隔离 / 真实范围，不把多次重跑数量相加。

本机忽略目录中的报告、数据库、私人媒体清单及凭据不属于公共文档，也不随此索引发布。

## 文档整理对照

| 原问题 | 当前处理 |
| --- | --- |
| README 同时承担上游介绍、部署历史和日常手册 | 重写中文产品入口，细节链接到对应指南 |
| 安装默认克隆 Foldergram、推荐未核实镜像、混用 npm/pnpm | 以 CosGallery 源码与锁定 pnpm 为主，上游部署标明边界 |
| 导航仍把所有阶段放在图库账本 | 更新页面地图和文档站导航，保留旧链接解释 |
| CLI / JSON 主导入库说明 | 网页指南作为主路径，CLI 文档保留维护契约 |
| 来源数量差被当成缺失作品数 | 改为 Work 对应与版本证据，单列资料留存与严格流程 |
| 旧预览和计时写成当前状态 | 增加历史标识，保留原始结果与时间 |
| 架构仅描述 folders/images，恢复建议直接回滚整库 | 补主业务 / 派生层及独立密钥，按具体失败排查 |

## 尚未确认的范围

当前文档以合并代码与已有本机验证为依据；不宣称已重新完成干净机器安装、公网部署、NAS、Docker CosGallery 全链路或所有平台回收验证。既有性能报告不能预测另一台机器的耗时。文档整理不启动服务、采集网站或执行真实入库。
