import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MAX_SCHEMA_BYTES = 16 * 1024 * 1024;
const MAX_OPTION_LENGTH = 256;

export interface CodexProtocolCatalog {
  approvalPolicies: string[];
  approvalReviewers: string[];
  clientMethods: string[];
  serverRequestDecisionFallbacks: Record<string, unknown[]>;
}

export async function loadCodexProtocolCatalog(
  codexPath: string | undefined,
): Promise<CodexProtocolCatalog> {
  if (!codexPath) {
    return emptyCatalog();
  }
  const outputDirectory = await mkdtemp(path.join(os.tmpdir(), "codex-local-remote-schema-"));
  try {
    await execFileAsync(
      codexPath,
      ["app-server", "generate-json-schema", "--experimental", "--out", outputDirectory],
      {
        maxBuffer: 1024 * 1024,
        timeout: 15_000,
        windowsHide: true,
      },
    );
    const clientRequest = await readBoundedJson(path.join(outputDirectory, "ClientRequest.json"));
    const serverRequest = await readBoundedJson(path.join(outputDirectory, "ServerRequest.json"));
    if (clientRequest === undefined || serverRequest === undefined) {
      return emptyCatalog();
    }
    const responseSchemas: Record<string, unknown> = {};
    for (const title of responseSchemaTitles(serverRequest)) {
      if (!/^[A-Za-z0-9_-]{1,256}$/u.test(title)) {
        continue;
      }
      const schema = await readBoundedJson(path.join(outputDirectory, `${title}.json`));
      if (schema !== undefined) {
        responseSchemas[title] = schema;
      }
    }
    return parseCodexProtocolCatalog(clientRequest, serverRequest, responseSchemas);
  } catch {
    return emptyCatalog();
  } finally {
    await rm(outputDirectory, { force: true, recursive: true }).catch(() => undefined);
  }
}

export function parseCodexProtocolCatalog(
  clientRequestSchema: unknown,
  serverRequestSchema?: unknown,
  responseSchemas: Readonly<Record<string, unknown>> = {},
): CodexProtocolCatalog {
  const definitions = asRecord(asRecord(clientRequestSchema).definitions);
  return {
    approvalPolicies: collectStringEnumValues(definitions.AskForApproval),
    approvalReviewers: collectStringEnumValues(definitions.ApprovalsReviewer),
    clientMethods: collectClientMethods(clientRequestSchema),
    serverRequestDecisionFallbacks: collectServerRequestDecisionFallbacks(
      serverRequestSchema,
      responseSchemas,
    ),
  };
}

function collectClientMethods(clientRequestSchema: unknown): string[] {
  const root = asRecord(clientRequestSchema);
  const definitions = asRecord(root.definitions);
  const requests = Array.isArray(root.oneOf) ? root.oneOf : [];
  return [
    ...new Set(
      requests.flatMap((candidate) => {
        const request = asRecord(resolveSchema(candidate, definitions));
        const properties = asRecord(request.properties);
        return collectStringEnumValues(resolveSchema(properties.method, definitions));
      }),
    ),
  ];
}

function collectServerRequestDecisionFallbacks(
  serverRequestSchema: unknown,
  responseSchemas: Readonly<Record<string, unknown>>,
): Record<string, unknown[]> {
  const result: Record<string, unknown[]> = {};
  const root = asRecord(serverRequestSchema);
  const definitions = asRecord(root.definitions);
  const requests = Array.isArray(root.oneOf) ? root.oneOf : [];
  for (const candidate of requests) {
    const request = asRecord(resolveSchema(candidate, definitions));
    const properties = asRecord(request.properties);
    const methods = collectStringEnumValues(properties.method);
    const paramsReference = asString(asRecord(properties.params).$ref);
    const paramsDefinitionName = localReferenceName(paramsReference);
    if (methods.length !== 1) {
      continue;
    }
    const requestTitle = asString(request.title);
    const responseTitle = requestTitle?.endsWith("Request")
      ? `${requestTitle.slice(0, -"Request".length)}Response`
      : undefined;
    const paramsResponseTitle = paramsDefinitionName?.endsWith("Params")
      ? `${paramsDefinitionName.slice(0, -"Params".length)}Response`
      : undefined;
    const responseSchema =
      (paramsResponseTitle === undefined ? undefined : responseSchemas[paramsResponseTitle]) ??
      (responseTitle === undefined ? undefined : responseSchemas[responseTitle]);
    if (responseSchema === undefined) {
      continue;
    }
    const decisions = collectResponseDecisionValues(responseSchema);
    if (decisions.length > 0) {
      result[methods[0]!] = decisions;
    }
  }
  return result;
}

