import { defineConfig } from "tsup";

export default defineConfig({
  // Core engine is the main entry; the HTMLMediaElement facade is a separate entry so
  // it's tree-shakeable and the core stays framework-agnostic.
  entry: {
    index: "src/index.ts",
    element: "src/adapters/eko-audio-element.ts",
    replaygain: "src/replaygain/index.ts",
    "media-session": "src/media-session/index.ts",
    react: "src/react/index.ts",
    vue: "src/vue/index.ts",
  },
  format: ["esm", "cjs"],
  dts: true,
  splitting: true,
  treeshake: true,
  clean: true,
  sourcemap: true,
  minify: false,
  // No framework deps in the core. React/Vue are only external once their bindings land.
  external: ["react", "react-dom", "vue"],
  outExtension({ format }) {
    return { js: format === "cjs" ? ".cjs" : ".js" };
  },
});
