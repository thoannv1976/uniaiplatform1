import { describe, expect, it } from 'vitest';
import { isAllowedEmail, isPermittedEmail, parseDomainList, parseEmailList } from './email.js';

describe('isAllowedEmail', () => {
  const domains = ['ftu.edu.vn'];

  it('accepts addresses of the allowed domain, case-insensitively', () => {
    expect(isAllowedEmail('gv01@ftu.edu.vn', domains)).toBe(true);
    expect(isAllowedEmail('GV01@FTU.EDU.VN', domains)).toBe(true);
  });

  it('rejects other domains, subdomains and look-alikes', () => {
    expect(isAllowedEmail('a@gmail.com', domains)).toBe(false);
    expect(isAllowedEmail('sv@student.ftu.edu.vn', domains)).toBe(false);
    expect(isAllowedEmail('a@ftu.edu.vn.evil.com', domains)).toBe(false);
    expect(isAllowedEmail('a@evilftu.edu.vn', domains)).toBe(false);
  });

  it('rejects malformed or missing emails', () => {
    expect(isAllowedEmail(undefined, domains)).toBe(false);
    expect(isAllowedEmail('', domains)).toBe(false);
    expect(isAllowedEmail('@ftu.edu.vn', domains)).toBe(false);
    expect(isAllowedEmail('ftu.edu.vn@', domains)).toBe(false);
  });
});

describe('parseDomainList', () => {
  it('splits, trims, lower-cases and strips a leading @', () => {
    expect(parseDomainList(' @FTU.edu.vn, example.org ,')).toEqual(['ftu.edu.vn', 'example.org']);
    expect(parseDomainList(undefined)).toEqual([]);
  });
});

describe('isPermittedEmail', () => {
  const policy = {
    domains: ['ftu.edu.vn'],
    extraEmails: parseEmailList(' Admin@Gmail.com , bad '),
  };

  it('accepts the school domain and the exact break-glass addresses only', () => {
    expect(policy.extraEmails).toEqual(['admin@gmail.com']);
    expect(isPermittedEmail('gv@ftu.edu.vn', policy)).toBe(true);
    expect(isPermittedEmail('ADMIN@gmail.com', policy)).toBe(true);
    expect(isPermittedEmail('other@gmail.com', policy)).toBe(false);
    expect(isPermittedEmail('xadmin@gmail.com', policy)).toBe(false);
    expect(isPermittedEmail(undefined, policy)).toBe(false);
  });
});
