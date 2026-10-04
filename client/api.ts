import type {
  Booking, Conflict, Environment, Holiday, ISODate, PlanImpact, Project, Resource, Task, TaskDependency, TaskHold, TaskSchedule, Team,
} from '../shared/types.ts';
import type { Baseline, BaselineTask, BookingView, ElsewhereTask, ExternalLink, LinkType } from '../shared/types.ts';
import type { ProjectLink } from '../shared/projectLinks.ts';
import type { OutlinePlacement } from '../shared/wbs.ts';
import type { ImportRow } from './planIO.ts';
import type { AssistantReport } from '../shared/assistant/rules.ts';
import type { SuggestionReport } from '../shared/assistant/optimise.ts';
import type { PlanOp } from '../shared/assistant/moves.ts';
import type { PlanReview } from '../shared/assistant/review.ts';
import type { EarnedValue, Missing } from '../shared/earnedValue.ts';
import type { AdvisorReply } from '../shared/assistant/validate.ts';
import type { AssistantSettings } from '../shared/assistant/settings.ts';

export type Bootstrap = { teams: Team[]; environments: Environment[]; holidays: Holiday[] };
export type BoardData = {
  bookings: BookingView[];
  projects: Project[];
  environments: Environment[];
  conflicts: Conflict[];
  /** Keys of accepted double-bookings (see `conflictKey`), for recomputed previews. */
  resolved?: string[];
};

export type PlanData = {
  project: Project;
  tasks: Task[];
  dependencies: TaskDependency[];
  schedule: TaskSchedule[];
  critical_path: number[];
  /** Task ids in dependency order, predecessors first. */
  order: number[];
  finish: ISODate | null;
  late_by: number;
  holds: TaskHold[];
  /** This project's bookings, with the tasks each one covers. */
  bookings: BookingView[];
  /** Each task's dates (and length) in the baseline the plan compares with; empty without one. */
  baseline: { task_id: number; start_date: ISODate; end_date: ISODate; duration: number | null }[];
  /** Every saved baseline, oldest first (reqs/pm_features.md §4). */
  baselines: Baseline[];
  /** Links to and from other plans' tasks (reqs/pm_features.md §7). */
  external: { incoming: ExternalLink[]; outgoing: ExternalLink[] };
  /** The floors those links set now, by task id, for the chart's drag preview. */
  external_floors: [number, ISODate][];
  /** The team's plans, for After's project tags. */
  link_projects: { id: number; name: string }[];
  /** Every person, for names and the Who suggestions; tasks name them by `resource_ids`. */
  resources: Resource[];
  /** This plan's people's open work in other plans, for the overlap warning. */
  elsewhere: ElsewhereTask[];
};

/** Every plan of a team, for the portfolio chart. Read-only. */
/** One thing a task waits on in another plan, as the link route takes it. */
export type ExternalLinkInput = ({ task_id: number } | { project_id: number; code: number }) & { type: LinkType; lag: number };

export type PortfolioData = {
  projects: {
    project: Project;
    tasks: Task[];
    dependencies: TaskDependency[];
    schedule: TaskSchedule[];
    finish: ISODate | null;
    late_by: number;
  }[];
  /** Links between the team's plans. */
  links?: ProjectLink[];
};

/** A network arrow's shape as saved; see `Route` in client/network.ts. */
export type LinkRoute = { out: number | null; y: number | null; in: number | null; from?: string | null; to?: string | null };

/** Box positions and arrow shapes, for many at once. Nulls mean automatic. */
export type SavedLayout = {
  tasks: { id: number; x: number | null; y: number | null }[];
  dependencies: ({ predecessor_id: number; successor_id: number } & LinkRoute)[];
};

/**
 * What a task form sends. `predecessors` replaces the whole set when present;
 * so does `resources`, the Who text (`Mai, Tuan`), whose new names become people.
 */
export type TaskInput = Partial<Pick<Task,
  'name' | 'environment_id' | 'duration' | 'status' | 'not_before' | 'note' | 'actual_start' | 'actual_end'
  | 'parent_id' | 'progress' | 'code' | 'duration_low' | 'duration_high' | 'deadline' | 'fixed_cost' | 'actual_cost'>>
  & { predecessors?: { id: number; lag: number; type?: LinkType }[]; resources?: string };

export type TaskChange =
  | { op: 'create'; fields: TaskInput; after_id?: number | null }
  | { op: 'update'; id: number; fields: TaskInput }
  | { op: 'delete'; id: number; bridge?: boolean; children?: 'lift' | 'delete' }
  | { op: 'outline'; placements: OutlinePlacement[] };

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: init?.body ? { 'content-type': 'application/json' } : undefined,
  });
  if (res.status === 204) return undefined as T;
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error ?? `Request failed (${res.status})`);
  return body as T;
}

