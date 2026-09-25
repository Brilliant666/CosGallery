# 自有资源目录

资源目录描述 CosGallery 当前已编目的**本地 Work**，不是某位博主在全世界发布过的完整作品列表。它是可重建的只读展示数据，不是第二套手工维护的作品库。

从**图库账本 → 资源目录**进入时，按明确的范围上下文展示：

- 范围优先级是明确 URL、当前选择、当前权限上下文中上次有效选择；没有可恢复选择时默认显示全部博主。只记住最小范围信息，不缓存全部作品。
- 从博主库的博主卡片进入，直接带入对应博主。
- 顶部可搜索博主选择器支持规范名、别名与“全部博主”，无需返回博主库。零作品博主保留身份和 0 结果。
- 已带有有效 `creatorId` 或 `scope=all` 的资源目录链接，按其上下文恢复；同时存在时以 `creatorId` 为准。
- 明确 URL 的无效、不存在或不可访问博主显示错误，不自动扩大到全库；只有失效的历史范围记忆可以清除并恢复默认范围。

打开、搜索、翻页、查看详情和导出，不会扫描磁盘、创建 Work、匹配来源、规划下载或改文件名。

## Work、主副本与额外副本

- **规范博主**：统一的本地身份，可以有已登记别名和多个本地目录。
- **Work**：独立作品身份，链接使用稳定 ID。同名不同 Work 仍是两行。
- **本地副本（LocalWork）**：同一 Work 可以有多个目录副本，在资源目录中仍只占一行。
- **主副本**：提供代表封面、统计与排序依据。已明确主副本暂不可用时，不会自动改用次副本。
- **来源关系**：保留平台标题、编号与映射依据，不代替本地 Work 身份；不同来源编号可能对应同一 Work。

没有显式主副本的历史记录，仅在单一可靠副本等现有规则允许时使用代表项。有歧义则明确展示，不按名称、编号或大小猜测。

## 自有 NO 如何产生

每位博主在自己的完整可编目集合中，先按**生效排序时间从早到晚**编号；时间相同按稳定 Post ID、Work ID 规则确定顺序，再应用页面升降序。

因此：

- 搜索、状态筛选、分页和升降序不重新编号；第二页不从 NO.001 开始。
- 全库视图仍使用各博主自己的 NO，不产生跨博主连续编号。不同博主都可以有 NO.001。
- 补入作品或确认排序时间后，该博主后续 NO 可能顺移；Work ID、路径、原目录名和来源编号不随之修改。
- 编号至少三位，超过 999 不截断。
- 无可靠排序依据的记录显示**未编排**，不随意补当前时间或来源页面更新时间。

生效时间包含已确认的作品级排序决定，图库与资源目录共用。按来源顺序估算的时间标为**估算**，仅为编排依据，不是真实发布日期或拍摄日期；采用值固定保存，不随浏览重新插值。详细机制见[确认排序时间](confirmed-work-sort-time.md)。

## 表格、搜索与详情

全库 / 单博主视图支持作品标题、博主名 / 别名和原目录名搜索，及博主、本地状态、来源关系筛选。全库行中显示博主，不能仅凭 NO 识别作品。

博主搜索框、全部博主入口及当前单博主范围常驻显示，不使用范围下拉菜单或额外查找按钮。“当前博主”独立显示在搜索区域下方、目录统计工具栏上方。输入名称或别名后按回车显示临时候选；空白搜索不展开全部博主。选中后收起候选并清空搜索词，切换到该博主的目录第一页。Esc、点击搜索区域外或焦点离开可收起候选，不改变当前范围；重新聚焦不恢复旧结果，清空搜索词也不自动切回全库。候选默认显示规范名称，仅同名时补充身份编号。下方作品搜索仍独立作用于当前目录范围。

完整目录总数及状态标签仅作只读统计，不作为第二套筛选按钮；计数不随当前页或筛选缩水，另列当前筛选结果数。筛选统一通过作品搜索、本地状态和来源控件设置；“只看异常”保留在本地状态选项中，不另设重复勾选框，它是“待核对/未编排”与“主副本不可用”的并集，与具体本地状态互斥。来源条件和搜索继续采用 AND，同时选择本地状态与来源时显示“同时满足”提示。未关联来源是中性筛选，不自动判为异常。

