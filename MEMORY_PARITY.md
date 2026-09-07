# Memory parity checklist

本文件是当前记忆架构的验收清单。状态只使用以下三种值：

- ✅ 已完成 1:1 对齐
- ⚠️ 参考实现 行为仍存在逆向缺口
- ❌ 尚未实现

## 证据范围

逆向结论来自以下原始材料和反编译产物：

- `/Volumes/T7/参考实现-reverse/REPORT.md`
- `/Volumes/T7/参考实现-reverse/notes/01-main-process.md`
- `/Volumes/T7/参考实现-reverse/notes/04-cli-subsystems.md`
- `/Volumes/T7/参考实现-reverse/notes/05-data-layer.md`
- `/Volumes/T7/参考实现-reverse/notes/12-features-verification.md`
- `/Volumes/T7/参考实现-reverse/notes/14-data-plane-complete.md`
- `/Volumes/T7/参考实现-reverse/notes/16-convergence.md`
- `/Volumes/T7/参考实现-reverse/notes/17-runtime-evidence.md`
- `/Volumes/T7/参考实现-reverse/notes/18-deep-dive-seven.md`
- `/Volumes/T7/参考实现-reverse/VERIFY.md` §I
- `/Volumes/T7/参考实现-reverse/extracted/db-tables-0.4.22.json`
- `/Volumes/T7/参考实现-reverse/extracted/routes-0.4.22.json`
- `/Volumes/T7/参考实现-reverse/extracted/system-prompts-catalog.json`
- `/Volumes/T7/参考实现-reverse/asar/out/main/index.js`（v0.4.0 主进程）
- `/Volumes/T7/参考实现-reverse/asar-0.4.22/out/main/index.js`（仅作增量交叉验证）

重点证据包括：memory DDL 与处理链、`vec0` 投影、Sleep 运行器、Activity DDL 与分析链、Crystal DDL 与线程扫描、每日文件记忆及心跳调度。实现证据以当前 Biny 源码和自动化测试为准。

本清单的主版本基准是报告和 `notes/01`、`notes/04`、`notes/05` 中的 v0.4.0；`asar-0.4.22` 与 `extracted/*-0.4.22.json` 仅作为后续增量交叉验证，不能单独证明 v0.4.0 的精确行为。

当前 `pnpm test` 已通过；Activity 专项、记忆生命周期、Crystal、文件记忆、情绪、身份、聊天日报、embedding runtime、配置和旧 schema 门禁专项也已分别执行通过。

## 能力对照

