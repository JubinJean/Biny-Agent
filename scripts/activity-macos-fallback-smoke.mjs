#!/usr/bin/env node
/**
 * 显式授权后的真实降级验收：临时 Swift 副本只替换原生截图调用为一次故障，
 * 其余协议、JPEG、去重和 Vision OCR 使用原实现，备用截图调用真实 Electron 实现。
 * 不写屏幕图像或 OCR 正文，不接触用户配置；临时二进制与隔离宿主目录在退出后删除。
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(scriptPath), "..");
const require = createRequire(import.meta.url);

if (process.platform !== "darwin" || process.env.BINY_ACTIVITY_MACOS_SMOKE !== "1") {
  console.log("SKIP: 仅在 macOS 且显式设置 BINY_ACTIVITY_MACOS_SMOKE=1 后执行真实屏幕验收。");
} else if (process.versions.electron) {
  const { app } = require("electron");
  const fixture = process.argv[process.argv.indexOf("--fixture") + 1];
  app.setPath("userData", path.join(fixture, "user-data"));
  app.dock?.hide();
  // Electron 要在入口模块加载结束后才发送 ready，不能用顶层 await 等它自身启动。
  void app.whenReady().then(async () => {
    await verifyFallback(fixture);
    app.exit(0);
  }).catch((error) => {
    console.error(error);
    app.exit(1);
  });
} else {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "biny-activity-native-fault-"));
  try {
    const source = await readFile(path.join(root, "native/activity-recorder/main.swift"), "utf8");
    const target = "return try await captureNativeScreen(maxWidth: maxWidth)";
    assert.equal(source.split(target).length, 2, "故障注入必须且只能替换一个原生调用点");
    await writeFile(path.join(fixture, "main.swift"), source.replace(target,
      'FileHandle.standardError.write(Data("BINY_NATIVE_FAILURE\\n".utf8))\n                throw NSError(domain: "BinySmokeFault", code: 1)'));
    await run("xcrun", ["swiftc", "-O", "-swift-version", "5", "-o", path.join(fixture, "activity-recorder"), path.join(fixture, "main.swift")]);
    // 只转译无其他本地依赖的正式 Electron 截图函数，不复制或仿造它的实现。
    const ts = require("typescript");
    const helper = await readFile(path.join(root, "src/desktop/electron/main/activityCapture.ts"), "utf8");
    await writeFile(path.join(fixture, "capture.cjs"), ts.transpileModule(helper, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
    }).outputText);
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    await run(require("electron"), [scriptPath, "--fixture", fixture], env);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
}

async function verifyFallback(fixture) {
  const { captureActivityDesktopScreen } = require(path.join(fixture, "capture.cjs"));
  const child = spawn(path.join(fixture, "activity-recorder"), [], { stdio: ["pipe", "pipe", "pipe"] });
  const exited = new Promise((resolve) => child.once("close", (code, signal) => resolve({ code, signal })));
  const messages = [];
  let failure;
  let nativeAttempts = 0;
  let captures = 0;
  let stderr = "";
  child.on("error", (error) => { failure = error; });
  child.stdin.on("error", (error) => { failure = error; });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
    nativeAttempts = stderr.split("BINY_NATIVE_FAILURE").length - 1;
  });
  const output = createInterface({ input: child.stdout });
  output.on("line", (line) => {
    const message = JSON.parse(line);
    if (message.type !== "desktop_capture") {
      // 验收不保存 AX 或输入事件，只保留核验 JPEG/OCR 所需的内存消息。
      if (["capture", "ocr", "status", "error"].includes(message.type)) messages.push(message);
      return;
    }
    void captureActivityDesktopScreen(message.maxWidth).then((image) => {
      send({ type: "desktop_capture_result", requestId: message.requestId, imageBase64: image.toString("base64") });
      captures += 1;
    }).catch((error) => {
      failure = error;
      send({ type: "desktop_capture_result", requestId: message.requestId, error: "本机备用截图失败" });
    });
  });
  try {
    send({ type: "start", desktopCaptureAvailable: true, settings: {
      enabled: true, visualPollMs: 0, browserPollIntervalMs: 0,
      inputMonitoringEnabled: false, ocrEnabled: true, ocrEveryNFrames: 1
    } });
    const status = await waitFor(() => messages.find((message) => message.type === "status"));
    assert.equal(status.screenRecordingGranted, true, "缺少系统权限不能算通过");
    send({ type: "capture" });
    const capture = await waitFor(() => messages.find((message) => message.type === "capture"));
    const jpeg = Buffer.from(capture.jpegBase64, "base64");
    assert.ok(jpeg.length > 100 && jpeg[0] === 0xff && jpeg[1] === 0xd8);
    assert.ok(capture.width > 0 && capture.height > 0 && capture.captureId);
    const ocr = await waitFor(() => messages.find((message) => message.type === "ocr" && message.captureId === capture.captureId));
    assert.ok(String(ocr.ocrText ?? "").trim().length > 0, "测试画面需要包含可识别文字");
    // 等过正式去抖窗口再取一次；即使同画面被去重，第二次也必须继续使用备用后端。
    await new Promise((resolve) => setTimeout(resolve, 4_100));
    const previousCaptures = captures;
    send({ type: "capture" });
    await waitFor(() => captures > previousCaptures);
    assert.equal(nativeAttempts, 1, "原生故障后不能每张截图重复尝试");
    console.log(JSON.stringify({ status: "fallback-ocr-ok", width: capture.width, height: capture.height,
      bytes: jpeg.length, ocrCharacters: String(ocr.ocrText).length, nativeAttempts, desktopCaptures: captures }));
  } finally {
    send({ type: "stop" });
    child.stdin.end();
    const timeout = setTimeout(() => child.kill("SIGTERM"), 5_000);
    const result = await exited;
    clearTimeout(timeout);
    output.close();
    assert.deepEqual(result, { code: 0, signal: null }, "验收后采集器必须正常退出");
    console.log(JSON.stringify({ status: "sidecar-stopped", exitCode: result.code }));
  }

  function send(command) {
    if (!child.stdin.destroyed && !child.stdin.writableEnded) child.stdin.write(`${JSON.stringify(command)}\n`);
  }

  async function waitFor(predicate) {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      if (failure) throw failure;
      const result = predicate();
      if (result) return result;
      if (child.exitCode !== null || child.signalCode !== null) throw new Error("采集器提前退出");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("等待真实 Activity 降级结果超时");
  }
}

async function run(command, args, env = process.env) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, env, stdio: "inherit", timeout: 60_000 });
    child.once("error", reject);
    child.once("exit", (code, signal) => code === 0 ? resolve() : reject(new Error(`验收子进程失败：${code ?? signal}`)));
  });
}
