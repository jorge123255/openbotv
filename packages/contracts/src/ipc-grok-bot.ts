export interface GrokBotSignInStart {
  readonly verificationUrl: string;
}

export interface GrokBotAgentSummary {
  readonly id: string;
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly hidden: boolean;
  readonly room: boolean;
}

export interface CreateGrokBotAgentInput {
  readonly name: string;
  readonly description: string;
}

export type GrokBotAccountEvent =
  | { readonly phase: "signed-in" }
  | { readonly phase: "signed-out" }
  | { readonly phase: "failed"; readonly message: string };
