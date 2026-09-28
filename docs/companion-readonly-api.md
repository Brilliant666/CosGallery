# Companion 最小只读接口（v1）

本契约供独立 **CosGallery Companion** 浏览辅助插件使用，不是 CostuanArchiveManager 改名，也不是采集 bridge 的另一组权限。部署版本以实际构建信息与`/connection`能力为准，文档出现不等于旧实例已支持新增接口。

插件在 `costuan.com` / `www.costuan.com`、`ecytt02.com`、`sndiary02.com` 页面提取有限身份线索；服务端不访问这些网站、不代理任意 URL、不登记来源、不增别名、不触发下载或入库。

可先使用[完整合成响应样例](/examples/companion-v1.json)开发插件。样例中的实例、人物、数量和授权均非真实数据，也不含可用连接密钥。合成测试见 `server/test/companion-*.test.ts`。

## 连接与撤销

1. 在图库已有管理流程中进入 **设置 → 安全与访问 → Companion 只读连接**。沿用现有管理员能力与CSRF，不新增登录方式或强制密码设置。
2. 填入独立 Companion 扩展的32位 ID（也接受完整 `chrome-extension://ID`），连接名称和有效期；选择所需只读权限。
3. 创建后只显示一次密钥；复制到插件自己的连接设置。刷新/离开页面后不能重新读取。不要填管理员密码、会话 Cookie 或 Costuan 的采集密钥。
4. 在同一页面撤销。撤销和到期立即令该grant的所有读取失效，不需要重启服务。

管理API（普通管理员会话、`canAccessSettings`、原CSRF intent）：

| 方法 | 路径 | 请求/结果 |
| --- | --- | --- |
| GET | `/api/admin/companion/grants` | 实例ID/label、授权元数据列表；从不返回秘密或hash |
| POST | 同上 | `{label,extensionOrigin,scopes,expiresInDays}` →201 `{instanceId,label,grant,token}`；仅这次返回token |
| DELETE | `/api/admin/companion/grants/:id` | 明确撤销，成功`{ok:true}`，重复撤销同一已撤销记录仍成功 |

`identity:read`必需；`summary:read`、`library:link`、`catalog:link`分别可选。有效期1～90天，默认30天；最多16个有效grant，保留有限过期/撤销元数据。身份专用授权不会读取统计或把统计变化编码进身份查询版本。

密钥使用256-bit随机秘密，数据库只保存SHA256。授权存在现有`app_settings`的独立键中，无新增迁移或私有密钥文件。实例ID首次**创建授权**时初始化，读取不会偷偷写设置。label固定为非敏感`CosGallery`，不包含机器名或路径。

实例身份跟随数据库：不同新实例生成不同UUID；恢复同一实例数据库保留其ID。复制整库也复制grant及其撤销状态，**不是独立隔离实例**。恢复旧库可能恢复旧授权状态，恢复后按需要撤销旧grant并重新签发；本功能不改变恢复引擎。

## 专用 HTTP 边界

基础路径 `/api/companion/v1`，仅本机loopback可达。每次请求提供 `Authorization: Bearer <专用密钥>`；忽略管理员Cookie，不接受bridge token，不接受URL查询密钥。

普通Host检查仍在最外层执行；Forwarded头不能改变信任。此路径仅包含以下读取接口（POST也是只读查询），没有claim、save、scan或rebuild路由。

跨域仅允许grant登记的确切Chrome扩展Origin，`null`、网站Origin和其他扩展均拒绝。预检只允许GET/POST、Authorization/Content-Type，不返回通配符或credentials许可；已登记扩展请求私有网络预检时可获明确许可。此CORS不作用于普通API。扩展后台可能省略Origin：仍必须携带有效Bearer，不能携带网页Referer或非`none`的Sec-Fetch-Site。Origin不是秘密，真正权限仍来自Bearer；不应将密钥暴露给内容页，插件应在后台代理有限消息。

所有响应`Cache-Control:no-store`，Vary包含Origin、Authorization。每个本机客户端每分钟最多120次专用请求；授权管理另有频率限制。接口JSON正文最多32KiB，未授权请求在解析正文前拒绝。

## 接口

### GET /connection

