import { defineConfig } from "tsup";

export default defineConfig({
  // Core engine is the main entry. Adapters (element facade, React hook) are added
  // as separate entries in Phase 4 so the core never pulls in React.
  entry: { index: "src/index.ts" },
  format: ["esm", "cjs"],
  dts: true,
  splitting: true,
  treeshake: true,
  clean: true,
  sourcemap: true,
  minify: false,
  // No framework deps in the core. React is only external once the React adapter lands.
  external: ["react", "react-dom"],
  outExtension({ format }) {
    return { js: format === "cjs" ? ".cjs" : ".js" };
  },
});
