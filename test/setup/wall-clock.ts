import { afterEach, beforeAll, beforeEach } from "vitest";

/**
 * Report a system clock that moved during a test file, instead of letting it
 * masquerade as a slow test.
 *
 * Inside workerd `performance.now()` is `Date.now()` with a time origin of
 * zero: there is no monotonic clock. Vitest measures a test by subtracting two
 * readings and fails it as "Test timed out in 5000ms" when the difference
 * reaches `testTimeout`, whether or not its own timer ever fired. So a system
 * clock stepped forward while a millisecond test awaits a Durable Object turns
 * that test into a timeout, and the matching step back gives the next test a
 * negative duration. On WSL2 the Hyper-V time service does exactly this, tens
 * of seconds at a time, and which test it lands on is chance: the whole-suite
 * run then fails a different file each pass while its real wall time stays a
 * few seconds.
 *
 * A step cannot be prevented from in here, and a forward step inside one test
 * cannot be told apart from a genuine stall. What can be told apart is a clock
 * that runs backwards, or one that jumps between two tests where the runner
 * does milliseconds of bookkeeping. Each is failed as its own case, naming the
 * size of the step, so a run that was hit reads as "the clock moved" rather
 * than as an arbitrary test being slow, and a green run whose clock stepped
 * back — which could have hidden a real stall — is not trusted either.
 */

/**
 * The longest gap the runner is allowed between one test ending and the next
 * starting in the same file. Only the pool's storage reset and Vitest's own
 * bookkeeping run there, which take milliseconds; the budget matches the test
 * timeout so that a jump big enough to fake a timeout is exactly what is caught.
 */
const MAX_GAP_BETWEEN_TESTS_MS = 5_000;

class WallClockStepError extends Error {
  override name = "WallClockStepError";

  constructor(step: string, where: string) {
    super(
      `The system clock ${step} ${where}. Inside workerd performance.now() is ` +
        "Date.now(), so Vitest times every test against the system clock and a " +
        'step of this size turns a millisecond test into "Test timed out in ' +
        '5000ms". A timeout reported elsewhere in this run is the other half of ' +
        "the same step, not a slow test: check the machine's time synchronisation " +
        "(on WSL2, Hyper-V TimeSync steps the guest clock) and rerun.",
    );
  }
}

let testStartedAt: number | undefined;
let previousTestEndedAt: number | undefined;

/** A file starts fresh: loading the next file legitimately takes longer than any gap inside one. */
beforeAll(() => {
  previousTestEndedAt = undefined;
});

beforeEach(({ task }) => {
  testStartedAt = Date.now();
  if (previousTestEndedAt === undefined) return;

  const gap = testStartedAt - previousTestEndedAt;
  if (gap < 0) {
    throw new WallClockStepError(`ran backwards by ${-gap} ms`, `before "${task.name}" started`);
  }
  if (gap >= MAX_GAP_BETWEEN_TESTS_MS) {
    throw new WallClockStepError(`jumped forward by ${gap} ms`, `before "${task.name}" started`);
  }
});

afterEach(({ task }) => {
  const endedAt = Date.now();
  previousTestEndedAt = endedAt;
  if (testStartedAt === undefined) return;

  const elapsed = endedAt - testStartedAt;
  testStartedAt = undefined;
  if (elapsed < 0) {
    throw new WallClockStepError(`ran backwards by ${-elapsed} ms`, `during "${task.name}"`);
  }
});
