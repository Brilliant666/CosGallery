import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createBuildInfo, root } from "./build-info.mjs";

if (process.argv[2] !== "server")
  throw new Error("Expected server build target");
const dist = resolve(root, "server/dist");
mkdirSync(dist, { recursive: true });
writeFileSync(
  resolve(dist, "build-info.json"),
  JSON.stringify(createBuildInfo(), null, 2) + "\n",
);
