/** ScreenCaptureKit 失败时的桌面备用截图；只传本机内存，不落临时图、不请求额外权限。 */
import { desktopCapturer, screen, systemPreferences } from "electron";

export async function captureActivityDesktopScreen(maxWidth: number): Promise<Buffer> {
  if (systemPreferences.getMediaAccessStatus("screen") !== "granted") throw new Error("未获屏幕录制权限。");
  const display = screen.getPrimaryDisplay();
  const width = Math.min(maxWidth, Math.round(display.size.width * display.scaleFactor));
  const height = Math.max(1, Math.round(width * display.size.height / display.size.width));
  const sources = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width, height } });
  const source = sources.find((item) => item.display_id === String(display.id));
  if (!source || source.thumbnail.isEmpty()) throw new Error("无法读取主屏幕画面。");
  if (systemPreferences.getMediaAccessStatus("screen") !== "granted") throw new Error("屏幕录制权限已撤回。");
  return source.thumbnail.toPNG();
}
