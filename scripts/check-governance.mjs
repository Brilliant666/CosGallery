import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { root } from "./build-info.mjs";

// Deliberately small baseline: no whole-repository reformat or local hooks.
const exec = (...args) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true });
exec("diff", "--check");
exec("diff", "--cached", "--check");
for (const file of [
  "package.json",
  "server/package.json",
  "client/package.json",
  "docs/package.json",
]) {
  JSON.parse(readFileSync(new URL("../" + file, import.meta.url), "utf8"));
}
const files = exec("ls-files", "scripts/*.mjs")
  .trim()
  .split(/\r?\n/)
  .filter(Boolean);
for (const file of files)
  execFileSync(process.execPath, ["--check", file], {
    cwd: root,
    stdio: "pipe",
    windowsHide: true,
  });
console.log(
  `Governance lint: JSON manifests, diff whitespace, ${files.length} script syntax checks passed.`,
);
