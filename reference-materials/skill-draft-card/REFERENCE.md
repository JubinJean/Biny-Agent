# 参考实现 技能提取聊天卡片 — 逆向参数

来源：/Volumes/T7/参考实现-reverse/asar/out/renderer/assets/index-D6nVdIyx.js（SkillExtractionCard 组件）+ x-CSJ5-D3V.js（i18n）。

## 挂载
- 渲染条件：assistant 消息下方，`skillExtraction && stage !== "skipped"` 才渲染；容器 `px-4 mt-2 max-w-[min(85%,640px)]`。
- 数据通道：WS `skill_extraction_progress` {threadId, messageId, stage, message, extractedSkill}，按 messageId 存 Map。
- 阶段：analyzing(0.3) → extracting(0.75) → saving(0.92) → done(1) / skipped。skipped 返回 null。
- done 时 extractedSkill = {id, name, description, path, action: "created"|"updated"}。

## 卡片结构（done 态）
```
motion.div  入场: {opacity:0, y:6, height:0} → {opacity:1, y:0, height:auto}  0.35s cubic-bezier(0.22,1,0.36,1)
└─ div.relative.rounded-lg.border.px-3.5.py-3
   │  done: border-border bg-muted/30；进行中: border-border/60 bg-muted/15；transition-colors 0.5s
   ├─ [done] 右上 X 关闭按钮：opacity 0→1 delay 0.4s；p-1 rounded text-muted-foreground/30 hover:text-muted-foreground
   └─ div.flex.items-start.gap-2.5
      ├─ 图标盒 size-7(28px) rounded-md flex center
      │    背景动画: done → fg 底 bg 字（反色）；进行中 → muted 底 muted-fg 字；0.4s easeOut
      │    图标: done → Check size-3.5 strokeWidth 2.5，入场 spring {scale:0,rotate:-45}→{1,0} stiffness 350 damping 18 delay 0.1
      │          进行中 → WandSparkles size-3.5 摇摆 rotate [0,-6,6,-3,3,0] 2.5s infinite easeInOut
      │    [done 瞬间] ScatterDots：6 个 size-1 圆点 bg-foreground/25，角度 i/6*360+rand*30，距离 12+rand*10px，delay rand*0.1，0.5s easeOut，700ms 后消失
      └─ div.flex-1.min-w-0.pr-4
         ├─ [进行中] 阶段文案 text-xs text-muted-foreground（AnimatePresence mode=wait，key=active-${stage}）
         │         + 进度条 mt-2 h-[2px] rounded-full bg-border/60，内条 h-full bg-foreground/20 width 0→progress*100% 1s cubic-bezier(0.22,1,0.36,1)
         └─ [done] motion.div {opacity:0,y:3}→{1,0} 0.25s delay 0.05，flex flex-col gap-1
              ├─ 标题 text-[11px] font-medium uppercase tracking-wide text-muted-foreground/60「技能已提取」
              ├─ 名称行 flex items-center gap-1.5 mt-0.5
              │    ├─ Sparkles size-3 text-foreground/40
              │    ├─ 技能名 text-sm font-medium truncate（打字机 35ms/字，光标 1.5px×13px bg-foreground/50 1s 闪烁）
              │    └─ 徽章 text-[10px] font-medium px-1.5 py-px rounded bg-foreground/5 text-foreground/50，opacity 0→1 delay 0.5「新建/更新」
              ├─ 描述 text-xs text-muted-foreground line-clamp-2 leading-relaxed，opacity 0→1 delay 0.6
              └─ [查看技能 →] 链接按钮 text-xs text-muted-foreground hover:text-foreground self-start，opacity 0→1 delay 0.8，ArrowRight size-3 hover 平移 0.5
```

## i18n（zh-CN）
title: 技能已提取 / analyzing: 正在分析对话中的可复用模式... / extracting: 正在生成新技能... / saving: 正在保存技能... / created: 新建 / updated: 更新 / viewSkill: 查看技能

## biny 适配差异
- 参考实现 提取后直接落盘（created/updated），卡片是纯通知；**biny 提取产出待审核草稿**，卡片是审核入口：
  标题「技能草稿待审核」，按钮「批准并安装 / 拒绝 / 在设置中查看」。
- biny 无 framer-motion：入场用 CSS transition（opacity + translateY + grid-rows 0fr→1fr），对勾弹入用 CSS keyframes（scale 0→1 rotate -45→0，cubic-bezier 回弹近似 spring 350/18），图标摇摆用 CSS keyframes。
- biny 事件通道：AgentHostEvent `skill.draft_created`（runtime emit → desktopIpc.event 广播 → useDesktopEventBridge），替代 参考实现 的 WS。
- 阶段简化：biny 提取是回合后一次性旁路任务，无进度阶段，卡片直接以待审核态出现。
