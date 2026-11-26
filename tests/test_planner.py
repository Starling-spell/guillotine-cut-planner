import hashlib
import json
import re
import sys
from functools import lru_cache
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[1]
PREFIX = "Starling-spell/guillotine-cut-planner/" + "a" * 40 + "/fixtures/"


@pytest.fixture
def planner(direct_deploy):
    instance = direct_deploy(str(ROOT / "contracts/GuillotineCutPlanner.py"))
    return instance, sys.modules[type(instance._instance).__module__]


def mock(vm, name, orientation, tampered=False):
    body = (ROOT / "fixtures" / (name + ".json")).read_bytes()
    path = PREFIX + name + ".json"
    vm.clear_mocks()
    vm.mock_web(re.escape("https://raw.githubusercontent.com/" + path) + "$", {
        "method": "GET", "response": {"status": 200, "headers": {}, "body": body + (b" " if tampered else b"")},
    })
    vm.mock_llm(r".*GUILLOTINE ORIENTATION EXTRACTION.*", json.dumps({"orientation": orientation}))
    return path, hashlib.sha256(body).hexdigest()


def verify_witness(width, height, part_sizes, kerf, plan):
    available = {(0, 0, width, height)}
    for cut in plan["cuts"]:
        box = tuple(cut["box"])
        available.remove(box)
        x, y, w, h = box
        offset = cut["offset"]
        if cut["axis"] == "X":
            assert 0 < offset <= w - max(1, kerf)
            available.add((x, y, offset, h))
            if offset + kerf < w:
                available.add((x + offset + kerf, y, w - offset - kerf, h))
        else:
            assert cut["axis"] == "Y"
            assert 0 < offset <= h - max(1, kerf)
            available.add((x, y, w, offset))
            if offset + kerf < h:
                available.add((x, y + offset + kerf, w, h - offset - kerf))
    for piece in plan["pieces"]:
        available.remove(tuple(piece))
        assert tuple(piece[2:]) in part_sizes
    assert plan["count"] == len(plan["pieces"])
    part_w, part_h = next(iter(part_sizes))
    assert plan["waste_area"] == width * height - plan["count"] * part_w * part_h


@pytest.mark.parametrize(("name", "orientation", "expected"), [("fixed", "FIXED", 2), ("rotatable", "ROTATE", 3)])
def test_orientation_changes_onchain_plan(planner, direct_vm, name, orientation, expected):
    contract, _ = planner
    args = mock(direct_vm, name, orientation)
    key = contract.register_order(*args)
    assert key == args[1]
    assert direct_vm.run_validator()
    assert contract.get_order(key)["orientation"] == orientation
    result = contract.plan(key, 5, 5, 0)
    assert result["guaranteed"] == result["possible"]
    assert result["guaranteed"]["count"] == expected
    allowed = {(3, 2), (2, 3)} if orientation == "ROTATE" else {(3, 2)}
    verify_witness(5, 5, allowed, 0, result["guaranteed"])


def test_validator_rejects_changed_authorization_and_tampered_text(planner, direct_vm):
    contract, _ = planner
    args = mock(direct_vm, "fixed", "FIXED")
    contract.register_order(*args)
    mock(direct_vm, "fixed", "ROTATE")
    assert not direct_vm.run_validator()
    mock(direct_vm, "fixed", "FIXED", tampered=True)
    assert not direct_vm.run_validator()
    assert contract.register_order(*args) == args[1]


def test_unknown_and_kerf(planner, direct_vm):
    contract, _ = planner
    key = contract.register_order(*mock(direct_vm, "fixed", "UNKNOWN"))
    assert direct_vm.run_validator()
    result = contract.plan(key, 5, 5, 0)
    assert result["guaranteed"]["count"] == 2
    assert result["possible"]["count"] == 3
    with_kerf = contract.plan(key, 5, 5, 1)
    assert with_kerf["possible"]["count"] < result["possible"]["count"]
    verify_witness(5, 5, {(3, 2), (2, 3)}, 1, with_kerf["possible"])
    with direct_vm.expect_revert("Stock dimensions or kerf out of range"):
        contract.plan(key, 25, 5, 0)


def test_optimal_plans_match_recursive_enumeration(planner):
    _, module = planner
    for part in [(2, 2), (2, 3), (3, 4)]:
        for kerf in range(3):
            for rotate in (False, True):
                allowed = {part, part[::-1]} if rotate else {part}

                @lru_cache(None)
                def maximum(w, h):
                    if not w or not h:
                        return 0
                    if (w, h) in allowed:
                        return 1
                    values = [0]
                    for width in range(1, w):
                        if width + kerf <= w:
                            values.append(maximum(width, h) + maximum(w - width - kerf, h))
                    for height in range(1, h):
                        if height + kerf <= h:
                            values.append(maximum(w, height) + maximum(w, h - height - kerf))
                    return max(values)

                for w in range(1, 9):
                    for h in range(1, 9):
                        plan = module.optimize(w, h, part, kerf, rotate)
                        assert plan["count"] == maximum(w, h)
                        verify_witness(w, h, allowed, kerf, plan)
