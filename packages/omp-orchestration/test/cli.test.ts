import { expect, test } from "bun:test";
import { execute } from "../src/cli.ts";

test("ompctl emits machine-readable help without contacting a daemon", async () => {
  expect(await execute(["--help"])).toMatchObject({ help: expect.stringContaining("ompctl projects add") });
});
