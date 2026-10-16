const { prisma, newId, isValidId, jsonArray } = require('../utils/db');

const findOwnDeck = (id, profileId) =>
    prisma.flashcard.findFirst({ where: { id: String(id), user: String(profileId) } });

// Cards were Mongoose subdocuments: each gets its own _id and a createdAt.
const normalizeCards = (cards) =>
    jsonArray(cards).map((card) => {
        const c = card && typeof card === 'object' ? card : {};
        const cardId = c._id != null && isValidId(String(c._id)) ? String(c._id) : newId();
        return {
            ...c,
            _id: cardId,
            front: c.front,
            back: c.back,
            createdAt: c.createdAt ? new Date(c.createdAt) : new Date()
        };
    });

const shapeDeck = (deck) => (deck ? { ...deck, cards: jsonArray(deck.cards) } : deck);

// Get all flashcard decks for authenticated user
exports.getAllDecks = async (req, res, next) => {
    try {
        const profileId = req.profile?._id;
        if (!profileId) {
            return res.status(401).json({
                success: false,
                message: 'Authentication required'
            });
        }

        const decks = (await prisma.flashcard.findMany({
            where: { user: String(profileId) },
            orderBy: { updatedAt: 'desc' }
        })).map(shapeDeck);

        return res.status(200).json({
            success: true,
            decks
        });
    } catch (error) {
        console.error('Error getting flashcard decks:', error);
        return res.status(500).json({
            success: false,
            message: 'Internal server error',
            error: error.message
        });
    }
};

// Get single deck
exports.getDeck = async (req, res, next) => {
    try {
        const { id } = req.params;
        const profileId = req.profile?._id;

        if (!profileId) {
            return res.status(401).json({
                success: false,
                message: 'Authentication required'
            });
        }

        const deck = await findOwnDeck(id, profileId);

        if (!deck) {
            return res.status(404).json({
                success: false,
                message: 'Deck not found'
            });
        }

        return res.status(200).json({
            success: true,
            deck: shapeDeck(deck)
        });
    } catch (error) {
        console.error('Error getting deck:', error);
        return res.status(500).json({
            success: false,
            message: 'Internal server error',
            error: error.message
        });
    }
};

// Create deck
exports.createDeck = async (req, res, next) => {
    try {
        const { deckName } = req.body;
        const profileId = req.profile?._id;

        if (!profileId) {
            return res.status(401).json({
                success: false,
                message: 'Authentication required'
            });
        }

        if (!deckName || !deckName.trim()) {
            return res.status(400).json({
                success: false,
                message: 'Deck name is required'
            });
        }

        const savedDeck = shapeDeck(await prisma.flashcard.create({
            data: {
                user: String(profileId),
                deckName: deckName.trim(),
                cards: []
            }
        }));

        return res.status(201).json({
            success: true,
            message: 'Deck created successfully',
            deck: savedDeck
        });
    } catch (error) {
        console.error('Error creating deck:', error);
        return res.status(500).json({
            success: false,
            message: 'Internal server error',
            error: error.message
        });
    }
};

// Update deck (add/update cards)
exports.updateDeck = async (req, res, next) => {
    try {
        const { id } = req.params;
        const { deckName, cards } = req.body;
        const profileId = req.profile?._id;

        if (!profileId) {
            return res.status(401).json({
                success: false,
                message: 'Authentication required'
            });
        }

        const deck = await findOwnDeck(id, profileId);

        if (!deck) {
            return res.status(404).json({
                success: false,
                message: 'Deck not found'
            });
        }

        if (deckName !== undefined) {
            deck.deckName = deckName.trim();
        }
        if (cards !== undefined) {
            deck.cards = normalizeCards(cards);
        }

        const updatedDeck = shapeDeck(await prisma.flashcard.update({
            where: { id: deck.id },
            data: { deckName: deck.deckName, cards: deck.cards ?? [] }
        }));

        return res.status(200).json({
            success: true,
            message: 'Deck updated successfully',
            deck: updatedDeck
        });
    } catch (error) {
        console.error('Error updating deck:', error);
        return res.status(500).json({
            success: false,
            message: 'Internal server error',
            error: error.message
        });
    }
};

// Delete deck
exports.deleteDeck = async (req, res, next) => {
    try {
        const { id } = req.params;
        const profileId = req.profile?._id;

        if (!profileId) {
            return res.status(401).json({
                success: false,
                message: 'Authentication required'
            });
        }

        const deck = await findOwnDeck(id, profileId);

        if (!deck) {
            return res.status(404).json({
                success: false,
                message: 'Deck not found'
            });
        }

        await prisma.flashcard.delete({ where: { id: deck.id } });

        return res.status(200).json({
            success: true,
            message: 'Deck deleted successfully'
        });
    } catch (error) {
        console.error('Error deleting deck:', error);
        return res.status(500).json({
            success: false,
            message: 'Internal server error',
            error: error.message
        });
    }
};
