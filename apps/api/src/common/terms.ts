import { ForbiddenException } from '@nestjs/common';
import { TERMS_VERSION, type UserProfile } from '@uniai/shared';

/** AI features need the current terms of use accepted (spec 12). */
export function requireTerms(profile: UserProfile): void {
  if (profile.termsVersion !== TERMS_VERSION) {
    throw new ForbiddenException(
      'Bạn cần đọc và đồng ý Điều khoản sử dụng trước khi dùng AI. Hãy tải lại trang.',
    );
  }
}
