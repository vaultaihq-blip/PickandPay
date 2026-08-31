/**
 * Zero-dependency test harness.
 *
 * The project has no test framework installed and adding one is a
 * package.json decision for the maintainer, so this harness keeps the
 * regression suite runnable today without changing runtime dependencies.
 */

interface TestCase {
  name: string;
  fn: () => void;
}

const suites: Array<{ name: string; tests: TestCase[] }> = [];
let current: { name: string; tests: TestCase[] } | null = null;

export function describe(name: string, fn: () => void): void {
  current = { name, tests: [] };
  suites.push(current);
  fn();
  current = null;
}

export function it(name: string, fn: () => void): void {
  if (current === null) {
    throw new Error(`it("${name}") called outside of describe()`);
  }
  current.tests.push({ name, fn });
}

export class AssertionError extends Error {}

export function assert(condition: boolean, message: string): void {
  if (!condition) throw new AssertionError(message);
}

export function assertEqual<T>(actual: T, expected: T, message?: string): void {
  if (!Object.is(actual, expected)) {
    throw new AssertionError(
      `${message ?? "values differ"}\n  expected: ${String(expected)}\n  actual:   ${String(actual)}`
    );
  }
}

export function assertDeepEqual(
  actual: unknown,
  expected: unknown,
  message?: string
): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) {
    throw new AssertionError(
      `${message ?? "objects differ"}\n  expected: ${b}\n  actual:   ${a}`
    );
  }
}

export function assertThrows(fn: () => unknown, message?: string): void {
  let threw = false;
  try {
    fn();
  } catch {
    threw = true;
  }
  if (!threw) {
    throw new AssertionError(message ?? "expected function to throw");
  }
}

export function run(): void {
  let passed = 0;
  const failures: Array<{ suite: string; test: string; error: unknown }> = [];

  for (const suite of suites) {
    for (const test of suite.tests) {
      try {
        test.fn();
        passed += 1;
      } catch (error) {
        failures.push({ suite: suite.name, test: test.name, error });
      }
    }
  }

  for (const suite of suites) {
    const suiteFailures = failures.filter((f) => f.suite === suite.name);
    const mark = suiteFailures.length === 0 ? "PASS" : "FAIL";
    console.log(`${mark}  ${suite.name}  (${suite.tests.length} tests)`);
    for (const failure of suiteFailures) {
      console.log(`      x ${failure.test}`);
      const detail =
        failure.error instanceof Error
          ? failure.error.message
          : String(failure.error);
      for (const line of detail.split("\n")) {
        console.log(`        ${line}`);
      }
    }
  }

  const total = passed + failures.length;
  console.log("");
  console.log(`${passed}/${total} tests passed`);

  if (failures.length > 0) {
    process.exitCode = 1;
  }
}
