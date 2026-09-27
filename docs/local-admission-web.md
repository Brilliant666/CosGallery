# 本地入库与精确审核

本指南面向已解压的本地图集。正常流程可全部通过网页完成，不需要 agent、命令行、手写 JSON 或查询内部 ID。后端读取的是**服务所在机器**的目录，不是浏览器上传整套媒体；远程服务器不能直接读取用户电脑上的盘符。

从 **博主入库 → 本地入库**进入多博主工作区，也可从**博主库 → 管理资料 → 本地目录 → 为该博主入库**进入带有规范博主的单博主入口。该快捷入口只导航，不保存目录设置、创建草稿或执行入库。来源资料是可选项，没有 Costuan 来源也能入库。页面总览见[导航指南](creator-admission-navigation.md)，Costuan 已下载压缩包使用[另一条流程](local-ingest-closed-loop.md)。

## 1 选择图集

先完成手工复制、下载和解压，准备如下结构。名称只是示例，不要求改成统一编号：

```text
已解压等待区/
  博主甲/
    图集原目录一/
    图集原目录二/
  博主乙/
    图集原目录三/
```

1. 在常驻的等待区设置中核对路径；配置变更需保存。
2. 点击**重新读取等待区**，勾选博主父目录。规范名或已登记别名可提供身份候选；未匹配或有歧义时手动选择现有规范博主，不会自动建人或启用已停用身份。
3. 勾选本次作品目录，可以一次选择多位博主。每个直接子目录表示一个拟接纳作品，内部文件结构保留。
4. 点击**下一步：检查所选图集**，生成并保存预览。此时只盘点明确范围，没有执行文件移动或入库。

等待区必须与正式图库同卷，并独立于图库、压缩包待入库区和处理区。路径边界、符号链接及 junction 等由服务端检查。页面不提供任意文件管理或任意路径执行能力。

每批最多 100 位博主；同一博主的多个父目录需分开确认，不能在一个批次里默默合并。空父目录和仅含内部保留目录的父目录不列为待选作品，这只是读取过滤，不等于已经清理或全部任务成功。

## 2 检查并确认

未发现已有作品候选、且没有路径或结构问题的目录会预选，但**没有候选不证明从未收录，预选也不是执行批准**。先看“需处理”，再查看“已选入库”；可按博主、组别、状态和标题筛选。逐项边界提示与处理选项在图集行内展示，不必进入处理弹窗。

候选查找以当前规范博主为范围，复用共享标题解析，比较已有 Work 的展示标题及本地副本原目录名，也保留来源标题和目标路径的相关证据；没有来源条目的本地作品同样参与。页面在暂缓时也显示候选及依据，不用先改成“对应已有作品”才能查看。

| 目录分组 | 含义与处理 |
| --- | --- |
| A · 未找到已有作品候选 | 当前标题规则未找到候选；不保证内容查重，可继续用作品选择器核对 |
| B · 已有作品候选，需确认 | 新预览的单个精确标题候选会标明精确依据；历史候选不推定匹配强度，仍需人工选择 |
| C · 相似标题 / 本批候选 / 已有目录关系 | 大小写、标点或版本标记等相似召回、本批相关目录，或路径已有关系；不自动认定同套或副本 |
| D · 多候选 / 路径或结构需核对 | 逐项标明多个候选、目标占用、目录结构或读取失败；不是一种统一的“文件冲突” |

标题版本差异（如 `_RED`、`(RED.Ver)`、`RED SP`、`+Video`、`V2`、内部 `Vol.02`）只能产生人工候选，不能作为可靠身份。外站 NO 不作为 Work 身份。预览只读取文件元数据，不解码媒体或计算内容哈希；同名、相同文件数或大小都不证明内容相同。已有作品候选最多展示50项，超过时明确提示截断，需通过“查找已有作品”缩小范围，不自动批准。

**本批相关目录**只比较当前规范博主、同一等待区父目录下本次选中的作品目录。标题主体或明确系列标记相关时显示目录名及依据，双方都需要核对；不按相同文件数量或总大小单独认定重复，也不会学习新别名。当前不跨父目录或其他批次全面查重。每项最多展示50个本批候选，截断时请缩小导入范围后重新核对。

确认同套且希望保留两份时，先明确其中一项为新作品或已有作品，再将另一项选择为“与本批另一目录同套”；不需再次收录的目录可跳过，不能确定则暂缓。该选择不是删除重复文件，也不会自动拆分合集或合并已有 Work。重新读取会重算本批候选；候选依据变化时重新核对，历史计划保持不变。

| 本次处理 | 作用 |
| --- | --- |
| 接纳为新独立作品 | 为当前目录建立独立 Work，允许同名不同作品；保留原目录名和内部结构 |
| 对应已有作品 | 查找并明确选择同一博主的已有 Work，将本目录作为其副本；可明确选择是否作为主副本 |
| 与本批另一目录同套 | 将本博主本批两个目录归入同一个 Work，两份副本保留；不是合并已有两个 Work |
| 跳过本次导入，保留等待区文件 | 本次不处理，不移动也不删除 |
| 暂缓，保留等待区文件 | 尚未确定身份、目录边界或异常处理，保留以后核对 |

