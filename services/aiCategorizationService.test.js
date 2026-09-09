const test = require('node:test');
const assert = require('node:assert/strict');
const { contentText, contentHash, mediaUrlFor } = require('./aiCategorizationService');

test('contentText combines supported post and watch fields', () => {
    const text = contentText({ caption: 'Fitness tips', feeling: 'motivated', location: 'Dhaka' }, 'watch');
    assert.match(text, /Fitness tips/);
    assert.match(text, /motivated/);
    assert.match(text, /Dhaka/);
});

test('contentText does not manufacture text for an empty post', () => {
    assert.equal(contentText({}, 'post'), '');
});

test('contentHash is deterministic and changes with content', () => {
    assert.equal(contentHash('same'), contentHash('same'));
    assert.notEqual(contentHash('same'), contentHash('different'));
});

test('media URLs change the categorization hash', () => {
    assert.notEqual(contentHash('caption\nhttps://example.com/a.jpg'), contentHash('caption\nhttps://example.com/b.jpg'));
});

test('mediaUrlFor selects post images and watch thumbnails', () => {
    assert.equal(mediaUrlFor({ photos: 'https://example.com/post.jpg' }, 'post'), 'https://example.com/post.jpg');
    assert.equal(mediaUrlFor({ thumbnail: 'https://example.com/thumb.jpg', videoUrl: 'https://example.com/video.mp4' }, 'watch'), 'https://example.com/thumb.jpg');
});
