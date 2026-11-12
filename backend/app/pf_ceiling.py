"""The company's PF wage ceiling, read the same way everywhere.

Both settings screens write Company.pf_wage_ceiling (the payroll settings
screen also keeps a copy on CompanyPayrollSettings). Payroll read the company
first and reports read the copy first, so after a change on the company
settings screen the two disagreed.
"""
STATUTORY_PF_CEILING = 15000.0


def pf_wage_ceiling_for(db, company_id) -> float:
    from app.models import Company, CompanyPayrollSettings
    company = db.query(Company).filter(Company.id == company_id).first()
    value = getattr(company, "pf_wage_ceiling", None) if company else None
    if value is None:
        row = db.query(CompanyPayrollSettings).filter(CompanyPayrollSettings.company_id == company_id).first()
        value = getattr(row, "pf_wage_ceiling", None) if row else None
    return float(value) if value is not None else STATUTORY_PF_CEILING
