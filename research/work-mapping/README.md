# 多来源作品映射研究 V1

研究基线：`9654ff8ee1040fe8761ed0c0488b1915a5d6ef30`，2026-09-13。
本地研究分支：`codex/multi-source-work-mapping-research-v1`。
脱敏发布分支：`codex/work-mapping-research-publish-v1`，从上述main基线新建，只发布当前研究文件，不携带本地研究分支历史。不合并，不部署，不修改生产 schema。

## 决策摘要

保留 Work / SourceWork / LocalWork / Post / Image 的现有 ID。Work 已经在表结构上平台独立，但创建、身份保留、默认展示和任务规划尚未平台独立。

推荐先增加“明确决定优先”的小型接纳服务，复用定向扫描和媒体索引。不要继续为外平台 NO 增加 Costuan 偏移例外。人工同套是作品层判断，哈希相等是文件层判断，二者不互相替代。

第一版不做通用 Work 合并、不做未知平台采集、不自动猜测来源编号重排。候选留在计划/决定证据中，确认前不调用现有来源导入创建 Work。没有来源的本地作品通过显式接纳创建 Work，不补造 SourceWork、DownloadTask、LocalIngestJob。

本轮提供两层验证：`prototype.test.mjs` 在实际 schema 上验证新关系和事务契约；`media-integration.test.ts` 使用现有媒体服务验证合成资源无来源可浏览。原型不是生产服务实现，也不是完整前端验收。

## 已确认产品规则（用户补充）

1. 一套实际图集是独立作品单位。同一博主的同名、同服装或同主题但内容不同的图集分别保留。
2. 图集名称仅用于展示，不增加 `(creator_id, display_title)` 唯一约束；标签仅分类，不是自动去重依据。
3. 沿用稳定Work ID，不要求用户编平台编号，也不强制给同名标题添加数字后缀。原目录名、内部结构、平台编号分别保留；提取展示名不改目录。
4. 同名不等于重复，异名/异号不等于不同。自动匹配只生成候选；仅可靠既有关联或用户确认同套才复用Work。无需重复获取还须有接受本地版本的依据。
5. 用户确认同套并接受现有版本，不为匹配Costuan重新下载。实际文件、来源声明、人工理由分别记录；接受版本不等于字节一致。
6. 本地029/030为用户确认的同套副本；不扩展成其他来源映射授权，不自动删除其中任何目录。TXT/URL广告授权仍仅限原清单。

第一版优先路径：选择规范博主 → 识别作品目录 → 提取并确认展示名称 → 确认重复候选（也可确认不同/暂不关联）→ 接纳本地作品 → 按需确认来源关联和版本接受，避免重复获取。

来源关联是后置可选步骤，不是本地接纳前提。不要求完整标签系统、多版本管理或AI识别；多个本地副本只是已确认同套的资源关系，不引入版本发布体系。

新增K测试验证最小路径：同博主、同展示名、同主题和数量仍可保留两个稳定Work；原目录不改名、展示名不加后缀；候选生成不写关系；本地接纳后异名异号来源经明确确认复用原Work，接受31P本地版本但保留30P来源声明，不创建下载任务。

补充规则后的专项结果：A–K **11/11通过**。下方原研究记录的10/10为补充前结果；现有媒体集成测试本次未改动，不重复运行。

## 六个核心缺口与代码证据

路径相对仓库根目录，行号以研究基线为准。

