#!/usr/bin/env bun
export { cliMain, serializePublicJson } from "./commands/cli";

import { cliMain } from "./commands/cli";

if (import.meta.main) process.exit(await cliMain());
