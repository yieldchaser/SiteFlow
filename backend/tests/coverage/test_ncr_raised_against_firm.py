"""An NCR can name the subcontractor it is raised against, only one of the
company's own; and the subcontractor list carries the library party id that
project screens filter on."""
import uuid

from app import models
from tests.coverage.test_domain_formula_fixes import _mk_project

_TAG = uuid.uuid4().hex[:8]
_MOB = "+9175" + str(int(_TAG, 16))[-8:]
_MAIL = f"ncr-{_TAG}@test.com"


def test_ncr_vendor_must_be_own_company(client, db, make_tenant, auth_headers):
    comp, user, team = make_tenant(company_name="NCR1", user_name="UNCR1", mobile=_MOB, email=_MAIL)
    hdr = auth_headers(user, comp)
    project = _mk_project(db, comp)
    other = models.Company(id=uuid.uuid4(), name="Other Co")
    db.add(other)
    db.flush()
    foreign = models.CompanyTeam(id=uuid.uuid4(), company_id=other.id, priority_type="subcontractor")
    db.add(foreign)
    db.commit()

    body = {"project_id": str(project.id), "title": "Honeycombing", "severity": "Major"}
    r = client.post("/apis/v3/quality/ncr", json={**body, "vendor_id": str(foreign.id)}, headers=hdr)
    assert r.status_code == 400, r.text

    r = client.post("/apis/v3/quality/ncr", json={**body, "vendor_id": str(team.id)}, headers=hdr)
    assert r.status_code == 201, r.text
    assert r.json()["vendor_id"] == str(team.id)


def test_subcontractor_list_has_library_party_id(client, db, make_tenant, auth_headers):
    tag = uuid.uuid4().hex[:8]
    comp, user, _ = make_tenant(company_name="NCR2", user_name="UNCR2",
                                mobile="+9174" + str(int(tag, 16))[-8:], email=f"ncr2-{tag}@test.com")
    hdr = auth_headers(user, comp)
    lp = models.LibraryParty(id=uuid.uuid4(), company_id=comp.id, name="Crew Co", party_type="Subcontractor")
    db.add(lp)
    db.commit()
    rows = client.get(f"/apis/v3/billing/subcontractors?company_id={comp.id}", headers=hdr).json()
    row = next(x for x in rows if x["name"] == "Crew Co")
    assert row["library_party_id"] == str(lp.id)
