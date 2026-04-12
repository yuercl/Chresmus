#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";

const npmBinary = process.platform === "win32" ? "npm.cmd" : "npm";

function runBuild(filter) {
  const result = spawnSync(
    npmBinary,
    ["run", "build", "--workspace", filter],
    {
      stdio: "inherit",
      env: process.env
    }
  );

  if (typeof result.status === "number") {
    return result.status;
  }

  if (result.error) {
    process.stderr.write(`${String(result.error)}\n`);
  }
  return 1;
}

const buildFilters = [
  "@farfield/protocol",
  "@farfield/unified-surface",
  "@farfield/api",
  "@farfield/opencode-api",
  "@farfield/web",
  "@farfield/server"
];

for (const filter of buildFilters) {
  const status = runBuild(filter);
  if (status !== 0) {
    process.exit(status);
  }
}

const serverProcess = spawn(
  npmBinary,
  ["run", "start", "--workspace", "@farfield/server"],
  {
    stdio: "inherit",
    env: process.env
  }
);

const webProcess = spawn(
  npmBinary,
  ["run", "start", "--workspace", "@farfield/web"],
  {
    stdio: "inherit",
    env: process.env
  }
);

const childProcesses = [serverProcess, webProcess];
let terminating = false;
let firstExit = {
  code: null,
  signal: null
};

const stopChildren = (signal) => {
  if (terminating) {
    return;
  }
  terminating = true;
  for (const child of childProcesses) {
    if (!child.killed) {
      child.kill(signal);
    }
  }
};

process.on("SIGINT", () => stopChildren("SIGINT"));
process.on("SIGTERM", () => stopChildren("SIGTERM"));

let remainingChildren = childProcesses.length;
for (const child of childProcesses) {
  child.on("exit", (code, signal) => {
    if (firstExit.code === null && firstExit.signal === null) {
      firstExit = { code, signal };
    }

    remainingChildren -= 1;
    if (!terminating && remainingChildren > 0) {
      stopChildren("SIGTERM");
    }

    if (remainingChildren === 0) {
      if (firstExit.signal) {
        process.kill(process.pid, firstExit.signal);
        return;
      }
      process.exit(firstExit.code ?? 0);
    }
  });
}