| 缺口 | 现有能力与实际位置 | 最小改动 |
|---|---|---|
| 1. Work 被来源驱动创建/命名 | `server/src/db/schema.ts:287` Work 无平台外键；`server/src/services/archive-catalog-service.ts:811-845` 新来源总建 Work，旧来源更新会写 display_title | 显式 `confirmedWorkId` 或“确认新作品”；Work.title_policy 控制规范标题。确认输入必须校验同博主及冲突；不要把标题查重当身份确认 |
| 2. 人工关系缺少持久优先级 | `archive-catalog-service.ts:1084-1093` 保留关系要求 has_active_source 且 Work 未被占用；`:1123-1167` 带NO只查同号；`:1623-1634` upsert覆写关系 | 扫描先加载有效决定；manual/local_only 不依赖活跃来源、不受自动候选的 claimedWorkIds排他限制；自动候选仍保留唯一及标题核验 |
| 3. 来源条目身份与观察编号混用 | `schema.ts:298` 唯一键(collection_id,source_work_id)；`archive-catalog-service.ts:811` 目前source_work_id来自sourceOrder | 既有内部SourceWork.id不变；每次观察记录原编号/标题/声明。无稳定外部ID且重排有歧义时只记录冲突，不迁移关系 |
| 4. 两副本默认展示两套 | `scanner-service.ts:1635-1699` 按目录建Post；`repositories.ts:2496` 按Post计数；LocalWork没有Post关系 | Work主副本指针＋LocalWork/Post桥接；默认列表/数量/封面/媒体汇总一致过滤，旧Post深链仍可访问 |
| 5. 本地存在不等于接受版本 | `archive-download-task-service.ts:269-277` 活跃LocalWork即可免建需求；`:326-355` 按creator修改任务并清claim | 收录接受决定与精确满足记录；需求层过滤已满足项，执行历史保持原样；不调用旧批量收尾 |
| 6. 跨文件与DB接纳无整体幂等计划 | `repositories.ts:1190-1205,2546-2555` 路径upsert可复用；`scanner-service.ts:1654,1741` 媒体写入早于Post拓扑事务 | 计划项稳定key、payload摘要、阶段与预期清单；文件步骤和DB事务分开恢复，不以单次SQL事务声称文件原子 |

重要保护已存在：`archive-catalog-service.ts:515-528` 完整来源核验遇到旧编号/标题/媒体声明变化、缺失或重排会拒绝刷新。应保留并增加可审查观察，不是删除保护。上述标题覆盖是另一个导入更新路径的风险，不能混为所有刷新都会错误覆写。

## 推荐最小模型及迁移

需要迁移，但本轮不执行生产迁移。以下是第一版具体范围；原型采用 `research_` 前缀对应这些窄用途表。

### 复用表，增加字段

1. `archive_catalog_works`：`title_policy TEXT NOT NULL DEFAULT 'source'`（source/manual）；`primary_local_work_id INTEGER NULL REFERENCES archive_catalog_local_works(id)`。Work.id为永久平台身份。主副本必须属于同Work、同博主且可用，由服务事务校验，外键本身不保证这些条件。
2. `archive_catalog_local_works`：`identity_policy TEXT NOT NULL DEFAULT 'auto'`（auto/manual/local_only）；`provenance_json TEXT NULL`，记录真实批次、原名、目录清单/媒体事实证据、未知平台null。复用原work_id；同Work允许多LocalWork。parsed_source_order仅保留旧事实，不作为人工映射身份。

不把现有match_method一律升级为人工决定；旧记录仍auto，只有明确操作才产生manual/local_only证据。

### 五个窄用途结构

| 建议表 | 核心字段及约束 | 必要性 |
|---|---|---|
| `archive_work_mapping_decisions` | id、request_key UNIQUE、kind(candidate/same_work/not_same/local_only/accept_existing)、local_id/source_id/work_id可空FK、actor、reason、evidence_json、created_at、revoked_at/revoked_by | 保留候选、拒绝、接受版本和撤销；未决来源用证据里的collection/外部key，不强建SourceWork |
| `archive_source_work_observations` | id、source_id FK、observation_key UNIQUE、observed_at、snapshot_json、identity_state | 原编号/标题/数量/撤回观察独立保存；迁移只记录已有快照为迁移观察，不编造旧历史 |
| `archive_local_work_posts` | local_id FK、post_id UNIQUE FK，组合PK | 不重建Post/Image；容纳现有/历史拓扑可能涉及多个Post，常规一套一个Post。不能仅凭同名自动回填 |
| `archive_legacy_import_items` | request_key PK、immutable payload/摘要、phase、work_id/local_id、source/target、manifest证据、last_error、updated_at | 仅批次接纳计划与恢复，不是新任务平台；候选阶段不改规范关系 |
| `archive_work_fulfillments` | id、request_key UNIQUE、task_id/source_id/work_id/local_id/decision_id FK、method、satisfied_at、prior_task_json、revoked_at；task_id有效记录部分唯一索引 | 收录满足与下载执行分离；原任务status/staged证据/attempt/download_id不改 |