“对应已有作品”可按标题、自有目录 NO 或原目录查找，不需手填 Work ID。仅选择处理类型而未补齐目标的条目仍是“需处理”；完整选择后会立即更新筛选结果。明确选择后保留原 Work 标题；未勾主副本时保留原主副本，不覆盖已存在目标。即使标题相同，用户仍可明确选择“新独立作品”。候选不会自动建立来源关系或满足下载任务。

默认规则是**已入库的同一作品不重复获取**，不再要求另勾一个“接受可用版本”选项。这是获取偏好，不表示文件完整、与所有来源逐字节一致或全部可解码。后补来源仍需可靠身份对应及当前本地有效性判断；已有明确来源的满足范围按具体勾选项处理，批次出处不会自动满足下载。详见[本地优先与来源复用](local-first-source-reuse.md)。

### 文件修改后怎么办

| 操作 | 读取什么 / 产生什么 |
| --- | --- |
| **重新读取并核对** | 重新读取本批已选博主父目录并盘点范围，保存关联的新预览；适用于内部文件变化，以及把合集拆分、重命名为多个直接作品目录 |
| 步骤条 **1 选择图集** | 修改博主、父目录或所选范围；点击下一步才按修改后的范围重新检查 |
| **读取已保存状态**（批次详情） | 只读取服务器已保存状态，不盘点文件、不批准新范围 |
| **更新进度**（入库结果） | 读取后台执行进度，不重新检查磁盘、不继续任务 |

重新读取会显示新增、移出或变化的目录；“移出”是从新预览范围移出，不是删除文件。此前未选择的其他作品不会因此被全部纳入。新增目录不能继承旧合集的身份和广告批准；旧草稿缺少范围证据时需先确认发现范围。系统待确认与人工暂缓分开，人工跳过、暂缓和取消广告选择不会被自动覆盖。

旧草稿保留当时的候选，不会被新规则偷偷改写；缺少匹配依据时显示历史候选提示。需要使用新召回规则时点击**重新读取并核对**生成新草稿。未变化的人工选择按原证据保留；新增候选或身份依据变化时重新核对，不把旧的人工对应改成自动新作品。已确认计划、历史结果和来源关系不因分类更新而变化。

复杂合集需要先由用户在等待区确认作品边界并整理。例如一个“全年合集”拆为数个独立作品目录，再重新读取并核对。页面不会自动判断拍摄主题、拆分合集或合并两个已有 Work。已提交或已移动的目录不能以修改草稿方式掩盖原检查点，须按原计划处理。

### 广告与最终确认

点击**广告附件**查看本批的具体候选。首次选择接纳时，列出的 TXT、URL 及已识别图片广告候选默认勾选，可以逐项、同名或整批取消；TXT/URL 的候选身份本身不证明内容一定是广告。人工取消选择会保留。

精确文件名规则包含 `492.jpg` 与 `009-01.jpg`，不扩展为相近编号或任意 JPG。默认选择仅作用于本批明确目录，不是全库文件清理。最终仍需另外批准列出的具体广告文件。

点击**确认入库…**核对所有博主、作品对应、目标目录、副本和广告处置，再确认文件已停止写入并执行。新网页确认的广告在索引完成后送入 Windows 回收站；旧计划继续使用原先记录的处置方式，不能因更新 UI 偷改历史批准。回收失败会保留检查点并报告，不能视为已完成清理。

未选广告保留；目标占用不覆盖；跳过和暂缓不删除。最终确认不是仅下载 scope 或保存 JSON，而是提交后端真实接纳任务。

## 3 入库结果与后续处理

已确认批次由后台按博主串行处理，进度来自实际文件、索引和身份检查点。关闭或切换页面不会主动取消任务。服务中断可能留下未完成状态，**重新打开页面不会自动重跑队列**。

- **入库记录**：打开历史弹窗，重新查看批次、草稿、结果及中断记录。
- **查看图集**：在完成项上打开图库和 Viewer。通常从本标签页返回本地入库可恢复最近批次，也可使用带批次参数的链接。
- **后续核对**：将尚未执行且仍符合条件的暂缓范围放入关联新草稿；已移动项按原检查点恢复，不能重新当新目录导入。
- **查看并处理 / 原计划继续**：仅在相应状态可用，使用原计划和明确范围，不重跑已完成作品。
- **清理本批空目录**：明确回收本批已核验为空且无活动任务的父目录；非空和仍有保留附件的目录不清理。正常新入库的空父目录收尾与图集结果分别记录，清理失败不表示作品未入库。

旧批次的失败、暂缓、尝试和确认时间保留。若精确目录、目标、完成记录及 Work/LocalWork 关系证明后来已完成，页面另示**后续已完成**并链接后续结果 / 图集，不再次计入当前待入库或允许普通重跑。没有可靠依据则显示尚未明确；旧大容器不能据此解释为“还缺一套”。

