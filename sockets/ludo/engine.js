// Ludo rules for the server-hosted game. Pure functions over plain data so the
// game host (and its tests) can run them without sockets or a database.
//
// Board geometry and rules match the clients that used to run the game:
// web/src/pages/ludo/constants/gameConstants.js + utils/gameLogic.js and the
// Expo copy in expo-connect-app/src/lib/ludo. A piece's position is its step
// count along its own path: 0 = in the yard, 1..maxSteps on the board, and
// maxSteps = finished (home).

const COLORS = ["#E53935", "#43A047", "#1E88E5", "#FDD835"];
const COLOR_NAMES = ["Red", "Green", "Blue", "Yellow"];
const HOME_COLUMN_LENGTH = 6;
const PIECES_PER_PLAYER = 4;

const FULL_PATHS = {
  0: [
    [1, 6], [2, 6], [3, 6], [4, 6], [5, 6],
    [6, 5], [6, 4], [6, 3], [6, 2], [6, 1],
    [6, 0], [7, 0], [8, 0],
    [8, 1], [8, 2], [8, 3], [8, 4], [8, 5],
    [9, 6], [10, 6], [11, 6], [12, 6], [13, 6],
    [14, 6], [14, 7], [14, 8],
    [13, 8], [12, 8], [11, 8], [10, 8], [9, 8],
    [8, 9], [8, 10], [8, 11], [8, 12], [8, 13],
    [8, 14], [7, 14], [6, 14],
    [6, 13], [6, 12], [6, 11], [6, 10], [6, 9],
    [5, 8], [4, 8], [3, 8], [2, 8], [1, 8],
    [0, 8], [0, 7],
    [1, 7], [2, 7], [3, 7], [4, 7], [5, 7], [6, 7],
  ],
  1: [
    [8, 1], [8, 2], [8, 3], [8, 4], [8, 5],
    [9, 6], [10, 6], [11, 6], [12, 6], [13, 6],
    [14, 6], [14, 7], [14, 8],
    [13, 8], [12, 8], [11, 8], [10, 8], [9, 8],
    [8, 9], [8, 10], [8, 11], [8, 12], [8, 13],
    [8, 14], [7, 14], [6, 14],
    [6, 13], [6, 12], [6, 11], [6, 10], [6, 9],
    [5, 8], [4, 8], [3, 8], [2, 8], [1, 8],
    [0, 8], [0, 7], [0, 6],
    [1, 6], [2, 6], [3, 6], [4, 6], [5, 6],
    [6, 5], [6, 4], [6, 3], [6, 2], [6, 1],
    [6, 0], [7, 0],
    [7, 1], [7, 2], [7, 3], [7, 4], [7, 5], [7, 6],
  ],
  2: [
    [6, 13], [6, 12], [6, 11], [6, 10], [6, 9],
    [5, 8], [4, 8], [3, 8], [2, 8], [1, 8],
    [0, 8], [0, 7], [0, 6],
    [1, 6], [2, 6], [3, 6], [4, 6], [5, 6],
    [6, 5], [6, 4], [6, 3], [6, 2], [6, 1],
    [6, 0], [7, 0], [8, 0],
    [8, 1], [8, 2], [8, 3], [8, 4], [8, 5],
    [9, 6], [10, 6], [11, 6], [12, 6], [13, 6],
    [14, 6], [14, 7], [14, 8],
    [13, 8], [12, 8], [11, 8], [10, 8], [9, 8],
    [8, 9], [8, 10], [8, 11], [8, 12], [8, 13],
    [8, 14], [7, 14],
    [7, 13], [7, 12], [7, 11], [7, 10], [7, 9], [7, 8],
  ],
  3: [
    [13, 8], [12, 8], [11, 8], [10, 8], [9, 8],
    [8, 9], [8, 10], [8, 11], [8, 12], [8, 13],
    [8, 14], [7, 14], [6, 14],
    [6, 13], [6, 12], [6, 11], [6, 10], [6, 9],
    [5, 8], [4, 8], [3, 8], [2, 8], [1, 8],
    [0, 8], [0, 7], [0, 6],
    [1, 6], [2, 6], [3, 6], [4, 6], [5, 6],
    [6, 5], [6, 4], [6, 3], [6, 2], [6, 1],
    [6, 0], [7, 0], [8, 0],
    [8, 1], [8, 2], [8, 3], [8, 4], [8, 5],
    [9, 6], [10, 6], [11, 6], [12, 6], [13, 6],
    [14, 6], [14, 7],
    [13, 7], [12, 7], [11, 7], [10, 7], [9, 7], [8, 7],
  ],
};

