/** Exit codes are part of the CLI's public contract: agents and CI branch on them. */
export const EXIT_CODES = {
  /** The command ran. For `audit` and `optimize`, findings do not change this. */
  OK: 0,
  /** `check` found findings above the configured thresholds. */
  FINDINGS: 1,
  /** The command line or the configuration file was invalid. */
  USAGE: 2,
  /** Refused to act for safety, such as a dirty git tree or another tool's config file. */
  ABORTED: 3,
  /** Failed in a way Upfly did not anticipate; the message says what happened. */
  INTERNAL: 4,
} as const;

/** One of the codes in `EXIT_CODES`, the number the binary exits with. */
export type ExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES];

/**
 * Every name an error line's `reason` can carry, for scripts and agents to branch on. A
 * refusal can only be given a name from this list, and `AGENTS.md` says what to do for each.
 */
export const REFUSAL_REASONS = [
  'UNCOMMITTED_CHANGES',
  'NO_REPOSITORY',
  'NO_GIT_IDENTITY',
  'GIT_OPERATION_IN_PROGRESS',
  'IGNORED_BY_GIT',
  'GIT_COMMIT_FAILED',
  'SERVING_ROOT_UNKNOWN',
  'TRANSACTION_INTERRUPTED',
  'TRANSACTION_LOCKED',
  'TRANSACTION_FOREIGN_CHANGE',
  'TRANSACTION_PLAN_INVALID',
  'MOVE_REFUSED',
  'CONFIG_EXISTS',
  'UPFLY_BLOCK_UNCLOSED',
  'V2_EXTENSION_CONFIG',
  'MANIFEST_VERSION_UNSUPPORTED',
  'MANIFEST_UNREADABLE',
] as const;

/** One of `REFUSAL_REASONS`. */
export type RefusalReason = (typeof REFUSAL_REASONS)[number];

/** Whether `code` is a name a refusal can carry. */
export function isRefusalReason(code: string): code is RefusalReason {
  return (REFUSAL_REASONS as readonly string[]).includes(code);
}
