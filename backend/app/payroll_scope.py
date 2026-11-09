"""Which payroll counts as a project's labour cost.

A payroll run made for a project counts in full. A company-wide run (no
project, the way most firms run payroll) counts the lines of staff posted
to that project. Matching on the run's project alone dropped every
company-wide run, so labour cost read zero on every site.
"""
from sqlalchemy import and_, or_

from app.models import PayrollLineItem, PayrollRun, StaffEmployee


def for_project(query, project_id):
    """Narrow a PayrollLineItem query, already joined to PayrollRun, to one project."""
    return query.join(StaffEmployee, StaffEmployee.id == PayrollLineItem.employee_id).filter(
        or_(
            PayrollRun.project_id == project_id,
            and_(PayrollRun.project_id.is_(None), StaffEmployee.project_id == project_id),
        )
    )
