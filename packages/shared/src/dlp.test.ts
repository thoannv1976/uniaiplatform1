import { describe, expect, it } from 'vitest';
import {
  createUnmasker,
  decide,
  DEFAULT_DLP_POLICY,
  DLP_DETECTORS,
  dlpPolicySchema,
  maskText,
  scanText,
  unmaskText,
  type DlpDetector,
  type DlpPolicy,
} from './dlp.js';

/**
 * Spec 13.2 (M15): every detector has ≥ 20 positive and ≥ 20 negative samples; overall
 * accuracy must be ≥ 95 %. Secrets are assembled at runtime so the repository's secret scan
 * does not flag the test file.
 */

/** Deterministic pseudo-random token of the given alphabet. */
function token(len: number, seed: number, alphabet: string): string {
  let x = seed;
  let out = '';
  for (let i = 0; i < len; i++) {
    x = (x * 1103515245 + 12345) % 2147483648;
    out += alphabet[x % alphabet.length];
  }
  return out;
}
const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const UPPER_NUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const t = (len: number, seed: number) => token(len, seed, ALNUM);

const POSITIVE: Record<DlpDetector, string[]> = {
  cccd: [
    'Số CCCD của tôi là 001203004567',
    'CCCD: 079095001234, ngày cấp 12/05/2021',
    'Căn cước công dân 031188009876 cấp tại Hà Nội',
    'Nhờ điền hộ mẫu: họ tên Nguyễn Văn A, 001090012345',
    'Thông tin: 036301005678 – Nam Định',
    'số định danh cá nhân 024199003456',
    'CMND 012345678 cấp năm 2010',
    'Số chứng minh nhân dân: 162345678',
    'cmt 031234567 do công an Hải Phòng cấp',
    'Anh ấy có CCCD 001300123456 và hộ khẩu tại Ba Đình',
    'Hồ sơ: Trần Thị B – 038197004321 – Thanh Hóa',
    'Số căn cước: 999123456789',
    '001085123456 là số giấy tờ tùy thân của ông C',
    'Cho tôi biết người có số 040201002233 sinh năm nào',
    'Mã định danh 001302007788 cần cập nhật',
    'Danh sách: 1) 079192001111 2) 079193002222',
    'Chứng minh thư số 145678901',
    'CCCD:001096011122',
    'Số thẻ căn cước 052300004455 hết hạn chưa?',
    'Người nhận: Lê Văn D, CCCD 060199008877, SĐT 0912345678',
    'Khách: 001190011223 (CCCD)',
  ],
  bank: [
    'Thẻ 4111 1111 1111 1111 hết hạn 12/28',
    'Số thẻ: 5500000000000004',
    'Thanh toán bằng thẻ 4012-8888-8888-1881 được không?',
    'STK 0011004123456 Vietcombank',
    'Số tài khoản: 19034567891011 Techcombank',
    'Chuyển khoản vào tài khoản 123456789 ngân hàng BIDV',
    'tk 0451000123456 tại VCB chi nhánh Thành Công',
    'Account number 9704123456 at ACB',
    'Agribank 1500205123456 – Nguyễn Văn A',
    'Vui lòng chuyển học phí vào STK 2345678901 MB Bank',
    'Tài khoản nhận lương: 0071001234567',
    'Số thẻ ATM 9704 0000 1234 5678 97',
    'Ngân hàng TPBank số tài khoản 03456789012',
    'card 3530111333300000 bị khóa',
    'STK: 107001234567 VietinBank',
    'số tài khoản 060123456789 Sacombank',
    'Thẻ visa 4532015112830 2',
    'Gửi giúp vào tk 19012345678901 nhé',
    'thông tin nhận tiền: VPBank 123456789012',
    'Số thẻ 621254123456789011 của tôi',
    'Hoàn tiền về tài khoản 9876543210',
  ],
  password: [
    'mật khẩu: Abc@12345',
    'Mật khẩu là ftu2026!',
    'password=hunter22',
    'pass: 12345678',
    'mk là ftu@2024',
    'pwd = s3cr3t!',
    'Mat khau: qwerty123',
    'Tài khoản admin, password: P@ssw0rd',
    'đăng nhập bằng user: anhnv, pass: anh123456',
    'MẬT KHẨU: Ftu#2026',
    'Wifi phòng họp mật khẩu: phonghop2026',
    'passwd: rootroot',
    'mk: 88888888',
    'Password: "Tr0ub4dor&3"',
    'mật khẩu = Hanoi@2025',
    'email anh@ftu.edu.vn mật khẩu là Anh_2025',
    'Đây là cấu hình: host=db, pwd=Xyz12345',
    'mật khẩu: abcdefgh',
    'pass = matkhau01',
    'Mật khẩu Wi-Fi: ftuwifi2026',
    'Pwd: Qaz!2wsx',
  ],
  secret: [
    `Key của tôi: sk-proj-${t(48, 1)}`,
    `OPENAI_API_KEY=sk-${t(48, 2)}`,
    `anthropic sk-ant-${t(40, 3)}`,
    `Gemini key AIza${t(35, 4)}`,
    `token github ghp_${t(36, 5)}`,
    `github_pat_${t(22, 6)}_${t(59, 7)}`,
    `slack xoxb-${t(12, 8)}-${t(12, 9)}`,
    `aws AKIA${token(16, 10, UPPER_NUM)}`,
    `Authorization: Bearer ya29.${t(60, 11)}`,
    `-----BEGIN ${'PRIVATE'} KEY-----\n${t(64, 12)}\n-----END ${'PRIVATE'} KEY-----`,
    `-----BEGIN RSA ${'PRIVATE'} KEY-----\n${t(64, 13)}`,
    `secret: ${t(40, 14)}`,
    `client_secret=${t(36, 15)}`,
    `Mã bí mật webhook ${t(44, 16)}`,
    `export TOKEN=${t(64, 17)}`,
    `jwt eyJ${t(30, 18)}.${t(40, 19)}`,
    `api key là ${t(32, 20)}`,
    `Sao key ${'sk-'}${t(30, 21)} không chạy?`,
    `ghs_${t(40, 22)} hết hạn`,
    `key=AIza${t(35, 23)}&q=1`,
    `xoxp-${t(20, 24)}`,
  ],
  student_data: [
    'MSV 11201234, điểm giữa kỳ 8.5, ngày sinh 01/02/2003',
    'Mã sinh viên: 2011150001, họ tên Nguyễn Văn A, SĐT 0912345678',
    'MSSV\tHọ tên\tĐiểm\n11201234\tA\t8\n11201235\tB\t7\n11201236\tC\t9',
    'Mã SV | Họ tên | Ngày sinh\n2111110001 | An | 01/01/2003\n2111110002 | Bình | 02/02/2003\n2111110003 | Chi | 03/03/2003',
    'mssv,ho ten,diem\n11211234,An,8\n11211235,Binh,6\n11211236,Chi,9',
    'Nhận xét học lực sinh viên mã sinh viên 11221234, xếp loại khá',
    'Mã cán bộ 10012345, lương cơ bản 12 triệu',
    'Sinh viên MSV 11191234, quê quán Nam Định, email a@ftu.edu.vn',
    'Mã SV 2214450012 điểm thi 4.0, có bị cảnh báo học vụ không?',
    'Danh sách điểm:\n11201111;Lan;8.5\n11201112;Mai;7.0\n11201113;Hoa;9.0',
    'Mã nhân sự 20230015, địa chỉ 91 Chùa Láng',
    'mã số sinh viên 1911110123 giới tính nữ ngày sinh 2001',
    'msv: 11231234 – sdt 0987654321',
    'Bảng điểm (msv, điểm):\n11200001, 8\n11200002, 7\n11200003, 6\n11200004, 9',
    'MSV 2012340056 xếp loại học lực giỏi',
    'Mã NV 12345678, lương tháng 9',
    'Nhập điểm cho mã sinh viên 11209999: 8.75',
    'MSSV 11205555, CCCD đang chờ cập nhật, email sv@ftu.edu.vn',
    'STT|MSV|Điểm\n1|11201001|7\n2|11201002|8\n3|11201003|9',
    'Mã sinh viên 2213310045, địa chỉ: Đống Đa, Hà Nội',
    'Mã SV 11221111 điểm rèn luyện 85',
  ],
  confidential: [
    'TUYỆT MẬT\nKế hoạch tuyển sinh 2027',
    'Văn bản TỐI MẬT về nhân sự',
    'MẬT\nBáo cáo thanh tra nội bộ',
    'Độ mật: Mật',
    'Độ mật: Tuyệt mật – tóm tắt giúp tôi',
    'Tài liệu lưu hành nội bộ, tóm tắt giúp tôi',
    'LƯU HÀNH NỘI BỘ\nQuy trình chấm thi',
    'Tài liệu này không phổ biến ra ngoài',
    'Không được phổ biến ra bên ngoài – đề thi dự kiến',
    'Dấu TUYỆT MẬT ở góc trên văn bản',
    'Tóm tắt văn bản sau: TỐI MẬT. Nội dung: ...',
    '   MẬT   \nDự thảo đề án',
    'ĐỘ MẬT: MẬT\nSố: 12/BC',
    'Ghi chú: lưu hành nội bộ trong Ban Giám hiệu',
    'Phân loại: TUYỆT MẬT',
    'Bản này Không phổ biến ra ngoài trường',
    'Tài liệu (TỐI MẬT) gửi Hiệu trưởng',
    'MẬT.\nKết luận cuộc họp',
    'Văn bản lưu hành nội bộ số 05/2026',
    'độ mật: tối mật',
    '[TUYỆT MẬT] Danh sách đề cử',
  ],
};