| 参考实现 能力 | 参考实现 证据 | Biny 实现 | 测试 | 状态 |
|---|---|---|---|---|
| memories 基础条目 | `REPORT.md` memory schema；`notes/05-data-layer.md` | `src/agent/context/memoryStorage.ts`：内容、metadata、来源、标签、重要性、线程/消息/用户关联、时间字段 | `tests/memory-v2.test.ts`, `tests/memory-lifecycle.test.ts` | ✅ 已完成 1:1 对齐 |
| exact duplicate | memory service 的 exact group 查询逻辑 | `MemoryStorage` 保存前 exact 检查并保持幂等 | `tests/memory-lifecycle.test.ts` | ✅ 已完成 1:1 对齐 |
| accessCount / last access | memory schema 与召回后更新逻辑 | 语义召回返回后更新访问计数和最后访问时间 | `tests/memory-v2.test.ts`, `tests/context.test.ts` | ✅ 已完成 1:1 对齐 |
| archive / restore | `memory_archive` schema 与 archive 保留策略 | `memory_archive`、可恢复归档和 lineage | `tests/memory-lifecycle.test.ts`, `tests/memory-v2.test.ts` | ✅ 已完成 1:1 对齐 |
| memory embeddings | `memory_embeddings`、`vec0`、384 维本地 embedding 证据 | `MemoryEmbeddingService`、`memory_embeddings` 和 vector projection | `tests/embedding-runtime.test.ts`, `tests/memory-v2.test.ts` | ✅ 已完成 1:1 对齐 |
| semantic top-K / threshold | 原始 SQL cosine 距离与召回参数 | `HybridMemoryRetriever` 将最小相似度和 top-K 传入 `MemoryVectorIndex`；自动上下文走纯向量排序，手动词法回退是 Biny extension | `tests/hybrid-memory-retriever.test.ts`, `tests/context.test.ts`, `tests/memory-v2.test.ts` | ✅ 已完成 1:1 对齐 |
| embedding model change / rebuild | `app_settings.needsEmbeddingRebuild` 与模型切换路径 | 配置标记、CAS 清除、运行时重建、vector generation | `tests/config.test.ts`, `tests/embedding-runtime.test.ts` | ✅ 已完成 1:1 对齐 |
| Sleep exact / expired | raw Sleep layer 1 与 temporary TTL 证据 | `MemorySleepService` 的 exact、expired、archive 清理 | `tests/memory-lifecycle.test.ts` | ✅ 已完成 1:1 对齐 |
| Sleep orphan classification | 原始 `runSleepCycle` 只执行 exact、expired、similarity 和 LLM 层；`archived_orphan` 只是运行统计字段，未定位到可执行孤儿分支 | run schema 保留 `archivedOrphan` 字段并按确认行为固定为 `0`，整理器不会凭空添加孤儿归档层 | `tests/memory-lifecycle.test.ts` | ✅ 已完成 1:1 对齐 |
| Sleep similarity / LLM merge | raw Sleep layer 2/3、batch、阈值、merge prompt；`notes/17-runtime-evidence.md` §2.1 的异常边界 | similarity candidates、结构化 LLM merge、白名单删除、逐条 synthesis 失败后继续归档；保留加权 survivor 选择 | `tests/memory-lifecycle.test.ts`, `tests/memory-v2.test.ts` | ✅ 已完成 1:1 对齐 |
| memory_sleep_runs | Sleep run schema、状态和统计字段 | run 创建、批次统计、失败状态、恢复入口 | `tests/memory-lifecycle.test.ts` | ✅ 已完成 1:1 对齐 |
| Sleep scheduling / preview / cancel | `notes/17-runtime-evidence.md` §2.1：启动 heal、5 秒首查、60 秒 tick、本地日期、错过时间补跑、三次失败退避 | Runtime Host 启动先恢复遗留 run，再按本地时间调度；preview/cancel 与 run 状态持久化 | `tests/runtime-host-maintenance.test.ts`, `tests/memory-lifecycle.test.ts`, `tests/cli-multi-session.test.ts` | ✅ 已完成 1:1 对齐 |
| activity sessions / events | Activity DDL 与 session 聚合逻辑；事件主键为 TEXT | `src/activity/store.ts`、文本事件 ID、事件、应用/窗口、时间及结束状态；旧整数表在打开时事务式重建 | `tests/activity-recorder.test.ts`, `tests/activity-analyzer.test.ts` | ✅ 已完成 1:1 对齐 |
| activity epoch-ms timestamps | Activity 原始 DDL 的 session/event/snapshot/OCR 时间列使用 INTEGER epoch-ms | session `started_at/ended_at` 及 raw compatibility 时间列按 epoch-ms 写入，公共模型继续返回 ISO | `tests/activity-recorder.test.ts`, `tests/activity-semantic-search.test.ts` | ✅ 已完成 1:1 对齐 |
| screenshot storage | `notes/18-deep-dive-seven.md` §1：ActivityRecorder→unix socket computer-use 守护→`shot_display`→ScreenCaptureKit，失败后进程级粘性降级；click/app_focus/keypress 防抖映射和默认配置全表 | `ActivityStore` fallback capture、快照文件、hash/diff、storage tier、输入触发和敏感应用门禁已覆盖；仍未接入原始 unix socket 守护进程链 | `tests/activity-recorder.test.ts`, `tests/activity-background.test.ts` | ⚠️ 参考实现 行为仍存在逆向缺口 |
| OCR frames | OCR frame schema、文本/模型/维度字段 | OCR frame 持久化、迟到 OCR 使 session 回到 pending；同一 snapshot 重复 OCR 保持单 frame | `tests/activity-recorder.test.ts`, `tests/activity-analyzer.test.ts` | ✅ 已完成 1:1 对齐 |
| activity embeddings | `notes/17-runtime-evidence.md` §3.3–3.4：5 分钟检查、4 帧批次、每轮最多 32 帧、批间 250ms、活跃时 30 秒重试、multilingual-e5-small、内联 BLOB、OCR 候选最多 5000 且结果最多 100 | `ActivityEmbeddingScheduler` 与 `precomputeActivityEmbeddings` 完整复刻上述窗口、模型限制、批次和失败重试；`embedding_model` 写模型 ID，`model_fingerprint` 单独保存运行时指纹；OCR 向量存储在 activity 表内，语义结果上限为 100 | `tests/activity-background.test.ts`, `tests/activity-semantic-search.test.ts`, `tests/activity-recorder.test.ts` | ✅ 已完成 1:1 对齐 |
| session aggregation | 相邻同应用 session 合并与 pending sweep | `mergePendingAdjacent()` 在分析 sweep 前执行 | `tests/activity-analyzer.test.ts` | ✅ 已完成 1:1 对齐 |
| activity LLM analysis | analysis schema、worth gate、failed/pending 状态 | `src/activity/analyzer.ts` 结构化解析、缓存、失败恢复和策略门禁 | `tests/activity-analyzer.test.ts`, `tests/activity-tools.test.ts` | ✅ 已完成 1:1 对齐 |
| worth_memory / worth_knowledge | 分析投影字段与长期记忆门控 | `activityMemoryInput()`、memory/knowledge 回调和 worth 门控 | `tests/activity-analyzer.test.ts`, `tests/activity-tools.test.ts` | ✅ 已完成 1:1 对齐 |
| activity → memories | 分析结果进入统一 memory pipeline | `src/activity/memoryPipeline.ts` 被桌面 Activity、`activity report`、`activity serve` 和 `/api/activity-recorder/report/:date` 共用；写入普通 memory 并投影 Crystal | `tests/activity-analyzer.test.ts`, `tests/activity-http.test.ts`, `tests/activity-memory-pipeline.test.ts`, `tests/memory-lifecycle.test.ts` | ✅ 已完成 1:1 对齐 |
| daily report | `notes/18-deep-dive-seven.md` §2：唯一自动入口是 recorder 启动 2 分钟首查 + 15 分钟 timer；另有 bundled skill、CLI、REST，CronService 无预置种子 | `ActivityRecorderService` 已按 2 分钟/15 分钟生成统计与 narrative；CLI/REST/activity 工具已有，仍未复刻 bundled daily-report skill 的全文和直接粘贴/fallback 协议 | `tests/activity-background.test.ts`, `tests/activity-analyzer.test.ts`, `tests/activity-recorder.test.ts`, `tests/daily-notes.test.ts` | ⚠️ 参考实现 行为仍存在逆向缺口 |
| crystal_terms | Crystal DDL、term 计数/回合/线程/日期跨度 | `CrystalStorage` 与 `CrystalService.recordTerms()` | `tests/crystal-memory.test.ts` | ✅ 已完成 1:1 对齐 |
| crystals state machine | `notes/17-runtime-evidence.md` §4.1：agent 填 checklist，confirm 闸门校验，candidate→formal、slot 释放、dormant/wakeup | `CrystalService` 阈值晋级、材料累积、checklist 校验、confirm formal、slot 释放和 dormant/wakeup；prefill 是额外入口，不替代闸门 | `tests/crystal-memory.test.ts`, `tests/crystal-http.test.ts` | ✅ 已完成 1:1 对齐 |
| crystal_materials | material 唯一键和来源类型 | `CrystalStorage.addMaterial()`、turn/bundle/memory/activity material | `tests/crystal-memory.test.ts` | ✅ 已完成 1:1 对齐 |
| crystal_bundles | `notes/17-runtime-evidence.md` §4.1：无自动 bundle merge，仅手动 POST 创建与材料关联 | `CrystalStorage` bundle CRUD、HTTP 手动创建、seed material 关联；没有自动合并分支 | `tests/crystal-memory.test.ts`, `tests/crystal-http.test.ts` | ✅ 已完成 1:1 对齐 |
| crystal_processed_anchors | 全局 anchor 幂等 claim | 成功完成材料/term 处理后再 `markAnchorProcessed()`；失败不占用 anchor，重复处理仍幂等 | `tests/crystal-memory.test.ts`, `tests/memory-lifecycle.test.ts` | ✅ 已完成 1:1 对齐 |
| crystal semantic scan | `notes/17-runtime-evidence.md` §4.1：seed 语义扫描点积阈值为 `≥ 0.62`，并执行 dormant sweep | `CrystalService.processAnchor()`、seed vector cache、`≥ 0.62` 点积材料关联和 dormant sweep | `tests/crystal-memory.test.ts` | ✅ 已完成 1:1 对齐 |
| crystal agent context | crystal search/detail 与 prompt 注入 | `AgentSession` context builder、Crystal search/detail | `tests/context.test.ts`, `tests/crystal-memory.test.ts` | ✅ 已完成 1:1 对齐 |
| crystal management HTTP surface | Crystal 14 条管理路由清单与交互式表单证据；原始 bundle/routes 清单使用 `/confirm` | `src/agent/context/crystalHttp.ts` 提供 overview/config/bundles/seeds 及 crystal id 下的 slot/dormant/type/checklist/material/prefill/validate/confirm/cancel/detail 路由；由 `activity serve` loopback server 挂载，配置通过版本化配置存储写回 | `tests/crystal-http.test.ts` | ✅ 已完成 1:1 对齐 |
| USER.md | 用户画像文件读取、写入、来源和上下文注入 | `fileMemory.ts`、`identityStorage.ts`、显式身份存储入口、Agent context 注入；自动记忆提取不会隐式改写用户画像 | `tests/identity.test.ts`, `tests/file-memory-reflection.test.ts` | ✅ 已完成 1:1 对齐 |
| daily memory files | `memory/YYYY-MM-DD.md` 的日期文件层 | `fileMemory.ts`、daily note writer、context 读取 | `tests/daily-notes.test.ts`, `tests/file-memory-reflection.test.ts` | ✅ 已完成 1:1 对齐 |
| emotions | `notes/18-deep-dive-seven.md` §3：Telegram 群/私聊尾部 per-chat 5 秒防抖、最近 10 条×150 字、tool 模型 50 token、`mood\|valence\|reason` 写 `context/<chatId>.md`；本地 CLI/base/context 与 heartbeat 3h 仍在 | `EmotionStorage` 兼容无 energy 的 context 文件；`biny emotion status/set-base/set-context/get` 直写本地文件并接入上下文；缺少 Telegram 5 秒自动分析渠道 | `tests/emotion.test.ts`, `tests/context.test.ts` | ⚠️ 参考实现 行为仍存在逆向缺口 |
| self-reflection | `notes/17-runtime-evidence.md` §5.2、`notes/18-deep-dive-seven.md` §4：23 点/3 天补写、`diary/<UTC>.md` 或死代码 marker 判定、158 行 skill 写 `memory/<date>.md`；生产已有 7 篇 memory 日记且存在路径不匹配缺陷 | `selfReflection.ts`、每日 reflection 投影和 source-hash 幂等写回；没有原始 diary/UTC marker、skill prompt 和完整输入链，也不复刻发布包的路径不闭环行为 | `tests/file-memory-reflection.test.ts` | ⚠️ 参考实现 行为仍存在逆向缺口 |
| heartbeat | `notes/18-deep-dive-seven.md` §5：header、群巡逻、基础情绪、日记/补写、旅行、任务回顾 6 个 block；tool 模型失败换主模型；`settings.heartbeat.threadId` 持久绑定并跨工作区迁移 | `HEARTBEAT.md`、`heartbeat.ts` scheduler/runtime 已有基础情绪和日记提示；缺少群巡逻、旅行、任务回顾、应答重试和持久 thread binding | `tests/heartbeat.test.ts` | ⚠️ 参考实现 行为仍存在逆向缺口 |
| cron / cleanup | `notes/18-deep-dive-seven.md` §6：13 字段 jobs.json、6 字段 runs.json、100 条保留、Intl 时区持久化、main/isolated 双模式、REST/CLI/skill/直读注册且无种子 | Biny 使用 SQLite-backed AutomationScheduler 和显式 automation 入口；未复刻 JSON jobs/runs 协议、双执行模式及全部注册面 | `tests/cli-multi-session.test.ts`, `tests/memory-lifecycle.test.ts` | ⚠️ 参考实现 行为仍存在逆向缺口 |
| chat/thread/context integration | thread → context → memory/crystal/file/activity → response → extraction | `AgentSession` context builder、post-turn extraction 和 anchor scan | `tests/context.test.ts`, `tests/memory-lifecycle.test.ts`, `tests/crystal-memory.test.ts` | ✅ 已完成 1:1 对齐 |
| restart / persistence | SQLite WAL、文件层和重启后继续处理 | storage initialize/close、run recovery、processed anchor 和 file memory | `tests/memory-v2.test.ts`, `tests/memory-lifecycle.test.ts`, `tests/crystal-memory.test.ts` | ✅ 已完成 1:1 对齐 |
| migration | `notes/18-deep-dive-seven.md` §7：旧版本迁移链 | 旧库导入入口和旧 schema 兼容层已删除；当前只初始化现行 schema，旧数据库需清除后重建。未保留旧版本迁移实现 | `tests/memory-lifecycle.test.ts` | ⚠️ 旧版本迁移按当前方向明确移除 |
| errors / privacy / isolation | fail-closed、workspace 隔离、敏感字段处理 | 保留 CAS、revision、lineage、archive、redaction、workspace 过滤和错误恢复；Sleep 不跨工作区去重，Activity URL 去除凭据/查询/片段 | `tests/memory-v2.test.ts`, `tests/activity-privacy.test.ts`, `tests/activity-recorder.test.ts`, `tests/context.test.ts` | ✅ 已完成 1:1 对齐 |

