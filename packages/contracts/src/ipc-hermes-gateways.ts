/** Local desktop gateway setup. No credential or authorization URL crosses this boundary. */
interface HermesGatewayProviderChoice {
  id: string;
  name: string;
  supported: boolean;
}
interface HermesGatewayProfileChoice {
  id: string;
  name: string;
}
export interface HermesGatewaySetup {
  id: string;
  url: string;
  phase: "discovered" | "signing-in" | "connected" | "signed-out";
  remembered: boolean;
  selectedProfileId: string | null;
  expiresAt: number | null;
  providers: HermesGatewayProviderChoice[];
  profiles: HermesGatewayProfileChoice[];
}
export interface ProbeHermesGatewayInput {
  url: string;
  id?: string;
}
export interface SignInHermesGatewayInput {
  id: string;
  providerId: string;
}
export interface SelectHermesGatewayProfileInput {
  id: string;
  profileId: string;
  remember: boolean;
}
