export const title = "the pearl bug";

const AGE = ["just boiled", "chewy", "chewy", "getting firm", "too old"];

export const state = (v) =>
  v.served === "an old cup" ? "an old cup is served"
  : v.batch === "thrown out" ? "thrown out"
  : AGE[v.age];

const STEPS = {
  AnHourPasses: "an hour passes",
  ServeACup: "a cup is served",
  RushStarts: "a rush starts",
  RushEnds: "the rush ends",
  ThrowOut: "thrown out",
  NewBatch: "a new batch is boiled",
};

export const step = (action, from, to) =>
  action === "ServeACup" && to.served === "an old cup" ? "a cup is served [in a rush]" : STEPS[action];
