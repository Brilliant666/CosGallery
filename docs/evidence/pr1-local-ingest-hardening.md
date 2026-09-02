# PR #1 LocalIngest 合并前硬化记录

记录时间：2026-09-02（Asia/Shanghai）

## 审计基线

- 仓库：`Brilliant666/CosGallery`
- 分支：`feat/local-ingest-closed-loop-v1`
- 任务开始 HEAD：`9ced2e486c36c47eef974bfbbb7f3981dcfc99bb`
- 任务开始 `origin/main` / merge-base：`d72407fa9441619903c0684ce3e40a8f03cdacd9`
- 生产数据库：`data/db/gallery.sqlite`
- 合并前安全备份：`data/db/backups/gallery-before-pr1-hardening-20260902-165548.sqlite`
- 源库与备份的 `PRAGMA quick_check` 均为 `ok`
- 开始时迁移版本到 `000014`；本次新增 `000015_harden_local_ingest_execution`
- 开始时真实 allowlist 仅为 `倦倦喵`；硬化测试没有修改生产 allowlist
- 密码仅核对“已配置”，未读取、记录或输出原文

## 审查结论与根因

| 审查项 | 当前 HEAD 原风险 | 本次处理 |
| --- | --- | --- |
| Scanner 根一致性 | `libraryRoot` 可编辑，而 Scanner 根由启动配置固定 | 字段只读；保存不一致值返回 400；运行前再次校验 |
| 文件稳定性 | 主要依赖文件年龄与临时后缀，未证明连续两次不变 | 持久 observation、二次观察、哈希后复核；不稳定时不创建 job |
| 并发执行 | 状态检查不是跨请求/跨实例原子锁 | 数据库 claim/lease + heartbeat + 进程内 per-job mutex |
| 7-Zip timeout | Windows `child.kill()` 不能保证子进程树退出 | 精确 PID 树终止并等待退出，不按进程名清理 |
| 路径边界 | 关键阶段主要依赖旧数据库路径和字符串拼接 | 根目录与 source/processing/ready/target/recycle 均按 realpath 重验 |
| 进程中断 | 启动只做 inbox 补偿扫描 | stale running/reconciling/cleanup 转为可恢复状态，不自动执行 |
| `000014` down | 旧 creator/hash 唯一键容纳不了合法同哈希双 source work | down 保留 source-aware 唯一规则；真实 dbmate up/down/repeat 测试无损 |
| `quarantineRoot` | 页面和校验暴露了未实现的工作流 | 从 V1 主动界面/校验移除，旧字段兼容忽略，磁盘内容不动 |
| 129 个编译文件 | 客户端基础 tsconfig 没有 `noEmit` 防线 | 标准 build 本来已显式 `--noEmit`，本次无法复现；补充全局 `noEmit` 与 CI 工作区检查 |
| 测试导入触发生产迁移 | LocalIngest 单例的默认数据库与静态 Scanner 导入会提前打开 `databaseManager.connection` | 数据库改为惰性获取、Scanner 改为执行时动态导入，Vitest 默认 DATA_ROOT 指向独立临时目录 |

129 个文件的历史精确命令不可从仓库恢复。结合标准客户端脚本一直使用 `vue-tsc --noEmit`、服务端固定输出到 `dist`，而客户端基础 tsconfig 原先缺少 `noEmit`，最符合证据的根因是曾运行裸 `vue-tsc/tsc -p client/tsconfig.json`。这是证据支持的推断，不把未知命令写成已证实事实。标准服务端和客户端构建后，Git 状态只包含本次预期源代码与文档改动，没有新增旁路编译产物。

## 自动测试边界

- 通用状态机、连续稳定观察、并发 claim、路径逃逸、迁移回滚和中断恢复在临时 SQLite 与临时目录运行。
- Windows 进程树超时测试使用可控父/子写入进程，确认超时返回后输出不再变化且下一次命令可安全运行。
- 真实 Windows 回收站与双层密码归档 E2E 由既有五项只读证据承担；Linux Verify 不宣称执行这些 Windows 专属真实 E2E。
- GitHub `Verify` 使用锁定的 pnpm 依赖，执行服务端、客户端、迁移、构建、diff check，并拒绝构建产生的未跟踪文件。

## 本机最终验证

- 服务端：67 个测试文件通过；389 项通过、2 项 Windows 条件测试按既有条件跳过，共 391 项。
- 客户端：42 个测试文件、187 项全部通过。
- 迁移：真实 dbmate `000014` down/up/repeat 覆盖同一博主、两个 source work、相同 SHA-256，记录无损保留。
- 构建：服务端 TypeScript 构建与客户端生产构建均通过；客户端共转换 266 个模块。
- 工作区：`git diff --check` 通过；标准构建没有向源码目录生成新的编译文件。
- 测试隔离：最终 Vitest 配置默认使用系统临时 `DATA_ROOT`；导入安全测试证明 LocalIngest 模块加载不会连接生产数据库。

GitHub `Verify` 首次完整运行已成功：[`33620405038`](https://github.com/Brilliant666/CosGallery/actions/runs/33620405038)，耗时 2 分 39 秒。该运行在 Ubuntu / Node.js 22 上通过两端测试、迁移、两端构建、diff check 与构建后生成物检查。记录该结果的纯文档提交仍需再次通过相同门禁，PR 才会从 Draft 转为 Ready。

## 真实数据保护

硬化期间没有处理第四位博主，没有运行五个既有 job，没有恢复回收站内容，没有改动 `G:\cos图集` 或真实媒体，没有修改 Script / CostuanArchiveManager。审计中确认旧的急切单例初始化曾让测试导入提前应用新增迁移；它没有执行扫描或任务，且五条业务记录和两项 Stage 3 设置与迁移前备份双向 `EXCEPT` 均为 0 差异。该入口现已改成惰性连接。生产数据库只允许新增向后迁移结构；五项任务的业务字段、状态、attemptCount、目标与证据必须在收尾时再次与备份核对。

收尾复核已完成：当前库与备份均 `quick_check=ok`；五条 job 的 `000015` 前业务列双向 `EXCEPT` 均为 0，Stage 3 设置与 allowlist 双向 `EXCEPT` 均为 0。五个 job 仍全部为 `ingested / done / passed / recycled`，`attemptCount` 均为 1。直接只读枚举正式目录得到 246 张图片、34 个视频、0 个其他文件；五个源归档路径和处理目录路径均不存在。服务保持停止，未触发扫描、入库、复扫或回收。
