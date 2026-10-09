import { randomUUID } from "node:crypto";
import { createRail, loadEnv } from "../src/config";
import { usd } from "../src/money";
import { RailError, sumByStatus } from "../src/rail/rail";

/**
 * Proves the sandbox keys and test card work end to end: take a $1.00 test
 * payment, refund $0.40 of it, send the same refund request again to confirm
 * PayPal does not refund twice, and read the result back from PayPal.
 */
async function main(): Promise<void> {
  loadEnv();
  const rail = createRail("paypal");

  console.log("1. Taking a $1.00 test payment...");
  const charge = await rail.charge({ amountCents: 100, description: "Crashtest setup check", reference: "crashtest-setup-check" });
  console.log(`   OK   order ${charge.orderId}, capture ${charge.captureId}`);

  console.log("2. Refunding $0.40...");
  const request = { captureId: charge.captureId, amountCents: 40, note: "Crashtest setup check", idempotencyKey: randomUUID() };
  const refund = await rail.refund(request);
  console.log(`   OK   refund ${refund.refundId} (${refund.status})`);

  console.log("3. Sending the same request again, with the same key...");
  const again = await rail.refund(request);
  if (again.refundId !== refund.refundId) {
    throw new Error(`PayPal created a second refund (${again.refundId}) for a repeated request. Duplicate protection is not working.`);
  }
  console.log("   OK   PayPal returned the original refund, not a new one");

  console.log("4. Reading the refunds back from PayPal...");
  const records = await rail.refunds(charge.orderId);
  const completed = sumByStatus(records, "COMPLETED");
  const pending = sumByStatus(records, "PENDING");
  for (const record of records) console.log(`        ${record.refundId}  ${usd(record.amountCents)}  ${record.status}`);
  if (records.length !== 1 || completed + pending !== 40) {
    throw new Error(`Expected exactly one refund of $0.40 on the order; PayPal reports ${records.length} totalling ${usd(completed + pending)}.`);
  }
  if (pending > 0) {
    console.log("   NOTE the refund is still PENDING. Crashtest counts only COMPLETED refunds as money moved,");
    console.log("        so runs on this account may show refunds as unresolved until PayPal settles them.");
  } else {
    console.log("   OK   PayPal reports one COMPLETED refund of $0.40");
  }
  console.log("\nSetup check passed. You can now run: npm run crashtest -- --profile sandbox");
}

main().catch((error: unknown) => {
  console.error(`\nSetup check FAILED: ${error instanceof Error ? error.message : String(error)}`);
  if (error instanceof RailError && error.body !== undefined) {
    console.error("PayPal said:", JSON.stringify(error.body, null, 2));
  }
  process.exitCode = 1;
});
