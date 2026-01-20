const Flashcard = require('../models/Flashcard');

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

        const decks = await Flashcard.find({ user: profileId })
            .sort({ updatedAt: -1 });

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

        const deck = await Flashcard.findOne({ _id: id, user: profileId });

        if (!deck) {
            return res.status(404).json({
                success: false,
                message: 'Deck not found'
            });
        }

        return res.status(200).json({
            success: true,
            deck
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

        const deck = new Flashcard({
            user: profileId,
            deckName: deckName.trim(),
            cards: []
        });

        const savedDeck = await deck.save();

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

        const deck = await Flashcard.findOne({ _id: id, user: profileId });

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
            deck.cards = cards;
        }
        deck.updatedAt = Date.now();

        const updatedDeck = await deck.save();

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

        const deck = await Flashcard.findOne({ _id: id, user: profileId });

        if (!deck) {
            return res.status(404).json({
                success: false,
                message: 'Deck not found'
            });
        }

        await Flashcard.deleteOne({ _id: id, user: profileId });

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
