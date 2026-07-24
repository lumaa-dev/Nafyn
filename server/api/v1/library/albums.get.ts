import { getAlbumsOfUser } from "~~/server/core/library";

export default defineEventHandler(async (event) => {
  const { sub: userId } = requireAuthToken(event);

  return getAlbumsOfUser(userId);
})
