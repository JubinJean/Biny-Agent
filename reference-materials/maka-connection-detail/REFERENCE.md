# maka 连接详情页 → biny 复刻规格

来源：`/Volumes/T7/maka-agent/apps/desktop/src/renderer/settings/provider-connection-detail.tsx`
+ `settings-expandable-row.tsx` + `settings-section.tsx` + `styles/settings/rows.css`
+ 中文文案 `locales/settings-provider-copy.ts`（zhCopy.detail）

## 结构树（biny 弹窗壳内，区块语言照搬）

```
弹窗 header（biny 壳保留）
└─ VStack gap=32px（astryx gap=8 × 4px）
   ├─ DetailSection「连接」 说明：密钥只保存在本机。
   │  └─ 行组（无卡片、hairline 分隔、行无圆角）
   │     ├─ SettingsExpandableRow 模型密钥 | 值=尚未设置密钥/已设置 | [设置|更改 ghost sm]
   │     ├─ SettingsExpandableRow 服务地址 | 值=URL/服务商默认地址 | [更改 ghost sm]
   │     └─ SettingsExpandableRow API 格式 | 值=格式名 | [更改 ghost sm]   ← biny 特有，maka 无此行
   ├─ DetailSection「模型」 说明：这些模型会出现在任务的模型选择器里。
   │  ├─ MultiSelector（triggerDisplay=labels、hasSearch、hasSelectAll=全部启用、width=100%、isLabelHidden）
   │  └─ 按钮行 HStack gap=8：[测试连接 secondary] [更新模型目录 ghost] [添加模型 ghost]
   └─ DetailSection「删除连接」 说明：此操作不可撤销。
      └─ [删除 destructive]
```

## 逐参数表（实测自 maka 源码）

| 项 | 值 | 出处 |
| --- | --- | --- |
| 区块间距 | 32px（VStack gap=8，astryx 4px 步进） | provider-connection-detail.tsx:363 |
| DetailSection 布局 | Grid columns minWidth 320，columnGap 40 rowGap 16；弹窗宽度下单列：标题→说明→控件 | provider-connection-detail.tsx:970 |
| 区块标题 | Heading level 3 + supporting sm secondary 说明 + Divider | settings-section.tsx:107-123 |
| 行容器 | grid 单列、gap 0、行间 hairline `border-block-start: 1px solid var(--border)`、行无圆角 | rows.css:19-58 |
| 折叠行 | Item density=balanced（block padding 8px）、label 上 + value 下（supporting secondary 色、换行不截断）、右侧 end 槽 cap 宽度 | settings-section.tsx:154-177 |
| 行操作按钮 | ghost variant、size sm；文案 设置（未配置）/更改（已配置）/编辑（名称） | settings-expandable-row.tsx:120-127 |
| 展开态 | SettingsField：padding-block 12px；editor grid gap 12px：粗体 label + 控件 + 右下 [保存 primary][取消 ghost]；保存无改动时禁用 | settings-expandable-row.tsx:132-158 + rows.css:177-189 |
| 一次只展开一行 | editingRow 单值状态 | provider-connection-detail.tsx（biny 已实现） |
| 焦点管理 | 展开聚焦编辑器第一个控件；收起焦点回 trigger | settings-expandable-row.tsx:96-113 |
| 模型选择器 | MultiSelector：trigger 显示已选模型名（labels，非"N 个已选"）、搜索占位「搜索模型」、全选「全部启用」、空态「暂无可选模型，请先更新模型目录。」 | provider-enabled-model-manager.tsx |
| 模型按钮行 | 测试连接=secondary 在前；更新模型目录、添加模型=ghost 在后；间距 8px | provider-connection-detail.tsx:626-631 |
| 危险区 | 区块标题即「删除连接」、说明「此操作不可撤销。」、按钮文案只写「删除」（不重复"连接"）、destructive 实体按钮、独立成段 | provider-connection-detail.tsx:885-904 |

## 文案对照（zhCopy.detail → biny）

| maka | biny 改动前 | 采用 |
| --- | --- | --- |
| 连接 / 密钥只保存在本机。 | 凭证 / 凭证不会离开这台机器。 | maka |
| 尚未设置密钥 / 已设置 | 未设置 | maka |
| 服务商默认地址 | 未设置 | maka（有默认 baseUrl 时） |
| 这些模型会出现在任务的模型选择器里。 | 勾选后可被任务选择 · 共 N 个候选… | maka |
| 删除连接 / 此操作不可撤销。 / 删除 | 危险区 / 删除后不可恢复。 / 删除 | maka |
| 搜索模型 / 全部启用 | —（组件缺失） | maka |

## 明确不做（biny 数据结构不支持）

- 「名称」行：maka name/slug 分离可编辑；biny 连接名=providerAlias（slug），改名牵动全部模型引用，需存储迁移。
- 「高级请求设置」（自定义请求头/额外请求体）：DesktopModelConnection/DesktopModelConfigurationInput 均无 headers/body 字段，LLM 请求层 requestHeaders 只是构造函数。

## 降级/边界

- OAuth 连接无密钥行（biny 已有 usesOAuth 分支，保留）。
- 密钥眼睛按钮：biny 保留（maka PasswordInput 无 reveal；biny 的只对未保存的新输入可见，安全成立）。
- API 格式行为 biny 独有（relay 协议切换），保留在「连接」区末行。
