import type { WorkflowDetail, WorkflowGraph } from "@openbot/contracts/ipc";

/** Observes only the synthetic host of the workflow canvas regression story. */
export interface WorkflowStarterFixtureState {
  current: WorkflowDetail | undefined;
  workflows: WorkflowDetail[];
  changes: WorkflowGraph[];
  creates: number;
  runs: number;
}

export interface WorkflowStarterFixture {
  read(): Promise<WorkflowStarterFixtureState>;
  savedNodeCount(): number;
  setReadOnly(value: boolean): void;
}

declare global {
  interface Window {
    openbotWorkflowStarterFixture?: WorkflowStarterFixture;
  }
}
