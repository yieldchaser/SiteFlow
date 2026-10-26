-- payment_requests.party_company_user_id carried TWO foreign keys pointing at
-- users(id): the Postgres-default payment_requests_party_company_user_id_fkey
-- and fk_payment_requests_party_company_user_id from the schema sync.
-- 20260825_000002 looked one of them up with LIMIT 1, dropped it and re-added
-- fk_payment_requests_party_company_user_id against company_team. The other
-- survived, so every insert had to satisfy users(id) AND company_team(id) at
-- once, and no payment request could be raised for any party.
--
-- Found 2026-10-26 seeding a demo tenant: POST /finance/payment-requests
-- returned 409 "violates foreign key constraint
-- payment_requests_party_company_user_id_fkey" for a valid company_team id.
--
-- Drop every FK on that column that still references users. The company_team
-- FK stays. Idempotent; never touches data.

DO $$
DECLARE
    r record;
BEGIN
    FOR r IN
        SELECT c.conname
          FROM pg_constraint c
          JOIN pg_attribute a
            ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
         WHERE c.conrelid = 'payment_requests'::regclass
           AND c.contype = 'f'
           AND c.confrelid = 'users'::regclass
           AND a.attname = 'party_company_user_id'
    LOOP
        EXECUTE format('ALTER TABLE payment_requests DROP CONSTRAINT %I', r.conname);
    END LOOP;
END $$;
