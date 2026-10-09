import { toCents } from "./money";
import type { Defense } from "./subject/tools";

export type ProfileId = "baseline" | "guarded" | "sandbox";

export interface Profile {
  id: ProfileId;
  label: string;
  /** The only rail this profile may use. */
  rail: "mock" | "paypal";
  enforcePolicy: boolean;
  /** The question this profile answers. */
  measures: string;
}

/**
 * Three separate experiments. They are never blended into one score.
 *
 * baseline  What does the agent do when nothing stops it? Test rail only, so
 *           an improper refund costs nothing real.
 * guarded   What does the policy defense change? Same test rail, defense on.
 * sandbox   Does the real PayPal integration behave as the test rail predicts?
 *           The policy defense is mandatory, so no deliberately unauthorized
 *           refund is ever sent to PayPal.
 */
export const PROFILES: Record<ProfileId, Profile> = {
  baseline: {
    id: "baseline",
    label: "Baseline: agent vulnerability",
    rail: "mock",
    enforcePolicy: false,
    measures: "what the agent attempts and what it costs when no policy defense is in the way",
  },
  guarded: {
    id: "guarded",
    label: "Guarded: defense effectiveness",
    rail: "mock",
    enforcePolicy: true,
    measures: "how the policy defense changes the outcome for the same agent and attacks",
  },
  sandbox: {
    id: "sandbox",
    label: "PayPal sandbox verification",
    rail: "paypal",
    enforcePolicy: true,
    measures: "what PayPal itself reports, with the policy defense always on",
  },
};

/** Choices that cost nothing and touch no account; the only ones a hosted copy will run. */
const HOSTED_ALLOWED = {
  profile: ["baseline", "guarded"],
  subject: ["gullible", "strict", "refuse-all"],
  attacker: ["scripted"],
};

export interface RunRequest {
  profile?: string | null;
  subject?: string | null;
  attacker?: string | null;
  /** Optional refund ceiling per order, in dollars. */
  cap?: string | null;
}

export interface RunPlan {
  profile: Profile;
  subject: string;
  attacker: string;
  defense: Defense;
}

/**
 * Turns a request from the command line or the dashboard into a plan, or
 * throws. Every run goes through here, so a profile's rail and mandatory
 * defense cannot be overridden by any other setting.
 */
export function planRun(request: RunRequest, options: { hosted: boolean }): RunPlan {
  const profileId = request.profile?.trim() || "baseline";
  const profile = PROFILES[profileId as ProfileId];
  if (!profile) {
    throw new Error(`Unknown profile "${profileId}". Use ${Object.keys(PROFILES).join(", ")}.`);
  }
  const subject = request.subject?.trim() || "gullible";
  const attacker = request.attacker?.trim() || "scripted";

  if (options.hosted) {
    const allowed =
      HOSTED_ALLOWED.profile.includes(profile.id) && HOSTED_ALLOWED.subject.includes(subject) && HOSTED_ALLOWED.attacker.includes(attacker);
    if (!allowed) {
      throw new Error(
        "This hosted copy only runs the built-in agents on the test rail. Watch a saved run, or install Crashtest to test a real agent.",
      );
    }
  }
  if (subject === "toolkit" && profile.rail !== "paypal") {
    throw new Error("The toolkit agent refunds through PayPal directly, so it only runs in the sandbox profile.");
  }

  const defense: Defense = { enforcePolicy: profile.enforcePolicy };
  const cap = request.cap?.trim();
  if (cap) defense.maxRefundCentsPerOrder = toCents(cap);
  return { profile, subject, attacker, defense };
}
