import { expect, test } from '@playwright/test';

test('trang chủ hiển thị trạng thái API và nút đăng nhập Google', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'University AI Platform' })).toBeVisible();
  await expect(page.getByRole('status')).toHaveText(/Máy chủ hoạt động bình thường.*phiên bản e2e/);
  await expect(page.getByRole('button', { name: 'Đăng nhập bằng Google' })).toBeVisible();
  await expect(page.getByText('@ftu.edu.vn')).toBeVisible();
});
