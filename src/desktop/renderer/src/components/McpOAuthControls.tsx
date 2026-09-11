/** 授权 URL 只保留在当前登录视图中；离开项目或关闭页面会取消等待中的登录。 */
import { useEffect, useRef, useState } from "react";
import type { DesktopMcpSnapshot } from "../../../protocol.js";
import { errorMessage } from "../app/desktopApi.js";

export function McpOAuthControls({ projectId, name, enabled, onChange }: {
  projectId?: string; name: string; enabled: boolean; onChange(snapshot: DesktopMcpSnapshot): void;
}): React.JSX.Element {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [authorizationUrl, setAuthorizationUrl] = useState<string>();
  const generation = useRef(0);
  const loginId = useRef<string | undefined>(undefined);
  useEffect(() => () => {
    generation.current += 1;
    if (loginId.current) void window.biny.mcpLoginCancel(loginId.current).catch(() => undefined);
  }, []);

  const login = async (): Promise<void> => {
    const current = ++generation.current;
    setBusy(true); setError(undefined);
    try {
      const pending = await window.biny.mcpLoginStart(projectId, name);
      if (current !== generation.current) { await window.biny.mcpLoginCancel(pending.id); return; }
      loginId.current = pending.id;
      setAuthorizationUrl(pending.url);
      await window.biny.openExternal(pending.url);
      const snapshot = await window.biny.mcpLoginFinish(projectId, name, pending.id);
      if (current === generation.current) onChange(snapshot);
    } catch (cause) {
      if (current === generation.current) setError(errorMessage(cause));
    } finally {
      if (current === generation.current) {
        if (loginId.current) await window.biny.mcpLoginCancel(loginId.current).catch(() => undefined);
        loginId.current = undefined; setBusy(false); setAuthorizationUrl(undefined);
      }
    }
  };
  const cancel = async (): Promise<void> => {
    generation.current += 1;
    try { if (loginId.current) await window.biny.mcpLoginCancel(loginId.current); }
    catch (cause) { setError(errorMessage(cause)); }
    finally { loginId.current = undefined; setBusy(false); setAuthorizationUrl(undefined); }
  };
  const logout = async (): Promise<void> => {
    const current = ++generation.current;
    setBusy(true); setError(undefined);
    try { const snapshot = await window.biny.mcpLogout(projectId, name); if (current === generation.current) onChange(snapshot); }
    catch (cause) { if (current === generation.current) setError(errorMessage(cause)); }
    finally { if (current === generation.current) setBusy(false); }
  };
  return <div className="biny-mcp-oauth-actions">
    {busy ? <><span role="status">正在等待授权…</span>{authorizationUrl ? <button type="button" onClick={() => void window.biny.openExternal(authorizationUrl).catch((cause) => setError(errorMessage(cause)))}>重新打开浏览器</button> : null}<button type="button" onClick={() => void cancel()}>取消</button></> : <><button disabled={!enabled} type="button" onClick={() => void login()}>登录授权</button><button type="button" onClick={() => void logout()}>清除登录</button></>}
    {error ? <p role="alert">{error}</p> : null}
  </div>;
}
