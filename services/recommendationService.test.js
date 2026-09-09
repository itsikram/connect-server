const test = require('node:test');
const assert = require('node:assert/strict');
const { cosineSimilarity, rankItems } = require('./recommendationService');

test('cosineSimilarity returns one for identical vectors', () => {
    assert.equal(cosineSimilarity([1, 0], [1, 0]), 1);
});

test('rankItems favors matching categories without dropping items', () => {
    const ranked = rankItems([
        { _id: 'other', createdAt: new Date(), aiMetadata: { categories: ['music'] } },
        { _id: 'match', createdAt: new Date(), aiMetadata: { categories: ['fitness'] } },
    ], { categories: { fitness: 3 }, interactionCount: 1 });
    assert.equal(ranked.length, 2);
    assert.equal(ranked[0]._id, 'match');
});