返回 `apiVersion:'companion-v1'`、`instanceId`、`label`、`grantId`、`permissionFingerprint`、`scopes`、`expiresAt`、`countPolicyVersion`、`queriedAt` 和 `capabilities`。

能力字段：`batchResolve`、`creatorSearch`、`creatorSummary`、`libraryLink`、`catalogLink`、`maxBatchItems:50`、`maxBodyBytes:32768`、`mutations:false`。权限指纹绑定实例、grant、扩展来源、权限及到期时间；不包含原始密钥。

支持完整离线名单同步的版本另返回`rosterSync:true`、`aliasSync:true`、`maxRosterPageSize:50`、`maxAliasPageSize:200`、`maxPageBytes:262144`。旧版本缺少能力时不要以关键词搜索或伪造页面解析请求代替完整同步。

### GET /roster 与 GET /aliases

两端点复用专用授权、Origin边界、`identity:read`和现有限流。只读，不调用扫描、编目、登记关系或重建服务；不新增迁移。只包含当前有效博主。

| 参数 | 规则 |
| --- | --- |
| `limit` | 正整数；roster默认/最大50，aliases默认/最大200；均可调小到1 |
| `identityVersion` | 64位小写十六进制共同身份版本；roster首个无游标请求可省略，其他请求必填，包括aliases首个请求 |
| `cursor` | 服务端返回的不透明游标，最长512字符；原样URL编码携带，不能在两个端点间互换 |

响应包含现有上下文`apiVersion、instanceId、label、grantId、permissionFingerprint、scopes、expiresAt、countPolicyVersion、queriedAt`，另有`identityVersion、total、nextCursor、items`。`total`是该端点整个身份集合的记录数，不是本页长度。最后一页`nextCursor:null`；空库明确返回`items:[]、total:0、nextCursor:null`。

- roster按`creatorId`升序；每项为`creatorId、canonicalName、preference、collectedWorkCount、countPolicyVersion、readModel、dataVersion、dataUpdatedAt、queriedAt、links`。顶层`preference`明确为`"liked"`（喜欢）、`"kept"`（保留）或`null`（未设置），互斥且只读，使用现有名单授权；即使没有摘要权限也会返回。有`summary:read`时直接复用现有`summary()`的统计字段；未就绪数量null，没有摘要权限时完全不读统计，返回null/permission_denied与身份/偏好同步版本。`links`只包含获准的图库/资源目录链接。
- aliases按`creatorId`及原文alias的BINARY顺序；每项只有`{creatorId,alias}`。同一博主相同原文别名跨来源去重，不返回来源、URL、私人资料或内部ID；跨博主相同别名保留两条，大小写等不同原文仍可分别存在。
- `identityVersion`是有效博主ID、规范名、偏好及上述去重别名集合的共同指纹，与作品数量和来源私密信息无关。两个端点、所有页共享；任意改名、增删身份/别名、启停或偏好修改（包括明确清空）导致版本变化。统计变化不改变此版本。
- 偏好只通过手动完整名单同步更新离线数据，仍只在CosGallery修改；其他查询接口和别名单项不增加此字段，摘要`dataVersion`及计数语义不变。旧插件可以忽略新增字段；新插件连接旧服务端时，字段缺失表示“偏好未同步”，不能按`null`显示“未设置”。升级后旧分页版本失效时按既有409流程重新完整同步，不复用半份名单。
- 每页只在一个短只读事务中核对版本、取身份与该页摘要，不保持跨HTTP长事务。名单身份一致**不代表全部摘要来自同一时刻**；保留逐项摘要版本和查询时间，客户端显示整轮同步完成时间。
- 请求版本与当前身份集合不一致返回409 `COMPANION_IDENTITY_CHANGED`，数量null、没有items。缺少必需版本、非法游标/端点混用或参数返回400 `INVALID_COMPANION_REQUEST`。整页JSON超过256KiB返回413 `COMPANION_PAGE_TOO_LARGE`，不截断；客户端可降低limit重试，单项仍超限则报告同步失败。

推荐同步顺序：

