import { describe, expect, it } from 'vitest';
import { createPromptRequestSchema, extractVariables, fillPrompt } from './workspace.js';

describe('prompt variables', () => {
  const body =
    'Soạn đề cương môn {{tên môn}} cho {{ so_tuan }} tuần, trình độ {{trình_độ}}. {{tên môn}}!';
  it('finds each variable once, in order', () => {
    expect(extractVariables(body)).toEqual(['tên môn', 'so_tuan', 'trình_độ']);
    expect(extractVariables('Không có biến')).toEqual([]);
  });
  it('fills known values and keeps the rest', () => {
    expect(fillPrompt(body, { 'tên môn': 'Kinh tế vĩ mô', so_tuan: '15' })).toBe(
      'Soạn đề cương môn Kinh tế vĩ mô cho 15 tuần, trình độ {{trình_độ}}. Kinh tế vĩ mô!',
    );
  });
  it('defaults new prompts to private', () => {
    expect(createPromptRequestSchema.parse({ title: 'A', body: 'B' })).toMatchObject({
      visibility: 'private',
      category: 'khac',
      publishedTo: [],
    });
  });
});
