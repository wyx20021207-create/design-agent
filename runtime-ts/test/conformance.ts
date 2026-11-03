/**
 * 官方一致性测试：用 Pi Durable 自带的 createEnvConformance 校验 DockerExecutionEnv。
 *
 *   npm run conformance
 *
 * 每个用例拿到一个全新、空的目录作为 cwd，跑在一个独立的 env server 进程里。
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { createEnvConformance } from "@earendil-works/pi-durable/testing";

import { ensureContainer } from "../src/env/container.ts";
import { DockerExecutionEnv } from "../src/env/docker-execution-env.ts";
import { RpcClient } from "../src/env/rpc.ts";

import { SPIKE as SPEC } from "./spike.ts";

const partialDeepEqual = (actual: unknown, expected: unknown): void => {
  if (
    expected !== null &&
    typeof expected === "object" &&
    !Array.isArray(expected)
  ) {
    for (const [key, value] of Object.entries(expected as Record<string, unknown>)) {
      partialDeepEqual((actual as Record<string, unknown> | null)?.[key], value);
    }
    return;
  }
  assert.deepStrictEqual(actual, expected);
};

const assertions = {
  ok: (value: unknown, message?: string): void => {
    assert.ok(value, message ?? "assertion failed");
  },
  strictEqual: (actual: unknown, expected: unknown): void => {
    assert.strictEqual(actual, expected);
  },
  deepEqual: (actual: unknown, expected: unknown): void => {
    assert.deepStrictEqual(actual, expected);
  },
  partialDeepEqual,
  greaterThan: (actual: number, expected: number): void => {
    assert.ok(actual > expected, `${actual} > ${expected}`);
  },
  rejects: async (operation: Promise<unknown>, messageIncludes: string): Promise<void> => {
    try {
      await operation;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      assert.ok(
        message.includes(messageIncludes),
        `期望包含 "${messageIncludes}"，实际 "${message}"`,
      );
      return;
    }
    assert.fail("期望操作失败，但它成功了");
  },
};

const withEnv = async (use: (env: DockerExecutionEnv) => Promise<void>): Promise<void> => {
  ensureContainer(SPEC);

  const bootstrap = RpcClient.docker(SPEC.name);
  const directory = `/tmp/conformance-${randomUUID()}`;

  const created = await bootstrap.call("createDir", [directory, { recursive: true }]).catch(() => {
    throw new Error(`无法创建测试目录 ${directory}`);
  });
  assert.ok(created === undefined || typeof created === "object");

  const rpc = RpcClient.docker(SPEC.name, { cwd: directory });
  const env = new DockerExecutionEnv(rpc, { id: `${SPEC.name}:${directory}`, cwd: directory });

  try {
    await use(env);
  } finally {
    rpc.close();
    await bootstrap.call("remove", [directory, { recursive: true, force: true }]).catch(() => undefined);
    bootstrap.close();
  }
};

const cases = createEnvConformance({
  assertions,
  withEnv,
  shell: ["sh", "-c"],
  symlinks: true,
  listFiles: false,
});

let passed = 0;
const failures: { name: string; error: string }[] = [];

for (const testCase of cases) {
  process.stdout.write(`· ${testCase.name}\n`);
  try {
    await testCase.run();
    passed += 1;
  } catch (error) {
    failures.push({
      name: testCase.name,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

console.log(`\n通过 ${passed}/${cases.length}`);

if (failures.length > 0) {
  console.log("\n失败用例：");
  for (const failure of failures) {
    console.log(`\n✗ ${failure.name}`);
    console.log(`  ${failure.error.split("\n").slice(0, 4).join("\n  ")}`);
  }
  process.exitCode = 1;
}
