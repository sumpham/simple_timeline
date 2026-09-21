import type { Booking, Conflict, Environment, Holiday, ISODate, Project, Team } from '../shared/types.ts';
import type { BookingView } from '../shared/types.ts';

export type Bootstrap = { teams: Team[]; environments: Environment[]; holidays: Holiday[] };
export type BoardData = {
  bookings: BookingView[];
  projects: Project[];
  environments: Environment[];
  conflicts: Conflict[];
};

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
};
