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
  task_count?: number;
};

export type Environment = {
  id: number;
  team_id: number;
  name: string;
  kind: EnvKind;
  capacity: number;
  sort_order: number;
  booking_count?: number;
  task_count?: number;
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
  /** Where the task schedule starts. Null until the project has a plan. */
  start_date?: ISODate | null;
  /** The date the project has promised; a schedule that finishes later is late. */
  target_date?: ISODate | null;
  /** When the plan's baseline was saved, if it has one. */
  baseline_at?: string | null;
  /** Total bookings, not just those inside the current window. */
  booking_count?: number;
  task_count?: number;
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
  /**
   * The span someone booked by hand. Null on both means the booking was made by
   * the project's tasks alone (see `shared/taskHolds.ts`). `start_date`/`end_date`
   * are always the effective span: the manual one stretched over any task hold.
   */
  manual_start?: ISODate | null;
  manual_end?: ISODate | null;
  /** The task hold this booking covers, if any, and whether its tasks are all done (1). Written by replan. */
  hold_start?: ISODate | null;
  hold_end?: ISODate | null;
  hold_done?: number;
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
  /** Made by tasks alone; its dates belong to the plan, not to a drag. */
  auto?: boolean;
  /** The tasks that make up that hold, with the calendar span each one needs. */
  tasks?: { id: number; name: string; start: ISODate; end: ISODate }[];
  /**
   * Every task in the hold is done and the booking runs on past them: the
   * environment could be handed back from this day.
   */
  release_from?: ISODate | null;
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

// ---------------------------------------------------------------- tasks

export type TaskStatus = 'todo' | 'in_progress' | 'blocked' | 'done';
export const TASK_STATUSES: readonly TaskStatus[] = ['todo', 'in_progress', 'blocked', 'done'];

export type Task = {
  id: number;
  project_id: number;
  /** A task on an environment books it (see `taskHolds`); null means it books nothing. */
  environment_id: number | null;
  name: string;
  /** Working days of effort. Zero is a milestone. */
  duration: number;
  status: TaskStatus;
  /** Start no earlier than this date, whatever the dependencies allow. */
  not_before: ISODate | null;
  assignee: string | null;
  note: string | null;
  sort_order: number;
  actual_start: ISODate | null;
  actual_end: ISODate | null;
  /** Scheduled by the server on every change; never typed by a person. */
  start_date: ISODate | null;
  end_date: ISODate | null;
  total_float: number | null;
  critical: number;
  /** Where the box was dragged in the network diagram; null is the automatic place. */
  net_x?: number | null;
  net_y?: number | null;
  /**
   * The summary task this one sits under. A task with children is a summary: its
   * dates roll up from them, it books nothing, and its own duration is ignored.
   */
  parent_id?: number | null;
  /** Percent complete as someone typed it; null means work it out from status. */
  progress?: number | null;
};

/**
 * How a link constrains its successor. FS: start after the predecessor finishes.
 * SS: start after it starts. FF: finish after it finishes. Lag applies to each.
 */
export type LinkType = 'FS' | 'SS' | 'FF';
export const LINK_TYPES: readonly LinkType[] = ['FS', 'SS', 'FF'];

/** A link between two tasks of one project; finish-to-start unless `type` says otherwise. */
export type TaskDependency = {
  predecessor_id: number;
  successor_id: number;
  /** Working days; negative is a lead. */
  lag: number;
  /** Missing or null reads as FS, so links made before types existed keep their meaning. */
  type?: LinkType | null;
  /** A hand-shaped arrow in the network diagram; null is automatic. Layout only. */
  route_out?: number | null;
  route_y?: number | null;
  route_in?: number | null;
  /** The anchor on each box's side: 'top', 'mid' or 'bottom'; null is automatic. */
  route_from?: string | null;
  route_to?: string | null;
};

/** A task's computed place in the schedule. All floats are in working days. */
export type TaskSchedule = {
  id: number;
  start: ISODate;
  end: ISODate;
  late_start: ISODate;
  late_end: ISODate;
  total_float: number;
  free_float: number;
  critical: boolean;
  /** Rolled up from the tasks under it rather than scheduled. */
  summary?: boolean;
};

/**
 * A stretch where one project's tasks hold one environment: the tasks on it,
 * merged while the gap between them is short (`HOLD_GAP_DAYS`).
 */
export type TaskHold = {
  project_id: number;
  environment_id: number;
  start: ISODate;
  end: ISODate;
  task_ids: number[];
  /** Every task in the hold is done. */
  done: boolean;
};

export type PlanRisk = 'low' | 'medium' | 'high';

/** What a proposed change to a plan would do, stated before it is made. */
export type PlanImpact = {
  risk: PlanRisk;
  moved: { id: number; name: string; days: number }[];
  unlinked: { id: number; name: string }[];
  finish: { before: ISODate | null; after: ISODate | null; days: number };
  /** Working days past the target date after the change; 0 when on time or no target. */
  late_by: number;
  critical_added: { id: number; name: string }[];
  critical_removed: { id: number; name: string }[];
  bookings: { id: number | null; env_name: string; change: 'created' | 'removed' | 'longer' | 'shorter' | 'moved';
    before: { start: ISODate; end: ISODate } | null; after: { start: ISODate; end: ISODate } | null }[];
  conflicts_added: { env_name: string; start_date: ISODate; end_date: ISODate; projects: string[] }[];
  conflicts_cleared: { env_name: string; start_date: ISODate; end_date: ISODate; projects: string[] }[];
  /** Set when the change would make a dependency loop; the change is then refused. */
  cycle?: string[];
};
