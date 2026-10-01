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
