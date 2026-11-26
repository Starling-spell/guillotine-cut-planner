# GuillotineCutPlanner

GuillotineCutPlanner finds the maximum number of identical rectangular parts that can be cut from a rectangular sheet. Each cut crosses one current rectangle from edge to edge. The work order governs whether a part may be turned 90 degrees.

`register_order(coordinate, commitment)` takes a full GitHub commit path and the exact SHA-256 of a JSON order containing the listed dimensions and a prose instruction. The leader and validators independently fetch and check the complete order. Each uses an LLM to interpret the current rotation permission. Agreement compares the complete text, dimensions, and exact permission label.

`get_order(commitment)` returns the agreed evidence. `plan(commitment, width, height, kerf)` considers integer stock dimensions 1 through 24 and kerf 0 through 2. It searches all legal vertical and horizontal splits by dynamic programming. Each plan returns cuts in parent-first order, piece rectangles, and waste area including kerf. All box coordinates are `[x, y, width, height]`. Each cut's offset is measured from the lower-left corner along the cut axis, and the kerf follows the offset.

The model treats the listed orientation as usable. An unresolved instruction gives one plan with optional rotation excluded and one with optional rotation enabled. The fictional fixtures compare two work orders for a 3-by-2 part on 5-by-5 stock with zero kerf. The fixed order yields two pieces. The rotated order yields three.

Install `requirements-dev.txt`, then run `python -m pytest tests -q` and `genvm-lint check contracts/GuillotineCutPlanner.py`.
