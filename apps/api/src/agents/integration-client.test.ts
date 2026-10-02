import type { IntegrationOperation } from '@uniai/shared';
import { describe, expect, it } from 'vitest';
import {
  buildOperationUrl,
  IntegrationArgumentError,
  integrationUrlAllowed,
} from './integration-client.js';

const op: IntegrationOperation = {
  id: 'get_grades',
  name: 'Điểm',
  description: 'Điểm của sinh viên trong học phần',
  method: 'GET',
  path: '/courses/{courseId}/grades',
  parameters: [
    { name: 'courseId', in: 'path', type: 'string', description: '', required: true },
    { name: 'term', in: 'query', type: 'number', description: '', required: false },
    { name: 'final', in: 'query', type: 'boolean', description: '', required: false },
  ],
};
const base = { baseUrl: 'https://lms.example.edu.vn/api/v2' };

describe('buildOperationUrl', () => {
  it('fills path and query parameters under the base path', () => {
    expect(buildOperationUrl(base, op, { courseId: 'KT101', term: 2, final: true }).href).toBe(
      'https://lms.example.edu.vn/api/v2/courses/KT101/grades?term=2&final=true',
    );
    expect(
      buildOperationUrl({ baseUrl: 'https://lms.example.edu.vn/' }, op, { courseId: 'A' }).href,
    ).toBe('https://lms.example.edu.vn/courses/A/grades');
  });

  it('never leaves the configured system', () => {
    // Slashes and dots are encoded inside the segment, "..", "." and other hosts are refused.
    expect(buildOperationUrl(base, op, { courseId: '../../admin' }).pathname).toBe(
      '/api/v2/courses/..%2F..%2Fadmin/grades',
    );
    expect(buildOperationUrl(base, op, { courseId: 'http://evil.example/x' }).host).toBe(
      'lms.example.edu.vn',
    );
    for (const courseId of ['..', '.']) {
      expect(() => buildOperationUrl(base, op, { courseId })).toThrow(IntegrationArgumentError);
    }
  });

  it('checks required and typed arguments', () => {
    expect(() => buildOperationUrl(base, op, {})).toThrow(/Thiếu tham số bắt buộc "courseId"/);
    expect(() => buildOperationUrl(base, op, { courseId: 'A', term: 'hai' })).toThrow(/phải là số/);
    expect(() => buildOperationUrl(base, op, { courseId: 'A', final: 'có' })).toThrow(
      /true\/false/,
    );
    expect(() => buildOperationUrl(base, op, { courseId: { x: 1 } })).toThrow(/phải là chuỗi/);
    expect(() => buildOperationUrl(base, op, { courseId: 'x'.repeat(201) })).toThrow(/quá dài/);
  });

  it('accepts http only for local test systems with the mock provider', () => {
    expect(
      integrationUrlAllowed('https://lms.example.edu.vn', { mockProviderEnabled: false }),
    ).toBe(true);
    expect(integrationUrlAllowed('http://lms.example.edu.vn', { mockProviderEnabled: true })).toBe(
      false,
    );
    expect(integrationUrlAllowed('http://127.0.0.1:8099', { mockProviderEnabled: true })).toBe(
      true,
    );
    expect(integrationUrlAllowed('http://127.0.0.1:8099', { mockProviderEnabled: false })).toBe(
      false,
    );
  });
});
