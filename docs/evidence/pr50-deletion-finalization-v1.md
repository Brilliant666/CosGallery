# PR50 永久删除收尾修复证据 V1

日期：2026-10-23。任务：`COSGALLERY_PR50_DELETION_FINALIZATION_AND_LEGACY_GUIDANCE_FIX_V1`。

## REPRODUCTION

起点为 `dcd3e31ad1757b41531bd8a9d0660d805f440afd`；相对上一轮 PR Head `5c12e6eb06ef14c7b51e4b28e860ea677be532c7`，只有 AGENTS 文档提交。故障使用临时目录、合成媒体和独立 SQLite 文件复现，未查询正式库。

在 `work-removal.test.ts` 的 `recovers after the journal is removed but the final database write fails` 用例中，合成 SQLite 触发器仅阻断永久删除的最后一次 `completed` 更新。旧实现已清理媒体并删除 journal；移除测试触发器、关闭并重开临时数据库、创建新服务后，正常重试仍返回 `cleanup_pending / filesRemoved=false`，与预期 `completed / filesRemoved=true` 不符。首次单例运行 **1 failed、19 skipped**。相同场景修复后通过。

这是对静态发现的故障窗口验证，不代表正式图库已发生过这一故障。

复核另在 Windows 目录句柄的真实 `sync()` 调用内注入 `EIO`：原同步助手吞掉错误并返回 `completed`，单例预期失败。修复将例外收窄到 Windows 目录句柄明确不支持的 `EPERM/fsync`；打开、关闭以及真正 I/O 失败透传，保留待收尾状态。该用例与四个打开／同步／关闭错误分类用例修复后通过。

## FINALIZATION_FIX

Work 永久删除的顺序现在是：

1. 持久 journal 与移动标记保护原文件隔离；数据库提交业务删除决定。
2. 按确认文件身份清理隔离媒体，检查各根目录没有未解释材料，并执行平台支持的目录同步。
3. journal 仍保留时，在原 `removal_operations.payload_json` 写入 `mediaCleanupReceipt`。
4. 清理本 operationId 的移动标记和 journal，完成日志目录同步，再写 `completed`。

凭据使用版本 1，绑定 operationId、Work ID、永久删除模式及确认快照摘要；标记条数必须等于按现有路径规则去重后的准确目标数。没有增加表、列、状态或 SQL 迁移。原确认快照不变，旧 journal v1 可继续恢复。旧版本代码不具备凭据恢复能力；末端故障应使用本修复或后续兼容版本收尾。

凭据写入失败时保留 journal。有效凭据允许在 journal 已删除后继续收尾；只检查本次隔离目录并删除本次内部标记，不再操作同名原件。旧记录若 journal 缺失又没有可信凭据，继续待核对并解释原因；未知隔离材料、身份或凭据不符不自动判为成功。

`filesRemoved=true / cleanupPending=true` 表示已确认媒体清理，仅内部收尾待完成；回收站保持可见和原 operationId 重试。无可信完成凭据且仍有清理失败时，`filesRemoved=false`。重复完成重试返回同一完成结果。单 Post 删除继续使用自身的提交判断，未被要求具有 Work 操作记录。无日志时的离线启动行为保留。

模拟进程中断异常直接透传，不经普通 catch 回滚。测试在媒体清理后、凭据持久化后和 journal 删除后三个阶段中断，并重开临时数据库后验证恢复。测试覆盖进程中断及注入的同步错误；不声称文件系统与 SQLite 原子，也不将这些测试扩展为所有平台突然断电保证。

## LEGACY_GUIDANCE

`profiles/images.profile_id` 仍阻断启动。提示改为保留数据库、配置和必要密钥，先核对一致性恢复副本及受支持的升级／恢复方式，明确不要删库重建。不声称任意早期结构可自动升级或可直接纳入当前恢复点服务。

五个合成测试覆盖旧 profiles、旧 profile_id、两者并存、带 baseline 标记的旧库及正常 folders 结构；重复拒绝后数据库字节和目录内容不变，未调用迁移或恢复流程。

## SCHEMA_REVIEW

四个后续候选及前置条件见[迁移链只读审查记录](./migration-chain-readonly-review-v1.md)。本轮未清理任何表、字段、索引或触发器。

## VALIDATION

- 本轮本地 Node 24.21.0：Work 删除／恢复 40、旧 Post 永久删除 14、Work guards 6、派生文件访问 5、旧结构提示 5，共 **70 个专项测试通过**。
- 受影响客户端：WorkTrashSection 7、WorkRemovalDialog 3、语言键校验 3，共 **13 个测试通过**，包括中英文收尾提示、持续 pending 和同操作重试。
- 服务端类型检查、服务端构建、客户端类型检查和构建、文档构建通过；客户端及文档构建有现有大 chunk 提示。
- 最终提交 SHA 和对应 Node 22/24 Verify 链接以 [PR50](https://github.com/Brilliant666/CosGallery/pull/50) 当前验证记录为准；本文件不把历史 Verify 当作最终提交证据。

## PR / SAFETY

继续原 PR50，保持 Draft。整个 PR 已包含 `000028_work_removal`、`000029_creator_deletion_audit`、`000030_remove_redundant_manual_creator_aliases`；只有本轮修复无新增迁移。

本轮未操作 4141/4241，未连接、复制或写入正式数据库，未复制配置／密钥或执行真实删除、恢复、扫描、入库和部署。用户配置、媒体、插件与恢复材料保持。历史部署及停止记录不作为本轮运行验收。
