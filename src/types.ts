export type Ats = 'greenhouse' | 'lever' | 'ashby' | 'smartrecruiters' | 'workable' | 'recruitee';

export const ATS_LIST: Ats[] = ['greenhouse', 'lever', 'ashby', 'smartrecruiters', 'workable', 'recruitee'];

/** Internal job record kept in cache. Description HTML is converted to text only for returned jobs. */
export interface RawJob {
  id: string;
  title: string | null;
  company: string;
  ats: Ats;
  boardToken: string;
  location: string | null;
  locations: string[];
  country: string | null;
  remote: boolean;
  workplaceType: 'remote' | 'hybrid' | 'onsite' | null;
  department: string | null;
  team: string | null;
  employmentType: string | null;
  salaryMin: number | null;
  salaryMax: number | null;
  salaryCurrency: string | null;
  salaryInterval: string | null;
  salaryText: string | null;
  postedAt: string | null;
  updatedAt: string | null;
  url: string | null;
  applyUrl: string | null;
  /** Raw HTML description (or plain text when the ATS gives only text). */
  descHtml: string | null;
  /** Plain description from the ATS when available (Ashby). */
  descPlain: string | null;
  /** Memo of the last text conversion (per max length), so cache hits skip the regex work. */
  _text?: { max: number; text: string | null; cut: boolean };
}

export interface Job {
  id: string;
  title: string | null;
  company: string;
  ats: Ats;
  boardToken: string;
  location: string | null;
  locations: string[];
  country: string | null;
  remote: boolean;
  workplaceType: 'remote' | 'hybrid' | 'onsite' | null;
  department: string | null;
  team: string | null;
  employmentType: string | null;
  /** full_time, part_time, contract, temporary, internship, or null when unknown. */
  employmentTypeNormalized: 'full_time' | 'part_time' | 'contract' | 'temporary' | 'internship' | null;
  salary: { min: number | null; max: number | null; currency: string | null; interval: string | null; text: string | null } | null;
  postedAt: string | null;
  updatedAt: string | null;
  url: string | null;
  applyUrl: string | null;
  description?: string | null;
  descriptionTruncated?: boolean;
  descriptionHtml?: string | null;
}

export interface Board {
  ats: Ats;
  boardToken: string;
  company: string;
  jobs: RawJob[];
  /** Total jobs the ATS reports (can exceed jobs.length when pagination was capped). */
  totalAvailable: number;
  truncated: boolean;
  fetchedAt: string;
  /** Number of upstream subrequests used to build this board (0 when served from cache). */
  subrequests: number;
}

export interface FetchOptions {
  /** Whether description content is needed (lets Greenhouse skip content=true). */
  withContent: boolean;
  /** Max pages for paginated providers (SmartRecruiters). */
  maxPages: number;
  /** Server-side keyword (SmartRecruiters only). */
  q?: string;
}
