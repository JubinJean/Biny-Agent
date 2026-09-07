/**
 * 主题沉淀层的持久化契约。
 *
 * term 记录跨回合出现的称呼及其来源，crystal 记录可继续补充材料的主题实体；两者都
 * 保留原始锚点引用，便于重复处理、回看和后续人工确认。
 */

export const crystalTypeFields = {
  entity: ["identity", "time", "participants", "source", "status"],
  concept: ["definition", "includes", "excludes", "examples", "source"],
  claim: ["statement", "scope", "supporting", "opposing", "status"],
  process: ["trigger", "inputs", "steps", "outputs", "failure_handling", "permissions"],
  rule: ["subjects", "conditions", "forbidden_allowed", "exceptions", "stop_conditions"],
  project: ["goal", "scope", "deliverables", "version", "source", "rights_status"]
} as const;

export type CrystalType = keyof typeof crystalTypeFields;
export type CrystalTermStatus = "latent" | "contour" | "nucleus";
export type CrystalOrigin = "seed" | "nucleus";
export type CrystalStage = "candidate" | "formal";
export type CrystalMaterialKind = "turn" | "bundle" | "note";
export type CrystalMaterialSource = "user" | "auto" | "auto-semantic";

export interface CrystalAnchor {
  threadId: string;
  anchorId: string;
  day: string;
  source?: "conversation" | "activity" | "memory";
}

export interface CrystalTerm {
  id: string;
  term: string;
  status: CrystalTermStatus;
  count: number;
  turnIds: string[];
  threadIds: string[];
  days: string[];
  occurrences: CrystalAnchor[];
  crystalId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CrystalChecklistItem {
  value: string;
  sources: string[];
  conflict?: boolean;
}

export type CrystalChecklist = Record<string, CrystalChecklistItem>;

export interface Crystal {
  id: string;
  origin: CrystalOrigin;
  stage: CrystalStage;
  name: string;
  type?: CrystalType;
  dormant: boolean;
  slot?: number;
  termId?: string;
  checklist: CrystalChecklist;
  notified: boolean;
  createdAt: string;
  updatedAt: string;
  formalAt?: string;
}

export interface CrystalMaterial {
  id: number;
  crystalId: string;
  kind: CrystalMaterialKind;
  ref: unknown;
  source: CrystalMaterialSource;
  createdAt: string;
}

export interface CrystalBundle {
  id: string;
  name?: string;
  threadId: string;
  anchorIds: string[];
  createdAt: string;
}

export interface CrystalConfig {
  passiveEnabled: boolean;
  semanticScanEnabled: boolean;
  contour: CrystalThreshold;
  nucleus: CrystalThreshold;
  dormantDays: number;
}

export interface CrystalThreshold {
  count: number;
  turns: number;
  spread: number;
}

export interface CrystalProcessResult {
  claimed: boolean;
  terms: string[];
  contoured: number;
  nucleated: Crystal[];
  woken: Crystal[];
  materialsAdded: number;
}

export interface CrystalOverview {
  types: CrystalType[];
  contourCount: number;
  slots: Crystal[];
  slotCapacity: 3;
  backpack: Crystal[];
  formal: Crystal[];
}

export const defaultCrystalConfig: CrystalConfig = {
  passiveEnabled: true,
  semanticScanEnabled: true,
  contour: { count: 4, turns: 3, spread: 2 },
  nucleus: { count: 8, turns: 5, spread: 2 },
  dormantDays: 14
};
