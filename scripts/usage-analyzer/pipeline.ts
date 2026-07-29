import {
  listRollouts,
  loadTitles,
  readLines,
  resolveCodexHome,
} from "./adapters";
import { HELP_TEXT, parseOptions } from "./options";
import { buildReport } from "./report";
import { renderHuman } from "./render";
import { parseRollout, type ParsedRollout } from "./rollout";

async function decodeRollouts(
  paths: string[],
  options: Parameters<typeof parseRollout>[1],
): Promise<ParsedRollout[]> {
  const rollouts: ParsedRollout[] = [];
  for (let index = 0; index < paths.length; index += 8) {
    rollouts.push(
      ...await Promise.all(
        paths
          .slice(index, index + 8)
          .map((path) => parseRollout(path, options, readLines)),
      ),
    );
  }
  return rollouts;
}

export async function runAnalysis(argv: string[]): Promise<void> {
  const parsedOptions = parseOptions(argv);
  if (parsedOptions.kind === "help") {
    console.log(HELP_TEXT);
    return;
  }

  const { options } = parsedOptions;
  const codexHome = resolveCodexHome(process.env);
  const paths = await listRollouts(codexHome);
  const rollouts = await decodeRollouts(paths, options);
  const titles = loadTitles(codexHome);
  const report = buildReport(options, paths.length, rollouts, titles);
  console.log(options.json ? JSON.stringify(report, null, 2) : renderHuman(report));
}
