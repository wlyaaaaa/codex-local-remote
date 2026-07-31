import { EventEmitter } from "node:events";

import { afterEach, describe, expect, it, vi } from "vitest";

import { WebSocketLivenessMonitor, type LivenessWebSocket } from "./websocket-liveness.js";

class FakeLivenessWebSocket extends EventEmitter implements LivenessWebSocket {
  readonly ping = vi.fn();
  readyState = 1;

  pong(): void {
    this.emit("pong");
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe("WebSocketLivenessMonitor", () => {
  it("gives an aligned resume a fresh heartbeat window instead of closing", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));
    const downstream = new FakeLivenessWebSocket();
    const upstream = new FakeLivenessWebSocket();
    const stale = vi.fn();
    const monitor = new WebSocketLivenessMonitor({
      deadlineMs: 1_000,
      intervalMs: 1_000,
      resumeToleranceMs: 100,
    });

    monitor.watchPair(downstream, upstream, stale);
    await vi.advanceTimersByTimeAsync(999);
    expect(downstream.ping).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(downstream.ping).toHaveBeenCalledTimes(1);
    expect(upstream.ping).toHaveBeenCalledTimes(1);
    expect(stale).not.toHaveBeenCalled();

    // A resume exactly on the next sweep is indistinguishable from one missed
    // deadline, so issue a fresh challenge before considering the pair stale.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(stale).not.toHaveBeenCalled();
    expect(downstream.ping).toHaveBeenCalledTimes(2);
    expect(upstream.ping).toHaveBeenCalledTimes(2);
    downstream.pong();
    upstream.pong();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(stale).not.toHaveBeenCalled();
    expect(downstream.ping).toHaveBeenCalledTimes(3);
    expect(upstream.ping).toHaveBeenCalledTimes(3);
    downstream.pong();
    upstream.pong();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(stale).not.toHaveBeenCalled();

    monitor.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("fails a pair closed after two bounded misses on either WebSocket leg", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));
    const downstream = new FakeLivenessWebSocket();
    const upstream = new FakeLivenessWebSocket();
    const stale = vi.fn();
    const monitor = new WebSocketLivenessMonitor({
      deadlineMs: 1_000,
      intervalMs: 1_000,
      resumeToleranceMs: 100,
    });

    monitor.watchPair(downstream, upstream, stale);
    await vi.advanceTimersByTimeAsync(1_000);
    downstream.pong();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(stale).not.toHaveBeenCalled();
    downstream.pong();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(stale).toHaveBeenCalledTimes(1);
    expect(downstream.listenerCount("pong")).toBe(0);
    expect(upstream.listenerCount("pong")).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps responsive pairs alive and releases the sole timer and listeners on stop", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));
    const downstream = new FakeLivenessWebSocket();
    const upstream = new FakeLivenessWebSocket();
    const stale = vi.fn();
    const monitor = new WebSocketLivenessMonitor({
      deadlineMs: 1_000,
      intervalMs: 1_000,
      resumeToleranceMs: 100,
    });

    monitor.watchPair(downstream, upstream, stale);
    await vi.advanceTimersByTimeAsync(1_000);
    downstream.pong();
    upstream.pong();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(stale).not.toHaveBeenCalled();
    expect(downstream.ping).toHaveBeenCalledTimes(2);
    expect(upstream.ping).toHaveBeenCalledTimes(2);

    monitor.stop();
    expect(downstream.listenerCount("pong")).toBe(0);
    expect(upstream.listenerCount("pong")).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(downstream.ping).toHaveBeenCalledTimes(2);
  });

  it("treats a delayed sweep as resume and requires a fresh missed heartbeat before closing", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));
    const downstream = new FakeLivenessWebSocket();
    const upstream = new FakeLivenessWebSocket();
    const stale = vi.fn();
    const monitor = new WebSocketLivenessMonitor({
      deadlineMs: 1_000,
      intervalMs: 1_000,
      resumeToleranceMs: 100,
    });

    monitor.watchPair(downstream, upstream, stale);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(downstream.ping).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date(10_000));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(stale).not.toHaveBeenCalled();
    expect(downstream.ping).toHaveBeenCalledTimes(2);
    expect(upstream.ping).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(stale).not.toHaveBeenCalled();
    expect(downstream.ping).toHaveBeenCalledTimes(3);
    expect(upstream.ping).toHaveBeenCalledTimes(3);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(stale).toHaveBeenCalledTimes(1);
  });

  it("isolates a stale callback failure and keeps checking other pairs", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));
    const firstDownstream = new FakeLivenessWebSocket();
    const firstUpstream = new FakeLivenessWebSocket();
    const secondDownstream = new FakeLivenessWebSocket();
    const secondUpstream = new FakeLivenessWebSocket();
    const monitor = new WebSocketLivenessMonitor({
      deadlineMs: 1_000,
      intervalMs: 1_000,
      resumeToleranceMs: 100,
    });

    monitor.watchPair(firstDownstream, firstUpstream, () => {
      throw new Error("fixture stale callback failure");
    });
    monitor.watchPair(secondDownstream, secondUpstream, vi.fn());
    await vi.advanceTimersByTimeAsync(1_000);
    secondDownstream.pong();
    secondUpstream.pong();

    await vi.advanceTimersByTimeAsync(1_000);
    secondDownstream.pong();
    secondUpstream.pong();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(secondDownstream.ping).toHaveBeenCalledTimes(3);
    expect(secondUpstream.ping).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(1);

    monitor.stop();
    expect(vi.getTimerCount()).toBe(0);
  });
});
