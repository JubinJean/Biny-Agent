/** 通用设置：主题与界面字体。 */
import { NativeSelect } from "../NativeSelect.js";
import { useEffect, useState } from "react";
import type { DesktopFontPreference, DesktopThemePreference } from "../../../../protocol.js";
import { clampFontSize, MAX_FONT_SIZE, MIN_FONT_SIZE, SYSTEM_FONT_FAMILY } from "../../../../fontPreference.js";

const fontFamilyOptions: Array<{ value: string; title: string }> = [
  { value: SYSTEM_FONT_FAMILY, title: "系统默认" },
  { value: "PingFang SC", title: "苹方" },
  { value: "Hiragino Sans GB", title: "冬青黑体" },
  { value: "Noto Sans SC", title: "思源黑体" },
  { value: "Songti SC", title: "宋体" },
  { value: "Kaiti SC", title: "楷体" },
  { value: "Yuanti SC", title: "圆体" }
];

export function SettingsAppearance({ theme, onThemeChange, font, onFontChange }: {
  theme: DesktopThemePreference;
  onThemeChange(theme: DesktopThemePreference): void;
  font: DesktopFontPreference;
  onFontChange(font: DesktopFontPreference): void;
}): React.JSX.Element {
  // 字号输入允许中间态（比如清空后再输入），失焦或回车时才夹取并提交。
  const [sizeText, setSizeText] = useState(String(font.size));
  useEffect(() => {
    setSizeText(String(font.size));
  }, [font.size]);
  const commitSize = (): void => {
    const parsed = Number(sizeText);
    const next = Number.isFinite(parsed) && sizeText.trim() !== "" ? clampFontSize(parsed) : font.size;
    setSizeText(String(next));
    if (next !== font.size) onFontChange({ ...font, size: next });
  };
  const changeSize = (value: string): void => {
    setSizeText(value);
    const parsed = Number(value);
    if (Number.isInteger(parsed) && parsed >= MIN_FONT_SIZE && parsed <= MAX_FONT_SIZE && parsed !== font.size) {
      onFontChange({ ...font, size: parsed });
    }
  };
  const familyOptions = fontFamilyOptions.some((option) => option.value === font.family)
    ? fontFamilyOptions
    : [...fontFamilyOptions, { value: font.family, title: font.family }];
  return (
    <div className="settings-sections appearance-settings">
      <section className="appearance-card">
        <div className="setting-row" id="appearance-theme">
          <label htmlFor="appearance-theme-mode">主题</label>
          <NativeSelect id="appearance-theme-mode" onChange={(event) => onThemeChange(event.target.value as DesktopThemePreference)} value={theme}>
            <option value="system">跟随系统</option>
            <option value="light">浅色</option>
            <option value="dark">深色</option>
          </NativeSelect>
        </div>
        <div className="setting-row" id="appearance-font">
          <label htmlFor="appearance-font-family">界面字体</label>
          <NativeSelect
            id="appearance-font-family"
            onChange={(event) => onFontChange({ ...font, family: event.target.value })}
            value={font.family}
          >
            {familyOptions.map((option) => <option key={option.value} value={option.value}>{option.title}</option>)}
          </NativeSelect>
        </div>
        <div className="setting-row">
          <label htmlFor="appearance-font-size">字体大小</label>
          <div className="font-size-row">
            <input
              className="font-size-input"
              id="appearance-font-size"
              max={MAX_FONT_SIZE}
              min={MIN_FONT_SIZE}
              onBlur={commitSize}
              onChange={(event) => changeSize(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") commitSize();
              }}
              step={1}
              type="number"
              value={sizeText}
            />
            <span className="font-size-unit">px</span>
          </div>
        </div>
      </section>
    </div>
  );
}
