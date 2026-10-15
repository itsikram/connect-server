import mongoose from "mongoose";
export async function connectToMongoDB() {
  try {
    await mongoose.connect(
      "mongodb+srv://mdikram295:RUM9epmbVgeQ01nQ@icsbd.mm9fg.mongodb.net/",
    );
    console.log("You successfully connected to MongoDB!");
    return mongoose;
  } catch (err) {
    console.dir(err);
  }
}
// Call this only when your application terminates
export async function disconnectFromMongoDB() {
  await mongoose.connection.close();
}
