import { expect, test } from '@playwright/test';
import { E2E_USER } from './e2e-user';

// Plan M6: sign in (emulator) → chat → streamed answer → cost shown; M8: my usage; M9: attachment; M10: terms.
test.skip(!process.env.FIRESTORE_EMULATOR_HOST, 'cần Firebase Emulator (pnpm test:e2e)');

test('đăng nhập, chat với AUTO, nhận câu trả lời dạng stream và thấy chi phí', async ({ page }) => {
  await page.goto('/');
  await page.getByText('Tài khoản quản trị dự phòng (email và mật khẩu)').click();
  await page.getByLabel('Email').fill(E2E_USER.email);
  await page.getByLabel('Mật khẩu').fill(E2E_USER.password);
  await page.getByRole('button', { name: 'Đăng nhập', exact: true }).click();

  // M10: terms of use at first sign-in.
  await page.getByLabel('Tôi đã đọc và đồng ý với Điều khoản sử dụng.').check();
  await page.getByRole('button', { name: 'Đồng ý và tiếp tục' }).click();

  await expect(page.getByText('Bạn cần hỗ trợ gì hôm nay?')).toBeVisible();
  const box = page.getByLabel('Tin nhắn');
  await box.fill('Xin chào từ kiểm thử e2e');
  await box.press('Enter');

  await expect(page.getByText('[mock:mock-economy] Xin chào từ kiểm thử e2e')).toBeVisible();
  await expect(page.getByText(/^Chi phí /)).toBeVisible();
  await expect(page.locator('article').getByText('Mock Economy', { exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\/hoi-thoai\/[A-Za-z0-9]+$/);

  const sidebar = page.getByRole('complementary', { name: 'Danh sách hội thoại' });
  await expect(sidebar.getByText('Xin chào từ kiểm thử e2e')).toBeVisible();

  // Reloading shows the stored conversation.
  await page.reload();
  await expect(page.getByText('[mock:mock-economy] Xin chào từ kiểm thử e2e')).toBeVisible();

  // M9: attach a document; its text reaches the model (the mock echoes it back).
  await page.getByLabel('Chọn tệp đính kèm').setInputFiles({
    name: 'ghi-chu.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('Lịch thi học kỳ: 15/12'),
  });
  await expect(page.getByText(/ghi-chu\.txt · \d+ B$/)).toBeVisible();
  await box.fill('Tệp nói gì?');
  await box.press('Enter');
  await expect(page.getByRole('list', { name: 'Tệp đính kèm' })).toContainText('ghi-chu.txt');
  await expect(page.getByText(/Lịch thi học kỳ: 15\/12/).last()).toBeVisible();

  // M8: personal usage comes straight from the ledger.
  await page.getByRole('link', { name: 'Mức sử dụng' }).click();
  await expect(page.getByRole('heading', { name: 'Mức sử dụng của tôi' })).toBeVisible();
  await expect(page.getByText('Mock Economy')).toBeVisible();
});