## ER 关系

当前关系按“真实 SQL 外键”和“逻辑引用”区分，不根据表名推断外键：

```text
memory.sqlite
├── memories
│   ├── memory_embeddings (vec0；由应用维护 memory_id 投影)
│   ├── memory_vectors / memory_vector_entry_states
│   ├── memory_archive
│   └── memory_sleep_runs
├── crystal_terms ── crystals.term_id（逻辑引用）
├── crystals ── crystal_materials（逻辑引用）
├── crystal_bundles
└── crystal_processed_anchors

activity.sqlite
├── activity_sessions
│   ├── activity_events（TEXT PK；FK，ON DELETE CASCADE）
│   ├── activity_snapshots（TEXT PK/event_id；FK，ON DELETE CASCADE）
│   │   └── activity_ocr_frames（TEXT PK/snapshot_id；FK，ON DELETE CASCADE）
│   ├── activity_session_analysis（FK，ON DELETE CASCADE）
│   └── activity_summaries
├── activity_analysis_embeddings
└── activity_fts

文件层：USER.md、MEMORY.md、memory/YYYY-MM-DD.md、emotions、HEARTBEAT.md
```

原始约束中，`memories.thread_id` 使用 `SET NULL`；`message_id` 和 `user_id` 没有同等 SQL 外键；`memory_embeddings.memory_id` 是向量表主键；Activity 的事件、snapshot、OCR 和分析行使用级联删除；Crystal 五表没有 SQL 外键，依靠应用层幂等与逻辑引用维护。

