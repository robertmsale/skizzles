#!/usr/bin/env bun
export {
  REAPER_OUTPUT_MAX_BYTES,
  reaperMain,
  reaperOutput,
  type ReaperCliOutput,
} from "./commands/reaper";

import { reaperMain } from "./commands/reaper";

if (import.meta.main) process.exit(await reaperMain());
