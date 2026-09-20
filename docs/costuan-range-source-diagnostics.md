# Costuan 范围编号：来源查询诊断契约

## 范围

本版支持来源文本的范围识别、编号覆盖检查和插件待审核展示。
不是范围到独立 Work、下载文件或本地版本的自动展开器；不新增迁移。
编号覆盖完整不等于作品边界、目录语义或网盘文件已经核验。

`NO.018-NO.26`、`NO.018-026`、`NO.018～026`、`VOL.003–VOL.005`
解析为两个端点和闭区间覆盖；原文保留，规范编号使用补零形式。
倒序、相同端点、零、越界、跨 NO/VOL、多编号归属歧义及残缺范围拒绝，
不退回首编号。明确发行标签后的出版 VOL 不误作合集范围。

每条范围仍是一条来源声明，合计图片/视频/大小仍属于整条声明。
不除以覆盖数量、不生成占位 Work、不猜测 `018.7z` 等文件。
范围条目的 `sourceOrder` 保留完整范围，省略 `order`；单号保持既有格式。
客户端的 `range`、`order`、complete 标记不是权威证据，服务端重新解析原文及条目。

## HTTP

沿用 `POST /api/archive-bridge/metadata-tasks/:id/validate-directory`。
原鉴权、creatorId、worker、attempt 和身份校验均保留，未绕过领取检查。
遇到未决范围时返回 HTTP 400：

```json
{
  "ok": false,
  "code": "COSTUAN_RANGE_DIRECTORY_REVIEW_REQUIRED",
  "message": "来源目录校验未通过：…",
  "coverage": {
    "rawEntryCount": 2,
    "numberedEntryCount": 2,
    "singleEntryCount": 1,
    "rangeEntryCount": 1,
    "uniqueNumberCount": 4,
    "declaredCount": 4,
    "overlaps": [],
    "missingNumbers": [],
    "outsideNumbers": [],
    "mixedSchemes": false,
    "numberingComplete": true,
    "ranges": [{
      "sourceOrder": "NO.001-NO.003",
      "rawTitle": "Fixture NO.001-NO.003 合集 [30P-20MB]",
      "label": "合集", "first": 1, "last": 3, "count": 3,
      "mediaSummary": "[30P-20MB]",
      "declaredImageCount": 30, "declaredVideoCount": null, "declaredSize": "20MB"
    }]
  }
}
```

上述为合成示例。`rawEntryCount` 是逐行解析得到的条目数，不是网页物理行数；
未编号条目数可用它减去 `numberedEntryCount`，不等于已审核附加作品数。
`numberingComplete` 仅检查 1..declaredCount 的覆盖、缺号、越界、重叠和编号体系。
未知行、身份或附加内容语义不能由此推断通过。
同一编号多次出现会保留在 overlaps 的 owners 中，不采用最后一行覆盖来隐藏重复。

响应不含 `requiredFilenames`，不写 Work/SourceWork/DownloadTask。
插件保留 code/coverage 到待审核诊断；不得转成成功 complete、调用网盘或自动重试成单号。
旧服务没有 coverage 时保持旧错误展示，不能截取首编号回退。
普通单号成功响应不变；Ely 既有逐项人工确认例外保持原限定条件，
不是对所有范围的授权。该例外成功响应附带 `reviewedRangePolicy: "ely-638-v1"`，
只在原 creator54/post638 限定规则通过后返回；插件同时核对policy、creator和post，
再沿用既有规范化目录。未知policy或旧服务无policy的范围仍不放行。
普通离线导入也检查 raw text 和 works 的每种表示，
不能用空原文或单号原文隐藏范围条目而建立错误 Work。

## 身份与附加内容

姓名变体核验可用完整范围覆盖作为编号连续性证据，仍要求每条明确的同博主身份、
唯一覆盖和既有标签/名称规则。身份通过不等于范围已经允许导入。
明确声明的微博附加内容支持“微博图／微博散图／微博配图／微薄散图／微博杂图”；
保留实际名称及合计媒体声明，不计入编号作品，也不授权暂存。

## 验证边界

纯解析、合成 133 条编号声明覆盖 142 个编号（另一个附加条目）、
非法范围、范围隐藏、身份、现有单号/Ely、HTTP 权限和零业务写入均在隔离测试验证。
该 142 示例不是当前网站完整目录抓取，不能据此宣布 Shika 当前来源已核验或已放行。
本轮不访问真实网盘、不恢复任务、不执行下载、解压、接纳或生产部署。

## 本轮验证记录

- Node24 服务端冻结回归：120 个文件，1020 通过、2 个既有跳过，155.79 秒。
  首次非冻结运行中新增 raw 编号断言出现 1 项失败，不计作通过；冻结重跑通过。
- 此后仅新增 Ely 既有审核 policy 透传与兼容断言，最终相关 36 项通过；
  服务端 TypeScript 编译通过。没有把此前全量宣称为最后该透传修改后的全量。
- Script 独立任务已完成插件解析、coverage 待审核持久化、实际浏览器展开和安全文本展示。
  双端纯模块合成合同一致，范围数仍为 2，没有虚构 Work 或包名。
- 正式主工作区、4141、数据库及原扩展未更新；本地分支用于审阅，不代表已上线。
