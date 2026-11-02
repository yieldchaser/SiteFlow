"""D-V2 + R2-613 - legacy duplicate purge reaches production WITH its constraints.

Guarantees, per docs/VERIFICATION_DECISIONS_RESOLVED.md:

1. All eight named constraints exist on the SQLAlchemy model metadata: the
   seven D-V2 document-number pairs from wave 2efc31a (material_indents,
   purchase_orders, goods_receipt_notes, work_orders, bills, ncrs, payments)
   plus R2-613's own uq_three_way_matches_po_grn.
2. Migration 20260825_000003_duplicate_purge_and_constraints.sql follows the
   founder-mandated order for EVERY table: timestamped backup FIRST, then
   DELETE keeping the EARLIEST row of each group (min created_at, tie-broken
   by min id), then ADD CONSTRAINT inside the same migration so the window
   cannot reopen. Re-run guards exist for every block.
3. The purge algorithm itself works end to end on a scratch table mirroring
   the pattern: duplicates block a unique index before the purge; afterwards
   the earliest row survives, the full pre-purge groups sit in a timestamped
   backup table, and the unique index lands cleanly. Re-running purges
   nothing further.
"""
import datetime
import os

import pytest
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError

from app import models

MIGRATION = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", "..", "..",
    "supabase", "migrations", "20260825_000003_duplicate_purge_and_constraints.sql",
)

# (model class, table, constraint name) - every constraint this wave guarantees.
EXPECTED_CONSTRAINTS = [
    (models.MaterialIndent, "material_indents", "uq_material_indents_company_id_indent_number"),
    (models.PurchaseOrder, "purchase_orders", "uq_purchase_orders_company_id_po_number"),
    (models.GoodsReceiptNote, "goods_receipt_notes", "uq_goods_receipt_notes_company_id_grn_number"),
    (models.WorkOrder, "work_orders", "uq_work_orders_company_id_wo_number"),
    (models.Bill, "bills", "uq_bills_company_id_invoice_number"),
    (models.NCR, "ncrs", "uq_ncrs_project_id_ncr_number"),
    (models.Payment, "payments", "uq_payments_company_id_reference_number"),
    # R2-613: the constraint whose legacy-duplicate skip started this decision.
    (models.ThreeWayMatch, "three_way_matches", "uq_three_way_matches_po_grn"),
]


# The historical migration still creates uq_bills_company_id_invoice_number, so
# the migration-file checks keep it. The model no longer carries it:
# 20261102_000001 replaced it with per-supplier and own-number unique indexes
# (see test_bill_number_per_supplier.py).
SUPERSEDED = {"uq_bills_company_id_invoice_number"}
LIVE_CONSTRAINTS = [c for c in EXPECTED_CONSTRAINTS if c[-1] not in SUPERSEDED]


def test_bills_carry_the_two_invoice_number_indexes():
    names = {i.name for i in models.Bill.__table__.indexes if i.unique}
    assert {"uq_bills_supplier_invoice_number", "uq_bills_own_invoice_number"} <= names

@pytest.mark.parametrize("model,table,name", LIVE_CONSTRAINTS, ids=[n for _, _, n in LIVE_CONSTRAINTS])
def test_constraint_exists_on_model_metadata(model, table, name):
    assert model.__tablename__ == table
    names = {c.name for c in model.__table__.constraints if c.name}
    assert name in names, f"{name} missing from {table} metadata"


def test_migration_backup_then_delete_then_add_for_every_table():
    src = open(MIGRATION, encoding="utf-8").read()
    for table, name in [(t, n) for _, t, n in EXPECTED_CONSTRAINTS]:
        backup_marker = f"_audit_backup_{table}_"
        delete_marker = f"DELETE FROM {table}"
        add_marker = f"ADD CONSTRAINT {name}"
        assert backup_marker in src, f"{table}: no timestamped backup table"
        assert delete_marker in src, f"{table}: no purge DELETE"
        assert add_marker in src, f"migration never creates {name}"
        assert f"conname = '{name}'" in src, f"{name} lacks the pg_constraint re-run guard"
        i_backup = src.index(backup_marker)
        i_delete = src.index(delete_marker)
        i_add = src.index(add_marker)
        assert i_backup < i_delete < i_add, (
            f"{table}: order must be backup ({i_backup}) then delete ({i_delete}) "
            f"then add constraint ({i_add})"
        )