1. 验证connection的实例/授权/权限及新增能力；GET `/roster?limit=50`取得版本。
2. roster后续页携带该版本和nextCursor；GET `/aliases?limit=200&identityVersion=...`并同样翻至结束。
3. 最后GET `/roster?limit=1&identityVersion=...`重新核对身份版本和授权；检查上下文不变、两个total收齐、无重复条目或悬空creatorId。
4. 只有全部成功才用整份新数据替换旧本地集合；409丢弃本轮暂存，有界重试。网络/限流/格式/容量失败保留上次完整集合，不发布半份。401/403、连接切换、撤销及到期仍执行原安全清理边界。

这两个端点不包含完整来源归属，离线名称匹配不能声称完整复现在线resolve的来源冲突判断。完整本地名单和手工同步属于独立插件实现，不会由服务端主动同步到浏览器。

### POST /resolve

```json
{
  "items": [
    {
      "requestKey": "card-1",
      "site": "costuan.com",
      "pageType": "resource",
      "pageIdentifier": "/123.html",
      "candidateNames": ["Synthetic Alpha"]
    }
  ]
}
```

批次1～50项。requestKey需在批内唯一，1～80个字母/数字/下划线/点/冒号/横线；这是响应配对键，不是身份。candidateNames最多8个，每个1～120字符。site只接受上述4个主机。pageIdentifier是最长300字符的规范相对pathname，不接受完整URL、查询/片段、反斜杠、控制字符或父目录跳转。输入是页面线索，不是服务端抓取指令。

pageType为`creator | resource | publisher | organization | multi_person | unknown`。只有前两种可自动判断资源人物；发布者、机构、多人和未知页面即使命中名称也返回`needs_confirmation`，不自动归属。

匹配顺序与边界：

1. 既有正式`archive_catalog_creator_sources`/有效collection中的页面归属事实（不是来源资料草稿）。Costuan `/123`及`/123.html`共用对应的数字页面关系；其他站点仅已有精确source_url路径关系。读取不会新建关系。
2. 规范名、登记别名，复用主项目身份规范化；宽泛搜索不是自动绑定依据。
3. 来源关联与名称冲突、多来源人物冲突、多名称候选均保留，不以来源优先级吞掉冲突。未知页面/未匹配不是“确定未收录”。

结果含`index`、`requestKey`、`matchStatus`、`matchedBy`、`creator`、`candidates`、`candidatesTruncated`及下述摘要字段。候选最多30个，超出明确标记。

| matchStatus | 意义 |
| --- | --- |
| matched | 唯一可靠对应；matchedBy为source_relation或canonical_or_registered_alias |
| conflict | 已有来源归属互相冲突或与名称不一致；creator=null |
| ambiguous | 多个规范/别名对应；creator=null |
| needs_confirmation | 页面人物语义不明确，不自动确认 |
| unresolved | 没有可靠对应；数量null，不是0 |

局部输入错误保留原index和可用requestKey，返回`error:{code,status,message}`、`collectedWorkCount:null`，其他项目继续。顶层`batchStatus:partial_failure`，HTTP200；合法但未匹配不是接口错误。重复requestKey、整体结构或批量超限为整体400；基础数据库故障为整体500，不假装全部查询未匹配。

### GET /creators?q=名称&limit=20

搜索规范名/已登记别名，q必填，1～120字符；limit为1～30，默认20。返回有限`items:[{creatorId,canonicalName,links}]`、`truncated`、`dataVersion`、`queriedAt`。没有全库一次性导出，也不带统计、别名清单或私人资料。搜索结果只是供人工选择，不记录来源绑定。

### GET /creators/:id

需要`summary:read`。手动指定正整数creatorId返回摘要，`matchStatus:'manual'`、`matchedBy:'explicit_creator_id'`；只展示该人物，不写入页面关联、来源或别名。缺少摘要权限403/null，人物不存在或已停用404/null。

## 唯一计数口径

`countPolicyVersion = independent-work-available-copy-v1`。

`collectedWorkCount`是该规范博主的**独立权威Work中至少有一个可靠、有效本地副本的数量**，SQL按Work ID去重，不由插件加减旧字段。依据现有ResourceCatalogBuilder的归属、索引及媒体可用性，不读取磁盘判断最新物理存在情况。

