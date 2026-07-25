import path from "node:path";

import { describe, expect, it } from "vitest";

import { parseCliInvocation, resolveSidecarConfig } from "./config.js";

describe("resolveSidecarConfig", () => {
  it("uses the installation defaults agreed for the Windows sidecar", () => {
    expect(
      resolveSidecarConfig({
        environment: {
          LOCALAPPDATA: "C:\\Users\\fixture\\AppData\\Local",
        },
      }),
    ).toMatchObject({
      basePath: "/codex-remote",
      dataDir: path.win32.join("C:\\Users\\fixture\\AppData\\Local", "CodexLocalRemote"),
      host: "127.0.0.1",
      port: 18_790,
    });
  });

  it("lets CLI listener flags override non-secret environment configuration", () => {
    expect(
      resolveSidecarConfig({
        cli: {
          basePath: "/phone/",
          dataDir: "D:\\Remote State",
          host: "::1",
          port: 19_001,
        },
        environment: {
          CODEX_REMOTE_BASE_PATH: "/from-env",
          CODEX_REMOTE_PORT: "19999",
          LOCALAPPDATA: "C:\\Users\\fixture\\AppData\\Local",
        },
      }),
    ).toMatchObject({
      basePath: "/phone",
      dataDir: "D:\\Remote State",
      host: "::1",
      port: 19_001,
    });
  });

  it("rejects an unsafe path prefix and a non-loopback listener by default", () => {
    expect(() =>
      resolveSidecarConfig({
        environment: {
          CODEX_REMOTE_BASE_PATH: "/../escape",
          LOCALAPPDATA: "C:\\Users\\fixture\\AppData\\Local",
        },
      }),
    ).toThrow("路径前缀");

    expect(() =>
      resolveSidecarConfig({
        cli: { host: "0.0.0.0" },
        environment: { LOCALAPPDATA: "C:\\Users\\fixture\\AppData\\Local" },
      }),
    ).toThrow("回环地址");
  });
});

describe("parseCliInvocation", () => {
  it("provides a secret-free help entrypoint", () => {
    expect(parseCliInvocation(["--help"])).toEqual({ command: "help" });
  });

  it("supports serve listener flags without accepting password material", () => {
    expect(
      parseCliInvocation([
        "serve",
        "--host",
        "127.0.0.1",
        "--port",
        "18790",
        "--base-path",
        "/codex-remote",
        "--data-dir",
        "D:\\Remote State",
      ]),
    ).toEqual({
      command: "serve",
      config: {
        basePath: "/codex-remote",
        dataDir: "D:\\Remote State",
        host: "127.0.0.1",
        port: 18_790,
      },
    });

    expect(() => parseCliInvocation(["setup-password", "--password", "secret"])).toThrow(
      "不支持的参数",
    );
  });
});
