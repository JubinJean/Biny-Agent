/** 国内/国际、普通 API/订阅必须识别到独立连接，避免保存时串用端点和凭据。 */
import assert from "node:assert/strict";
import test from "node:test";
import { catalogForConnection, providerAliasFor, providerCatalog } from "../src/desktop/renderer/src/providerCatalog.js";

const endpoints = [
  ["zhipu", "https://open.bigmodel.cn/api/paas/v4"],
  ["zhipu-coding-plan", "https://open.bigmodel.cn/api/coding/paas/v4"],
  ["zai", "https://api.z.ai/api/paas/v4"],
  ["zai-coding-plan", "https://api.z.ai/api/coding/paas/v4"]
] as const;

test("四个入口使用独立别名，保存和回显不会混淆站点或套餐", () => {
  const aliases = new Set<string>();
  for (const [id, url] of endpoints) {
    const entry = providerCatalog.find((item) => item.id === id)!;
    assert.equal(entry.baseUrl, url);
    const provider = providerAliasFor(entry, url);
    aliases.add(provider);
    assert.equal(catalogForConnection({ provider, providerType: entry.value }, `${url}/`)?.id, id);
  }
  assert.equal(aliases.size, endpoints.length);
});

test("已有兼容连接按完整地址识别，国际普通 API 不会误认成 Coding Plan", () => {
  for (const [id, url] of endpoints) {
    assert.equal(catalogForConnection({ provider: "api-z-ai", providerType: "openai-compatible" }, url)?.id, id);
  }
  assert.equal(catalogForConnection({ provider: "zai", providerType: "zai" })?.id, "zai");
});

test("别名不能把自定义地址误认成官方站点", () => {
  assert.equal(catalogForConnection({ provider: "zai-coding-plan", providerType: "openai-compatible" }, "https://relay.example/v1"), undefined);
  assert.equal(catalogForConnection({ provider: "api-z-ai", providerType: "openai-compatible" }), undefined);
  const custom = providerCatalog.find((item) => item.id === "openai-compatible")!;
  assert.equal(providerAliasFor(custom, "https://relay.example/v1"), "relay-example");
});
