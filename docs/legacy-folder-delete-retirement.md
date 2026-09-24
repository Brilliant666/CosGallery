# 旧文件夹永久删除入口退役

PR41 的 L4 治理针对 `DELETE /api/folders/:slug`，不是新增整博主删除或整目录回收功能。已授权请求现在返回 HTTP **410** 和稳定错误码 `LEGACY_FOLDER_DELETE_RETIRED`，在查询目标、删除文件或修改业务记录之前结束。默认参数和 `deleteSourceFolder=true` 都不再执行删除。

## 调用者与身份边界

退役前的调用链为：

```text
旧 LibraryView.vue 删除菜单（当前路由未挂载）
  → client/api/gallery.deleteFolder
  → DELETE /api/folders/:slug
  → galleryService.deleteFolder
  → 先删除原文件/派生文件，再清除扫描状态、头像引用和 Folder
  → Folder 删除级联 Image / Post / PostItem
                       ↑
               LocalWork.post_id（非 CASCADE 外键，可能阻止 Post 删除）
```

当前 `/library` 的组件实际来自 `CosGalleryHomeView.vue`，不是同名旧 `LibraryView.vue`；`/library/:creatorId` 和作品路由使用规范博主/作品视图。核对覆盖路由导入、前端封装、服务层、脚本/CLI 和测试，不只是构建产物字符串。旧 Vue 文件仅在一个未生效的路由测试 mock 中被引用；除旧菜单、API 路由及旧删除专项外，没有发现正常业务调用者。

- **Folder** 是物理目录索引，可能有普通子目录或专用 owned（carousel/story）目录，不等同一位规范博主。
- **Image** 是一个媒体索引；**Post** 是图库展示项，以 PostItem 关联媒体。
- **LocalWork** 是本地作品副本，可关联 Post 和规范 **Work**。一个 Work 可以有多个 LocalWork，主副本另有明确关系。
- **规范博主**、来源条目、版本决定及派生资源目录通过上述业务身份关联，不应被旧 Folder 级联删除当作无关记录清理。

## 退役前的隔离复现

参考源码为 `7dc0f628fd0b8f7117ad5813932a3b127cb943fe`。使用一次性 SQLite、`mkdtemp` 图库/缩略图/预览目录、合成索引文件及附件；没有使用正式数据库副本中的路径。每个场景明确执行并断言 `PRAGMA foreign_keys=ON`。此测试验证文件及数据库操作顺序，不调用媒体解码器。

| 场景 | 默认 / false | `deleteSourceFolder=true` |
| --- | --- | --- |
| 无 LocalWork 引用的旧 Folder | 删除直属及 owned 媒体、对应派生和索引；可成功 | 删除整个物理子树及对应索引；可成功 |
| LocalWork.post_id 引用受影响 Post | 原件及派生已经删除，随后数据库外键拒绝；Folder/Post/LocalWork 仍在 | 同样先删文件再发生外键拒绝 |
| 父目录含普通子目录、owned 目录及 notes 附件 | 删除父目录及 owned 的索引媒体；普通子目录及 notes 保留 | 普通子目录、owned、附件连同整个子树被删除 |

12 项退役前专项通过，包含原有 carousel、视频派生、软删除/回收成员场景。引用失败场景还证明：扫描状态在 Folder 删除失败前已经被清除，操作不是跨文件与数据库的原子事务。单条失败的 Folder DELETE 不能撤销此前文件和数据库动作。不能据此宣称所有 Folder 都必然失败。

“66/146”等历史比例没有在本轮作正式只读计数，也没有用作产品判断。上述范围来自代码审查和隔离复现，不代表正式库发生过同样删除。

## 实际治理与兼容

- 保留原认证、`canDeleteMedia` 能力保护、可信写请求保护及 slug/query 校验。开启认证时未认证请求仍为 401，viewer 仍为 403；获准请求才是 410。缺少可信写入头仍为 403，非法参数仍为 400。
- 删除 `galleryService.deleteFolder` 方法及只为该方法服务的文件移除 helper；没有内部可调用的旧破坏实现、旁路开关或换路径替代。
- 清理旧页面的专用删除按钮、对话框及状态，移除未使用的客户端调用和返回类型。未删除通用确认组件、Folder 读取/修改服务及其他正常页面。
- 没有关闭外键、增加 CASCADE、提前清除 LocalWork 引用或变更迁移。

退役后的专项通过真实 HTTP 请求验证默认、true、false、重复请求、旧客户端参数和不存在的 slug；比较全部夹具表行和原件/派生文件内容，均无请求引起的变化。无 LocalWork 引用的旧目录也受同样保护。后台服务对象中不再存在 `deleteFolder`。

单帖/作品永久删除、应用回收站与恢复、Stage3 原压缩包回收、入库广告及空父目录收尾、未使用手工博主删除、扫描对消失文件的处理保持原路径。单帖永久删除、回收/恢复、消失/重现及手工博主删除的相关测试继续运行；这不是对它们重新定义语义或自动添加整库备份。

需要批量维护时应先按应用恢复点文档保留恢复材料，再使用各自已支持的明确操作。本次不把旧 Folder 删除自动转换为整目录回收，也不提供新整博主删除能力。