const FULL_PATH_LENGTH = FULL_PATHS[0].length;

// Entry and start squares, plus every home-column cell: nobody is captured here.
const SAFE_CELLS = new Set(
  [
    "1,6", "8,1", "6,13", "13,8",
    "7,13", "13,7", "7,2", "2,7",
  ].concat(
    Object.values(FULL_PATHS).flatMap((path) =>
      path.slice(-HOME_COLUMN_LENGTH).map(([x, y]) => `${x},${y}`),
    ),
  ),
);

// In 2-player games the second player sits in the opposite corner (Yellow).
const boardSeatOf = (playerIndex, playerCount) =>
  Number(playerCount) === 2 && Number(playerIndex) === 1 ? 3 : Number(playerIndex);

// Turn order around the board: Red, Green, Yellow, Blue with four players.
const turnOrderFor = (playerCount) =>
  Number(playerCount) === 4 ? [0, 1, 3, 2] : [0, 1, 2].slice(0, Number(playerCount));

const colorFor = (playerIndex, playerCount) => COLORS[boardSeatOf(playerIndex, playerCount)];
const colorNameFor = (playerIndex, playerCount) =>
  COLOR_NAMES[boardSeatOf(playerIndex, playerCount)];

const cache = new Map();

/**
 * Rules bound to a path length. Production games use the full 57-cell paths;
 * tests shorten them (keeping the end of each path) so a match is quick.
 */
