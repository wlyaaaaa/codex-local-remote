import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

const statePath = process.env["MOCK_TAILSCALE_STATE"];
const logPath = process.env["MOCK_TAILSCALE_LOG"];
if (!statePath || !logPath) {
  process.stderr.write("Mock state and log paths are required.\n");
  process.exit(2);
}

const arguments_ = process.argv.slice(2);
appendFileSync(logPath, `${JSON.stringify(arguments_)}\n`, "utf8");
const state = JSON.parse(readFileSync(statePath, "utf8"));

if (arguments_[0] === "funnel" && arguments_[1] === "status" && arguments_[2] === "--json") {
  if (process.env["MOCK_TAILSCALE_MODE"] === "foreignize-remove-before-write") {
    state._mockStatusCalls = (state._mockStatusCalls ?? 0) + 1;
    if (state._mockStatusCalls === 2) {
      state.Web["mock.example.ts.net:443"].Handlers["/codex-remote"] = {
        Proxy: "http://127.0.0.1:19999",
      };
    }
    writeFileSync(statePath, JSON.stringify(state), "utf8");
  }
  if (process.env["MOCK_TAILSCALE_MODE"] === "drift-before-write") {
    state._mockStatusCalls = (state._mockStatusCalls ?? 0) + 1;
    if (state._mockStatusCalls === 2) {
      state.Web["mock.example.ts.net:443"].Handlers["/concurrent"] = {
        Proxy: "http://127.0.0.1:18888",
      };
    }
    writeFileSync(statePath, JSON.stringify(state), "utf8");
  }
  if (process.env["MOCK_TAILSCALE_MODE"] === "foreignize-before-rollback") {
    state._mockStatusCalls = (state._mockStatusCalls ?? 0) + 1;
    if (state._mockStatusCalls === 4) {
      state.Web["mock.example.ts.net:443"].Handlers["/codex-remote"] = {
        Proxy: "http://127.0.0.1:19999",
      };
    }
    writeFileSync(statePath, JSON.stringify(state), "utf8");
  }
  if (
    process.env["MOCK_TAILSCALE_MODE"] === "foreignize-remove-before-rollback" &&
    state._mockRemovalCalls === 1
  ) {
    state._mockPostRemovalStatusCalls = (state._mockPostRemovalStatusCalls ?? 0) + 1;
    if (state._mockPostRemovalStatusCalls === 2) {
      state.Web["mock.example.ts.net:443"].Handlers["/codex-remote"] = {
        Proxy: "http://127.0.0.1:19999",
      };
    }
    writeFileSync(statePath, JSON.stringify(state), "utf8");
  }
  process.stdout.write(JSON.stringify(state));
  process.exit(0);
}

if (arguments_[0] !== "funnel") {
  process.stderr.write("Unsupported mock command.\n");
  process.exit(2);
}

const pathFlag = arguments_.find((value) => value.startsWith("--set-path="));
const portFlag = arguments_.find((value) => value.startsWith("--https="));
const basePath = pathFlag?.slice("--set-path=".length);
const port = portFlag?.slice("--https=".length);
if (!basePath || !port) {
  process.stderr.write("Missing mock path or port.\n");
  process.exit(2);
}

state.Web ??= {};
let webKey = Object.keys(state.Web).find((key) => key.endsWith(`:${port}`));
webKey ??= `mock.example.ts.net:${port}`;
state.Web[webKey] ??= { Handlers: {} };
state.Web[webKey].Handlers ??= {};

const isRemoval = arguments_.includes("off");
if (isRemoval) {
  delete state.Web[webKey].Handlers[basePath];
  if (process.env["MOCK_TAILSCALE_MODE"] === "foreignize-remove-before-rollback") {
    state._mockRemovalCalls = (state._mockRemovalCalls ?? 0) + 1;
    state.Web[webKey].Handlers["/concurrent"] = {
      Proxy: "http://127.0.0.1:18888",
    };
  }
} else {
  const target = arguments_.at(-1);
  state._mockSetCalls = (state._mockSetCalls ?? 0) + 1;
  const wrongOnce =
    ["wrong-target-on-first-set", "foreignize-before-rollback"].includes(
      process.env["MOCK_TAILSCALE_MODE"] ?? "",
    ) && state._mockSetCalls === 1;
  state.Web[webKey].Handlers[basePath] = {
    Proxy: wrongOnce ? "http://127.0.0.1:9" : target,
  };
}

writeFileSync(statePath, JSON.stringify(state), "utf8");
if (
  process.env["MOCK_TAILSCALE_MODE"] === "fail-after-first-set" &&
  !isRemoval &&
  state._mockSetCalls === 1
) {
  process.exit(1);
}
process.exit(0);
