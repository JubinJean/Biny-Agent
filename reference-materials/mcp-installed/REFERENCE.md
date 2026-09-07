# 参考实现「MCP 服务器 · 已安装」界面逆向参数

来源：`/Volumes/T7/参考实现-reverse/asar/out/renderer/assets/`
- 组件：`PluginNotificationListener-Ddjbsf83.js`（MCPInstalledServers / 设置页 MCP 节）
- 文案：`x-CSJ5-D3V.js`（i18n key `settings.mcp.*`）
- 主题变量：`x-DUvk_eoT.css` `.dark` 块（One Dark 系）
- 视觉基准：用户提供的 参考实现 截图（已安装 tab）

## 结构树（含实测 className）

```
div.space-y-4                                   # 页面容器
├─ div                                          # 标题区（biny 落地时用设置弹窗统一 header 替代）
│   ├─ h2.text-lg.font-medium        "MCP 服务器"
│   └─ p.text-sm.text-muted-foreground  "管理模型上下文协议 (MCP) 服务器以扩展 AI 能力"
└─ Tabs.w-full
    ├─ TabsList.grid.w-full.grid-cols-2         # 通栏分段控件
    │   ├─ TabsTrigger(value=marketplace).flex.items-center.gap-2   [Store 16px] 应用市场
    │   └─ TabsTrigger(value=installed).flex.items-center.gap-2     [Server 16px] 已安装
    └─ TabsContent(value=installed).mt-4
        └─ div.space-y-4
            ├─ div.flex.items-center.justify-between.pr-4    # 计数行
            │   ├─ p.text-sm.text-muted-foreground  "已安装 N 个服务器" / "未安装 MCP 服务器"
            │   └─ Button(default).h-9              [Plus 16px mr-1] 添加服务器
            └─ 空态: div.text-center.py-12.text-muted-foreground
            │      [Server 48px opacity-50] + p "从应用市场安装服务器或手动添加"
                列表: OverflowContainer.h-[400px].pr-4 > div.space-y-3
                └─ Card.gap-2.py-4  (每张服务器卡片)
                    ├─ CardHeader.pb-0
                    │   └─ div.flex.items-start.justify-between
                    │       └─ CardTitle.text-base.flex.items-center.gap-2
                    │           ├─ {server.name}
                    │           └─ 状态 Badge（见下）
                    ├─ CardContent.pt-0
                    │   └─ div.flex.items-center.justify-between
                    │       ├─ code.text-xs.bg-muted.px-2.py-1.rounded   command + args(灰色)
                    │       └─ div.flex.items-center.gap-1               # 图标按钮组
                    │           ├─ [非 connected] Button.ghost.icon.h-8.w-8  PlugZap 14  重连
                    │           ├─ Button.ghost.icon.h-8.w-8  Settings 14  编辑
                    │           └─ Button.ghost.icon.h-8.w-8.text-muted-foreground.hover:text-red-500  Trash2 14  删除
                    └─ [lastError] div.mt-2.p-2.bg-red-500/10.border.border-red-500/20.rounded.text-xs.text-red-500
                        [CircleAlert 12px] {错误文本}
```

## 逐参数表

### 主题色（.dark）
| token | 值 |
|---|---|
| --background | #282c34 |
| --foreground | #dcdfe4 |
| --card | #21252b |
| --primary | #61afef |
| --primary-foreground | #0c111a |
| --secondary | #3e4451 |
| --muted | #3b404c |
| --muted-foreground | #8b92a4 |
| --border | #3e4451 |
| --destructive | #b56b6f |
| --radius | 10px (.625rem) |
| --radius-sm | 6px |

### Tabs 分段控件
- TabsList: `flex justify-center rounded-[calc(6px+0.25rem)=10px] bg-muted p-1(4px) text-muted-foreground`；页面用法 `grid w-full grid-cols-2`（两等分通栏）
- TabsTrigger: `inline-flex items-center justify-center whitespace-nowrap rounded-sm(6px) px-3 py-1.5(6px) text-sm(14px) font-medium transition-all`
  - active: `bg-background text-foreground shadow-sm`
  - 图标 16px，图标-文字间距 gap-2(8px)

### 添加服务器按钮（Button variant=default, h-9）
- `inline-flex items-center justify-center gap-2 rounded-xl(≈14px) text-sm font-medium shadow-xs`
- `bg-primary text-primary-foreground hover:bg-primary/90`
- 尺寸 `h-9(36px) px-4(16px)`；Plus 图标 16px + mr-1

### 服务器卡片（Card className="gap-2 py-4"）
- 基础: `bg-card text-card-foreground flex flex-col rounded-xl(≈14px) border shadow-sm`，覆盖后 `py-4(16px) gap-2(8px)`
- CardHeader: 基础 `grid items-start gap-1.5 px-6(24px)` + 覆盖 `pb-0`
- CardTitle: `text-base(16px) flex items-center gap-2(8px)`，font-semibold
- CardContent: 基础 `px-6` + 覆盖 `pt-0`
- 卡片间距: space-y-3(12px)

### 状态 Badge（已连接）
- 基础: `inline-flex items-center rounded-full border px-2.5(10px) py-0.5(2px) text-xs(12px) font-semibold`
- connected: `text-emerald-600/80 border-emerald-600/30` → rgba(5,150,105,.8) / rgba(5,150,105,.3)
- 图标 CircleCheckBig 12px + mr-1
- connecting: variant=secondary（bg-secondary）+ LoaderCircle spin
- error: variant=destructive（bg-destructive 实心）
- disconnected: variant=outline + Server 图标

### 命令 code 块
- 代码实现：`text-xs(12px) bg-muted px-2 py-1 rounded(4px) max-w-[60%] truncate`，command 主色 + args `text-muted-foreground` 追加，单行省略
- ⚠️ 用户截图版本为**两行**（command 一行、args 一行）、灰框更高更宽。以截图为准：block 布局、每行 truncate、padding px-3 py-2、宽度 flex-1

### 图标按钮（ghost icon）
- `h-8 w-8(32px)`，图标 14px，`hover:bg-muted/50`
- 删除按钮: `text-muted-foreground hover:text-red-500`

### 错误条
- `mt-2 p-2 bg-red-500/10 border border-red-500/20 rounded text-xs text-red-500`
- CircleAlert 12px mt-0.5 + span.break-all

### 计数文字
- `text-sm(14px) text-muted-foreground`；容器 `flex items-center justify-between pr-4(16px)`

### 空态
- `text-center py-12(48px) text-muted-foreground`
- Server 图标 48px，`mx-auto mb-4 opacity-50`

## 降级/响应式
- 列表 OverflowContainer 固定高 400px + 滚动，右侧 pr-4 给滚动条留位
- code 块 truncate 防溢出；错误文本 break-all

## 落地 biny 的映射
| 参考实现 | biny |
|---|---|
| bg-background #282c34 | var(--biny-surface) |
| bg-card #21252b | var(--biny-surface-elevated) |
| bg-muted #3b404c（轨道/code块） | var(--biny-dark-surface-hover/#262626) 或 color-mix |
| text-muted-foreground | var(--biny-text-secondary/tertiary) |
| primary #61afef | var(--biny-focus) 系 |
| emerald-600/80 已连接 | var(--biny-success) |
| red-500 系 | var(--biny-danger) |
| biny 额外功能保留：启用开关、能力统计(工具/提示/资源/环境变量)、详情按钮、Remote/SSE 标识 | 融入 参考实现 版式：开关放标题行右侧，统计并入描述行 |
