const Portfolio = require('../models/Portfolio');
const defaults = require('../data/portfolioDefaults');

const ALLOWED_ROOT_KEYS = [
  'profile',
  'social',
  'hero',
  'homeAbout',
  'skills',
  'projects',
  'homeExperience',
  'homeContact',
  'aboutPage',
  'resumePage',
  'experiences',
  'education',
  'blogs',
  'contactPage',
  'seo',
  'footerText',
];

async function ensurePortfolio() {
  let doc = await Portfolio.findOne();
  if (!doc) {
    doc = await Portfolio.create(defaults);
  }
  return doc;
}

exports.getPortfolio = async (req, res, next) => {
  try {
    const doc = await ensurePortfolio();
    return res.status(200).json(doc);
  } catch (error) {
    next(error);
  }
};

exports.updatePortfolio = async (req, res, next) => {
  try {
    const payload = {};
    for (const key of ALLOWED_ROOT_KEYS) {
      if (Object.prototype.hasOwnProperty.call(req.body, key)) {
        payload[key] = req.body[key];
      }
    }

    let doc = await Portfolio.findOne();
    if (!doc) {
      doc = await Portfolio.create({ ...defaults, ...payload });
      return res.status(200).json(doc);
    }

    for (const key of Object.keys(payload)) {
      doc.set(key, payload[key]);
      doc.markModified(key);
    }
    await doc.save();
    return res.status(200).json(doc);
  } catch (error) {
    next(error);
  }
};

exports.resetPortfolio = async (req, res, next) => {
  try {
    await Portfolio.deleteMany({});
    const doc = await Portfolio.create(defaults);
    return res.status(200).json(doc);
  } catch (error) {
    next(error);
  }
};
