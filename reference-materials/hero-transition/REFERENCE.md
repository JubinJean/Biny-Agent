# 参考实现 首页 → 聊天 过场动画逆向规格

来源：`/Applications/参考实现.app/Contents/Resources/app.asar` → `out/renderer/assets/index-lxC0W_vd.js`（Main 组件）+ `x-BsqgF1LB.css` + `PluginNotificationListener-zpPfN7i5.js`（PromptInput 组件库）。
对应截图：深色主题首页（logo + 「今天聊点什么？」+ composer + 建议 pill）。

---

## 1. 首页布局（Main 组件）

```
<div class="flex h-full items-center justify-center overflow-y-auto">   <!-- 页容器（动画测量的参照系） -->
  <div class="mx-auto flex w-full max-w-2xl flex-col items-center px-8 py-12">  <!-- max-w-2xl = 672px -->
    <div class="hero-block">          <!-- 提交时整体 200ms 淡出 + pointer-events-none -->
      <img class="hero-fade mb-6 size-24" />                        <!-- logo 96×96 -->
      <h1  class="hero-fade mb-3 text-4xl font-semibold tracking-tight"
           style="font-family:'Slabo 27px',serif">今天聊点什么？</h1>
      <p   class="hero-fade mb-8 max-w-md text-sm text-muted-foreground">一个想法、半句话、一段粘贴——剩下交给 参考实现。</p>
    </div>
    <motion.div class="hero-fade" style="{ y: composerY, width: composerWidth }">  <!-- composer 包装层 -->
      <ChatComposer class="rounded-[calc(1.375rem+1px)] bg-muted/40 transition-colors duration-300" />
      <!--   ↑ bg-muted/40 是「首页限定」底色，滑动开始后 300ms 内褪成透明，与聊天页无缝衔接 -->
    </motion.div>
    <motion.div animate="{ height: showSuggestions ? contentHeight : 0, opacity: willLeave ? 0 : 1 }"
                transition="{ duration: 0.45, ease: [0.32,0.72,0,1] }" style="overflow:hidden">
      <div class="w-full pt-6 flex flex-wrap justify-center gap-1.5">  <!-- 建议 pill 区 -->
        …
      </div>
    </motion.div>
  </div>
</div>
```

- i18n key：`main.heroTitle` / `main.heroSubtitle` / `main.inputPlaceholder`（"随便说点什么…"）
- 建议 pill 数据来源：`useActivitySuggestions()` → SWR `/api/activity/suggestions` → `activityRecorderApi.getSuggestions()`（**由屏幕活动记录生成的工作建议**，不是最近会话标题）
- 加载中：4 个骨架 pill `h-7 w-28 animate-pulse rounded-full bg-muted/50`
- 建议区高度用 ResizeObserver 测量真实内容高度，0.45s ease 动画开合

## 2. 入场动画（首次渲染）

```css
@keyframes hero-fade { from { opacity: 0 } to { opacity: 1 } }
.hero-fade { opacity: 0; animation: .25s ease-out forwards hero-fade;
             animation-delay: var(--hero-delay, 0s); will-change: opacity; }

@keyframes hero-pop {
  0%   { opacity: 0; transform: translateY(6px) scale(.85); }
  60%  {             transform: translateY(0)   scale(1.04); }
  100% { opacity: 1; transform: translateY(0)   scale(1); }
}
.hero-pop { opacity: 0; animation: .42s cubic-bezier(.34,1.56,.64,1) forwards hero-pop;
            animation-delay: var(--hero-delay, 0s); will-change: transform, opacity; }

@media (prefers-reduced-motion: reduce) {
  .hero-fade, .hero-pop { opacity: 1; animation: none; transform: none; }
}
```

- logo / 标题 / 副标题 / composer：`hero-fade`，delay = 0（即时）
- 建议 pill：`hero-pop`，**阶梯 delay = 220ms + i × 70ms**（`pillsBase: 220, pillsStep: 70`）

## 3. 建议 pill 样式（utility 类原样照抄）

```
hero-pop suggestion-chip inline-flex max-w-full items-center justify-center truncate
whitespace-nowrap rounded-full border border-border/40 bg-muted/40 px-3 py-1
text-xs font-medium text-foreground/80
transition-all duration-200 ease-out
hover:-translate-y-px hover:border-border/70 hover:bg-muted hover:text-foreground hover:shadow-sm
focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50
active:translate-y-0 active:scale-[0.98]
disabled:pointer-events-none disabled:opacity-50
```

## 4. 提交过场（核心）

`submit()` 触发（`Main` 组件内）：

1. `setWillLeave(true)` — hero 块 200ms 淡出；建议区 opacity → 0（450ms）；输入框清空
2. `animateComposerToBottom(previewText)`（requestAnimationFrame 里测量）：

```js
const leftPad   = 0.75  * rootFontPx   // 12px
const rightPad  = 0.625 * rootFontPx   // 10px
const bottomPad = 0.75  * rootFontPx   // 12px
targetTop    = pageRect.bottom - bottomPad - composerRect.height
targetWidth  = pageRect.width - leftPad - rightPad
deltaY       = targetTop - composerRect.top + composerY.get()

// 用户气泡预览（submittedPreview）
previewFinalTop        = pageRect.top + 1.25 * rootFontPx          // 页面顶 + 20px
previewSlideUpDistance = composerRect.top - previewFinalTop        // 从 composer 顶边起滑
chatRightPadding       = 51 + 15 + 1                               // 67px（右侧栏开关区）
previewRightOffset     = max(0, innerWidth - pageRect.right) + 67
previewMaxWidth        = (pageRect.width - leftPad - 67) * 0.8

const tween = { type: 'tween', duration: 0.5, ease: [0.32, 0.72, 0, 1] }
animate(composerWidth, targetWidth, tween)
animate(composerY,     deltaY,      { ...tween, onComplete: resolve })
```

