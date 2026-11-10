"""The Home page's New Project form sent no state, and the server refuses a
project without one (GST depends on it), so creating a project there always
failed. Every screen that creates a project must send the site's state, and
must not invent a project code."""
import pathlib
import re

FRONT = pathlib.Path(__file__).resolve().parents[3] / "frontend" / "src"


def _create_calls():
    for p in FRONT.rglob("*.tsx"):
        s = p.read_text(encoding="utf-8")
        for m in re.finditer(r"/apis/v3/(?:planning/)?projects/?`", s):
            body = s[m.end():m.end() + 900]
            if 'method: "POST"' in body[:200]:
                yield p, body


def test_every_project_create_sends_state():
    calls = list(_create_calls())
    assert calls, "no project-create calls found; the search pattern is stale"
    missing = [str(p.relative_to(FRONT)) for p, body in calls if not re.search(r"\bstate\s*:", body)]
    assert not missing, f"project created without the site's state: {missing}"


def test_no_random_project_code():
    bad = [str(p.relative_to(FRONT)) for p, body in _create_calls() if "Math.random" in body]
    assert not bad, bad