原型为压缩验证采用简化字段：revoked布尔、单task唯一、fixture证据、原始payload字符串。生产最小实现需补actor/time、撤销记录、有效记录部分唯一约束、行版本CAS、主副本语义校验及正式迁移测试，不能直接把原型DDL当生产迁移运行。

### 迁移兼容

- 新字段默认保持旧行为；旧Work/Post/Image ID不变，不解除任何媒体唯一约束。
- 新表先空。旧人工关系不能凭名字/数量批量猜测迁移；仅对可靠现有关联提出确认回填。
- 第一版保持SourceWork.work_id NOT NULL。未决来源不进入现有导入服务，只留候选计划；已确认复用Work或明确新Work后再登记来源。这适合本次已有171来源的试点。
- 若下一版要求“来源已正式登记但Work身份未决”，才重建SQLite SourceWork表使work_id可空，同时逐一修复所有JOIN、任务规划和API类型。需要保留SourceWork ID/FK并做迁移回归；不在第一版偷做。
- 迁移前一致性备份、外键检查、重复主副本/跨博主检查；部署为独立授权步骤。新增关系数据被采用后不能盲目回退旧扫描器；回退需停止接纳并保留新表，防止旧规则覆盖决定。

## 关系图与五层边界

```text
Creator #35
  └─ Work（内部稳定ID、规范标题、主副本）
       ├─ SourceWork A ── 观察历史（原编号/原标题/声明/撤回）
       ├─ SourceWork B ── 观察历史
       ├─ LocalWork 1 [主] ── Post ── post_items ── Image
       └─ LocalWork 2      ── Post ── post_items ── Image
              ↑
       人工同套/不同/接受版本/撤销决定
              └─ Fulfillment ── 指定DownloadTask（执行历史不变）
```

1. 作品映射索引：Work与来源/本地的持久身份关系。扫描不得覆盖人工决定。
2. 副本位置/主副本：LocalWork.id独立于路径；移动更新原记录，不按新路径建另一Work。
3. 媒体展示：Post/Image/post_items负责图片视频顺序、权限和派生图，不承担作品去重。
4. 文件证据：精确哈希证明字节相同与否；相似标题、数量仅候选。广告清单与媒体指纹分开。
5. 获取需求：接受版本可满足来源条目；不等于发生下载、解压或回收。

保留 `images.relative_path UNIQUE`、`posts.source_path UNIQUE`、`post_items.image_id UNIQUE` 和asset_key约束（schema.ts:30,65,84-90,496）。不同副本各持有自己的Image，不共享同一Image到两个Post。

保留 `/library/:creatorId` 和 `/library/:creatorId/works/:postId`（client/src/router/index.ts:147-153）。默认主副本过滤集中用于 repositories.ts:2326,2350,2471,2496；`:2510`拥有权查询保持旧Post深链可访问，不直接套默认列表过滤。

主副本消失时显示不可用/要求选择替代，不能静默删除或把未接受版本当成已满足。解除主副本选择不等于删除资产。

## 决定、撤销与执行顺序

- 本地NO032对应CostuanNO030：以LocalWork.id和SourceWork.id明确确认，保留原目录名和两种编号事实。
- 029/030：一个Work、两个LocalWork，人工同套理由与哈希不同同时保存。主副本必须另行明确选择，本批未选择；不自动删另一份。
- 没有来源：创建本地规范Work，identity_policy=local_only；以后来源出现时提出候选，不自动覆盖。
- 明确不相同：持久negative决定按具体双方身份保存；新候选流程必须过滤。撤销后回到待判断，不自动合并。
- 关联撤销：记录撤销人/理由及依赖检查，退回候选/未关联；关联决定派生的满足记录一并失效，但不重置下载历史、不自动重下、不移动文件。若已有后续变更则冲突停下。
- 已存在两个Work：第一版拒绝通用合并。将来合并需迁移来源、本地、主副本、决定/满足引用，保存旧ID重定向及逆向映射，检查外部引用和合并后活动；不能只重绑一列再删旧Work。当前测试明确断言冲突。

