import type { Job, Project } from "./protocol.ts";
import { checkedCommand, runCommand } from "./process.ts";
import { OrchestrationState } from "./state.ts";

type PullRequest = { number: number; url: string; state?: string; isDraft?: boolean };
type PublisherCommands = {
  checked: typeof checkedCommand;
  run: typeof runCommand;
};

export class PullRequestPublisher {
  private active = new Set<string>();

  constructor(
    private readonly state: OrchestrationState,
    private readonly commands: PublisherCommands = { checked: checkedCommand, run: runCommand },
  ) {}

  async publish(project: Project, job: Job): Promise<Job> {
    const key = `${project.id}:${job.id}`;
    if (this.active.has(key)) return this.state.job(project.id, job.id) ?? job;
    this.active.add(key);
    try {
      if (!project.remote) throw new Error("project has no supported origin remote");
      if (!job.baseSha) throw new Error("job has no recorded base commit");
      if (job.branchName !== `omp/task/${job.id}` || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(job.id)) {
        throw new Error("job branch does not match the native OMP task namespace");
      }
      if (!["completed", "publish_failed"].includes(job.status)) throw new Error(`job is not publishable from state ${job.status}`);
      this.state.setJobPublishState(project.id, job.id, { status: "publishing", error: null });
      const currentRemote = await this.commands.checked(["git", "remote", "get-url", "origin"], { cwd: project.cwd });
      if (currentRemote !== project.remote) throw new Error("origin remote changed after project registration");
      await this.commands.checked(["git", "show-ref", "--verify", `refs/heads/${job.branchName}`], { cwd: project.cwd });
      await this.commands.checked(["git", "merge-base", "--is-ancestor", job.baseSha, job.branchName], { cwd: project.cwd });
      await this.commands.checked(["git", "merge-base", "--is-ancestor", job.baseSha, project.baseBranch], { cwd: project.cwd });
      const commits = await this.commands.checked(["git", "rev-list", "--count", `${job.baseSha}..${job.branchName}`], { cwd: project.cwd });
      if (Number(commits) < 1) throw new Error("job branch contains no commits beyond its recorded base");
      const existing = await findPullRequest(project, job.branchName, this.commands);
      if (existing) return this.remember(project.id, job.id, existing);
      await this.commands.checked(["git", "push", "--set-upstream", "origin", `${job.branchName}:refs/heads/${job.branchName}`], {
        cwd: project.cwd,
        timeoutMs: 120_000,
      });
      const afterPush = await findPullRequest(project, job.branchName, this.commands);
      if (afterPush) return this.remember(project.id, job.id, afterPush);
      const title = (job.description || job.assignment || `OMP task ${job.id}`).replaceAll(/\s+/g, " ").slice(0, 120);
      const body = [
        "Created by the Skizzles OMP orchestration daemon from an APFS-isolated OMP subagent.",
        "",
        `Subagent: ${job.agent}`,
        `Job: ${job.id}`,
        job.assignment ? `\nAssignment:\n\n${job.assignment.slice(0, 8_000)}` : "",
      ].filter(Boolean).join("\n");
      await this.commands.checked(["gh", "pr", "create", "--draft", "--base", project.baseBranch, "--head", job.branchName, "--title", title, "--body", body], {
        cwd: project.cwd,
        timeoutMs: 120_000,
      });
      const created = await findPullRequest(project, job.branchName, this.commands);
      if (!created) throw new Error("GitHub accepted PR creation but the PR could not be rediscovered");
      return this.remember(project.id, job.id, created);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.state.setJobPublishState(project.id, job.id, { status: "publish_failed", error: message });
      throw error;
    } finally {
      this.active.delete(key);
    }
  }

  private remember(projectId: string, jobId: string, pullRequest: PullRequest): Job {
    this.state.setJobPublishState(projectId, jobId, {
      status: "published",
      error: null,
      prUrl: pullRequest.url,
      prNumber: pullRequest.number,
    });
    return this.state.job(projectId, jobId)!;
  }
}

async function findPullRequest(project: Project, branch: string, commands: PublisherCommands): Promise<PullRequest | undefined> {
  const result = await commands.run(["gh", "pr", "list", "--head", branch, "--state", "all", "--json", "number,url,state,isDraft", "--limit", "2"], {
    cwd: project.cwd,
    timeoutMs: 30_000,
  });
  if (result.exitCode !== 0) throw new Error(result.stderr || "unable to query GitHub pull requests");
  const parsed: unknown = JSON.parse(result.stdout || "[]");
  if (!Array.isArray(parsed)) throw new Error("gh pr list returned malformed JSON");
  const candidate = parsed[0];
  if (!candidate || typeof candidate !== "object" || typeof candidate.number !== "number" || typeof candidate.url !== "string") return undefined;
  return candidate as PullRequest;
}
