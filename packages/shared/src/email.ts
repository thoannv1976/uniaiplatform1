/** Normalises a domain list entry: lower-case, no leading "@". */
function normaliseDomain(domain: string): string {
  return domain.trim().toLowerCase().replace(/^@/, '');
}

export function parseDomainList(value: string | undefined): string[] {
  return (value ?? '').split(',').map(normaliseDomain).filter(Boolean);
}

/**
 * True when the email belongs exactly to one of the allowed domains.
 * Subdomains are NOT accepted (student.ftu.edu.vn is not ftu.edu.vn).
 */
export function isAllowedEmail(email: string | undefined, allowedDomains: string[]): boolean {
  if (!email) return false;
  const at = email.lastIndexOf('@');
  if (at <= 0 || at === email.length - 1) return false;
  const domain = email.slice(at + 1).toLowerCase();
  return allowedDomains.map(normaliseDomain).includes(domain);
}

/** Parses a comma-separated list of exact email addresses (lower-cased, trimmed). */
export function parseEmailList(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e.includes('@'));
}

export interface EmailPolicy {
  /** Whole domains, e.g. ["ftu.edu.vn"]. */
  domains: string[];
  /**
   * Exact addresses allowed outside those domains: break-glass admin accounts that sign in
   * with email + password (decision 2026-10-01, ADR 0004). Keep this list very short.
   */
  extraEmails: string[];
}

export function isPermittedEmail(email: string | undefined, policy: EmailPolicy): boolean {
  if (!email) return false;
  return (
    isAllowedEmail(email, policy.domains) || policy.extraEmails.includes(email.trim().toLowerCase())
  );
}
