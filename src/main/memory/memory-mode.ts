export type MemoryMode = "vector" | "summary" | "off";

let activeMemoryMode: MemoryMode = "vector";

export function normalizeMemoryMode(value: unknown): MemoryMode {
  return value === "summary" ? "summary" : value === "off" ? "off" : "vector";
}

export function isVectorMemoryEnabled(): boolean {
  return activeMemoryMode === "vector";
}

export function isSummaryMemoryEnabled(): boolean {
  return activeMemoryMode === "summary";
}

/** Existing RAG/L0/L1/L2 call sites remain vector-only. */
export function isMemoryEnabled(): boolean {
  return isVectorMemoryEnabled();
}

export function setMemoryMode(mode: MemoryMode): void {
  activeMemoryMode = mode;
}
