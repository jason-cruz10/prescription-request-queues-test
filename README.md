# GLP-1 daily review + refill audit (Vercel cron)

## Files

| File                                 | Purpose                                                                |
| ------------------------------------ | ---------------------------------------------------------------------- |
| `vercel.json`                        | Cron schedules (UTC)                                                   |
| `app/api/cron/glp1-review/route.ts`  | Pull, filter, invoice check, write dated sheet tab, optional send-back |
| `app/api/cron/refill-audit/route.ts` | Run a saved Looker Look, flag invalid "too soon" denials, draft emails |
| `lib/sheets.ts`                      | Writes a dated tab (idempotent)                                        |
| `sql/glp1_review.sql`                | Same filters in SQL, for cross-checking                                |
| `sql/discovery.sql`                  | Read-only queries to confirm assumptions                               |
| `.env.example`                       | Required environment variables                                         |

## Install

```
npm i @supabase/supabase-js date-fns-tz googleapis
```

The routes use the `@/lib/sheets` alias; adjust if your project uses a different path alias.

## Schedule

Vercel cron runs in UTC. `0 11 * * *` is 7:00 AM EDT / 6:00 AM EST. The route
computes "yesterday" in `BUSINESS_TIMEZONE`, so the window stays correct across
daylight saving changes. On the Hobby plan a job can fire anywhere within its
scheduled hour.

## Rollout

1. Run `sql/discovery.sql`; fix `KEEP_STATUSES` and the medication filters if the data differs.
2. Deploy with `DRY_RUN=true`. Call `GET /api/cron/glp1-review?date=YYYY-MM-DD`
   with header `Authorization: Bearer <CRON_SECRET>` for a recent day.
3. Compare the sheet tab with what the team produced manually for the same day
   (and with `sql/glp1_review.sql`). Expect small differences at the day edges:
   the cron uses 12:00:00 AM to 11:59:59 PM, the manual export is minute precision.
4. Build the send-back endpoint in the app (see below), then set `SEND_BACK_URL`
   and `DRY_RUN=false`.
5. Refill audit: save the Looker Look, replace the placeholder `FIELDS` names,
   and review the drafted tab by hand. Nothing is emailed and no strike is issued automatically.

## Send-back endpoint (not included)

The cron does not write to `task_queue` directly. In the app, creating a
provider task also links the request via `queue_id`, hides the patient's older
open tasks, and triggers priority assignment. Build one internal route that reuses
that logic and does the equivalent of the "Requested" button
(status `REQUESTED`) plus creating the task with the SOP note. The cron sends
`{ prescriptionRequestId, patientId, expectedStatus, note }`; return 2xx on
success and make the route reject the call if the request's status no longer
equals `expectedStatus`.

## Open decisions

- `APPROVED` and `CANCELED`: the SOP lists them under both remove and keep.
- Which `clinician_id` to record on automated actions (compensation reports may use it).
- Whether `REJECTED` requests that already had a denial refund should be re-requested automatically.
- Whether the daily review should also cover `PRESCRIPTION_REFILL` tasks.
- Rotate the `Supabase-Signature` webhook secret that appeared in the schemas shared earlier.
