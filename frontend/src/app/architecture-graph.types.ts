export type GraphNodeKind =
  | 'service'
  | 'library'
  | 'entrypoint'
  | 'database'
  | 'queue'
  | 'external';

export type GraphEdgeKind =
  | 'handles'
  | 'references'
  | 'queries'
  | 'publishes'
  | 'consumes'
  | 'calls_external'
  | 'uses';

export type EvidenceStrength = 'call' | 'wiring' | 'declaration';

export type EvidenceKind =
  | 'call'
  | 'route'
  | 'registration'
  | 'injection'
  | 'configuration'
  | 'package'
  | 'generated-client'
  | 'project-reference';

export type Confidence = 'high' | 'medium' | 'low';
export type Resolution = 'direct' | 'inferred' | 'unresolved';

export interface GraphSource {
  file: string;
  line: number;
  symbol: string;
}

export interface GraphEvidence extends GraphSource {
  reason: string;
  kind: EvidenceKind;
  confidence: Confidence;
  resolution: Resolution;
}

export interface ArchitectureNode {
  id: string;
  kind: GraphNodeKind;
  label: string;
  name: string;
  service: string | null;
  description: string | null;
  confidence: Confidence;
  resolution: Resolution;
  flow_ids: string[];
  source: GraphSource | null;
}

export interface ArchitectureEdge {
  id: string;
  source: string;
  target: string;
  kind: GraphEdgeKind;
  strength: EvidenceStrength;
  confidence: Confidence;
  resolution: Resolution;
  evidence_count: number;
  flow_ids: string[];
  evidence: GraphEvidence[];
}

export interface GraphFlowLink {
  id: string;
  label: string;
  service: string;
}

export interface GraphSummary {
  services: number;
  libraries: number;
  technologies: number;
  call_sites: number;
  evidence_items: number;
}

export interface ArchitectureGraph {
  schema_version: '2.0.0';
  analysis: {
    mode: 'study';
    completeness: string;
    limitations?: string[];
  };
  summary: GraphSummary;
  nodes: ArchitectureNode[];
  edges: ArchitectureEdge[];
  flows: GraphFlowLink[];
  warnings: Array<string | { code?: string; message?: string }>;
}
