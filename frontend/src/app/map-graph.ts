import {
  ArchitectureEdge,
  ArchitectureGraph,
  ArchitectureNode,
  Confidence,
  EvidenceKind,
  EvidenceStrength,
} from './architecture-graph.types';

export interface MapEdge extends ArchitectureEdge {
  /** Libraries whose code this service edge was lifted from. */
  via: string[];
}

export interface VisibleMap {
  nodes: ArchitectureNode[];
  edges: MapEdge[];
}

const STRENGTH_ORDER: Record<EvidenceStrength, number> = { call: 0, wiring: 1, declaration: 2 };
const CONFIDENCE_ORDER: Record<Confidence, number> = { high: 3, medium: 2, low: 1 };
const EVIDENCE_ORDER: Record<EvidenceKind, number> = {
  call: 0,
  route: 1,
  registration: 2,
  injection: 3,
  configuration: 4,
  'generated-client': 5,
  package: 6,
  'project-reference': 7,
};

export const TECHNOLOGY_KINDS: ReadonlySet<string> = new Set(['database', 'queue', 'external']);

export function visibleMap(
  graph: ArchitectureGraph,
  options: { libraries: boolean; entrypoints: boolean },
): VisibleMap {
  const edges = options.libraries
    ? graph.edges.map((edge) => ({ ...edge, via: [] }))
    : liftLibraryEdges(graph);
  const candidates = graph.nodes.filter(
    (node) =>
      (options.libraries || node.kind !== 'library') &&
      (options.entrypoints || node.kind !== 'entrypoint'),
  );
  const ids = new Set(candidates.map((node) => node.id));
  const visibleEdges = edges.filter((edge) => ids.has(edge.source) && ids.has(edge.target));
  const connected = new Set(visibleEdges.flatMap((edge) => [edge.source, edge.target]));
  return {
    nodes: candidates.filter((node) => node.kind !== 'entrypoint' || connected.has(node.id)),
    edges: visibleEdges,
  };
}

/**
 * Replaces library nodes with the services that reference them: each service
 * inherits the dependencies of every library it references, directly or
 * transitively, and keeps the library evidence behind the lifted edge.
 */
export function liftLibraryEdges(graph: ArchitectureGraph): MapEdge[] {
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const isLibrary = (id: string) => nodes.get(id)?.kind === 'library';
  const references = new Map<string, string[]>();
  for (const edge of graph.edges) {
    if (edge.kind === 'references' && isLibrary(edge.target)) {
      references.set(edge.source, [...(references.get(edge.source) ?? []), edge.target]);
    }
  }
  const key = (source: string, kind: string, target: string) => `${source}\u0000${kind}\u0000${target}`;
  const merged = new Map<string, MapEdge>();
  for (const edge of graph.edges) {
    if (!isLibrary(edge.source) && !isLibrary(edge.target)) {
      merged.set(key(edge.source, edge.kind, edge.target), { ...edge, via: [] });
    }
  }
  for (const service of graph.nodes.filter((node) => node.kind === 'service')) {
    const libraries = new Set<string>();
    const pending = [...(references.get(service.id) ?? [])];
    while (pending.length) {
      const library = pending.pop()!;
      if (!libraries.has(library)) {
        libraries.add(library);
        pending.push(...(references.get(library) ?? []));
      }
    }
    for (const edge of graph.edges) {
      if (
        !libraries.has(edge.source) ||
        edge.kind === 'references' ||
        edge.kind === 'handles' ||
        isLibrary(edge.target)
      ) {
        continue;
      }
      const via = nodes.get(edge.source)!.label;
      const id = key(service.id, edge.kind, edge.target);
      const existing = merged.get(id);
      if (!existing) {
        merged.set(id, { ...edge, id: `via:${service.id}:${edge.id}`, source: service.id, via: [via] });
        continue;
      }
      merged.set(id, {
        ...existing,
        via: [...new Set([...existing.via, via])].sort(),
        strength:
          STRENGTH_ORDER[edge.strength] < STRENGTH_ORDER[existing.strength]
            ? edge.strength
            : existing.strength,
        confidence:
          CONFIDENCE_ORDER[edge.confidence] > CONFIDENCE_ORDER[existing.confidence]
            ? edge.confidence
            : existing.confidence,
        resolution:
          existing.resolution === 'direct' || edge.resolution === 'direct'
            ? 'direct'
            : existing.resolution,
        evidence_count: existing.evidence_count + edge.evidence_count,
        evidence: [...existing.evidence, ...edge.evidence].sort(
          (left, right) => EVIDENCE_ORDER[left.kind] - EVIDENCE_ORDER[right.kind],
        ),
        flow_ids: [...new Set([...existing.flow_ids, ...edge.flow_ids])].sort(),
      });
    }
  }
  return [...merged.values()];
}

/** Services whose own code, wiring, or project files depend on the node. */
export function servicesUsing(graph: ArchitectureGraph, nodeId: string): string[] {
  const services = new Map(
    graph.nodes.filter((node) => node.kind === 'service').map((node) => [node.id, node.label]),
  );
  return [
    ...new Set(
      graph.edges
        .filter((edge) => edge.target === nodeId && edge.kind !== 'handles' && services.has(edge.source))
        .map((edge) => services.get(edge.source)!),
    ),
  ].sort();
}

export function sharedTechnologies(graph: ArchitectureGraph): Set<string> {
  return new Set(
    graph.nodes
      .filter((node) => TECHNOLOGY_KINDS.has(node.kind) && servicesUsing(graph, node.id).length > 1)
      .map((node) => node.id),
  );
}
