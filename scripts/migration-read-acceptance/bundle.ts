import assert from "node:assert/strict";
import { isBuiltin } from "node:module";
import { resolve } from "node:path";
import { build } from "vite";

const root = resolve(import.meta.dirname, "../..");
const entry = resolve(import.meta.dirname, "reader.ts");
const backendFiles = new Set(
  ["conversation-queries.ts", "database-rows.ts", "legacy-conversation-message.ts", "search-sql-functions.ts"].map(
    (name) => resolve(root, "src/backend/database", name),
  ),
);
const readerBuiltins = new Set(["node:assert/strict", "node:crypto", "node:fs", "node:os", "node:path", "node:sqlite"]);

/** Bundles only the audited read graph. Unexpected sources fail before they can load. */
export async function buildAcceptanceReader(outDir: string, poison = false): Promise<number> {
  let bundledModules = 0;
  await build({
    configFile: false,
    envDir: false,
    logLevel: "silent",
    plugins: [
      {
        name: "migration-read-graph",
        enforce: "pre",
        resolveId(source, importer) {
          if (!isBuiltin(source)) return null;
          assert.ok(importer === entry && readerBuiltins.has(source), "READ_GRAPH_BUILTIN_REFUSED");
          return { id: source, external: true };
        },
        load(id) {
          const path = id.split("?")[0];
          if (!path) throw new Error("READ_GRAPH_SOURCE_REFUSED");
          if (path === entry) return null;
          if (backendFiles.has(path) || path.startsWith(`${root}/packages/contracts/src/`)) return null;
          if (path.includes("/node_modules/emoji-regex/")) return null;
          throw new Error("READ_GRAPH_SOURCE_REFUSED");
        },
        transform(code, id) {
          if (poison && id === entry) return `import "../../src/backend/openbot-database";\n${code}`;
          return null;
        },
        generateBundle(_options, bundle) {
          const chunks = Object.values(bundle);
          assert.equal(chunks.length, 1, "READ_GRAPH_CHUNKS_REFUSED");
          const chunk = chunks[0];
          if (chunk?.type !== "chunk") throw new Error("READ_GRAPH_CHUNKS_REFUSED");
          assert.equal(chunk.dynamicImports.length, 0, "READ_GRAPH_DYNAMIC_REFUSED");
          assert.ok(
            chunk.imports.every((name) => readerBuiltins.has(name)),
            "READ_GRAPH_IMPORT_REFUSED",
          );
          assert.ok(Object.keys(chunk.modules).includes(resolve(root, "src/backend/database/conversation-queries.ts")));
          bundledModules = Object.keys(chunk.modules).length;
        },
      },
    ],
    ssr: { noExternal: true },
    build: {
      ssr: entry,
      outDir,
      emptyOutDir: false,
      minify: false,
      sourcemap: false,
      rolldownOptions: {
        platform: "neutral",
        output: { format: "es", entryFileNames: "reader.mjs", codeSplitting: false, polyfillRequire: false },
      },
    },
  });
  assert.ok(bundledModules > 0);
  return bundledModules;
}
