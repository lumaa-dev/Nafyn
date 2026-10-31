import { describe, expect, test } from "bun:test";
import { canManageUser, Permission } from "../server/entity/Permission";

const plain = Permission.REQUEST_ALBUMS | Permission.REQUEST_TRACKS;
const manager = Permission.MANAGE_ACCOUNTS;
const admin = Permission.ADMIN;

describe("canManageUser", () => {
    test("nobody edits their own account here, an ADMIN included", () => {
        expect(canManageUser("a", admin, "a", plain)).toBe(false);
        expect(canManageUser("a", manager, "a", plain)).toBe(false);
    });

    test("an account without MANAGE_ACCOUNTS or ADMIN edits nobody", () => {
        expect(canManageUser("a", plain | Permission.MANAGE_MUSIC, "b", plain)).toBe(false);
    });

    test("ADMIN edits anyone - ordinary accounts and MANAGE_ACCOUNTS holders - but never another ADMIN", () => {
        expect(canManageUser("a", admin, "b", plain)).toBe(true);
        expect(canManageUser("a", admin, "b", manager)).toBe(true);
        expect(canManageUser("a", admin, "b", plain | manager)).toBe(true);
        expect(canManageUser("a", admin, "b", admin)).toBe(false);
        expect(canManageUser("a", admin, "b", admin | manager)).toBe(false);
    });

    test("MANAGE_ACCOUNTS edits only accounts holding neither MANAGE_ACCOUNTS nor ADMIN", () => {
        expect(canManageUser("a", manager, "b", plain)).toBe(true);
        expect(canManageUser("a", manager, "b", manager)).toBe(false);
        expect(canManageUser("a", manager, "b", admin)).toBe(false);
        expect(canManageUser("a", manager, "b", plain | manager)).toBe(false);
    });

    test("an account holding both bits is an ADMIN first: it edits MANAGE_ACCOUNTS holders, not admins", () => {
        expect(canManageUser("a", admin | manager, "b", manager)).toBe(true);
        expect(canManageUser("a", admin | manager, "b", admin)).toBe(false);
    });
});