const rulesFor = (pathLength = FULL_PATH_LENGTH) => {
  const length = Math.max(
    HOME_COLUMN_LENGTH + 1,
    Math.min(FULL_PATH_LENGTH, Number(pathLength) || FULL_PATH_LENGTH),
  );
  if (cache.has(length)) return cache.get(length);

  const paths = {};
  Object.keys(FULL_PATHS).forEach((seat) => {
    paths[seat] = FULL_PATHS[seat].slice(-length);
  });
  const maxSteps = length;
  const homeStart = maxSteps - (HOME_COLUMN_LENGTH - 1);

  const isHomeColumn = (steps) => steps >= homeStart && steps <= maxSteps;
  const onTrack = (steps) => steps > 0 && steps < maxSteps;

  const cellOf = (playerIndex, steps, playerCount) => {
    const path = paths[boardSeatOf(playerIndex, playerCount)];
    if (!path || steps <= 0 || steps > path.length) return null;
    const [x, y] = path[steps - 1];
    return { x, y };
  };
  const keyOf = (cell) => (cell ? `${cell.x},${cell.y}` : "");
  const isSafe = (cell) => Boolean(cell) && SAFE_CELLS.has(keyOf(cell));

  // Steps after rolling `dice`, or -1 when the piece cannot move.
  const targetSteps = (steps, dice) => {
    if (steps <= 0) return dice === 6 ? 1 : -1;
    if (steps >= maxSteps) return -1;
    const next = steps + dice;
    return next <= maxSteps ? next : -1;
  };

  const legalPieces = (pieces, dice) =>
    (pieces || []).reduce((list, steps, index) => {
      if (targetSteps(Number(steps) || 0, dice) > 0) list.push(index);
      return list;
    }, []);

  // pieces of every seat that stand on `cell` (track pieces only).
  const occupantsAt = (seats, cell, playerCount) => {
    const bySeat = new Map();
    if (!cell) return bySeat;
    const key = keyOf(cell);
    seats.forEach((seat, seatIndex) => {
      (seat?.pieces || []).forEach((steps, pieceIndex) => {
        if (!onTrack(steps)) return;
        if (keyOf(cellOf(seatIndex, steps, playerCount)) !== key) return;
        const list = bySeat.get(seatIndex) || [];
        list.push(pieceIndex);
        bySeat.set(seatIndex, list);
      });
    });
    return bySeat;
  };

  /**
   * Captures caused by moving `mover`'s piece to `to` (the board must already
   * show the piece there). A lone opponent piece is captured; a pair only by
   * a pair (or bigger) of the mover's pieces; three or more are a blockade.
   * Safe squares and home columns never capture. Leaving a square where the
   * mover still keeps two or more pieces also captures a lone opponent there.
   */
  const capturesAfterMove = (seats, mover, from, to, playerCount) => {
    const hits = new Map();
    const add = (seatIndex, pieceIndex) => hits.set(`${seatIndex}:${pieceIndex}`, { seat: seatIndex, piece: pieceIndex });

    if (to > 0 && to < maxSteps) {
      const cell = cellOf(mover, to, playerCount);
      if (!isHomeColumn(to) && !isSafe(cell)) {
        const occupants = occupantsAt(seats, cell, playerCount);
        const moverCount = (occupants.get(mover) || []).length;
        occupants.forEach((pieceIndexes, seatIndex) => {
          if (seatIndex === mover) return;
          const count = pieceIndexes.length;
          if (count === 1 || (count === 2 && moverCount >= 2)) {
            pieceIndexes.forEach((pieceIndex) => add(seatIndex, pieceIndex));
          }
        });
      }

      if (from > 0 && from < maxSteps) {
        const oldCell = cellOf(mover, from, playerCount);
        if (!isSafe(oldCell)) {
          const occupants = occupantsAt(seats, oldCell, playerCount);
          if ((occupants.get(mover) || []).length >= 2) {
            occupants.forEach((pieceIndexes, seatIndex) => {
              if (seatIndex === mover || pieceIndexes.length !== 1) return;
              add(seatIndex, pieceIndexes[0]);
            });
          }
        }
      }
    }
    return Array.from(hits.values());
  };

  // ---- Computer player -----------------------------------------------------

  const ownCountAt = (seats, seatIndex, cell, skipPiece, playerCount) => {
    const key = keyOf(cell);
    return (seats[seatIndex]?.pieces || []).reduce((count, steps, pieceIndex) => {
      if (pieceIndex === skipPiece || !onTrack(steps)) return count;
      return keyOf(cellOf(seatIndex, steps, playerCount)) === key ? count + 1 : count;
    }, 0);
  };

  const opponentHitsAt = (seats, mover, cell, playerCount) => {
    const hits = [];
    const key = keyOf(cell);
    seats.forEach((seat, seatIndex) => {
      if (seatIndex === mover) return;
      (seat?.pieces || []).forEach((steps, pieceIndex) => {
        if (!onTrack(steps) || isHomeColumn(steps)) return;
        if (keyOf(cellOf(seatIndex, steps, playerCount)) === key) {
          hits.push({ seat: seatIndex, piece: pieceIndex, steps });
        }
      });
    });
    return hits;
  };

  const wouldCapture = (seats, mover, cell, to, playerCount) => {
    if (!cell || to <= 0 || to >= maxSteps || isHomeColumn(to) || isSafe(cell)) return [];
    const hits = opponentHitsAt(seats, mover, cell, playerCount);
    if (!hits.length) return [];
    const bySeat = new Map();
    hits.forEach((hit) => bySeat.set(hit.seat, [...(bySeat.get(hit.seat) || []), hit]));
    const landingStack = 1 + ownCountAt(seats, mover, cell, -1, playerCount);
    const captured = [];
    bySeat.forEach((list) => {
      if (list.length >= 2 && landingStack < 2) return;
      captured.push(...list);
    });
    return captured;
  };

  const isThreatened = (seats, owner, cell, skipPiece, playerCount) => {
    if (!cell || isSafe(cell)) return false;
    if (ownCountAt(seats, owner, cell, skipPiece, playerCount) >= 1) return false;
    const key = keyOf(cell);
    return seats.some((seat, seatIndex) => {
      if (seatIndex === owner) return false;
      return (seat?.pieces || []).some((from) => {
        if (!onTrack(from) || isHomeColumn(from)) return false;
        for (let roll = 1; roll <= 6; roll += 1) {
          const to = from + roll;
          if (to > maxSteps || isHomeColumn(to)) continue;
          if (keyOf(cellOf(seatIndex, to, playerCount)) === key) return true;
        }
        return false;
      });
    });
  };

  // Develops several tokens instead of racing one piece home (same scoring as
  // the clients' pickSmartBotPiece).
  const pickBotPiece = (seats, seatIndex, dice, playerCount, legal = null) => {
    const pieces = seats[seatIndex]?.pieces || [];
    const ids = Array.isArray(legal) ? legal : legalPieces(pieces, dice);
    if (ids.length === 0) return -1;
    if (ids.length === 1) return ids[0];

    const inPlay = pieces.filter(onTrack);
    const inPlayCount = inPlay.length;
    const yardCount = pieces.filter((steps) => steps <= 0).length;
    const minInPlay = inPlayCount ? Math.min(...inPlay) : 0;
    const maxInPlay = inPlayCount ? Math.max(...inPlay) : 0;

    let best = ids[0];
    let bestScore = -Infinity;
    ids.forEach((id) => {
      const from = Number(pieces[id]) || 0;
      const to = targetSteps(from, dice);
      if (to < 0) return;
      const leavingYard = from <= 0;
      const dest = cellOf(seatIndex, to, playerCount);
      const fromCell = from > 0 ? cellOf(seatIndex, from, playerCount) : null;
      let score = 0;

      const hits = leavingYard ? [] : wouldCapture(seats, seatIndex, dest, to, playerCount);
      if (hits.length) score += 1400 + hits.reduce((sum, hit) => sum + hit.steps * 3, 0);

      if (to >= maxSteps) score += 1100;
      else if (to >= homeStart) {
        score += 240;
        if (from < homeStart) score += 180;
        score += (to - homeStart) * 30;
      }

      if (leavingYard && dice === 6) {
        score += inPlayCount === 0 ? 460 : inPlayCount === 1 ? 420 : inPlayCount === 2 ? 300 : 90;
      }

      if (!leavingYard && to < homeStart) {
        if (from === minInPlay) score += 160;
        if (from === maxInPlay && inPlayCount >= 2 && maxInPlay - minInPlay > 10) score -= 110;
        if (from === maxInPlay && inPlayCount === 1 && yardCount > 0 && dice === 6) score -= 220;
        score += Math.min(from, 18);
      }

      if (!leavingYard && fromCell && isThreatened(seats, seatIndex, fromCell, id, playerCount)) {
        score += 240;
        if (to >= homeStart || isSafe(dest)) score += 90;
      }

      if (dest && to > 0 && to < maxSteps) {
        if (isSafe(dest) || to >= homeStart) score += 85;
        else if (isThreatened(seats, seatIndex, dest, id, playerCount)) score -= 95;
        if (ownCountAt(seats, seatIndex, dest, id, playerCount) >= 1) score += 55;
      }

      score += (id * 5 + dice) % 9;
      if (score > bestScore) {
        bestScore = score;
        best = id;
      }
    });
    return best;
  };

  // Moves that end on the same square from the same square are the same move
  // (e.g. any yard piece on a 6), so the game can play them automatically.
  const distinctMoves = (pieces, legal) =>
    new Set((legal || []).map((index) => `${pieces[index]}`)).size;

  const piecesFinished = (pieces) =>
    (pieces || []).length > 0 && pieces.every((steps) => steps >= maxSteps);

  const progressOf = (pieces) =>
    (pieces || []).reduce((sum, steps) => sum + Math.max(0, Math.min(maxSteps, steps)), 0);

  const rules = {
    maxSteps,
    pathLength: length,
    homeStart,
    isHomeColumn,
    cellOf,
    isSafe,
    targetSteps,
    legalPieces,
    capturesAfterMove,
    pickBotPiece,
    distinctMoves,
    piecesFinished,
    progressOf,
  };
  cache.set(length, rules);
  return rules;
};

module.exports = {
  COLORS,
  COLOR_NAMES,
  FULL_PATH_LENGTH,
  HOME_COLUMN_LENGTH,
  PIECES_PER_PLAYER,
  boardSeatOf,
  turnOrderFor,
  colorFor,
  colorNameFor,
  rulesFor,
};
