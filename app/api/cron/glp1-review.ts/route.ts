// app/api/cron/glp1-review/route.ts
//
// Daily review of Weight Loss Injectable prescription requests.
//   1. Pull yesterday's requests (12:00 AM - 11:59 PM, business timezone)
//   2. Apply the SOP filters
//   3. Flag patients with NO semaglutide/tirzepatide invoice in the last 7 days
//   4. Write everything to a tab named for the pulled date in the Google Sheet
//   5. (Optional, off by default) call an internal endpoint to send flagged
//      tasks back to the Provider Queue
//
// Safe by default: DRY_RUN is ON unless the env var DRY_RUN is exactly "false".
// Manual backfill: GET /api/cron/glp1-review?date=YYYY-MM-DD (needs the secret)

import { createClient } from "@supabase/supabase-js";
import { formatInTimeZone, fromZonedTime } from "date-fns-tz";
import { writeTab } from "@/lib/sheets";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

// ---------- Config ----------
const TZ = process.env.BUSINESS_TIMEZONE ?? "America/New_York";
const WL_INJECTABLE_TYPE = "WEIGHT_LOSS_GLP1 (INJECTABLE)";
const INVOICE_WINDOW_DAYS = 7;
const PAGE = 1000;

// Statuses to KEEP, normalized (uppercase, spaces/hyphens -> "_").
// Override with env KEEP_STATUSES="REJECTED,REQUESTED_FORWARDED,..." once the
// SOP conflict about APPROVED / CANCELED is resolved.
const KEEP_STATUSES = new Set(
  (
    process.env.KEEP_STATUSES ??
    "REJECTED,REQUESTED_FORWARDED,PENDING_MEDICAL_INFORMATION"
  )
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean),
);

const INJECTABLE = /(semaglutide|tirzepatide)/i;
const NAME_BRANDS = /(zepbound|wegovy|saxenda|ozempic|mounjaro|victoza)/i;

const SOP_NOTE =
  "Provider support has been reviewed and the patient appears to be eligible and ready for GLP-1. Please write and send an order.";

// ---------- Helpers ----------
const norm = (s?: string | null) =>
  (s ?? "").toUpperCase().replace(/[\s-]+/g, "_");

const chunk = <T>(arr: T[], n: number): T[][] =>
  Array.from({ length: Math.ceil(arr.length / n) }, (_, i) =>
    arr.slice(i * n, (i + 1) * n),
  );