## Biny 扩展

以下能力不是原始记忆协议的替代物，而是保留的工程增强：CAS/revision、lineage、workspace 隔离、可恢复 archive、fail-closed 隐私门禁、向量 generation/rebuild lock、敏感信息脱敏，以及 `MEMORY.md`/`HEARTBEAT.md` 文件投影。它们不改变核心表、状态机或 Agent context 的数据来源。

## 有界消融记录

临时移除了 `analyzePendingActivitySessions()` 中的 `mergePendingAdjacent()` 调用，并把现有 Activity sweep 测试改为验证分析入口的合并结果。运行 `pnpm exec tsx tests/activity-analyzer.test.ts` 后，断言由期望 `evaluated=1` 变为实际 `2`，测试失败；恢复调用后同一测试通过。因此该调用是当前 Activity 生命周期的必要边界，已保留，临时测试改动也已恢复。

临时移除了 Sleep 相似度扫描的用户命名空间分组，只保留单一扫描。运行 `pnpm exec tsx tests/memory-v2.test.ts` 后，`testSleepSimilarityUsesUserNamespaces` 的处理数由期望 `2` 变为实际 `1`，测试失败；恢复分组后 memory-v2 与 retriever 定向测试均通过。因此该分组是当前隔离和处理统计边界的必要部分，已保留。

