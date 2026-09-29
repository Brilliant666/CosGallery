# 重复图集移除：只读审查

审查日期：2026-09-29。代码基线：`900c1d828c3457124a9a5c7496593ab3781107e6`。

本文件保留修改前的审查结论。PR #50 后续候选已按用户确认实现“单张回收”和“资源目录整独立作品回收”，当前操作契约见 [回收说明](album-media-deletion-design.md)。以下旧入口说明不作为新候选的操作指南。

本阶段只审查已有实现并记录操作边界。未修改产品逻辑，未读取正式数据库或枚举真实媒体，未执行回收、删除、扫描、恢复、部署或服务启停。以下为源码结论，不是对某个真实图集的操作验收，也不判定任何作品已经重复。

## 当前实现的操作（存在范围误导）

管理员从博主页打开目标作品，再点击图集中的任意媒体，进入查看器后点击侧栏红色垃圾桶。确认框默认不勾选 `Also permanently delete original file from disk`；保持不勾选并确认，会将当前 Post 及其全部关联媒体标记为应用回收站内容，原文件留在磁盘。可在 `/trash` 选择对应项目并恢复。

这是现状说明，不是认可该交互。在“博主 → 图集 → 单张媒体详情”的页面层级下，单张详情的垃圾桶操作整套图集不合理。该问题应按作用范围错误修正，不能只翻译确认文案。完整改进方案见 [图集与媒体删除方案](album-media-deletion-design.md)。

操作对象是查看器加载的 Post ID，不是当前选中媒体的 ID。一个 Post 承载的整套图集都会受影响；它不代表遍历物理目录中的所有文件，也不代表删除规范 Work 身份或同一 Work 的所有本地副本。仅凭同名、编号或文件数量相同不能确认重复。

当前成功移除后可能留在“无法加载图集”页面，需要返回博主页查看结果。若移除的是已指定主副本，博主页还会提示主副本不可用；现有操作不会自动改选其他副本。

实现入口：

- `client/src/components/PostViewer.vue`：`canDeleteMedia` 控制删除按钮。
- `client/src/views/PostView.vue`：`openDeleteDialog` 默认关闭永久删除，`handleDelete` 传递 `viewerStore.image.id`。
- `client/src/api/gallery.ts`：`trashImage`、`restoreImage`、`deleteImage` 调用 Post API。
- `server/src/routes/api.ts`：回收、恢复、永久删除均要求 `canDeleteMedia`。
- `server/src/services/gallery-service.ts`：`trashImage`、`restoreImage` 调用索引更新。
- `server/src/db/repositories.ts`：`trashPost`、`restoreTrashedPost` 更新 Post 及其 `post_items` 关联媒体；`listPrimaryCopies` 将被回收的主副本判为不可用。

## 已确认的缺口

### 1. 入口与确认范围不清楚

博主作品卡片和图集页没有直接的“移除此图集”入口，用户必须先进入媒体查看器。`PostView.vue` 的确认框使用硬编码英文和单数 `file`，没有显示图集标题及本次全部媒体范围，容易被理解成只删除正在看的单张图片。

后续应在图集层提供明确入口，确认时展示标题、媒体数量、处置方式和主副本影响。显示范围应来自后端认可的目标，不把当前筛选后可见媒体数冒充实际处置数量。

### 2. 成功后重新读取已回收对象，进入错误页

`PostView.vue` 在成功后发出 `removedWork`，`WorkGalleryView.vue` 随即调用 `loadWork`，目标已不再可读。`WorkGalleryView.test.ts` 的 `retains caption changes and revalidates deleted work instead of re-adopting a stale detail` 用例也明确预期该错误页。

后续应返回所属博主作品列表并显示成功反馈。现有 `folders` store 已使博主读取缓存失效，不能将此问题归为缓存完全未失效。

### 3. 永久删除未覆盖规范作品副本引用

`000019_local_work_identity.sql` 为 `archive_catalog_local_works.post_id` 声明指向 `posts(id)` 的外键，没有级联删除或置空规则。`postRepository.deletePostAndImages` 直接删除 Post，没有处理该副本引用。在外键启用且引用存在时，该路径会被约束阻止；这是源码推导，本轮未执行隔离复现或真实删除。

`permanent-deletion-service.ts` 先将关联原件及派生文件移入内部隔离区，再提交数据库删除；数据库失败时尝试恢复文件，并保留恢复机制。不能据此声称失败请求完全没有文件操作，也不能声称当前实现必然丢失原件。

因此，当前“永久删除”不能作为已完成关联登记的重复图集清理方案。应用回收站只改变展示和媒体回收状态，保留 Work、LocalWork、主副本选择以及来源和入库历史；它不能代替重复身份合并或磁盘空间回收。旧 `DELETE /api/folders/:slug` 已退役为 410，也不是替代路径。

## 下一阶段范围

先明确目标是从图库中隐藏整套图集、可恢复地移走某份本地原件，还是纠正重复 Work 身份。后两者需要针对所选图集核对保留对象、本地副本、主副本、来源和入库历史，再设计处置及恢复规则。此审查不授权自动合并、批量去重或真实数据维护。

后续已明确：单张默认可恢复回收；资源目录的整图集操作对应独立 Work 及全部本地副本，进入作品回收站；永久删除仅在回收站单独确认。实现候选保持身份历史并统一处理故障恢复和关联保护，尚未代表正式运行版本已更新。

## 验证边界

本阶段由前端入口和后端处置两部分只读审查交叉核对，并阅读相关既有测试断言；没有重新运行应用测试或浏览器交互。文档提交仅检查实际 diff 与空白错误。新 PR 保持 Draft；仓库现有 PR CI 可能自动运行，其结果不等同于正式数据验证。
