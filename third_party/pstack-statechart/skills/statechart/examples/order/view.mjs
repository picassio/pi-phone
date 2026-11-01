export const title = "an order of boba";

export const state = (v) => v.order;

const STEPS = {
  YouOrder: "you order",
  YouPay: "you pay",
  PearlsRunOut: "the pearls run out",
  BaristaStarts: "the barista starts [if there are pearls]",
  MoneyBack: "money back [if the pearls ran out]",
  NumberCalled: "your number is called",
  WrongDrink: "it's the wrong drink",
  YouPickItUp: "you pick it up",
  Done: "you drink it",
};

export const step = (action) => STEPS[action];
