// app/api/cron/refill-audit/route.ts
//
// Daily refill audit (compound refills denied as "too soon").
//
// SETUP IN LOOKER (once): save a Look filtered to
//     Is Compound = Yes, Status = denied, Date = yesterday
// and put its ID in LOOKER_LOOK_ID. This route runs that Look, checks each
// denial against the refill-window policy, and writes flagged rows plus a
// DRAFT email to a sheet tab. It never emails providers and never issues
// strikes: a person reviews the tab first.
//
// The FIELDS mapping below uses PLACEHOLDER Looker field names. Replace them
// with the real ones from your Look.

import { formatInTimeZone } from "date-fns-tz";
import { writeTab } from "@/lib/sheets";

export const maxDuration = 120;
export const dynamic = "force-dynamic";

const TZ = process.env.BUSINESS_TIMEZONE ?? "America/New_York";

// Looker field names (view.field). EDIT THESE.
const FIELDS = {
  requestId: "refill_requests.id",
  requestedAt: "refill_requests.created_date", // when the patient asked
  supplyEndDate: "refill_requests.supply_end_date", // when the patient needs the refill
  supplyMonths: "refill_requests.supply_months", // 3, 6 or 12
  denialReason: "refill_requests.denial_reason",
  providerName: "clinician.full_name",
  providerEmail: "clinician.email",
};

// Refill timing guidelines from the SOP: months of supply -> allowed days early
const WINDOW_DAYS: Record<number, number> = { 3: 45, 6: 90, 12: 120 };

const DAY_MS = 24 * 3600 * 1000;

async function lookerToken() {
  const res = await fetch(`${process.env.LOOKER_BASE_URL}/api/4.0/login`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.LOOKER_CLIENT_ID!,
      client_secret: process.env.LOOKER_CLIENT_SECRET!,
    }),
  });
  if (!res.ok) throw new Error(`Looker login failed: ${res.status}`);
  return (await res.json()).access_token as string;
}

async function runLook(token: string) {
  const res = await fetch(
    `${process.env.LOOKER_BASE_URL}/api/4.0/looks/${process.env.LOOKER_LOOK_ID}/run/json`,
    { headers: { Authorization: `token ${token}` } },
  );
  if (!res.ok) throw new Error(`Looker run_look failed: ${res.status}`);
  return (await res.json()) as Record<string, any>[];
}

function draftEmail(providerName: string) {
  return `Hi ${providerName},

I'm reaching out regarding a recent medication refill request that was denied with the reason "too soon for refill." After review, the request appears to have been submitted within the allowable refill window, which means it should have been approved under our refill policy.

For reference, the approved refill request windows are:
3-month supply: Refill allowed within 45 days of need
6-month supply: Refill allowed within 90 days of need
12-month supply: Refill allowed within 120 days of need

These windows are designed to ensure continuity of care and prevent treatment interruptions for patients who proactively request refills before running out of medication.

Because the request fell within the permitted timeframe but was still denied, this instance is considered non-adherence to the refill policy. Therefore, a strike was issued on your behalf.

Going forward, please ensure refill requests are evaluated against the allowable window guidelines above before issuing a denial. If there are clinical concerns or questions about a request, those should be documented accordingly rather than using "too soon for refill" when the request is within policy.

If you have any questions about the refill window guidelines, please let us know.

Thank you.`;
}

export async function GET(req: Request) {
  if (
    req.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`
  ) {
    return new Response("Unauthorized", { status: 401 });
  }

  const token = await lookerToken();
  const denials = await runLook(token);

  const flagged: Record<string, any>[] = [];
  const needsManualReview: Record<string, any>[] = [];

  for (const d of denials) {
    const reason = String(d[FIELDS.denialReason] ?? "");
    if (!/too\s*soon/i.test(reason)) continue; // other denial reasons: not auditable by this rule

    const months = Number(d[FIELDS.supplyMonths]);
    const windowDays = WINDOW_DAYS[months];
    const requestedAt = Date.parse(d[FIELDS.requestedAt]);
    const supplyEnd = Date.parse(d[FIELDS.supplyEndDate]);

    // Missing data: do not guess, send to a human
    if (!windowDays || Number.isNaN(requestedAt) || Number.isNaN(supplyEnd)) {
      needsManualReview.push(d);
      continue;
    }

    // Positive = requested before the need date. Within window if <= windowDays.
    const daysEarly = Math.round((supplyEnd - requestedAt) / DAY_MS);
    if (daysEarly <= windowDays) {
      flagged.push({ ...d, daysEarly, windowDays });
    }
  }

  const auditDate = formatInTimeZone(new Date(), TZ, "yyyy-MM-dd");
  const header = [
    "Request ID",
    "Provider",
    "Provider Email",
    "Supply (months)",
    "Allowed window (days)",
    "Days early",
    "Denial reason",
    "Result",
    "Draft email (review before sending)",
  ];
  const values = [
    header,
    ...flagged.map((f) => [
      f[FIELDS.requestId],
      f[FIELDS.providerName],
      f[FIELDS.providerEmail],
      f[FIELDS.supplyMonths],
      f.windowDays,
      f.daysEarly,
      f[FIELDS.denialReason],
      "INVALID DENIAL - within window",
      draftEmail(f[FIELDS.providerName]),
    ]),
    ...needsManualReview.map((d) => [
      d[FIELDS.requestId],
      d[FIELDS.providerName],
      d[FIELDS.providerEmail],
      d[FIELDS.supplyMonths],
      "",
      "",
      d[FIELDS.denialReason],
      "MANUAL REVIEW - missing data",
      "",
    ]),
  ];

  if (process.env.GOOGLE_SHEET_ID) {
    await writeTab(
      process.env.GOOGLE_SHEET_ID,
      `Refill audit ${auditDate}`,
      values,
    );
  }

  return Response.json({
    auditDate,
    denialsInLook: denials.length,
    flagged: flagged.length,
    needsManualReview: needsManualReview.length,
  });
}
