import {
  decodeMigrationAssessmentSource,
  type MigrationAssessmentSource,
} from "@openbot/contracts/ipc-migration-assessment";
import { Effect } from "effect";
import { MigrationAssessmentFailure } from "./migration-assessment-store";

/** Reads host identity metadata only. It does not inspect runtimes, accounts, secrets or devices. */
export const readMigrationAssessmentSource = Effect.fn("MigrationAssessment.readSource")(
  (options: { appVersion: () => string; platform?: () => NodeJS.Platform; architecture?: () => string }) =>
    Effect.try({
      try: (): Omit<MigrationAssessmentSource, "schemaVersion"> => {
        const platform = (options.platform ?? (() => process.platform))();
        if (platform !== "darwin" && platform !== "win32" && platform !== "linux")
          throw new MigrationAssessmentFailure({ code: "source-unavailable" });
        const architecture = (options.architecture ?? (() => process.arch))();
        const identity: MigrationAssessmentSource = {
          platform,
          architecture: architecture === "x64" || architecture === "arm64" ? architecture : "unsupported",
          appVersion: null,
          schemaVersion: null,
        };
        const reportedVersion = options.appVersion();
        try {
          identity.appVersion = decodeMigrationAssessmentSource({
            ...identity,
            appVersion: reportedVersion,
          }).appVersion;
        } catch {
          /* Noncanonical host versions are unknown, never converted into a compatibility match. */
        }
        return { platform: identity.platform, architecture: identity.architecture, appVersion: identity.appVersion };
      },
      catch: () => new MigrationAssessmentFailure({ code: "source-unavailable" }),
    }),
);
