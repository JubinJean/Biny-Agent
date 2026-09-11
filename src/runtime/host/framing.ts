/** JSONL 按帧限制字节数；socket 必须先 setEncoding("utf8")，由 Node 保留跨 chunk 的 UTF-8 字符。 */
import { runtimeHostMaxFrameBytes } from "./protocol.js";

export class RuntimeHostFrameDecoder {
  private parts: string[] = [];
  private bytes = 0;

  constructor(private readonly maxBytes = runtimeHostMaxFrameBytes) {}

  *push(chunk: string): Generator<string> {
    let start = 0;
    while (start < chunk.length) {
      const newline = chunk.indexOf("\n", start);
      const part = chunk.slice(start, newline < 0 ? undefined : newline);
      this.bytes += Buffer.byteLength(part, "utf8");
      if (this.bytes > this.maxBytes) throw new Error("Runtime Host frame is too large.");
      this.parts.push(part);
      if (newline < 0) return;
      const line = this.parts.join("").trim();
      this.parts = [];
      this.bytes = 0;
      if (line) yield line;
      start = newline + 1;
    }
  }
}