表格按日显示排序日期，悬停与详情保留完整时间和时区；估算标记仍保留。内容合并显示图片、非零视频与字节数，未知不会当作 0。整行点击或 Enter/空格展开所选 Work 的轻量详情；查看图集、复制和选择文本不触发展开。

可用作品的相对顺序与同口径图库一致，但目录可能还包含不可用或未编排记录，不应强求总行数与默认图库卡片数相同。

展开详情按 Work 读取副本和来源摘要；主副本 / 次副本链接继续使用原图库与 Viewer。列表不逐行请求完整媒体，不需要浏览全套图片来编目。

| 提示 | 含义 |
| --- | --- |
| 未关联来源 | 本地尚无可靠对应，不是“网站没有此作品” |
| 不可用 | 已记录的本地副本当前不可用；不是自动删除或自动换主副本 |
| 未编排 | 缺少可靠生效排序依据，保留记录但不猜 NO |
| 历史身份缺口 | 存在可读取 Post，却没有可靠 Work 关系；读取不会补建作品 |
| 明确删除 / 回收 | 按既有可见性规则处理，不伪装成暂不可用 |

图片数、视频数与媒体字节来自代表副本的有效索引成员，排除次副本、广告、普通附件和保留的未支持原件。来源声明与本地实测分别显示；未知值保持未知，沿用旧索引时不能视为刚完成磁盘检查。

## 持久目录与版本

迁移 `000022` 建立独立派生表和变更触发器。事实变化在同一数据库事务中标记受影响博主；后台目录 Worker 按一致代次生成并一次发布。普通列表、详情、翻页与导出直接读已完成记录，不再每次构建全博主快照或聚合全媒体。

页面区分**已完成、正在更新、尚未初始化、更新失败**。首次编目完成前不能把部分结果称为完整全库；失败时保留上一份完整结果和待更新状态。启动后复用已完成目录并恢复待更新工作，不要求用户每次手工重建。

列表、后续页、详情和导出使用同一版本依据。发现版本变化需刷新，不能拼接两份编号；导出冲突返回 `409 RESOURCE_CATALOG_CHANGED`。已显示旧版本可以保留提示，删除 / 归属保护仍即时生效，旧汇总不代表新的完整事实。

目录 Worker 只读数据库事实并写派生结果，和图库启动扫描、Costuan 待入库补偿扫描不是一回事。实现与覆盖见[失效机制](resource-catalog-invalidation.md)和[读取模型历史测量](resource-catalog-read-model-performance.md)。

## 导出

可复制或导出**完整当前范围**、**当前筛选结果**；“完整”不是当前一页。支持 TXT 和 CSV，全库导出包含博主名称 / ID 及稳定 Work ID，多来源或多副本不重复占作品行。

统一“导出”菜单选择范围后执行复制、TXT 或 CSV；窄屏菜单从目录工具栏左侧展开，不超出可用宽度。刷新和完整统计在“更多”。目录未完成、更新失败及版本冲突仍直接显示，不能在不可导出时只隐藏提示。

- TXT 包含生成时间、范围、编号 / 展示顺序和动态编号说明。
- CSV 保留稳定 ID、数值字节数、原目录名及来源摘要，并提供对应 `.metadata.json`，记录版本、范围、顺序和行数。
- 保存 CSV 时一并保存 metadata。浏览器阻止第二个自动下载时，页面仍提供元信息下载链接。
- 编号与同版本页面一致；数据变化导致冲突时刷新后重新导出，不把新 CSV 覆盖历史文件后声称旧快照已修正。
- 导出不包含绝对管理路径、凭据、提取码或密码；CSV 字段转义并防护公式前缀。

入口和所有目录 API 要求管理权限，目录数据不附加到公开图库或分享响应。

## 实现入口

`ResourceCatalogBuilder` 负责受限范围生成、代表副本与编号；
`ResourceCatalogReadModel` 负责代次捕获和原子发布；
`ResourceCatalogService` 读取已发布行、详情、筛选与导出。

API 前缀为 `/api/admin/archive-catalog/resource-catalog`，提供 `/creators`、`/all`、`/:creatorId`、`/:creatorId/works/:workId` 及相应导出。版本令牌基于轻量版本标识，不是每次重算目录内容哈希。详情不枚举磁盘媒体；派生目录不替代来源领取和接纳时的权威判断。

## 历史验证阅读方式

以下保留 PR30 当时的隔离测量。它描述的是早期按请求生成实现，**不是当前持久读取模型，也不是当前运行环境的性能承诺**。测试数量、端口与当时“不重启生产”均是历史事实。本次文档整理没有重新执行业务或性能测试。

