import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const root = fileURLToPath(new URL("../", import.meta.url));

// Only called while building. Runtime code must never inspect the checkout.
export function createBuildInfo(cwd = root) {
  const run = (...args) =>
    execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  const version = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ).version;
  let commit = null,
    tree = null,
    dirty = null;
  try {
    commit = run("rev-parse", "HEAD");
    tree = run("rev-parse", "HEAD^{tree}");
    dirty = run("status", "--porcelain", "--untracked-files=normal").length > 0;
  } catch {
    /* Source archives without Git are explicitly unverified builds. */
  }
  return {
    product: "CosGallery",
    version,
    commit,
    tree,
    dirty,
    builtAt: new Date().toISOString(),
    node: process.version,
  };
}
