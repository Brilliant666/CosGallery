# PR52 文档核对与更新

日期：2026-10-24。实现核对基线：`6dcd5faa78920f679a97bd5657fcbee994ebb724`。本轮远端确认 PR52 已于当日 19:02（UTC+8）合并为 `4c5653194719eb645e305e243645f1762a0dab23`；两者 Git tree 同为 `557da00eb59ff27b6971def08be3be3699b3e054`。旧交接中的 Open / Draft 已是历史状态，文档更新基于合并后的 main，使用后续分支 `codex/documentation-refresh-pr52`。本文是文档核对记录，不是新一轮部署或运行验收。

## 发现与更新范围

| 旧说明或缺口 | 按当前代码更新 | 主要核对入口 |
| --- | --- | --- |
| README 与页面地图偏向账本 / 入库，图库仍统一描述分级与个人偏好 | 补浏览入口、四个多选博主标签、全部图库分级、管理员偏好和分类编辑边界 | `CosGalleryHomeView.vue`、`creator-gallery-labels.ts`、`router/index.ts` |
| 未说明首页三模式、图库统计、最新侧栏控制与强调色 | 区分全站配置与浏览器偏好；不再把最近浏览当作现行侧栏内容 | `HomeView.vue`、`GalleryStatistics.vue`、`SettingsView.vue`、`sidebar-preferences.ts` |
| 媒体参考仍称混合图集视频不进短片，图集总是先播预览 | 短片含图集视频；图集视频原件优先，照片仍用缓存；区分分享页播放器 | `PostViewer.vue`、`VideoMediaPlayer.vue`、`useVideoPlayback.ts` |
| 删除指南仍写候选，旧退役记录可能被误读为没有整 Work / 全局博主删除 | 保留历史，明确单媒体回收、整 Work 全副本回收、受控永久删除及删除博主限制 | `work-removal-service.ts`、`managed-creator-deletion.ts`、`media-trash-routes.ts` |
| 开发说明称无 engines、CI 仅 Node 22、Vite 默认全接口监听，安装停留在旧迁移编号 | 与版本声明、Node 22/24 CI、回环开发边界和现行部署门槛对齐 | 根 `package.json`、`.node-version`、Verify、Vite 配置、运行治理指南 |
| API 来源校验参考与后续 Host / Origin 规则不一致 | 修正生产同源、明确可信来源和 Referer 双校验，补标签及作品回收路由索引 | `csrf-protection.ts`、`request-host.ts`、`app.ts`、`api.ts` |
| 排错和身份说明未区分最新读取恢复与保留原件规则 | 补列表重试、收藏部分成功、异常继续边界与 `_未支持格式原件` | 当前客户端及入库 / 审核服务；原计划不重跑规则保持 |

## 验证与边界

文档采用定向源码核对及独立复核，不重新执行旧专项测试。使用既有依赖构建 VitePress，检查内部文件链接、章节锚点和 Markdown diff；具体结果由本轮提交及 PR Checks 记录，不把应用完整 CI 与文档构建混称为同一验证。

应用代码、迁移、锁文件、数据库、媒体、博主标签和用户配置均不属于本轮修改。没有读取正式数据库、调用真实任务、构建应用、启动 / 重启服务或部署。文档 Head 变化不代表运行版本变化；既有服务的最后部署快照仍须按原记录看待。

历史报告保留原版本、原日期和原验证范围；不把过去的合成性能数据改写为当前整库收益。公网生产发布、Cloudflare R2 派生图上传、原作 / 角色 / 主题发现仍不是已交付能力；没有新增干净机器或跨平台验收声明。