const NEGATIVE: Record<DlpDetector, string[]> = {
  cccd: [
    'Gọi tôi theo số 0912345678',
    'Ngân sách năm nay là 1.200.000.000 đồng',
    'Mã đơn hàng 999123456789 đã giao',
    'Năm 2026 trường tuyển 4000 sinh viên',
    'Số hiệu văn bản 123/QĐ-ĐHNT ngày 15/09/2026',
    'Dân số Việt Nam khoảng 100000000 người',
    'Mã số thuế 0101234567',
    'Mã bài báo DOI 10.1016/j.jbusres.2021.04.012',
    'ISBN 9786043456789',
    'Tôi cần mẫu đơn xin cấp lại CCCD',
    'CCCD gắn chip có thời hạn bao lâu?',
    'Điểm trung bình 8,5 trên thang 10',
    'Hẹn họp lúc 14:30 ngày 02/10/2026',
    'Số 123456789 là số gì trong dãy Fibonacci?',
    'Mã lớp học phần KTE201.1 và KTE201.2',
    'Doanh thu quý 3: 987.654.321.000 đồng',
    'Giải phương trình 3x + 5 = 20',
    'Số hiệu chuyến bay VN123 khởi hành 7h',
    '500 sinh viên đăng ký, 12 lớp, 3 khoa',
    'Đếm từ 1 đến 100 bằng Python',
    'Mã giao dịch 888812345678 hoàn tất', // 888 is not a province code
  ],
  bank: [
    'Cách mở tài khoản ngân hàng cho sinh viên?',
    'Lãi suất tiết kiệm Vietcombank năm nay bao nhiêu?',
    'Gọi 0912345678 để được hỗ trợ',
    'Mã đơn 1234567890123 đã xử lý', // not Luhn, no bank keyword
    'Ngân sách 1.500.000.000 đồng cho đề tài',
    'Năm 2025 có 365 ngày',
    'Tài khoản email của tôi bị khóa',
    'Học phí 15.000.000 đồng mỗi học kỳ',
    'Mã số thuế 0101234567 của công ty',
    'Số lượng 12345 sản phẩm',
    'ISBN 978-604-345-678-9',
    'Giải thích thẻ tín dụng và thẻ ghi nợ khác nhau thế nào',
    'Tỷ giá 25.400 VND/USD',
    'Mã lớp 2111110',
    'Đơn hàng số 4111111111111112 bị lỗi', // fails Luhn
    'Dãy số 1 2 3 4 5 6 7 8 9 10',
    'Phiếu thu số 00012345 ngày 01/10',
    'Hướng dẫn đổi mật khẩu tài khoản ngân hàng điện tử',
    'Ngân hàng Nhà nước điều chỉnh lãi suất điều hành',
    'BIDV tuyển dụng 2026',
    'Số báo danh 12345678 xem điểm ở đâu?',
  ],
  password: [
    'Quên mật khẩu thì làm sao?',
    'Mật khẩu là gì?',
    'Mật khẩu là những ký tự bí mật dùng để xác thực',
    'Đổi mật khẩu định kỳ 90 ngày',
    'Password manager nào tốt?',
    'Sinh viên pass môn cần bao nhiêu điểm?',
    'bypass = true trong cấu hình',
    'Hướng dẫn đặt mật khẩu mạnh',
    'mật khẩu phải có ít nhất 12 ký tự',
    'Chính sách mật khẩu của trường',
    'Tôi đã reset password rồi',
    'compass: hướng bắc',
    'Mật khẩu là chuỗi bí mật',
    'Nhập mật khẩu vào ô bên dưới',
    'passport: hộ chiếu',
    'Làm sao để khôi phục mật khẩu email ftu?',
    'mkdir: tạo thư mục',
    'pass là gì trong tiếng Anh',
    'Mật khẩu mạnh nên có chữ hoa, số và ký tự đặc biệt',
    'Đổi password thế nào?',
    'pwd trong Linux in thư mục hiện tại',
  ],
  secret: [
    'Mã UUID 550e8400-e29b-41d4-a716-446655440000',
    'Commit 9fceb02d0ae598e95dc970b74767f19372d61af8',
    'AbstractSingletonProxyFactoryBean là lớp trong Spring',
    'Xem https://docs.google.com/document/d/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms/edit',
    'Cách tạo API key OpenAI?',
    'sk-learn là thư viện học máy',
    'Từ dài nhất: Supercalifragilisticexpialidocious',
    'Mã hash SHA-256: e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    'Quy trình xoay vòng khóa bí mật mỗi 90 ngày',
    'GitHub token cần quyền repo',
    'AIza là tiền tố khóa của Google',
    'Tên tệp bao_cao_tong_ket_nam_hoc_2025_2026_khoa_kinh_te.docx',
    'Biến môi trường OPENAI_API_KEY lấy từ đâu?',
    'ghp_ là tiền tố gì?',
    'Đường dẫn www.ftu.edu.vn/tin-tuc/thong-bao-tuyen-sinh-dai-hoc-chinh-quy-nam-2026',
    'AKIA là gì trong AWS?',
    'Câu dài: Hôm nay trời đẹp, chúng tôi đi dạo quanh hồ Gươm',
    'Mã lớp KTEE2012026HK1NHOM01',
    'BEGIN và END trong SQL dùng để làm gì?',
    'PRIVATE KEY khác PUBLIC KEY thế nào?',
    'Base64 của "hello" là aGVsbG8=',
  ],
  student_data: [
    'Mã sinh viên gồm mấy chữ số?',
    'Cách tính điểm trung bình tích lũy',
    'Quy chế xếp loại học lực sinh viên',
    'Năm 2026 có 4000 sinh viên nhập học',
    'Bảng điểm:\nToán 8\nVăn 7\nAnh 9',
    'Số 20241234 là số gì?',
    'Mã SV của tôi là gì?',
    'Tổng hợp điểm rèn luyện học kỳ 1',
    'Năm học,Số SV,Tỷ lệ\n2023,4000,95%\n2024,4100,96%\n2025,4200,97%',
    'Viết email nhắc sinh viên nộp bài',
    'Ngân sách 12345678 đồng cho hội thảo', // no label, no personal fields
    'Mẫu phiếu điểm cho học phần Kinh tế vi mô',
    'MSSV là viết tắt của gì?',
    'Danh sách lớp gồm họ tên và mã sinh viên – mẫu Excel trống',
    'Điểm chuẩn năm 2025 là 28,5',
    'Gửi email cho phòng đào tạo về lịch thi',
    'Thời khóa biểu tuần 5',
    'Số hiệu 12345678/QĐ ngày 01/10',
    'Cách tra cứu điểm thi trên cổng thông tin',
    'Lớp có 60 sinh viên, 3 nhóm',
    'Mã số đề tài 10012026 nghiệm thu tháng 12',
  ],
  confidential: [
    'Chính sách bảo mật thông tin',
    'CHÍNH SÁCH BẢO MẬT',
    'Đây là BÍ MẬT của tôi',
    'Mật ong có tốt cho sức khỏe không?',
    'Mật độ dân số Hà Nội',
    'Đổi mật khẩu thế nào?',
    'Thông tin nội bộ khoa',
    'Phổ biến kiến thức pháp luật cho sinh viên',
    'Hội nghị bảo mật dữ liệu',
    'Mật mã học là gì?',
    'Giải thích khái niệm thông tin mật',
    'Quy định về bảo vệ bí mật nhà nước',
    'Nhà mật thám',
    'Họp kín, chưa công bố',
    'Mật thư trò chơi trại hè',
    'Kế hoạch phổ biến rộng rãi tới sinh viên',
    'BẢO MẬT VÀ AN TOÀN THÔNG TIN',
    'Thông tin này đã được công bố',
    'Mật khẩu: không có trong câu này',
    'Thân mật gửi các bạn',
    'Báo cáo tình hình mật độ giao thông',
  ],
};