3. **同时**：`submittedPreview` 气泡以 fixed 定位渲染在最终落点，`initial {opacity:0, y:slideUpDistance}` → `animate {opacity:1, y:0}`，同样 0.5s / ease [0.32,0.72,0,1]
4. 并行执行 `createThread()` → `navigate(/thread/:id)`：聊天页 composer 本来就在底部同位置同尺寸，直接无缝接管；preview 气泡的位置/尺寸与真实用户消息一致，swap 无跳变
5. 失败回滚：`willLeave=false`、`submittedPreview=null`、恢复输入、`composerY.set(0)`、`composerWidth.set('100%')`

**曲线备忘**：`cubic-bezier(0.32, 0.72, 0, 1)` ≈ easeOutQuint 偏快出；时长 0.5s。两处（composer 下滑 + 气泡上滑）共用同一条曲线，视觉上像气泡「从输入框里升起来、输入框顺势沉到底部」。

### 用户气泡（preview 与真实消息同款）

```
fixed / 右对齐 / z-40
rounded-[24px_4px_24px_24px]          <!-- 右上 4px 尖角，其余 24px -->
bg-[var(--chat-user-bg)]              <!-- 浅色=--primary；深色=#2f3643 -->
text-[var(--chat-user-foreground)]    <!-- 深色=#f6f8fb -->
px-4 py-3 text-ui-base whitespace-pre-wrap break-words shadow-sm
```

## 5. Composer 结构（ChatComposer）

```
<div class="composer-shared relative">            <!-- view-transition-name: 参考实现-composer（当前 JS 未触发，仅 CSS 声明） -->
  <form class="relative w-full overflow-hidden rounded-[calc(1.375rem+1px)] border bg-background shadow-sm transition-colors">
    <!-- 拖拽态：border-primary border-dashed bg-primary/5 -->
    <!-- 圆角推导：1rem(提交按钮半径) + 0.375rem(工具栏内边距间隙) + 1px(边框) = 同心圆 -->
    <PromptInputAttachments />                       <!-- 附件条 -->
    <PromptInputTextarea placeholder="随便说点什么…" autoFocus />
    <div class="prompt-toolbar flex items-center justify-between p-1">
      <div class="flex items-center gap-1 min-w-0 p-1 -m-1 overflow-hidden
                  [&_button:first-child]:rounded-bl-[1rem]">   <!-- 左组，首个按钮左下圆角贴合 composer -->
        [GoalLoop]  [📎 附件]  [📁 工作区名]  <divider class="mx-0.5 h-4 w-px bg-border/70"/>
        [⚙ 能力]  [💡 Med]  [🖼 比例?]  [▦ 模型名⌄]
      </div>
      <div class="ml-auto flex shrink-0 items-center gap-1 pr-0.5">   <!-- 右组 -->
        [👁 无痕]  [🎙 语音]  [发送]
      </div>
    </div>
  </form>
</div>
```

### 工具栏按钮规格

- `.composer-action`（左侧 ghost 按钮）：`height 32px / min-width 32px / padding-inline 6px / gap 5px`，图标 `size-4`（16px），激活时带 `text-[11px] font-medium` 文字标签（如 Med）
- 推理档位缩写：`off→Off low→Low medium→Med high→High xhigh→XHigh max→Max ultra→Ultra`；`value!=="off"` 时显示标签且 `text-foreground/85`，否则 `text-muted-foreground`
- 档位列表用 HoverCard（openDelay 80ms / closeDelay 120ms）不是下拉
- 发送按钮 `.prompt-submit-button`：`32×32px rounded-full`；就绪 `bg-primary hover:bg-primary/85`；禁用 `bg-muted opacity-100`（实心灰圆不ghost）；流式/错误 `bg-destructive/10`
- 能力/工作区按钮仅当模型 `capabilities.functionCalling` 时渲染；💡仅当 `capabilities.reasoning`

## 6. 落地后（Chat 页）

- 消息区：左 padding 12px、右 padding 67px（51+15+1）、顶部 padding 20px —— 与 preview 气泡落点严格一致
- 用户消息入场：**无额外动画**（preview 已经滑到位了，真实消息原地 swap）
- 助手回复：流式正文带 `.streaming-cursor-caret`（primary 色，1.2s 脉冲 opacity .4→.9 + scaleY 1→1.05），新 token 块 `streamingTextReveal`（0.5s cubic-bezier(.22,1,.36,1)，opacity 0 + translateY(4px) → 归位）
- 聊天页 composer 容器 padding：`pl-3 pr-2.5 pb-3`（= 首页动画的 leftPad/rightPad/bottomPad）

## 7. 时序总表

| t(ms) | 事件 |
|---|---|
| 0 | 提交：hero 开始 200ms 淡出；建议区 450ms 淡出；清空输入 |
| 0 | rAF 测量，composer 开始下滑+收窄（500ms ease[.32,.72,0,1]） |
| 0 | 用户气泡从 composer 顶边位置上滑+淡入（同 500ms） |
| 0–300 | composer 包装层 muted 底色褪为透明 |
| ~500 | 动画完成 → navigate → 聊天页同位置接管 |
| 500+ | 助手流式回复（呼吸 caret） |
REFEEOF
echo "REFERENCE.md written: $(wc -l < /Users/think/CodingAgent/biny/reference-materials/hero-transition/REFERENCE.md) lines"