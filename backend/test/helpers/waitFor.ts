export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function waitFor(
  check: () => Promise<boolean>,
  timeoutMs = 10_000,
  intervalMs = 50,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(intervalMs);
  }
  throw new Error('waitFor timed out');
}