const { Prisma } = require('@prisma/client');
const { prisma } = require('./db');

// Every model with its text / Json columns: the tables that can hold Cloudinary URLs.
const textColumnsByModel = () => Prisma.dmmf.datamodel.models
  .map((model) => ({
    name: model.name,
    delegate: prisma[model.name.charAt(0).toLowerCase() + model.name.slice(1)],
    columns: model.fields
      .filter((field) => field.kind !== 'object' && (field.type === 'String' || field.type === 'Json') && !field.isId)
      .map((field) => ({ name: field.name, json: field.type === 'Json' })),
  }))
  .filter((model) => model.delegate && model.columns.length);

/** Stream every row (id + text/Json columns) of every table in id order. */
async function* allTextRows() {
  for (const model of textColumnsByModel()) {
    const select = { id: true, ...Object.fromEntries(model.columns.map((column) => [column.name, true])) };
    let cursor = null;
    for (;;) {
      const rows = await model.delegate.findMany({
        select,
        orderBy: { id: 'asc' },
        take: 500,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      for (const row of rows) yield { model, row };
      if (rows.length < 500) break;
      cursor = rows[rows.length - 1].id;
    }
  }
}

module.exports = { textColumnsByModel, allTextRows };
