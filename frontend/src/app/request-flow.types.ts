export type RequestFlowTriggerKind = 'api' | 'cli' | 'queue' | string;
export type RequestFlowConfidence = 'high' | 'medium' | string;

export interface RequestFlowTrigger {
  kind: RequestFlowTriggerKind;
  label: string;
  message_type?: string;
}

export type FlowStoryCategory =
  | 'user-request'
  | 'cli-tool'
  | 'background-job'
  | 'device-event'
  | 'platform-event'
  | string;

export interface FlowStoryTouch {
  kind: string;
  system: string;
}

export interface FlowStoryFanOutMember {
  name: string;
  label: string;
  summary?: string | null;
  touches: FlowStoryTouch[];
  file: string;
  line: number;
}

export interface FlowStory {
  category: FlowStoryCategory;
  purpose?: { text: string; source: string; file: string; line: number } | null;
  triggeredBy?: {
    kind: string;
    label: string;
    outsideRepo?: boolean;
    ownerHint?: string;
    messageType?: string;
    evidence?: string;
    publishers?: Array<{ symbol: string; file: string; line: number }>;
  } | null;
  fanOut: Array<{ via: string; interface: string; label: string; members: FlowStoryFanOutMember[] }>;
  produces: {
    metrics: Array<{ name: string; type?: string; file: string; line: number }>;
    boundaries: Array<FlowStoryTouch & { access: string; calls?: string[] }>;
  };
  timing: Array<{ key: string; value: unknown; human: string; file: string; line: number }>;
  summary: string;
}

export interface FlowKnowledgeFact {
  id: string;
  kind: 'tribal' | 'doc' | 'rule' | string;
  title: string;
  text: string;
  why_it_matters?: string;
  source: { type: string; name?: string; role?: string; path?: string; line?: number; url?: string };
  verified: boolean;
  verify_hint?: string;
  matched_by?: string;
}

export interface RequestFlowStep {
  id: string;
  kind: string;
  symbol: string;
  label: string;
  file: string;
  line: number;
  confidence: RequestFlowConfidence;
  evidence: string[];
  doc?: string | null;
}

export interface RequestFlow {
  id: string;
  service: string;
  trigger: RequestFlowTrigger;
  confidence: RequestFlowConfidence;
  steps: RequestFlowStep[];
  branches?: RequestFlowStep[][];
  story?: FlowStory;
  knowledge?: FlowKnowledgeFact[];
}

export interface RequestFlowWarning {
  code?: string;
  message?: string;
  file?: string | null;
  line?: number | null;
}

export interface RequestFlowCatalog {
  schema_version: string;
  generator: Record<string, unknown>;
  limits: Record<string, unknown>;
  flows: RequestFlow[];
  warnings: Array<RequestFlowWarning | string>;
  glossary: Record<string, string>;
}

export interface RequestFlowMermaid {
  flow_id: string;
  mermaid: string;
}

export interface RequestFlowSelectionContext {
  flowId: string;
  stepId?: string;
  term?: string;
}
