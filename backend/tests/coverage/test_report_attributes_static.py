import ast
import inspect
import os
import pytest

from app.routers import reports
from app import models

def test_all_82_report_handlers_attribute_integrity():
    """R2-800: Statically assert that every attribute accessed on a model instance
    across all 82 report handlers in reports.py actually exists on its SQLAlchemy model class.
    """
    model_classes = {}
    for name in dir(models):
        obj = getattr(models, name)
        if inspect.isclass(obj) and hasattr(obj, "__tablename__"):
            model_classes[name] = obj

    reports_file = os.path.abspath(reports.__file__)
    with open(reports_file, "r", encoding="utf-8") as f:
        source_code = f.read()
        tree = ast.parse(source_code, filename="reports.py")

    func_defs = {}
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            func_defs[node.name] = node

    report_handlers = reports._REPORT_HANDLERS
    assert len(report_handlers) == 78, f"Expected 78 handlers (four reports with no source removed), found {len(report_handlers)}"

    issues = []

    for slug, handler in report_handlers.items():
        func_name = handler.__name__
        func_ast = func_defs.get(func_name)
        if not func_ast:
            continue
        
        instance_vars = {}
        query_vars = {}

        for stmt in ast.walk(func_ast):
            if isinstance(stmt, ast.Assign):
                val = stmt.value
                target_names = [t.id for t in stmt.targets if isinstance(t, ast.Name)]
                
                for subnode in ast.walk(val):
                    if isinstance(subnode, ast.Call) and isinstance(subnode.func, ast.Attribute) and subnode.func.attr == "query":
                        if subnode.args and isinstance(subnode.args[0], ast.Name) and subnode.args[0].id in model_classes:
                            m_name = subnode.args[0].id
                            if isinstance(val, ast.Call) and isinstance(val.func, ast.Attribute) and val.func.attr in ("first", "one", "one_or_none", "get"):
                                for tname in target_names:
                                    instance_vars[tname] = m_name
                            elif isinstance(val, ast.IfExp):
                                for tname in target_names:
                                    instance_vars[tname] = m_name
                            else:
                                for tname in target_names:
                                    query_vars[tname] = m_name
                            break
            
            elif isinstance(stmt, ast.For):
                iter_node = stmt.iter
                target = stmt.target
                if isinstance(target, ast.Name):
                    tname = target.id
                    for subnode in ast.walk(iter_node):
                        if isinstance(subnode, ast.Name) and subnode.id in query_vars:
                            instance_vars[tname] = query_vars[subnode.id]
                            break
                        elif isinstance(subnode, ast.Call) and isinstance(subnode.func, ast.Attribute) and subnode.func.attr == "query":
                            if subnode.args and isinstance(subnode.args[0], ast.Name) and subnode.args[0].id in model_classes:
                                instance_vars[tname] = subnode.args[0].id
                                break

        for node in ast.walk(func_ast):
            if isinstance(node, ast.Attribute) and isinstance(node.value, ast.Name):
                var_name = node.value.id
                attr_name = node.attr
                if var_name in instance_vars:
                    m_name = instance_vars[var_name]
                    m_cls = model_classes[m_name]
                    valid_attrs = set(dir(m_cls))
                    if hasattr(m_cls, "__table__"):
                        valid_attrs.update(c.name for c in m_cls.__table__.columns)
                    if attr_name not in valid_attrs:
                        issues.append({
                            "slug": slug,
                            "func": func_name,
                            "line": getattr(node, "lineno", 0),
                            "model": m_name,
                            "var": var_name,
                            "attr": attr_name
                        })

    formatted = [f"[{i['slug']}] {i['func']}: line {i['line']} -> {i['model']}.{i['attr']} (var: {i['var']})" for i in issues]
    assert len(issues) == 0, f"Found {len(issues)} invalid model attribute accesses:\n" + "\n".join(formatted)