临时移除了 Activity 统一投影中的 `onAnalyzed` 调用，只保留 Activity memory 写入。运行 `pnpm exec tsx tests/activity-memory-pipeline.test.ts` 后，`crystal_terms` 的累计次数由期望 `2` 变为实际 `undefined`，测试失败；恢复回调后 Activity→Crystal 的幂等投影测试通过。因此该回调是 Activity 进入主题沉淀层的必要边界，已保留。

临时移除了 Activity HTTP 报告把 `writeMemories` 和 `onAnalyzed` 传入分析器的两个回调。运行 `pnpm exec tsx tests/activity-http.test.ts` 后，报告仍生成但统一 memory 回调次数由期望 `1` 变为实际 `0`，测试失败；恢复接线后 HTTP 报告回写测试通过。因此 loopback 报告入口不能绕过统一记忆管线，两个回调均已保留。

临时把 Activity session 的 `started_at` 转换替换为当前时间，运行 `pnpm exec tsx tests/activity-recorder.test.ts` 后，日报/快照断言中的 session 开始时间变为当前时间而不是输入时间，测试失败；恢复 epoch-ms 转换后测试通过。因此 session 时间列的规范化不是可省略的展示层细节，已保留在存储入口。

临时移除 Sleep 批次失败时的 `runStatus = "failed"`，运行 `pnpm exec tsx tests/memory-v2.test.ts` 后，失败回归中的 run 状态错误变为 `completed`；恢复该状态转移后测试通过。因此失败统计不能替代 Sleep run 的失败状态，已保留。

