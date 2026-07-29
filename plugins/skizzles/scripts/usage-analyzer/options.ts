export type Bucket = "hour" | "day";

export type Options = {
  from: number;
  to: number;
  bucket: Bucket;
  cachedWeight: number;
  top: number;
  json: boolean;
};

export type ParsedOptions =
  | { kind: "help" }
  | { kind: "analyze"; options: Options };

export const HELP_TEXT = `Usage: bun scripts/analyze.ts --from <date/time> [options]

Analyze Codex rollout usage across active and archived sessions. By default,
the analyzer uses $CODEX_HOME when set, otherwise $HOME/.codex.

Options:
  --from <value>          Inclusive range start (required)
  --to <value>            Inclusive range end (default: now)
  --bucket hour|day       Timeline granularity (default: day)
  --cached-weight <0..1>  Cache-adjusted comparison weight (default: 0.1)
  --top <count>           Maximum rows in ranked tables (default: 10)
  --json                  Emit machine-readable JSON
  -h, --help              Show this help

Local forms like "2026-07-13 07:00" use the machine timezone. A date-only
--to value includes that entire local day. The comparison proxy is not quota
or billing: uncached input + cached input * weight + output.`;

function parseDate(value: string, endOfDay = false): number {
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (dateOnly) {
    const [, year, month, day] = dateOnly;
    return new Date(
      Number(year),
      Number(month) - 1,
      Number(day),
      endOfDay ? 23 : 0,
      endOfDay ? 59 : 0,
      endOfDay ? 59 : 0,
      endOfDay ? 999 : 0,
    ).getTime();
  }
  const local = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value);
  if (local) {
    const [, year, month, day, hour, minute, second = "0"] = local;
    return new Date(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      Number(second),
    ).getTime();
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new Error(`Invalid date/time: ${value}`);
  return timestamp;
}

export function parseOptions(argv: string[]): ParsedOptions {
  let from: number | undefined;
  let to = Date.now();
  let bucket: Bucket = "day";
  let cachedWeight = 0.1;
  let top = 10;
  let json = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = (): string => {
      const value = argv[++index];
      if (!value) throw new Error(`${arg} requires a value`);
      return value;
    };
    if (arg === "--from") from = parseDate(next());
    else if (arg === "--to") to = parseDate(next(), true);
    else if (arg === "--bucket") {
      const value = next();
      if (value !== "hour" && value !== "day") throw new Error("--bucket must be hour or day");
      bucket = value;
    } else if (arg === "--cached-weight") cachedWeight = Number(next());
    else if (arg === "--top") top = Number(next());
    else if (arg === "--json") json = true;
    else if (arg === "--help" || arg === "-h") return { kind: "help" };
    else throw new Error(`Unknown argument: ${arg}`);
  }

  if (from === undefined) throw new Error("--from is required");
  if (!Number.isFinite(cachedWeight) || cachedWeight < 0 || cachedWeight > 1) {
    throw new Error("--cached-weight must be between 0 and 1");
  }
  if (!Number.isInteger(top) || top < 1) throw new Error("--top must be a positive integer");
  if (from > to) throw new Error("--from must not be after --to");
  return { kind: "analyze", options: { from, to, bucket, cachedWeight, top, json } };
}
