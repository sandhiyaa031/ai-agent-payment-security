import { createRail, loadEnv } from "../src/config";
import { usd } from "../src/money";
import { RailError } from "../src/rail/rail";

/**
 * Proves the sandbox keys and test card work end to end: take a $1.00 test
 * payment, refund $0.40 of it, and read the refund back from PayPal.
 */
async function main(): Promise<void> {
  loadEnv();
  const rail = createRail("paypal");

  console.log("1. Taking a $1.00 test payment...");
  const charge = await rail.charge({ amountCents: 100, description: "Crashtest setup check", reference: "crashtest-setup-check" });
  console.log(`   OK   order ${charge.orderId}, capture ${charge.captureId}`);

  console.log("2. Refunding $0.40...");
  const refund = await rail.refund({ captureId: charge.captureId, amountCents: 40, note: "Crashtest setup check" });
  console.log(`   OK   refund ${refund.refundId} (${refund.status})`);

  console.log("3. Reading the refund back from PayPal...");
  const refunded = await rail.refundedCents(charge.orderId);
  if (refunded !== 40) {
    throw new Error(`PayPal reports ${usd(refunded)} refunded on the order; expected $0.40.`);
  }
  console.log("   OK   PayPal reports $0.40 refunded");
  console.log("\nSetup check passed. You can now run: npm run crashtest -- --rail paypal");
}

main().catch((error: unknown) => {
  console.error(`\nSetup check FAILED: ${error instanceof Error ? error.message : String(error)}`);
  if (error instanceof RailError && error.body !== undefined) {
    console.error("PayPal said:", JSON.stringify(error.body, null, 2));
  }
  process.exitCode = 1;
});
