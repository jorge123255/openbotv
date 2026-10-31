import { defineMessages } from "../../../message";

export const messages = defineMessages("error.migration", {
  "error.migration.assessmentFailed":
    "OpenBot could not confirm the assessment request. Reload the assessment and the preparation plan before you try again.",
  "error.migration.preparationFailed":
    "OpenBot could not confirm the preparation request. Reload the saved plan and try again.",
  "error.migration.destinationPolicyReadFailed":
    "OpenBot could not read the migration policy status. Reload the saved plan and try again.",
});
