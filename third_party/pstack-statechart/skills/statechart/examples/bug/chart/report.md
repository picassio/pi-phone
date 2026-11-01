# Bug

TLC reached 36 states and 90 steps. The chart draws 6 states and 8 arrows.
The chart does not draw 66 steps that stay in one chart state.

## NeverServeOldPearls breaks
The shortest path has 6 steps:
0. just boiled
1. an hour passes: chewy
2. an hour passes: chewy
3. an hour passes: getting firm
4. an hour passes: too old
5. a rush starts: too old
6. a cup is served [in a rush]: an old cup is served

## Rules that hold
TypeOK, NoDeadlock