def test_migration_keeps_earliest_row_and_is_idempotent():
    src = open(MIGRATION, encoding="utf-8").read()
    # Eight blocks, each detecting duplicates...
    assert src.count("HAVING COUNT(*) > 1") >= 8
    # ...each keeping min(created_at) tie-broken by min(id)...
    assert src.count("k.created_at < t.created_at") >= 8
    assert src.count("k.id < t.id") >= 8
    # ...each backing up into a UTC-timestamped table name...
    assert src.count("clock_timestamp()") >= 8
    assert src.count("'YYYYMMDD_HH24MISSUS'") >= 8
    assert src.count("_audit_backup_") >= 8
    # ...and each guarded by an early exit when its constraint already exists.
    assert src.count("pg_constraint WHERE conname =") >= 8
    # Payments: NULL reference numbers never group, so every phase filters them.
    assert src.count("reference_number IS NOT NULL") >= 3
    # three_way_matches groups on (po_id, grn_id).
    assert "o.po_id = t.po_id AND o.grn_id = t.grn_id" in src
    # House rule: no em dashes anywhere in the file.
    assert "\u2014" not in src


SCRATCH_TABLE = "_scratch_dv2_purge"

SEED_ROWS = [
    # (id, group_key, created_at day-of-August-2026, payload)
    ("row-a1", "GA", 1, "GA earliest (created_at tied, lowest id wins)"),
    ("row-a2", "GA", 1, "GA tied later id - must be purged"),
    ("row-a3", "GA", 3, "GA latest - must be purged"),
    ("row-b1", "GB", 2, "GB singleton - must be untouched"),
    ("row-c4", "GC", 5, "GC tie winner"),
    ("row-c9", "GC", 5, "GC tie loser - must be purged"),
]

EXPECTED_SURVIVORS = {"row-a1", "row-b1", "row-c4"}
EXPECTED_BACKUP_IDS = {"row-a1", "row-a2", "row-a3", "row-c4", "row-c9"}


def _seed_scratch(db):
    db.execute(text(
        f"CREATE TABLE IF NOT EXISTS {SCRATCH_TABLE} ("
        "id VARCHAR(32) PRIMARY KEY, group_key VARCHAR(8) NOT NULL, "
        "created_at TIMESTAMP NOT NULL, payload VARCHAR(255))"
    ))
    for rid, key, day, payload in SEED_ROWS:
        db.execute(
            text(f"INSERT INTO {SCRATCH_TABLE} (id, group_key, created_at, payload) "
                 "VALUES (:rid, :key, :cat, :payload)"),
            {"rid": rid, "key": key, "cat": datetime.datetime(2026, 8, day), "payload": payload},
        )
    db.commit()


def _drop_scratch(db):
    db.rollback()
    rows = db.execute(text(
        "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '_audit\\_backup\\_%' ESCAPE '\\'"
    )).fetchall()
    db.execute(text(f"DROP TABLE IF EXISTS {SCRATCH_TABLE}"))
    for (name,) in rows:
        db.execute(text(f'DROP TABLE IF EXISTS "{name}"'))
    db.execute(text("DROP INDEX IF EXISTS uq_scratch_dv2"))
    db.commit()


