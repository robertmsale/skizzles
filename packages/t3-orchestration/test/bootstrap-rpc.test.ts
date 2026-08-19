import { describe, expect, test } from "bun:test";
import { bootstrapRpcRequest, bootstrapRpcResponse, requiresRpcDispatch, taskApprovalRespondCommand, taskLifecycleCommand, taskTitleCommand } from "../src/t3.ts";

describe("T3 bootstrap RPC wire format", () => {
  test("uses the Effect-RPC shape expected by T3's layerJson websocket serializer", () => {
    expect(bootstrapRpcRequest("request-1", { type: "thread.turn.start" })).toEqual({
      _tag: "Request",
      id: "request-1",
      tag: "orchestration.dispatchCommand",
      payload: { type: "thread.turn.start" },
      headers: [],
    });
  });

  test("supports read-only RPC tags for provider preflight", () => {
    expect(bootstrapRpcRequest("request", {}, "server.getConfig")).toEqual({
      _tag: "Request",
      id: "request",
      tag: "server.getConfig",
      payload: {},
      headers: [],
    });
  });

  test("accepts matching results and preserves useful failures", () => {
    expect(bootstrapRpcResponse('{"_tag":"Exit","requestId":"request-1","exit":{"_tag":"Success","value":{"sequence":42}}}', "request-1")).toEqual({
      type: "success",
      value: { sequence: 42 },
    });
    expect(bootstrapRpcResponse('{"_tag":"Exit","requestId":"request-1","exit":{"_tag":"Failure","cause":[{"_tag":"Fail","error":{"message":"nope"}}]}}', "request-1")).toEqual({
      type: "failure",
      message: 'T3 WebSocket dispatch failed: [{"_tag":"Fail","error":{"message":"nope"}}]',
    });
  });

  test("ignores unrelated protocol frames and fails malformed JSON", () => {
    expect(bootstrapRpcResponse('{"_tag":"Ping"}', "request-1")).toEqual({
      type: "ignore",
      description: "Ping requestId=undefined",
    });
    expect(bootstrapRpcResponse("not-json", "request-1")).toEqual({
      type: "failure",
      message: "T3 WebSocket bootstrap returned malformed JSON",
    });
  });

  test("routes bootstrap and parking commands through the server's WS cleanup layer", () => {
    expect(requiresRpcDispatch({ type: "thread.turn.start", bootstrap: {} })).toBe(true);
    expect(requiresRpcDispatch({ type: "thread.archive" })).toBe(true);
    expect(requiresRpcDispatch({ type: "thread.settle" })).toBe(true);
    expect(requiresRpcDispatch({ type: "thread.pin" })).toBe(false);
    expect(requiresRpcDispatch({ type: "thread.approval.respond" })).toBe(false);
  });

  test("maps coordinator approve and deny onto T3 thread.approval.respond", () => {
    expect(taskApprovalRespondCommand("task", "req-1", "accept", "command", "now", {
      requestKind: "command",
      command: "git status",
      cwd: "/worktree",
      toolName: "Shell",
    })).toEqual({
      type: "thread.approval.respond",
      commandId: "command",
      threadId: "task",
      requestId: "req-1",
      decision: "accept",
      createdAt: "now",
    });
    expect(taskApprovalRespondCommand("task", "req-1", "decline", "command", "now")).toEqual({
      type: "thread.approval.respond",
      commandId: "command",
      threadId: "task",
      requestId: "req-1",
      decision: "decline",
      createdAt: "now",
    });
  });

  test("management commands never include model or reasoning overrides", () => {
    expect(taskTitleCommand("task", "Title", "command")).toEqual({ type: "thread.meta.update", commandId: "command", threadId: "task", title: "Title" });
    expect(taskLifecycleCommand("archive", "task", "command", "now")).toEqual({ type: "thread.archive", commandId: "command", threadId: "task" });
    expect(taskLifecycleCommand("unsettle", "task", "command", "now")).toEqual({ type: "thread.unsettle", commandId: "command", threadId: "task", reason: "user" });
    expect(taskLifecycleCommand("interrupt", "task", "command", "now")).toEqual({ type: "thread.turn.interrupt", commandId: "command", threadId: "task", createdAt: "now" });
  });
});
