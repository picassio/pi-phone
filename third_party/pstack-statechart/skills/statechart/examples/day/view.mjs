export const title = "a day at the shop";

const PATH = {
  closed: ["closed"],
  brewing: ["getting ready"],
  boiling: ["getting ready"],
  quiet: ["open", "quiet"],
  busy: ["open", "busy"],
  rush: ["open", "a rush"],
  cleaning: ["closing up"],
  counting: ["closing up"],
};

export const state = (v) => PATH[v.phase];

const STEPS = {
  Unlock: "7 am",
  TeaSteeped: "tea steeped",
  DoorsOpen: "tea and pearls ready",
  PeopleComeIn: "people come in",
  SchoolLetsOut: "school's out",
  RushPasses: "it calms down",
  DoorsClose: "9 pm [if quiet]",
  FloorMopped: "floor mopped",
  TillAddsUp: "till counted",
};

export const step = (action) => STEPS[action];
