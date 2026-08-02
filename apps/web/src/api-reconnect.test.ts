import type { RemoteEvent } from "@codex-local-remote/contracts";
import { describe, expect, it } from "vitest";
import {
  EVENT_SOURCE_CLOSED,
  EVENT_SOURCE_CONNECTING,
  EVENT_STREAM_OFFLINE_CONFIRM_MS,
  EVENT_STREAM_OFFLINE_GRACE_MS,
  EVENT_STREAM_ONLINE_STABILITY_MS,
  EVENT_STREAM_RETRY_DELAYS_MS,
  createFetchEventStreamSource,
  subscribeRemoteEvents,
  type EventStreamSource,
} from "./api";

class FakeEventStreamSource implements EventStreamSource {
  readyState = 0;
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  closeCalls = 0;

  close() {
    this.closeCalls += 1;
  }
}

function reconnectHarness() {
  const sources: FakeEventStreamSource[] = [];
  const urls: string[] = [];
  const timers = new Map<number, { callback: () => void; delay: number; dueAt: number }>();
  const delays: number[] = [];
  let nextTimerId = 1;
  let now = 0;

  return {
    sources,
    urls,
    delays,
    dependencies: {
      createSource: (url: string) => {
        const source = new FakeEventStreamSource();
        sources.push(source);
        urls.push(url);
        return source;
      },
      schedule: (callback: () => void, delay: number) => {
        const id = nextTimerId++;
        timers.set(id, { callback, delay, dueAt: now + delay });
        delays.push(delay);
        return id;
      },
      cancel: (id: number) => {
        timers.delete(id);
      },
    },
    runTimer(delay: number) {
      const next = [...timers.entries()].find(([, timer]) => timer.delay === delay);
      expect(next).toBeDefined();
      const [id, timer] = next!;
      timers.delete(id);
      now = Math.max(now, timer.dueAt);
      timer.callback();
    },
    advance(elapsedMs: number) {
      const target = now + elapsedMs;
      while (true) {
        const next = [...timers.entries()]
          .filter(([, timer]) => timer.dueAt <= target)
          .sort(([leftId, left], [rightId, right]) => left.dueAt - right.dueAt || leftId - rightId)
          .at(0);
        if (!next) break;
        const [id, timer] = next;
        timers.delete(id);
        now = timer.dueAt;
        timer.callback();
      }
      now = target;
    },
    timerCount() {
      return timers.size;
    },
  };
}

