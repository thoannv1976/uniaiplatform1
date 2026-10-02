import { describe, expect, it } from 'vitest';
import {
  classifyRequest,
  DEFAULT_ROUTER_CONFIG,
  routerConfigSchema,
  tierFallbackOrder,
  type AutoTier,
} from './router.js';

/**
 * Spec 13.2 (M11): 100 sample questions; the default rules must route ≥ 85 % of them to
 * the expected tier. The university should replace these with its own 100 questions.
 */
const E: AutoTier = 'economy';
const S: AutoTier = 'standard';
const A: AutoTier = 'advanced';
type Sample = [string, AutoTier, { docs?: number; images?: number; chars?: number }?];
const SAMPLES: Sample[] = [
  // Everyday questions → economy
  ['Dịch câu này sang tiếng Anh: Chúc mừng năm mới thầy cô', E],
  ['Viết lời chúc sinh nhật ngắn cho đồng nghiệp', E],
  ['Từ "logistics" nghĩa là gì?', E],
  [
    'Tóm tắt đoạn văn sau trong 3 câu: Thương mại quốc tế là hoạt động trao đổi hàng hóa giữa các quốc gia.',
    E,
  ],
  ['Gợi ý 5 tiêu đề email mời họp bộ môn', E],
  ['Sửa lỗi chính tả: Tôi đang chuẩn bi bài giang', E],
  ['Viết email cảm ơn khách mời đã tham dự hội thảo', E],
  ['Giải thích ngắn gọn FOB và CIF khác nhau thế nào', E],
  ['Đặt 3 câu hỏi khởi động cho buổi học về marketing', E],
  ['Chuyển đoạn này thành văn phong trang trọng: mai họp nha mọi người', E],
  ['Thủ đô của Úc là gì?', E],
  ['Liệt kê 5 kỹ năng mềm cần thiết cho sinh viên năm nhất', E],
  ['Viết một câu slogan cho ngày hội việc làm', E],
  ['Định nghĩa lạm phát trong một câu', E],
  ['Có bao nhiêu châu lục trên thế giới?', E],
  ['Dịch sang tiếng Việt: The meeting has been postponed until further notice.', E],
  ['Gợi ý tên cho câu lạc bộ tiếng Anh của khoa', E],
  ['Viết lời mở đầu cho buổi lễ khai giảng, khoảng 5 câu', E],
  ['Tóm tắt ý chính: Doanh nghiệp cần đa dạng hóa thị trường xuất khẩu để giảm rủi ro.', E],
  ['Từ đồng nghĩa với "hiệu quả" là gì?', E],
  ['Cách viết tắt của Tổ chức Thương mại Thế giới', E],
  ['Viết thông báo nghỉ học ngắn gửi lớp', E],
  ['Gợi ý 3 trò chơi khởi động cho lớp 40 sinh viên', E],
  ['Chuyển 25 độ C sang độ F', E],
  ['Ngày quốc tế lao động là ngày nào?', E],
  [
    'Viết lại câu này cho ngắn gọn hơn: Chúng tôi xin trân trọng thông báo tới quý thầy cô về việc thay đổi lịch họp',
    E,
  ],
  ['Giải thích khái niệm chuỗi cung ứng cho học sinh cấp 3', E],
  ['Gợi ý quà tặng 20/11 cho giảng viên', E],
  ['Dịch tên chức danh "Trưởng phòng Đào tạo" sang tiếng Anh', E],
  ['Viết caption Facebook giới thiệu hội thảo khoa học sắp tới', E],
  ['Tính 15% của 2.400.000 đồng', E],
  ['Cho ví dụ về hàng rào phi thuế quan', E],
  ['Nên chào hỏi đối tác Nhật Bản thế nào trong email đầu tiên?', E],
  ['Viết tin nhắn nhắc sinh viên nộp bài đúng hạn', E],
  ['Tóm tắt điểm chính của học thuyết lợi thế so sánh', E],
  ['Viết lời cảm ơn cuối bài thuyết trình', E],
  ['Gợi ý 10 từ khóa tìm tài liệu về thương mại điện tử', E],
  ['Viết lại tiêu đề này hấp dẫn hơn: Hội thảo về xuất khẩu', E],
  ['Phân biệt "affect" và "effect"', E],
  ['Viết lời mời phát biểu ngắn gửi diễn giả', E],
  ['Ý nghĩa của chỉ số PMI là gì?', E],
  ['Đề xuất 3 hoạt động ngoại khóa cho tháng thanh niên', E],
  ['Chuyển câu sang thể bị động: Nhà trường tổ chức hội nghị', E],
  ['Tóm tắt trong 2 câu: Tỷ giá ảnh hưởng tới giá hàng xuất khẩu.', E],
  ['Viết lời chào mừng tân sinh viên trên website', E],
  ['Một tín chỉ tương đương bao nhiêu tiết học?', E],
  ['Viết phản hồi lịch sự từ chối lời mời họp', E],
  ['Cho 3 ví dụ về rủi ro trong thanh toán quốc tế', E],
  ['Giải thích từ viết tắt KPI', E],
  ['Viết lời nhắn chúc mừng đồng nghiệp được thăng chức', E],
  ['Gợi ý câu hỏi phỏng vấn cho vị trí trợ giảng', E],
  ['Hướng dẫn cách trích dẫn theo APA ngắn gọn', E],
  ['Viết đoạn giới thiệu bản thân 3 câu bằng tiếng Anh', E],
  ['Ý nghĩa của Incoterms là gì?', E],
  ['Viết thông báo thay đổi phòng học', E],
  // Drafting, code, files, images, long questions → standard
  ['Viết báo cáo tổng kết hoạt động năm học của bộ môn', S],
  ['Soạn đề cương môn Kinh tế vĩ mô 15 tuần', S],
  ['Soạn tờ trình xin kinh phí tổ chức hội thảo', S],
  ['Lập kế hoạch tuyển sinh thạc sĩ năm 2027', S],
  ['Soạn giáo án buổi học về thanh toán quốc tế', S],
  ['Tạo 20 câu hỏi trắc nghiệm về marketing quốc tế có đáp án', S],
  ['Soạn đề thi cuối kỳ môn Thương mại điện tử', S],
  ['Viết công văn gửi các khoa về lịch thi', S],
  ['Viết hàm Python đọc file CSV và tính trung bình cột điểm', S],
  ['Câu lệnh SQL lấy 10 sinh viên có điểm cao nhất', S],
  ['Debug đoạn javascript này giúp tôi: const x = [1,2,3].map(i => i*2', S],
  ['Viết công thức Excel tính điểm trung bình có trọng số', S],
  ['Viết macro VBA tự động tô màu ô điểm dưới 5', S],
  ['Thuật toán sắp xếp nhanh hoạt động thế nào? Viết code minh họa', S],
  ['Tóm tắt tài liệu đính kèm', S, { docs: 1, chars: 12_000 }],
  ['Rút ra 5 ý chính của các tệp này', S, { docs: 2, chars: 30_000 }],
  ['Ảnh này là biểu đồ gì?', S, { images: 1 }],
  ['Đọc chữ trong ảnh giúp tôi', S, { images: 1 }],
  ['Soạn bài giảng điện tử chương 3 Kinh tế quốc tế', S],
  ['Viết thuyết minh đề án mở ngành Logistics', S],
  ['Viết hướng dẫn chi tiết quy trình xin giấy xác nhận sinh viên', S],
  ['Soạn quy chế chi tiêu nội bộ cho câu lạc bộ', S],
  ['Viết regex kiểm tra email có đuôi ftu.edu.vn', S],
  ['Tạo pivot từ dữ liệu bảng doanh thu theo quý', S],
  [
    `Hãy góp ý cho đoạn văn sau: ${'Nhà trường cần tăng cường hợp tác doanh nghiệp. '.repeat(40)}`,
    S,
  ],
  ['Soạn kế hoạch giảng dạy học kỳ 2 cho bộ môn', S],
  ['Viết báo cáo khảo sát mức độ hài lòng của sinh viên', S],
  ['Gọi API thời tiết bằng Python thế nào?', S],
  ['Tạo đề cương chi tiết học phần Logistics quốc tế', S],
  ['Lập kế hoạch tổ chức ngày hội việc làm 2026', S],
  // Research and deep analysis → advanced
  ['Phân tích chuyên sâu tác động của CPTPP tới xuất khẩu dệt may Việt Nam', A],
  ['Thiết kế nghiên cứu về hành vi mua sắm trực tuyến của Gen Z', A],
  ['Đề xuất phương pháp nghiên cứu cho luận án về chuỗi giá trị toàn cầu', A],
  ['Xây dựng mô hình hồi quy đánh giá các yếu tố ảnh hưởng FDI', A],
  ['Viết tổng quan tài liệu về logistics xanh', A],
  ['Phản biện bài báo khoa học này về tỷ giá và cán cân thương mại', A],
  ['Đánh giá toàn diện chiến lược quốc tế hóa của trường đại học', A],
  ['Chứng minh lợi thế so sánh vẫn đúng khi có chi phí vận tải', A],
  ['Gợi ý giả thuyết nghiên cứu cho đề tài về thương mại điện tử xuyên biên giới', A],
  ['Ứng dụng kinh tế lượng phân tích dữ liệu bảng xuất khẩu nông sản', A],
  ['Góp ý chương 2 luận văn thạc sĩ về quản trị rủi ro', A],
  ['Đề xuất chính sách thúc đẩy xuất khẩu dịch vụ giáo dục', A],
  ['Xây dựng chiến lược dài hạn phát triển nghiên cứu khoa học của khoa', A],
  ['Lập luận chặt chẽ ủng hộ và phản đối việc tăng học phí', A],
  ['Literature review về fintech và tài chính toàn diện', A],
];

