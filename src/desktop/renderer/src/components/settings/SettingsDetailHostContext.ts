/** 二级弹层挂到设置壳内，避开内容列的层叠/裁剪，并保留原生 Dialog 的焦点与主题边界。 */
import { createContext } from "react";

export const SettingsDetailHostContext = createContext<HTMLElement | null>(null);