describe("SSE 断线重连", () => {
  it("短暂 CLOSED 会重建连接，但不会立刻把编辑和发送状态切成离线", () => {
    const harness = reconnectHarness();
    const connections: boolean[] = [];
    const unsubscribe = subscribeRemoteEvents(
      "/api/v1/events",
      () => undefined,
      (online) => connections.push(online),
      harness.dependencies,
    );

    expect(harness.sources).toHaveLength(1);
    const first = harness.sources[0]!;
    first.onopen?.({} as Event);
    first.readyState = EVENT_SOURCE_CLOSED;
    first.onerror?.({} as Event);
    first.onerror?.({} as Event);

    expect(connections).toEqual([true]);
    expect(first.closeCalls).toBe(1);
    expect(harness.timerCount()).toBe(2);
    expect(harness.delays).toEqual([
      EVENT_STREAM_OFFLINE_GRACE_MS,
      EVENT_STREAM_RETRY_DELAYS_MS[0],
    ]);

    harness.runTimer(EVENT_STREAM_RETRY_DELAYS_MS[0]);
    expect(harness.sources).toHaveLength(2);
    harness.sources[1]!.onopen?.({} as Event);
    expect(connections).toEqual([true]);
    expect(harness.timerCount()).toBe(0);

    unsubscribe();
    expect(harness.sources[1]!.closeCalls).toBe(1);
  });

  it("超过宽限时间的真实断线仍会报告离线并禁用远程 mutation", () => {
    const harness = reconnectHarness();
    const connections: boolean[] = [];
    const unsubscribe = subscribeRemoteEvents(
      "/api/v1/events",
      () => undefined,
      (online) => connections.push(online),
      harness.dependencies,
    );

    const source = harness.sources[0]!;
    source.onopen?.({} as Event);
    source.readyState = EVENT_SOURCE_CLOSED;
    source.onerror?.({} as Event);
    harness.runTimer(EVENT_STREAM_OFFLINE_GRACE_MS);
    expect(connections).toEqual([true]);
    harness.runTimer(EVENT_STREAM_OFFLINE_CONFIRM_MS);

    expect(connections).toEqual([true, false]);
    unsubscribe();
  });

  it("原生 EventSource 自动重连期间恢复时不弹出离线状态", () => {
    const harness = reconnectHarness();
    const connections: boolean[] = [];
    const unsubscribe = subscribeRemoteEvents(
      "/api/v1/events",
      () => undefined,
      (online) => connections.push(online),
      harness.dependencies,
    );

    const source = harness.sources[0]!;
    source.onopen?.({} as Event);
    source.readyState = EVENT_SOURCE_CONNECTING;
    source.onerror?.({} as Event);
    expect(harness.sources).toHaveLength(1);
    expect(harness.timerCount()).toBe(1);

    source.onopen?.({} as Event);
    expect(connections).toEqual([true]);
    expect(harness.timerCount()).toBe(0);
    unsubscribe();
  });

  it("宽限边界上的反复重连成功不会产生 false 到 true 的闪烁", () => {
    const harness = reconnectHarness();
    const connections: boolean[] = [];
    const unsubscribe = subscribeRemoteEvents(
      "/api/v1/events",
      () => undefined,
      (online) => connections.push(online),
      harness.dependencies,
    );

    const first = harness.sources[0]!;
    first.onopen?.({} as Event);
    first.readyState = EVENT_SOURCE_CLOSED;
    first.onerror?.({} as Event);

    harness.advance(EVENT_STREAM_RETRY_DELAYS_MS[0]);
    const second = harness.sources[1]!;
    second.readyState = EVENT_SOURCE_CLOSED;
    second.onerror?.({} as Event);

    harness.advance(EVENT_STREAM_OFFLINE_GRACE_MS - EVENT_STREAM_RETRY_DELAYS_MS[0]);
    expect(harness.sources).toHaveLength(3);
    expect(connections).toEqual([true]);

    harness.advance(500);
    harness.sources[2]!.onopen?.({} as Event);
    harness.advance(EVENT_STREAM_OFFLINE_CONFIRM_MS);
    expect(connections).toEqual([true]);

    unsubscribe();
  });

  it("真实持续断线经过宽限和恢复确认窗口后仍会报告离线", () => {
    const harness = reconnectHarness();
    const connections: boolean[] = [];
    const unsubscribe = subscribeRemoteEvents(
      "/api/v1/events",
      () => undefined,
      (online) => connections.push(online),
      harness.dependencies,
    );

    const source = harness.sources[0]!;
    source.onopen?.({} as Event);
    source.readyState = EVENT_SOURCE_CLOSED;
    source.onerror?.({} as Event);

    harness.advance(EVENT_STREAM_OFFLINE_GRACE_MS);
    expect(connections).toEqual([true]);
    harness.advance(EVENT_STREAM_OFFLINE_CONFIRM_MS);
    expect(connections).toEqual([true, false]);

    unsubscribe();
  });

  it("已报告离线后仅在恢复保持稳定时重新报告在线", () => {
    const harness = reconnectHarness();
    const connections: boolean[] = [];
    const unsubscribe = subscribeRemoteEvents(
      "/api/v1/events",
      () => undefined,
      (online) => connections.push(online),
      harness.dependencies,
    );

    const first = harness.sources[0]!;
    first.onopen?.({} as Event);
    first.readyState = EVENT_SOURCE_CLOSED;
    first.onerror?.({} as Event);
    harness.advance(EVENT_STREAM_OFFLINE_GRACE_MS + EVENT_STREAM_OFFLINE_CONFIRM_MS);
    expect(connections).toEqual([true, false]);

    const unstable = harness.sources[1]!;
    unstable.onopen?.({} as Event);
    harness.advance(500);
    unstable.readyState = EVENT_SOURCE_CLOSED;
    unstable.onerror?.({} as Event);
    expect(connections).toEqual([true, false]);

    harness.advance(EVENT_STREAM_RETRY_DELAYS_MS[1]);
    const stable = harness.sources.at(-1)!;
    stable.onopen?.({} as Event);
    harness.advance(EVENT_STREAM_ONLINE_STABILITY_MS);
    expect(connections).toEqual([true, false, true]);

    unsubscribe();
  });

  it("退避有上限，连接成功后从最短退避重新开始", () => {
    const harness = reconnectHarness();
    const unsubscribe = subscribeRemoteEvents(
      "/api/v1/events",
      () => undefined,
      () => undefined,
      harness.dependencies,
    );

    for (let attempt = 0; attempt < EVENT_STREAM_RETRY_DELAYS_MS.length + 2; attempt += 1) {
      const source = harness.sources.at(-1)!;
      source.readyState = EVENT_SOURCE_CLOSED;
      source.onerror?.({} as Event);
      harness.runTimer(
        EVENT_STREAM_RETRY_DELAYS_MS[Math.min(attempt, EVENT_STREAM_RETRY_DELAYS_MS.length - 1)]!,
      );
    }

    expect(harness.delays.filter((delay) => delay !== EVENT_STREAM_OFFLINE_GRACE_MS)).toEqual([
      ...EVENT_STREAM_RETRY_DELAYS_MS,
      EVENT_STREAM_RETRY_DELAYS_MS.at(-1),
      EVENT_STREAM_RETRY_DELAYS_MS.at(-1),
    ]);

    const recovered = harness.sources.at(-1)!;
    recovered.onopen?.({} as Event);
    recovered.readyState = EVENT_SOURCE_CLOSED;
    recovered.onerror?.({} as Event);
    expect(harness.delays.at(-1)).toBe(EVENT_STREAM_RETRY_DELAYS_MS[0]);

    unsubscribe();
  });

  it("只投递合法事件，取消订阅后不再重建", () => {
    const harness = reconnectHarness();
    const events: RemoteEvent[] = [];
    const unsubscribe = subscribeRemoteEvents(
      "/api/v1/events",
      (event) => events.push(event),
      () => undefined,
      harness.dependencies,
    );
    const source = harness.sources[0]!;

    source.onmessage?.({ data: "{broken" } as MessageEvent<string>);
    source.onmessage?.({
      data: JSON.stringify({ type: "connection.ready" }),
    } as MessageEvent<string>);
    expect(events).toEqual([{ type: "connection.ready" }]);

    source.readyState = EVENT_SOURCE_CLOSED;
    source.onerror?.({} as Event);
    unsubscribe();
    expect(harness.timerCount()).toBe(0);
    expect(harness.sources).toHaveLength(1);
  });

  it("显式重建时携带最后一个服务端事件游标", () => {
    const harness = reconnectHarness();
    const unsubscribe = subscribeRemoteEvents(
      "/api/v1/events",
      () => undefined,
      () => undefined,
      harness.dependencies,
    );
    const source = harness.sources[0]!;
    source.onmessage?.({
      data: JSON.stringify({ type: "connection.ready" }),
      lastEventId: "stream-a:42",
    } as MessageEvent<string>);
    source.readyState = EVENT_SOURCE_CLOSED;
    source.onerror?.({} as Event);
    harness.runTimer(EVENT_STREAM_RETRY_DELAYS_MS[0]);

    expect(harness.urls).toEqual(["/api/v1/events", "/api/v1/events?cursor=stream-a%3A42"]);
    unsubscribe();
  });

  it("首连使用详情快照游标，重连时用最新事件游标精确替换", () => {
    const harness = reconnectHarness();
    const unsubscribe = subscribeRemoteEvents(
      "/api/v1/events?threadId=thread-1&cursor=snapshot%3A7",
      () => undefined,
      () => undefined,
      harness.dependencies,
    );
    const source = harness.sources[0]!;
    source.onmessage?.({
      data: JSON.stringify({ type: "connection.ready" }),
      lastEventId: "stream-current:9",
    } as MessageEvent<string>);
    source.readyState = EVENT_SOURCE_CLOSED;
    source.onerror?.({} as Event);
    harness.runTimer(EVENT_STREAM_RETRY_DELAYS_MS[0]);

    expect(harness.urls).toEqual([
      "/api/v1/events?threadId=thread-1&cursor=snapshot%3A7",
      "/api/v1/events?threadId=thread-1&cursor=stream-current%3A9",
    ]);
    unsubscribe();
  });

  it("没有原生 EventSource 时用 fetch 流完成同一 SSE 握手和消息投递", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode('id: stream-fetch:7\r\ndata: {"type":"connection.ready","seq":7}\r\n\r\n'),
        );
      },
    });
    const fetcher = async () =>
      new Response(stream, {
        headers: { "content-type": "text/event-stream; charset=utf-8" },
        status: 200,
      });
    const source = createFetchEventStreamSource("/api/v1/events", fetcher);
    const opened = Promise.withResolvers<void>();
    const delivered = Promise.withResolvers<MessageEvent<string>>();
    source.onopen = () => opened.resolve();
    source.onmessage = (message) => delivered.resolve(message);

    await opened.promise;
    const message = await delivered.promise;

    expect(message.lastEventId).toBe("stream-fetch:7");
    expect(JSON.parse(message.data)).toMatchObject({ type: "connection.ready", seq: 7 });
    source.close();
    expect(source.readyState).toBe(EVENT_SOURCE_CLOSED);
  });
});
