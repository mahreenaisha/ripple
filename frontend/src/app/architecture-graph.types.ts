export type GraphNodeKind =
  | 'service'
  | 'entrypoint'
  | 'database'
  | 'queue'
  | 'external'
  | 'unresolved';

export interface GraphSource {
  file: string;
  line: number;
  symbol: string;
}

export interface GraphEvidence extends GraphSource {
  reason: string;
  confidence: 'high' | 'medium' | 'low';
  resolution: 'direct' | 'inferred' | 'unresolved';
}

export interface ArchitectureNode {
  id: string;
  kind: GraphNodeKind;
  label: string;
  confidence: 'high' | 'medium' | 'low';
  resolution: 'direct' | 'inferred' | 'unresolved';
  flow_ids: string[];
  source: GraphSource | null;
}

export interface ArchitectureEdge {
  id: string;
  source: string;
  target: string;
  kind:
    | 'handles'
    | 'queries'
    | 'publishes'
    | 'consumes'
    | 'calls_external'
    | 'unresolved_dependency';
  confidence: 'high' | 'medium' | 'low';
  resolution: 'direct' | 'inferred' | 'unresolved';
  flow_ids: string[];
  evidence: GraphEvidence[];
}

export interface ArchitectureGraph {
  schema_version: '1.0.0';
  analysis: {
    mode: 'study';
    completeness: string;
    limitations?: string[];
  };
  nodes: ArchitectureNode[];
  edges: ArchitectureEdge[];
  warnings: Array<string | { code?: string; message?: string }>;
}
