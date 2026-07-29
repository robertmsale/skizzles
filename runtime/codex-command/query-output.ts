import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  commandOutputRoot,
  readArtifactTail,
  requireRunDirectory,
} from "./artifact-store.ts";

export function printRunStatus(id: string): void {
  process.stdout.write(readFileSync(join(requireRunDirectory(id), "status.json"), "utf8"));
}

export function printRunTail(id: string, stream: string | undefined): void {
  const selected = stream ?? "stdout";
  if (selected !== "stdout" && selected !== "stderr") {
    throw new Error("stream must be stdout or stderr");
  }
  const filename = selected === "stdout" ? "stdout.log" : "stderr.log";
  const content = readArtifactTail(join(requireRunDirectory(id), filename));
  process.stdout.write(content);
  if (!content.endsWith("\n")) process.stdout.write("\n");
}

export function searchRunOutput(needle: string, id: string | undefined): void {
  if (!needle || needle.length > 256) {
    throw new Error("search text must be 1-256 characters");
  }
  const directories = id
    ? [requireRunDirectory(id)]
    : readdirSync(commandOutputRoot()).map((name) => join(commandOutputRoot(), name));
  for (const directory of directories) {
    for (const filename of ["stdout.log", "stderr.log"]) {
      const path = join(directory, filename);
      try {
        if (readFileSync(path, "utf8").includes(needle)) {
          console.log(`${directory}/${filename}`);
        }
      } catch {}
    }
  }
}
