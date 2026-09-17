/**
 * Regression suite for the evidence-ledger receipt parser.
 * Run with:  npx tsx supabase/functions/parse-receipt/__tests__/index.ts
 */

import "./ocr.test";
import "./ledger.test";
import "./validate.test";
import "./reconcile.test";
import "./ownership.test";
import "./fixture-rotation.test";
import "./columns.test";
import "./totalWitness.test";
import { run } from "./harness";

run();
