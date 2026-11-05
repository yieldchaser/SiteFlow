"""The same person cannot be added twice as an employee.

Raised during the VCPL rollout (2026-11-05): the assistant enters staff from
Excel sheets sent by each site, so one person can arrive twice. Matching is on
mobile, UAN and employee code, never on name alone.
"""
import uuid

_SFX = uuid.uuid4().hex[:6]
URL = "/apis/v3/hr/employees"


def test_no_duplicate_employee(client, make_tenant, auth_headers):
    company, owner, _ = make_tenant(company_name=f"Dup Co {_SFX}", user_name="Owner",
                                    email=f"dup-{_SFX}@example.com")
    other, other_owner, _ = make_tenant(company_name=f"Dup Other {_SFX}", user_name="Other",
                                        email=f"dupo-{_SFX}@example.com")
    h = auth_headers(owner, company)
    base = {"company_id": str(company.id), "basic_salary": 18000}

    r = client.post(URL, headers=h, json={**base, "name": "Ramesh", "mobile": "98765 43210",
                                          "uan": "100200300400", "employee_code": "emp-001"})
    assert r.status_code == 201, r.text
    ramesh = r.json()

    for dup in ({"mobile": "+91 9876543210"}, {"uan": "100200300400"}, {"employee_code": "EMP-001"}):
        r = client.post(URL, headers=h, json={**base, "name": "Ramesh K", **dup})
        assert r.status_code == 409, (dup, r.text)
        assert "Ramesh" in r.json()["detail"]

    # Same name, different person: allowed.
    r = client.post(URL, headers=h, json={**base, "name": "Ramesh", "mobile": "9000000001"})
    assert r.status_code == 201, r.text
    second = r.json()

    # Editing someone onto another person's mobile is refused; saving yourself is not.
    r = client.put(f"{URL}/{second['id']}", headers=h, json={"mobile": "9876543210"})
    assert r.status_code == 409, r.text
    r = client.put(f"{URL}/{ramesh['id']}", headers=h, json={"mobile": "9876543210"})
    assert r.status_code == 200, r.text

    # Another company may have the same person.
    r = client.post(URL, headers=auth_headers(other_owner, other),
                    json={"company_id": str(other.id), "basic_salary": 1, "name": "Ramesh", "mobile": "9876543210"})
    assert r.status_code == 201, r.text
