import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { moveFile } from "../server/utils/moveFile";

describe("moveFile", () => {
    test("moves a file over an existing one and leaves nothing behind", async () => {
        const dir = await mkdtemp(join(tmpdir(), "nafyn-move-"));
        await writeFile(join(dir, "from.flac"), "new");
        await writeFile(join(dir, "to.flac"), "old");

        await moveFile(join(dir, "from.flac"), join(dir, "to.flac"));

        expect(await readFile(join(dir, "to.flac"), "utf8")).toBe("new");
        expect(await readdir(dir)).toEqual(["to.flac"]);
    });

    test("a missing source throws and leaves the destination alone", async () => {
        const dir = await mkdtemp(join(tmpdir(), "nafyn-move-"));
        await writeFile(join(dir, "to.flac"), "old");

        await expect(moveFile(join(dir, "nope.flac"), join(dir, "to.flac"))).rejects.toThrow();
        expect(await readFile(join(dir, "to.flac"), "utf8")).toBe("old");
    });
});
