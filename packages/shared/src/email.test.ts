import { describe, expect, it } from 'vitest';
import { isAllowedEmail, parseDomainList } from './email.js';

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
