export interface EngineSessionSummary {
  sessionId: string;
  preview: string;
  lastActive: number;
  sizeBytes: number;
  isCurrent: boolean;
}

export interface ListEngineSessionsOptions {
  workingDirectory: string;
  currentSessionId?: string;
  limit?: number;
}
