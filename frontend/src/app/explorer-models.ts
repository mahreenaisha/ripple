export interface RepositoryRecord {
  id: string;
  name: string;
  path: string;
  added_at: string;
}

export interface LanguageCount {
  language: string;
  files: number;
}

export interface RootEntry {
  name: string;
  path: string;
  kind: 'folder' | 'file';
  file_count: number;
  directory_count: number;
  languages: LanguageCount[];
  manifests: string[];
  state_hash: string;
}

export interface RepositoryInventory {
  repository: RepositoryRecord;
  commit: string;
  dirty: boolean;
  branch: string | null;
  generated_at: string;
  entries: RootEntry[];
}

export interface ReadmeSection {
  id: string;
  heading: string;
  level: number;
  start_line: number;
  end_line: number;
  content: string;
}

export interface ReadmeDocument {
  found: boolean;
  path: string | null;
  word_count: number;
  reading_minutes: number;
  state_hash: string;
  sections: ReadmeSection[];
}

export interface EvidenceItem {
  id: string;
  file: string;
  start_line: number;
  end_line: number;
  category: string;
  scope: string;
  content: string;
}

export interface FolderExplanationContent {
  summary: string;
  responsibilities: string[];
  evidence: { evidence_id: string; reason: string }[];
  uncertainties: string[];
}

export interface FolderExplanation {
  repository_id: string;
  folder: string;
  mode: 'preview' | 'full';
  facts: {
    folder: string;
    file_count: number;
    directory_count: number;
    languages: LanguageCount[];
    manifests: string[];
    entry_points: string[];
    state_hash: string;
    evidence_hash: string;
  };
  explanation: FolderExplanationContent | null;
  evidence: EvidenceItem[];
  model: string;
  prompt_version: string;
  commit: string;
  generated_at: string | null;
  cached: boolean;
  verified_citations: boolean;
  review_state: 'unreviewed' | 'reviewed';
  error: string | null;
}

export interface ModelStatus {
  available: boolean;
  model: string;
  detail: string;
}

