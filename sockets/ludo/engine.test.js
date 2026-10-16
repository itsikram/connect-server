const test = require("node:test");
const assert = require("node:assert/strict");
const { rulesFor, boardSeatOf, turnOrderFor, FULL_PATH_LENGTH } = require("./engine");

const rules = rulesFor();
const seats = (...pieces) => pieces.map((p) => ({ pieces: p }));

// Steps of seat `seat` that land on the same square as `steps` of seat 0.
const stepsOnSameCell = (seat, steps, count = 4) => {
  const target = rules.cellOf(0, steps, count);
  for (let s = 1; s < rules.maxSteps; s += 1) {
    const cell = rules.cellOf(seat, s, count);
    if (cell && cell.x === target.x && cell.y === target.y) return s;
  }
  return -1;
};

test("board geometry matches the clients", () => {
  assert.equal(FULL_PATH_LENGTH, 57);
  assert.equal(rules.maxSteps, 57);
  assert.equal(boardSeatOf(1, 2), 3);
  assert.equal(boardSeatOf(1, 3), 1);
  assert.deepEqual(turnOrderFor(4), [0, 1, 3, 2]);
  assert.deepEqual(turnOrderFor(3), [0, 1, 2]);
  assert.deepEqual(turnOrderFor(2), [0, 1]);
  assert.deepEqual(rules.cellOf(0, 1, 4), { x: 1, y: 6 });
  assert.equal(rules.cellOf(0, 0, 4), null);
});

test("legal moves: a 6 leaves the yard, no overshooting home", () => {
  assert.deepEqual(rules.legalPieces([0, 0, 0, 0], 5), []);
  assert.deepEqual(rules.legalPieces([0, 0, 0, 0], 6), [0, 1, 2, 3]);
  assert.deepEqual(rules.legalPieces([55, 0, 57, 10], 3), [3]);
  assert.deepEqual(rules.legalPieces([55, 0, 57, 10], 2), [0, 3]);
  assert.equal(rules.targetSteps(0, 6), 1);
  assert.equal(rules.targetSteps(56, 2), -1);
  assert.equal(rules.targetSteps(57, 1), -1);
});

test("a single piece captures a single opponent piece", () => {
  const to = 10; // (6,2): not a safe square
  const opp = stepsOnSameCell(1, to);
  assert.ok(opp > 0);
  const board = seats([to, 0, 0, 0], [opp, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]);
  assert.deepEqual(rules.capturesAfterMove(board, 0, 7, to, 4), [{ seat: 1, piece: 0 }]);
});

test("safe squares and home columns never capture", () => {
  // Step 1 is a start square (safe).
  const opp = stepsOnSameCell(3, 1);
  const board = seats([1, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [opp, 0, 0, 0]);
  assert.deepEqual(rules.capturesAfterMove(board, 0, 0, 1, 4), []);
  assert.ok(rules.isHomeColumn(rules.maxSteps - 1));
});

test("pairs: a pair is only captured by a pair; three is a blockade", () => {
  const to = 10;
  const opp = stepsOnSameCell(1, to);
  const pairVsSingle = seats([to, 0, 0, 0], [opp, opp, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]);
  assert.deepEqual(rules.capturesAfterMove(pairVsSingle, 0, 5, to, 4), []);

  const pairVsPair = seats([to, to, 0, 0], [opp, opp, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]);
  assert.deepEqual(
    rules.capturesAfterMove(pairVsPair, 0, 5, to, 4).sort((a, b) => a.piece - b.piece),
    [{ seat: 1, piece: 0 }, { seat: 1, piece: 1 }],
  );

  const pairVsThree = seats([to, to, 0, 0], [opp, opp, opp, 0], [0, 0, 0, 0], [0, 0, 0, 0]);
  assert.deepEqual(rules.capturesAfterMove(pairVsThree, 0, 5, to, 4), []);
});

test("leaving a stack of two captures a lone opponent left on it", () => {
  const from = 10;
  const opp = stepsOnSameCell(1, from);
  // Seat 0 had three pieces on `from`; one moves on to 14, two stay.
  const board = seats([14, from, from, 0], [opp, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]);
  assert.deepEqual(rules.capturesAfterMove(board, 0, from, 14, 4), [{ seat: 1, piece: 0 }]);
});

test("two-player games use the opposite corner for the second player", () => {
  const short = rulesFor(8);
  assert.equal(short.maxSteps, 8);
  assert.deepEqual(short.cellOf(1, 8, 2), { x: 8, y: 7 }); // Yellow home
  assert.deepEqual(short.cellOf(0, 8, 2), { x: 6, y: 7 }); // Red home
});

test("the computer prefers a capture and brings pieces home", () => {
  const to = 20;
  const opp = stepsOnSameCell(1, to);
  const board = seats([16, 3, 0, 0], [opp, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]);
  assert.equal(rules.pickBotPiece(board, 0, 4, 4), 0);

  const home = seats([53, 3, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]);
  assert.equal(rules.pickBotPiece(home, 0, 4, 4), 0);
  assert.equal(rules.pickBotPiece(seats([0, 0, 0, 0]), 0, 5, 4), -1);
});

test("identical moves are recognised (any yard piece on a six)", () => {
  assert.equal(rules.distinctMoves([0, 0, 0, 0], [0, 1, 2, 3]), 1);
  assert.equal(rules.distinctMoves([0, 5, 0, 0], [0, 1, 2, 3]), 2);
});