function addDays(ymd: string, n: number) {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const et = (iso?: string | null) =>
  iso ? formatInTimeZone(iso, TZ, "MM/dd/yyyy hh:mm a") : "";

// ---------- Route ----------
export async function GET(req: Request) {
  if (
    req.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`
  ) {
    return new Response("Unauthorized", { status: 401 });
  }

  const url = new URL(req.url);
  const dateParam = url.searchParams.get("date");
  if (dateParam && !/^\d{4}-\d{2}-\d{2}$/.test(dateParam)) {
    return new Response("date must be YYYY-MM-DD", { status: 400 });
  }

  const dryRun = process.env.DRY_RUN !== "false";
  const supabase = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );

  // Window: target day 00:00:00 to next day 00:00:00 in business timezone
  const todayLocal = formatInTimeZone(new Date(), TZ, "yyyy-MM-dd");
  const target = dateParam ?? addDays(todayLocal, -1);
  const start = fromZonedTime(`${target}T00:00:00`, TZ).toISOString();
  const end = fromZonedTime(`${addDays(target, 1)}T00:00:00`, TZ).toISOString();

  // 1. Pull all rows for the window, 1000 at a time
  const pulled: any[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("prescription_request")
      .select("*")
      .eq("is_visible", true)
      .eq("type", WL_INJECTABLE_TYPE)
      .gte("created_at", start)
      .lt("created_at", end)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`pull failed: ${error.message}`);
    pulled.push(...(data ?? []));
    if (!data || data.length < PAGE) break;
  }

  // 2. Patient emails (to exclude internal test accounts like the dashboard does)
  const patientIds = [
    ...new Set(pulled.map((r) => r.patient_id).filter(Boolean)),
  ];
  const emailByPatient = new Map<number, string>();
  for (const ids of chunk(patientIds, 200)) {
    const { data, error } = await supabase
      .from("patient")
      .select("id, profile:profile_id(email)")
      .in("id", ids);
    if (error) throw new Error(`patient lookup failed: ${error.message}`);
    (data ?? []).forEach((p: any) =>
      emailByPatient.set(p.id, p.profile?.email ?? ""),
    );
  }

  // 3. SOP filters
  const filtered = pulled.filter((r) => {
    const email = (emailByPatient.get(r.patient_id) ?? "").toLowerCase();
    const med = r.specific_medication ?? "";
    return (
      !email.includes("@getzealthy.com") &&
      INJECTABLE.test(med) &&
      !NAME_BRANDS.test(med) &&
      KEEP_STATUSES.has(norm(r.status))
    );
  });

  // 4. Paid, non-refunded semaglutide/tirzepatide invoice in the last N days
  const since = new Date(
    Date.now() - INVOICE_WINDOW_DAYS * 24 * 3600 * 1000,
  ).toISOString();
  const hasRecentInvoice = new Set<number>();
  for (const ids of chunk(
    [...new Set(filtered.map((r) => r.patient_id))],
    200,
  )) {
    const { data, error } = await supabase
      .from("meta_paid_wl_medication_invoices")
      .select("patient_id, product, amount_paid, is_refunded")
      .in("patient_id", ids)
      .gte("created_at", since);
    if (error) throw new Error(`invoice lookup failed: ${error.message}`);
    (data ?? []).forEach((i: any) => {
      if (
        INJECTABLE.test(i.product ?? "") &&
        (i.amount_paid ?? 0) > 0 &&
        !i.is_refunded
      ) {
        hasRecentInvoice.add(i.patient_id);
      }
    });
  }

  // 5. Patients that already have an open PRESCRIPTION_REQUEST task (any queue)
  const alreadyOpen = new Set<number>();
  const flaggedPatientIds = [
    ...new Set(
      filtered
        .filter((r) => !hasRecentInvoice.has(r.patient_id))
        .map((r) => r.patient_id),
    ),
  ];
  for (const ids of chunk(flaggedPatientIds, 200)) {
    const { data, error } = await supabase
      .from("task_queue")
      .select("patient_id")
      .in("patient_id", ids)
      .eq("task_type", "PRESCRIPTION_REQUEST")
      .eq("visible", true)
      .is("completed_at", null);
    if (error) throw new Error(`task lookup failed: ${error.message}`);
    (data ?? []).forEach((t: any) => alreadyOpen.add(t.patient_id));
  }

  // 6. Decide an action per row
  const seenPatient = new Set<number>();
  const rows = filtered.map((r) => {
    let action = "none (has invoice in window)";
    if (!hasRecentInvoice.has(r.patient_id)) {
      if (r.is_auto_renew === true) action = "skip (auto-renew)";
      else if (alreadyOpen.has(r.patient_id))
        action = "skip (open task exists)";
      else if (seenPatient.has(r.patient_id))
        action = "skip (patient already queued this run)";
      else {
        action = "SEND BACK";
        seenPatient.add(r.patient_id);
      }
    }
    return { r, action };
  });

  // 7. Optional send-back via an internal endpoint (build this in your app so
  //    it reuses the app's own logic for tasks, linking, hiding and priority)
  const sendBackUrl = process.env.SEND_BACK_URL;
  const sent: number[] = [];
  const failed: { pr: number; error: string }[] = [];

  if (!dryRun && sendBackUrl) {
    for (const { r, action } of rows) {
      if (action !== "SEND BACK") continue;
      try {
        const res = await fetch(sendBackUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${process.env.SEND_BACK_TOKEN}`,
          },
          body: JSON.stringify({
            prescriptionRequestId: r.id,
            patientId: r.patient_id,
            expectedStatus: r.status,
            note: SOP_NOTE,
          }),
        });
        if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
        sent.push(r.id);
      } catch (e: any) {
        failed.push({ pr: r.id, error: e.message });
      }
    }
  }

  // 8. Write the dated tab
  const header = [
    "Prescription Request ID",
    "Created (ET)",
    "Patient ID",
    "Status",
    "Specific Medication",
    "Clinician ID",
    "Queue ID",
    "Months",
    "Note",
    "Invoice in last 7 days",
    "Action",
    "Sent (this run)",
  ];
  const values = [
    header,
    ...rows.map(({ r, action }) => [
      r.id,
      et(r.created_at),
      r.patient_id,
      r.status,
      r.specific_medication,
      r.clinician_id,
      r.queue_id,
      r.number_of_month_requested,
      r.note,
      hasRecentInvoice.has(r.patient_id) ? "Yes" : "No",
      action,
      sent.includes(r.id) ? "Yes" : dryRun ? "dry-run" : "",
    ]),
  ];

  if (process.env.GOOGLE_SHEET_ID) {
    await writeTab(process.env.GOOGLE_SHEET_ID, target, values);
  }

  return Response.json({
    date: target,
    window: { start, end },
    dryRun,
    pulled: pulled.length,
    afterFilters: filtered.length,
    sendBackCandidates: rows.filter((x) => x.action === "SEND BACK").length,
    sent: sent.length,
    failed,
  });
}
