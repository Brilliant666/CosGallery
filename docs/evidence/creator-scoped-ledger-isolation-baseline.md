# Creator-scoped ledger isolation baseline

## Safety baseline

- Base commit: `37ad5e6a6f90035856b3341847ff8acba8e824cd`
- Production database: `data/db/gallery.sqlite`
- Read-only checks: `PRAGMA quick_check = ok`; `PRAGMA foreign_key_check` returned no rows; migration `000015`.
- Recovery-state counts: 1,744 active local works; 1,744 linked; 0 unmatched; 0 ambiguous; 9 `local_ingest_jobs`.
- `五更百鬼`: creator id 39, 35 active local works, 21 genuine missing works.
- Stage 3 allowlist: `倦倦喵`.
- Service was stopped and port 4141 was not listening.
- New pre-fix backup: `data/db/backups/gallery-before-scoped-ledger-fix-20260903-010331.sqlite` (126,279,680 bytes). Both integrity checks passed and the path is Git-ignored.
- `G:\cos待入库\五更百鬼` contained exactly `033.7z` through `053.7z` (21 files, 3,413,803,069 bytes).
- `G:\cos图集\五更百鬼` contained 35 direct work folders and 790 files (8,267,590,983 bytes).

Stable production table snapshots were recorded before any code change. In particular, the `local_ingest_jobs` row hash, Stage 3 settings and allowlist were retained for the final safety comparison.

## Incident databases

The comparison used these databases read-only:

1. Before the four-work operation: `gallery-before-wugengbaigui-029-032-20260902-234530.sqlite`.
2. Failure state before recovery: `gallery-before-e2e-ledger-recovery-20260903-003027.sqlite`.
3. Current recovered production database: `gallery.sqlite`.

The pre-operation to failure-state diff showed:

- 4 intended new local works and 4 intended LocalIngest jobs;
- all 33 local creator-folder rows had only scan/update timestamps refreshed;
- all 1,740 existing local-work rows had scan/update timestamps refreshed;
- 1,660 existing rows changed matching method as a consequence of being rematched;
- 53 rows lost `work_id` and changed from `matched` to `ambiguous`;
- 50 unrelated pending download tasks were inserted;
- no `archive_catalog_works`, `archive_catalog_source_works`, or metadata-task business rows changed;
- two global setting timestamps changed: `archive_catalog.last_refresh_at` and `derivatives.stale_gc_last_run_at`.

The recovered database restores every one of the 1,740 pre-existing relationships, retains only the four intended new local works/jobs and their intended download-task status changes, and contains none of the 50 erroneous tasks.

## The 53 lost persistent relationships

All 53 remained active. The failure was specifically `work_id -> NULL`, `matched -> ambiguous`, and `costuan-numbering-title-conflict`; it was not a filesystem deletion.