推荐调用链：只读计划 → 用户集中确认 → 确认事务（同博主、payload、冲突校验）→ 授权文件步骤 → 定向scanner索引事实 → 绑定返回Post与既定Work → 精确满足事务 → 定向验证。

planned → move_intent → files_verified → indexed → mapped → fulfilled。
移动前持久保存源/目标与清单；发生移动后DB提交前中断：源无目标有，仅在目标验证符合预期时续登记；两边都有、两边都无或目标不符均暂停。每阶段幂等key与payload绑定。使用现有Post路径upsert和topology expectedRevision（creator-work-post-topology-service.ts:863-900），不把文件系统与SQLite视为同一事务。

同卷目录移动：核对实际卷/重解析点、目标不存在，目录rename后对照一次必要清单/完整性证据；跨卷：复制到专属临时目标、一次完整校验后提交目标，源删除另受授权及既有清理要求约束。预览不重复哈希21GiB。原型只模拟合成同卷rename中断，不声称已实现跨卷恢复器。

## 精确收录满足，不改写下载历史

接受决定必须具体到SourceWork和可用LocalWork，明确用户接受本地版本及差异。Work相同不自动代表任意未来来源版本均获接受。

精确服务参数是 taskIds + decisionIds + expectedRevision，不是creatorId。事务内重新检查任务来源、Work归属、本地活跃可用、接受决定未撤销及无冲突执行；活动claimed/downloading拒绝。原型对任何残留claim也保守拒绝，不尝试清除。

满足记录method=historical_local，保存原任务快照；原任务仍可为staged，API/规划器展示“历史本地资源已满足”，从待获取集合剔除。不要用当前批量reconcileAlreadyLocalTasks；否则可能核销未确认作品并清claim。所有规划/领取路径必须读取满足叠加层，不能只改显示。

可复用 archive-download-activity.ts:6 的taskId级staged证据能力，但不能用它制造本轮暂存时间。撤销满足只撤销叠加层；是否重新获取由后续明确动作决定。

既有样本快照存在staged任务保留worker字段的情况。这不证明任务正在执行，也不能视为领取字段可随意清理。实际执行前须通过既有任务运行/回执证据区分历史worker归属与活动claim；研究原型遇到这种状态返回blocked，未触碰真实任务。

## 历史本地样本更新后的预览

详见同目录 `SAKURAI-PREVIEW.md`。这是上轮只读盘点的复用，不是本轮重扫/解码/全量哈希。

- 53目录、2837图片、34视频、108其他文件，21.02GiB。
- 用户已确认029/030为同套；此前图片SHA-256集合不同仍保留。形成52个候选作品组，不代表覆盖52条Costuan来源。
- 其余来源映射未获批，029/030也尚未确认任何Costuan映射。
- 用户确认本批TXT/URL为广告。后续清理仅按本批已有相对路径清单（106个顶层附件＋039内2个附件），不打开URL；本轮不清理。其他新增文件必须另核对。
- 029/030的主副本尚未选择，不能由研究原型的首次插入默认值推导真实主副本授权；不删除任一目录。

## 验证与边界

运行（使用Node24，项目根目录）：

```powershell
node --test research/work-mapping/prototype.test.mjs
```

原型直接读取当前schema.ts并在临时SQLite执行研究扩展；不接受外部DB/媒体目录参数。10项A–J契约测试覆盖无来源规范Work与展示关联、重启后映射、双副本主展示、两来源明确复用、negative决定、数量差异接受、两种到达顺序、来源观察、精确任务满足、幂等及合成文件中断。

现有媒体集成验证运行：

```powershell
node --import ./server/node_modules/tsx/dist/loader.mjs --test research/work-mapping/media-integration.test.ts
```

需要已安装的server开发依赖（tsx、sharp等）；本轮只用研究worktree的依赖junction引用已有安装，未安装或更新依赖。测试先设置NODE_ENV=test，断言DATA_ROOT/GALLERY_ROOT/DB_DIR/THUMBNAILS_DIR/PREVIEWS_DIR最终路径全部在新建系统临时目录下，再加载服务；不启动4141、启动扫描或业务队列。