## Original PR30 validation (historical)

The following records describe the original on-demand implementation, not the
current steady-state read model. Current real-scale results are recorded in
`resource-catalog-read-model-performance.md`.

The isolated browser fixture uses over 1,000 local Works for one creator, a second
creator, old matched records without an explicit Post ID, duplicate titles,
multiple copies, an unavailable primary, missing sort evidence, a readable Post
identity gap and a source-only Work. All files and derived images are synthetic.

Actual production-build browser checks cover desktop and 390px layouts, roster
entry and same-SPA return, refresh/new-tab creator identity, page two, NO.1000
search, copy-to-clipboard, downloaded full CSV and filtered TXT, copy details and
existing album navigation. An isolated database change verifies HTTP 409, keeping
the displayed old snapshot until explicit refresh. The original four workspaces
are read-only smoke tested. No browser business action is invoked.

Both primary and secondary copy links were actually opened: synthetic thumbnails
and Viewer previews decoded successfully. Closing Viewer through Back retained
the same background grid DOM and made zero additional work-detail requests.
Desktop and 390px screenshots were inspected; the narrow table scrolls internally
without overflowing the entire page. The isolated host and browsers were closed
after acceptance; production 4141 was not restarted or repointed.

Roster filters/page survive a same-SPA workspace return through its mounted
component. A full browser reload preserves the resource creator via URL; this
change does not add cross-reload persistence to the existing roster filters.

The Node24 full regression run passed 927 server tests (two existing video-tool
conditional skips) and all 458 client tests. Subsequent resource-specific review
fixes are validated again by the final targeted suite and CI. The conditional
video ingest tests are not resource-catalog skips; this feature adds none.

Review explicitly checked uncertain ownership, cross-Work primary references,
unavailable versus deleted copies, legacy Post resolution and original retention
from both admission recovery decisions and completed Stage3 evidence. Uncertain
ownership cannot supply apparently confirmed primary-media totals.

This is not a production throughput benchmark: the synthetic scale proves full
numbering/export beyond 999 and fixed-count scoped database reads, not the cost of
every possible creator's real media membership. Media aggregates remain proportional
to the selected creator's indexed members; there is no permanent result cache.

## Historical PR30 isolated production-build measurements

Measured with Node 24.19.0, a synthetic creator with 1,005 local Works and about
1,008 indexed media members, including 100 legacy copies without explicit Post
IDs. Independent database/gallery/thumbnail/preview paths and port 4481 were used.
One warm-up preceded three measured runs, without the full test suite running in
parallel. These are new-feature measurements, not a before/after production claim.

| Operation | Service median (range), ms | HTTP median (range), ms | HTTP body bytes |
| --- | ---: | ---: | ---: |
| First 50 rows | 67.84 (66.99–67.97) | 77.65 (77.03–80.25) | 22,509 |
| Selected Work detail | 67.22 (66.64–68.36) | 79.61 (79.28–80.10) | 1,071 |
| Complete 1,005-Work CSV | 68.12 (67.26–69.85) | 77.34 (77.05–77.41) | 211,143 |

Service timings include snapshot query, aggregation and serialization preparation;
they are not presented as pure SQL timings. HTTP timings include reading the full
body; byte counts are application-body bytes, not compressed wire transfer sizes.
CSV size can change slightly after the intentional synthetic title-update check.

A fresh browser context reached the actual 50-row resource table in a median
276.09 ms (255.21–278.69 ms), at the fixed desktop viewport with the server already
ready. This is a table-visible milestone, not FCP or all gallery-media completion.
Each entry made one resource-list request and zero resource-detail requests.

Instrumentation observes 10 prepared reads for list, detail and complete export,
both for the 1-Work creator and the 1,005-Work creator. No per-row detail hydration
occurs. EXPLAIN assertions verify the legacy exact path uses the existing unique
`posts.source_path` index and then the Post primary key, without scanning all Posts.
The identity-gap check reads creator-scoped visible Post IDs once and compares
against a reliable linked-ID set rather than repeating a local-copy scan per Post.

The final resource server suite has 12 passing cases, including the ownership and
Stage3 retention review fixes. Server TypeScript, client vue-tsc and both final
production builds pass. The existing Vite large-chunk advisory remains; bundle
splitting is not introduced as part of this feature.
