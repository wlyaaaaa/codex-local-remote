import { timingSafeEqual } from "node:crypto";
import { readFile, stat } from "node:fs/promises";

const MAINTENANCE_TOKEN = /^[a-f0-9]{64}$/u;
const UPDATE_ID = /^[a-f0-9]{32}$/u;
const MAX_TOKEN_FILE_BYTES = 256;

export interface MaintenanceDrainReceipt {
  activeMutations: 0;
  status: "drained";
  updateId: string;
}

export interface MaintenanceActivityLease {
  release(): void;
}

export interface MaintenanceActivityGate {
  tryAdmitActivity(): MaintenanceActivityLease | undefined;
}

export type MaintenanceMutationLease = MaintenanceActivityLease;

export class MaintenanceDrainTimeoutError extends Error {
  constructor() {
    super("Sidecar maintenance drain timed out");
    this.name = "MaintenanceDrainTimeoutError";
  }
}

export class MaintenanceUpdateConflictError extends Error {
  constructor() {
    super("Sidecar is already draining for another update");
    this.name = "MaintenanceUpdateConflictError";
  }
}

export class SidecarMaintenanceController {
  readonly #drainTimeoutMs: number;
  readonly #waiters = new Set<(receipt: MaintenanceDrainReceipt) => void>();
  #activeActivities = 0;
  #receipt: MaintenanceDrainReceipt | undefined;
  #state: "draining" | "serving" = "serving";
  #updateId: string | undefined;

  constructor(drainTimeoutMs = 30_000) {
    if (!Number.isSafeInteger(drainTimeoutMs) || drainTimeoutMs < 1 || drainTimeoutMs > 120_000) {
      throw new Error("Sidecar maintenance drain timeout is invalid");
    }
    this.#drainTimeoutMs = drainTimeoutMs;
  }

  get state(): "draining" | "serving" {
    return this.#state;
  }

  tryAdmitActivity(): MaintenanceActivityLease | undefined {
    if (this.#state !== "serving") {
      return undefined;
    }
    this.#activeActivities += 1;
    let released = false;
    return {
      release: () => {
        if (released) {
          return;
        }
        released = true;
        this.#activeActivities -= 1;
        this.#completeDrainIfReady();
      },
    };
  }

  tryAdmitMutation(): MaintenanceMutationLease | undefined {
    return this.tryAdmitActivity();
  }

  async drain(updateId: string): Promise<MaintenanceDrainReceipt> {
    if (!isCanonicalMaintenanceUpdateId(updateId)) {
      throw new Error("Sidecar maintenance update id is invalid");
    }
    if (this.#state === "serving") {
      this.#state = "draining";
      this.#updateId = updateId;
      this.#completeDrainIfReady();
    } else if (this.#updateId !== updateId) {
      throw new MaintenanceUpdateConflictError();
    }
    if (this.#receipt !== undefined) {
      return this.#receipt;
    }

    return await new Promise<MaintenanceDrainReceipt>((resolve, reject) => {
      const onDrained = (receipt: MaintenanceDrainReceipt) => {
        clearTimeout(timeout);
        this.#waiters.delete(onDrained);
        resolve(receipt);
      };
      const timeout = setTimeout(() => {
        this.#waiters.delete(onDrained);
        if (
          this.#receipt === undefined &&
          this.#state === "draining" &&
          this.#updateId === updateId &&
          this.#waiters.size === 0
        ) {
          this.#state = "serving";
          this.#updateId = undefined;
        }
        reject(new MaintenanceDrainTimeoutError());
      }, this.#drainTimeoutMs);
      timeout.unref();
      this.#waiters.add(onDrained);
    });
  }

  #completeDrainIfReady(): void {
    if (
      this.#state !== "draining" ||
      this.#activeActivities !== 0 ||
      this.#receipt !== undefined ||
      this.#updateId === undefined
    ) {
      return;
    }
    this.#receipt = Object.freeze({
      activeMutations: 0,
      status: "drained",
      updateId: this.#updateId,
    });
    for (const waiter of this.#waiters) {
      waiter(this.#receipt);
    }
    this.#waiters.clear();
  }
}

export async function readMaintenanceToken(filePath: string): Promise<string> {
  const file = await stat(filePath);
  if (!file.isFile() || file.size < 64 || file.size > MAX_TOKEN_FILE_BYTES) {
    throw new Error("Sidecar maintenance token file is invalid");
  }
  const contents = await readFile(filePath, "utf8");
  if (Buffer.byteLength(contents, "utf8") > MAX_TOKEN_FILE_BYTES) {
    throw new Error("Sidecar maintenance token file is invalid");
  }
  const token = contents.endsWith("\r\n")
    ? contents.slice(0, -2)
    : contents.endsWith("\n")
      ? contents.slice(0, -1)
      : contents;
  if (!isHighEntropyMaintenanceToken(token)) {
    throw new Error("Sidecar maintenance token file is invalid");
  }
  return token;
}

export function isCanonicalMaintenanceUpdateId(value: string | undefined): value is string {
  return value !== undefined && UPDATE_ID.test(value);
}

export function isHighEntropyMaintenanceToken(value: string | undefined): value is string {
  return value !== undefined && MAINTENANCE_TOKEN.test(value);
}

export function matchesMaintenanceBearer(
  expectedToken: string,
  authorization: string | undefined,
): boolean {
  const prefix = "Bearer ";
  if (authorization === undefined || authorization.length <= prefix.length) {
    return false;
  }
  if (authorization.slice(0, prefix.length).toLocaleLowerCase("en-US") !== "bearer ") {
    return false;
  }
  const candidate = authorization.slice(prefix.length);
  const expectedBytes = Buffer.from(expectedToken, "utf8");
  const candidateBytes = Buffer.from(candidate, "utf8");
  return (
    expectedBytes.length === candidateBytes.length && timingSafeEqual(expectedBytes, candidateBytes)
  );
}
