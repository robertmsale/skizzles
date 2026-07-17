import { FastMCP } from "fastmcp";
import { createLifecycle } from "./lifecycle";
import { registerHealthTool } from "./tools/health";

const serverName = "project-env";
const lifecycle = createLifecycle({
  repoRoot: process.cwd(),
  serverName,
});

await lifecycle.start();

const server = new FastMCP({
  name: serverName,
  version: "0.1.0",
});

registerHealthTool(server, lifecycle);

server.start({ transportType: "stdio" });
