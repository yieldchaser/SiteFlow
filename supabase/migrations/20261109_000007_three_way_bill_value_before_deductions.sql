-- Three-way matches compared the goods received with the bill's payable
-- amount, which is after TDS and other deductions. Deductions are held back
-- from the supplier, not a price difference, so a bill with TDS read as
-- under-billed by the TDS amount. Re-read each match's bill value as work
-- plus GST and recompute the difference. Matches still awaiting a decision
-- (matched / mismatch) get their verdict recomputed with the same tolerance
-- as the API: the larger of Rs 1 and 1% of the goods value. Approved and
-- rejected matches keep their decision.
WITH fix AS (
    SELECT
        m.id,
        round(
            CASE WHEN COALESCE(b.subtotal, 0) + COALESCE(b.gst_amount, 0) > 0
                 THEN COALESCE(b.subtotal, 0) + COALESCE(b.gst_amount, 0)
                 ELSE COALESCE(b.total_payable, 0) END,
            2
        ) AS bill_value
    FROM three_way_matches m
    JOIN bills b ON b.id = m.invoice_id
)
UPDATE three_way_matches m
SET
    invoiced_amount = fix.bill_value,
    variance_amount = round(fix.bill_value - m.po_amount, 2),
    match_status = CASE
        WHEN m.match_status IN ('matched', 'mismatch') THEN
            CASE WHEN abs(fix.bill_value - m.po_amount) <= GREATEST(1, abs(m.po_amount) * 0.01)
                 THEN 'matched' ELSE 'mismatch' END
        ELSE m.match_status
    END
FROM fix
WHERE fix.id = m.id
  AND m.invoiced_amount IS DISTINCT FROM fix.bill_value;
