#!/usr/bin/env bun

import { renderManagedCommandResponse } from "./managed-command/render-response.ts";

const response = renderManagedCommandResponse(await Bun.stdin.text());
if (response) console.log(response);
