# Manual QA Checklist

## Local App

1. Run `npm run build`.
2. Run `npm run dev`.
3. Open `http://127.0.0.1:5173`.
4. Verify the landing screen shows "Send files" and "Receive files".
5. Click "Send files" and select a file smaller than 1 GB.
6. Confirm the transfer monitor shows 2 active lanes.
7. Select a file larger than 1 GB when available.
8. Confirm the transfer monitor shows 8 active lanes.
9. Click "Receive files".
10. Confirm the pairing code input is visible.

## Cloudflare Worker

1. Run `npm run test:worker`.
2. Confirm room creation returns status 201.
3. Confirm unknown API routes return status 404.
4. Confirm relay request guard tests pass.

## Recovery Behavior

1. In unit tests, verify IndexedDB progress can be saved and loaded.
2. In unit tests, verify missing chunk bitmaps identify incomplete chunks.
3. In unit tests, verify the scheduler retries a temporary chunk failure.
