/** 错误展示不能让 IPC 包装或凭据淹没真正原因。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { providerErrorMessage } from "../src/desktop/renderer/src/components/settings/providerFeedback.js";

test("去除远程调用包装并保留多行原因", () => {
  assert.equal(providerErrorMessage(new Error("Error invoking remote method 'desktop:model:fetch-catalog': Error: TLS failed\ncertificate expired")), "TLS failed\ncertificate expired");
  assert.equal(providerErrorMessage("Error invoking remote method 'fetch': Unauthorized"), "Unauthorized");
});
test("错误里的常见密钥与认证头脱敏", () => {
  const message = providerErrorMessage("Bearer secret-value sk-example-secret https://example.test?api_key=secret");
  assert.ok(!message.includes("secret"));
  assert.ok(message.includes("[已隐藏]"));
});
test("空错误提供可读提示", () => {
  assert.match(providerErrorMessage("Error: "), /请求失败/);
});
