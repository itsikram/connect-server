const test = require("node:test");
const assert = require("node:assert/strict");
const {
  escapeRegex,
  getSearchMatchScore,
  getSearchTokens,
} = require("./searchMatching");

test("removes video command filler from translated searches", () => {
  assert.deepEqual(getSearchTokens("the song Nikosh Gal"), ["nikosh", "gal"]);
});

test("matches translated phonetic spelling to the watch caption", () => {
  const score = getSearchMatchScore(
    "the song Nikosh Gal",
    "Nikosh kalo ei adhare Lyrics plus Song",
  );

  assert.ok(score >= 0.55, `expected a match, received score ${score}`);
});

test("escapes user input before creating MongoDB regexes", () => {
  assert.equal(escapeRegex("song (live)?"), "song \\(live\\)\\?");
});
