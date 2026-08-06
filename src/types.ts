export interface Project {
  id: string;
  name: string;
}

export interface Entry {
  id: string;
  userId: string;
  userEmail: string;
  userDisplayName: string;
  projectId: string;
  projectName: string;
  notes: string;
  startAt: string;
  endAt: string | null;
  durationMs?: number;
}

export interface SignedInUser {
  id: string;
  email: string;
  displayName: string;
  role: 'employee' | 'admin';
}

export interface SessionData {
  authenticated: true;
  csrfToken: string;
  user: SignedInUser;
  logoutUrl: string;
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
