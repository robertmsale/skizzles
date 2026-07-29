#!/usr/bin/env bun

import { runCommandLine } from "./codex-command/cli.ts";

await runCommandLine(process.argv.slice(2));
