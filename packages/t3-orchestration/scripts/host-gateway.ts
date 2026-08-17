export type HostGatewayConfig = {
  users?: string;
  port?: string;
};

function unescapeXml(value: string): string {
  return value.replaceAll("&quot;", '"').replaceAll("&gt;", ">").replaceAll("&lt;", "<").replaceAll("&amp;", "&");
}

function normalize(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function parseLaunchAgentGateway(plist: string): HostGatewayConfig {
  const read = (name: string): string | undefined => {
    const match = plist.match(new RegExp(`<string>${name}=([^<]*)</string>`));
    if (!match?.[1]) return undefined;
    return normalize(unescapeXml(match[1]));
  };
  const users = read("T3_ORCHESTRATION_TAILSCALE_USERS");
  const port = read("T3_ORCHESTRATION_HTTP_PORT");
  return {
    ...(users ? { users } : {}),
    ...(port ? { port } : {}),
  };
}

export function resolveHostGateway(env: HostGatewayConfig, existing?: HostGatewayConfig): HostGatewayConfig {
  const users = normalize(env.users) ?? normalize(existing?.users);
  const port = normalize(env.port) ?? normalize(existing?.port);
  return {
    ...(users ? { users } : {}),
    ...(port ? { port } : {}),
  };
}

export function assertHostGatewayNotDropped(existing: HostGatewayConfig | undefined, next: HostGatewayConfig): void {
  if (normalize(existing?.users) && !normalize(next.users)) {
    throw new Error(
      "Refusing to write a host LaunchAgent without T3_ORCHESTRATION_TAILSCALE_USERS; the existing LaunchAgent has the Tailscale gateway enabled",
    );
  }
}
