const { Schema } = require('mongoose');

/**
 * Who did something: a Clerk user id and their name at the time. Stored on the
 * record itself, so history keeps the name after a member is removed.
 */
const actorSchema = new Schema(
  {
    id: { type: String, required: true },
    name: { type: String, required: true }
  },
  { _id: false }
);

module.exports = actorSchema;
