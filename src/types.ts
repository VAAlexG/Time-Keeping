export interface Project {
  id: string;
  name: string;
}

export interface Entry {
  id: string;
  projectId: string;
  projectName: string;
  notes: string;
  startAt: string;
  endAt: string | null;
  durationMs?: number;
}

export interface DashboardData {
  active: Entry | null;
  projects: Project[];
  today: { date: string; entries: Entry[]; totalMs: number };
  week: {
    start: string;
    end: string;
    entries: Entry[];
    totalMs: number;
    projectTotals: { projectName: string; totalMs: number }[];
  };
}

export interface HistoryData {
  entries: Entry[];
  totalMs: number;
  projectTotals: { projectName: string; totalMs: number }[];
}
