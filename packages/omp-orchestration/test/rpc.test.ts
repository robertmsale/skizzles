import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_RPC_FRAME_BYTES, RPC_CHUNK_PAYLOAD_BYTES } from "../src/protocol.ts";
import { OmpRpcClient, RpcFrameDecoder } from "../src/rpc.ts";

const temporaryRoots: string[] = [];
afterEach(async () => { await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

describe("RpcFrameDecoder", () => {
  test("reassembles OMP protocol v2 frames", () => {
    const frame = { type: "message_end", message: { text: "x".repeat(MAX_RPC_FRAME_BYTES + 200) } };
    const json = JSON.stringify(frame);
    const bytes = Buffer.from(json);
    const count = Math.ceil(bytes.byteLength / RPC_CHUNK_PAYLOAD_BYTES);
    const decoder = new RpcFrameDecoder();
    let result: Record<string, unknown> | undefined;
    for (let index = 0; index < count; index++) {
      result = decoder.push({
        type: "rpc_chunk", chunkId: "chunk-1", index, count, byteLength: bytes.byteLength,
        data: bytes.subarray(index * RPC_CHUNK_PAYLOAD_BYTES, (index + 1) * RPC_CHUNK_PAYLOAD_BYTES).toString("base64"),
      });
    }
    expect(result).toEqual(frame);
  });

  test("rejects out-of-order chunks", () => {
    const decoder = new RpcFrameDecoder();
    expect(() => decoder.push({ type: "rpc_chunk", chunkId: "bad", index: 1, count: 2, byteLength: MAX_RPC_FRAME_BYTES, data: "eA==" }))
      .toThrow("start at index zero");
  });
});

describe("OmpRpcClient", () => {
  test("negotiates v2, correlates requests, and forwards subagent frames", async () => {
    const root = await mkdtemp(join(tmpdir(), "skizzles-omp-rpc-"));
    temporaryRoots.push(root);
    const fake = join(root, "omp");
    await Bun.write(fake, `#!${process.execPath}\nimport { createInterface } from "node:readline";\nconsole.log(JSON.stringify({type:"ready",protocolVersion:1,supportedProtocolVersions:[1,2],maxFrameBytes:1048576,maxReassembledFrameBytes:67108864}));\nconst rl=createInterface({input:process.stdin});\nrl.on("line",line=>{const x=JSON.parse(line);if(x.type==="prompt"){console.log(JSON.stringify({type:"subagent_lifecycle",payload:{id:"a1",agent:"worker",agentSource:"bundled",status:"started",index:0}}));console.log(JSON.stringify({type:"subagent_lifecycle",payload:{id:"a1",agent:"worker",agentSource:"bundled",status:"completed",index:0}}));}const data=x.type==="get_state"?{sessionId:"s1",sessionFile:"/tmp/s1.jsonl",isStreaming:false}:x.type==="get_subagents"?{subagents:[]}:undefined;console.log(JSON.stringify({id:x.id,type:"response",command:x.type,success:true,...(data?{data}:{} )}));});\n`);
    await chmod(fake, 0o755);
    const frames: Record<string, unknown>[] = [];
    const client = new OmpRpcClient({ command: [fake], cwd: root, onFrame: (frame) => { frames.push(frame); } });
    expect(await client.start()).toMatchObject({ data: { sessionId: "s1" } });
    await client.prompt("delegate");
    await Bun.sleep(20);
    expect(frames.filter((frame) => frame.type === "subagent_lifecycle")).toHaveLength(2);
    await client.stop();
  });
});
