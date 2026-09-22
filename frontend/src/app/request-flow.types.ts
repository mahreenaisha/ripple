export type RequestFlowTriggerKind = 'api' | 'cli' | 'queue' | string;
export type RequestFlowConfidence = 'high' | 'medium' | string;

export interface RequestFlowTrigger {
  kind: RequestFlowTriggerKind;
  label: string;
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
}

export interface RequestFlow {
  id: string;
  service: string;
  trigger: RequestFlowTrigger;
  confidence: RequestFlowConfidence;
  steps: RequestFlowStep[];
  branches?: RequestFlowStep[][];
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
