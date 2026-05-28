export interface CallFrame {
  functionName: string;
  url: string;
  scriptId: string;
  lineNumber: number;
  columnNumber: number;
}

export interface ProfileNode {
  id: number;
  callFrame: CallFrame;
  hitCount: number;
  children?: number[];
  positionTicks?: { line: number; ticks: number }[];
}

export interface CpuProfile {
  nodes: ProfileNode[];
  startTime: number;
  endTime: number;
  samples: number[];
  timeDeltas: number[];
}

export interface AggregatedNode {
  id: number;
  callFrame: CallFrame;
  selfTime: number;
  totalTime: number;
  hitCount: number;
  children: number[];
  parent: number | null;
  positionTicks?: { line: number; ticks: number }[];
}

export interface ParsedProfile {
  id: string;
  filename: string;
  nodes: Map<number, AggregatedNode>;
  totalDuration: number;
  sampleCount: number;
  root: number;
}
