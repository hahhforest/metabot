/**
 * Engine-neutral event protocol consumed by the bridge and card renderer.
 *
 * Native Claude, Codex, Kimi, and OpenCode events must be translated at their
 * adapter boundary. Keeping this protocol outside every adapter prevents a
 * transport SDK from becoming MetaBot's domain model.
 */
export type EngineEvent = {
  type: string;
  subtype?: string;
  uuid?: string;
  session_id?: string;
  message?: {
    content?: Array<{
      type: string;
      text?: string;
      name?: string;
      id?: string;
      input?: unknown;
    }>;
  };
  // Result fields
  duration_ms?: number;
  duration_api_ms?: number;
  total_cost_usd?: number;
  result?: string;
  is_error?: boolean;
  num_turns?: number;
  errors?: string[];
  // Model usage from result message (per-model breakdown)
  modelUsage?: Record<
    string,
    {
      inputTokens: number;
      outputTokens: number;
      contextWindow: number;
      costUSD: number;
    }
  >;
  // Incremental stream fields
  event?: {
    type: string;
    index?: number;
    delta?: {
      type: string;
      text?: string;
    };
    content_block?: {
      type: string;
      text?: string;
      name?: string;
      id?: string;
    };
  };
  parent_tool_use_id?: string | null;
  // Engine adapters may attach structured task/tool metadata understood by
  // StreamProcessor without leaking their native wire types.
  [key: string]: unknown;
};

