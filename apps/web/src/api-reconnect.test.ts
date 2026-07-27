import type { RemoteEvent } from "@codex-local-remote/contracts";
import { describe, expect, it } from "vitest";
import {
  EVENT_SOURCE_CLOSED,
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
  const timers = new Map<number, () => void>();
  const delays: number[] = [];
  let nextTimerId = 1;

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
        timers.set(id, callback);
        delays.push(delay);
        return id;
      },
      cancel: (id: number) => {
        timers.delete(id);
      },
    },
    runNextTimer() {
      const next = timers.entries().next().value as [number, () => void] | undefined;
      expect(next).toBeDefined();
      const [id, callback] = next!;
      timers.delete(id);
      callback();
    },
    timerCount() {
      return timers.size;
    },
  };
}

describe("SSE 断线重连", () => {
  it("EventSource 进入 CLOSED 后显式重建，并且重复 error 不创建重复连接", () => {
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
    first.readyState = EVENT_SOURCE_CLOSED;
    first.onerror?.({} as Event);
    first.onerror?.({} as Event);

    expect(connections).toEqual([false]);
    expect(first.closeCalls).toBe(1);
    expect(harness.timerCount()).toBe(1);
    expect(harness.delays).toEqual([EVENT_STREAM_RETRY_DELAYS_MS[0]]);

    harness.runNextTimer();
    expect(harness.sources).toHaveLength(2);

    unsubscribe();
    expect(harness.sources[1]!.closeCalls).toBe(1);
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
      harness.runNextTimer();
    }

    expect(harness.delays).toEqual([
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
    harness.runNextTimer();

    expect(harness.urls).toEqual(["/api/v1/events", "/api/v1/events?cursor=stream-a%3A42"]);
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
