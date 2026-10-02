import { z } from 'zod';
import { apiErrorSchema } from './api.js';
import {
  platformChatRequestSchema,
  platformChatResponseSchema,
  platformModelsResponseSchema,
  platformStreamEventSchema,
  platformUsageResponseSchema,
} from './platform.js';

/** JSON Schema of a Zod schema, without the top-level "$schema" key (OpenAPI 3.1 dialect). */
function schema(s: z.ZodType, io: 'input' | 'output'): Record<string, unknown> {
  const out = z.toJSONSchema(s, { io, unrepresentable: 'any' }) as Record<string, unknown>;
  delete out.$schema;
  return out;
}

const error = (description: string) => ({
  description,
  content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
});

/**
 * OpenAPI 3.1 description of the Platform API (spec 10, M17), built from the same Zod
 * schemas the API validates with. docs/platform/openapi.json is this document (a unit test
 * checks they match).
 */
export function buildPlatformOpenApi(): Record<string, unknown> {
  return {
    openapi: '3.1.0',
    info: {
      title: 'UniAI Platform API',
      version: '1.0.0',
      description:
        'AI Gateway của Trường cho ứng dụng nội bộ. Xác thực: header `Authorization: Bearer uak_…` (API key của ứng dụng do Super Admin/AI Admin cấp). Mọi yêu cầu đi qua DLP, Smart Router, kill switch và trừ vào ngân sách tháng của ứng dụng; tiền tính bằng micro-USD (1 USD = 1.000.000).',
    },
    servers: [
      { url: '/', description: 'Địa chỉ API của môi trường (run.app hoặc tên miền riêng)' },
    ],
    security: [{ appKey: [] }],
    paths: {
      '/api/platform/v1/chat': {
        post: {
          operationId: 'chat',
          summary: 'Gọi AI (quyền "chat")',
          description:
            'Không lưu hội thoại: ứng dụng gửi toàn bộ các tin nhắn cần thiết. `stream: true` trả Server-Sent Events (`event: meta|delta|done|error`), ngược lại trả một JSON. Chi phí thực tế được trừ vào ngân sách tháng của ứng dụng và ghi sổ cái kèm `reference`.',
          requestBody: {
            required: true,
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/ChatRequest' } },
            },
          },
          responses: {
            '200': {
              description: 'Câu trả lời (JSON) hoặc luồng sự kiện (stream)',
              content: {
                'application/json': { schema: { $ref: '#/components/schemas/ChatResponse' } },
                'text/event-stream': { schema: { $ref: '#/components/schemas/StreamEvent' } },
              },
            },
            '400': error('Yêu cầu không hợp lệ'),
            '401': error('Thiếu hoặc sai API key'),
            '402': error('Hết ngân sách tháng của ứng dụng'),
            '403': error('Ứng dụng bị tạm dừng, thiếu quyền, hoặc model ngoài phạm vi'),
            '422': error('DLP chặn nội dung'),
            '428': error('DLP cảnh báo: gửi lại với "dlpAcknowledged": true nếu chắc chắn'),
            '429': error('Quá số yêu cầu/phút (xem header Retry-After)'),
            '502': error('Nhà cung cấp AI từ chối yêu cầu'),
            '503': error('AI tạm dừng (kill switch) hoặc nhà cung cấp không phản hồi'),
          },
        },
      },
      '/api/platform/v1/models': {
        get: {
          operationId: 'models',
          summary: 'Danh sách model ứng dụng được chọn (quyền "models")',
          responses: {
            '200': {
              description: 'Các model đang dùng được',
              content: {
                'application/json': { schema: { $ref: '#/components/schemas/ModelsResponse' } },
              },
            },
            '401': error('Thiếu hoặc sai API key'),
            '403': error('Thiếu quyền'),
          },
        },
      },
      '/api/platform/v1/usage': {
        get: {
          operationId: 'usage',
          summary: 'Ngân sách và chi phí tháng này của ứng dụng (quyền "usage")',
          responses: {
            '200': {
              description: 'Số liệu tháng hiện tại (micro-USD)',
              content: {
                'application/json': { schema: { $ref: '#/components/schemas/UsageResponse' } },
              },
            },
            '401': error('Thiếu hoặc sai API key'),
            '403': error('Thiếu quyền'),
          },
        },
      },
    },
    components: {
      securitySchemes: {
        appKey: {
          type: 'http',
          scheme: 'bearer',
          description: 'API key của ứng dụng, dạng uak_<mã ứng dụng>_<bí mật>',
        },
      },
      schemas: {
        ChatRequest: schema(platformChatRequestSchema, 'input'),
        ChatResponse: schema(platformChatResponseSchema, 'output'),
        StreamEvent: schema(platformStreamEventSchema, 'output'),
        ModelsResponse: schema(platformModelsResponseSchema, 'output'),
        UsageResponse: schema(platformUsageResponseSchema, 'output'),
        Error: schema(apiErrorSchema, 'output'),
      },
    },
  };
}
