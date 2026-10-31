// Keep this entry import-free. A rehearsal request must be refused before the application graph.
// This is a deny-only interlock, not a supported offline application mode or a host fence.
export {};

const reservedRehearsalName = (name: string) =>
  name
    .trimStart()
    .toLowerCase()
    .replaceAll("_", "-")
    .replace(/^-+/, "")
    .replace(/^no-/, "")
    .startsWith("openbot-offline-rehearsal");

const rehearsalRequested =
  process.argv.some(reservedRehearsalName) || Object.keys(process.env).some(reservedRehearsalName);

if (rehearsalRequested) {
  // Machine-readable: no argument, environment value, path, account or logger is read for output.
  process.stderr.write("OPENBOT_OFFLINE_REHEARSAL_UNAVAILABLE\n");
  process.exit(78);
} else {
  // Electron must await this import before ready; the application registers pre-ready policies.
  await import("./index");
}
