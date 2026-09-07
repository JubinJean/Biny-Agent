# 连接详情弹窗 — 1:1 复刻 maka-agent `ConnectionDetail`

来源：`/Volumes/T7/maka-agent/apps/desktop/src/renderer/settings/provider-connection-detail.tsx`
+ `settings-expandable-row.tsx` / `styles/settings/rows.css` / `maka-tokens.css`

## 布局哲学（代码注释原文）

> "a row reports its state and carries one link, and only becomes a form when
> the user asks it to. A credential and an endpoint are set once and then read;
> a permanent input box for each was the page telling the user to fill in
> something that is already filled in."

## 结构树

```
弹窗内容（单列 VStack, gap=32px = --space-8）
├─ DetailSection「凭证」          标题 + 一句 supporting 说明
│   └─ 行组（无边框卡片，行间 hairline 1px / foreground 10%）
│       ├─ ExpandableRow 连接名称 → 值 + [编辑]
│       ├─ ExpandableRow 模型密钥 → 状态值 + [设置|更改]
│       ├─ ExpandableRow 服务地址 → URL(mono) + [更改]
│       └─ ExpandableRow API 格式 → 格式名 + [更改]   ← biny 保留（maka 由 providerType 定死）
├─ DetailSection「高级请求设置」
│   ├─ ExpandableRow 自定义请求头 → 已配置 N 个 + [编辑]
│   └─ ExpandableRow 额外请求体 → 已设置/未设置 + [编辑]
├─ DetailSection「模型」
│   ├─ MultiSelector（trigger 显示已选标签、搜索、全选）
│   └─ 按钮行 [测试连接 secondary] [更新模型目录 ghost] [添加模型 ghost]
└─ DetailSection「危险区」
    └─ [删除] destructive
```

## ExpandableRow 折叠态（核心行语言）

- **两行式**：label 行（13px semibold）在上，value 行（12.5px, foreground 74%）在下 —— 不是横排
- action 是右侧 ghost 小按钮（高 28px），垂直顶对齐（align="start"）
- 行 padding-block: 12px（--space-3），左右无 inset（edge-to-edge）
- 行间分隔：`border-block-start: 1px solid foreground@10%`（第 2..n 行）
- 行组首行上两角、末行下两角 radius 10px；行本身 radius 0
- value 过长：`overflow-wrap: anywhere`，右端 cap `min(320px, 62%)`

## ExpandableRow 展开态

- 整行换成编辑块：label(semibold) + 编辑器 + 右下 [保存 primary][取消 ghost]
- 编辑块 padding-block: 12px；内部 grid gap: 12px
- 保存仅在有改动时可点；取消丢弃草稿
- 焦点管理：展开聚焦第一个控件，收起焦点回 trigger
- 一次只开一行：开另一行 = 丢弃当前行草稿

## MultiSelector（模型管理）

- trigger：高 32px、radius 6px、1px border、surface-soft 底；内容=已选模型标签逗号分隔（不是"已选 N 个"），溢出省略；右侧 chevron
- popover：顶部搜索框（自动聚焦）→「全选」行 → checkbox 选项行；popover 宽=trigger 宽；列表 max-height 滚动
- 点选项即切换（乐观更新），不需要确认按钮；点外部/Esc 关闭
- 空目录：trigger 禁用 + "暂无可选模型，请先更新模型目录。"

## Token（maka 实测值 → biny 映射）

| maka | 值 | biny |
|---|---|---|
| --space-2 / 3 / 4 / 8 | 8 / 12 / 16 / 32px | 直接 px |
| --border | foreground 10% | var(--border) |
| --foreground-secondary | 74% ink | var(--text-secondary) |
| --radius-surface / control | 10 / 6px | 10 / 6px |
| --h-control-lg | 32px | 按钮/输入高 32px |
| section 间距 | VStack gap=32px | 32px |
| DetailSection 内 | 标题区 gap 2px，控件区 gap 16px | 同左 |

## 文案（maka zh）

凭证「凭证不会离开这台机器。」/ 高级请求设置「按需附加到每个请求。」/
模型「勾选后可被任务选择。」/ 危险区「删除后不可恢复。」
密钥状态值：已设置 / 尚未设置密钥；按钮：已设置→更改，未设置→设置
