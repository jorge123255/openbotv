import { defineMessages } from "../../../message";
export const messages = defineMessages("error.hermesGateway", {
  "error.hermesGateway.address": "Enter a gateway URL without credentials, a query or a fragment.",
  "error.hermesGateway.callback": "This sign-in request was not accepted. Return to OpenBot and try again.",
  "error.hermesGateway.failed": "The Hermes gateway connection failed. Check the address and sign in again.",
  "error.hermesGateway.unsupported":
    "This gateway needs a password provider and native browser sign-in support. OAuth, SSH and remote HTTP are not supported here.",
  "error.hermesGateway.cancelled": "Hermes sign-in was cancelled or timed out.",
  "error.hermesGateway.rememberCancelled":
    "Nothing was remembered. Turn off Remember to select this profile for this session.",
  "error.hermesGateway.storage": "The saved Hermes gateway settings could not be changed. No credentials were saved.",
  "error.hermesGateway.profile": "Sign in and select a profile returned by this gateway.",
  "error.hermesGateway.busy": "This Hermes gateway is already signing in.",
  "error.hermesGateway.limit": "Remove a Hermes gateway before adding another.",
});
