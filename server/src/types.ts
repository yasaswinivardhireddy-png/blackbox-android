export type IssueKind = 'crash' | 'native_crash' | 'anr' | 'hang' | 'non_fatal' | 'leak' | 'jank' | 'exit';

export type Envelope = {
  schema: number;
  id: string;
  type: string;
  sessionId: string;
  timestamp: number;
  sdk?: string;
  app: { id: string; version: string; build: number; debuggable?: boolean; process?: string; pid?: number };
  device: { manufacturer: string; brand?: string; model: string; device?: string; sdkInt: number; release?: string; abis?: string[]; emulator?: boolean };
  state?: { foreground: boolean; sessionAgeMs: number };
  memory?: { heapUsedKb: number; heapMaxKb: number; nativeHeapKb: number };
  breadcrumbs?: { t: number; c: string; m: string }[];
  keys?: Record<string, string>;
  // Payload shapes vary by report type and come from devices, so fields are validated at use.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  payload: Record<string, any>;
};

export type DisplayFrame = { text: string; inApp: boolean; kind: 'java' | 'native' };

export type Classification = {
  category: string;
  explanation: string;
  confidence: 'high' | 'medium' | 'low';
  evidence: string[];
};

export type Analysis = Classification & {
  kind: IssueKind;
  title: string;
  location: string;
  frames: DisplayFrame[];
  threads?: { name: string; state: string; frames: DisplayFrame[] }[];
  fingerprint: string;
  retraced: boolean;
  symbolicated: boolean;
};

export const REPORT_TYPES = ['session', 'jvm_crash', 'native_crash', 'non_fatal', 'app_hang', 'app_exit', 'jank', 'leak', 'startup'] as const;
