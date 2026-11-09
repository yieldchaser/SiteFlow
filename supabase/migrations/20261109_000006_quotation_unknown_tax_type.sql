-- Quotations saved with a tax type other than bill_level / item_level fell
-- through both tax branches: they showed 18% GST but charged nothing, and
-- the total was the bare subtotal. Treat them as tax on the bill, the way
-- the API now reads "GST", and recompute tax and total from the stored
-- figures. Old total = subtotal + additional charges + round off.
WITH fix AS (
    SELECT
        q.id,
        GREATEST(
            (q.total_amount - COALESCE(q.additional_charges, 0) - COALESCE(q.round_off, 0))
            - COALESCE(q.discount, 0),
            0
        ) AS taxable,
        q.gst_pct,
        q.cgst_pct,
        q.sgst_pct,
        COALESCE(q.igst_pct, 0) AS igst_pct
    FROM crm_quotations q
    WHERE lower(q.tax_type) NOT IN ('bill_level', 'item_level')
)
UPDATE crm_quotations q
SET
    tax_type = 'bill_level',
    igst_amount = CASE WHEN fix.igst_pct > 0
        THEN round(fix.taxable * fix.gst_pct / 100, 2) ELSE 0 END,
    cgst_amount = CASE WHEN fix.igst_pct > 0 THEN 0
        ELSE round(fix.taxable * fix.gst_pct / 100
                   * fix.cgst_pct / NULLIF(fix.cgst_pct + fix.sgst_pct, 0), 2) END,
    sgst_amount = CASE WHEN fix.igst_pct > 0 THEN 0
        ELSE round(fix.taxable * fix.gst_pct / 100
                   * fix.sgst_pct / NULLIF(fix.cgst_pct + fix.sgst_pct, 0), 2) END,
    total_amount = fix.taxable + round(fix.taxable * fix.gst_pct / 100, 2)
        + COALESCE(q.additional_charges, 0) + COALESCE(q.round_off, 0)
FROM fix
WHERE q.id = fix.id;

-- Quotes saved without a number get QT-nnn in creation order per company,
-- continuing after the highest QT number the company already uses.
WITH numbered AS (
    SELECT
        q.id,
        l.company_id,
        row_number() OVER (PARTITION BY l.company_id ORDER BY q.created_at, q.id) AS rn
    FROM crm_quotations q
    JOIN crm_leads l ON l.id = q.lead_id
    WHERE q.qt_no IS NULL OR btrim(q.qt_no) = ''
),
base AS (
    SELECT l.company_id,
           COALESCE(max(NULLIF(substring(q.qt_no FROM '^QT-(\d+)$'), '')::int), 0) AS top
    FROM crm_quotations q
    JOIN crm_leads l ON l.id = q.lead_id
    GROUP BY l.company_id
)
UPDATE crm_quotations q
SET qt_no = 'QT-' || lpad((base.top + numbered.rn)::text, 3, '0')
FROM numbered
JOIN base ON base.company_id = numbered.company_id
WHERE q.id = numbered.id;
