/** Date-only ISO string, `YYYY-MM-DD`. Never a Date object across a boundary. */
export type ISODate = string;

export type EnvKind = 'SIT' | 'UAT' | 'NFT' | 'PENTEST' | 'PROD' | 'OTHER';
export type BookingKind = 'SIT' | 'UAT' | 'NFT' | 'PENTEST' | 'RELEASE' | 'CUSTOM';
export type Confidence = 'committed' | 'tentative';
export type Status = 'planned' | 'in_progress' | 'on_hold' | 'done' | 'cancelled';
export type Priority = 'low' | 'normal' | 'high' | 'critical';

export const PRIORITY_RANK: Record<Priority, number> = {
  low: 1, normal: 2, high: 3, critical: 4,
};

export type Team = {
  id: number;
  name: string;
  code: string;
  active: number;
  created_at: string;
  /** What deleting this team would take with it. Present on list responses. */
  project_count?: number;
  booking_count?: number;
};

export type Environment = {
  id: number;
  team_id: number;
  name: string;
  kind: EnvKind;
  capacity: number;
  sort_order: number;
  booking_count?: number;
};

export type Project = {
  id: number;
  team_id: number;
  parent_id: number | null;
  name: string;
  status: Status;
  priority: Priority;
  owner: string | null;
  description: string | null;
  external_link: string | null;
  /** Total bookings, not just those inside the current window. */
  booking_count?: number;
};

export type Booking = {
  id: number;
  project_id: number;
  environment_id: number;
  kind: BookingKind;
  start_date: ISODate;
  end_date: ISODate;
  confidence: Confidence;
  optional: number;
};

export type Holiday = { date: ISODate; name: string };

/** A booking joined with the names needed to render and label it. */
export type BookingView = Booking & {
  project_name: string;
  team_id: number;
  priority: Priority;
  env_name: string;
  env_kind: EnvKind;
  capacity: number;
  /** Calendar days occupied, inclusive. */
  calendar_days: number;
  /** Working days of effort, weekends and holidays excluded. */
  working_days: number;
  is_milestone: boolean;
};

/** A stretch of time where an environment is booked beyond its capacity. */
export type Conflict = {
  environment_id: number;
  env_name: string;
  env_kind: EnvKind;
  capacity: number;
  start_date: ISODate;
  end_date: ISODate;
  /** How many bookings are live at the peak of this stretch. */
  peak: number;
  booking_ids: number[];
  projects: { id: number; name: string; priority: Priority }[];
  overlap_days: number;
  /** overlap_days x rank of the highest-priority project involved. */
  severity: number;
};
