import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { basename, relative, resolve } from "node:path";
import { TextDecoder } from "node:util";

const arguments_ = process.argv.slice(2);
const rootFlag = arguments_.indexOf("--root");
const root = resolve(
  rootFlag >= 0 && arguments_[rootFlag + 1] ? arguments_[rootFlag + 1] : import.meta.dirname,
  rootFlag >= 0 ? "." : "..",
);
const maximumFileSize = 2_000_000;
const reviewedBinaryAssets = new Map([
  ["docs/assets/desktop-tasks-en.jpg", "jpeg"],
  ["docs/assets/mobile-conversation-zh.jpg", "jpeg"],
  ["docs/assets/mobile-tasks-en.jpg", "jpeg"],
]);

const candidates = execFileSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
  {
    cwd: root,
    encoding: "utf8",
  },
)
  .split("\0")
  .filter(Boolean);

const placeholderWords = new Set([
  "demo",
  "device",
  "example",
  "fake",
  "fixture",
  "host",
  "hostname",
  "local",
  "machine",
  "node",
  "placeholder",
  "sample",
  "tailnet",
  "tailnet-name",
  "test",
  "user",
  "username",
  "you",
  "your-name",
]);

const forbidden = [
  {
    label: "OpenAI-style secret",
    pattern: /\bsk-(?!example|test|fake|demo)[A-Za-z0-9_-]{20,}\b/gu,
  },
  {
    label: "GitHub token",
    pattern: /\b(?:ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/gu,
  },
  { label: "Tailscale auth key", pattern: /\btskey-[A-Za-z0-9_-]{20,}\b/gu },
  { label: "AWS access key", pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/gu },
  { label: "Google API key", pattern: /\bAIza[A-Za-z0-9_-]{35}\b/gu },
  {
    label: "Slack token",
    pattern: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/gu,
  },
  {
    label: "live payment secret",
    pattern: /\bsk_live_[A-Za-z0-9]{20,}\b/gu,
  },
  {
    label: "private key material",
    pattern: /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/gu,
  },
  {
    label: "OAuth client secret",
    pattern: /["']client_secret["']\s*:\s*["'](?!example|test|fake|demo)[^"'\r\n]{16,}["']/giu,
  },
  {
    label: "cloud account secret",
    pattern:
      /\b(?:aws_secret_access_key|accountkey)\b\s*[:=]\s*["']?(?!example|test|fake|demo)[A-Za-z0-9+/=_-]{32,}/giu,
  },
];

function isSensitiveFilename(candidate) {
  const name = basename(candidate).toLowerCase();
  if (
    name === ".env" ||
    (name.startsWith(".env.") && !/\.(?:example|sample|template)$/.test(name))
  ) {
    return true;
  }
  if (/^id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?$/.test(name)) {
    return !name.endsWith(".pub");
  }
  if (/\.(?:key|p12|pfx|pem)$/.test(name)) {
    return true;
  }
  return (
    /^(?:client[_-]?secret|credentials|oauth)[^/]*\.json$/.test(name) &&
    !/(?:example|sample|template)/.test(name)
  );
}

function decodeText(buffer) {
  const acceptText = (decoded) => {
    for (const character of decoded) {
      const code = character.codePointAt(0);
      if (code !== undefined && code < 32 && code !== 9 && code !== 10 && code !== 13) {
        return undefined;
      }
    }
    return decoded;
  };

  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    if ((buffer.length - 2) % 2 !== 0) return undefined;
    return acceptText(new TextDecoder("utf-16le", { fatal: true }).decode(buffer.subarray(2)));
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    if ((buffer.length - 2) % 2 !== 0) return undefined;
    const swapped = Buffer.allocUnsafe(buffer.length - 2);
    for (let index = 2; index + 1 < buffer.length; index += 2) {
      swapped[index - 2] = buffer[index + 1];
      swapped[index - 1] = buffer[index];
    }
    return acceptText(new TextDecoder("utf-16le", { fatal: true }).decode(swapped));
  }

  const sampleLength = Math.min(buffer.length, 512);
  let evenNulls = 0;
  let oddNulls = 0;
  for (let index = 0; index < sampleLength; index += 1) {
    if (buffer[index] === 0) {
      if (index % 2 === 0) evenNulls += 1;
      else oddNulls += 1;
    }
  }
  const pairs = Math.max(1, Math.floor(sampleLength / 2));
  if (buffer.length % 2 === 0 && oddNulls / pairs > 0.3 && evenNulls / pairs < 0.05) {
    return acceptText(new TextDecoder("utf-16le", { fatal: true }).decode(buffer));
  }
  if (buffer.length % 2 === 0 && evenNulls / pairs > 0.3 && oddNulls / pairs < 0.05) {
    const swapped = Buffer.allocUnsafe(buffer.length);
    for (let index = 0; index + 1 < buffer.length; index += 2) {
      swapped[index] = buffer[index + 1];
      swapped[index + 1] = buffer[index];
    }
    return acceptText(new TextDecoder("utf-16le", { fatal: true }).decode(swapped));
  }

  try {
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    return decoded.includes("\0") ? undefined : acceptText(decoded);
  } catch {
    return undefined;
  }
}

function hasReviewedImageSignature(candidate, buffer) {
  const normalized = candidate.replaceAll("\\", "/");
  const format = reviewedBinaryAssets.get(normalized);
  if (!format) return false;
  if (format === "jpeg") {
    return (
      buffer.length >= 4 &&
      buffer[0] === 0xff &&
      buffer[1] === 0xd8 &&
      buffer[2] === 0xff &&
      buffer.at(-2) === 0xff &&
      buffer.at(-1) === 0xd9
    );
  }
  return false;
}

function lineNumberAt(source, index) {
  return source.slice(0, index).split(/\r\n|[\n\r]/u).length;
}

function scanWindowsPaths(source, candidate, findings) {
  let normalized = source;
  for (let index = 0; index < 3; index += 1) {
    normalized = normalized.replaceAll("\\\\", "\\");
  }
  const userPath = /\b[A-Za-z]:\\Users\\([^\\/"'\r\n]+)/giu;
  for (const match of normalized.matchAll(userPath)) {
    const user = match[1].replace(/[<>%${}]/gu, "").toLowerCase();
    if (!placeholderWords.has(user)) {
      findings.push(
        `${candidate}:${lineNumberAt(normalized, match.index)} machine-specific Windows user path`,
      );
    }
  }
}

function scanFunnelHostnames(source, candidate, findings) {
  const hostname = /\b([a-z0-9-]+)\.([a-z0-9-]+)\.ts\.net\b/giu;
  for (const match of source.matchAll(hostname)) {
    const machine = match[1].toLowerCase();
    const tailnet = match[2].toLowerCase();
    if (placeholderWords.has(machine) || placeholderWords.has(tailnet)) {
      continue;
    }
    findings.push(`${candidate}:${lineNumberAt(source, match.index)} real Funnel hostname`);
  }
}

const findings = [];

for (const candidate of candidates) {
  const absolute = resolve(root, candidate);
  const stat = lstatSync(absolute);

  if (isSensitiveFilename(candidate)) {
    findings.push(`${candidate}:1 sensitive filename`);
    continue;
  }
  if (stat.isSymbolicLink()) {
    findings.push(`${candidate}:1 symbolic link requires explicit public review`);
    continue;
  }
  if (stat.size > maximumFileSize) {
    findings.push(
      `${candidate}:1 oversized file (${stat.size} bytes) was rejected instead of skipped`,
    );
    continue;
  }

  const content = readFileSync(absolute);
  if (hasReviewedImageSignature(candidate, content)) {
    continue;
  }
  const source = decodeText(content);
  if (source === undefined) {
    findings.push(`${candidate}:1 binary or unsupported encoding was rejected instead of skipped`);
    continue;
  }

  for (const rule of forbidden) {
    for (const match of source.matchAll(rule.pattern)) {
      findings.push(
        `${relative(root, absolute)}:${lineNumberAt(source, match.index)} ${rule.label}`,
      );
    }
  }
  scanWindowsPaths(source, relative(root, absolute), findings);
  scanFunnelHostnames(source, relative(root, absolute), findings);
}

if (findings.length > 0) {
  process.stderr.write(
    `Public-safety scan failed:\n${findings.map((item) => `- ${item}`).join("\n")}\n`,
  );
  process.exitCode = 1;
} else {
  process.stdout.write(`Public-safety scan passed (${candidates.length} files checked).\n`);
}
