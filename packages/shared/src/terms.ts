import { z } from 'zod';

/**
 * Terms of use (spec 12: "Người dùng đồng ý điều khoản sử dụng ở lần đăng nhập đầu tiên").
 * Changing the text means a new version: everyone is asked again.
 */
export const TERMS_VERSION = '2026-10-v1';

export const TERMS_TITLE_VI = 'Điều khoản sử dụng Nền tảng AI của Trường Đại học Ngoại thương';

export const TERMS_SECTIONS_VI: string[] = [
  'Nền tảng chỉ dùng cho công việc chuyên môn của cán bộ, giảng viên: giảng dạy, nghiên cứu, hành chính.',
  'Không nhập dữ liệu mật, tuyệt mật, thông tin cá nhân nhạy cảm (CCCD, tài khoản ngân hàng, hồ sơ sức khỏe…) hoặc dữ liệu người học khi chưa được phép. Nội dung được gửi tới nhà cung cấp AI (OpenAI, Google, Anthropic) theo gói không dùng dữ liệu để huấn luyện.',
  'Kết quả do AI tạo ra có thể sai. Bạn chịu trách nhiệm kiểm tra trước khi sử dụng và ghi rõ việc dùng AI khi trích dẫn trong học thuật theo quy định của Trường.',
  'Hội thoại và tệp đính kèm được lưu có thời hạn (mặc định 180 ngày) rồi tự xóa; quản trị viên không xem nội dung hội thoại của bạn, trừ quy trình điều tra sự cố có ghi nhật ký.',
  'Mỗi tài khoản có định mức chi phí AI hằng tháng; việc sử dụng (model, số token, chi phí) được ghi nhận để thống kê và kiểm toán.',
  'Vi phạm có thể dẫn tới khóa tài khoản theo quy định của Trường.',
];

export const acceptTermsRequestSchema = z.object({ version: z.string().min(1).max(50) }).strict();
