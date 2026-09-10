import { cp, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = path.resolve(projectRoot, process.argv[2] ?? "dist/bundled-skills");
await mkdir(path.dirname(target), { recursive: true });
await cp(path.join(projectRoot, "src", "bundled-skills"), target, { recursive: true, force: true });
