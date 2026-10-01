/**
 * Deletes every document in a Firestore emulator database. Refuses to run against a real
 * project (FIRESTORE_EMULATOR_HOST must be set).
 */
export async function clearFirestoreEmulator(
  projectId = process.env.GCLOUD_PROJECT ?? 'demo-uniai',
) {
  const host = process.env.FIRESTORE_EMULATOR_HOST;
  if (!host) throw new Error('clearFirestoreEmulator chỉ dùng với Firestore emulator');
  const res = await fetch(
    `http://${host}/emulator/v1/projects/${projectId}/databases/(default)/documents`,
    { method: 'DELETE' },
  );
  if (!res.ok) throw new Error(`Xóa dữ liệu emulator thất bại: ${res.status}`);
}
