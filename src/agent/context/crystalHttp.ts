/**
 * 主题沉淀层的本地 HTTP 投影。
 *
 * 路由只负责参数校验、错误映射和响应形状，实际状态转换全部交给 CrystalService
 * 与 CrystalStorage，保证命令行、对话运行时和 loopback API 共享同一套生命周期。
 */
import {
  CrystalNotReadyError,
  CrystalService,
  CrystalSlotsFullError,
  normalizeCrystalConfig,
  validateCrystal
} from "./crystalService.js";
import {
  defaultCrystalConfig,
  type CrystalChecklist,
  type CrystalConfig,
  type CrystalMaterialKind,
  type CrystalType
} from "./crystalTypes.js";

export interface CrystalHttpDependencies {
  service: CrystalService;
  getConfig(): CrystalConfig;
  setConfig?(config: CrystalConfig): Promise<void> | void;
}

export interface CrystalHttpRequest {
  method: string;
  pathname: string;
  searchParams?: URLSearchParams;
  body?: unknown;
}

export interface CrystalHttpResponse {
  status: number;
  body: unknown;
}

export async function handleCrystalHttpRequest(
  request: CrystalHttpRequest,
  deps: CrystalHttpDependencies
): Promise<CrystalHttpResponse | undefined> {
  const method = request.method.toUpperCase();
  const pathname = normalizePath(request.pathname);
  if (pathname !== "/api/crystal" && !pathname.startsWith("/api/crystal/")) return undefined;
  if (method === "OPTIONS") return { status: 204, body: undefined };

  try {
    if (pathname === "/api/crystal/overview" && method === "GET") {
      return { status: 200, body: deps.service.overview() };
    }
    if (pathname === "/api/crystal/config" && method === "GET") {
      return {
        status: 200,
        body: { config: deps.getConfig(), defaults: defaultCrystalConfig, seedSlots: 3 }
      };
    }
    if (pathname === "/api/crystal/config" && method === "PUT") {
      if (!deps.setConfig) return { status: 501, body: { error: "Crystal configuration is read-only." } };
      const config = normalizeCrystalConfig(asRecord(request.body));
      await deps.setConfig(config);
      return { status: 200, body: { config } };
    }
    if (pathname === "/api/crystal/bundles" && method === "GET") {
      const threadId = request.searchParams?.get("threadId") ?? undefined;
      return { status: 200, body: deps.service.storage.listBundles(threadId) };
    }
    if (pathname === "/api/crystal/bundles" && method === "POST") {
      const body = asRecord(request.body);
      const threadId = body.threadId;
      const anchorIds = body.anchorIds;
      if (typeof threadId !== "string" || !threadId || !Array.isArray(anchorIds) || anchorIds.length === 0) {
        return { status: 400, body: { error: "threadId and anchorIds are required" } };
      }
      const name = typeof body.name === "string" ? body.name.trim() || undefined : undefined;
      const bundle = deps.service.storage.insertBundle({
        threadId,
        anchorIds: anchorIds.map(String),
        name
      });
      return { status: 200, body: { id: bundle.id } };
    }
    if (pathname === "/api/crystal/seeds" && method === "POST") {
      const body = asRecord(request.body);
      if (typeof body.name !== "string" || !body.name.trim()) {
        return { status: 400, body: { error: "name is required" } };
      }
      const threadId = typeof body.threadId === "string" ? body.threadId : undefined;
      const bundleIds = stringArray(body.bundleIds);
      const anchorIds = stringArray(body.anchorIds);
      return {
        status: 200,
        body: deps.service.createSeed(body.name, { threadId, bundleIds, anchorIds })
      };
    }

    const route = crystalRoute(pathname);
    if (!route) return notFound();
    const id = decodePathPart(route.id);
    if (!id) return badRequest("crystal id 不能为空。");

    if (!route.action && method === "GET") {
      const detail = deps.service.detail(id);
      if (!detail) return notFound();
      return {
        status: 200,
        body: {
          ...detail.crystal,
          checklist: detail.crystal.checklist,
          materials: detail.materials,
          validation: detail.validation,
          checklistSpec: detail.checklistSpec,
          related: detail.related,
          termStats: detail.termStats
        }
      };
    }
    if (route.action === "slot" && method === "POST") {
      const body = asRecord(request.body);
      const rawSlot = body.slot;
      const slot = rawSlot === null || rawSlot === undefined ? null : Number(rawSlot);
      return { status: 200, body: deps.service.setSlot(id, slot) };
    }
    if (route.action === "dormant" && method === "POST") {
      const body = asRecord(request.body);
      return { status: 200, body: deps.service.setDormant(id, Boolean(body.dormant)) };
    }
    if (route.action === "type" && method === "POST") {
      const body = asRecord(request.body);
      return { status: 200, body: deps.service.setType(id, body.type as CrystalType) };
    }
    if (route.action === "checklist" && method === "PUT") {
      const body = asRecord(request.body);
      if (typeof body.field !== "string") return badRequest("field is required");
      const value = typeof body.value === "string" ? body.value : undefined;
      const sources = Array.isArray(body.sources) ? body.sources.map(String) : undefined;
      const conflict = typeof body.conflict === "boolean" ? body.conflict : undefined;
      return {
        status: 200,
        body: {
          ...deps.service.updateChecklist(id, body.field, { value, sources, conflict }),
          checklist: deps.service.detail(id)?.crystal.checklist ?? {}
        }
      };
    }
    if (route.action === "material" && method === "POST") {
      const body = asRecord(request.body);
      if (!isMaterialKind(body.kind) || !isObject(body.ref)) {
        return { status: 400, body: { error: "kind (turn|bundle|note) and ref are required" } };
      }
      const detail = deps.service.detail(id);
      if (!detail) return notFound();
      return { status: 200, body: { added: deps.service.addMaterial(id, body.kind, body.ref) } };
    }
    if (route.action === "prefill" && method === "POST") {
      const before = deps.service.detail(id);
      if (!before) return notFound();
      const result = await deps.service.prefill(id);
      const filled = Object.keys(result.checklist).filter((field) => {
        const previous = before.crystal.checklist[field]?.value.trim() ?? "";
        return !previous && result.checklist[field]?.value.trim();
      });
      return { status: 200, body: { checklist: result.checklist, filled } };
    }
    if (route.action === "validate" && method === "GET") {
      const detail = deps.service.detail(id);
      if (!detail) return notFound();
      return { status: 200, body: validateCrystal(detail.crystal) };
    }
    if (route.action === "confirm" && method === "POST") {
      const body = asRecord(request.body);
      const name = typeof body.name === "string" ? body.name : undefined;
      const checklist = isObject(body.checklist) ? parseChecklist(body.checklist) : undefined;
      return { status: 200, body: deps.service.confirm(id, { name, checklist }) };
    }
    if (route.action === "cancel" && method === "POST") {
      const body = asRecord(request.body);
      return { status: 200, body: deps.service.cancel(id, body.keepObserving !== false) };
    }
    return notFound();
  } catch (error) {
    return mapCrystalError(error);
  }
}

