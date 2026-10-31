import { defineMessages } from "../../message";

export const messages = defineMessages("migrationDestinationPolicy", {
  "migrationDestinationPolicy.title": "Approved migration policy",
  "migrationDestinationPolicy.description":
    "Read the approved scope for this prepared Docker plan. This does not connect to a destination.",
  "migrationDestinationPolicy.blocked":
    "Destination verification is unavailable. No release tag or build has been verified. Export, restore, and activation remain unavailable.",
  "migrationDestinationPolicy.stale":
    "The preparation plan changed. Reload the saved plan and policy status before you continue.",
  "migrationDestinationPolicy.repository": "Approved repository",
  "migrationDestinationPolicy.workflow": "Approved release workflow",
  "migrationDestinationPolicy.issuer": "Required attestation issuer",
  "migrationDestinationPolicy.imageRepository": "Approved image repository",
  "migrationDestinationPolicy.runtime": "Required runtime",
  "migrationDestinationPolicy.dockerToDocker": "Docker to Docker only",
  "migrationDestinationPolicy.releaseTag": "Approved release tag",
  "migrationDestinationPolicy.noApprovedTag": "No release tag is approved yet",
  "migrationDestinationPolicy.exactBuild": "Exact build required",
  "migrationDestinationPolicy.exactBuildDescription":
    "Both ends must use the same verified Linux platform manifest and image configuration from an explicitly approved release tag. Matching versions or image tags are not proof. Source and destination runtime binding is unavailable.",
  "migrationDestinationPolicy.unavailableTitle": "Missing verification providers",
  "migrationDestinationPolicy.unavailable.approved-release-tag-unavailable":
    "Approval of a specific release tag is unavailable.",
  "migrationDestinationPolicy.unavailable.attestation-verifier-unavailable":
    "Release attestation verification is unavailable.",
  "migrationDestinationPolicy.unavailable.runtime-binding-unavailable":
    "Binding verified artifacts to the running source and destination is unavailable.",
  "migrationDestinationPolicy.unavailable.pairing-approval-unavailable": "An approved pairing record is unavailable.",
  "migrationDestinationPolicy.unavailable.source-authentication-unavailable":
    "Authenticated source requests are unavailable.",
  "migrationDestinationPolicy.reload": "Reload policy status",
  "migrationDestinationPolicy.loading": "Reading policy status…",
});
