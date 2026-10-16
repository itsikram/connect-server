// Prisma-backed stand-ins for the Recovery Mongoose models. The recovery
// controller is written against a small Mongoose-style API (it is injectable,
// so its tests run on in-memory fakes); these adapters implement exactly that
// API on the MySQL tables:
//   findOne(filter).lean(), find(filter).sort().limit().lean(), countDocuments,
//   create, insertMany, updateOne / findOneAndUpdate with $set / $inc / $push
//   ($each), deleteMany.
// Filters are equality plus $gte / $lt. Json columns get the defaults the
// Mongoose schemas applied, and Dates nested in Json are revived, so documents
// look the way `.lean()` returned them.
const { prisma, pickModelFields, isDuplicate } = require("../utils/db");

const toWhere = (filter = {}) => {
  const where = {};
  for (const [key, condition] of Object.entries(filter)) {
    const column = key === "_id" ? "id" : key;
    if (condition && typeof condition === "object" && !(condition instanceof Date)) {
      const ops = {};
      for (const [op, arg] of Object.entries(condition)) {
        if (op === "$gte") ops.gte = arg;
        else if (op === "$lt") ops.lt = arg;
        else throw new Error(`recoveryStore: unsupported operator ${op}`);
      }
      where[column] = ops;
    } else {
      where[column] = condition == null ? condition : typeof condition === "object" ? condition : String(condition);
    }
  }
  return where;
};

const asArray = (value) => (Array.isArray(value) ? value : []);
const asDate = (value) => (value == null || value instanceof Date ? value : new Date(value));

const SHAPES = {
  RecoveryProfile: (row) => ({
    ...row,
    substances: asArray(row.substances).map((substance) => ({
      ...substance,
      quitDate: asDate(substance?.quitDate),
      streakStart: asDate(substance?.streakStart),
    })),
    readiness: { importance: 8, confidence: 5, ...(row.readiness || {}) },
    reasonKeys: asArray(row.reasonKeys),
    triggers: asArray(row.triggers),
    riskHours: asArray(row.riskHours),
    badges: asArray(row.badges).map((badge) => ({ ...badge, at: asDate(badge?.at) })),
    daily: { dayKey: "", noteEnc: "", ...(row.daily || {}) },
    settings: { aiEnabled: true, discreet: true, riskNudges: false, ...(row.settings || {}) },
  }),
  RecoveryCheckIn: (row) => ({
    ...row,
    used: asArray(row.used),
    halt: asArray(row.halt),
    triggers: asArray(row.triggers),
    symptoms: asArray(row.symptoms),
  }),
  RecoveryCraving: (row) => ({ ...row, tools: asArray(row.tools) }),
  RecoveryLapse: (row) => row,
  RecoveryChatMessage: (row) => row,
};

/** Drop nulls for optional columns, so lean() docs omit unset paths as Mongo did. */
const leanRow = (modelName, row) => {
  if (!row) return null;
  const out = {};
  for (const [key, value] of Object.entries(row)) if (value !== null) out[key] = value;
  return SHAPES[modelName](out);
};

/** Mongo's duplicate-key error code, which the controller checks for. */
const asMongoError = (error) => {
  if (isDuplicate(error)) error.code = 11000;
  return error;
};

const createModel = (modelName) => {
  const delegate = prisma[modelName.charAt(0).toLowerCase() + modelName.slice(1)];
  // createdAt is kept: chat messages are written with explicit, ordered times.
  const data = (input) => pickModelFields(modelName, input, { keep: ["createdAt"] });

  const query = (run) => {
    const args = {};
    const chain = {
      sort: (spec) => {
        args.orderBy = Object.entries(spec).map(([key, dir]) => ({ [key]: dir < 0 ? "desc" : "asc" }));
        return chain;
      },
      limit: (count) => {
        args.take = count;
        return chain;
      },
      select: () => chain,
      lean: () => run(args),
      then: (resolve, reject) => run(args).then(resolve, reject),
    };
    return chain;
  };

  /** Apply $set / $inc / $push to one row inside a transaction; returns the new row. */
  const applyUpdate = (where, update, { upsertWith } = {}) =>
    prisma.$transaction(async (tx) => {
      const model = tx[modelName.charAt(0).toLowerCase() + modelName.slice(1)];
      let row = await model.findFirst({ where });
      if (!row) {
        if (!upsertWith) return null;
        row = await model.create({ data: data({ ...upsertWith, ...(update.$set || {}) }) });
        if (!update.$inc && !update.$push) return row;
      }
      const changes = { ...(update.$set || {}) };
      for (const [key, amount] of Object.entries(update.$inc || {})) {
        changes[key] = { increment: amount };
      }
      if (update.$push) {
        const shaped = SHAPES[modelName](row);
        for (const [key, value] of Object.entries(update.$push)) {
          const items = value && typeof value === "object" && Array.isArray(value.$each) ? value.$each : [value];
          changes[key] = [...asArray(shaped[key]), ...items];
        }
      }
      return model.update({ where: { id: row.id }, data: data(changes) });
    });

  return {
    findOne: (filter) =>
      query(async (args) => leanRow(modelName, await delegate.findFirst({ where: toWhere(filter), orderBy: args.orderBy }))),
    find: (filter) =>
      query(async (args) => (await delegate.findMany({ where: toWhere(filter), ...args })).map((row) => leanRow(modelName, row))),
    countDocuments: (filter) => delegate.count({ where: toWhere(filter) }),
    create: async (input) => {
      try {
        return leanRow(modelName, await delegate.create({ data: data(input) }));
      } catch (error) {
        throw asMongoError(error);
      }
    },
    insertMany: async (list) => {
      try {
        return await prisma.$transaction(list.map((input) => delegate.create({ data: data(input) })));
      } catch (error) {
        throw asMongoError(error);
      }
    },
    updateOne: async (filter, update) => {
      const row = await applyUpdate(toWhere(filter), update);
      return { matchedCount: row ? 1 : 0, modifiedCount: row ? 1 : 0 };
    },
    findOneAndUpdate: (filter, update, options = {}) =>
      query(async () => {
        const where = toWhere(filter);
        const before = options.new ? null : await delegate.findFirst({ where });
        const upsertWith = options.upsert
          ? Object.fromEntries(Object.entries(filter).filter(([, value]) => value == null || typeof value !== "object" || value instanceof Date))
          : undefined;
        try {
          const after = await applyUpdate(where, update, { upsertWith });
          return leanRow(modelName, options.new ? after : before);
        } catch (error) {
          throw asMongoError(error);
        }
      }),
    deleteMany: async (filter) => {
      const { count } = await delegate.deleteMany({ where: toWhere(filter) });
      return { deletedCount: count };
    },
  };
};

module.exports = {
  RecoveryProfile: createModel("RecoveryProfile"),
  RecoveryCheckIn: createModel("RecoveryCheckIn"),
  RecoveryCraving: createModel("RecoveryCraving"),
  RecoveryLapse: createModel("RecoveryLapse"),
  RecoveryChatMessage: createModel("RecoveryChatMessage"),
};
