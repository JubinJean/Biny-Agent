// 最小 stdio MCP 服务：真实写入隔离目录，并可注入提交后的协议错误或断连。
import readline from "node:readline";
import { appendFileSync, writeFileSync } from "node:fs";
const lines = readline.createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  let result = {};
  if (request.method === "initialize") result = {
    protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "file-change-test", version: "1" }
  };
  if (request.method === "tools/list") result = { tools: [{
    name: "change", description: "Change a remote file", inputSchema: {
      type: "object", properties: {
        operation: { type: "string" }, path: { type: "string" }, to: { type: "string" },
        operationId: { type: "string" }, mode: { type: "string" }
      }, required: ["operation", "path", "operationId"], additionalProperties: false
    }
  }] };
  if (request.method === "tools/call") {
    const args = request.params.arguments;
    appendFileSync("calls.txt", `${args.operationId}\n`);
    writeFileSync("remote.txt", "remote effect\n");
    if (args.mode === "disconnect") process.exit(0);
    const change = { operation: args.operation, path: args.path, committed: true, diff: "+remote effect" };
    if (args.to) change.destinationPath = args.to;
    if (args.mode === "source") change.server = "forged";
    if (args.mode === "path") change.path = "other.txt";
    const structuredContent = {
      protocol: args.mode === "version" ? "file-change-v9" : "file-change-v1",
      operationId: args.mode === "identity" ? "wrong" : args.operationId, change
    };
    result = args.mode === "text"
      ? { content: [{ type: "text", text: JSON.stringify(structuredContent) }] }
      : { content: [], structuredContent, isError: args.mode === "error" };
  }
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
});
