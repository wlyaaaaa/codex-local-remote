export { checkPasswordStrength, hashPassword, verifyPassword } from "./password.js";
export type { PasswordStrengthResult } from "./password.js";

export { createSession, digestSessionToken, touchSession, validateSession } from "./session.js";
export type { CreateSessionOptions, SessionRecord, SessionValidation } from "./session.js";

export { createCsrfToken, verifyCsrfToken } from "./csrf.js";
export type { CsrfToken } from "./csrf.js";

export { validateBrowserMutation } from "./request-guards.js";
export type { BrowserMutationInput, BrowserMutationResult } from "./request-guards.js";

export { LoginRateLimiter } from "./rate-limiter.js";
export type {
  LoginRateLimitDecision,
  LoginRateLimiterConfig,
  LoginRateLimitScopeConfig,
} from "./rate-limiter.js";

export {
  resolveContainedPath,
  resolveContainedPathFromCanonicalRoot,
  validateSafeWindowsProjectRoot,
  validateSafeWindowsRelativePath,
} from "./windows-path.js";
export type {
  WindowsProjectRootValidation,
  WindowsRelativePathValidation,
} from "./windows-path.js";

export {
  authorizeDownload,
  authorizeDownloadFromCanonicalRoot,
  evaluateDownload,
} from "./download-policy.js";
export type {
  AuthorizedDownload,
  DownloadAuthorizationFileSystem,
  DownloadCandidate,
  DownloadDecision,
} from "./download-policy.js";

export { sanitizeAuditMetadata } from "./audit.js";
export type { AuditMetadata } from "./audit.js";
