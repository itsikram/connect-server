const {Schema,model} = require('mongoose')
const Profile = require('./Profile')

  
const FaceEncodingSchema = new Schema({
    name: { type: String, required: true },
    email: { type: String, unique: true },
    faceEncoding: {
      type: [Number], // Array of 128 floats
      required: true,
    },
    profile: {
        type: Schema.Types.ObjectId,
        ref: Profile
    },
    timestamp: { type: Date, default: Date.now }
});
const FaceEncoding = model("FaceEncoding", FaceEncodingSchema);

module.exports = FaceEncoding