function crystalRoute(pathname: string): { id: string; action?: string } | undefined {
  const match = /^\/api\/crystal\/([^/]+)(?:\/(cancel|checklist|confirm|dormant|material|prefill|slot|type|validate))?$/u.exec(pathname);
  return match ? { id: match[1]!, action: match[2] } : undefined;
}

function mapCrystalError(error: unknown): CrystalHttpResponse {
  if (error instanceof CrystalSlotsFullError || error instanceof CrystalNotReadyError) {
    return {
      status: 409,
      body: error instanceof CrystalNotReadyError
        ? { error: error.message, validation: error.validation }
        : { error: error.message, code: error.code }
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/not found/u.test(message)) return { status: 404, body: { error: message } };
  if (/model is unavailable/u.test(message)) return { status: 503, body: { error: message } };
  if (/No materials to draw from|Materials have no readable text/u.test(message)) {
    return { status: 409, body: { error: message } };
  }
  if (/required|invalid|unknown|only seed|checklist/u.test(message)) {
    return { status: 400, body: { error: message } };
  }
  return { status: 500, body: { error: message } };
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return isObject(value) && !Array.isArray(value);
}

function isMaterialKind(value: unknown): value is CrystalMaterialKind {
  return value === "turn" || value === "bundle" || value === "note";
}

function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.map(String) : undefined;
}

function parseChecklist(value: Record<string, unknown>): CrystalChecklist {
  const checklist: CrystalChecklist = {};
  for (const [field, item] of Object.entries(value)) {
    if (!isObject(item)) continue;
    const sources = Array.isArray(item.sources) ? item.sources.map(String) : [];
    checklist[field] = {
      value: typeof item.value === "string" ? item.value : "",
      sources,
      conflict: item.conflict === true ? true : undefined
    };
  }
  return checklist;
}

function normalizePath(value: string): string {
  return value.length > 1 ? value.replace(/\/+$/u, "") : value;
}

function decodePathPart(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return "";
  }
}

function notFound(): CrystalHttpResponse {
  return { status: 404, body: { error: "not found" } };
}

function badRequest(message: string): CrystalHttpResponse {
  return { status: 400, body: { error: message } };
}
