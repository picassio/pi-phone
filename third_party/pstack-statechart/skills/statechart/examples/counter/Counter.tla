---- MODULE Counter ----
VARIABLES barista, pot

vars == <<barista, pot>>

Init ==
  /\ barista = "free"
  /\ pot = "full"

OrderComesIn ==
  /\ barista = "free"
  /\ pot # "cooking"
  /\ barista' = "making"
  /\ UNCHANGED pot

ShakenAndSealed ==
  /\ barista = "making"
  /\ barista' = "calling"
  /\ UNCHANGED pot

PickedUp ==
  /\ barista = "calling"
  /\ barista' = "free"
  /\ UNCHANGED pot

PearlsRunLow ==
  /\ pot = "full"
  /\ pot' = "low"
  /\ UNCHANGED barista

NewBatch ==
  /\ pot = "low"
  /\ barista = "free"
  /\ pot' = "cooking"
  /\ UNCHANGED barista

ChewyAgain ==
  /\ pot = "cooking"
  /\ pot' = "full"
  /\ UNCHANGED barista

Next == OrderComesIn \/ ShakenAndSealed \/ PickedUp \/ PearlsRunLow \/ NewBatch \/ ChewyAgain

Spec == Init /\ [][Next]_vars

TypeOK ==
  /\ barista \in {"free", "making", "calling"}
  /\ pot \in {"full", "low", "cooking"}

NoDrinkWhileCooking == barista # "free" => pot # "cooking"
====
