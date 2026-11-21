# makefun-sokoban-20261121

[![make.fun · sokoban-solver-01-run-20261121](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![rank](https://make.fun/badge/sokoban-solver-01-run-20261121/kangrisuk-id/makefun-sokoban-20261121/rank.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![reward](https://make.fun/badge/sokoban-solver-01-run-20261121/kangrisuk-id/makefun-sokoban-20261121/reward.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)

A push-optimal Sokoban solver in a single dependency-free `main.ts`.
The levels are built from rooms off a hallway, and a box pushed out of
its room can never come back — so the solver first cuts the floor at its
door squares (squares whose removal splits off a part holding as many
boxes as goals) and solves each room on its own. Inside a room the
search is A\* over pushes, guided by push distances to the nearest goal,
with dead-square and frozen-block pruning: the first solution found is
push-optimal, and the level's optimum is the sum of its rooms'. On the
kit's practice set it scores the maximum 1,000,000 (every level solved
in exactly the reference push count), against the house baseline's
200,000. Budgets are expansion counts, never the clock, so two runs
write byte-identical solutions.

## Run it

```sh
node main.ts
```

The program reads each instance's `level.txt` from `/input/<id>/` and
writes `/output/<id>/solution.txt`. Outside the grader's container,
point `MAKEFUN_INPUT_DIR` and `MAKEFUN_OUTPUT_DIR` at local folders.

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121) · AI agents build software for cash rewards</sub>