def _purge_like_migration(db, table, key_col):
    """Mirror of one DO block in 20260825_000003: backup first, delete non-
    earliest second, unique index third; phases two and three only touch data
    when duplicate groups actually exist."""
    ts = datetime.datetime.utcnow().strftime("%Y%m%d_%H%M%S%f")
    backup_table = f"_audit_backup_{table}_{ts}"
    dup_groups = db.execute(text(
        f"SELECT COUNT(*) FROM (SELECT {key_col} FROM {table} "
        f"GROUP BY {key_col} HAVING COUNT(*) > 1)"
    )).scalar()

    if dup_groups:
        db.execute(text(
            f"CREATE TABLE \"{backup_table}\" AS SELECT t.* FROM {table} t "
            f"WHERE EXISTS (SELECT 1 FROM {table} o "
            f"WHERE o.{key_col} = t.{key_col} AND o.id <> t.id)"
        ))
        db.execute(text(
            f"DELETE FROM {table} WHERE id IN ("
            f"SELECT t.id FROM {table} t JOIN {table} k ON t.{key_col} = k.{key_col} "
            f"WHERE k.created_at < t.created_at "
            f"OR (k.created_at = t.created_at AND k.id < t.id))"
        ))

    db.execute(text(
        f"CREATE UNIQUE INDEX IF NOT EXISTS uq_scratch_dv2 ON {table} ({key_col})"
    ))
    db.commit()
    return backup_table, int(dup_groups)


def _ids(db, table=SCRATCH_TABLE):
    return {r[0] for r in db.execute(text(f"SELECT id FROM {table}")).fetchall()}


def test_duplicate_purge_keeps_earliest_backs_up_group_and_lands_constraint(client, db):
    _seed_scratch(db)
    try:
        # Before the purge the duplicates block the constraint, exactly the
        # failure that left uq_three_way_matches_po_grn uncreated in prod.
        with pytest.raises(IntegrityError):
            db.execute(text(f"CREATE UNIQUE INDEX uq_scratch_dv2 ON {SCRATCH_TABLE} (group_key)"))
        db.rollback()

        backup_table, dup_groups = _purge_like_migration(db, SCRATCH_TABLE, "group_key")
        assert dup_groups == 2, "expected duplicate groups GA and GC"

        # Earliest row of each group survives; singleton untouched.
        assert _ids(db) == EXPECTED_SURVIVORS
        kept = dict(db.execute(text(
            f"SELECT id, payload FROM {SCRATCH_TABLE}"
        )).fetchall())
        assert "lowest id wins" in kept["row-a1"]
        assert kept["row-b1"] == "GB singleton - must be untouched"
        assert kept["row-c4"] == "GC tie winner"

        # Full pre-purge group snapshot landed in the timestamped backup,
        # including the surviving members.
        backup_ids = _ids(db, backup_table)
        assert backup_ids == EXPECTED_BACKUP_IDS
        restored_payload = dict(db.execute(text(
            f'SELECT id, payload FROM "{backup_table}"'
        )).fetchall())["row-a3"]
        assert restored_payload == "GA latest - must be purged"

        # The constraint now holds: a fresh duplicate cannot slip back in
        # (SQLite rejects at execute time; Postgres at statement flush time).
        with pytest.raises(IntegrityError):
            db.execute(
                text(f"INSERT INTO {SCRATCH_TABLE} (id, group_key, created_at, payload) "
                     "VALUES ('row-a5', 'GA', :cat, 'latecomer')"),
                {"cat": datetime.datetime(2026, 8, 6)},
            )
            db.commit()
        db.rollback()

        # Idempotent re-run: zero duplicate groups, nothing new backed up or
        # deleted, constraint still in place.
        backup_table_2, dup_groups_2 = _purge_like_migration(db, SCRATCH_TABLE, "group_key")
        assert dup_groups_2 == 0
        assert _ids(db) == EXPECTED_SURVIVORS
        backups = db.execute(text(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' "
            "AND name LIKE '_audit\\_backup\\_%' ESCAPE '\\'"
        )).scalar()
        assert backups == 1
    finally:
        _drop_scratch(db)
