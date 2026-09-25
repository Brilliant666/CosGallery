import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createBuildInfo, root } from "./build-info.mjs";

test("build identity records source at build time without private paths", () => {
  const value = createBuildInfo();
  const commit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  assert.equal(value.commit, commit);
  assert.match(value.tree, /^[a-f0-9]{40}$/);
  assert.equal(value.product, "CosGallery");
  assert.equal(typeof value.dirty, "boolean");
  assert.deepEqual(
    Object.keys(value).sort(),
    ["product", "version", "commit", "tree", "dirty", "builtAt", "node"].sort(),
  );
  assert(!JSON.stringify(value).includes(root));
});

test("source archive outside Git is explicitly unverified, not current runtime HEAD", () => {
  const folder = mkdtempSync(join(tmpdir(), "cosgallery-build-test-"));
  try {
    const value = createBuildInfo(folder);
    assert.equal(value.commit, null);
    assert.equal(value.tree, null);
    assert.equal(value.dirty, null);
  } finally {
    rmSync(folder, { recursive: true });
  }
});
