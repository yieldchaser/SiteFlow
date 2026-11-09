"""Professional tax (PT) by state.

PT is a state tax on salaries, deducted from the employee's monthly pay. Each
state sets its own slabs on monthly gross. The company picks its state in
payroll settings; a person can be marked as not liable (for example a
disabled employee, or staff the company pays PT for elsewhere).

Slabs are monthly gross upper bounds with the tax for that slab. Where a
state collects a higher amount in one month to make up the yearly total
(Maharashtra and Karnataka in February), that month is listed separately.
"""
from typing import Optional

# state -> (slabs [(upper_bound_inclusive_or_None, monthly_tax)], {month: tax_for_top_slab})
PT_SLABS: dict = {
    "Maharashtra": ([(7500, 0), (10000, 175), (None, 200)], {2: 300}),
    "Gujarat": ([(11999, 0), (None, 200)], {}),
    "Karnataka": ([(24999, 0), (None, 200)], {2: 300}),
    "West Bengal": ([(10000, 0), (15000, 110), (25000, 130), (40000, 150), (None, 200)], {}),
    "Telangana": ([(15000, 0), (20000, 150), (None, 200)], {}),
    "Andhra Pradesh": ([(15000, 0), (20000, 150), (None, 200)], {}),
    "Madhya Pradesh": ([(18750, 0), (25000, 125), (33333, 167), (None, 208)], {3: 212}),
    "Odisha": ([(13304, 0), (25000, 125), (None, 200)], {3: 300}),
    "Assam": ([(10000, 0), (15000, 150), (25000, 180), (None, 208)], {}),
    "Kerala": ([(11999, 0), (17999, 120), (29999, 180), (44999, 300), (99999, 450), (124999, 1000), (None, 1250)], {}),
}

PT_STATES = sorted(PT_SLABS)

# Where women pay on different slabs. Maharashtra exempts women earning up
# to Rs 25,000 a month; above that they pay like everyone else.
PT_SLABS_WOMEN: dict = {
    "Maharashtra": ([(25000, 0), (None, 200)], {2: 300}),
}


def professional_tax(state: Optional[str], monthly_gross: float, month: int, gender: Optional[str] = None) -> float:
    """Monthly PT for this gross in this state. 0 for an unknown or unset state."""
    state = (state or "").strip()
    entry = PT_SLABS.get(state)
    if (gender or "").lower() == "female" and state in PT_SLABS_WOMEN:
        entry = PT_SLABS_WOMEN[state]
    if not entry or monthly_gross <= 0:
        return 0.0
    slabs, month_override = entry
    for bound, tax in slabs:
        if bound is None or monthly_gross <= bound:
            if bound is None and month in month_override:
                return float(month_override[month])
            return float(tax)
    return 0.0
