/** Date-only ISO string, `YYYY-MM-DD`. Never a Date object across a boundary. */
export type ISODate = string;

export type EnvKind = 'SIT' | 'UAT' | 'NFT' | 'PENTEST' | 'PROD' | 'OTHER';
export type BookingKind = 'SIT' | 'UAT' | 'NFT' | 'PENTEST' | 'RELEASE' | 'CUSTOM';
export type Confidence = 'committed' | 'tentative';
export type Status = 'planned' | 'in_progress' | 'on_hold' | 'done' | 'cancelled';
export type Priority = 'low' | 'normal' | 'high' | 'critical';
/** The glyph a CUSTOM booking shows on the timeline. */
export type Marker = 'star' | 'flag' | 'pin';
export const MARKERS: readonly Marker[] = ['star', 'flag', 'pin'];

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
  note: string | null;
  /** Always null unless kind is CUSTOM. */
  marker: Marker | null;
  /**
   * What the bar says on the timeline, when someone has written it. Null means the
   * default (`defaultTimelineText`), which follows the project name and note.
   */
  timeline_text?: string | null;
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
  /**
   * Someone has looked at this double-booking and accepted it. It still exists
   * and is still drawn, but no longer raises the alarm. See `conflictKey`.
   */
  resolved?: boolean;
};
