import uuid
from decimal import Decimal
from datetime import datetime, timezone, timedelta
import pytest
from app import models

def test_operational_records_correction_paths_part2(client, db, make_tenant, auth_headers):
    comp, user, _ = make_tenant(company_name="Op Records Test Co", user_name="Op User")
    hdr = auth_headers(user, comp)
    cid = str(comp.id)

    # 1. Project
    proj = models.Project(
        id=uuid.uuid4(),
        company_id=comp.id,
        name="Op Test Project",
        status="active",
    )
    db.add(proj)
    db.commit()
    pid = str(proj.id)

    # -------------------------------------------------------------
    # 1. Procurement GRN Cancellation and Stock Reversal
    # -------------------------------------------------------------
    po = models.PurchaseOrder(
        id=uuid.uuid4(),
        company_id=comp.id,
        project_id=proj.id,
        po_number="PO-2026-999",
        status="approved",
        approval_flag="approved",
        po_date=datetime.now(timezone.utc),
        total_amount=Decimal("10000.00"),
    )
    db.add(po)
    db.flush()

    po_item = models.PurchaseOrderItem(
        id=uuid.uuid4(),
        po_id=po.id,
        material_name="Cement Grade 53",
        unit="Bags",
        quantity=Decimal("100.00"),
        rate=Decimal("400.00"),
        tax_pct=Decimal("18.00"),
        total_amount=Decimal("40000.00"),
    )
    db.add(po_item)
    db.commit()

    # Create GRN
    grn_res = client.post(
        "/apis/v3/procurement/grns",
        headers=hdr,
        json={
            "company_id": cid,
            "project_id": pid,
            "po_id": str(po.id),
            "received_date": datetime.now(timezone.utc).isoformat(),
            "items": [
                {"po_item_id": str(po_item.id), "received_qty": 50.0}
            ]
        }
    )
    assert grn_res.status_code == 201, grn_res.text
    grn_id = grn_res.json()["id"]

    inv = db.query(models.WarehouseInventory).filter(
        models.WarehouseInventory.project_id == proj.id,
        models.WarehouseInventory.material_name == "Cement Grade 53"
    ).first()
    assert inv is not None
    assert float(inv.on_hand_qty) == 50.0

    # Cancel GRN
    cancel_grn_res = client.post(
        f"/apis/v3/procurement/grns/{grn_id}/cancel",
        headers=hdr,
    )
    assert cancel_grn_res.status_code == 200, cancel_grn_res.text
    db.expire_all()
    inv_after = db.query(models.WarehouseInventory).filter(
        models.WarehouseInventory.project_id == proj.id,
        models.WarehouseInventory.material_name == "Cement Grade 53"
    ).first()
    assert float(inv_after.on_hand_qty) == 0.0

    # Double cancel returns 409
    cancel_grn_again = client.post(
        f"/apis/v3/procurement/grns/{grn_id}/cancel",
        headers=hdr,
    )
    assert cancel_grn_again.status_code == 409

    # -------------------------------------------------------------
    # 2. Drawings Update and Delete
    # -------------------------------------------------------------
    draw_res = client.post(
        "/apis/v3/drawings",
        headers=hdr,
        json={
            "project_id": pid,
            "name": "Structural Plan Level 1",
            "category": "2D Layout",
            "file_url": "/drawings/level1_struct.pdf"
        }
    )
    assert draw_res.status_code == 200, draw_res.text
    drawing_id = draw_res.json()["id"]

    # Update drawing
    update_draw_res = client.put(
        f"/apis/v3/drawings/{drawing_id}",
        headers=hdr,
        json={"name": "Structural Plan Level 1 - Revised", "category": "3D Layout"}
    )
    assert update_draw_res.status_code == 200, update_draw_res.text
    assert update_draw_res.json()["name"] == "Structural Plan Level 1 - Revised"
    assert update_draw_res.json()["category"] == "3D Layout"

    # Delete drawing
    del_draw_res = client.delete(
        f"/apis/v3/drawings/{drawing_id}",
        headers=hdr,
    )
    assert del_draw_res.status_code == 204

    # -------------------------------------------------------------
    # 3. Safety Toolbox Talks Update and Delete
    # -------------------------------------------------------------
    tt_res = client.post(
        "/apis/v3/safety/toolbox-talks",
        headers=hdr,
        json={
            "project_id": pid,
            "topic": "Scaffolding Safety",
            "conducted_by": "Safety Officer John",
            "conducted_at": datetime.now(timezone.utc).isoformat(),
            "attendee_count": 15,
            "notes": "Daily morning briefing"
        }
    )
    assert tt_res.status_code == 200, tt_res.text
    tt_id = tt_res.json()["id"]

    update_tt_res = client.put(
        f"/apis/v3/safety/toolbox-talks/{tt_id}",
        headers=hdr,
        json={"topic": "Scaffolding & Harness Safety", "attendee_count": 18}
    )
    assert update_tt_res.status_code == 200, update_tt_res.text
    assert update_tt_res.json()["topic"] == "Scaffolding & Harness Safety"
    assert update_tt_res.json()["attendee_count"] == 18

    del_tt_res = client.delete(
        f"/apis/v3/safety/toolbox-talks/{tt_id}",
        headers=hdr,
    )
    assert del_tt_res.status_code == 204

    # -------------------------------------------------------------
    # 4. Safety PPE Checks Update and Delete
    # -------------------------------------------------------------
    ppe_res = client.post(
        "/apis/v3/safety/ppe-checks",
        headers=hdr,
        json={
            "project_id": pid,
            "checked_by": "Inspector Mark",
            "check_date": datetime.now(timezone.utc).isoformat(),
            "total_workers": 20,
            "compliant_workers": 18,
            "non_compliant_items": ["Helmets", "Boots"]
        }
    )
    assert ppe_res.status_code == 200, ppe_res.text
    ppe_id = ppe_res.json()["id"]

    update_ppe_res = client.put(
        f"/apis/v3/safety/ppe-checks/{ppe_id}",
        headers=hdr,
        json={"compliant_workers": 19}
    )
    assert update_ppe_res.status_code == 200, update_ppe_res.text
    assert update_ppe_res.json()["compliant_workers"] == 19
    assert update_ppe_res.json()["compliance_pct"] == 95.0

    del_ppe_res = client.delete(
        f"/apis/v3/safety/ppe-checks/{ppe_id}",
        headers=hdr,
    )
    assert del_ppe_res.status_code == 204

    # -------------------------------------------------------------
    # 5. Quality Material Tests Update and Delete
    # -------------------------------------------------------------
    mt_res = client.post(
        "/apis/v3/quality/material-tests",
        headers=hdr,
        json={
            "project_id": pid,
            "test_type": "Compressive Strength (7 Days)",
            "material": "Concrete M25",
            "test_date": datetime.now(timezone.utc).isoformat(),
            "result_value": 18.5,
            "min_acceptable": 16.5,
            "unit": "N/mm2"
        }
    )
    assert mt_res.status_code == 201, mt_res.text
    mt_id = mt_res.json()["id"]
    assert mt_res.json()["is_pass"] is True

    update_mt_res = client.put(
        f"/apis/v3/quality/material-tests/{mt_id}",
        headers=hdr,
        json={"result_value": 15.0}
    )
    assert update_mt_res.status_code == 200, update_mt_res.text
    assert update_mt_res.json()["result_value"] == 15.0
    assert update_mt_res.json()["is_pass"] is False

    del_mt_res = client.delete(
        f"/apis/v3/quality/material-tests/{mt_id}",
        headers=hdr,
    )
    assert del_mt_res.status_code == 204

    # -------------------------------------------------------------
    # 6. Settings Company File Delete
    # -------------------------------------------------------------
    cf = models.CompanyFile(
        id=uuid.uuid4(),
        company_id=comp.id,
        asset_type="logo",
        filename="logo.png",
        content_type="image/png",
        data=b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR"
    )
    db.add(cf)
    db.commit()

    del_cf_res = client.delete(
        f"/apis/v3/settings/company-file/{cid}/logo",
        headers=hdr,
    )
    assert del_cf_res.status_code == 204

    # -------------------------------------------------------------
    # 7. Team Schedule Timesheets Update
    # -------------------------------------------------------------
    ts_res = client.post(
        "/apis/v3/team-schedule/timesheets",
        headers=hdr,
        json={
            "company_id": cid,
            "project_id": pid,
            "entry_date": datetime.now(timezone.utc).isoformat(),
            "start_time": (datetime.now(timezone.utc) - timedelta(hours=4)).isoformat(),
            "end_time": datetime.now(timezone.utc).isoformat(),
            "remarks": "Site boundary inspection"
        }
    )
    assert ts_res.status_code == 201, ts_res.text
    ts_id = ts_res.json()["id"]

    update_ts_res = client.put(
        f"/apis/v3/team-schedule/timesheets/{ts_id}",
        headers=hdr,
        json={"remarks": "Updated site inspection notes"}
    )
    assert update_ts_res.status_code == 200, update_ts_res.text
    assert update_ts_res.json()["remarks"] == "Updated site inspection notes"

    del_ts_res = client.delete(
        f"/apis/v3/team-schedule/timesheets/{ts_id}",
        headers=hdr,
    )
    assert del_ts_res.status_code == 200

    # -------------------------------------------------------------
    # 8. Custom Fields Values Upsert
    # -------------------------------------------------------------
    cf_field = models.CustomField(
        id=uuid.uuid4(),
        company_id=comp.id,
        entity_type="project",
        field_name="r2_test_field",
        field_label="R2 Test Field",
        field_type="text",
        is_required=False,
        display_order=0
    )
    db.add(cf_field)
    db.commit()

    # 1st call creates
    cf_res1 = client.post(
        "/apis/v3/custom-fields/values",
        headers=hdr,
        json={
            "company_id": cid,
            "field_id": str(cf_field.id),
            "entity_type": "project",
            "entity_id": pid,
            "value_text": "Initial Custom Value"
        }
    )
    assert cf_res1.status_code == 201, cf_res1.text
    assert cf_res1.json()["value_text"] == "Initial Custom Value"

    # 2nd call upserts
    cf_res2 = client.post(
        "/apis/v3/custom-fields/values",
        headers=hdr,
        json={
            "company_id": cid,
            "field_id": str(cf_field.id),
            "entity_type": "project",
            "entity_id": pid,
            "value_text": "Updated Custom Value"
        }
    )
    assert cf_res2.status_code == 201, cf_res2.text
    assert cf_res2.json()["value_text"] == "Updated Custom Value"

    # -------------------------------------------------------------
    # 9. HR Leaves Withdrawal
    # -------------------------------------------------------------
    leave_emp = models.StaffEmployee(id=uuid.uuid4(), company_id=comp.id, name="Leave Tester", status="active")
    db.add(leave_emp)
    db.commit()
    leave_res = client.post(
        f"/apis/v3/hr/leaves/{cid}",
        headers=hdr,
        json={
            "project_id": pid,
            "employee_id": str(leave_emp.id),
            "employee_name": "Leave Tester",
            "leave_type": "Casual",
            "start_date": datetime.now(timezone.utc).isoformat(),
            "end_date": (datetime.now(timezone.utc) + timedelta(days=2)).isoformat(),
            "days_count": 2
        }
    )
    assert leave_res.status_code == 200, leave_res.text
    leave_id = leave_res.json()["id"]
    assert leave_res.json()["status"] == "Pending"

    # Withdraw leave request
    withdraw_res = client.post(
        f"/apis/v3/hr/leaves/{leave_id}/withdraw",
        headers=hdr,
    )
    assert withdraw_res.status_code == 200, withdraw_res.text
    assert withdraw_res.json()["status"] == "Withdrawn"

    # Double withdraw returns 409
    withdraw_again = client.post(
        f"/apis/v3/hr/leaves/{leave_id}/withdraw",
        headers=hdr,
    )
    assert withdraw_again.status_code == 409
