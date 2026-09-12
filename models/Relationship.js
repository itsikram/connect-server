const { Schema, model, models } = require("mongoose");

const relationshipSchema = new Schema(
  {
    userA: { type: Schema.Types.ObjectId, ref: "Profile", required: true },
    userB: { type: Schema.Types.ObjectId, ref: "Profile", required: true },
    relationType: { type: String, required: true, trim: true, maxlength: 80 },
    createdBy: { type: Schema.Types.ObjectId, ref: "Profile", required: true },
  },
  { timestamps: true },
);

relationshipSchema.index({ userA: 1, userB: 1, relationType: 1 }, { unique: true });

module.exports =
  models.Relationship || model("Relationship", relationshipSchema);
