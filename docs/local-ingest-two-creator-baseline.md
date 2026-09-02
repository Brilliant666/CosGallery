# 本地入库双博主真实基线

记录时间：2026-09-02（Asia/Shanghai）  
任务：`LOCAL_INGEST_CLOSED_LOOP_V1_TWO_CREATOR_E2E`

## 安全范围

- 允许扫描和处理：`G:\cos待入库\火龙果羊`、`G:\cos待入库\女主K`
- 正式目标：`G:\cos图集\火龙果羊`、`G:\cos图集\女主K`
- 不处理其他待入库博主，不修改任何既有作品目录。
- 基线阶段未解压真实文件，也未写入正式图库。

## 仓库基线

- 仓库：`C:\Users\brilliant\Documents\ChatGPT\插件\Foldergram-CosGallery`
- 原始分支：`main`
- 原始 HEAD：`ef4e46b`（`feat: add local creator metadata acquisition workflow`）
- 远端：`origin = https://github.com/Brilliant666/CosGallery.git`
- 开始时存在 6 个上一阶段留下的未提交文件，内容是“为本地尚无目录的博主生成整位缺失任务”。已完整审阅、保留并在功能分支提交为 `4d3de14`。
- 功能分支：`feat/local-ingest-closed-loop-v1`
- 基线时没有 CosGallery 服务监听 `127.0.0.1:4141`。

## 数据库基线

- 实际 SQLite：`C:\Users\brilliant\Documents\ChatGPT\插件\Foldergram-CosGallery\data\db\gallery.sqlite`
- 大小：125,476,864 bytes
- `PRAGMA quick_check`：`ok`
- 已应用迁移：`000001`、`000002`、`000004`、`000005`、`000007`、`000008`、`000009`、`000010`、`000011`、`000012`
- 迁移前备份：`data\db\backups\gallery-before-local-ingest-20260902-132950.sqlite`
- 备份大小与源库一致，使用只读连接执行 `PRAGMA quick_check` 返回 `ok`；备份位于 Git 忽略的 `data/` 下。
- 本文件生成时尚未应用本任务的新迁移。

## 工具、磁盘和卷

- 可用 7-Zip：`C:\Program Files\NVIDIA Corporation\NVIDIA app\7z.exe`
- 版本：7-Zip 22.01 x64
- 备用工具：`C:\Program Files\Billfish\7za.exe`，7-Zip 21.04 beta x86
- G 盘剩余空间：约 6,134.32 GiB
- `libraryRoot`、`inboxRoot`、`processingRoot`、`quarantineRoot` 均位于 `G:\`
- `G:\$Recycle.Bin` 存在；是否能通过实现的 `RecycleBinAdapter` 正确回收，须以临时哨兵 smoke test 为准。

## 输入目录盘点

两个目录都没有子目录、下载临时文件、零字节文件或重复文件名。四个文件均可以只读打开；修改时间距盘点已远超稳定等待时间。

| 博主 | 文件 | 大小（bytes） | 修改时间 | SHA-256 |
| --- | --- | ---: | --- | --- |
| 火龙果羊 | `007.7z` | 79,924,226 | 2026-09-02 01:44:15 | `17A57441040E338D3380DEFC8B0EF4EAD37CA97E951B5F03E9AA09E513691E58` |
| 火龙果羊 | `008.7z` | 979,745,923 | 2026-09-02 01:45:31 | `86951B01448DFBC90DED95C43EF519E9C400D1A7F99E797D4E7913AD7F34DD62` |
| 女主K | `047.7z` | 693,462,131 | 2026-09-02 01:48:17 | `0025A1545035370D7D423963EC29279897F2722523ADAE74D8BC400EE6404D69` |
| 女主K | `048.7z` | 371,120,963 | 2026-09-02 01:47:21 | `AF4695412EC24CD244BF4EA760F0B1BAA3F5DFD225F92C3D70DB3193ABDCECF7` |

统计：

| 博主 | `.7z` | `.7zz` | `.zip` | 其他文件 | 临时下载 | 已解压目录 | 零字节 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 火龙果羊 | 2 | 0 | 0 | 0 | 0 | 0 | 0 |
| 女主K | 2 | 0 | 0 | 0 | 0 | 0 | 0 |

## 账本精确映射

| 博主 | 文件 | creator ID | collection ID | source work ID | download task ID | 状态 | Costuan 标题 |
| --- | --- | ---: | ---: | ---: | ---: | --- | --- |
| 火龙果羊 | `007.7z` | 192 | 6 | 485 | 1068 | `staged` | 日系死库水 |
| 火龙果羊 | `008.7z` | 192 | 6 | 486 | 1069 | `staged` | 视频小合集 |
| 女主K | `047.7z` | 69 | 60 | 1348 | 1754 | `staged` | `[Fantia] 2024年05月订阅` |
| 女主K | `048.7z` | 69 | 60 | 1349 | 1755 | `staged` | 喜多川海梦兔女郎 |

映射同时满足博主目录、下载任务目标文件名、source collection 和 source work；没有依赖跨博主裸文件名或标题相似度。

## 正式图库现状与目标冲突

- 火龙果羊：账本平台作品 8 套，本地已关联 1–6 共 6 套，`007/008` 尚不存在。
- 女主K：账本平台作品 48 套，本地已关联 1–46 共 46 套，`047/048` 尚不存在。
- 四个输入都属于“唯一映射、尚未入库、当前无目标目录冲突”。
- 目标目录名将在预览时沿用既有命名风格，并包含博主、Costuan 序号、标题与原声明摘要；提交前仍会再次检查冲突。

## 修改前验证结果

- 服务端 TypeScript 构建：通过。
- 客户端测试：42 个文件、185 个测试，全部通过。
- 客户端类型检查和生产构建：通过；仅有既存的大 chunk 警告。
- 服务端测试：64 个文件中 63 个通过；348 个测试中 340 个通过。
- 8 个既存失败全部位于 `migration-bootstrap.test.ts`：实际仓库已经包含并应用迁移 `000012`，旧断言仍只期望到 `000011`。这属于开始前基线问题，不是本地入库实现引入；本任务新增迁移时将同步修正迁移版本断言并要求最终全绿。

## 首批验收选择

1. 黄金样本：`G:\cos待入库\火龙果羊\007.7z`（存在、稳定、唯一映射、目标不存在）。
2. 独立样本优先选择：`G:\cos待入库\女主K\048.7z`，因为它比 `047.7z` 更小；最终仍以外层测试和预检结果为准。
3. 两份首样本通过后，再处理同一 allowlist 中的 `008.7z` 和 `047.7z`。
