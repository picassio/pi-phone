---- MODULE Bug ----
EXTENDS Naturals
VARIABLES age, batch, rush, served

vars == <<age, batch, rush, served>>

Init ==
  /\ age = 0
  /\ batch = "in the pot"
  /\ rush = FALSE
  /\ served = "nothing yet"

AnHourPasses ==
  /\ batch = "in the pot"
  /\ age < 4
  /\ age' = age + 1
  /\ UNCHANGED <<batch, rush, served>>

ServeACup ==
  /\ batch = "in the pot"
  /\ served # "an old cup"
  /\ (age < 4 \/ rush)
  /\ served' = IF age < 4 THEN "a fresh cup" ELSE "an old cup"
  /\ UNCHANGED <<age, batch, rush>>

RushStarts ==
  /\ ~rush
  /\ rush' = TRUE
  /\ UNCHANGED <<age, batch, served>>

RushEnds ==
  /\ rush
  /\ rush' = FALSE
  /\ UNCHANGED <<age, batch, served>>

ThrowOut ==
  /\ batch = "in the pot"
  /\ age = 4
  /\ batch' = "thrown out"
  /\ UNCHANGED <<age, rush, served>>

NewBatch ==
  /\ batch = "thrown out"
  /\ batch' = "in the pot"
  /\ age' = 0
  /\ UNCHANGED <<rush, served>>

Next == AnHourPasses \/ ServeACup \/ RushStarts \/ RushEnds \/ ThrowOut \/ NewBatch

Spec == Init /\ [][Next]_vars

TypeOK ==
  /\ age \in 0..4
  /\ batch \in {"in the pot", "thrown out"}
  /\ rush \in BOOLEAN
  /\ served \in {"nothing yet", "a fresh cup", "an old cup"}

NeverServeOldPearls == served # "an old cup"
====
