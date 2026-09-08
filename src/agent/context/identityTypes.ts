/**
 * Agent 身份资料的共享契约。
 *
 * 用户资料是用户可审计的 Markdown canonical state。Agent 的核心人格由应用内置，不属于这里的可编辑文档。
 */

export const identityDocumentKinds = ["user"] as const;
export type IdentityDocumentKind = (typeof identityDocumentKinds)[number];

export interface IdentityDocument {
  kind: IdentityDocumentKind;
  content: string;
  revision: number;
  updatedAt: string;
  contentHash: string;
}