const has = (text: string, d: DlpDetector) => scanText(text).some((f) => f.detector === d);

describe('DLP detectors', () => {
  it('have ≥ 20 positive and ≥ 20 negative samples each', () => {
    for (const d of DLP_DETECTORS) {
      expect(POSITIVE[d].length, d).toBeGreaterThanOrEqual(20);
      expect(NEGATIVE[d].length, d).toBeGreaterThanOrEqual(20);
    }
  });

  it('classify ≥ 95 % of the samples correctly (per detector and overall)', () => {
    let right = 0;
    let total = 0;
    const wrong: string[] = [];
    for (const d of DLP_DETECTORS) {
      let ok = 0;
      for (const s of POSITIVE[d]) {
        if (has(s, d)) ok++;
        else wrong.push(`${d} missed: ${s}`);
      }
      for (const s of NEGATIVE[d]) {
        if (!has(s, d)) ok++;
        else wrong.push(`${d} false alarm: ${s}`);
      }
      const n = POSITIVE[d].length + NEGATIVE[d].length;
      expect(ok / n, `${d}\n${wrong.join('\n')}`).toBeGreaterThanOrEqual(0.95);
      right += ok;
      total += n;
    }
    expect(right / total, wrong.join('\n')).toBeGreaterThanOrEqual(0.95);
  });
});

