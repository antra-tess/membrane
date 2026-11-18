/** Allow slow or CPU-quota CI runners to budget more time for real subprocesses. */
const scale = Number(process.env.MEMBRANE_TEST_WATCHDOG_SCALE ?? 1);
if (!Number.isFinite(scale) || scale < 1 || scale > 100) {
  throw new Error('MEMBRANE_TEST_WATCHDOG_SCALE must be a number between 1 and 100');
}

export const watchdogMs = (milliseconds: number) => Math.ceil(milliseconds * scale);
