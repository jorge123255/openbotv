// Build-time guard only. It must never be imported by the Electron bootstrap or application graph.
import { resolve } from "node:path";
import type { Plugin } from "vite";

const normalized = (path: string | null) => path?.replaceAll("\\", "/");

export function offlineEntryIntegrity(): Plugin {
  return {
    name: "openbot-offline-entry-integrity",
    enforce: "post",
    generateBundle(options, bundle) {
      const entry = bundle["index.js"];
      const application = bundle["application.js"];
      if (
        options.format !== "es" ||
        !entry ||
        entry.type !== "chunk" ||
        !application ||
        application.type !== "chunk" ||
        !entry.isEntry ||
        !application.isEntry ||
        normalized(entry.facadeModuleId) !== normalized(resolve("src/main/startup-entry.ts")) ||
        normalized(application.facadeModuleId) !== normalized(resolve("src/main/index.ts")) ||
        entry.imports.length !== 0 ||
        entry.dynamicImports.length !== 1 ||
        entry.dynamicImports[0] !== "application.js" ||
        Object.keys(entry.modules).some((id) => normalized(id) !== normalized(resolve("src/main/startup-entry.ts")))
      )
        this.error("OPENBOT_OFFLINE_ENTRY_GRAPH_INVALID");

      const tree = this.parse(entry.code);
      let importCount = 0;
      let hasRequire = false;
      // ESTree children have different shapes. Inspect every object/array, without an assertion
      // or a partial visitor that could miss an eager import in a newly added expression.
      const visit = (node: unknown): void => {
        if (!node || typeof node !== "object") return;
        if (Array.isArray(node)) {
          for (const child of node) visit(child);
          return;
        }
        if ("type" in node && node.type === "ImportExpression") importCount++;
        if ("type" in node && node.type === "Identifier" && "name" in node && node.name === "require")
          hasRequire = true;
        for (const child of Object.values(node)) visit(child);
      };
      visit(tree);
      if (hasRequire || importCount !== 1) this.error("OPENBOT_OFFLINE_ENTRY_GRAPH_INVALID");
      const awaitsApplication = tree.body.some((statement) => {
        if (statement.type !== "IfStatement" || !statement.alternate) return false;
        const alternate =
          statement.alternate.type === "BlockStatement" ? statement.alternate.body : [statement.alternate];
        return (
          alternate.length === 1 &&
          alternate.some(
            (item) =>
              item.type === "ExpressionStatement" &&
              item.expression.type === "AwaitExpression" &&
              item.expression.argument.type === "ImportExpression" &&
              item.expression.argument.source.type === "Literal" &&
              item.expression.argument.source.value === "./application.js",
          )
        );
      });
      if (!awaitsApplication) this.error("OPENBOT_OFFLINE_ENTRY_AWAIT_REQUIRED");
    },
  };
}
