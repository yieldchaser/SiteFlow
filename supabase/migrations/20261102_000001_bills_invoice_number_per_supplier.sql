-- Migration: a supplier's bill number is unique per supplier, not company-wide.
-- Idempotent.
--
-- uq_bills_company_id_invoice_number made invoice_number unique across the
-- whole company. A supplier bill carries the supplier's own number, so when two
-- suppliers both sent "1123" the second bill could not be entered, and a bill
-- cancelled for a typing mistake could never be re-entered with its real number.
--
-- Replaced by two partial unique indexes:
--   uq_bills_supplier_invoice_number: purchase / subcon / expense / equipment
--     bills, unique per (company, party, number) among bills not cancelled.
--   uq_bills_own_invoice_number: every other type (sales invoices and the
--     company's own documents), unique company-wide, cancelled or not, because
--     a GST invoice serial is never reused.
--
-- Both are looser than the constraint they replace, so existing rows already
-- satisfy them and nothing is purged.

CREATE UNIQUE INDEX IF NOT EXISTS uq_bills_supplier_invoice_number
    ON bills (company_id, party_company_user_id, invoice_number)
    WHERE invoice_type IN ('purchase', 'subcon', 'expense', 'equipment') AND lower(status) <> 'cancelled';

CREATE UNIQUE INDEX IF NOT EXISTS uq_bills_own_invoice_number
    ON bills (company_id, invoice_number)
    WHERE invoice_type NOT IN ('purchase', 'subcon', 'expense', 'equipment');

ALTER TABLE bills DROP CONSTRAINT IF EXISTS uq_bills_company_id_invoice_number;