服务器持久保存提交、回执和执行结果。未提交选择仅在当前浏览器标签页的会话范围恢复，不承诺跨设备永久保存；回执不明确时使用**原请求重试**，不要新建同范围批次来替代它。

## 异常文件：网页精确审核

本地接纳结果与 Costuan 原 Job 的适用异常可打开同一**查看并处理**页面，但各自保留原任务类型。入口会先检查是否满足审核条件，并非任意失败均可放行。

1. **生成本项审核预览**：读取当前项证据并保存审核会话，可能核验原包和媒体，不扫描全库，也不先移动文件。
2. 查看相对文件名、问题和可用处置，逐文件选择。
3. **查看文件处置确认**，明确批准后**确认处置并后台继续**。
4. 查看真实文件处置与恢复结果；失败后仅重试这个原处置与原计划。

| 文件情况 | 当前能力 |
| --- | --- |
| JPEG 确实触发既有像素上限 | 可明确保留为未支持原件，不降低解码上限、不计作普通展示图片 |
| PDF 及审核允许的 TXT / URL | 可按附件保留，不转换成图片；URL 不会被打开 |
| 正常可解码 WebP | 作为正常媒体，不需逐个批准 |
| 明确广告 / 损坏文件 | 审核允许时逐文件可恢复移出，先记持久化意图、核对实际处置，再恢复原任务 |
| 未支持类型、证据变化、身份或活动任务冲突 | 保持暂停，不提供“忽略全部错误” |

审核中的**可恢复移出**与新入库广告送回收站不是同一操作。保留原件不等于已经解码；记录决定也不等于实际文件处置已经完成。查看最终文件动作与索引结果，不能只看接口回执。

## 维护边界

普通入库和符合条件的精确审核无需命令行。历史广告专项回收、部分事后身份关系维护等仍使用[本地接纳维护 CLI](local-folder-admission.md)，不是本页面一键清理能力。来源资料中的后补批次 / 精确条目对应目前仍需填写稳定 ID，见[来源资料说明](source-evidence-local-admission.md)。

服务复用原接纳、作品身份、本地满足及扫描引擎；活动 claim、目录占用、manifest 与身份检查仍由后端执行。网页 orchestration 表保存草稿、不可变确认、幂等回执、审核文件动作；不是第二套作品身份系统。

## 历史实现与验证记录（PR38 阶段）

Focused tests cover original-engine execution, immutable replay, identity/main-copy
choices, exact source acceptance with staged history, changes/claims, auth/CSRF,
path confinement, review failure and migration compatibility. Browser acceptance uses
independent synthetic media, real nested Chinese 7z archives and a 2,100-image album
through the production entry on 4241. The local ignored report records actual completed
cases and timings; preparing fixtures alone is not a passed browser test.

The real production-entry fixture exposed a Windows/libvips handle issue that the
existing test-wide `sharp.cache(false)` masked: path-based WebP metadata could leave
the file open, allowing a hardlink but blocking source unlink with `EBUSY`. Local
admission/review metadata now uses a Buffer input on Windows; other platforms keep
the file input. Global Sharp cache settings, pixel limits and one metadata-validation
call remain unchanged. This adds a full file read and temporary input-buffer memory
on Windows at the existing bounded/sequential validation point, not another hash or
decode pass. A separate Node process test retains default caching and exercises actual
Chinese-path JPEG/WebP link/unlink plus the unchanged pixel-limit rejection.

A separate two-connection regression test reproduces SQLite's deferred read-to-write
upgrade conflict during `ManagedCreatorService.linkFolder` while a real catalog
publication holds the writer. Top-level folder linking now reserves the writer with
`BEGIN IMMEDIATE` before reading ownership. Caller-owned transactions retain their
SAVEPOINT/rollback contract. This does not change journal mode, global timeouts or
the catalog worker, and is not a blanket promise that every SQLite contention is
resolved. Historical failures without a statement-level trace are not retrospectively
claimed to have this sole cause.

`WorkIdentityService.registerLocal` now follows the same top-level writer reservation
rule before its first identity/idempotency read. A separate real catalog-publisher
connection regression reproduces the old conflict despite `busy_timeout`, then checks
successful waiting, stable identities and rollback. Nested caller transactions retain
their original semantics; they are not silently replaced or automatically retried.
Advertisement-result transactions also reserve the top-level writer before reading.
No filesystem operation is wrapped in a blanket SQLite retry. The historical paused
batch's error is retained; its exact former lock-owning connection was not observed.

该阶段运行交接要求配套前端、后端和 CLI，并保留当前备份；隔离数据没有复制到正式数据区，已完成真实任务不重放。PR38 当时先试用再收尾，Script PR13 的合并与安装另行处理。这是历史交接边界，不表示当前仍待批准合并。



> 上述为历史实现与验证经过，测试计数、端口和当时的候选部署限制不代表当前运行现场或本次文档任务的新验收。当前正常操作以本页前半部分为准；PR38 / PR39 已合并，插件后续状态见[来源资料说明](source-evidence-local-admission.md)。
