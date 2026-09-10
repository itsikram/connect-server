# Embedded friendship → Connects migration

Friendship data is embedded in `profiles.friends` and `profiles.friendReqs`;
there is no dedicated friendship collection.

By default, `migrate-friendships-to-connects.js`:

1. Exports the complete live `profiles` collection to
   `server/scripts/migration-backups/`.
2. Copies every profile, preserving `_id`, into a timestamped
   `profiles_connects_staging_*` collection.
3. Runs `$rename` only on staging (`friends` → `connects`,
   `friendReqs` → `connectReqs`).
4. Verifies counts, IDs, legacy-field counts, connect-field counts, and samples.
5. Writes `connects_migration_audit`.

Live `profiles` and its legacy fields are untouched unless
`LIVE_CUTOVER_CONFIRM=I_UNDERSTAND_LIVE_CUTOVER` is explicitly set. The
export and staging collection remain as rollback artifacts; nothing is dropped.

## Rollback

For the default staging-only run, rollback requires no database changes: stop
using the staging collection and retain it for investigation. Do not drop it.

If explicit live cutover was used, restore from the JSON export or run this
copy-only reversal in `mongosh` (substitute the database and backup/staging
names recorded in the audit entry):

```js
const db = db.getSiblingDB("<database>");
db.profiles.updateMany(
  { $or: [{ connects: { $exists: true } }, { connectReqs: { $exists: true } }] },
  { $rename: { connects: "friends", connectReqs: "friendReqs" } }
);
```

Do not drop `profiles`, the staging collection, backups, or audit records.
