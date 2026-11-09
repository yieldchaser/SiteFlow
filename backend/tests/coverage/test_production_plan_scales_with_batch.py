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
