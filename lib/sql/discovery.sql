-- discovery.sql
-- Read-only queries. Run these BEFORE turning DRY_RUN off.

-- 1. Exact status spellings in use for this request type
SELECT status, count(*)
FROM prescription_request
WHERE type = 'WEIGHT_LOSS_GLP1 (INJECTABLE)'
GROUP BY 1 ORDER BY 2 DESC;

-- 2. Medication names inside the injectable type (are there non-sema/tirz rows?)
SELECT specific_medication, count(*)
FROM prescription_request
WHERE type = 'WEIGHT_LOSS_GLP1 (INJECTABLE)'
GROUP BY 1 ORDER BY 2 DESC;

-- 3. Which queues and task types are live right now?
SELECT queue_type, task_type, count(*)
FROM task_queue
WHERE visible = true AND created_at > now() - interval '30 days'
GROUP BY 1, 2 ORDER BY 3 DESC;

-- 4. How do requests link to tasks? (confirms queue_id is set by the app)
SELECT pr.id AS pr_id, pr.status, pr.queue_id, t.queue_type, t.task_type,
       t.note, t.priority_level, t.visible, t.created_at
FROM prescription_request pr
JOIN task_queue t ON t.id = pr.queue_id
WHERE pr.type = 'WEIGHT_LOSS_GLP1 (INJECTABLE)'
ORDER BY pr.created_at DESC
LIMIT 20;

-- 5. Recent tasks that carry the SOP send-back note (shows the real shape)
SELECT t.id, t.created_at, t.queue_type, t.task_type, t.note, t.priority_level,
       t.forwarded_task_id, pr.id AS pr_id, pr.status
FROM task_queue t
LEFT JOIN prescription_request pr ON pr.queue_id = t.id
WHERE t.note ILIKE 'Provider support has been reviewed%'
  AND t.created_at > now() - interval '30 days'
ORDER BY t.created_at DESC
LIMIT 20;

-- 6. Invoice view: status values and product names
SELECT status, count(*) FROM meta_paid_wl_medication_invoices GROUP BY 1 ORDER BY 2 DESC;
SELECT product, count(*) FROM meta_paid_wl_medication_invoices GROUP BY 1 ORDER BY 2 DESC;

-- 7. Enum labels for the type column
SELECT enum_range(NULL::public.medication_type);