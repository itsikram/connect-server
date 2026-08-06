function getPostId(post) {
    if (post == null || post === '') return '';
    if (typeof post === 'object' && post._id != null) {
        return String(post._id);
    }
    return String(post);
}

function postLink(post) {
    const id = getPostId(post);
    return id ? `/post/${id}` : '/';
}

module.exports = { getPostId, postLink };