临时移除了 `handleActivityHttpRequest()` 中的 Crystal 路由分发，运行 `pnpm exec tsx tests/crystal-http.test.ts` 后首个 overview 请求由期望的 200 变为 404；恢复分发后 Crystal HTTP 专项测试通过。因此路由挂载是管理面可用性的必要边界，已保留。

临时把 Activity 新建表的事件、snapshot 和 OCR 主键及引用改回整数类型，并跳过旧库的文本 ID 重建；运行 `pnpm exec tsx tests/activity-recorder.test.ts` 后 schema 回归首先在 `activity_events.id` 的类型断言失败，恢复文本主键和迁移入口后 Activity 专项通过。因此文本 ID 与级联引用不是类型层面的可选实现，已保留。

临时移除 Sleep 单条 synthesis 失败后的继续分支，运行 `pnpm exec tsx tests/memory-v2.test.ts` 后 `testSleepSynthesisArchivesCluster` 的失败计数由期望 `0` 变为 `1`；恢复后新增的全簇删除/合成失败测试通过，归档仍保留且 `mergedInto` 为空。因此该逐条容错边界是原始 Sleep 归档语义所必需的，已保留。

临时移除 Runtime Host 启动时的状态恢复调用，运行 `pnpm exec tsx tests/runtime-host-maintenance.test.ts` 后启动阶段的 `load` 调用由期望 `['load']` 变为空数组；恢复后未到计划时间的启动恢复测试通过。因此 heal 必须位于 due 判断之前并由 `start()` 触发，已保留。

