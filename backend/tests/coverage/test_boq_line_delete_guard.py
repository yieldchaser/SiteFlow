"""A BOQ line that a task measures against cannot be deleted out from under
it; an unused line can."""
import uuid

from app import models
from tests.coverage.test_domain_formula_fixes import _mk_project, _utc

_TAG = uuid.uuid4().hex[:8]
_MOB = "+9176" + str(int(_TAG, 16))[-8:]
_MAIL = f"boq-{_TAG}@test.com"


def test_linked_boq_line_is_not_deleted(client, db, make_tenant, auth_headers):
    comp, user, _team = make_tenant(company_name="BQ1", user_name="UBQ1", mobile=_MOB, email=_MAIL)
    hdr = auth_headers(user, comp)
    project = _mk_project(db, comp)
    used = models.BOQItem(id=uuid.uuid4(), project_id=project.id, section_name="S",
                          item_name="Slab", unit="sqm", quantity=100.0)
    spare = models.BOQItem(id=uuid.uuid4(), project_id=project.id, section_name="S",
                           item_name="Spare", unit="sqm", quantity=10.0)
    db.add_all([used, spare])
    db.flush()
    db.add(models.Task(id=uuid.uuid4(), project_id=project.id, name="Slab L1", status="in_progress",
                       duration_days=5, start_date=_utc(2026, 1, 1), end_date=_utc(2026, 1, 10),
                       boq_item_id=used.id))
    db.commit()

    r = client.delete(f"/apis/v3/budgeting/boq/{used.id}", headers=hdr)
    assert r.status_code == 409, r.text
    assert "1 task" in r.json()["detail"]
    db.expire_all()
    assert db.get(models.BOQItem, used.id) is not None

    r = client.delete(f"/apis/v3/budgeting/boq/{spare.id}", headers=hdr)
    assert r.status_code == 204, r.text