function collectResponseDecisionValues(schema: unknown): unknown[] {
  const root = asRecord(schema);
  const definitions = asRecord(root.definitions);
  const decisionSchema = resolveSchema(asRecord(root.properties).decision, definitions);
  const decisions: unknown[] = [];
  const visit = (candidate: unknown): void => {
    const resolved = resolveSchema(candidate, definitions);
    if (Array.isArray(resolved)) {
      for (const item of resolved) visit(item);
      return;
    }
    const record = asRecord(resolved);
    for (const key of ["allOf", "anyOf", "oneOf"] as const) {
      if (Array.isArray(record[key])) {
        visit(record[key]);
      }
    }
    if (record.type === "string" && Array.isArray(record.enum)) {
      const description = asString(record.description)?.toLowerCase() ?? "";
      for (const value of record.enum) {
        if (
          typeof value === "string" &&
          value.length > 0 &&
          value.length <= MAX_OPTION_LENGTH &&
          !description.includes("timed out") &&
          !description.includes("automatic approval")
        ) {
          decisions.push(value);
        }
      }
      return;
    }
    if (record.type === "object" && isDenialDecisionSchema(record)) {
      const instantiated = instantiateRequiredObject(record, definitions, []);
      if (instantiated !== undefined) {
        decisions.push(instantiated);
      }
    }
  };
  visit(decisionSchema);
  const unique = new Map<string, unknown>();
  for (const decision of decisions.slice(0, 20)) {
    const key = JSON.stringify(decision);
    if (key.length <= 8_192 && !unique.has(key)) {
      unique.set(key, decision);
    }
  }
  return [...unique.values()];
}

function isDenialDecisionSchema(schema: Record<string, unknown>): boolean {
  const required = Array.isArray(schema.required)
    ? schema.required.filter((value): value is string => typeof value === "string")
    : [];
  const title = asString(schema.title) ?? "";
  const description = asString(schema.description) ?? "";
  return /deni|declin|reject|cancel|abort/iu.test(`${required.join(" ")} ${title} ${description}`);
}

function instantiateRequiredObject(
  schema: unknown,
  definitions: Record<string, unknown>,
  pathParts: string[],
): unknown {
  const record = asRecord(resolveSchema(schema, definitions));
  if (record.type === "string") {
    const values = Array.isArray(record.enum)
      ? record.enum.filter((value): value is string => typeof value === "string")
      : [];
    return (
      values[0] ??
      (/deni|declin|reject|cancel|abort/iu.test(pathParts.join(" ")) ? "用户拒绝" : undefined)
    );
  }
  if (record.type !== "object") {
    return undefined;
  }
  const required = Array.isArray(record.required)
    ? record.required.filter((value): value is string => typeof value === "string")
    : [];
  if (required.length === 0 || required.length > 12) {
    return undefined;
  }
  const properties = asRecord(record.properties);
  const result: Record<string, unknown> = {};
  for (const key of required) {
    const value = instantiateRequiredObject(properties[key], definitions, [...pathParts, key]);
    if (value === undefined) {
      return undefined;
    }
    result[key] = value;
  }
  return result;
}

function responseSchemaTitles(serverRequestSchema: unknown): string[] {
  const root = asRecord(serverRequestSchema);
  const requests = Array.isArray(root.oneOf) ? root.oneOf : [];
  return [
    ...new Set(
      requests.flatMap((candidate) => {
        const request = asRecord(candidate);
        const title = asString(request.title);
        const paramsReference = asString(asRecord(asRecord(request.properties).params).$ref);
        const paramsDefinitionName = localReferenceName(paramsReference);
        return [
          ...(title?.endsWith("Request") === true
            ? [`${title.slice(0, -"Request".length)}Response`]
            : []),
          ...(paramsDefinitionName?.endsWith("Params") === true
            ? [`${paramsDefinitionName.slice(0, -"Params".length)}Response`]
            : []),
        ];
      }),
    ),
  ];
}

async function readBoundedJson(filePath: string): Promise<unknown> {
  try {
    const metadata = await stat(filePath);
    if (!metadata.isFile() || metadata.size > MAX_SCHEMA_BYTES) {
      return undefined;
    }
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return undefined;
  }
}

function resolveSchema(value: unknown, definitions: Record<string, unknown>): unknown {
  const reference = asString(asRecord(value).$ref);
  return resolveLocalReference(reference, definitions) ?? value;
}

function resolveLocalReference(
  reference: string | undefined,
  definitions: Record<string, unknown>,
): unknown {
  const name = localReferenceName(reference);
  return name === undefined ? undefined : definitions[name];
}

function localReferenceName(reference: string | undefined): string | undefined {
  const prefix = "#/definitions/";
  return reference?.startsWith(prefix) === true ? reference.slice(prefix.length) : undefined;
}

function collectStringEnumValues(value: unknown): string[] {
  const collected: string[] = [];
  const visit = (candidate: unknown): void => {
    if (Array.isArray(candidate)) {
      for (const item of candidate) visit(item);
      return;
    }
    const record = asRecord(candidate);
    if (record.type === "string" && Array.isArray(record.enum)) {
      for (const option of record.enum) {
        if (typeof option === "string" && option.length > 0 && option.length <= MAX_OPTION_LENGTH) {
          collected.push(option);
        }
      }
    }
    for (const key of ["allOf", "anyOf", "oneOf"] as const) {
      if (Array.isArray(record[key])) visit(record[key]);
    }
  };
  visit(value);
  return [...new Set(collected)];
}

function emptyCatalog(): CodexProtocolCatalog {
  return {
    approvalPolicies: [],
    approvalReviewers: [],
    clientMethods: [],
    serverRequestDecisionFallbacks: {},
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
