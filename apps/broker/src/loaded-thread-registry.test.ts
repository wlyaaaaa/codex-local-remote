import { describe, expect, it } from "vitest";

import { LoadedThreadRegistry } from "./loaded-thread-registry.js";

describe("LoadedThreadRegistry", () => {
  it("forms a stable union across Desktop and Sidecar snapshots", () => {
    const registry = new LoadedThreadRegistry();
    registry.replaceConnection(1, ["desktop-a", "shared"]);
    registry.replaceConnection(2, ["sidecar-b", "shared"]);

    expect(registry.union()).toEqual(["desktop-a", "shared", "sidecar-b"]);
  });

  it("keeps a newly discovered thread only until every current snapshot has checked it", () => {
    const registry = new LoadedThreadRegistry();
    registry.replaceConnection(1, ["desktop-a"]);
    registry.replaceConnection(2, ["sidecar-a"]);
    registry.remember("phone-created", [1, 2]);

    registry.replaceConnection(1, ["desktop-a"]);
    expect(registry.union()).toEqual(["desktop-a", "phone-created", "sidecar-a"]);

    registry.replaceConnection(2, ["sidecar-a"]);
    expect(registry.union()).toEqual(["desktop-a", "sidecar-a"]);
  });

  it("does not let a refresh started before discovery clear the new thread", () => {
    const registry = new LoadedThreadRegistry();
    registry.replaceConnection(1, []);
    const staleRefresh = registry.beginConnectionRefresh(1);
    registry.remember("created-during-refresh", [1]);

    registry.replaceConnection(1, [], staleRefresh);
    expect(registry.union()).toEqual(["created-during-refresh"]);

    const confirmingRefresh = registry.beginConnectionRefresh(1);
    registry.replaceConnection(1, [], confirmingRefresh);
    expect(registry.union()).toEqual([]);
  });

  it("hands a pending discovery to an authoritative snapshot without retaining history", () => {
    const registry = new LoadedThreadRegistry();
    registry.replaceConnection(1, []);
    registry.remember("phone-created", [1]);

    registry.replaceConnection(1, ["phone-created"]);
    expect(registry.union()).toEqual(["phone-created"]);

    registry.replaceConnection(1, []);
    expect(registry.union()).toEqual([]);
  });

  it("retains in-flight work across an empty refresh and removes it at terminal state", () => {
    const registry = new LoadedThreadRegistry();
    registry.replaceConnection(1, []);
    registry.markInFlight("running");

    registry.replaceConnection(1, []);
    expect(registry.union()).toEqual(["running"]);

    registry.markTerminal("running");
    expect(registry.union()).toEqual([]);
  });

  it("does not remove a terminal or disconnected thread still held by another connection", () => {
    const registry = new LoadedThreadRegistry();
    registry.replaceConnection(1, ["shared"]);
    registry.replaceConnection(2, ["shared", "sidecar-only"]);
    registry.markInFlight("shared");

    registry.markTerminal("shared");
    registry.removeConnection(1);
    expect(registry.union()).toEqual(["shared", "sidecar-only"]);

    registry.replaceConnection(2, []);
    expect(registry.union()).toEqual([]);
  });

  it("bounds transient discoveries and in-flight fallbacks", () => {
    const registry = new LoadedThreadRegistry({ maxTransientThreads: 2 });
    registry.remember("oldest", [1]);
    registry.markInFlight("middle");
    registry.remember("newest", [1]);

    expect(registry.union()).toEqual(["middle", "newest"]);
  });

  it("rejects malformed or unbounded thread identifiers", () => {
    const registry = new LoadedThreadRegistry();
    registry.replaceConnection(1, ["", " ok ", "x".repeat(513), "valid"]);
    registry.remember(" pending ", [1]);
    registry.markInFlight("");

    expect(registry.union()).toEqual(["valid"]);
  });
});