describe('classifyRequest (default rules)', () => {
  it('routes ≥ 85 % of the 100 sample questions to the expected tier', () => {
    expect(SAMPLES).toHaveLength(100);
    const wrong = SAMPLES.filter(([text, tier, extra]) => {
      const got = classifyRequest(DEFAULT_ROUTER_CONFIG, {
        text,
        documentCount: extra?.docs ?? 0,
        imageCount: extra?.images ?? 0,
        attachedChars: extra?.chars ?? 0,
      });
      return got.tier !== tier;
    });
    const accuracy = (SAMPLES.length - wrong.length) / SAMPLES.length;
    expect(accuracy, wrong.map((w) => w[0]).join('\n')).toBeGreaterThanOrEqual(0.85);
  });

  it('explains the decision and ignores case and diacritics', () => {
    const d = classifyRequest(DEFAULT_ROUTER_CONFIG, {
      text: 'VIET HAM PYTHON',
      documentCount: 0,
      imageCount: 0,
      attachedChars: 0,
    });
    expect(d).toEqual({
      tier: 'standard',
      ruleId: 'lap-trinh',
      reason: 'AUTO: luật "Lập trình, dữ liệu" → nhóm Tiêu chuẩn',
    });
    // Whole words only: "rapid" does not contain the keyword "api".
    expect(
      classifyRequest(DEFAULT_ROUTER_CONFIG, {
        text: 'rapid growth',
        documentCount: 0,
        imageCount: 0,
        attachedChars: 0,
      }).ruleId,
    ).toBeNull();
  });

  it('skips disabled rules and uses the default tier', () => {
    const config = {
      ...DEFAULT_ROUTER_CONFIG,
      rules: DEFAULT_ROUTER_CONFIG.rules.map((r) => ({ ...r, enabled: r.id !== 'lap-trinh' })),
    };
    expect(
      classifyRequest(config, {
        text: 'viết code python',
        documentCount: 0,
        imageCount: 0,
        attachedChars: 0,
      }).tier,
    ).toBe('economy');
  });
});

describe('router config', () => {
  it('validates targets and duplicate rule ids', () => {
    expect(routerConfigSchema.safeParse(DEFAULT_ROUTER_CONFIG).success).toBe(true);
    expect(
      routerConfigSchema.safeParse({
        ...DEFAULT_ROUTER_CONFIG,
        targets: { economy: 50, standard: 20, advanced: 5 },
      }).success,
    ).toBe(false);
    const dup = [...DEFAULT_ROUTER_CONFIG.rules, DEFAULT_ROUTER_CONFIG.rules[0]!];
    expect(routerConfigSchema.safeParse({ ...DEFAULT_ROUTER_CONFIG, rules: dup }).success).toBe(
      false,
    );
  });

  it('falls back to the nearest tier, cheaper first', () => {
    expect(tierFallbackOrder('advanced')).toEqual(['advanced', 'standard', 'economy']);
    expect(tierFallbackOrder('standard')).toEqual(['standard', 'economy', 'advanced']);
    expect(tierFallbackOrder('economy')).toEqual(['economy', 'standard', 'advanced']);
  });
});
