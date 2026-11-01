---- MODULE Order ----
EXTENDS Naturals
VARIABLES order, paid, pearls, remakes

vars == <<order, paid, pearls, remakes>>

Init ==
  /\ order = "in line"
  /\ paid = FALSE
  /\ pearls = "plenty"
  /\ remakes = 0

YouOrder ==
  /\ order = "in line"
  /\ order' = "ordered"
  /\ UNCHANGED <<paid, pearls, remakes>>

YouPay ==
  /\ order = "ordered"
  /\ order' = "paid"
  /\ paid' = TRUE
  /\ UNCHANGED <<pearls, remakes>>

PearlsRunOut ==
  /\ pearls = "plenty"
  /\ order \in {"in line", "ordered", "paid"}
  /\ pearls' = "out"
  /\ UNCHANGED <<order, paid, remakes>>

BaristaStarts ==
  /\ order = "paid"
  /\ pearls = "plenty"
  /\ order' = "being made"
  /\ UNCHANGED <<paid, pearls, remakes>>

MoneyBack ==
  /\ order = "paid"
  /\ pearls = "out"
  /\ order' = "refunded"
  /\ paid' = FALSE
  /\ UNCHANGED <<pearls, remakes>>

NumberCalled ==
  /\ order = "being made"
  /\ order' = "ready"
  /\ UNCHANGED <<paid, pearls, remakes>>

WrongDrink ==
  /\ order = "ready"
  /\ remakes < 1
  /\ order' = "being made"
  /\ remakes' = remakes + 1
  /\ UNCHANGED <<paid, pearls>>

YouPickItUp ==
  /\ order = "ready"
  /\ order' = "in your hand"
  /\ UNCHANGED <<paid, pearls, remakes>>

Done ==
  /\ order \in {"in your hand", "refunded"}
  /\ UNCHANGED vars

Next ==
  \/ YouOrder \/ YouPay \/ PearlsRunOut \/ BaristaStarts \/ MoneyBack
  \/ NumberCalled \/ WrongDrink \/ YouPickItUp \/ Done

Spec == Init /\ [][Next]_vars

TypeOK ==
  /\ order \in {"in line", "ordered", "paid", "being made", "ready", "in your hand", "refunded"}
  /\ paid \in BOOLEAN
  /\ pearls \in {"plenty", "out"}
  /\ remakes \in 0..1

PaidForEveryDrink == order \in {"being made", "ready", "in your hand"} => paid
RefundsGiveMoneyBack == order = "refunded" => ~paid
NoDrinkWithoutPearls == order = "being made" => pearls = "plenty" \/ remakes > 0
====