describe('DLP policy', () => {
  const staff = { role: 'user' as const, departmentPath: ['ftu', 'khoa-kt'] };

  it('takes the strictest action among the findings', () => {
    const findings = scanText('CCCD 001203004567, mật khẩu: Abc@12345');
    const d = decide(findings, DEFAULT_DLP_POLICY, staff);
    expect(d.action).toBe('block');
    expect(d.counts).toEqual({ cccd: 1, password: 1 });
    expect(d.byAction).toEqual({ mask: ['cccd'], block: ['password'] });
    expect(decide([], DEFAULT_DLP_POLICY, staff).action).toBe('allow');
  });

  it('applies the first matching override by unit and role', () => {
    const policy: DlpPolicy = dlpPolicySchema.parse({
      defaults: DEFAULT_DLP_POLICY.defaults,
      overrides: [
        { detector: 'student_data', action: 'allow', departmentIds: ['p-dt'], roles: [], note: '' },
        { detector: 'cccd', action: 'block', departmentIds: [], roles: ['user'], note: 'Thử' },
      ],
    });
    const msv = scanText('MSV 11201234, điểm giữa kỳ 8.5');
    expect(decide(msv, policy, staff).action).toBe('warn');
    expect(decide(msv, policy, { role: 'user', departmentPath: ['ftu', 'p-dt'] }).action).toBe(
      'allow',
    );
    const id = scanText('CCCD 001203004567');
    expect(decide(id, policy, staff).action).toBe('block');
    expect(decide(id, policy, { role: 'unit_admin', departmentPath: [] }).action).toBe('mask');
  });

  it('masks with stable placeholders and restores them', () => {
    const text = 'CCCD 001203004567 và STK 0011004123456 Vietcombank; nhắc lại 001203004567';
    const mapping = new Map<string, string>();
    const masked = maskText(text, scanText(text), ['cccd', 'bank'], mapping);
    expect(masked).toBe('CCCD [CCCD_1] và STK [STK_1] Vietcombank; nhắc lại [CCCD_1]');
    const next = 'CCCD 079095001234';
    expect(maskText(next, scanText(next), ['cccd'], mapping)).toBe('CCCD [CCCD_2]');
    expect(unmaskText('Số [CCCD_1] và [STK_1], [CCCD_2]', mapping)).toBe(
      'Số 001203004567 và 0011004123456, 079095001234',
    );
    // Detectors not listed stay as they are.
    expect(maskText(text, scanText(text), ['bank'])).toContain('001203004567');
  });

  it('restores placeholders split across streamed chunks', () => {
    const mapping = new Map([['[CCCD_1]', '001203004567']]);
    const u = createUnmasker(mapping);
    const chunks = ['Số của bạn là [CC', 'CD_', '1]. Mảng a', '[0] và [', 'chú thích'];
    const out = chunks.map((c) => u.push(c)).join('') + u.flush();
    expect(out).toBe('Số của bạn là 001203004567. Mảng a[0] và [chú thích');
    expect(createUnmasker(new Map()).push('[CCCD_1')).toBe('[CCCD_1');
  });

  it('rejects unknown actions and detectors', () => {
    expect(dlpPolicySchema.safeParse({ ...DEFAULT_DLP_POLICY, extra: 1 }).success).toBe(false);
    expect(
      dlpPolicySchema.safeParse({
        defaults: { ...DEFAULT_DLP_POLICY.defaults, cccd: 'drop' },
        overrides: [],
      }).success,
    ).toBe(false);
  });
});
