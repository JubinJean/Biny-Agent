/**
 * Fluid Functionalism 的 FluidHoverHighlight：一份绝对定位的高亮填充，
 * 在 useFluidHover 量测出的条目矩形之间做弹簧位移。
 *
 * 移植自上游 registry：Tailwind 类（pointer-events-none absolute left-0 top-0
 * bg-hover）换成 .biny-fluid-hover-highlight，由 styles/biny.css 提供；
 * className 仍原样追加，供调用方补圆角等覆盖样式。容器必须是 position:
 * relative（或其它定位上下文），圆角与层级归调用方管。
 */
import { motion, AnimatePresence, useReducedMotion, type Transition } from "framer-motion";
import { spring } from "../motionTokens.js";
import type { ItemRect, UseFluidHoverReturn } from "../useFluidHover.js";

/** 高亮从 hook 读取的字段：点亮索引、量测矩形、矩形是否就绪、指针会话。 */
export type FluidHoverSource = Pick<
  UseFluidHoverReturn,
  "activeIndex" | "itemRects" | "isMeasured" | "sessionRef"
>;

interface HighlightFromHook {
  /** useFluidHover 的返回值。高亮在 isMeasured 后落在 itemRects[activeIndex]， */
  /** 并以指针会话为 key 重新入场。 */
  hover: FluidHoverSource;
  /** 保留列表状态但不显示（弹层关闭、悬停关闭）。走退场淡出。 */
  hidden?: boolean;
  rect?: never;
  session?: never;
}

interface HighlightFromRect {
  /** 列表自行解析矩形时（统一的悬停范围）直接给矩形，坐标系同容器。null 隐藏。 */
  rect: ItemRect | null;
  /** useFluidHover 的 sessionRef.current。指针进入容器时自增，作为 key 让 */
  /** 高亮从 from ?? rect 淡入而不是从上一次的位置滑过来。 */
  session: number;
  hover?: never;
  hidden?: never;
}

export type FluidHoverHighlightProps = (HighlightFromHook | HighlightFromRect) & {
  /** 新会话淡入的起点。下拉菜单传当前选中行，导航菜单传当前路由。默认为矩形本身。 */
  from?: ItemRect | null;
  /** 圆角、层级等附加样式，合并到 biny-fluid-hover-highlight 之后。 */
  className?: string;
  /** 位移弹簧。默认 spring.fast；传 false 表示布局回流后原地吸附不做位移。 */
  /** 透明度淡入淡出恒为 0.08s。 */
  transition?: Transition | false;
};

const fade: Transition = { duration: 0.08 };
const snap: Transition = { duration: 0 };

/** 把量测矩形转成动画目标：位置走 transform，尺寸走布局。 */
export function toTarget(rect: ItemRect) {
  return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
}

/**
 * 解析位移过渡。减少动效偏好下保留淡出、去掉位移：动效更少更缓，而不是全无。
 */
export function resolveHighlightTransition(
  transition: Transition | false | undefined,
  reduceMotion: boolean
): Transition {
  const positional =
    transition === false || reduceMotion ? snap : (transition ?? spring.fast);
  return { ...positional, opacity: fade };
}

/** 解析出一组 props 对应的矩形与会话。 */
export function resolveHighlightSource(
  props: FluidHoverHighlightProps
): { rect: ItemRect | null; session: number } {
  if (props.hover) {
    const { activeIndex, itemRects, isMeasured, sessionRef } = props.hover;
    const rect =
      !props.hidden && isMeasured && activeIndex !== null
        ? (itemRects[activeIndex] ?? null)
        : null;
    return { rect, session: sessionRef.current };
  }
  return { rect: props.rect, session: props.session };
}

export function FluidHoverHighlight(props: FluidHoverHighlightProps) {
  const { from, className, transition } = props;
  const { rect, session } = resolveHighlightSource(props);
  // 直接读系统的减少动效媒体查询：未包 MotionConfig 的应用也能正确降级；
  // 已包的应用里 transform 会被再降一次，结果一致。
  const reduceMotion = useReducedMotion() ?? false;
  return (
    <AnimatePresence>
      {rect && (
        <motion.div
          key={session}
          data-slot="fluid-hover-highlight"
          // 钉在容器 padding 角上用 transform 位移，动画跑在合成器上；
          // 宽高是真实布局值，但只在目标尺寸变化时才变（多数列表从不变化）。
          className={"biny-fluid-hover-highlight" + (className ? ` ${className}` : "")}
          initial={{ opacity: 0, ...toTarget(from ?? rect) }}
          animate={{ opacity: 1, ...toTarget(rect) }}
          exit={{ opacity: 0, transition: spring.fast.exit }}
          transition={resolveHighlightTransition(transition, reduceMotion)}
        />
      )}
    </AnimatePresence>
  );
}
