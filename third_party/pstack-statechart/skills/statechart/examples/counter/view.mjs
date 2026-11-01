export const title = "behind the counter";

const BARISTA = { free: "barista free", making: "making a drink", calling: "calling a number" };
const POT = { full: "full of pearls", low: "running low", cooking: "cooking pearls" };

export const state = (v) => ({ "the barista": BARISTA[v.barista], "the pot": POT[v.pot] });

const STEPS = {
  OrderComesIn: "an order comes in",
  ShakenAndSealed: "shaken and sealed",
  PickedUp: "picked up",
  PearlsRunLow: "pearls run low",
  NewBatch: "a new batch",
  ChewyAgain: "chewy again",
};

export const step = (action) => STEPS[action];
