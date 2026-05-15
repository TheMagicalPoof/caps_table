import { expect, test } from '@playwright/test';

test('renders caps table canvas from local caps data', async ({ page }) => {
	await page.goto('/');
	await expect(page.getByTestId('caps-canvas')).toBeVisible();
	await expect(page.getByTestId('table-width')).toHaveValue('600');

	await expect
		.poll(async () => {
			return page.getByTestId('caps-canvas').evaluate((canvas: HTMLCanvasElement) => {
				const ctx = canvas.getContext('2d');
				if (!ctx || canvas.width === 0 || canvas.height === 0) return false;

				const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
				for (let i = 3; i < data.length; i += 4) {
					if (data[i] !== 0) return true;
				}
				return false;
			});
		})
		.toBe(true);

	await page.getByTestId('table-width').fill('300');
	await page.getByTestId('rotate').click();
});
