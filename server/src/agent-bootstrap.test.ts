import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

/*
 * The agents file is deployment configuration that a container replacement
 * must not be needed for, and these stages run in the order an operator would
 * produce them: a file at boot, one that names a different agent, one that has
 * stopped parsing, and finally the address the deployment itself names.
 *
 * `config` is imported after the environment is staged, because the bootstrap
 * is resolved when the module loads — the point of these tests is what happens
 * to it afterwards, while the process keeps running.
 */
const dir = mkdtempSync(join(tmpdir(), "gilbert-agents-file-"));
const file = join(dir, "agents.json");
const original = {
  file: process.env.GILBERT_AGENTS_FILE,
  address: process.env.GILBERT_AGENT_ADDRESS,
  password: process.env.GILBERT_AGENT_PASSWORD,
};

process.env.GILBERT_AGENTS_FILE = file;
delete process.env.GILBERT_AGENT_ADDRESS;
delete process.env.GILBERT_AGENT_PASSWORD;
writeFileSync(file, JSON.stringify({ "first@example.com": { password: "p1" } }));

const { config } = await import("./config.js");

/** Longer than the re-check window, so a changed file has certainly been seen. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 1_200));

test.after(() => {
  rmSync(dir, { recursive: true, force: true });
  for (const [key, value] of Object.entries({
    GILBERT_AGENTS_FILE: original.file,
    GILBERT_AGENT_ADDRESS: original.address,
    GILBERT_AGENT_PASSWORD: original.password,
  })) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test("the installation's agent follows the agents file, without a restart", () => {
  assert.equal(config.agent.address, "first@example.com");

  writeFileSync(
    file,
    JSON.stringify({ "second@example.com": { password: "p2", areas: ["mail"] } }),
  );

  return settle().then(() => {
    assert.equal(config.agent.address, "second@example.com");
    assert.equal(config.agent.password, "p2");
    assert.deepEqual(config.agent.areas, ["mail"]);
  });
});

test("an agents file that stops parsing keeps the agent in force", () => {
  writeFileSync(file, "{ not json");

  return settle().then(() => {
    assert.equal(config.agent.address, "second@example.com");
    assert.equal(config.agent.password, "p2");
  });
});

test("the address the deployment names wins over the file's", () => {
  process.env.GILBERT_AGENT_ADDRESS = "first@example.com";
  writeFileSync(file, JSON.stringify({ "first@example.com": { password: "p3" } }));

  return settle().then(() => {
    assert.equal(config.agent.address, "first@example.com");
    assert.equal(config.agent.password, "p3");
  });
});