2026-09-13结果：关系契约10/10通过，真实媒体服务集成1/1通过。合成JPG＋嵌套PNG经过现有定向scanner，生成1个Post、2个Image；实际规范作品API返回200、2个媒体项；原图及4个派生文件均能被sharp解码；重扫后Post/Image/post_items/LocalWork ID不变。SourceWork、DownloadTask和LocalIngestJob均0，SQLite integrity_check=ok。

重要区分：集成测试也断言现有scanner的无来源LocalWork.work_id仍为空，揭示其缺口；平台独立Work创建/人工绑定由关系原型验证。两层合起来证明最小方案可实施，未声称新关系服务已经集成进生产scanner。未启动浏览器UI进行人工视觉验收，前端主副本过滤仍是实施项。

合成媒体证据保留于测试输出的系统临时目录，不发布本机具体临时路径。运行原型会创建新的临时SQLite/合成文件目录；不清理用户数据。

限制：原型不实现自动候选评分、真实权限API、通用Work合并、生产迁移、完整恢复器或跨卷复制。SQL展示投影不等于前端浏览器回归；现有媒体服务的合成集成测试单独列出。不将研究测试通过写成真实53目录已接入。

## 后续最小实施顺序（尚未授权实施）

1. 确认模型和迁移边界：决定优先、默认主副本、满足叠加层、未决来源仅候选。
2. 隔离迁移和服务：决定/撤销、显式Work复用、来源标题保护、扫描身份保护；正负决定与现有自动规则回归。
3. 接入主副本查询与精确需求/领取过滤；保留旧路由、staged历史和活动claim。补跨博主/失效副本/CAS并发/撤销迁移测试。
4. 本批计划工具：复用53目录预览，集中确认来源映射、029/030保留方案、广告清单及目标。没有证据的允许本地接纳但不核销。
5. 单独授权生产代码启用，备份并核对任务状态；再按确认范围分阶段移动、定向索引、精确满足，最后验证。任何一步未完成均PARTIAL。

研究完成的READY只表示可以讨论实施，不是生产接纳PASS。

## 发布交接：逐项验证边界

以下11项均来自 `prototype.test.mjs` 的研究Pilot类，读取实际schema后添加研究扩展，**没有一项是已接入正式应用的适配实现**。既有11/11结果复用；本次只改文档，未重新执行测试。

| 项 | 实际调用与证明 | 下一轮仍需接入/验证 |
|---|---|---|
| A | Pilot.local/index/browse；无来源Work与合成Post关系 | 正式接纳入口创建Work，与现有scanner联通 |
| B | Pilot.rescan只更新数量；临时DB关闭重开后不同编号映射保留 | 正式reconcileLocalCreators/upsert人工决定优先；不代表正式扫描已保护关系 |
| C | Pilot.local绑定同Work、SQL主副本投影、不同合成字符串哈希 | 用户选择主副本；正式列表、计数、封面、媒体汇总过滤。只重绑work_id不足以去重展示 |
| D | Pilot.source明确输入Work；need读取接受决定 | 来源导入复用Work；现有规划/领取读取满足记录 |
| E | Pilot.blocked/revoke验证拒绝决定与撤销 | 正式自动候选排除negative；重启、来源刷新和撤销依赖回归。没有完整决策状态机 |
| F | Pilot.decision接受版本；保留31P实测和30P声明 | 正式接受入口、证据记录和满足服务 |
| G | Pilot.source/local显式传已有ID，两种顺序不重复建Work，双既有Work报冲突 | 正式导入/接纳事务校验；通用既有Work合并不支持 |
| H | Pilot.observe保存观察、冲突返回；规范标题不写 | 正式来源刷新title_policy、撤回保护、观察历史；不放宽已有完整性拒绝 |
| I | Pilot.fulfill写精确满足记录；原任务状态/attempt保留，claim拒绝 | 正式task级CAS、活动判定、规划与领取过滤；生产任务未核销 |
| J | Pilot.local/index/fulfill幂等；合成文件rename后核验 | 持久文件阶段恢复器、并发与部分失败；未验证完整文件/DB原子操作 |
| K | Pilot.local独立展示名；同名两Work；可选后置来源接受 | 正式目录识别/展示名提取入口。原型名称为人工提供输入，不是自动提取器 |

