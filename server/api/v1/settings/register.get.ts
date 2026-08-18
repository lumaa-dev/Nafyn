// public: tells the client (settings page + /register) whether open registration is currently allowed
import { isRegistrationOpen } from "~~/server/core/appSettings";

export default defineEventHandler(async () => {
    return { open: isRegistrationOpen() };
});
