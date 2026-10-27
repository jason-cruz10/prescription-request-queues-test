-- glp1_review.sql
-- SQL equivalent of the daily review in app/api/cron/glp1-review/route.ts.
-- Use it to cross-check the cron output against the manual process.
--
-- Change target_date to backfill a day. Default = yesterday in New York time.

WITH params AS (
  SELECT
    COALESCE(
      NULL::date,                                              -- <- put 'YYYY-MM-DD'::date here to override
      (now() AT TIME ZONE 'America/New_York')::date - 1
    ) AS target_date
),
bounds AS (
  SELECT
    (target_date::timestamp)       AT TIME ZONE 'America/New_York' AS start_ts,
    ((target_date + 1)::timestamp) AT TIME ZONE 'America/New_York' AS end_ts
  FROM params
),
base AS (
  SELECT
    pr.id,
    pr.created_at,
    pr.patient_id,
    pr.clinician_id,
    pr.status,
    pr.specific_medication,
    pr.queue_id,
    pr.number_of_month_requested,
    pr.note,
    pr.is_auto_renew
  FROM public.prescription_request pr
  JOIN public.patient p       ON p.id = pr.patient_id
  LEFT JOIN public.profiles pf ON pf.id = p.profile_id
  CROSS JOIN bounds b
  WHERE
    -- 1. Previous-day window
    pr.created_at >= b.start_ts
    AND pr.created_at <  b.end_ts

    -- 2. Dashboard filters
    AND pr.is_visible = true
    AND pr.type = 'WEIGHT_LOSS_GLP1 (INJECTABLE)'

    -- 3. Exclude internal test accounts (same rule as the dashboard)
    AND COALESCE(lower(pf.email), '') NOT LIKE '%@getzealthy.com%'

    -- 4. Injectables only, no name brands
    AND (pr.specific_medication ILIKE '%semaglutide%'
         OR pr.specific_medication ILIKE '%tirzepatide%')
    AND pr.specific_medication !~* '(zepbound|wegovy|saxenda|ozempic|mounjaro|victoza)'

    -- 5. Statuses to KEEP (normalized: upper-case, spaces/hyphens -> underscore)
    --    Add 'APPROVED' / 'CANCELED' here only after the SOP conflict is resolved.
    AND upper(regexp_replace(pr.status, '[\s-]+', '_', 'g')) IN (
      'REJECTED',
      'REQUESTED_FORWARDED',
      'PENDING_MEDICAL_INFORMATION'
    )
)
SELECT
  base.*,
  -- Paid, non-refunded semaglutide/tirzepatide invoice in the last 7 days?
  EXISTS (
    SELECT 1
    FROM public.meta_paid_wl_medication_invoices inv
    WHERE inv.patient_id = base.patient_id
      AND inv.created_at >= now() - interval '7 days'
      AND COALESCE(inv.is_refunded, false) = false
      AND COALESCE(inv.amount_paid, 0) > 0
      AND (inv.product ILIKE '%semaglutide%' OR inv.product ILIKE '%tirzepatide%')
  ) AS has_invoice_last_7_days,
  -- Already has an open PRESCRIPTION_REQUEST task in any queue?
  EXISTS (
    SELECT 1
    FROM public.task_queue t
    WHERE t.patient_id = base.patient_id
      AND t.task_type = 'PRESCRIPTION_REQUEST'
      AND t.visible = true
      AND t.completed_at IS NULL
  ) AS has_open_task
FROM base
ORDER BY base.created_at;

-- Rows to send back to the Provider Queue =
--   has_invoice_last_7_days = false AND has_open_task = false AND is_auto_renew IS NOT TRUE