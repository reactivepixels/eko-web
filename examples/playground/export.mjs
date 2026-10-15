#!/usr/bin/env node
/**
 * Copy the Playground into a static site, self-contained.
 *
 *   npm run build && node examples/playground/export.mjs <out-dir> [--base /url/of/out-dir/]
 *
 * With --base, every page gets a <base href> naming its own folder. Hosts that drop the
 * trailing slash (a Vercel site with trailingSlash: false serves /playground, not
 * /playground/) would otherwise resolve the pages' relative links one folder too high.
 *
 * Every player imports the engine from the repo's dist/ (../../../dist/*.js). In the export
 * those imports point at a lib/ folder beside the players instead, holding the browser
 * build of the engine copied from dist/. Tests and test-only helpers are left behind.
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dist = resolve(here, "../../dist");
const args = process.argv.slice(2);
const baseAt = args.indexOf("--base");
const base = baseAt >= 0 ? args.splice(baseAt, 2)[1] : null;
const out = args[0] && resolve(args[0]);

if (!out) {
  console.error("usage: node examples/playground/export.mjs <out-dir> [--base /url/of/out-dir/]");
  process.exit(1);
}
if (!existsSync(join(dist, "index.js"))) {
  console.error("dist/ is missing: run npm run build first.");
  process.exit(1);
}

const skip = (name) =>
  name.endsWith(".test.js") ||
  name === "export.mjs" ||
  name === "fake-context.js" ||
  name === ".DS_Store";

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

function copyTree(from, to) {
  for (const name of readdirSync(from)) {
    if (skip(name)) continue;
    const src = join(from, name);
    const dst = join(to, name);
    if (statSync(src).isDirectory()) {
      mkdirSync(dst, { recursive: true });
      copyTree(src, dst);
    } else {
      cpSync(src, dst);
    }
  }
}
copyTree(here, out);

// The engine's browser build: the ES modules and the chunks they share, no maps or CJS.
const lib = join(out, "lib");
mkdirSync(lib);
for (const name of readdirSync(dist)) {
  if (name.endsWith(".js")) cpSync(join(dist, name), join(lib, name));
}

const IMPORT = /(["'])(?:\.\.\/){3}dist\/([\w.-]+\.js)\1/g;
let rewritten = 0;
function rewrite(dir) {
  for (const name of readdirSync(dir)) {
    const file = join(dir, name);
    if (statSync(file).isDirectory()) {
      if (file !== lib) rewrite(file);
      continue;
    }
    if (![".js", ".html"].includes(extname(name))) continue;
    const text = readFileSync(file, "utf8");
    const toLib = relative(dirname(file), lib).split(sep).join("/");
    let next = text.replace(IMPORT, (_, q, mod) => `${q}${toLib}/${mod}${q}`);
    if (base && extname(name) === ".html") {
      const folder = relative(out, dirname(file)).split(sep).join("/");
      const href = `${base.replace(/\/?$/, "/")}${folder ? `${folder}/` : ""}`;
      next = next.replace(/<head>/i, `<head>\n    <base href="${href}" />`);
    }
    if (next !== text) {
      writeFileSync(file, next);
      rewritten += 1;
    }
  }
}
rewrite(out);

console.log(`Playground exported to ${out} (${rewritten} files pointed at lib/).`);
