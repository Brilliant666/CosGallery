# 运行时与仓库治理（独立候选）

本轮基于 PR41 合并结果继续治理，不改变普通网页入库流程，不重放真实任务。

## 运行时和构建身份

- 推荐官方 Node 24.21.0；`.node-version` / `.nvmrc` 固定该开发版本。
- 支持 Node `>=22.16.0 <23 || >=24.0.0 <25`，pnpm 10.28.0。Node 22 下限来自应用使用的 `node:sqlite` backup API；Verify 分别执行 Node 22、24 测试与双端构建。
- Windows 可解压官方 Node ZIP 到独立应用运行时目录，核对官方 SHA256 与签名后以绝对路径运行，不需要修改系统 PATH 或删除旧 Node。
- 服务端 `dist/build-info.json`、客户端 `dist/build-info.json` 在构建时记录版本、源提交、源树、dirty、构建时间和 Node；health 与侧栏版本提示读取产物身份，不在运行时读取 Git HEAD。非 Git 源码包明确显示未核实，dirty 构建不能当作干净候选。
- CLI、前端和后端仍须由同一已提交候选构建/运行。更新工作区提交并不能让旧进程自动重载。

## 最小检查与发行边界

`pnpm lint` 检查 manifest JSON、脚本语法及 diff 空白；`pnpm format:check` 只检查列明的新治理文件，`pnpm format:governance` 只格式化这些文件。不全仓库重排、不安装本机 hooks。

Dependabot 对 npm 每周、Actions 每月提出有限更新 PR，不自动合并。维护者和漏洞沟通见 [SECURITY.md](https://github.com/Brilliant666/CosGallery/blob/chore/recovery-runtime-and-repository-governance-v1/SECURITY.md)。GitHub main 规则属于远端管理设置，需先确认实际权限和用户选择，不以个人维护者无法满足的第二人审批作为默认条件。

原 GHCR tag 自动发布暂停。容器 workflow 仅支持手工构建检查，`push:false`、无 packages 写权限和登录；本轮不发布 tag/镜像、不部署容器。现存 Docker/compose 是上游遗留链路（包括上游镜像引用），**不作为已验收的 CosGallery 部署方式**。不应直接使用 compose 拉取上游镜像替代本项目候选。

## 配置、恢复材料和公开证据

解压密码仅可设置、替换或明确清除；打开设置、空输入及保存其他设置保持原值。旧读取接口已退役。环境回退与本地明确清除不同，状态可见，已有密码不可读回。

应用恢复点沿用既有服务：数据库与必要配置/密钥配套，配置缺口必须如实记录。它不是原媒体备份，也不防同盘损坏。最终路径、自动开关、频率和保留规则经用户确认后生效；历史副本、配置和密钥按精确清单确认后处理，不按文件大小或日期机械删除。

受控证据使用匿名标识与合成路径；当前文件脱敏不表示 Git 历史已清理。私人清单、实际路径、恢复点和检查原始日志仅存本机忽略目录。

## 安全边界

生产 Express 响应使用强制 CSP 和适用安全头，保留 Inter 的既有字体来源、blob 媒体和本机 HTTP；不启用 HTTPS 强制升级。独立 Vite 开发 HTML 不因此自动获得 Express 的响应头，不宣称已加强开发文件暴露策略。

H1 四项由用户明确暂缓：管理员鉴权改造、7-Zip 执行边界、Host/Origin/代理规则、Vite 监听与文件访问保护。M5、响应头及错误治理不代表 H1 已修复。WAL/NORMAL、云端部署和原媒体备份也不属于本轮。