export const api = {
  bootstrap: () => request<Bootstrap>('/api/bootstrap'),

  board: (params: { team?: number; envs?: number[]; from: ISODate; to: ISODate }) => {
    const q = new URLSearchParams({ from: params.from, to: params.to });
    if (params.team != null) q.set('team', String(params.team));
    if (params.envs?.length) q.set('envs', params.envs.join(','));
    return request<BoardData>(`/api/board?${q}`);
  },

  createTeam: (body: { name: string; code?: string }) =>
    request<Team>('/api/teams', { method: 'POST', body: JSON.stringify(body) }),
  updateTeam: (id: number, body: Partial<Team>) =>
    request<Team>(`/api/teams/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  deleteTeam: (id: number) => request<void>(`/api/teams/${id}`, { method: 'DELETE' }),

  createEnvironment: (body: Partial<Environment> & { team_id: number; name: string }) =>
    request<Environment>('/api/environments', { method: 'POST', body: JSON.stringify(body) }),
  updateEnvironment: (id: number, body: Partial<Environment>) =>
    request<Environment>(`/api/environments/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  deleteEnvironment: (id: number) => request<void>(`/api/environments/${id}`, { method: 'DELETE' }),

  createProject: (body: Partial<Project> & { team_id: number; name: string }) =>
    request<Project>('/api/projects', { method: 'POST', body: JSON.stringify(body) }),
  updateProject: (id: number, body: Partial<Project>) =>
    request<Project>(`/api/projects/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  deleteProject: (id: number) => request<void>(`/api/projects/${id}`, { method: 'DELETE' }),

  createBooking: (body: Partial<Booking> & { project_id: number; environment_id: number; start_date: ISODate }) =>
    request<Booking & { adjusted: boolean }>('/api/bookings', { method: 'POST', body: JSON.stringify(body) }),
  updateBooking: (id: number, body: Partial<Booking>) =>
    request<Booking & { adjusted: boolean }>(`/api/bookings/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  deleteBooking: (id: number) => request<void>(`/api/bookings/${id}`, { method: 'DELETE' }),

  plan: (projectId: number) => request<PlanData>(`/api/projects/${projectId}/plan`),
  createTask: (projectId: number, fields: TaskInput & { name: string }, afterId?: number | null) =>
    request<{ id: number; plan: PlanData }>('/api/tasks', {
      method: 'POST', body: JSON.stringify({ ...fields, project_id: projectId, after_id: afterId ?? null }),
    }),
  updateTask: (id: number, fields: TaskInput) =>
    request<{ id: number; plan: PlanData }>(`/api/tasks/${id}`, { method: 'PATCH', body: JSON.stringify(fields) }),
  deleteTask: (id: number, bridge: boolean, children?: 'lift' | 'delete') => {
    const q = new URLSearchParams({ ...(bridge ? { bridge: '1' } : {}), ...(children ? { children } : {}) }).toString();
    return request<{ plan: PlanData }>(`/api/tasks/${id}${q ? `?${q}` : ''}`, { method: 'DELETE' });
  },
  reorderTasks: (projectId: number, ids: number[]) =>
    request<{ plan: PlanData }>('/api/tasks/reorder', { method: 'POST', body: JSON.stringify({ project_id: projectId, ids }) }),
  previewTask: (projectId: number, change: TaskChange) =>
    request<PlanImpact>('/api/tasks/preview', { method: 'POST', body: JSON.stringify({ project_id: projectId, change }) }),
  moveTaskBox: (id: number, pos: { x: number; y: number } | null) =>
    request<unknown>(`/api/tasks/${id}/position`, { method: 'PATCH', body: JSON.stringify(pos ?? { x: null, y: null }) }),
  routeLink: (predecessorId: number, successorId: number, route: LinkRoute | null) =>
    request<unknown>('/api/dependencies/route', {
      method: 'PATCH',
      body: JSON.stringify({ predecessor_id: predecessorId, successor_id: successorId, ...(route ?? { out: null, y: null, in: null }) }),
    }),
  /** Overwrite many boxes and arrows at once; nulls put them back to automatic. */
  saveLayout: (projectId: number, layout: SavedLayout) =>
    request<void>(`/api/projects/${projectId}/layout`, { method: 'PUT', body: JSON.stringify(layout) }),
  resetLayout: (projectId: number) => request<void>(`/api/projects/${projectId}/layout/reset`, { method: 'POST' }),
  outlineTasks: (projectId: number, placements: OutlinePlacement[]) =>
    request<{ plan: PlanData }>('/api/tasks/outline', { method: 'POST', body: JSON.stringify({ project_id: projectId, placements }) }),
  /** Replace what a task waits on in other plans; a task by id, or by its plan and TaskID. */
  setExternalLinks: (taskId: number, links: ExternalLinkInput[]) =>
    request<{ plan: PlanData }>(`/api/tasks/${taskId}/external-links`, { method: 'PUT', body: JSON.stringify({ links }) }),
  saveBaseline: (projectId: number, name: string) =>
    request<{ plan: PlanData }>(`/api/projects/${projectId}/baselines`, { method: 'POST', body: JSON.stringify({ name }) }),
  updateBaseline: (id: number, patch: { name?: string; compare?: true }) =>
    request<{ plan: PlanData }>(`/api/baselines/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  deleteBaseline: (id: number) => request<{ plan: PlanData }>(`/api/baselines/${id}`, { method: 'DELETE' }),
  /** Every baseline with its tasks, for an MS Project file. */
  baselinesWithTasks: (projectId: number) =>
    request<(Baseline & { rows: BaselineTask[] })[]>(`/api/projects/${projectId}/baselines?tasks=1`),
  importTasks: (projectId: number, rows: ImportRow[]) =>
    request<{ plan: PlanData; created: number; warnings: string[] }>(`/api/projects/${projectId}/import`, {
      method: 'POST', body: JSON.stringify({ rows }),
    }),
  portfolio: (teamId: number) => request<PortfolioData>(`/api/teams/${teamId}/portfolio`),
  releaseBooking: (id: number) =>
    request<Booking & { previous_end: ISODate }>(`/api/bookings/${id}/release`, { method: 'POST' }),

  resources: () => request<Resource[]>('/api/resources'),
  updateResource: (id: number, body: { name?: string; active?: boolean; rate?: number | null }) =>
    request<Resource>(`/api/resources/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  mergeResource: (id: number, into: number) =>
    request<Resource>(`/api/resources/${id}/merge`, { method: 'POST', body: JSON.stringify({ into }) }),
  deleteResource: (id: number) => request<void>(`/api/resources/${id}`, { method: 'DELETE' }),

  resolveConflict: (body: { environment_id: number; booking_ids: number[] }) =>
    request<{ key: string }>('/api/conflicts/resolve', { method: 'POST', body: JSON.stringify(body) }),
  reopenConflict: (body: { environment_id: number; booking_ids: number[] }) =>
    request<{ key: string }>('/api/conflicts/reopen', { method: 'POST', body: JSON.stringify(body) }),

  assistant: (projectId: number) => request<AssistantReport>(`/api/projects/${projectId}/assistant`),
  dismissFinding: (projectId: number, key: string) =>
    request<AssistantReport>(`/api/projects/${projectId}/assistant/dismiss`, { method: 'POST', body: JSON.stringify({ key }) }),
  suggestions: (projectId: number, focus?: 'people') =>
    request<SuggestionReport>(`/api/projects/${projectId}/assistant/suggestions${focus ? `?focus=${focus}` : ''}`),
  previewOps: (projectId: number, ops: PlanOp[]) =>
    request<PlanImpact>(`/api/projects/${projectId}/assistant/preview`, { method: 'POST', body: JSON.stringify({ ops }) }),
  /** Earned value at a status date (today when omitted), against the compared baseline. */
  earnedValue: (projectId: number, date?: ISODate) =>
    request<EarnedValue | Missing>(`/api/projects/${projectId}/earned-value${date ? `?date=${date}` : ''}`),
  reviewOps: (projectId: number, ops: PlanOp[], version: string | null) =>
    request<PlanReview>(`/api/projects/${projectId}/assistant/review`, { method: 'POST', body: JSON.stringify({ ops, version }) }),
  applyOps: (projectId: number, ops: PlanOp[], version: string | null) =>
    request<{ plan: PlanData; undo: PlanOp[] }>(`/api/projects/${projectId}/assistant/apply`, { method: 'POST', body: JSON.stringify({ ops, version }) }),
  ask: (projectId: number, body: { question: string | null; mode: 'brief' | 'replan' }) =>
    request<AdvisorReply>(`/api/projects/${projectId}/assistant/ask`, { method: 'POST', body: JSON.stringify(body) }),
  assistantSettings: () => request<AssistantSettings>('/api/assistant/settings'),
  updateAssistantSettings: (patch: Partial<{ [K in keyof AssistantSettings]: AssistantSettings[K] | null }>) =>
    request<AssistantSettings>('/api/assistant/settings', { method: 'PATCH', body: JSON.stringify(patch) }),
  assistantProviders: () => request<{ id: string; ready: boolean; note: string | null }[]>('/api/assistant/providers'),
  restoreFinding: (projectId: number, key: string) =>
    request<AssistantReport>(`/api/projects/${projectId}/assistant/restore`, { method: 'POST', body: JSON.stringify({ key }) }),
};