另有独立 `media-integration.test.ts`，调用**现有应用服务**：ManagedCreatorService.create/linkFolder → scannerService.scanCosCreators（限定作品）→ ArchiveCatalogService.reconcileLocalCreators → galleryService及现有列表/详情HTTP API。实际生成和解码合成图片及派生图，重扫保持Post/Image/post_items/LocalWork ID，SourceWork/DownloadTask/LocalIngestJob为0。它同时断言无来源LocalWork.work_id为空：证明当前能浏览，不证明新的规范Work映射已接入。该测试1/1为既有结果，本轮未重跑。没有正式浏览器主副本界面验收。

## 两种接入顺序的实施调用链

以下为下一轮拟新增/调整的调用链，不是已经存在的接口。

**本地先存在：** scoped preview → 用户确认独立作品/同套及展示名 → 接纳事务创建或明确复用Work、LocalWork和决定 → 既有scanCosCreators限定workFolderName索引 → LocalWork/Post桥接 → 后来来源候选确认 → 调整archive-catalog-service导入接收confirmedWorkId，复用原Work → 接受此来源的本地版本后记录精确满足。

规范标题通过title_policy=manual保护，来源刷新只更新SourceWork与观察；未确认来源停留候选，不进入“新来源必建Work”的路径。两侧已有不同Work时保守报冲突，不自动合并。

**来源先存在：** 读取现有SourceWork.work_id → 目录预览 → 用户确认映射 → 接纳事务必须使用该work_id，禁止另调用无参新建Work → 定向索引且扫描不覆盖决定 → 选择主展示Post → 接受版本 → 精确满足指定source/task。只有映射仍不足以免除获取，必须有版本接受证据。

## 四种决定的正式接入要求

| 决定 | 意义 | 持久/撤销行为 |
|---|---|---|
| 已确认同套 | 特定对象复用同一Work | 记录对象ID、操作者、理由；重扫不按NO重猜，来源失效不解绑本地 |
| 明确不是同套 | 排除特定双方候选 | 自动候选必须读取拒绝；撤销后只回候选，不自动合并 |
| 暂不关联 | 本地独立接纳，未断言永远不同 | 显式local_only决定阻止自动绑定；后来明确确认才改变 |
| 接受当前本地版本 | 特定来源需求可由该副本满足 | 声明与实测分离；撤销需使派生满足失效，保留真实执行历史，不自动重下 |

原型仅实现部分决定契约，正式决定事务还需actor/time、依赖校验和行版本保护。manual/local_only分支优先于has_active_source及自动claimedWorkIds限制；自动匹配的防重限制仍保留。主展示指向选中的现有Post：同名不同Work保留两卡，同Work的不同副本默认展示选中副本，旧Post链接和媒体ID保持；本批主副本尚未决定。

## 下一轮单一最小实施任务与验收

建议任务：`COSGALLERY_LOCAL_FOLDER_ADMISSION_AND_EXPLICIT_MAPPING_V1`。

范围：一个小型脚本或操作入口，支持选择博主、已解压目录只读预览、展示名确认、独立作品/同套/不同/暂不关联决定、来源映射和接受版本；配套必要隔离迁移与服务适配、限定目录索引、主副本默认展示及精确满足记录。先合成数据验收，再单独取得生产启用与真实目录范围确认。

验收：两种到达顺序不重复建Work；同名不同内容两卡；显式不同编号映射经过真实定向扫描、来源刷新和重启仍保留；无来源可浏览；用户选择主副本后默认一张卡且旧深链可读；只有确认覆盖的非活动task免于领取，staged历史不变；重复计划不增加ID，文件中断可识别；未确认映射/任务完全不变。桜井宁宁仅复用既有本地预览，不把53目录/52组计为52条来源覆盖。

不包含新资源站、全库自动去重、AI/感知哈希前置、复杂拆包/组合包覆盖、物理删除重复文件、完整多副本后台、标签系统、重编号或重建已有媒体ID。
