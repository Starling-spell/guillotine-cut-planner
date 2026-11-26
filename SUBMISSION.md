# GuillotineCutPlanner — Verified Work Orders and Optimal Sheet Cuts

**Contribution type** Builder → Intelligent Contracts

GuillotineCutPlanner finds the largest number of identical rectangular parts that can be cut from one sheet. It considers all feasible full-span splits and accounts for the material consumed by each cut. Its result includes the ordered cuts and exact piece rectangles.

Each validator and the leader independently fetch the complete commit-pinned work order, check its SHA-256, and use an LLM to determine the current rotation permission. Consensus compares the full evidence, dimensions, and permission exactly. The permission controls which placements the optimizer can consider.

The two fictional work orders specify the same 3-by-2 part. A 5-by-5 sheet with zero kerf yields two pieces under the fixed-orientation order and three when rotation is permitted. An unresolved instruction yields both outcomes for the two rotation assumptions.

GenVM lint and five local tests passed. The test suite checked 1,152 cases against recursive full-span split enumeration and replayed each returned plan.

[GitHub repository](https://github.com/Starling-spell/guillotine-cut-planner)

StudioNet deployment is pending. The work-order fixtures and exact plans have been validated locally.
