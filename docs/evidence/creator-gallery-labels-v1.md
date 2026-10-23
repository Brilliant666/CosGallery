# 图库博主分类实施记录

日期：2026-10-23（UTC+8）

PR：[52](https://github.com/Brilliant666/CosGallery/pull/52)；分支：`codex/creator-taxonomy-readonly-review`

## 实现范围

本记录对应 PR52 从研究进入实现后的变更。用户已确认四个图库博主标签及访问边界；此前的[只读研究](./creator-taxonomy-readonly-review-v1.md)保留为实施前证据。

| 操作 | 当前候选行为 |
| --- | --- |
| 点击导航“图库”文字 | 回到全部，清除标签、分级、搜索、偏好和分页条件，回到列表顶部 |
| 点击独立下拉箭头 | 只显示 Cosplay、写真、自拍、福利姬四项；一次进入一个分类 |
| 分类页 | 展示对应规范博主，可按名称搜索；不显示分级控件或分级徽章，也不保留隐藏分级条件 |
| 全部图库 | 保留 R15/R18 独立筛选；未设置标签的博主继续正常显示 |
| 管理员编辑分类 | 博主卡片提供有边框的“编辑分类”按钮，四项多选，支持清空、取消和保存 |
| 返回浏览 | 博主、作品和 Viewer 返回路径保留分类上下文；主动点击图库则重置 |
| 喜欢／保留 | 仅管理员可以查看和使用；匿名与 viewer 的界面、查询及响应均隔离 |

一位规范博主可出现在多个分类，同一列表按规范身份显示一次。标签不进入 Work、LocalWork、别名或来源身份，不自动推断分级；没有全库自动赋值。

## 数据与接口

- 新增 `000031_creator_gallery_labels.sql`：标签关联表 `archive_catalog_creator_gallery_labels`，以及规范博主的 `gallery_labels_revision`。主键约束防止同一标签重复；允许值固定为 `cosplay/portrait/selfie/fuliji`。新建库 schema 与迁移后结构一致。
- 公开列表使用 `GET /api/cos-gallery/creators?label=cosplay`。标签过滤在分页前执行；只要指定有效标签，服务端会忽略旧 `contentRating` 条件。原来的活动／可见范围继续生效。
- 规范博主响应增加 `galleryLabels`。管理员通过 `GET/PUT /api/admin/archive-catalog/creators/:id/gallery-labels` 读取或保存；写入仍走既有管理权限和 CSRF 机制。
- 保存提交 `galleryLabels` 与 `expectedRevision`。事务内检查版本，过期返回 `409 GALLERY_LABELS_CHANGED`，不覆盖他人保存；弹窗保留草稿并要求重新读取。递增版本覆盖标签改回原值的并发情况。
- 标签加入现有博主删除预览范围、快照、确认令牌与显式删除过程。标签变化后旧删除确认失效；没有改变删除博主的业务前置限制。

## 管理员偏好边界

1. 列表、详情及作品列表内嵌 creator 对象，对非管理员省略 `preference` 字段。
2. 非管理员携带 `preference` 查询参数时，在参数验证及过滤前移除，不能得到站主喜欢或保留的子集及数量。
3. 前端清理当前地址和返回地址中的非管理员偏好条件。身份变化时清理阅读缓存、旧列表及编辑弹窗，并拒绝旧身份下迟到的响应。
4. 分类、站主偏好和既有媒体收藏分别处理；没有新增访客关注功能。

## 本地验证

环境：Windows，受支持的 Node 24.19.0、项目指定 pnpm 10.28.0。全部使用隔离测试数据。

| 证据 | 结果及边界 |
| --- | --- |
| 服务端 9 个专项文件，144 项 | 通过。覆盖标签／版本冲突、匿名与 viewer 读取和写入限制、规范博主去重与分页、删除联动、迁移引导、作品摘要及既有相关路由 |
| 前端相关专项，70 项 | 通过。覆盖图库与 API 参数、四项导航、多选弹窗与冲突、返回路径、身份切换缓存、App 初始化及路由守卫 |
| `build:server`、`build:client` | 通过。客户端保留既有大包体积提示，未作为测试失败 |
| 隔离 Chromium 交互 | 通过。1440×900 与 390×844；四项菜单、分级切换与清理、进入博主后返回、点击图库重置、多选保存、409 后重新读取、匿名与 viewer 旧链接、移动布局 |
| 独立静态审阅 | 发现并修复退出管理员时旧喜欢子集可能残留的问题；审阅范围内无未关闭发现。此项不冒充动态测试 |
| Git diff 格式 | 交付前核对；远端 Verify 结果按最终 PR Head 另行确认 |

服务端专项文件：`creator-gallery-labels.test.ts`、`creator-gallery-label-routes.test.ts`、`library-joint-filter.test.ts`、`managed-creator-deletion.test.ts`、`migration-bootstrap.test.ts`、`manual-creator-alias-migration.test.ts`、`cos-gallery-mode.test.ts`、`managed-creator-routes.test.ts`、`canonical-work-summary.test.ts`。首次完整 CI 发现作品摘要的旧测试仍要求默认公开响应包含偏好；已改为同时检查公开字段省略与管理员读取，保留原聚合及限定查询断言，专项重新通过。

浏览器脚本为 `client/test/creator-gallery-browser.mjs`，使用真实 Vue 页面组件与合成 API；普通应用入口、真实登录和正式后端未纳入本次浏览器检查。脚本在独立临时端口运行，API 请求仅允许合成端点，结束后关闭测试浏览器和 Vite。没有连接 4141/4241。

本地截图及脱敏证据：`.mocks/pr52/browser/evidence.json` 与同目录 `desktop-menu.png`、`desktop-category.png`、`desktop-editor.png`、`mobile-menu.png`、`mobile-category.png`。索引记录 URL、视口、观察时间、模拟角色和实际操作。桌面菜单移开鼠标后仍保持展开，项目文字不裁切；手机分类页无横向溢出。

## 版本与交付边界

应用基线是已合并 PR50 的 main `3e31d560739798b23be47934d9da505e31397a73`；PR52 研究提交 `20ebb08` 之后开始本次实现。最终候选 Head 与 Node 22／24 Verify 结果以 PR 检查及阶段记录为准。既有 Verify 工作流运行完整服务端与迁移测试、完整客户端测试、开发服务边界检查、治理检查和双端构建；本地专项与远端完整检查分别记录。

本阶段完成候选实现及验证，保持 Draft，等待用户验收。没有合并、安装到 4141、启动或停止正式服务，也没有执行正式数据库迁移、修改真实分类或操作媒体。新增 000031 仅在隔离测试库验证；旧运行快照中的 000030 不等于本轮重新核对的运行事实。
