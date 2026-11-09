"""A batch plans material for its own size.

The recipe is written per target output (8 bags of cement per 1 cum). A
5 cum batch kept the recipe's 8 bags as its plan, so using 41 bags showed
33 bags over plan instead of 1, and the Production page reported a 544%
material overrun on a site that was on plan.
"""
import uuid

from app import models

_TAG = uuid.uuid4().hex[:8]
_MOB = "+9170" + str(int(_TAG, 16))[-8:]


def test_batch_plan_scales_to_batch_size(client, db, make_tenant, auth_headers):
    comp, user, _ = make_tenant(company_name=f"Prod-{_TAG}", user_name="Prod",
                                mobile=_MOB, email=f"prod-{_TAG}@test.com")
    hdr = auth_headers(user, comp)
    project = models.Project(id=uuid.uuid4(), company_id=comp.id, name="Plant", status="Ongoing")
    db.add(project)
    db.commit()

    r = client.post("/apis/v3/production/recipes", headers=hdr, json={
        "company_id": str(comp.id), "project_id": str(project.id),
        "recipe_code": f"M20-{_TAG}", "product_name": "M20 concrete", "mix_type": "concrete",
        "unit": "cum", "target_output_qty": 1, "wastage_pct": 0,
        "materials": [{"material_name": "Cement", "planned_qty": 8, "unit": "bag"}],
    })
    assert r.status_code in (200, 201), r.text
    recipe_id = r.json()["id"]

    b = client.post("/apis/v3/production/batches", headers=hdr, json={
        "company_id": str(comp.id), "project_id": str(project.id), "recipe_id": recipe_id,
        "batch_number": f"B-{_TAG}", "planned_output_qty": 5, "actual_output_qty": 5,
        "status": "draft",
        "materials": [{"material_name": "Cement", "actual_qty": 41, "unit": "bag"}],
    })
    assert b.status_code in (200, 201), b.text
    mat = b.json()["materials"][0]
    assert round(mat["planned_qty"], 2) == 40.0
    assert round(mat["variance_qty"], 2) == 1.0


def test_completing_a_running_batch_records_what_was_used(client, db, make_tenant, auth_headers):
    """A running batch was completed with the plan as its actuals: the site
    had no way to say it used 43 bags, so stock and variance were both off."""
    tag = uuid.uuid4().hex[:8]
    comp, user, _ = make_tenant(company_name=f"ProdC-{tag}", user_name="ProdC",
                                mobile="+9171" + str(int(tag, 16))[-8:], email=f"prodc-{tag}@test.com")
    hdr = auth_headers(user, comp)
    project = models.Project(id=uuid.uuid4(), company_id=comp.id, name="Plant C", status="Ongoing")
    db.add(project)
    db.commit()

    r = client.post("/apis/v3/production/recipes", headers=hdr, json={
        "company_id": str(comp.id), "project_id": str(project.id),
        "recipe_code": f"M20C-{tag}", "product_name": "M20 concrete", "mix_type": "concrete",
        "unit": "cum", "target_output_qty": 1, "wastage_pct": 0,
        "materials": [{"material_name": "Cement", "planned_qty": 8, "unit": "bag"}],
    })
    assert r.status_code in (200, 201), r.text
    b = client.post("/apis/v3/production/batches", headers=hdr, json={
        "company_id": str(comp.id), "project_id": str(project.id), "recipe_id": r.json()["id"],
        "batch_number": f"BC-{tag}", "planned_output_qty": 5, "status": "running",
    })
    assert b.status_code in (200, 201), b.text
    batch_id = b.json()["id"]

    c = client.patch(f"/apis/v3/production/batches/{batch_id}/complete", headers=hdr, json={
        "actual_output_qty": 4.8,
        "materials": [{"material_name": "Cement", "actual_qty": 43, "unit": "bag"}],
    })
    assert c.status_code == 200, c.text
    body = c.json()
    assert body["status"] == "completed"
    assert body["actual_output_qty"] == 4.8
    mat = body["materials"][0]
    assert mat["actual_qty"] == 43
    assert round(mat["variance_qty"], 2) == 3.0
    used = db.query(models.MaterialTransaction).filter(
        models.MaterialTransaction.source_ref_id == uuid.UUID(batch_id)).all()
    assert [float(t.qty) for t in used] == [43.0]


def test_completing_without_a_body_still_works(client, db, make_tenant, auth_headers):
    tag = uuid.uuid4().hex[:8]
    comp, user, _ = make_tenant(company_name=f"ProdN-{tag}", user_name="ProdN",
                                mobile="+9172" + str(int(tag, 16))[-8:], email=f"prodn-{tag}@test.com")
    hdr = auth_headers(user, comp)
    project = models.Project(id=uuid.uuid4(), company_id=comp.id, name="Plant N", status="Ongoing")
    db.add(project)
    db.commit()
    r = client.post("/apis/v3/production/recipes", headers=hdr, json={
        "company_id": str(comp.id), "project_id": str(project.id),
        "recipe_code": f"M20N-{tag}", "product_name": "M20 concrete", "mix_type": "concrete",
        "unit": "cum", "target_output_qty": 1, "wastage_pct": 0,
        "materials": [{"material_name": "Cement", "planned_qty": 8, "unit": "bag"}],
    })
    b = client.post("/apis/v3/production/batches", headers=hdr, json={
        "company_id": str(comp.id), "project_id": str(project.id), "recipe_id": r.json()["id"],
        "batch_number": f"BN-{tag}", "planned_output_qty": 2, "status": "running",
    })
    c = client.patch(f"/apis/v3/production/batches/{b.json()['id']}/complete", headers=hdr)
    assert c.status_code == 200, c.text
    assert c.json()["materials"][0]["actual_qty"] == 16
