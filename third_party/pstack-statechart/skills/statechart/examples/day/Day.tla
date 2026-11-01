---- MODULE Day ----
VARIABLES phase, teaReady, pearlsReady, crowd, mopped

vars == <<phase, teaReady, pearlsReady, crowd, mopped>>

Phases == {"closed", "brewing", "boiling", "quiet", "busy", "rush", "cleaning", "counting"}

Init ==
  /\ phase = "closed"
  /\ teaReady = FALSE
  /\ pearlsReady = FALSE
  /\ crowd = 0
  /\ mopped = FALSE

Unlock ==
  /\ phase = "closed"
  /\ phase' = "brewing"
  /\ UNCHANGED <<teaReady, pearlsReady, crowd, mopped>>

TeaSteeped ==
  /\ phase = "brewing"
  /\ phase' = "boiling"
  /\ teaReady' = TRUE
  /\ UNCHANGED <<pearlsReady, crowd, mopped>>

DoorsOpen ==
  /\ phase = "boiling"
  /\ phase' = "quiet"
  /\ pearlsReady' = TRUE
  /\ UNCHANGED <<teaReady, crowd, mopped>>

PeopleComeIn ==
  /\ phase = "quiet"
  /\ phase' = "busy"
  /\ crowd' = 1
  /\ UNCHANGED <<teaReady, pearlsReady, mopped>>

SchoolLetsOut ==
  /\ phase = "busy"
  /\ phase' = "rush"
  /\ crowd' = 2
  /\ UNCHANGED <<teaReady, pearlsReady, mopped>>

RushPasses ==
  /\ phase = "rush"
  /\ phase' = "quiet"
  /\ crowd' = 0
  /\ UNCHANGED <<teaReady, pearlsReady, mopped>>

DoorsClose ==
  /\ phase = "quiet"
  /\ crowd = 0
  /\ phase' = "cleaning"
  /\ UNCHANGED <<teaReady, pearlsReady, crowd, mopped>>

FloorMopped ==
  /\ phase = "cleaning"
  /\ phase' = "counting"
  /\ mopped' = TRUE
  /\ UNCHANGED <<teaReady, pearlsReady, crowd>>

TillAddsUp ==
  /\ phase = "counting"
  /\ phase' = "closed"
  /\ teaReady' = FALSE
  /\ pearlsReady' = FALSE
  /\ mopped' = FALSE
  /\ UNCHANGED crowd

Next ==
  \/ Unlock \/ TeaSteeped \/ DoorsOpen \/ PeopleComeIn \/ SchoolLetsOut
  \/ RushPasses \/ DoorsClose \/ FloorMopped \/ TillAddsUp

Spec == Init /\ [][Next]_vars

TypeOK ==
  /\ phase \in Phases
  /\ teaReady \in BOOLEAN
  /\ pearlsReady \in BOOLEAN
  /\ crowd \in {0, 1, 2}
  /\ mopped \in BOOLEAN

OpenOnlyWhenReady == phase \in {"quiet", "busy", "rush"} => teaReady /\ pearlsReady
CloseOnlyWhenEmpty == phase \in {"cleaning", "counting"} => crowd = 0
CountAfterMopping == phase = "counting" => mopped
====
