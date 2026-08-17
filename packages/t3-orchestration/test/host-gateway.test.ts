import { describe, expect, test } from "bun:test";
import { assertHostGatewayNotDropped, parseLaunchAgentGateway, resolveHostGateway } from "../scripts/host-gateway.ts";

describe("host LaunchAgent gateway resolution", () => {
  test("preserves an existing allowlist and HTTP port when env is unset", () => {
    expect(resolveHostGateway({}, { users: "robertmsale@icloud.com", port: "43773" })).toEqual({
      users: "robertmsale@icloud.com",
      port: "43773",
    });
  });

  test("does not invent an allowlist or port", () => {
    expect(resolveHostGateway({}, {})).toEqual({});
    expect(resolveHostGateway({ users: "  ", port: " " })).toEqual({});
  });

  test("uses an explicit env allowlist or port without inventing the other", () => {
    expect(resolveHostGateway(
      { users: "other@example.com" },
      { users: "robertmsale@icloud.com", port: "43773" },
    )).toEqual({
      users: "other@example.com",
      port: "43773",
    });
    expect(resolveHostGateway({ port: "54321" }, { users: "owner@example.com" })).toEqual({
      users: "owner@example.com",
      port: "54321",
    });
  });

  test("refuses to write a gateway-less plist over an existing allowlist", () => {
    expect(() => assertHostGatewayNotDropped({ users: "owner@example.com" }, {})).toThrow(
      "Refusing to write a host LaunchAgent without T3_ORCHESTRATION_TAILSCALE_USERS",
    );
    expect(() => assertHostGatewayNotDropped({ users: "owner@example.com" }, { users: "owner@example.com" })).not.toThrow();
    expect(() => assertHostGatewayNotDropped({}, {})).not.toThrow();
  });
});

describe("parseLaunchAgentGateway", () => {
  test("reads the existing LaunchAgent env assignments", () => {
    expect(parseLaunchAgentGateway(`
      <string>HOME=/Users/robertsale</string>
      <string>T3_ORCHESTRATION_TAILSCALE_USERS=robertmsale@icloud.com</string>
      <string>T3_ORCHESTRATION_HTTP_PORT=43773</string>
    `)).toEqual({
      users: "robertmsale@icloud.com",
      port: "43773",
    });
  });

  test("treats a missing or empty assignment as gateway-less", () => {
    expect(parseLaunchAgentGateway("<plist></plist>")).toEqual({});
    expect(parseLaunchAgentGateway("<string>T3_ORCHESTRATION_TAILSCALE_USERS=</string>")).toEqual({});
  });
});
