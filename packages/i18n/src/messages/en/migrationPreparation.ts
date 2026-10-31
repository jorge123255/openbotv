import { defineMessages } from "../../message";

export const messages = defineMessages("migrationPreparation", {
  "migrationPreparation.title": "Migration preparation",
  "migrationPreparation.description":
    "Save a preparation plan for this OpenBot instance. This step does not move data, credentials, or running agents.",
  "migrationPreparation.destination.label": "Destination type",
  "migrationPreparation.destination.local-desktop": "Local desktop",
  "migrationPreparation.destination.docker-host": "Docker host",
  "migrationPreparation.destination.other-server": "Other server",
  "migrationPreparation.destination.description":
    "Choose where you want to host OpenBot. No destination is connected or configured here.",
  "migrationPreparation.prepare": "Save preparation plan",
  "migrationPreparation.preparing": "Saving preparation plan…",
  "migrationPreparation.newPlan": "Save a new preparation plan",
  "migrationPreparation.reload": "Reload saved plan",
  "migrationPreparation.loading": "Reading saved plan…",
  "migrationPreparation.cancel": "Cancel preparation plan",
  "migrationPreparation.cancelling": "Cancelling preparation plan…",
  "migrationPreparation.status.prepared": "Preparation plan saved",
  "migrationPreparation.status.cancelled": "Preparation plan cancelled",
  "migrationPreparation.savedDestination": "Saved destination type",
  "migrationPreparation.updatedAt": "Last saved",
  "migrationPreparation.provisionalInventory": "Provisional record counts",
  "migrationPreparation.metadataOnly":
    "These metadata counts are a preparation record. They are not a consistent snapshot or a verified file inventory. A saved plan can become out of date.",
  "migrationPreparation.counts.agents": "Agent records",
  "migrationPreparation.counts.conversations": "Conversation threads",
  "migrationPreparation.counts.messages": "Message records",
  "migrationPreparation.counts.attachments": "Attachment records",
  "migrationPreparation.counts.routines": "Agent routine definitions",
  "migrationPreparation.blockers.title": "Unresolved requirements",
  "migrationPreparation.blockers.destination-unconfigured": "The destination is not configured or verified.",
  "migrationPreparation.blockers.snapshot-unavailable": "A consistent snapshot and its verification are not available.",
  "migrationPreparation.blockers.credentials-unavailable":
    "Credential transfer and required sign-ins are not resolved.",
  "migrationPreparation.blockers.fencing-unavailable": "A verified single-writer cutover is not available.",
  "migrationPreparation.blockers.restore-unavailable": "A verified destination restore is not available.",
  "migrationPreparation.blockers.activation-unavailable": "Destination activation is not available.",
  "migrationPreparation.unavailable":
    "Export, restore, and activation are unavailable in preparation. This plan does not establish a complete migration.",
  "migrationPreparation.actions": "Migration actions",
  "migrationPreparation.export": "Export",
  "migrationPreparation.restore": "Restore",
  "migrationPreparation.activate": "Activate",
});