| 边界 | 计数行为 |
| --- | --- |
| 同一Work多个有效副本 | 1 |
| 主副本不可用/删除/回收，但有效次副本仍在 | 1，不依赖当前主副本选择 |
| 只有SourceWork、任务、压缩包，或没有可用媒体的索引Post | 0 |
| 本地副本/归属停用、归属冲突、非normal文件夹、未匹配目录 | 不计 |
| Post/媒体删除或回收、仅保留区原件、特殊显式封面Post | 不计；媒体资格沿用资源目录builder |
| 没有NO/排序，但有权威Work和可用媒体 | 正常计数 |
| 已索引媒体尚无可靠Work对应，发布结果有legacy gaps | 整个人物数量null/incomplete，不猜独立套数 |

`localWorks`（副本数）、图库`workCount`（Post投影）及资源目录`totalWorks`（展示口径）均不是此计数。目录展示当前可能按主副本隐藏Work；此契约明确任意有效副本存在即可收录，不修改现有目录布局或数据。

只在既有read-model已发布、规则可读、generation与built_generation一致且无legacy gaps时返回数字，包括明确的0。`readModel:{status,complete}`状态为：ready、uninitialized、updating、failed、incomplete、reader_outdated；身份专用授权为permission_denied，未匹配为unresolved。非ready数量为null。旧快照不冒充当前结果。

`dataVersion`是当前身份、关联、统计与发布状态的非敏感不透明指纹；规范名/别名/来源对应/可用性或发布版本变化会失效。`dataUpdatedAt`仅表示已有统计read-model的发布时间，可能早于当前身份变更，不代表最后查询时间或所有业务表的统一更新时间。`queriedAt`是本次查询时间，必须分别显示。身份变化用dataVersion判断，不以时间相等认定不变。

## 权限、缓存及错误

摘要查询不返回磁盘路径、密码、偏好、来源资料正文、任务历史或媒体清单；偏好仅在上述roster名单顶层扩展。仅相应scope存在时返回同实例相对跳转：`/library/{creatorId}`、`/archive-catalog?workspace=resources&creatorId={creatorId}`。插件应基于已连接服务地址解析；网页本身仍需要正常登录，Bearer不能换取网页/管理权限。

查询缓存键至少包含：`instanceId + grantId + permissionFingerprint + 查询对象(含site/pageType/path/names或creatorId) + countPolicyVersion`，并关联dataVersion。完整离线名单亦按实例、授权、权限、计数口径隔离，并保存共同identityVersion及逐项摘要版本。不同实例中相同creatorId不是同一身份。

HTTP缓存禁止；仅connection成功不证明旧统计或身份版本仍有效。原查询缓存重新作为在线当前结果使用时须验证相同查询。用户主动完整同步的离线名单可以显示上次同步的身份与摘要，但必须说明同步时间，不能冒充当前在线事实；网络失败保留完整旧名单，不把旧“0”作下载建议。已知401/403/到期/撤销仍使授权数据不可用；离线无法立即感知远端撤销，重新连接验证后必须执行撤销。每次服务端读取现查grant，旧游标/版本/缓存不能绕过撤销。

典型错误：400参数错误、401专用授权失效、403来源或scope不足、404身份/接口不存在、413正文过大、429频率限制、500未知服务故障；本协议错误响应数量null，不能当0。更外层Host拒绝也按失败处理，不依赖一定存在数量字段。错误不返回底层堆栈、路径、凭据。插件网络失败自行采用同样null语义。

## 验证与发布边界

合成内存库覆盖重复副本、有效次副本、source-only、删除/回收、不可用索引、未编排、歧义和来源冲突、版本失效；`PRAGMA query_only`及全表前后比较验证读取无领域/派生写入，spy验证不触发rebuild。真实Express隔离HTTP覆盖管理创建/撤销、401/403、权限裁剪、Host/CORS/CSRF保持、批量/正文限制和部分失败；临时端口由测试分配，不使用4141/4241。

初始开发使用合成数据；后续经用户授权部署候选，并以只读测量发现和修复摘要SQL连接顺序造成的同步阻塞。实际部署记录、精确Head CI和插件验收分别记录，不将接口或隔离测试冒称为插件端到端验收。无真实绑定或采集；完整名单接口不授权修改身份、来源或既有任务。
