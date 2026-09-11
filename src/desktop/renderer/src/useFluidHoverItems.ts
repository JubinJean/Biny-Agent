/**
 * Fluid Functionalism 的菜单封装：在 useFluidHover 之上按 CSS 选择器自动注册选项。
 *
 * 菜单选项多以内联 JSX 书写，逐个拆组件注册成本高；这里监听容器子树变化，按 DOM
 * 顺序把匹配元素注册进 hook——搜索过滤、分组展开、挂载卸载都会自动重新注册并触发
 * 重测。禁用选项（disabled / aria-disabled）对悬停不可见，也不会被空隙点击路由。
 */
import { useEffect, useRef, type RefObject } from "react";
import { useFluidHover, type UseFluidHoverOptions, type UseFluidHoverReturn } from "./useFluidHover.js";

export function useFluidHoverItems<T extends HTMLElement>(
  containerRef: RefObject<T | null>,
  itemSelector: string,
  options: UseFluidHoverOptions = {}
): UseFluidHoverReturn {
  const hover = useFluidHover(containerRef, {
    ...options,
    // 默认跳过禁用项；调用方传入的 isItemDisabled 优先。
    isItemDisabled:
      options.isItemDisabled ??
      ((element) =>
        element.getAttribute("aria-disabled") === "true" ||
        (element instanceof HTMLButtonElement && element.disabled))
  });
  const { registerItem } = hover;
  const registeredRef = useRef<HTMLElement[]>([]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const sync = (): void => {
      const items = [...container.querySelectorAll<HTMLElement>(itemSelector)];
      const previous = registeredRef.current;
      for (let index = 0; index < Math.max(previous.length, items.length); index++) {
        if (previous[index] !== items[index]) registerItem(index, items[index] ?? null);
      }
      registeredRef.current = items;
    };
    sync();
    // childList 变化（搜索过滤、分组展开）驱动重注册；属性变化（is-selected）
    // 不需要，注册集合不变。
    const observer = new MutationObserver(sync);
    observer.observe(container, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      for (let index = 0; index < registeredRef.current.length; index++) registerItem(index, null);
      registeredRef.current = [];
    };
  }, [containerRef, itemSelector, registerItem]);

  return hover;
}
