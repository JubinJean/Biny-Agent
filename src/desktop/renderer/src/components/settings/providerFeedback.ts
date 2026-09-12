/** 服务商页仅呈现可读错误原因，移除 IPC 包装并隐藏常见凭据格式。 */
export function providerErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/^Error invoking remote method ['"][^'"]+['"]:\s*/i, "")
    .replace(/^(?:Error:\s*)+/i, "")
    .replace(/Bearer\s+[^\s,;"']+/gi, "Bearer [已隐藏]")
    .replace(/\bsk-[a-z0-9_-]+/gi, "[已隐藏]")
    .replace(/([?&](?:api[_-]?key|token|key)=)[^&\s]+/gi, "$1[已隐藏]")
    .trim() || "请求失败，请检查服务地址和连接设置后重试。";
}
