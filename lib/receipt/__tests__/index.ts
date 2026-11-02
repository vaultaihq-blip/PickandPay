/**
 * Regression suite for the receipt parsing pipeline.
 *
 * Run with:  npm run test:receipt
 */

import "./money.test";
import "./pipeline.test";
import "./e2e-bridge.test";
import "./printedTotalGap.test";
import "./units.test";
import "./currency.test";
import { run } from "./harness";

run();