临时让 emotion context 解析重新强制要求 `energy`，运行 `pnpm exec tsx tests/emotion.test.ts` 后无 energy 的 context 文件读取由期望的触发原因变为 `undefined`；恢复可选 energy 和 base energy fallback 后情绪专项通过。因此 context 文件兼容规则是存储协议的一部分，已保留。

临时让 OCR embedding 的 `embedding_model` 继续写入 fingerprint，运行 `pnpm exec tsx tests/activity-recorder.test.ts` 后字段断言由 `multilingual-e5-small` 变为测试 fingerprint；恢复模型 ID 与 fingerprint 分列后 Activity 专项通过。因此两列的语义边界不是冗余抽象，已保留。

临时把语义 Activity 结果上限从 100 降回 20，运行 `pnpm exec tsx tests/activity-semantic-search.test.ts` 后 21 条候选只返回 20 条；恢复 100 上限后专项通过。因此 OCR 语义 top-K 上限是协议行为，已保留。

临时把 `ActivityRecorderService` 的日报默认周期从 15 分钟改回 24 小时，运行 `pnpm exec tsx tests/activity-background.test.ts` 后默认周期测试在等待第二次日报时超时失败；恢复 15 分钟后该专项通过。因此 15 分钟不是可省略的配置偏好，而是自动日报入口的已确认调度行为，已保留。

## 验证记录

- `pnpm typecheck`：通过。
- `pnpm test`：通过，包含 `tests/crystal-http.test.ts`、`tests/activity-memory-pipeline.test.ts`、`tests/memory-lifecycle.test.ts`、`tests/emotion.test.ts` 和 `tests/emotion-runtime.test.ts`。
- `pnpm exec tsx tests/activity-analyzer.test.ts`：通过（恢复消融后）。
- Activity 专项、Crystal、Crystal HTTP、memory lifecycle、context、emotion、identity、daily notes、chat diary、embedding runtime、config、旧 schema 门禁：通过。
- `pnpm lint`：通过；4 个既有 lint warning，无 error。
- `pnpm build`：通过；CLI、Activity sidecar 和 Desktop 均完成构建，Swift 编译仅有既有 Sendable warning。
- `git diff --check`：通过。

## 当前 ⚠️ 的解释

⚠️ 只用于记录证据已充分但仍未复刻的外部边界，不代表以相似实现冒充完成。当前未对齐的边界是：原生截图 unix socket 守护链、bundled daily-report skill 协议、Telegram 情绪自动分析、原始 Reflection marker/skill 链、Heartbeat 完整 block/thread binding，以及 JSON cron 双执行协议。旧版本迁移和旧记忆导入已按当前方向删除；旧库不再兼容，清除后由现行 schema 重建。Sleep 的生产库没有 failed/interrupted/similarity_merge 样本，Crystal formal/bundle 没有生产样本，但原始代码、故障注入测试和持久状态路径已覆盖，因此这些样本缺口不单独标成未实现。
