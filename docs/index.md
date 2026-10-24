---
layout: home
title: CosGallery
titleTemplate: false
hero:
  name: CosGallery
  text: 以本地作品为核心的自有图库
  tagline: 按博主分类发现照片与视频，管理独立作品、本地副本和入库过程。
  image:
    src: /logo.svg
    alt: Foldergram 上游项目标志
  actions:
    - theme: brand
      text: 本机快速开始
      link: /quick-start
    - theme: alt
      text: 页面与使用路径
      link: /creator-admission-navigation
    - theme: alt
      text: GitHub
      link: https://github.com/Brilliant666/CosGallery
features:
  - title: 分类与浏览
    details: 图库按 Cosplay、写真、自拍、福利姬发现博主；首页切换最新、重新发现与随机，照片使用缓存预览，视频原件优先。
    link: /features
  - title: 图库账本
    details: 规范博主与自有资源目录分工明确；按 Work 编目，个人编号与全库搜索共存。
    link: /own-resource-catalog
  - title: 本地入库
    details: 选择多位博主及已解压图集，在网页核对、确认并查看后台结果，来源可后补。
    link: /local-admission-web
  - title: 来源与 Costuan
    details: 原始资料、精确对应与本地满足分别记录；专用插件与手工下载配合，不将暂存当成入库。
    link: /local-ingest-closed-loop
  - title: 本机数据
    details: 业务事实保存在 SQLite，原件与派生缓存分开管理；备份还需包含配置与必要本地密钥。
    link: /security
---

## 按需要阅读

- 文档于 2026-10-24 按已合并的 PR52（`4c56531`）核对；功能说明不等于当前服务部署状态，历史证据另见参考索引。
- 浏览与整理：[功能与边界](features.md)、[页面地图](creator-admission-navigation.md)、[回收与删除](album-media-deletion-design.md)。
- 第一次安装：[快速开始](quick-start.md)、[配置](configuration.md)。
- 日常收录：[本地入库](local-admission-web.md)、[Costuan 入库](local-ingest-closed-loop.md)、[来源资料](source-evidence-local-admission.md)。
- 暂停或历史结果：[排错](troubleshooting.md)、[FAQ](faq.md)。
- 维护与开发：[架构](how-it-works.md)、[开发](development.md)、[技术与历史索引](reference-index.md)。

基于 [Foldergram](https://github.com/foldergram/foldergram)，保留 Sajjad Ali 及上游贡献者署名与 AGPL 许可证。[上游演示](https://foldergram.intentdeep.com/)不代表当前 CosGallery 的完整在线产品；本指南以本机源码使用为主。
