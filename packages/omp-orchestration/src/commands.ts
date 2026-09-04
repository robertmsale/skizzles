import { ServiceError, optionalString, requireProjectId, requiredString } from "./protocol.ts";
import type { OmpManager } from "./manager.ts";

export async function executeCommand(command: Record<string, unknown>, manager: OmpManager): Promise<unknown> {
  const op = requiredString(command.op, "operation", 80);
  switch (op) {
    case "health": return { service: "omp-orchestrationd", schema: 1 };
    case "projects.list": return manager.projects.list();
    case "projects.add": return manager.registerProject({
      id: optionalString(command.id, "project id", 64),
      name: optionalString(command.name, "project name", 120),
      cwd: requiredString(command.cwd, "project cwd", 4096),
      baseBranch: optionalString(command.baseBranch, "base branch", 255),
      model: optionalString(command.model, "model", 255),
      thinking: optionalString(command.thinking, "thinking", 32),
      autoPublish: command.autoPublish === undefined ? true : requireBoolean(command.autoPublish, "autoPublish"),
    });
    case "projects.remove": return manager.removeProject(requireProjectId(command.projectId));
    case "projects.start": await manager.enableProject(requireProjectId(command.projectId)); return manager.status(requireProjectId(command.projectId));
    case "projects.stop": await manager.stopProject(requireProjectId(command.projectId)); return manager.status(requireProjectId(command.projectId));
    case "maintainers.status": return manager.status(requireProjectId(command.projectId));
    case "maintainers.send": return manager.send(requireProjectId(command.projectId), requiredString(command.message, "message"));
    case "maintainers.history": return manager.history(requireProjectId(command.projectId), optionalString(command.cursor, "cursor", 4096), boundedInteger(command.limit, 50, 1, 200, "limit"));
    case "maintainers.subagents": return manager.subagents(requireProjectId(command.projectId));
    case "maintainers.abort": return manager.abort(requireProjectId(command.projectId));
    case "jobs.list": return manager.state.jobs(optionalProjectId(command.projectId));
    case "jobs.read": {
      const projectId = requireProjectId(command.projectId);
      const job = manager.state.job(projectId, requiredString(command.jobId, "job id", 128));
      if (!job) throw new ServiceError("job not found", "not_found", 404);
      return job;
    }
    case "jobs.publish": return manager.publish(requireProjectId(command.projectId), requiredString(command.jobId, "job id", 128));
    case "approvals.list": return manager.approvals(optionalProjectId(command.projectId));
    case "approvals.approve": return manager.resolveApproval(
      requireProjectId(command.projectId),
      requiredString(command.approvalId, "approval id", 128),
      { approved: true, ...(command.value !== undefined ? { value: requiredString(command.value, "approval value") } : {}) },
    );
    case "approvals.deny": return manager.resolveApproval(
      requireProjectId(command.projectId),
      requiredString(command.approvalId, "approval id", 128),
      { approved: false },
    );
    case "events.list": return manager.events(
      boundedInteger(command.after, 0, 0, Number.MAX_SAFE_INTEGER, "after"),
      optionalProjectId(command.projectId),
      boundedInteger(command.limit, 200, 1, 1000, "limit"),
    );
    case "events.wait": {
      const after = boundedInteger(command.after, 0, 0, Number.MAX_SAFE_INTEGER, "after");
      const projectId = optionalProjectId(command.projectId);
      await manager.waitForEvent(after, boundedInteger(command.timeoutMs, 55_000, 0, 58_000, "timeoutMs"), projectId);
      return manager.events(after, projectId, boundedInteger(command.limit, 200, 1, 1000, "limit"));
    }
    case "ingress.accept": return manager.acceptIngress({
      projectId: requireProjectId(command.projectId),
      source: requiredString(command.source, "ingress source", 120),
      sourceKey: requiredString(command.sourceKey, "ingress source key", 255),
      kind: requiredString(command.kind, "ingress kind", 120),
      payload: command.payload ?? null,
      message: requiredString(command.message, "ingress message"),
    });
    default: throw new ServiceError(`unknown operation: ${op}`, "not_found", 404);
  }
}

function optionalProjectId(value: unknown): string | undefined {
  return value === undefined || value === null ? undefined : requireProjectId(value);
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new ServiceError(`${label} must be a boolean`, "invalid_request");
  return value;
}

function boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number, label: string): number {
  if (value === undefined || value === null) return fallback;
  const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new ServiceError(`${label} must be an integer from ${minimum} through ${maximum}`, "invalid_request");
  }
  return parsed;
}
