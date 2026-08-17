const SEARCH_FILLER_WORDS = new Set([
  "a",
  "an",
  "for",
  "from",
  "me",
  "music",
  "play",
  "please",
  "song",
  "songs",
  "the",
  "this",
  "video",
  "videos",
  "watch",
]);

const normalizeSearchText = (value = "") =>
  String(value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\u0980-\u09ff]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const getSearchTokens = (value) => {
  const allTokens = normalizeSearchText(value).split(" ").filter(Boolean);
  const meaningfulTokens = allTokens.filter(
    (token) => token.length > 1 && !SEARCH_FILLER_WORDS.has(token),
  );

  return meaningfulTokens.length > 0 ? meaningfulTokens : allTokens;
};

const levenshteinDistance = (left, right) => {
  if (left === right) return 0;
  if (!left) return right.length;
  if (!right) return left.length;

  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);

  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      current[rightIndex] = Math.min(
        current[rightIndex - 1] + 1,
        previous[rightIndex] + 1,
        previous[rightIndex - 1] +
          (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
      );
    }
    previous = current;
  }

  return previous[right.length];
};

const getTokenSimilarity = (queryToken, candidateToken) => {
  if (queryToken === candidateToken) return 1;

  if (
    queryToken.includes(candidateToken) ||
    candidateToken.includes(queryToken)
  ) {
    return (
      Math.min(queryToken.length, candidateToken.length) /
      Math.max(queryToken.length, candidateToken.length)
    );
  }

  return (
    1 -
    levenshteinDistance(queryToken, candidateToken) /
      Math.max(queryToken.length, candidateToken.length)
  );
};

const getSearchMatchScore = (query, candidate) => {
  const normalizedQuery = normalizeSearchText(query);
  const normalizedCandidate = normalizeSearchText(candidate);
  if (!normalizedQuery || !normalizedCandidate) return 0;
  if (normalizedQuery === normalizedCandidate) return 1;
  if (normalizedCandidate.includes(normalizedQuery)) return 0.99;

  const queryTokens = getSearchTokens(query);
  const candidateTokens = normalizedCandidate.split(" ").filter(Boolean);
  if (queryTokens.length === 0 || candidateTokens.length === 0) return 0;

  const tokenScores = queryTokens.map((queryToken) =>
    Math.max(
      0,
      ...candidateTokens.map((candidateToken) =>
        getTokenSimilarity(queryToken, candidateToken),
      ),
    ),
  );

  return tokenScores.reduce((sum, score) => sum + score, 0) /
    tokenScores.length;
};

const escapeRegex = (value = "") =>
  String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

module.exports = {
  escapeRegex,
  getSearchMatchScore,
  getSearchTokens,
  normalizeSearchText,
};
