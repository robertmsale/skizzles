import type { FastMCP } from "fastmcp";
import { z } from "zod";
import type { ProjectLifecycle } from "../lifecycle";

export function registerHealthTool(server: FastMCP, lifecycle: ProjectLifecycle): void {
  server.addTool({
    name: "health",
    description: "Return a compact health check for this MCP server.",
    parameters: z.object({
      verbose: z.boolean().optional(),
    }),
    execute: async ({ verbose }) => JSON.stringify(lifecycle.snapshot(verbose)),
  });
}