| ID | Creator | Local directory | Before (work/status/method/active) | Failure state (work/status/method/active) |
|---:|---|---|---|---|
| 5 | 次屁啦 | 次屁啦 NO.005 学姐大胆三点式[30P-93MB] | 548 / matched / costuan-source-order / 1 | NULL / ambiguous / costuan-numbering-title-conflict / 1 |
| 29 | 可可小白兔 | 可可小白兔 - NO.001 追蹤起來 跟著🐰🐰去游泳！ [7P-20MB] | 410 / matched / costuan-source-order / 1 | NULL / ambiguous / costuan-numbering-title-conflict / 1 |
| 30 | 可可小白兔 | 可可小白兔 - NO.002 夏日浴衣 純慾粉嫩少女🌸 [34P-125MB] | 411 / matched / costuan-source-order / 1 | NULL / ambiguous / costuan-numbering-title-conflict / 1 |
| 400 | 二佐Nisa | 二佐Nisa NO.007 外拍 [13P-247MB] | 919 / matched / costuan-source-order / 1 | NULL / ambiguous / costuan-numbering-title-conflict / 1 |
| 402 | 二佐Nisa | 二佐Nisa NO.009 宠物少女 私房白婚纱 [28P-178MB] | 921 / matched / costuan-source-order / 1 | NULL / ambiguous / costuan-numbering-title-conflict / 1 |
| 403 | 二佐Nisa | 二佐Nisa NO.010 宠物少女 私房黑猫 [28P-724MB] | 922 / matched / costuan-source-order / 1 | NULL / ambiguous / costuan-numbering-title-conflict / 1 |
| 404 | 二佐Nisa | 二佐Nisa NO.011 宠物少女 私房露背毛衣 [17P-37MB] | 923 / matched / costuan-source-order / 1 | NULL / ambiguous / costuan-numbering-title-conflict / 1 |
| 457 | 二佐Nisa | 二佐Nisa NO.064 JK私房2[41P-845MB] | 976 / matched / costuan-source-order / 1 | NULL / ambiguous / costuan-numbering-title-conflict / 1 |
| 522 | 二佐Nisa | 二佐Nisa NO.129 半透明女郎[29P-282MB] | 1041 / matched / costuan-source-order / 1 | NULL / ambiguous / costuan-numbering-title-conflict / 1 |
| 637 | 瓜希酱 | 瓜希酱 NO.068 明日方舟 凯尔希 (Kal'tsit) [21P-146MB] | 616 / matched / costuan-source-order / 1 | NULL / ambiguous / costuan-numbering-title-conflict / 1 |
| 723 | 花铃 | 花铃 017 黑丝透明短裙女仆 [66P-615MB] | 1918 / matched / costuan-source-order / 1 | NULL / ambiguous / costuan-numbering-title-conflict / 1 |
| 844 | 菌烨tako | 菌烨tako NO.016 22年8月奥古斯都女仆 [12P-142MB] | 1988 / matched / costuan-source-order / 1 | NULL / ambiguous / costuan-numbering-title-conflict / 1 |
| 937 | 迷之呆梨 | 迷之呆梨 NO.033 fantia 23.04月会员订阅[156P-4V-361.8M] | 2047 / matched / costuan-source-order / 1 | NULL / ambiguous / costuan-numbering-title-conflict / 1 |
| 938 | 迷之呆梨 | 迷之呆梨 NO.034 fantia 23.05月会员订阅[150P-1V-397.1M] | 2048 / matched / costuan-source-order / 1 | NULL / ambiguous / costuan-numbering-title-conflict / 1 |
| 939 | 迷之呆梨 | 迷之呆梨 NO.035 fantia 23.06月会员订阅[149P1V-386M] | 2049 / matched / costuan-source-order / 1 | NULL / ambiguous / costuan-numbering-title-conflict / 1 |
| 940 | 迷之呆梨 | 迷之呆梨 NO.036 半透明メイド服 [48P3V-360MB] | 2050 / matched / costuan-source-order / 1 | NULL / ambiguous / costuan-numbering-title-conflict / 1 |
| 964 | 女主K | 女主K - NO.05 红色毛衣的丰满妹妹 [103P-416MB] | 1306 / matched / costuan-source-order / 1 | NULL / ambiguous / costuan-numbering-title-conflict / 1 |
| 1007 | 清水由乃 | 清水由乃 NO.002 御风街拍 紧身裙肉丝 [341P-2.4GB] | 1458 / matched / costuan-source-order / 1 | NULL / ambiguous / costuan-numbering-title-conflict / 1 |
| 1008 | 清水由乃 | 清水由乃 NO.003 御风街拍 轻水海鸥岛RS牛仔街拍 [413P-2.81GB] | 1459 / matched / costuan-source-order / 1 | NULL / ambiguous / costuan-numbering-title-conflict / 1 |
| 1018 | 清水由乃 | 清水由乃 NO.013 海鸥岛肉丝牛仔街拍[413P1V-3.86GB] | 1469 / matched / costuan-source-order / 1 | NULL / ambiguous / costuan-numbering-title-conflict / 1 |
| 1061 | 神楽坂真冬 | NO.002 神楽坂真冬 - OL写真系列 | 1661 / matched / costuan-source-order / 1 | NULL / ambiguous / costuan-numbering-title-conflict / 1 |
| 1090 | 神楽坂真冬 | NO.031 神楽坂真冬 - 明日の花嫁 | 1690 / matched / costuan-source-order / 1 | NULL / ambiguous / costuan-numbering-title-conflict / 1 |
| 1091 | 神楽坂真冬 | NO.032 神楽坂真冬 - 魔法を使えないの日常(Fate kaleid liner Prismalllya ) | 1691 / matched / costuan-source-order / 1 | NULL / ambiguous / costuan-numbering-title-conflict / 1 |
| 1096 | 神楽坂真冬 | NO.037 神楽坂真冬 - 原版写真《小さな恋-血小板》 | 1696 / matched / costuan-source-order / 1 | NULL / ambiguous / costuan-numbering-title-conflict / 1 |
| 1110 | 神楽坂真冬 | NO.051 神楽板真冬《笑颜水时计》夏日比基尼 | 1710 / matched / costuan-source-order / 1 | NULL / ambiguous / costuan-numbering-title-conflict / 1 |
| 1132 | 神楽坂真冬 | NO.073 神楽坂真冬《許しの日》苦行修女(絶対企画)[150P2V-173MB] | 1732 / matched / costuan-source-order / 1 | NULL / ambiguous / costuan-numbering-title-conflict / 1 |
| 1176 | 神楽坂真冬 | NO.117 神楽坂真冬 夏日戏水[75P-205MB] | 1776 / matched / costuan-source-order / 1 | NULL / ambiguous / costuan-numbering-title-conflict / 1 |
| 1347 | 眼酱大魔王w | 眼酱大魔王w NO.004 8套合集 [92P2V-133MB] | 1566 / matched / costuan-source-order / 1 | NULL / ambiguous / costuan-numbering-title-conflict / 1 |
| 1350 | 眼酱大魔王w | 眼酱大魔王w NO.007 补丁 蝴蝶结黑丝 裸足 兽耳 [43P-63MB] | 1569 / matched / costuan-source-order / 1 | NULL / ambiguous / costuan-numbering-title-conflict / 1 |
| 1380 | 眼酱大魔王w | 眼酱大魔王w NO.053 肉丝[37P-395MB] | 1614 / matched / costuan-source-order / 1 | NULL / ambiguous / costuan-numbering-title-conflict / 1 |
| 1382 | 眼酱大魔王w | 眼酱大魔王w NO.055 圣诞老人[18P-89MB] | 1616 / matched / costuan-source-order / 1 | NULL / ambiguous / costuan-numbering-title-conflict / 1 |
| 1426 | 眼酱大魔王w | 眼酱大魔王w Vol增刊OL5 [67P-797MB] | 2336 / matched / costuan-numbering-key / 1 | NULL / ambiguous / costuan-numbering-title-conflict / 1 |
| 1506 | 咬一口兔娘 | 咬一口兔娘 NO.007 粉欲私房 [15P-147MB] | 7 / matched / costuan-source-order / 1 | NULL / ambiguous / costuan-numbering-title-conflict / 1 |
| 1526 | 咬一口兔娘 | 咬一口兔娘(黏黏团子兔) – NO.025 『女仆小叽』70P-340M | 25 / matched / costuan-source-order / 1 | NULL / ambiguous / costuan-numbering-title-conflict / 1 |
| 1539 | 咬一口兔娘 | 咬一口兔娘(黏黏团子兔) – NO.040『蕾姆夏日祭』32P1V-970M | 40 / matched / costuan-source-order / 1 | NULL / ambiguous / costuan-numbering-title-conflict / 1 |
| 1545 | 咬一口兔娘 | 咬一口兔娘(黏黏团子兔) – NO.046 回家的诱惑[35P-322M] | 46 / matched / costuan-source-order / 1 | NULL / ambiguous / costuan-numbering-title-conflict / 1 |
| 1572 | 咬一口兔娘 | 咬一口兔娘(黏黏团子兔) – NO.073 『男友衬衣』&Boom Boom[20P1V-962M] | 73 / matched / costuan-source-order / 1 | NULL / ambiguous / costuan-numbering-title-conflict / 1 |
| 1573 | 咬一口兔娘 | 咬一口兔娘(黏黏团子兔) – NO.074 乌龙女警』&Good-night Kiss [23P1V-427M] | 74 / matched / costuan-source-order / 1 | NULL / ambiguous / costuan-numbering-title-conflict / 1 |
| 1577 | 咬一口兔娘 | 咬一口兔娘(黏黏团子兔) – NO.078『黑凌波』&小剧场[34P1V-551MB] | 78 / matched / costuan-source-order / 1 | NULL / ambiguous / costuan-numbering-title-conflict / 1 |
| 1578 | 咬一口兔娘 | 咬一口兔娘(黏黏团子兔) – NO.079『蕾姆喵喵』&小剧场[34P1V-587MB] | 79 / matched / costuan-source-order / 1 | NULL / ambiguous / costuan-numbering-title-conflict / 1 |
| 1580 | 咬一口兔娘 | 咬一口兔娘(黏黏团子兔) – NO.081 八月T3专属特典『碧蓝航线-爱宕』[28P-313M] | 81 / matched / costuan-source-order / 1 | NULL / ambiguous / costuan-numbering-title-conflict / 1 |
| 1581 | 咬一口兔娘 | 咬一口兔娘(黏黏团子兔) – NO.082 八月订阅『狐灵』&LIKEY [55P1V-1.3G] | 82 / matched / costuan-source-order / 1 | NULL / ambiguous / costuan-numbering-title-conflict / 1 |
| 1582 | 咬一口兔娘 | 咬一口兔娘(黏黏团子兔) – NO.083 八月订阅『遗失病栋』&小花仙 [49P1V-973M | 83 / matched / costuan-source-order / 1 | NULL / ambiguous / costuan-numbering-title-conflict / 1 |
| 1593 | 咬一口兔娘 | 咬一口兔娘(黏黏团子兔) – NO.094 盒岛1900目标奖励 sexy love [1V-420M] | 94 / matched / costuan-source-order / 1 | NULL / ambiguous / costuan-numbering-title-conflict / 1 |
| 1601 | 咬一口兔娘 | 咬一口兔娘(黏黏团子兔) – NO.102 海の夏日 Shotgun[73P1V-1.31G] | 102 / matched / costuan-source-order / 1 | NULL / ambiguous / costuan-numbering-title-conflict / 1 |
| 1618 | 咬一口兔娘 | 咬一口兔娘(黏黏团子兔) – NO.119 『兔兔班车』万圣小恶魔 [41P1V-643MB] | 119 / matched / costuan-source-order / 1 | NULL / ambiguous / costuan-numbering-title-conflict / 1 |
| 1627 | 咬一口兔娘 | 咬一口兔娘(Yiko湿润兔) – NO.201 狂赌之梦 [75P1V-2.38GB] | 201 / matched / costuan-source-order / 1 | NULL / ambiguous / costuan-numbering-title-conflict / 1 |
| 1677 | 咬一口兔娘 | 咬一口兔娘(Yiko湿润兔) – NO.251 2025年9月作品『变态教室』WISPLAH[104P3V-3.28G] | 251 / matched / costuan-source-order / 1 | NULL / ambiguous / costuan-numbering-title-conflict / 1 |
| 1710 | 桜桃喵 | 桜桃喵 013 小少女 少女私房 [50P-442MB] | 675 / matched / costuan-source-order / 1 | NULL / ambiguous / costuan-numbering-title-conflict / 1 |
| 1741 | 桜桃喵 | 桜桃喵 044 冬眠系列-纯白私房[46P-386MB] | 706 / matched / costuan-source-order / 1 | NULL / ambiguous / costuan-numbering-title-conflict / 1 |
| 1990 | usejan蓝蓝 | usejan蓝蓝 NO.009 奔驰[40P-75MB] | 1244 / matched / costuan-source-order / 1 | NULL / ambiguous / costuan-numbering-title-conflict / 1 |
| 6543 | 眼酱大魔王w | 眼酱大魔王w NO.040 黑丝润滑液足 10P | 1602 / matched / costuan-source-order / 1 | NULL / ambiguous / costuan-numbering-title-conflict / 1 |
| 6544 | 眼酱大魔王w | 眼酱大魔王w NO.041 裸足3 9P | 1603 / matched / costuan-source-order / 1 | NULL / ambiguous / costuan-numbering-title-conflict / 1 |

Creator distribution: 咬一口兔娘 16; 眼酱大魔王w 7; 神楽坂真冬 7; 二佐Nisa 6; 迷之呆梨 4; 清水由乃 3; 可可小白兔 2; 桜桃喵 2; 次屁啦、瓜希酱、花铃、菌烨tako、女主K、usejan蓝蓝 each 1.

## The 50 erroneous download tasks

| Task | Creator | source-work row | Source identity | Title |
|---:|---|---:|---|---|
| 5895 | 瓜希酱 | 616 | NO.068 | 明日方舟 凯尔希 (Kal’tsit) |
| 5915 | 桜桃喵 | 675 | NO.013 | 小少女 少女私訪 |
| 5916 | 桜桃喵 | 706 | NO.044 | 冬眠系列-纯白私訪 |
| 6042 | 咬一口兔娘 | 7 | NO.007 | 粉欲私訪 |
| 6043 | 咬一口兔娘 | 25 | NO.025 | 女仆小叽70P-340M |
| 6044 | 咬一口兔娘 | 40 | NO.040 | 『蕾姆夏祭』32P1V-970M |
| 6045 | 咬一口兔娘 | 46 | NO.046 | 回家的有货 |
| 6046 | 咬一口兔娘 | 73 | NO.073 | 男友衬衣&Boom Boom |
| 6047 | 咬一口兔娘 | 74 | NO.074 | 乌龙女警&Good-night Kiss |
| 6048 | 咬一口兔娘 | 78 | NO.078 | 黑凌波&小剧场 |
| 6049 | 咬一口兔娘 | 79 | NO.079 | 蕾姆喵喵&小剧场 |
| 6050 | 咬一口兔娘 | 81 | NO.081 | 八月T3专属特典 碧蓝航线-爱宕 |
| 6051 | 咬一口兔娘 | 82 | NO.082 | 八月订阅 狐灵&LIKEY |
| 6052 | 咬一口兔娘 | 83 | NO.083 | 八月订阅 遗失病栋&小花仙 |
| 6053 | 咬一口兔娘 | 94 | NO.094 | 盒岛1900目标奖励 love |
| 6054 | 咬一口兔娘 | 102 | NO.102 | 海の夏 Shotgun |
| 6055 | 咬一口兔娘 | 119 | NO.119 | 兔兔班车 万圣小恶魔 |
| 6056 | 咬一口兔娘 | 201 | NO.201 | 狂堵之梦 |
| 6057 | 咬一口兔娘 | 251 | NO.251 | 2025年9月作品 变态教室 WISPLAH |
| 6153 | 可可小白兔 | 410 | NO.001 | 追蹤起來 跟着去游泳 |
| 6154 | 可可小白兔 | 411 | NO.002 | 夏日浴衣 純粉嫩少女 |
| 6166 | 二佐Nisa | 919 | NO.007 | 外怕 |
| 6167 | 二佐Nisa | 921 | NO.009 | 宠物少女 白婚纱 |
| 6168 | 二佐Nisa | 922 | NO.010 | 宠物少女 黑猫 |
| 6169 | 二佐Nisa | 923 | NO.011 | 宠物少女 露背毛衣 |
| 6170 | 二佐Nisa | 976 | NO.064 | JK2 |
| 6171 | 二佐Nisa | 1041 | NO.129 | 半透女郎 |
| 6222 | 神楽坂真冬 | 1661 | NO.002 | OL系列 |
| 6223 | 神楽坂真冬 | 1690 | NO.031 | 明の花嫁 |
| 6224 | 神楽坂真冬 | 1691 | NO.032 | 魔法を使えないの常(Fate kaleid liner Prismalllya ) |
| 6225 | 神楽坂真冬 | 1696 | NO.037 | 原版《小さな恋-血小板》 |
| 6226 | 神楽坂真冬 | 1710 | NO.051 | 《笑颜水时计》夏比基尼 |
| 6227 | 神楽坂真冬 | 1732 | NO.073 | 《許しの》苦行修女(絶対企画) |
| 6228 | 神楽坂真冬 | 1776 | NO.117 | 神楽坂真冬 夏戏水 |
| 6292 | 清水由乃 | 1458 | NO.002 | 御风街怕 紧身裙 |
| 6293 | 清水由乃 | 1459 | NO.003 | 御风街怕 轻水海鸥岛RS牛仔街怕 |
| 6294 | 清水由乃 | 1469 | NO.013 | 海鸥岛牛仔街怕（413P1V） |
| 6347 | 菌烨tako | 1988 | NO.016 | 22年8月奥古斯女仆 |
| 6358 | 眼酱大魔王w | 1566 | NO.004 | 8套小合集 |
| 6359 | 眼酱大魔王w | 1569 | NO.007 | 补丁 蝴蝶结黑咝 L足 兽耳 |
| 6362 | 眼酱大魔王w | 1614 | NO.053 | R咝 |
| 6363 | 眼酱大魔王w | 1616 | NO.055 | 圣诞老R |
| 6380 | 花铃 | 1918 | NO.017 | 黑咝短裙女仆 |
| 6384 | 女主K | 1306 | NO.005 | 红色毛衣的丰满妹妹 |
| 6422 | 迷之呆梨 | 2047 | NO.033 | fantia 2023.04月会员订阅 |
| 6423 | 迷之呆梨 | 2048 | NO.034 | fantia 2023.05月会员订阅 |
| 6424 | 迷之呆梨 | 2049 | NO.035 | fantia 2023.06月会员订阅 |
| 6425 | 迷之呆梨 | 2050 | NO.036 | 半透メイド服 |
| 6468 | 次屁啦 | 548 | NO.005 | 学姐三点 |
| 6472 | usejan蓝蓝 | 1244 | NO.009 | 夜樱 |

All 50 were `pending` with attempt count 0. They were generated because the global rematch made their corresponding local `work_id` disappear, so global `planMissing` interpreted the same already-local works as newly missing.

## Root-cause separation

### A. Scoped physical scan called global ledger work

`ScannerService.scanCosCreators([creatorName])` correctly limited media discovery and stale-row cleanup to one direct creator directory. Immediately afterwards, however, LocalIngest called `ArchiveCatalogPipelineService.refreshAfterGalleryScan({ galleryRoot })`. That method performed a full-root catalog reconciliation, global download-task planning, and global metadata-task planning. The physical and ledger scopes were therefore structurally different.

### B. Full reconciliation was not relationship-idempotent

`reconcileLocalRoot` first made every local creator folder/work inactive and then rebuilt every local relationship from current title heuristics. It did not treat an existing, active, same-creator source/local link as persistent. The newer numbering matcher found the same numbering keys but rejected 53 title pairs because of punctuation, OCR/traditional-character variation, creator prefixes, abbreviations, or later title drift. Those rows were classified as title conflicts even though their existing source works were still active and belonged to the same creators.

The correct default is therefore not to hard-code the 53 links. It is to retain every existing valid relationship during ordinary scans and run automatic matching only for new, unlinked, invalid, or explicitly rematched local works.
