/** Vercel Agent 适配层共用的无状态值转换工具。 */
import type { SharedV4ProviderMetadata } from "@ai-sdk/provider";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function providerMetadata(value: unknown): SharedV4ProviderMetadata | undefined {
  return isRecord(value) ? value as SharedV4ProviderMetadata : undefined;
}
